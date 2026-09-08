/**
 * Entry point. Run directly (`npm start`) it loads `.env`, wires the database,
 * event hub, X client, scheduler and HTTP app, listens, prints a banner and
 * shuts down cleanly on SIGINT/SIGTERM. Tests use {@link startServer} to get
 * the same stack on an ephemeral port with a throw-away data directory.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './api.js';
import { ConfigError, loadConfig, normalizeConfig } from './config.js';
import { openDb } from './db.js';
import { createEventHub } from './events.js';
import { createScheduler } from './scheduler.js';
import { createXClientFromEnv } from './x.js';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_STATIC_DIR = path.join(ROOT_DIR, 'public');
const { version: VERSION } = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** How long a graceful shutdown may take before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 5000;
/** Bind addresses only this machine can reach (with or without IPv6 brackets). */
const LOOPBACK_HOST = /^\[?(localhost|127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})\]?$/i;

/**
 * Load `.env` into `process.env` without overriding variables that are
 * already set. A missing file is fine; any other problem is logged.
 *
 * @param {string} [file]
 * @param {{ warn: Function }} [logger]
 */
export function loadEnv(file = '.env', logger = console) {
  try {
    process.loadEnvFile(file);
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`Could not read ${file}: ${err.message}`);
  }
}

/**
 * Wire every component into an HTTP server that is not listening yet.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env] defaults to process.env
 * @param {object} [options.config] raw or normalized config; wins over `configPath`
 * @param {string} [options.configPath] defaults to `$CONFIG_PATH` or ./config.json
 * @param {string} [options.dataDir] defaults to `$DATA_DIR` or ./data
 * @param {string} [options.bindHost] the address the HTTP server will listen on (the Host check depends on it); default 127.0.0.1
 * @param {string[]} [options.allowedHosts] Host names to serve; defaults to `$ALLOWED_HOSTS` split on commas
 * @param {string} [options.staticDir] defaults to `<root>/public`
 * @param {import('./x.js').XClient | null} [options.xClient] defaults to a client built from the env; null forces reminder mode
 * @param {() => number} [options.now] epoch ms clock, injectable for tests
 * @param {{ log: Function, info: Function, warn: Function, error: Function }} [options.logger]
 * @returns {{ app: import('express').Express, server: http.Server, db: import('./db.js').Db,
 *   events: import('./events.js').EventHub, scheduler: import('./scheduler.js').Scheduler,
 *   xClient: import('./x.js').XClient | null, config: import('./config.js').NormalizedConfig,
 *   dataDir: string, close: () => Promise<void> }}
 */
export function createServer({
  env = process.env,
  config,
  configPath = env.CONFIG_PATH || './config.json',
  dataDir = env.DATA_DIR || './data',
  bindHost = '127.0.0.1',
  allowedHosts = parseAllowedHosts(env.ALLOWED_HOSTS),
  staticDir = DEFAULT_STATIC_DIR,
  xClient,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const resolvedConfig = config === undefined ? loadConfig(configPath) : normalizeConfig(config);
  const resolvedDataDir = path.resolve(dataDir);
  const uploadsDir = path.join(resolvedDataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const db = openDb(path.join(resolvedDataDir, 'app.db'), { logger });
  const events = createEventHub();
  const client = xClient === undefined ? createXClientFromEnv(env, { logger }) : xClient;
  const scheduler = createScheduler({ db, config: resolvedConfig, events, xClient: client, uploadsDir, now, logger });
  const app = createApp({
    db, config: resolvedConfig, events, scheduler, xClient: client, uploadsDir, env, bindHost, allowedHosts, staticDir, now, logger,
  });
  const server = http.createServer(app);

  let closing = null;
  function close() {
    closing ??= (async () => {
      // The pass in flight must persist its outcome before the database goes away.
      await scheduler.stop();
      events.close();
      await closeHttpServer(server);
      db.close();
    })();
    return closing;
  }

  return { app, server, db, events, scheduler, xClient: client, config: resolvedConfig, dataDir: resolvedDataDir, close };
}

/**
 * Create, listen and start the scheduler. Without `port`/`dataDir` it uses an
 * ephemeral port and a temporary data directory (removed on close), which is
 * what tests want. The scheduler's first pass runs in the background: the
 * promise resolves as soon as the port is open, whatever is due.
 *
 * @param {Parameters<typeof createServer>[0] & { port?: number, host?: string }} [options]
 * @returns {Promise<ReturnType<typeof createServer> & { url: string }>}
 */
export async function startServer({ port = 0, host = '127.0.0.1', dataDir, ...rest } = {}) {
  const tempDataDir = dataDir === undefined ? fs.mkdtempSync(path.join(os.tmpdir(), 'otf-')) : null;
  const instance = createServer({ ...rest, bindHost: host, dataDir: dataDir ?? tempDataDir });
  const close = async () => {
    await instance.close();
    if (tempDataDir) fs.rmSync(tempDataDir, { recursive: true, force: true });
  };
  try {
    await listen(instance.server, port, host);
    instance.scheduler.start();
  } catch (err) {
    await close();
    throw err;
  }
  const warning = exposureWarning(host, instance.server.address(), rest.env ?? process.env);
  if (warning) (rest.logger ?? console).warn(warning);
  return { ...instance, url: urlOf(instance.server.address(), host), close };
}

/**
 * The startup warning for a bind address other machines can reach while no
 * password guards the routes, or null. Only a warning: a reverse proxy or a
 * private network in front of the port is a legitimate no-password setup.
 *
 * @param {string} host the requested bind address ('' and wildcards mean every interface)
 * @param {import('node:net').AddressInfo | string | null} address what the server bound
 * @param {Record<string, string | undefined>} env read for APP_PASSWORD
 * @returns {string | null}
 */
function exposureWarning(host, address, env) {
  if (LOOPBACK_HOST.test(String(host ?? ''))) return null;
  if (typeof env.APP_PASSWORD === 'string' && env.APP_PASSWORD !== '') return null;
  const port = address && typeof address === 'object' ? address.port : '';
  const where = host === undefined || host === '' ? 'every interface' : host;
  return `WARNING: listening on ${where} with no APP_PASSWORD: anyone who can reach port ${port} can read, edit and delete every draft, upload images and post to X with your keys. `
    + 'Set APP_PASSWORD, or keep HOST=127.0.0.1 behind a reverse proxy (README: "Running on a VPS").';
}

/**
 * `ALLOWED_HOSTS`: comma-separated `host` or `host:port` entries the server
 * answers to besides the local names (a reverse proxy passing the public name
 * through, say). Empty or unset → the loopback rule applies (see api.js).
 *
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function parseAllowedHosts(value) {
  if (value === undefined || value === null || String(value).trim() === '') return [];
  const entries = String(value).split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  for (const entry of entries) {
    if (!/^(?:\[[^\]\s]+\]|[^\s:\[\]/,]+)(?::\d{1,5})?$/.test(entry)) {
      throw new ConfigError(`ALLOWED_HOSTS entries must be "host" or "host:port" (got ${JSON.stringify(entry)})`);
    }
  }
  return entries;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Close the listener and drop keep-alive/SSE connections so close() does not hang. */
function closeHttpServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** @param {import('node:net').AddressInfo | string | null} address */
function urlOf(address, host) {
  if (!address || typeof address === 'string') return `http://${host}`;
  const isWildcard = address.address === '0.0.0.0' || address.address === '::';
  const hostname = isWildcard ? 'localhost' : address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `http://${hostname}:${address.port}`;
}

/**
 * @param {string | undefined} value
 * @returns {number} 0..65535
 */
function parsePort(value) {
  const port = value === undefined || value === '' ? 3000 : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 0 and 65535 (got ${JSON.stringify(value)})`);
  }
  return port;
}

/** "weekdays 09:00, sat/sun 11:30" style summary of the configured slots. */
function describeSlots(slots) {
  if (slots.length === 0) return 'none configured (only custom times)';
  const NAMED = { '1,2,3,4,5': 'weekdays', '0,6': 'weekends', '0,1,2,3,4,5,6': 'daily' };
  return slots
    .map((slot) => `${NAMED[slot.days.join(',')] ?? slot.days.map((d) => DAY_NAMES[d]).join('/')} ${slot.time}`)
    .join(', ');
}

function printBanner({ url, config, xClient, dataDir }, env, logger) {
  const handle = env.X_HANDLE ? ` (@${env.X_HANDLE.replace(/^@/, '')})` : '';
  logger.log(`o_typefully ${VERSION} listening at ${url}`);
  logger.log(`Timezone ${config.timezone} · slots: ${describeSlots(config.slots)}`);
  logger.log(xClient ? `X API: configured${handle}` : 'X API: not configured → reminder mode');
  logger.log(`Scheduler: every ${config.schedulerIntervalSeconds}s · missed-slot grace ${config.missedGraceMinutes} min · data in ${dataDir}`);
}

function installSignalHandlers(instance, logger) {
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`\n${signal} received, shutting down…`);
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    try {
      await instance.close();
      process.exit(0);
    } catch (err) {
      logger.error('Shutdown failed:', err);
      process.exit(1);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown(signal));
}

async function main() {
  const logger = console;
  loadEnv('.env', logger);
  const env = process.env;
  const configPath = env.CONFIG_PATH || './config.json';
  if (!fs.existsSync(configPath)) {
    logger.log(`No config file at ${configPath}; using the default slots (weekdays 09:00 and 16:00, system timezone)`);
  }
  const instance = await startServer({
    env,
    port: parsePort(env.PORT),
    host: env.HOST || '127.0.0.1',
    dataDir: env.DATA_DIR || './data',
    configPath,
    logger,
  });
  printBanner(instance, env, logger);
  installSignalHandlers(instance, logger);
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  });
}

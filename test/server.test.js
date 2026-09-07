import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConfigError } from '../src/config.js';
import { openDb } from '../src/db.js';
import { parseAllowedHosts, startServer } from '../src/server.js';

const TEST_CONFIG = { timezone: 'UTC', slots: [], schedulerIntervalSeconds: 3600 };
const T0 = Date.UTC(2026, 8, 7, 12, 0, 0);
const MINUTE = 60_000;

/** A logger that keeps what it was told. */
function recorder() {
  const lines = { log: [], warn: [], error: [] };
  return {
    lines,
    log: (...args) => lines.log.push(args.join(' ')),
    info: (...args) => lines.log.push(args.join(' ')),
    warn: (...args) => lines.warn.push(args.join(' ')),
    error: (...args) => lines.error.push(args.join(' ')),
  };
}

async function bootWith({ host, env }) {
  const logger = recorder();
  const instance = await startServer({ host, env, xClient: null, config: TEST_CONFIG, logger });
  return { instance, logger };
}

describe('startServer exposure warning', () => {
  const running = [];
  after(async () => { for (const instance of running) await instance.close(); });
  before(() => { running.length = 0; });

  it('warns when the bind address is reachable from other machines and APP_PASSWORD is empty', async () => {
    for (const host of ['0.0.0.0', '']) {
      const { instance, logger } = await bootWith({ host, env: { APP_PASSWORD: '' } });
      running.push(instance);
      assert.equal(logger.lines.warn.length, 1, `host ${JSON.stringify(host)}`);
      const [warning] = logger.lines.warn;
      assert.match(warning, /^WARNING: listening on /);
      assert.match(warning, host === '' ? /every interface/ : /0\.0\.0\.0/);
      assert.match(warning, /no APP_PASSWORD/);
      assert.match(warning, new RegExp(`port ${instance.server.address().port}\\b`));
      assert.match(warning, /post to X with your keys/);
      assert.match(warning, /Set APP_PASSWORD/);
      // Only a warning: the server is up and answers as usual.
      assert.equal((await fetch(`${instance.url}/api/status`)).status, 200);
    }
  });

  it('stays quiet on loopback, and on any address once a password is set', async () => {
    const cases = [
      { host: '127.0.0.1', env: {} },
      { host: 'localhost', env: { APP_PASSWORD: '' } },
      { host: '0.0.0.0', env: { APP_PASSWORD: 'secret' } },
    ];
    for (const { host, env } of cases) {
      const { instance, logger } = await bootWith({ host, env });
      running.push(instance);
      assert.deepEqual(logger.lines.warn, [], `${host} with ${JSON.stringify(env)}`);
    }
  });
});

describe('startServer and the first publish pass', () => {
  it('resolves as soon as the port is open; the due drafts are published in the background', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otf-seed-'));
    const seed = openDb(path.join(dataDir, 'app.db'));
    const ids = [1, 2].map((n) => {
      const draft = seed.createDraft({ tweets: [{ text: `due ${n}`, media: [] }], mode: 'api' }, T0 - 2 * MINUTE);
      return seed.updateDraft(draft.id, { status: 'scheduled', scheduledAt: T0 - MINUTE }, T0 - 2 * MINUTE).id;
    });
    seed.close();

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let counter = 0;
    const xClient = {
      calls: [],
      async publishThread({ tweets }) {
        xClient.calls.push(tweets[0].text);
        await gate;
        return { tweetIds: tweets.map(() => `id-${(counter += 1)}`) };
      },
    };
    let instance = null;
    try {
      instance = await startServer({ dataDir, xClient, config: TEST_CONFIG, now: () => T0, logger: recorder() });
      // The caller gets control back before the pass even claims its rows,
      // so main() prints the banner and installs the signal handlers first.
      assert.deepEqual(ids.map((id) => instance.db.getDraft(id).status), ['scheduled', 'scheduled']);
      assert.deepEqual(xClient.calls, []);
      assert.ok(instance.scheduler.firstTick instanceof Promise);
      assert.equal((await fetch(`${instance.url}/api/status`)).status, 200, 'the server answers while the pass runs');

      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(xClient.calls, ['due 1'], 'the first pass started on its own');
      release();
      await instance.scheduler.firstTick;
      assert.deepEqual(ids.map((id) => instance.db.getDraft(id).status), ['posted', 'posted']);
    } finally {
      await instance?.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('parseAllowedHosts', () => {
  it('splits ALLOWED_HOSTS on commas, trims, skips blanks and rejects malformed entries', () => {
    assert.deepEqual(parseAllowedHosts(undefined), []);
    assert.deepEqual(parseAllowedHosts(''), []);
    assert.deepEqual(parseAllowedHosts('  ,  '), []);
    assert.deepEqual(
      parseAllowedHosts(' posts.example.com, api.example.com:8080 ,,[::1]:3000,10.0.0.5 '),
      ['posts.example.com', 'api.example.com:8080', '[::1]:3000', '10.0.0.5'],
    );
    for (const bad of ['http://example.com', 'example.com/app', 'example.com:abc', 'two words', '[::1', 'a:1:2']) {
      assert.throws(() => parseAllowedHosts(bad), (err) => err instanceof ConfigError && /ALLOWED_HOSTS entries must be/.test(err.message), bad);
    }
  });
});

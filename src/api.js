/**
 * HTTP layer: the `/api/*` JSON routes, `/media/:id`, the SSE endpoint and
 * the static front end, wired into one Express app by {@link createApp}.
 *
 * Every request body is untrusted: bodies are coerced through
 * `normalizeTweets`, enums are checked against the db vocabularies, and
 * uploads are verified by size and magic bytes before touching disk.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { MAX_QUEUE_DAYS } from './config.js';
import { MODES, QUEUE_STATUSES, STATUSES } from './db.js';
import { ALREADY_POSTED, NOT_CONFIGURED_MESSAGE, PUBLISHING_NOW, removeMedia, resumableResult } from './scheduler.js';
import { addDays, formatDateKey, nextFreeSlot, slotTimesBetween, startOfDay, zonedTimeToUtc } from './slots.js';
import { normalizeTweets, validateThread } from './tweet.js';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_STATIC_DIR = path.join(ROOT_DIR, 'public');
const { version: VERSION } = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";
const AUTH_CHALLENGE = 'Basic realm="o_typefully", charset="UTF-8"';
const MEDIA_CACHE_CONTROL = 'private, max-age=31536000, immutable';
/** Ids are UUIDs; anything else is rejected before it reaches the database. */
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** Scheduling slightly in the past is fine: the clock skew between browser and server. */
const PAST_TOLERANCE_MS = 60_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/**
 * Latest instant a draft may be scheduled for. `Date` cannot represent
 * anything past 8.64e15 ms (year 275760) and the slot math probes one day
 * either side of an instant, so anything closer than that would make the
 * queue calendar throw on every request once stored.
 */
const MAX_INSTANT_MS = 8.64e15 - 2 * DAY_MS;
/**
 * ISO-8601 date or date-time without a zone designator. `Date.parse` reads
 * the date-time form in the process's local zone and the date-only form in
 * UTC; the app reads both in the configured zone instead.
 */
const LOCAL_ISO_PATTERN = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/i;
/**
 * ISO-8601 with an explicit zone designator: the only form handed to
 * `Date.parse`, whose other formats ('March 8, 2026 09:00', '9/8/2026') are
 * read in the process's local zone rather than the configured one.
 */
const ZONED_ISO_PATTERN = /^([+-]\d{6}|\d{4})-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const MAX_FILENAME_CHARS = 255;

const MIB = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * MIB;
const MAX_GIF_BYTES = 15 * MIB;
const SIZE_MESSAGE = 'Images must be 5 MB or smaller; GIFs 15 MB';
/** Accepted upload types → file extension on disk. */
const IMAGE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const IMAGE_TYPES = Object.keys(IMAGE_EXTENSIONS);

const SCHEDULABLE_STATUSES = ['draft', 'scheduled', 'due', 'failed'];
const MARKABLE_STATUSES = ['due', 'scheduled', 'failed'];
const MEDIA_IN_USE = 'A draft still uses this image; remove it from the post first.';

/** An error with an HTTP status; the message is safe to show to the client. */
export class HttpError extends Error {
  /**
   * @param {number} status 4xx
   * @param {string} message
   * @param {unknown[]} [details] extra items for the JSON body (validation errors)
   */
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Build the Express app. Listening is the caller's job (see server.js).
 *
 * @param {object} options
 * @param {import('./db.js').Db} options.db
 * @param {import('./config.js').NormalizedConfig} options.config
 * @param {import('./events.js').EventHub} options.events
 * @param {import('./scheduler.js').Scheduler} options.scheduler
 * @param {import('./x.js').XClient | null} options.xClient null = reminder mode
 * @param {string} options.uploadsDir where uploaded images live
 * @param {Record<string, string | undefined>} [options.env] read for APP_PASSWORD and X_HANDLE
 * @param {string} [options.bindHost] the address the server listens on; a loopback one restricts the Host header to local names
 * @param {string[]} [options.allowedHosts] Host values (`host` or `host:port`) to serve in addition to the local names, from ALLOWED_HOSTS
 * @param {string} [options.staticDir] front-end directory, default `<root>/public`
 * @param {() => number} [options.now] epoch ms clock, injectable for tests
 * @param {{ error: Function }} [options.logger]
 * @returns {import('express').Express}
 */
export function createApp({
  db,
  config,
  events,
  scheduler,
  xClient,
  uploadsDir,
  env = process.env,
  bindHost = '127.0.0.1',
  allowedHosts = [],
  staticDir = DEFAULT_STATIC_DIR,
  now = () => Date.now(),
  logger = console,
}) {
  if (!db || !config || !events || !scheduler) throw new TypeError('createApp needs db, config, events and scheduler');
  if (typeof uploadsDir !== 'string' || uploadsDir === '') throw new TypeError('createApp: uploadsDir must be a non-empty path');
  const configured = xClient != null;
  const media = { db, uploadsDir };

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(securityHeaders);
  // Liveness probe for container platforms: no password, no Host check, no data.
  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true });
  });
  app.use(['/api', '/media'], originGuard({ bindHost, allowedHosts }));
  if (typeof env.APP_PASSWORD === 'string' && env.APP_PASSWORD !== '') app.use(basicAuth(env.APP_PASSWORD));
  app.use(express.json({ limit: '2mb' }));

  /** Fetch a draft by route param or 404. */
  function draftOr404(id) {
    const draft = ID_PATTERN.test(id) ? db.getDraft(id) : null;
    if (!draft) throw new HttpError(404, `Draft not found: ${id}`);
    return draft;
  }

  function saveDraft(id, patch) {
    const draft = db.updateDraft(id, patch, now());
    events.emit('draft.updated', { draft });
    return draft;
  }

  /** The mode a request asked for, validated; `fallback` when absent. */
  function modeFrom(body, fallback) {
    if (body.mode === undefined) return fallback;
    if (!MODES.includes(body.mode)) throw new HttpError(400, `mode must be "api" or "manual" (got ${JSON.stringify(body.mode)})`);
    if (body.mode === 'api' && !configured) throw new HttpError(400, NOT_CONFIGURED_MESSAGE);
    return body.mode;
  }

  function assertValidThread(draft) {
    const { ok, errors } = validateThread(draft.tweets);
    if (!ok) throw new HttpError(400, 'Fix these first', errors);
  }

  /**
   * Media references as the library knows them: `type`, `size` and `url`
   * come from the media row (its type was verified from the file's bytes),
   * not from the client, so the GIF rule and the scheduler see the real image
   * type. A reference to an id the library does not have is kept as sent;
   * the scheduler reports it when the post goes out.
   */
  function withLibraryMedia(tweets) {
    return tweets.map((tweet) => ({
      ...tweet,
      media: tweet.media.map((ref) => {
        const row = ID_PATTERN.test(ref.id) ? db.getMedia(ref.id) : null;
        return row ? { ...ref, url: `/media/${row.id}`, type: row.mime, size: row.size } : ref;
      }),
    }));
  }

  // --- status -------------------------------------------------------------

  app.get('/api/status', (req, res) => {
    res.json({
      configured,
      handle: typeof env.X_HANDLE === 'string' && env.X_HANDLE.trim() !== '' ? env.X_HANDLE.trim().replace(/^@/, '') : null,
      timezone: config.timezone,
      slots: config.slots.map((slot) => ({ days: slot.days.map((day) => DAY_NAMES[day]), time: slot.time })),
      now: now(),
      schedulerIntervalSeconds: config.schedulerIntervalSeconds,
      missedGraceMinutes: config.missedGraceMinutes,
      counts: db.countByStatus(),
      version: VERSION,
    });
  });

  // --- drafts -------------------------------------------------------------

  app.get('/api/drafts', (req, res) => {
    const statuses = parseStatuses(req.query.status);
    res.json({ drafts: statuses ? db.listDrafts({ statuses }) : db.listDrafts() });
  });

  app.post('/api/drafts', (req, res) => {
    const body = jsonBody(req);
    const draft = db.createDraft({
      tweets: withLibraryMedia(normalizeTweets(body.tweets)),
      mode: modeFrom(body, configured ? 'api' : 'manual'),
    }, now());
    events.emit('draft.updated', { draft });
    res.status(201).json({ draft });
  });

  app.get('/api/drafts/:id', (req, res) => {
    res.json({ draft: draftOr404(req.params.id) });
  });

  app.put('/api/drafts/:id', (req, res) => {
    const draft = draftOr404(req.params.id);
    if (draft.status === 'posted') throw new HttpError(409, ALREADY_POSTED);
    if (draft.status === 'publishing') throw new HttpError(409, PUBLISHING_NOW);
    const body = jsonBody(req);
    const patch = {};
    if (body.tweets !== undefined) {
      patch.tweets = withLibraryMedia(normalizeTweets(body.tweets));
      assertPublishedPostsUnchanged(draft, patch.tweets);
      // A plain draft may hold half-typed text, but a queued one is what the
      // scheduler will hand to X (or remind about), so it stays valid.
      if (QUEUE_STATUSES.includes(draft.status)) assertValidThread({ tweets: patch.tweets });
    }
    if (body.mode !== undefined) {
      patch.mode = modeFrom(body, draft.mode);
      // A reminder that has fired waits for the human; nothing in the loop
      // claims a 'due' row. Once the API is to post it instead, it goes back
      // into the queue at its slot so the next pass picks it up.
      if (patch.mode === 'api' && draft.status === 'due') Object.assign(patch, { status: 'scheduled', remindedAt: null });
    }
    res.json({ draft: saveDraft(draft.id, patch) });
  });

  /**
   * A partially published thread resumes by position, so the posts already on
   * X must stay where they are; rewriting them belongs in a duplicate.
   */
  function assertPublishedPostsUnchanged(draft, tweets) {
    const count = resumableResult(draft)?.tweetIds.length ?? 0;
    if (count > 0 && publishedPostsChanged(draft.tweets, tweets, count)) {
      const which = count === 1 ? 'Post 1 is' : `Posts 1–${count} are`;
      throw new HttpError(409, `${which} already on X and cannot be changed — duplicate the draft to rewrite them.`);
    }
  }

  app.delete('/api/drafts/:id', (req, res) => {
    const draft = draftOr404(req.params.id);
    if (draft.status === 'publishing') throw new HttpError(409, PUBLISHING_NOW);
    db.deleteDraft(draft.id);
    events.emit('draft.deleted', { id: draft.id });
    collectDraftMedia(draft);
    res.status(204).end();
  });

  /** Delete the images only this (now deleted) draft was using. Best effort: the draft is already gone. */
  function collectDraftMedia(draft) {
    const ids = mediaIdsOf(draft);
    if (ids.size === 0) return;
    try {
      for (const row of db.unreferencedMedia(Number.MAX_SAFE_INTEGER)) {
        if (ids.has(row.id)) removeMedia(media, row);
      }
    } catch (err) {
      logger.error(`api: media cleanup after deleting draft ${draft.id} failed:`, err);
    }
  }

  app.post('/api/drafts/:id/duplicate', (req, res) => {
    const source = draftOr404(req.params.id);
    const draft = db.createDraft({
      tweets: withLibraryMedia(normalizeTweets(source.tweets)),
      mode: source.mode === 'api' && !configured ? 'manual' : source.mode,
    }, now());
    events.emit('draft.updated', { draft });
    res.status(201).json({ draft });
  });

  app.post('/api/drafts/:id/schedule', (req, res) => {
    const draft = draftOr404(req.params.id);
    const tweets = withoutTrailingEmpty(draft.tweets);
    assertValidThread({ tweets });
    const body = jsonBody(req);
    const useNextFree = body.nextFree === true;
    if (useNextFree === (body.at !== undefined)) {
      throw new HttpError(400, 'Send exactly one of "at" (a time) or "nextFree": true');
    }
    const t = now();
    let scheduledAt;
    if (useNextFree) {
      scheduledAt = nextFreeSlot({
        slots: config.slots,
        timeZone: config.timezone,
        now: t,
        taken: db.takenTimes({ excludeId: draft.id }),
      });
      if (scheduledAt === null) throw new HttpError(409, 'No free slot found — add slots to config.json');
    } else {
      const requested = parseInstant(body.at, config.timezone);
      if (requested < t - PAST_TOLERANCE_MS) throw new HttpError(400, 'That time is in the past');
      // Slots are whole minutes (so is the browser's datetime-local input), and
      // both slot occupancy and the calendar match instants exactly: a time a
      // few ms off a slot would leave the slot "free" beside a card showing the
      // same minute. Floored, never rounded up, so "now" stays due right away.
      scheduledAt = Math.floor(requested / MINUTE_MS) * MINUTE_MS;
    }
    const mode = modeFrom(body, draft.mode);
    if (mode === 'api' && !configured) throw new HttpError(400, NOT_CONFIGURED_MESSAGE);
    if (!SCHEDULABLE_STATUSES.includes(draft.status)) {
      throw new HttpError(409, draft.status === 'posted' ? ALREADY_POSTED : PUBLISHING_NOW);
    }
    // A thread that failed part-way keeps the ids it already posted, so the
    // new slot continues it instead of posting the first posts a second time.
    const result = resumableResult(draft);
    const patch = { status: 'scheduled', scheduledAt, mode, remindedAt: null, result };
    if (tweets !== draft.tweets) patch.tweets = tweets; // queued without the empty cards at its end
    res.json({ draft: saveDraft(draft.id, patch) });
  });

  app.post('/api/drafts/:id/unschedule', (req, res) => {
    const draft = draftOr404(req.params.id);
    if (draft.status === 'posted') throw new HttpError(409, ALREADY_POSTED);
    if (draft.status === 'publishing') throw new HttpError(409, PUBLISHING_NOW);
    // Back to a plain draft, but the posts already on X stay on record: they
    // remain locked and the next publish continues after them. Only a
    // duplicate starts the thread over.
    res.json({ draft: saveDraft(draft.id, { status: 'draft', scheduledAt: null, remindedAt: null, result: resumableResult(draft) }) });
  });

  app.post('/api/drafts/:id/publish', async (req, res) => {
    const draft = draftOr404(req.params.id);
    const tweets = withoutTrailingEmpty(draft.tweets);
    assertValidThread({ tweets });
    if (!configured) throw new HttpError(400, NOT_CONFIGURED_MESSAGE);
    if (draft.status === 'posted') throw new HttpError(409, ALREADY_POSTED);
    if (draft.status === 'publishing') throw new HttpError(409, PUBLISHING_NOW);
    if (tweets !== draft.tweets) saveDraft(draft.id, { tweets }); // what goes to X is what is stored
    res.json({ draft: await scheduler.publishNow(draft.id) });
  });

  app.post('/api/drafts/:id/retry', async (req, res) => {
    const draft = draftOr404(req.params.id);
    if (draft.status !== 'failed') throw new HttpError(409, `Only failed posts can be retried (this one is ${draft.status})`);
    const tweets = withoutTrailingEmpty(draft.tweets);
    assertValidThread({ tweets });
    // The result is kept on purpose: the scheduler resumes from result.failedIndex.
    const patch = { status: 'scheduled', scheduledAt: now(), remindedAt: null };
    if (tweets !== draft.tweets) patch.tweets = tweets;
    saveDraft(draft.id, patch);
    // A pass already in flight did its claim step before this write, so it
    // would finish without touching the draft; run one that starts after it.
    await scheduler.tickFresh();
    res.json({ draft: db.getDraft(draft.id) });
  });

  app.post('/api/drafts/:id/mark-posted', (req, res) => {
    const draft = draftOr404(req.params.id);
    if (!MARKABLE_STATUSES.includes(draft.status)) {
      throw new HttpError(409, `Only scheduled, due or failed posts can be marked as posted (this one is ${draft.status})`);
    }
    const url = parseOptionalUrl(jsonBody(req).url);
    res.json({ draft: saveDraft(draft.id, { status: 'posted', postedAt: now(), result: { manual: true, url } }) });
  });

  // --- queue and slots ----------------------------------------------------

  app.get('/api/queue', (req, res) => {
    const t = now();
    const from = req.query.from === undefined ? startOfDay(t, config.timezone) : parseMsQuery(req.query.from, 'from');
    // Start of the day N days ahead, not from + N days: when today has no local
    // midnight (DST starting at 00:00) `from` is 01:00, and carrying that
    // wall-clock forward would add a 15th partial day to the window.
    const to = req.query.to === undefined
      ? startOfDay(addDays(from, config.queueDaysAhead, config.timezone), config.timezone)
      : parseMsQuery(req.query.to, 'to');
    if (to <= from) throw new HttpError(400, '"to" must be after "from"');
    // Calendar days, not elapsed ms: a range ending in standard time is an hour longer than its day count.
    if (to > addDays(from, MAX_QUEUE_DAYS, config.timezone)) throw new HttpError(400, `The queue range cannot exceed ${MAX_QUEUE_DAYS} days`);
    res.json({
      timezone: config.timezone,
      now: t,
      from,
      to,
      days: buildQueueDays({ config, from, to, drafts: db.listDrafts({ statuses: QUEUE_STATUSES }) }),
    });
  });

  app.get('/api/slots/next', (req, res) => {
    const exclude = req.query.exclude;
    if (exclude !== undefined && (typeof exclude !== 'string' || !ID_PATTERN.test(exclude))) {
      throw new HttpError(400, '"exclude" must be a draft id');
    }
    const taken = db.takenTimes(exclude === undefined ? {} : { excludeId: exclude });
    const at = nextFreeSlot({ slots: config.slots, timeZone: config.timezone, now: now(), taken });
    res.json({ at, taken });
  });

  // --- media --------------------------------------------------------------

  app.post('/api/media', rawImageBody, async (req, res) => {
    const type = mimeOf(req.get('content-type'));
    if (!IMAGE_TYPES.includes(type)) {
      throw new HttpError(415, `Unsupported image type "${type || 'unknown'}"; send image/png, image/jpeg, image/gif or image/webp`);
    }
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new HttpError(400, 'The upload is empty');
    if (bytes.length > (type === 'image/gif' ? MAX_GIF_BYTES : MAX_IMAGE_BYTES)) throw new HttpError(413, SIZE_MESSAGE);
    if (!hasMagicBytes(type, bytes)) throw new HttpError(415, `The file content is not a valid ${IMAGE_EXTENSIONS[type].toUpperCase()} image`);

    const id = randomUUID();
    const filename = `${id}.${IMAGE_EXTENSIONS[type]}`;
    const filePath = path.join(uploadsDir, filename);
    await fs.promises.writeFile(filePath, bytes, { flag: 'wx' });
    let row;
    try {
      row = db.insertMedia({
        id,
        filename,
        originalName: originalNameFrom(req.get('x-filename')),
        mime: type,
        size: bytes.length,
        ...(imageDimensions(type, bytes) ?? { width: null, height: null }),
      }, now());
    } catch (err) {
      await fs.promises.unlink(filePath).catch(() => {});
      throw err;
    }
    res.status(201).json({ media: mediaView(row) });
  });

  app.get('/media/:id', (req, res, next) => {
    const row = ID_PATTERN.test(req.params.id) ? db.getMedia(req.params.id) : null;
    if (!row) throw new HttpError(404, `Media not found: ${req.params.id}`);
    const options = {
      headers: { 'Content-Type': row.mime, 'Cache-Control': MEDIA_CACHE_CONTROL },
      dotfiles: 'deny',
    };
    res.sendFile(path.join(uploadsDir, path.basename(row.filename)), options, (err) => {
      if (err) next(err.code === 'ENOENT' ? new HttpError(404, 'The image file is missing on disk') : err);
    });
  });

  app.delete('/api/media/:id', (req, res) => {
    const row = ID_PATTERN.test(req.params.id) ? db.getMedia(req.params.id) : null;
    if (!row) throw new HttpError(404, `Media not found: ${req.params.id}`);
    // Duplicates share media ids, so the file may still belong to another draft.
    const unreferenced = db.unreferencedMedia(Number.MAX_SAFE_INTEGER).some((candidate) => candidate.id === row.id);
    if (!unreferenced) throw new HttpError(409, MEDIA_IN_USE);
    removeMedia(media, row);
    res.status(204).end();
  });

  // --- events and X -------------------------------------------------------

  app.get('/api/events', events.handler);

  app.get('/api/x/verify', async (req, res) => {
    if (!configured) throw new HttpError(400, NOT_CONFIGURED_MESSAGE);
    const note = 'This is a read call (GET /2/users/me); on pay-per-use plans X bills it as one read.';
    try {
      res.json({ ok: true, user: await xClient.me(), note });
    } catch (err) {
      res.json({ ok: false, error: err.message, hint: err.hint ?? null, note });
    }
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
  });

  // --- static front end ---------------------------------------------------

  app.get('/', (req, res, next) => {
    res.sendFile(path.join(staticDir, 'index.html'), { dotfiles: 'deny' }, (err) => {
      if (err) next(err.code === 'ENOENT' ? undefined : err);
    });
  });
  app.use(express.static(staticDir, { index: 'index.html', extensions: false }));
  app.use((req, res) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
  });

  app.use(errorHandler(logger));
  return app;
}

// --- middleware ---------------------------------------------------------------

/** Host names a server bound to a loopback address answers to, whatever the port. */
const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '::1'];
const LOOPBACK_BIND = /^\[?(localhost|127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})\]?$/i;
/** Methods that never change anything, so a cross-site one is harmless (and the browser blocks reading the reply). */
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Two checks a browser cannot be talked out of. The Host check defeats DNS
 * rebinding: a page from evil.example whose name is re-pointed at 127.0.0.1
 * reaches this port with `Host: evil.example`, which the loopback rule (or
 * the ALLOWED_HOSTS list) rejects with 421. The cross-site check defeats
 * CSRF on the body-less routes: a form auto-submitted from another site
 * carries `Sec-Fetch-Site: cross-site` and/or a foreign `Origin`, and gets
 * 403. Tools like curl send neither header and are unaffected.
 *
 * @param {{ bindHost: string, allowedHosts: string[] }} options
 */
function originGuard({ bindHost, allowedHosts }) {
  const allowed = (Array.isArray(allowedHosts) ? allowedHosts : []).map(parseHostEntry).filter(Boolean);
  const localOnly = allowed.length === 0 && LOOPBACK_BIND.test(String(bindHost ?? ''));
  const bound = parseHostEntry(String(bindHost ?? ''));

  function hostAllowed(host) {
    // Local names are always fine: a rebinding attacker cannot make a browser send them.
    if (LOCAL_HOSTNAMES.includes(host.hostname)) return true;
    if (allowed.length > 0) return allowed.some((entry) => entry.hostname === host.hostname && (entry.port === null || entry.port === host.port));
    if (!localOnly) return true;
    return bound !== null && bound.hostname === host.hostname;
  }

  return (req, res, next) => {
    const host = parseHostEntry(req.headers.host);
    if (allowed.length > 0 || localOnly) {
      if (host === null || !hostAllowed(host)) {
        const shown = typeof req.headers.host === 'string' ? req.headers.host : '';
        const fix = host === null ? '' : `; set ALLOWED_HOSTS=${host.hostname} in .env to serve it`;
        return res.status(421).json({ error: `This server does not answer to the host name "${shown}"${fix}` });
      }
    }
    if (SAFE_METHODS.includes(req.method)) return next();
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      return res.status(403).json({ error: 'Cross-site requests are not allowed' });
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !sameHost(origin, req.headers.host)) {
      return res.status(403).json({ error: `Requests from the origin ${origin} are not allowed` });
    }
    return next();
  };
}

/**
 * True when an Origin header names the same host the request was sent to.
 * Ports are compared only when both sides carry one: a reverse proxy that
 * forwards `Host` without the port (nginx's `$host`) would otherwise turn
 * every same-origin request on a non-standard port into a 403.
 */
function sameHost(origin, host) {
  let originHost;
  try {
    originHost = parseHostEntry(new URL(origin).host);
  } catch {
    return false;
  }
  const requestHost = parseHostEntry(host);
  return originHost !== null && requestHost !== null
    && originHost.hostname === requestHost.hostname
    && (originHost.port === null || requestHost.port === null || originHost.port === requestHost.port);
}

/**
 * `host`, `host:port` or `[v6]:port` → lower-cased hostname (brackets
 * stripped) and port string, or null for anything else.
 *
 * @param {unknown} value
 * @returns {{ hostname: string, port: string | null } | null}
 */
function parseHostEntry(value) {
  if (typeof value !== 'string') return null;
  const match = /^(?:\[([^\]\s]+)\]|([^\s:\[\]/]+))(?::(\d{1,5}))?$/.exec(value.trim());
  if (!match) return null;
  const hostname = (match[1] ?? match[2]).toLowerCase();
  return { hostname, port: match[3] === undefined ? null : match[3] };
}

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
  });
  next();
}

/**
 * HTTP Basic auth with any username. The comparison is constant-time for
 * equal-length passwords; a length mismatch is rejected outright.
 *
 * @param {string} password
 */
function basicAuth(password) {
  const expected = Buffer.from(password, 'utf8');
  return (req, res, next) => {
    if (passwordMatches(req.get('authorization'), expected)) return next();
    res.set('WWW-Authenticate', AUTH_CHALLENGE);
    res.status(401).json({ error: 'Authentication required' });
  };
}

/**
 * @param {string | undefined} header the Authorization header
 * @param {Buffer} expected
 * @returns {boolean}
 */
function passwordMatches(header, expected) {
  if (typeof header !== 'string') return false;
  const [scheme, encoded, extra] = header.trim().split(/\s+/);
  if (!/^basic$/i.test(scheme ?? '') || !encoded || extra !== undefined) return false;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  const given = Buffer.from(decoded.slice(colon + 1), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const rawParser = express.raw({ type: IMAGE_TYPES, limit: '15mb' });

/** `express.raw` for images, with the size error translated into the app's own message. */
function rawImageBody(req, res, next) {
  rawParser(req, res, (err) => {
    next(err?.type === 'entity.too.large' ? new HttpError(413, SIZE_MESSAGE) : err);
  });
}

/**
 * JSON error responses: `{ error, details? }`. Client errors carry their
 * message; anything else is a generic 500 that is logged with its stack.
 *
 * @param {{ error: Function }} logger
 */
function errorHandler(logger) {
  // Express only treats a 4-argument function as an error handler.
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = statusOf(err);
    if (status >= 500) logger.error(`api: ${req.method} ${req.originalUrl} failed:`, err);
    const body = { error: status >= 500 ? 'Internal server error' : clientMessage(err) };
    if (Array.isArray(err?.details)) body.details = err.details;
    res.status(status).json(body);
  };
}

function statusOf(err) {
  const status = err?.status ?? err?.statusCode;
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function clientMessage(err) {
  if (err?.type === 'entity.parse.failed') return 'The request body is not valid JSON';
  return typeof err?.message === 'string' && err.message !== '' ? err.message : 'Request failed';
}

// --- request parsing ----------------------------------------------------------

/** The parsed JSON body as a plain object (an absent body counts as `{}`). */
function jsonBody(req) {
  // express.json leaves req.body undefined for any other Content-Type; a body
  // that was sent but never parsed must not pass as an empty patch.
  if (req.body === undefined && hasBody(req)) throw new HttpError(415, 'Send the body as application/json');
  const body = req.body ?? {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'The request body must be a JSON object');
  }
  return body;
}

/** True when the request carries a body (the same test body-parser uses to skip empty requests). */
function hasBody(req) {
  return req.get('transfer-encoding') !== undefined || Number(req.get('content-length')) > 0;
}

/**
 * `?status=a,b` → validated status list, or null when absent/blank.
 * @param {unknown} value
 * @returns {string[] | null}
 */
function parseStatuses(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, '"status" must be a comma-separated list');
  const statuses = value.split(',').map((s) => s.trim()).filter((s) => s !== '');
  for (const status of statuses) {
    if (!STATUSES.includes(status)) throw new HttpError(400, `Unknown status "${status}"; expected one of ${STATUSES.join(', ')}`);
  }
  return statuses.length > 0 ? statuses : null;
}

/**
 * A time from a JSON body: epoch ms or an ISO-8601 string. A string without
 * a zone designator is read in `timeZone`.
 *
 * @param {unknown} value
 * @param {string} timeZone the configured IANA zone
 * @returns {number} epoch ms, no later than MAX_INSTANT_MS
 */
function parseInstant(value, timeZone) {
  let ms = NaN;
  if (typeof value === 'number' && Number.isFinite(value)) ms = Math.round(value);
  else if (typeof value === 'string' && value.trim() !== '') ms = parseIsoInstant(value.trim(), timeZone);
  if (!Number.isFinite(ms)) throw new HttpError(400, '"at" must be epoch milliseconds or an ISO-8601 date string');
  if (ms > MAX_INSTANT_MS) throw new HttpError(400, '"at" is too far in the future');
  return ms;
}

/**
 * @param {string} text an ISO-8601 date string (trimmed)
 * @param {string} timeZone zone for strings that carry none
 * @returns {number} epoch ms, or NaN when unparsable
 */
function parseIsoInstant(text, timeZone) {
  const local = LOCAL_ISO_PATTERN.exec(text);
  if (local) {
    const [year, month, day, hour, minute, second] = local.slice(1, 7).map((field) => (field === undefined ? 0 : Number(field)));
    // Date.UTC (and so zonedTimeToUtc) rolls an impossible date over — Feb 30
    // becomes Mar 2 — so the fields are checked against the calendar first.
    if (!isCalendarTime({ year, month, day, hour, minute, second })) return NaN;
    const millis = local[7] === undefined ? 0 : Number(local[7].slice(0, 3).padEnd(3, '0'));
    return zonedTimeToUtc({ year, month, day, hour, minute, second }, timeZone) + millis;
  }
  return ZONED_ISO_PATTERN.test(text) ? Date.parse(text) : NaN;
}

/** True when the fields name a real wall-clock time (a DST gap is left to zonedTimeToUtc). */
function isCalendarTime({ year, month, day, hour, minute, second }) {
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * @param {unknown} value query string value
 * @param {string} name for the error message
 * @returns {number} non-negative integer ms
 */
function parseMsQuery(value, name) {
  const ms = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(ms)) throw new HttpError(400, `"${name}" must be epoch milliseconds`);
  return ms;
}

/**
 * @param {unknown} value
 * @returns {string | null} an http(s) URL or null when absent
 */
function parseOptionalUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && value.length <= 2048) {
    try {
      const url = new URL(value.trim());
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {
      // fall through to the error below
    }
  }
  throw new HttpError(400, '"url" must be an http(s) link');
}

/** Lower-cased MIME type without parameters. */
function mimeOf(contentType) {
  return typeof contentType === 'string' ? contentType.split(';')[0].trim().toLowerCase() : '';
}

/**
 * The `X-Filename` header (URL-encoded) reduced to a safe basename, or null.
 * @param {string | undefined} header
 * @returns {string | null}
 */
function originalNameFrom(header) {
  if (typeof header !== 'string' || header === '') return null;
  let name = header;
  try {
    name = decodeURIComponent(header);
  } catch {
    // Not URL-encoded after all; use it as sent.
  }
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop().trim();
  return name === '' ? null : name.slice(0, MAX_FILENAME_CHARS);
}

/**
 * The thread without its trailing empty posts — never fewer than one. The
 * editor leaves an empty card after `---` for the caret and drops such cards
 * the same way before it queues or publishes; a thread sent straight to
 * /schedule, /publish or /retry gets the same treatment (and is stored so),
 * so client and server agree. An empty post in the middle is left alone and
 * fails validation: dropping it would rewrite the thread.
 *
 * @param {Array<{ text: string, media: unknown[] }>} tweets
 * @returns {typeof tweets} the same array when nothing was dropped
 */
function withoutTrailingEmpty(tweets) {
  let end = tweets.length;
  while (end > 1 && isEmptyPost(tweets[end - 1])) end -= 1;
  return end === tweets.length ? tweets : tweets.slice(0, end);
}

/** No text and no image: what validateThread reports as "Post n is empty." */
function isEmptyPost(tweet) {
  const text = typeof tweet?.text === 'string' ? tweet.text : '';
  return text.trim() === '' && (Array.isArray(tweet?.media) ? tweet.media.length : 0) === 0;
}

/**
 * True when any of the first `count` posts differs in what reached X: its
 * text or the images attached to it (alt text and display fields are free).
 *
 * @param {object[]} before the stored posts
 * @param {object[]} after the normalized replacement
 * @param {number} count posts already published
 */
function publishedPostsChanged(before, after, count) {
  const mediaKey = (tweet) => (tweet?.media ?? []).map((item) => item?.id).join('\n');
  for (let index = 0; index < count; index += 1) {
    const old = before[index];
    const next = after[index];
    if (!old || !next || old.text !== next.text || mediaKey(old) !== mediaKey(next)) return true;
  }
  return false;
}

/** @returns {Set<string>} media ids referenced by a draft's posts */
function mediaIdsOf(draft) {
  const ids = new Set();
  for (const tweet of draft.tweets ?? []) {
    for (const item of tweet?.media ?? []) {
      if (typeof item?.id === 'string') ids.add(item.id);
    }
  }
  return ids;
}

/** Media row → the shape stored on tweets and returned by POST /api/media. */
function mediaView(row) {
  return {
    id: row.id,
    url: `/media/${row.id}`,
    name: row.originalName ?? row.filename,
    type: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
  };
}

// --- queue calendar -----------------------------------------------------------

/**
 * Calendar days for `[from, to)`: every slot occurrence as an entry (filled by
 * the draft scheduled exactly then, if any), custom-time drafts as their own
 * entries, and days outside the range for drafts that fall there.
 *
 * @param {{ config: import('./config.js').NormalizedConfig, from: number, to: number, drafts: object[] }} input
 * @returns {Array<{ date: string, startsAt: number, entries: Array<{ at: number, kind: 'slot' | 'custom', draft: object | null }> }>}
 */
export function buildQueueDays({ config, from, to, drafts }) {
  const { timezone, slots } = config;
  const entries = slotTimesBetween(slots, from, to - 1, timezone).map((at) => ({ at, kind: 'slot', draft: null }));
  for (const draft of drafts) {
    // A row stored before the schedule bound existed could hold an instant
    // Date cannot format; it stays in the drafts list but not on the calendar.
    if (!Number.isFinite(draft.scheduledAt) || Math.abs(draft.scheduledAt) > MAX_INSTANT_MS) continue;
    const free = entries.find((entry) => entry.at === draft.scheduledAt && entry.draft === null);
    if (free) free.draft = draft;
    else entries.push({ at: draft.scheduledAt, kind: 'custom', draft });
  }

  /** @type {Map<string, { date: string, startsAt: number, entries: object[] }>} */
  const days = new Map();
  const dayFor = (ms) => {
    const date = formatDateKey(ms, timezone);
    let day = days.get(date);
    if (!day) {
      day = { date, startsAt: startOfDay(ms, timezone), entries: [] };
      days.set(date, day);
    }
    return day;
  };
  for (let dayStart = startOfDay(from, timezone); dayStart < to; dayStart = addDays(dayStart, 1, timezone)) dayFor(dayStart);
  for (const entry of entries) dayFor(entry.at).entries.push(entry);

  const byTime = (a, b) => a.at - b.at || Number(a.draft === null) - Number(b.draft === null);
  return [...days.values()]
    .sort((a, b) => a.startsAt - b.startsAt)
    .map((day) => ({ ...day, entries: day.entries.sort(byTime) }));
}

// --- image inspection ---------------------------------------------------------

/**
 * True when the bytes start with the signature of the declared type.
 * @param {string} type
 * @param {Buffer} bytes
 */
function hasMagicBytes(type, bytes) {
  switch (type) {
    case 'image/png':
      return bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif':
      return bytes.length >= 4 && bytes.toString('latin1', 0, 4) === 'GIF8';
    case 'image/webp':
      return bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP';
    default:
      return false;
  }
}

/**
 * Pixel size from the header, or null when the header is truncated or odd.
 * @param {string} type
 * @param {Buffer} bytes
 * @returns {{ width: number, height: number } | null}
 */
function imageDimensions(type, bytes) {
  let size = null;
  switch (type) {
    case 'image/png':
      if (bytes.length >= 24) size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
      break;
    case 'image/gif':
      if (bytes.length >= 10) size = { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
      break;
    case 'image/jpeg':
      size = jpegDimensions(bytes);
      break;
    case 'image/webp':
      size = webpDimensions(bytes);
      break;
    default:
      break;
  }
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** Walk JPEG segments to the first SOFn marker, which carries the frame size. */
function jpegDimensions(bytes) {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2; // standalone marker without a length
      continue;
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return offset + 9 <= bytes.length ? { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) } : null;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/** WebP: the first chunk is VP8X (extended), VP8L (lossless) or VP8 (lossy), each with its own size encoding. */
function webpDimensions(bytes) {
  if (bytes.length < 30) return null;
  switch (bytes.toString('latin1', 12, 16)) {
    case 'VP8X':
      return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    case 'VP8L': {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case 'VP8 ':
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    default:
      return null;
  }
}

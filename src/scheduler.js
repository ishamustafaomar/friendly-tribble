/**
 * Publish loop. Every `intervalMs` a tick fires manual-mode reminders,
 * publishes due API-mode drafts (resuming half-posted threads), and garbage
 * collects unreferenced images. One draft failing never blocks the others,
 * and every error ends up in the logger or on the draft's `result`.
 */
import fs from 'node:fs';
import path from 'node:path';

import { NotFoundError } from './db.js';
import { validateThread } from './tweet.js';

const HOUR_MS = 3_600_000;
/** Node clamps longer timer delays to 1 ms, which would turn the loop into a busy spin. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const REQUIRED_DB_METHODS = [
  'recoverStuck', 'dueManual', 'claimDueApi', 'updateDraft', 'getDraft', 'getMedia', 'unreferencedMedia', 'deleteMedia',
];

/** Error recorded on an API-mode draft that comes due while no X client exists. */
export const NOT_CONFIGURED_MESSAGE = 'X API keys are not configured. Switch this post to reminder mode or add keys to .env.';
export const ALREADY_POSTED = 'Already posted — duplicate it to edit.';
export const PUBLISHING_NOW = 'This post is being published right now — wait for it to finish.';

/**
 * Thrown by {@link Scheduler.publishNow} when the draft's status rules the
 * publish out. Carries `status = 409` so the HTTP layer can map it directly.
 */
export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
  }
}

/**
 * @typedef {object} ApiResult
 * @property {string[]} tweetIds ids posted so far (across attempts)
 * @property {string | null} url link to the first post
 * @property {string | null} error
 * @property {number | null} failedIndex post index a retry resumes from
 * @property {number} attempts publish attempts made
 */

/**
 * @typedef {object} Scheduler
 * @property {() => void} start recover stuck rows, kick off a first pass (without waiting for it), then tick every interval
 * @property {Promise<void> | null} firstTick the pass start() kicked off, for tests; null before start()
 * @property {() => Promise<void>} stop end the loop; resolves once the draft in flight (if any) has persisted its outcome
 * @property {() => Promise<void>} tick run one pass (joins the pass already running, if any; a no-op after stop())
 * @property {() => Promise<void>} tickFresh run one pass that starts after the pass in flight (if any), so it sees every row queued before the call
 * @property {(id: string) => Promise<object>} publishNow queue a draft for right now and publish it
 */

/** A post's image could not be loaded from disk; `index` is the post to resume from. */
class MissingMediaError extends Error {
  /**
   * @param {number} index 0-based post index
   * @param {string} message
   */
  constructor(index, message) {
    super(message);
    this.name = 'MissingMediaError';
    this.index = index;
  }
}

/**
 * Create the publish loop. Nothing runs until {@link Scheduler.start} or
 * {@link Scheduler.tick} is called.
 *
 * @param {object} options
 * @param {import('./db.js').Db} options.db
 * @param {import('./config.js').NormalizedConfig} options.config
 * @param {{ emit: (type: string, payload: unknown) => void }} options.events
 * @param {import('./x.js').XClient | null} [options.xClient] null = reminder mode only
 * @param {string} options.uploadsDir directory holding media files
 * @param {() => number} [options.now] epoch ms clock, injectable for tests
 * @param {{ error: Function, warn: Function, info: Function }} [options.logger]
 * @param {number} [options.intervalMs] defaults to `config.schedulerIntervalSeconds * 1000`
 * @returns {Scheduler}
 */
export function createScheduler({
  db,
  config,
  events,
  xClient = null,
  uploadsDir,
  now = () => Date.now(),
  logger = console,
  intervalMs = config?.schedulerIntervalSeconds * 1000,
} = {}) {
  validateOptions({ db, config, events, xClient, uploadsDir, now, logger, intervalMs });

  let timer = null;
  /** @type {Promise<void> | null} the pass in progress, shared by concurrent tick() calls */
  let running = null;
  /** @type {Promise<void> | null} the first pass after start() */
  let firstTick = null;
  /** True after stop(): no new pass may start, so nothing touches a database that is about to close. */
  let stopped = false;
  /** @type {number | null} when media GC last ran */
  let lastGcAt = null;

  /** @returns {number} */
  function clock() {
    const t = now();
    if (!Number.isSafeInteger(t)) throw new TypeError(`now() must return integer epoch milliseconds (got ${String(t)})`);
    return t;
  }

  /**
   * Recover rows left in 'publishing', then run the first pass on the next
   * turn of the event loop — not now, so the caller (listen → banner → signal
   * handlers) is never held up behind a thread that happens to be due — and
   * every `intervalMs` after that. The first pass is exposed as `firstTick`.
   */
  function start() {
    if (timer) return;
    stopped = false;
    const recovered = db.recoverStuck(clock());
    if (recovered > 0) logger.warn(`scheduler: re-queued ${recovered} draft(s) left in "publishing" by a previous run`);
    timer = setInterval(tick, intervalMs);
    timer.unref();
    firstTick = new Promise((resolve) => setImmediate(() => resolve(tick())));
  }

  /**
   * End the loop. The draft in flight keeps going until it has persisted its
   * outcome — cutting it short would leave a half-posted thread with stale
   * progress, which the next start would post again — but the other drafts
   * the pass claimed go back to the queue untouched (see runPass).
   * @returns {Promise<void>} resolves when no pass is running any more
   */
  function stop() {
    clearInterval(timer);
    timer = null;
    stopped = true;
    return running ?? Promise.resolve();
  }

  function tick() {
    if (running) return running;
    if (stopped) return Promise.resolve();
    running = runPass()
      .catch((err) => logger.error('scheduler: tick failed:', err))
      .finally(() => { running = null; });
    return running;
  }

  async function runPass() {
    const t = clock();
    remindManual(t);
    const claimed = claimApi(t);
    for (let index = 0; index < claimed.length; index += 1) {
      // Shutdown gives the whole process a few seconds: finish the draft in
      // flight, but do not start another one under that deadline.
      if (stopped) {
        handBack(claimed.slice(index));
        return;
      }
      await handleClaimed(claimed[index], t);
    }
    collectMedia(t);
  }

  /**
   * Return drafts this pass claimed but will not publish to the queue, with
   * their slot and partial result intact, so the next start resumes them
   * instead of finding them stuck in 'publishing'.
   * @param {object[]} drafts
   */
  function handBack(drafts) {
    let returned = 0;
    for (const draft of drafts) {
      if (guarded(`hand back draft ${draft.id}`, () => db.updateDraft(draft.id, { status: 'scheduled' }, clock())) !== undefined) returned += 1;
    }
    if (returned > 0) logger.warn(`scheduler: stopping; handed ${returned} claimed draft(s) back to the queue`);
  }

  /** @param {number} t */
  function remindManual(t) {
    for (const draft of guarded('list manual reminders', () => db.dueManual(t)) ?? []) {
      guarded(`remind draft ${draft.id}`, () => {
        const updated = db.updateDraft(draft.id, { status: 'due', remindedAt: t }, t);
        events.emit('reminder', { draft: updated });
      });
    }
  }

  /** @param {number} t */
  function claimApi(t) {
    return guarded('claim due drafts', () => db.claimDueApi(t)) ?? [];
  }

  /**
   * @param {object} draft already in status 'publishing'
   * @param {number} t tick time
   */
  async function handleClaimed(draft, t) {
    try {
      const prior = priorResult(draft);
      if (!xClient) {
        fail(draft, { ...prior, error: NOT_CONFIGURED_MESSAGE });
      } else if (isMissed(draft, prior, t)) {
        fail(draft, { ...prior, error: missedMessage(draft) });
      } else {
        await publish(draft, prior);
      }
    } catch (err) {
      logger.error(`scheduler: draft ${draft.id} could not be processed:`, err);
    }
  }

  /**
   * A late item with no attempts yet was missed while the server was down;
   * publishing it now would surprise the author. Grace 0 disables the check.
   */
  function isMissed(draft, prior, t) {
    const grace = config.missedGraceMinutes;
    return grace > 0 && t - draft.scheduledAt > grace * 60_000 && prior.attempts === 0;
  }

  function missedMessage(draft) {
    const when = new Date(draft.scheduledAt).toISOString();
    return `Missed its slot: the server was not running at ${when} and the item is more than ${config.missedGraceMinutes} minutes late. Retry or reschedule it.`;
  }

  /**
   * Post the thread from where a previous attempt stopped. Progress is
   * persisted after every post so a crash mid-thread never re-posts.
   *
   * @param {object} draft
   * @param {ApiResult} prior
   */
  async function publish(draft, prior) {
    // The HTTP layer validates before queueing, but a draft can still change
    // afterwards (an edit while a publish-now call waits its turn, a damaged
    // row), and X would reject it — or worse, accept the first posts only.
    const { ok, errors } = validateThread(draft.tweets);
    if (!ok) {
      fail(draft, { ...prior, error: `Fix these first: ${errors.map((problem) => problem.message).join(' ')}` });
      return;
    }
    const startIndex = Math.min(prior.failedIndex ?? 0, draft.tweets.length);
    const attempts = prior.attempts + 1;
    let tweetIds = prior.tweetIds;
    try {
      const tweets = loadThread(draft, startIndex);
      const outcome = await xClient.publishThread({
        tweets,
        startIndex,
        replyToId: tweetIds.at(-1) ?? null,
        onProgress: ({ index, tweetIds: newIds }) => {
          tweetIds = [...prior.tweetIds, ...newIds];
          db.updateDraft(draft.id, { result: apiResult({ tweetIds, failedIndex: index + 1, attempts }) }, clock());
        },
      });
      tweetIds = [...prior.tweetIds, ...outcome.tweetIds];
      const t = clock();
      const posted = db.updateDraft(draft.id, { status: 'posted', postedAt: t, result: apiResult({ tweetIds, attempts }) }, t);
      logger.info(`scheduler: published draft ${draft.id} (${tweetIds.length} post(s))`);
      events.emit('posted', { draft: posted });
    } catch (err) {
      // Duck-typed rather than instanceof so fakes and foreign XPublishError copies work.
      // Only a publish error knows where the thread stopped; anything else
      // (an image missing before posting started, a client bug) resumes from
      // the first post that has no recorded id, so nothing is skipped or re-posted.
      const fromPublish = Array.isArray(err.tweetIds);
      if (fromPublish) tweetIds = [...prior.tweetIds, ...err.tweetIds];
      const failedIndex = fromPublish && Number.isInteger(err.index) ? err.index : Math.max(startIndex, tweetIds.length);
      fail(draft, { tweetIds, failedIndex, attempts, error: describe(err) });
    }
  }

  /**
   * Record a failure and notify listeners.
   * @param {object} draft
   * @param {{ tweetIds: string[], failedIndex: number | null, attempts: number, error: string }} outcome
   */
  function fail(draft, outcome) {
    const t = clock();
    const failed = db.updateDraft(draft.id, { status: 'failed', result: apiResult(outcome) }, t);
    logger.error(`scheduler: draft ${draft.id} failed: ${outcome.error}`);
    events.emit('failed', { draft: failed });
  }

  /**
   * Thread in the shape `publishThread` wants. Media is only read for posts
   * that still have to go out; earlier ones are already live.
   *
   * @param {object} draft
   * @param {number} startIndex
   */
  function loadThread(draft, startIndex) {
    return draft.tweets.map((tweet, index) => ({
      text: tweet.text,
      media: index < startIndex ? [] : (tweet.media ?? []).map((ref) => loadMedia(ref, index)),
    }));
  }

  /**
   * @param {{ id: string, name?: string, type?: string, alt?: string }} ref media reference stored on the tweet
   * @param {number} index post index, for error messages and resume
   */
  function loadMedia(ref, index) {
    const media = db.getMedia(ref.id);
    const label = `Post ${index + 1}: image "${ref.name || ref.id}"`;
    if (!media) throw new MissingMediaError(index, `${label} is no longer in the media library. Remove it from the post and retry.`);
    let buffer;
    try {
      buffer = fs.readFileSync(path.join(uploadsDir, path.basename(media.filename)));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      throw new MissingMediaError(index, `${label} is missing on disk (${media.filename}). Remove it from the post and retry.`);
    }
    // The row's MIME was verified from the file's magic bytes at upload; the
    // reference on the post is whatever the client sent. X's media category
    // and type derive from this value, so only the verified one goes out.
    return { buffer, mimeType: media.mime || ref.type, alt: ref.alt ?? null };
  }

  /** Delete images no draft references any more, at most once an hour. */
  function collectMedia(t) {
    if (lastGcAt !== null && t - lastGcAt < HOUR_MS) return;
    lastGcAt = t;
    const orphans = guarded('list unreferenced media', () => db.unreferencedMedia(t - HOUR_MS)) ?? [];
    let removed = 0;
    for (const media of orphans) {
      if (guarded(`delete media ${media.id}`, () => removeMedia({ db, uploadsDir }, media)) === true) removed += 1;
    }
    if (removed > 0) logger.info(`scheduler: removed ${removed} unreferenced image(s)`);
  }

  /**
   * Run a synchronous step, logging instead of throwing.
   * @returns {unknown} the step's return value, or undefined when it threw
   */
  function guarded(what, fn) {
    try {
      return fn();
    } catch (err) {
      logger.error(`scheduler: could not ${what}:`, err);
      return undefined;
    }
  }

  /**
   * A pass that starts after the one in flight: that pass did its claim step
   * when it began, so a row queued since would sit until the next interval.
   * @returns {Promise<void>}
   */
  async function tickFresh() {
    while (running) await running;
    return tick();
  }

  /**
   * Move a draft to the front of the queue and publish it in this call.
   * @param {string} id
   * @returns {Promise<object>} the draft after the attempt (posted or failed)
   */
  async function publishNow(id) {
    if (!xClient) throw new Error('X API is not configured');
    if (typeof id !== 'string' || id === '') throw new TypeError('publishNow expects a draft id');
    // A pass already in flight has done its claim step, so it would not see
    // this draft; wait it out and start a fresh one.
    while (running) await running;
    // Re-read after the wait: the pass just finished (or a concurrent call)
    // may have published this very draft, and re-queuing it would post it again.
    const draft = db.getDraft(id);
    if (!draft) throw new NotFoundError(`Draft not found: ${id}`);
    if (draft.status === 'posted') throw new ConflictError(ALREADY_POSTED);
    if (draft.status === 'publishing') throw new ConflictError(PUBLISHING_NOW);
    const t = clock();
    db.updateDraft(id, { status: 'scheduled', mode: 'api', scheduledAt: t, remindedAt: null, result: resumableResult(draft) }, t);
    await tick();
    return db.getDraft(id);
  }

  return {
    start,
    stop,
    tick,
    tickFresh,
    publishNow,
    get firstTick() {
      return firstTick;
    },
  };
}

/**
 * Remove one media row and its file (a missing file is not an error).
 *
 * @param {{ db: import('./db.js').Db, uploadsDir: string }} context
 * @param {{ id: string, filename: string }} media
 * @returns {boolean} true when the row existed
 */
export function removeMedia({ db, uploadsDir }, media) {
  try {
    fs.unlinkSync(path.join(uploadsDir, path.basename(media.filename)));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return db.deleteMedia(media.id);
}

/**
 * The resumable parts of a draft's previous API result, with safe defaults
 * when there is none (or it is the manual-mode shape).
 *
 * @param {{ result?: object | null }} draft
 * @returns {ApiResult}
 */
function priorResult(draft) {
  const result = draft.result ?? {};
  const tweetIds = Array.isArray(result.tweetIds) ? result.tweetIds.filter((id) => typeof id === 'string') : [];
  return apiResult({
    tweetIds,
    // Without a recorded id there is nothing to reply to, so the thread starts over.
    failedIndex: tweetIds.length > 0 && Number.isInteger(result.failedIndex) && result.failedIndex >= 0 ? result.failedIndex : null,
    attempts: Number.isInteger(result.attempts) && result.attempts >= 0 ? result.attempts : 0,
  });
}

/**
 * The result a new attempt at this draft must carry so the posts already on
 * X are not posted again: the partial result of a half-posted thread with its
 * error cleared, or null when nothing was posted (or the result is the
 * manual-mode shape). Resumability is a property of the result alone —
 * whatever the status or mode ("Back to drafts", a reminder that came due), a
 * draft that carries tweet ids continues after the last one; only a duplicate
 * starts over.
 *
 * @param {{ result?: object | null }} draft
 * @returns {ApiResult | null}
 */
export function resumableResult(draft) {
  const prior = priorResult(draft);
  return prior.tweetIds.length > 0 ? prior : null;
}

/**
 * @param {{ tweetIds?: string[], error?: string | null, failedIndex?: number | null, attempts?: number }} fields
 * @returns {ApiResult}
 */
function apiResult({ tweetIds = [], error = null, failedIndex = null, attempts = 0 }) {
  return {
    tweetIds,
    url: tweetIds.length > 0 ? `https://x.com/i/status/${tweetIds[0]}` : null,
    error,
    failedIndex,
    attempts,
  };
}

/** Human-readable error text: the message plus the X hint when there is one. */
function describe(err) {
  const message = err?.message || String(err);
  const hint = err?.hint ?? err?.cause?.hint;
  return typeof hint === 'string' && hint !== '' ? `${message} — ${hint}` : message;
}

function validateOptions({ db, config, events, xClient, uploadsDir, now, logger, intervalMs }) {
  const missing = REQUIRED_DB_METHODS.filter((name) => typeof db?.[name] !== 'function');
  if (missing.length > 0) throw new TypeError(`createScheduler: db is missing ${missing.join(', ')}`);
  if (!config || typeof config.missedGraceMinutes !== 'number') {
    throw new TypeError('createScheduler: config must be a normalized config (missedGraceMinutes missing)');
  }
  if (typeof events?.emit !== 'function') throw new TypeError('createScheduler: events must have an emit(type, payload) method');
  if (xClient !== null && typeof xClient?.publishThread !== 'function') {
    throw new TypeError('createScheduler: xClient must be null or expose publishThread()');
  }
  if (typeof uploadsDir !== 'string' || uploadsDir === '') throw new TypeError('createScheduler: uploadsDir must be a non-empty path');
  if (typeof now !== 'function') throw new TypeError('createScheduler: now must be a function');
  for (const level of ['error', 'warn', 'info']) {
    if (typeof logger?.[level] !== 'function') throw new TypeError(`createScheduler: logger.${level} must be a function`);
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > MAX_TIMER_MS) {
    throw new RangeError(`createScheduler: intervalMs must be between 1 and ${MAX_TIMER_MS} ms (got ${String(intervalMs)}); check schedulerIntervalSeconds`);
  }
}

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { ALREADY_POSTED, NOT_CONFIGURED_MESSAGE, createScheduler, removeMedia } from '../src/scheduler.js';
import { XApiError, XPublishError } from '../src/x.js';

const T0 = Date.UTC(2026, 8, 7, 12, 0, 0); // Monday 2026-09-07T12:00:00Z
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');

/**
 * In-memory X client. Posts get ids `id-1`, `id-2`, ... in order; while
 * `failAt` is set, the post with that index throws a real XPublishError
 * (403 with a hint).
 */
function fakeClient({ failAt = null, hint = 'Fix the app permissions.' } = {}) {
  let counter = 0;
  const client = {
    calls: [],
    failAt,
    async publishThread({ tweets, startIndex = 0, replyToId = null, onProgress = null }) {
      client.calls.push({ tweets, startIndex, replyToId });
      const tweetIds = [];
      for (let index = startIndex; index < tweets.length; index += 1) {
        if (index === client.failAt) {
          const cause = new XApiError('X API 403 on POST /2/tweets: Forbidden', { status: 403, endpoint: 'POST /2/tweets', hint });
          throw new XPublishError(`Post ${index + 1} of ${tweets.length} failed: ${cause.message}`, { index, tweetIds, cause });
        }
        counter += 1;
        const tweetId = `id-${counter}`;
        tweetIds.push(tweetId);
        if (onProgress) await onProgress({ index, tweetId, tweetIds: [...tweetIds] });
      }
      return { tweetIds };
    },
  };
  return client;
}

/** A whole scheduler stack around an in-memory database and a pinned clock. */
function setup({ xClient = null, config = {}, now = T0 } = {}) {
  const db = openDb(':memory:');
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otf-'));
  const emitted = [];
  const clock = { now };
  const logged = [];
  const logger = {
    error: (...args) => logged.push(args.join(' ')),
    warn: (...args) => logged.push(args.join(' ')),
    info() {},
  };
  const scheduler = createScheduler({
    db,
    config: normalizeConfig({ timezone: 'UTC', missedGraceMinutes: 180, schedulerIntervalSeconds: 3600, ...config }),
    events: { emit: (type, payload) => emitted.push({ type, payload }) },
    xClient,
    uploadsDir,
    now: () => clock.now,
    logger,
  });
  return {
    db,
    uploadsDir,
    emitted,
    clock,
    logged,
    scheduler,
    cleanup() {
      scheduler.stop();
      db.close();
      fs.rmSync(uploadsDir, { recursive: true, force: true });
    },
  };
}

/** Insert a draft straight into the queue. */
function queued(db, { mode = 'api', scheduledAt = T0, tweets = [{ text: 'hello', media: [] }], result = null, status = 'scheduled' }) {
  const draft = db.createDraft({ tweets, mode }, T0 - HOUR);
  return db.updateDraft(draft.id, { status, scheduledAt, result }, T0 - HOUR);
}

function storeImage(ctx, { id = 'img-1', filename = `${id}.png`, bytes = PNG_BYTES, createdAt = T0 - 2 * HOUR } = {}) {
  fs.writeFileSync(path.join(ctx.uploadsDir, filename), bytes);
  return ctx.db.insertMedia({ id, filename, originalName: 'dot.png', mime: 'image/png', size: bytes.length }, createdAt);
}

describe('createScheduler', () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  it('validates its options', () => {
    const db = openDb(':memory:');
    const config = normalizeConfig({});
    const events = { emit() {} };
    assert.throws(() => createScheduler({ config, events, uploadsDir: '/x' }), /db is missing/);
    assert.throws(() => createScheduler({ db, events, uploadsDir: '/x' }), /config/);
    assert.throws(() => createScheduler({ db, config, uploadsDir: '/x' }), /events/);
    assert.throws(() => createScheduler({ db, config, events }), /uploadsDir/);
    assert.throws(() => createScheduler({ db, config, events, uploadsDir: '/x', xClient: {} }), /publishThread/);
    assert.throws(() => createScheduler({ db, config, events, uploadsDir: '/x', intervalMs: 0 }), RangeError);
    db.close();
  });

  it('fires a reminder for a due manual draft', async () => {
    ctx = setup();
    const draft = queued(ctx.db, { mode: 'manual', scheduledAt: T0 - MINUTE });
    const later = queued(ctx.db, { mode: 'manual', scheduledAt: T0 + MINUTE });

    await ctx.scheduler.tick();

    const due = ctx.db.getDraft(draft.id);
    assert.equal(due.status, 'due');
    assert.equal(due.remindedAt, T0);
    assert.equal(ctx.db.getDraft(later.id).status, 'scheduled');
    assert.deepEqual(ctx.emitted, [{ type: 'reminder', payload: { draft: due } }]);

    await ctx.scheduler.tick();
    assert.equal(ctx.emitted.length, 1, 'a draft is reminded only once');
  });

  it('publishes a due API draft with its images and records the result', async () => {
    const xClient = fakeClient();
    ctx = setup({ xClient });
    storeImage(ctx);
    const draft = queued(ctx.db, {
      tweets: [
        { text: 'one', media: [{ id: 'img-1', url: '/media/img-1', name: 'dot.png', type: 'image/png', size: 8, alt: 'a dot' }] },
        { text: 'two', media: [] },
      ],
    });

    await ctx.scheduler.tick();

    const posted = ctx.db.getDraft(draft.id);
    assert.equal(posted.status, 'posted');
    assert.equal(posted.postedAt, T0);
    assert.deepEqual(posted.result, {
      tweetIds: ['id-1', 'id-2'],
      url: 'https://x.com/i/status/id-1',
      error: null,
      failedIndex: null,
      attempts: 1,
    });
    assert.deepEqual(ctx.emitted, [{ type: 'posted', payload: { draft: posted } }]);

    assert.equal(xClient.calls.length, 1);
    const call = xClient.calls[0];
    assert.equal(call.startIndex, 0);
    assert.equal(call.replyToId, null);
    assert.equal(call.tweets.length, 2);
    assert.equal(call.tweets[0].text, 'one');
    assert.deepEqual(call.tweets[0].media[0].buffer, PNG_BYTES);
    assert.equal(call.tweets[0].media[0].mimeType, 'image/png');
    assert.equal(call.tweets[0].media[0].alt, 'a dot');
    assert.deepEqual(call.tweets[1].media, []);
  });

  it('records a failure with the hint, partial ids and the index to resume from', async () => {
    const xClient = fakeClient({ failAt: 2 });
    ctx = setup({ xClient });
    const draft = queued(ctx.db, { tweets: [{ text: 'a', media: [] }, { text: 'b', media: [] }, { text: 'c', media: [] }] });

    await ctx.scheduler.tick();

    const failed = ctx.db.getDraft(draft.id);
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.result, {
      tweetIds: ['id-1', 'id-2'],
      url: 'https://x.com/i/status/id-1',
      error: 'Post 3 of 3 failed: X API 403 on POST /2/tweets: Forbidden — Fix the app permissions.',
      failedIndex: 2,
      attempts: 1,
    });
    assert.deepEqual(ctx.emitted.map((e) => e.type), ['failed']);
    assert.equal(ctx.emitted[0].payload.draft.status, 'failed');
    assert.ok(ctx.logged.some((line) => line.includes(draft.id) && line.includes('Post 3 of 3 failed')));
  });

  it('persists progress after every post so a crash never re-posts', async () => {
    const seen = [];
    const xClient = {
      async publishThread({ tweets, onProgress }) {
        const tweetIds = [];
        for (let index = 0; index < tweets.length; index += 1) {
          tweetIds.push(`id-${index + 1}`);
          await onProgress({ index, tweetId: tweetIds.at(-1), tweetIds: [...tweetIds] });
          seen.push(ctx.db.getDraft(draft.id).result);
        }
        throw new Error('connection reset');
      },
    };
    ctx = setup({ xClient });
    const draft = queued(ctx.db, { tweets: [{ text: 'a', media: [] }, { text: 'b', media: [] }] });

    await ctx.scheduler.tick();

    assert.deepEqual(seen.map((r) => [r.tweetIds, r.failedIndex, r.attempts]), [[['id-1'], 1, 1], [['id-1', 'id-2'], 2, 1]]);
    const failed = ctx.db.getDraft(draft.id);
    assert.equal(failed.status, 'failed');
    // A plain Error carries no partial ids, so the last persisted progress is
    // kept and the resume point follows it: both posts are live, none is re-sent.
    assert.deepEqual(failed.result.tweetIds, ['id-1', 'id-2']);
    assert.equal(failed.result.error, 'connection reset');
    assert.equal(failed.result.failedIndex, 2);
  });

  it('retries from the failed post, replying to the last posted id', async () => {
    const xClient = fakeClient({ failAt: 1 });
    ctx = setup({ xClient });
    storeImage(ctx);
    const media = [{ id: 'img-1', url: '/media/img-1', name: 'dot.png', type: 'image/png', size: 8 }];
    const draft = queued(ctx.db, { tweets: [{ text: 'a', media }, { text: 'b', media: [] }, { text: 'c', media: [] }] });

    await ctx.scheduler.tick();
    assert.equal(ctx.db.getDraft(draft.id).status, 'failed');

    // What POST /api/drafts/:id/retry does: back into the queue, result kept.
    xClient.failAt = null;
    ctx.db.updateDraft(draft.id, { status: 'scheduled', scheduledAt: T0 }, T0);
    await ctx.scheduler.tick();

    const retry = xClient.calls[1];
    assert.equal(retry.startIndex, 1);
    assert.equal(retry.replyToId, 'id-1');
    assert.deepEqual(retry.tweets[0].media, [], 'media of already-published posts is not read from disk');
    const posted = ctx.db.getDraft(draft.id);
    assert.equal(posted.status, 'posted');
    assert.deepEqual(posted.result, {
      tweetIds: ['id-1', 'id-2', 'id-3'],
      url: 'https://x.com/i/status/id-1',
      error: null,
      failedIndex: null,
      attempts: 2,
    });
    assert.deepEqual(ctx.emitted.map((e) => e.type), ['failed', 'posted']);
  });

  it('fails an API draft with a clear message when no X client is configured', async () => {
    ctx = setup();
    const draft = queued(ctx.db, {});

    await ctx.scheduler.tick();

    const failed = ctx.db.getDraft(draft.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.result.error, NOT_CONFIGURED_MESSAGE);
    assert.equal(failed.result.attempts, 0);
    assert.deepEqual(ctx.emitted.map((e) => e.type), ['failed']);
  });

  it('marks a never-attempted item that is later than the grace period as missed', async () => {
    const xClient = fakeClient();
    ctx = setup({ xClient, config: { missedGraceMinutes: 180 } });
    const late = queued(ctx.db, { scheduledAt: T0 - 4 * HOUR });
    const onTime = queued(ctx.db, { scheduledAt: T0 - 2 * HOUR });
    const lateButAttempted = queued(ctx.db, {
      scheduledAt: T0 - 4 * HOUR,
      result: { tweetIds: [], url: null, error: 'x', failedIndex: 0, attempts: 1 },
    });

    await ctx.scheduler.tick();

    const missed = ctx.db.getDraft(late.id);
    assert.equal(missed.status, 'failed');
    assert.equal(
      missed.result.error,
      `Missed its slot: the server was not running at ${new Date(T0 - 4 * HOUR).toISOString()} and the item is more than 180 minutes late. Retry or reschedule it.`,
    );
    assert.equal(missed.result.attempts, 0);
    assert.equal(ctx.db.getDraft(onTime.id).status, 'posted');
    assert.equal(ctx.db.getDraft(lateButAttempted.id).status, 'posted');
    assert.equal(xClient.calls.length, 2);
  });

  it('publishes late items when missedGraceMinutes is 0', async () => {
    const xClient = fakeClient();
    ctx = setup({ xClient, config: { missedGraceMinutes: 0 } });
    const late = queued(ctx.db, { scheduledAt: T0 - 48 * HOUR });

    await ctx.scheduler.tick();

    assert.equal(ctx.db.getDraft(late.id).status, 'posted');
  });

  it('sends X the MIME the upload verified, not the type stored on the post', async () => {
    const xClient = fakeClient();
    ctx = setup({ xClient });
    const gif = Buffer.from('GIF89a', 'latin1');
    fs.writeFileSync(path.join(ctx.uploadsDir, 'anim.gif'), gif);
    ctx.db.insertMedia({ id: 'anim', filename: 'anim.gif', originalName: 'anim.gif', mime: 'image/gif', size: gif.length }, T0 - HOUR);
    const draft = queued(ctx.db, {
      tweets: [{ text: 'moving', media: [{ id: 'anim', url: '/media/anim', name: 'anim.gif', type: 'image/png', size: 1 }] }],
    });

    await ctx.scheduler.tick();

    assert.equal(ctx.db.getDraft(draft.id).status, 'posted');
    const [{ media }] = xClient.calls[0].tweets;
    assert.equal(media[0].mimeType, 'image/gif');
    assert.deepEqual(media[0].buffer, gif);
  });

  it('fails cleanly when an image is missing instead of crashing the tick', async () => {
    const xClient = fakeClient();
    ctx = setup({ xClient });
    const media = [{ id: 'gone', url: '/media/gone', name: 'gone.png', type: 'image/png', size: 8 }];
    const noRow = queued(ctx.db, { tweets: [{ text: 'a', media: [] }, { text: 'b', media: [] }, { text: 'c', media }] });
    ctx.db.insertMedia({ id: 'unlinked', filename: 'unlinked.png', mime: 'image/png', size: 8 }, T0);
    const noFile = queued(ctx.db, { tweets: [{ text: 'd', media: [] }, { text: 'e', media: [{ ...media[0], id: 'unlinked' }] }] });
    const fine = queued(ctx.db, {});

    await ctx.scheduler.tick();

    const first = ctx.db.getDraft(noRow.id);
    assert.equal(first.status, 'failed');
    assert.match(first.result.error, /Post 3: image "gone.png" is no longer in the media library/);
    // Images are read before anything is posted, so a retry must start at the first post, not the broken one.
    assert.deepEqual([first.result.tweetIds, first.result.failedIndex, first.result.attempts], [[], 0, 1]);
    const second = ctx.db.getDraft(noFile.id);
    assert.equal(second.status, 'failed');
    assert.match(second.result.error, /Post 2: image "gone.png" is missing on disk \(unlinked\.png\)/);
    assert.deepEqual([second.result.tweetIds, second.result.failedIndex], [[], 0]);
    assert.equal(ctx.db.getDraft(fine.id).status, 'posted');
    assert.equal(xClient.calls.length, 1);

    // The file is restored and the item retried: the whole thread goes out, in order.
    fs.writeFileSync(path.join(ctx.uploadsDir, 'unlinked.png'), PNG_BYTES);
    ctx.db.updateDraft(noFile.id, { status: 'scheduled', scheduledAt: T0 }, T0);
    await ctx.scheduler.tick();

    const retry = xClient.calls[1];
    assert.equal(retry.startIndex, 0);
    assert.equal(retry.replyToId, null);
    assert.deepEqual(retry.tweets.map((t) => t.text), ['d', 'e']);
    const posted = ctx.db.getDraft(noFile.id);
    assert.equal(posted.status, 'posted');
    assert.deepEqual(posted.result.tweetIds, ['id-2', 'id-3']);
  });

  it('fails a draft that is no longer a valid thread instead of handing it to X', async () => {
    const xClient = fakeClient();
    ctx = setup({ xClient });
    // Queued while valid, then edited (or damaged) into something X would reject after post 1.
    const draft = queued(ctx.db, { tweets: [{ text: 'fine', media: [] }, { text: 'x'.repeat(300), media: [] }, { text: '', media: [] }] });
    const partial = { tweetIds: ['old-1'], url: 'https://x.com/i/status/old-1', error: null, failedIndex: 1, attempts: 1 };
    const resumed = queued(ctx.db, { tweets: [{ text: 'fine', media: [] }, { text: '   ', media: [] }], result: partial });
    const empty = queued(ctx.db, { tweets: [] });

    await ctx.scheduler.tick();

    const failed = ctx.db.getDraft(draft.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.result.error, 'Fix these first: Post 2 is over the 280-character limit (300/280). Post 3 is empty.');
    assert.deepEqual([failed.result.tweetIds, failed.result.failedIndex, failed.result.attempts], [[], null, 0], 'no attempt was made');
    const kept = ctx.db.getDraft(resumed.id);
    assert.equal(kept.status, 'failed');
    assert.equal(kept.result.error, 'Fix these first: Post 2 is empty.');
    assert.deepEqual([kept.result.tweetIds, kept.result.failedIndex], [['old-1'], 1], 'the resume point survives for the next retry');
    assert.equal(ctx.db.getDraft(empty.id).result.error, 'Fix these first: A thread needs at least one post.');
    assert.equal(xClient.calls.length, 0, 'nothing reached X');
    assert.deepEqual(ctx.emitted.map((e) => e.type), ['failed', 'failed', 'failed']);
  });

  it('tickFresh runs a pass after the one in flight, so a row queued meanwhile does not wait for the next interval', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const seen = [];
    const xClient = {
      async publishThread({ tweets }) {
        seen.push(tweets[0].text);
        if (tweets[0].text === 'slow') await gate;
        return { tweetIds: [`id-${seen.length}`] };
      },
    };
    ctx = setup({ xClient });
    queued(ctx.db, { tweets: [{ text: 'slow', media: [] }] });

    const pass = ctx.scheduler.tick();
    // Queued after the pass did its claim step: tick() just joins that pass, which never sees this row.
    const late = queued(ctx.db, { tweets: [{ text: 'late', media: [] }] });
    assert.equal(ctx.scheduler.tick(), pass, 'tick() joins the pass in flight');
    const fresh = ctx.scheduler.tickFresh();
    assert.deepEqual(seen, ['slow'], 'tickFresh does not start a second pass while one is running');
    release();
    await pass;
    await fresh;

    assert.deepEqual(seen, ['slow', 'late']);
    assert.equal(ctx.db.getDraft(late.id).status, 'posted');
    await ctx.scheduler.tickFresh();
    assert.equal(seen.length, 2, 'with nothing in flight it is a plain pass');
  });

  it('stop() resolves once the pass in flight has persisted its outcome, and later ticks are no-ops', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const xClient = {
      async publishThread({ tweets, onProgress }) {
        await onProgress({ index: 0, tweetId: 'id-1', tweetIds: ['id-1'] });
        await gate;
        await onProgress({ index: 1, tweetId: 'id-2', tweetIds: ['id-1', 'id-2'] });
        return { tweetIds: ['id-1', 'id-2'] };
      },
    };
    ctx = setup({ xClient });
    const draft = queued(ctx.db, { tweets: [{ text: 'a', media: [] }, { text: 'b', media: [] }] });

    const pass = ctx.scheduler.tick();
    let stopped = false;
    const stopping = ctx.scheduler.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false, 'stop() waits for the pass');
    assert.equal(ctx.db.getDraft(draft.id).status, 'publishing');

    release();
    await stopping;
    await pass;
    const posted = ctx.db.getDraft(draft.id);
    assert.equal(posted.status, 'posted');
    assert.deepEqual(posted.result.tweetIds, ['id-1', 'id-2']);

    const later = queued(ctx.db, {});
    await ctx.scheduler.tick();
    assert.equal(ctx.db.getDraft(later.id).status, 'scheduled', 'no pass starts after stop()');
    await ctx.scheduler.stop();
  });

  it('keeps processing other drafts when one throws unexpectedly', async () => {
    let calls = 0;
    const xClient = {
      async publishThread() {
        calls += 1;
        if (calls === 1) throw new TypeError('fake client exploded');
        return { tweetIds: ['id-9'] };
      },
    };
    ctx = setup({ xClient });
    const broken = queued(ctx.db, { scheduledAt: T0 - 2 });
    const fine = queued(ctx.db, { scheduledAt: T0 - 1 });

    await ctx.scheduler.tick();

    assert.equal(ctx.db.getDraft(broken.id).status, 'failed');
    assert.equal(ctx.db.getDraft(broken.id).result.error, 'fake client exploded');
    assert.equal(ctx.db.getDraft(fine.id).status, 'posted');
    assert.deepEqual(ctx.emitted.map((e) => e.type), ['failed', 'posted']);
  });

  it('shares one run between concurrent tick() calls', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const xClient = {
      async publishThread() {
        calls += 1;
        await gate;
        return { tweetIds: ['id-1'] };
      },
    };
    ctx = setup({ xClient });
    queued(ctx.db, {});

    const first = ctx.scheduler.tick();
    const second = ctx.scheduler.tick();
    assert.equal(first, second);
    release();
    await first;
    assert.equal(calls, 1);

    const third = ctx.scheduler.tick();
    assert.notEqual(third, first, 'a new pass starts once the previous one finished');
    await third;
  });

  it('publishNow queues the draft for right now, publishes it and returns the outcome', async () => {
    const xClient = fakeClient();
    ctx = setup({ xClient });
    const draft = ctx.db.createDraft({ tweets: [{ text: 'now', media: [] }], mode: 'manual' }, T0);

    const posted = await ctx.scheduler.publishNow(draft.id);

    assert.equal(posted.status, 'posted');
    assert.equal(posted.mode, 'api');
    assert.equal(posted.scheduledAt, T0);
    assert.equal(posted.result.url, 'https://x.com/i/status/id-1');
    assert.deepEqual(posted, ctx.db.getDraft(draft.id));
  });

  it('publishNow waits for a pass in flight so the draft is not skipped', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const seen = [];
    const xClient = {
      async publishThread({ tweets }) {
        seen.push(tweets[0].text);
        if (tweets[0].text === 'slow') await gate;
        return { tweetIds: [`id-${seen.length}`] };
      },
    };
    ctx = setup({ xClient });
    queued(ctx.db, { tweets: [{ text: 'slow', media: [] }] });
    const other = ctx.db.createDraft({ tweets: [{ text: 'urgent', media: [] }] }, T0);

    const pass = ctx.scheduler.tick();
    const publishing = ctx.scheduler.publishNow(other.id);
    release();
    await pass;
    const result = await publishing;

    assert.deepEqual(seen, ['slow', 'urgent']);
    assert.equal(result.status, 'posted');
  });

  it('publishNow publishes a draft once even when two calls wait out the same busy pass', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const xClient = fakeClient();
    const inner = xClient.publishThread;
    xClient.publishThread = async (input) => {
      if (input.tweets[0].text === 'slow') await gate;
      return inner(input);
    };
    ctx = setup({ xClient });
    queued(ctx.db, { tweets: [{ text: 'slow', media: [] }] });
    const draft = ctx.db.createDraft({ tweets: [{ text: 'my 1', media: [] }, { text: 'my 2', media: [] }] }, T0);

    const pass = ctx.scheduler.tick();
    const first = ctx.scheduler.publishNow(draft.id);
    const second = ctx.scheduler.publishNow(draft.id);
    release();
    await pass;

    const posted = await first;
    assert.equal(posted.status, 'posted');
    assert.deepEqual(posted.result.tweetIds, ['id-2', 'id-3']);
    await assert.rejects(second, { name: 'ConflictError', status: 409, message: ALREADY_POSTED });
    const mine = xClient.calls.filter((call) => call.tweets[0].text === 'my 1');
    assert.equal(mine.length, 1, 'the thread is posted exactly once');
    assert.deepEqual(ctx.db.getDraft(draft.id).result.tweetIds, ['id-2', 'id-3']);
    assert.equal(ctx.db.getDraft(draft.id).result.attempts, 1);
  });

  it('publishNow resumes any draft that carries posted ids, whatever its status, and starts a clean one from its first post', async () => {
    const xClient = fakeClient();
    ctx = setup({ xClient });
    const tweets = [{ text: 'one', media: [] }, { text: 'two', media: [] }];
    const partial = { tweetIds: ['old-1'], url: 'https://x.com/i/status/old-1', error: 'boom', failedIndex: 1, attempts: 1 };
    const failed = queued(ctx.db, { tweets, status: 'failed', result: partial });
    // "Back to drafts" keeps the record of what is on X; so does a reminder that came due.
    const backInDrafts = queued(ctx.db, { tweets, status: 'draft', scheduledAt: null, result: partial });
    const dueReminder = queued(ctx.db, { tweets, mode: 'manual', status: 'due', result: partial });
    const clean = queued(ctx.db, { tweets, status: 'draft', scheduledAt: null });

    const expectResumed = async (draft, label) => {
      const before = xClient.calls.length;
      const resumed = await ctx.scheduler.publishNow(draft.id);
      assert.equal(resumed.status, 'posted', label);
      assert.equal(resumed.result.tweetIds[0], 'old-1', label);
      assert.equal(resumed.result.tweetIds.length, 2, label);
      assert.deepEqual([xClient.calls[before].startIndex, xClient.calls[before].replyToId], [1, 'old-1'], label);
    };
    await expectResumed(failed, 'failed');
    await expectResumed(backInDrafts, 'draft carrying ids');
    await expectResumed(dueReminder, 'due reminder carrying ids');

    const fresh = await ctx.scheduler.publishNow(clean.id);
    assert.equal(fresh.status, 'posted');
    assert.equal(fresh.result.tweetIds.length, 2);
    assert.deepEqual([xClient.calls.at(-1).startIndex, xClient.calls.at(-1).replyToId], [0, null]);
  });

  it('stop() finishes the draft in flight and hands the other claimed drafts back to the queue', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let parked;
    const parkedPromise = new Promise((resolve) => { parked = resolve; });
    let counter = 0;
    const xClient = {
      calls: [],
      async publishThread({ tweets, startIndex = 0 }) {
        xClient.calls.push({ text: tweets[0].text, startIndex });
        if (xClient.calls.length === 1) {
          parked();
          await gate;
        }
        return { tweetIds: tweets.slice(startIndex).map(() => `id-${(counter += 1)}`) };
      },
    };
    ctx = setup({ xClient });
    const a = queued(ctx.db, { tweets: [{ text: 'A', media: [] }], scheduledAt: T0 - 3 * MINUTE });
    const partial = { tweetIds: ['old-1'], url: 'https://x.com/i/status/old-1', error: null, failedIndex: 1, attempts: 1 };
    const b = queued(ctx.db, { tweets: [{ text: 'B', media: [] }, { text: 'B2', media: [] }], scheduledAt: T0 - 2 * MINUTE, result: partial });
    const c = queued(ctx.db, { tweets: [{ text: 'C', media: [] }], scheduledAt: T0 - MINUTE });

    const pass = ctx.scheduler.tick();
    await parkedPromise;
    assert.deepEqual([a, b, c].map((draft) => ctx.db.getDraft(draft.id).status), ['publishing', 'publishing', 'publishing'], 'the pass claims everything due up front');

    const stopping = ctx.scheduler.stop();
    release();
    await stopping;
    await pass;

    assert.equal(ctx.db.getDraft(a.id).status, 'posted', 'the draft in flight is finished');
    assert.deepEqual(xClient.calls.map((call) => call.text), ['A'], 'no other draft is started after stop()');
    for (const [draft, result] of [[b, partial], [c, null]]) {
      const row = ctx.db.getDraft(draft.id);
      assert.equal(row.status, 'scheduled', draft.id);
      assert.equal(row.scheduledAt, draft.scheduledAt, 'the slot is kept');
      assert.deepEqual(row.result, result, 'the partial result is kept');
    }
    assert.ok(ctx.logged.some((line) => line.includes('handed 2 claimed draft(s) back to the queue')), ctx.logged.join('\n'));

    // The next start picks them up where they were: nothing is stuck, nothing is re-posted.
    ctx.scheduler.start();
    await ctx.scheduler.firstTick;
    assert.equal(ctx.db.getDraft(b.id).status, 'posted');
    assert.deepEqual(ctx.db.getDraft(b.id).result.tweetIds, ['old-1', 'id-2']);
    assert.equal(ctx.db.getDraft(c.id).status, 'posted');
    assert.deepEqual(xClient.calls.slice(1), [{ text: 'B', startIndex: 1 }, { text: 'C', startIndex: 0 }]);
    assert.ok(!ctx.logged.some((line) => line.includes('re-queued')), 'nothing was left in "publishing"');
  });

  it('publishNow rejects without an X client or with a bad id', async () => {
    ctx = setup();
    await assert.rejects(ctx.scheduler.publishNow('whatever'), { message: 'X API is not configured' });
    ctx.cleanup();
    ctx = setup({ xClient: fakeClient() });
    await assert.rejects(ctx.scheduler.publishNow('missing'), { name: 'NotFoundError' });
    await assert.rejects(ctx.scheduler.publishNow(''), TypeError);
  });

  it('garbage collects unreferenced images at most once an hour', async () => {
    ctx = setup();
    const orphan = storeImage(ctx, { id: 'orphan', createdAt: T0 - 2 * HOUR });
    const fresh = storeImage(ctx, { id: 'fresh', createdAt: T0 - 10 * MINUTE });
    const used = storeImage(ctx, { id: 'used', createdAt: T0 - 2 * HOUR });
    ctx.db.createDraft({ tweets: [{ text: 'x', media: [{ id: 'used', url: '/media/used', name: 'u.png', type: 'image/png', size: 8 }] }] }, T0);

    await ctx.scheduler.tick();
    assert.equal(ctx.db.getMedia('orphan'), null);
    assert.ok(!fs.existsSync(path.join(ctx.uploadsDir, orphan.filename)));
    assert.ok(ctx.db.getMedia('used'));
    assert.ok(fs.existsSync(path.join(ctx.uploadsDir, used.filename)));
    assert.ok(ctx.db.getMedia('fresh'), 'recent uploads are kept: the draft may not be saved yet');

    ctx.clock.now = T0 + 59 * MINUTE; // 'fresh' is now old enough, but GC ran less than an hour ago
    await ctx.scheduler.tick();
    assert.ok(ctx.db.getMedia('fresh'), 'GC does not run again within the hour');

    ctx.clock.now = T0 + HOUR;
    await ctx.scheduler.tick();
    assert.equal(ctx.db.getMedia('fresh'), null);
    assert.ok(!fs.existsSync(path.join(ctx.uploadsDir, fresh.filename)));
  });

  it('start() re-queues drafts stuck in publishing, runs the first pass without holding the caller up, and stop() ends the loop', async () => {
    const xClient = fakeClient();
    ctx = setup({ xClient });
    const stuck = queued(ctx.db, {
      status: 'publishing',
      tweets: [{ text: 'a', media: [] }, { text: 'b', media: [] }],
      result: { tweetIds: ['id-0'], url: 'https://x.com/i/status/id-0', error: null, failedIndex: 1, attempts: 1 },
    });

    assert.equal(ctx.scheduler.firstTick, null, 'no pass before start()');
    assert.equal(ctx.scheduler.start(), undefined, 'start() does not hand back a promise to wait on');
    assert.equal(ctx.db.getDraft(stuck.id).status, 'scheduled', 'recovered right away, but the pass itself waits for the next turn of the event loop');
    assert.equal(xClient.calls.length, 0);
    assert.ok(ctx.scheduler.firstTick instanceof Promise);
    assert.ok(ctx.logged.some((line) => line.includes('re-queued 1 draft')));

    await ctx.scheduler.firstTick;
    const posted = ctx.db.getDraft(stuck.id);
    assert.equal(posted.status, 'posted');
    assert.deepEqual(posted.result.tweetIds, ['id-0', 'id-1']);
    assert.equal(xClient.calls[0].startIndex, 1);
    assert.equal(xClient.calls[0].replyToId, 'id-0');
    ctx.scheduler.stop();
    ctx.scheduler.stop();
  });

  it('stop() before the first pass fires cancels it', async () => {
    const xClient = fakeClient();
    ctx = setup({ xClient });
    const draft = queued(ctx.db, {});
    ctx.scheduler.start();
    await ctx.scheduler.stop();
    await ctx.scheduler.firstTick;
    assert.equal(ctx.db.getDraft(draft.id).status, 'scheduled');
    assert.equal(xClient.calls.length, 0);
  });
});

describe('removeMedia', () => {
  it('removes the row and the file, tolerating a file that is already gone', () => {
    const db = openDb(':memory:');
    const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otf-'));
    const row = db.insertMedia({ id: 'm', filename: 'm.png', mime: 'image/png', size: 1 }, T0);
    fs.writeFileSync(path.join(uploadsDir, 'm.png'), 'x');

    assert.equal(removeMedia({ db, uploadsDir }, row), true);
    assert.ok(!fs.existsSync(path.join(uploadsDir, 'm.png')));
    assert.equal(db.getMedia('m'), null);
    assert.equal(removeMedia({ db, uploadsDir }, row), false);

    db.close();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  });
});

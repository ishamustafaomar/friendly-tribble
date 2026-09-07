import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../src/db.js';
import { startServer } from '../src/server.js';

const T0 = Date.UTC(2026, 8, 7, 12, 0, 0); // Monday 2026-09-07T12:00:00Z
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MON_16 = Date.UTC(2026, 8, 7, 16);
const TUE_09 = Date.UTC(2026, 8, 8, 9);
const TUE_16 = Date.UTC(2026, 8, 8, 16);

/** 1x1 transparent PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
/** GIF89a header declaring 2x3 pixels (enough for the header parser). */
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([2, 0, 3, 0, 0, 0, 0, 0x3b])]);
/** SOI + SOF0 declaring 7x5 pixels. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x05, 0x00, 0x07, 0x03, 0xff, 0xd9]);

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

const TEST_CONFIG = {
  timezone: 'UTC',
  slots: [{ days: 'weekdays', time: '09:00' }, { days: 'weekdays', time: '16:00' }],
  schedulerIntervalSeconds: 3600,
  missedGraceMinutes: 180,
  queueDaysAhead: 3,
};

/** A fake X client: `me()` answers, `publishThread` numbers posts `t-1`, `t-2`, ... */
function fakeXClient() {
  let counter = 0;
  return {
    calls: [],
    async me() {
      return { id: '42', username: 'tester', name: 'Test Er' };
    },
    async publishThread({ tweets, startIndex = 0, replyToId = null, onProgress = null }) {
      this.calls.push({ startIndex, replyToId, texts: tweets.map((t) => t.text) });
      const tweetIds = [];
      for (let index = startIndex; index < tweets.length; index += 1) {
        if (tweets[index].text === 'FAIL') {
          throw Object.assign(new Error(`Post ${index + 1} of ${tweets.length} failed: X API 403 on POST /2/tweets: Forbidden`), { index, tweetIds, hint: 'Check permissions.' });
        }
        counter += 1;
        tweetIds.push(`t-${counter}`);
        if (onProgress) await onProgress({ index, tweetId: tweetIds.at(-1), tweetIds: [...tweetIds] });
      }
      return { tweetIds };
    },
  };
}

/** Start a server on port 0 with a pinned clock and return fetch helpers bound to it. */
async function boot({ env = {}, xClient = null, config = TEST_CONFIG, now = T0, staticDir, dataDir, host } = {}) {
  const clock = { now };
  const instance = await startServer({ env, xClient, config, now: () => clock.now, logger: silentLogger, staticDir, dataDir, host });
  async function call(method, route, { body, headers = {}, raw = false } = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = raw ? body : JSON.stringify(body);
      if (!raw) init.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(instance.url + route, init);
    const text = await res.text();
    let json = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, json, text };
  }
  return {
    ...instance,
    clock,
    call,
    get: (route, opts) => call('GET', route, opts),
    post: (route, body, opts) => call('POST', route, { body, ...opts }),
    put: (route, body) => call('PUT', route, { body }),
    del: (route) => call('DELETE', route),
    async createDraft(tweets = [{ text: 'hello', media: [] }], extra = {}) {
      const { status, json } = await call('POST', '/api/drafts', { body: { tweets, ...extra } });
      assert.equal(status, 201, JSON.stringify(json));
      return json.draft;
    },
  };
}

describe('API (reminder mode)', () => {
  let s;
  before(async () => { s = await boot(); });
  after(() => s.close());

  it('GET /api/status describes the server', async () => {
    const { status, json, headers } = await s.get('/api/status');
    assert.equal(status, 200);
    assert.equal(json.configured, false);
    assert.equal(json.handle, null);
    assert.equal(json.timezone, 'UTC');
    assert.deepEqual(json.slots, [
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '09:00' },
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '16:00' },
    ]);
    assert.equal(json.now, T0);
    assert.equal(json.schedulerIntervalSeconds, 3600);
    assert.equal(json.missedGraceMinutes, 180);
    assert.deepEqual(json.counts, { draft: 0, scheduled: 0, publishing: 0, due: 0, posted: 0, failed: 0 });
    assert.match(json.version, /^\d+\.\d+\.\d+$/);
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('referrer-policy'), 'no-referrer');
    assert.match(headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors 'none'/);
    assert.equal(headers.get('x-powered-by'), null);
  });

  it('creates, normalizes, reads, updates, lists and deletes drafts', async () => {
    const created = await s.post('/api/drafts', {
      tweets: [{ text: 'hi', extra: 1, media: [{ id: 'm1', junk: true, url: '/media/m1', type: 'image/png' }] }, 'garbage'],
    });
    assert.equal(created.status, 201);
    const draft = created.json.draft;
    assert.deepEqual(draft.tweets, [
      { text: 'hi', media: [{ id: 'm1', url: '/media/m1', name: '', type: 'image/png', size: 0 }] },
      { text: '', media: [] },
    ]);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.mode, 'manual', 'defaults to reminder mode when X is not configured');
    assert.equal(draft.createdAt, T0);

    const empty = await s.post('/api/drafts', {});
    assert.deepEqual(empty.json.draft.tweets, [{ text: '', media: [] }]);

    const fetched = await s.get(`/api/drafts/${draft.id}`);
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.json.draft, draft);

    const updated = await s.put(`/api/drafts/${draft.id}`, { tweets: [{ text: 'edited', media: [] }], ignored: true });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.json.draft.tweets, [{ text: 'edited', media: [] }]);

    const listed = await s.get('/api/drafts?status=draft');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.drafts.map((d) => d.id).sort(), [draft.id, empty.json.draft.id].sort());
    assert.deepEqual((await s.get('/api/drafts?status=posted,failed')).json.drafts, []);
    assert.equal((await s.get('/api/drafts')).json.drafts.length, 2);

    const removed = await s.del(`/api/drafts/${draft.id}`);
    assert.equal(removed.status, 204);
    assert.equal((await s.get(`/api/drafts/${draft.id}`)).status, 404);
    assert.equal((await s.del(`/api/drafts/${draft.id}`)).status, 404);
    await s.del(`/api/drafts/${empty.json.draft.id}`);
  });

  it('rejects bad input with 400 and a message', async () => {
    assert.equal((await s.get('/api/drafts?status=bogus')).status, 400);
    assert.equal((await s.post('/api/drafts', { mode: 'carrier-pigeon' })).status, 400);
    const api = await s.post('/api/drafts', { mode: 'api' });
    assert.equal(api.status, 400);
    assert.match(api.json.error, /X API keys are not configured/);
    const array = await s.post('/api/drafts', [1, 2]);
    assert.equal(array.status, 400);
    const broken = await s.call('POST', '/api/drafts', { body: '{not json', raw: true, headers: { 'Content-Type': 'application/json' } });
    assert.equal(broken.status, 400);
    assert.match(broken.json.error, /not valid JSON/);
    assert.equal((await s.get('/api/drafts/../etc')).status, 404);
  });

  it('duplicates a draft with the same posts and media references', async () => {
    const media = [{ id: 'm9', url: '/media/m9', name: 'x.png', type: 'image/png', size: 1 }];
    const source = await s.createDraft([{ text: 'copy me', media }]);
    const { status, json } = await s.post(`/api/drafts/${source.id}/duplicate`);
    assert.equal(status, 201);
    assert.notEqual(json.draft.id, source.id);
    assert.equal(json.draft.status, 'draft');
    assert.deepEqual(json.draft.tweets, source.tweets);
    await s.del(`/api/drafts/${source.id}`);
    await s.del(`/api/drafts/${json.draft.id}`);
  });

  it('schedules into the next free slot, then the one after, and exposes /api/slots/next', async () => {
    const first = await s.createDraft();
    const second = await s.createDraft();

    const a = await s.post(`/api/drafts/${first.id}/schedule`, { nextFree: true });
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(a.json.draft.status, 'scheduled');
    assert.equal(a.json.draft.mode, 'manual');
    assert.equal(a.json.draft.scheduledAt, MON_16);
    assert.equal(a.json.draft.result, null);

    const b = await s.post(`/api/drafts/${second.id}/schedule`, { nextFree: true });
    assert.equal(b.json.draft.scheduledAt, TUE_09);

    const next = await s.get('/api/slots/next');
    assert.deepEqual(next.json, { at: TUE_16, taken: [MON_16, TUE_09] });
    const excluding = await s.get(`/api/slots/next?exclude=${first.id}`);
    assert.deepEqual(excluding.json, { at: MON_16, taken: [TUE_09] });
    assert.equal((await s.get('/api/slots/next?exclude=%00')).status, 400);

    // Rescheduling keeps its own slot available to itself.
    const again = await s.post(`/api/drafts/${first.id}/schedule`, { nextFree: true });
    assert.equal(again.json.draft.scheduledAt, MON_16);

    await s.del(`/api/drafts/${first.id}`);
    await s.del(`/api/drafts/${second.id}`);
  });

  it('answers 409 when there is no free slot at all', async () => {
    const empty = await boot({ config: { ...TEST_CONFIG, slots: [] } });
    try {
      const draft = await empty.createDraft();
      const { status, json } = await empty.post(`/api/drafts/${draft.id}/schedule`, { nextFree: true });
      assert.equal(status, 409);
      assert.equal(json.error, 'No free slot found — add slots to config.json');
      assert.deepEqual((await empty.get('/api/slots/next')).json, { at: null, taken: [] });
    } finally {
      await empty.close();
    }
  });

  it('schedules at a custom time (ms or ISO), rejecting the past and ambiguous bodies', async () => {
    const draft = await s.createDraft();
    const past = await s.post(`/api/drafts/${draft.id}/schedule`, { at: T0 - 2 * MINUTE });
    assert.equal(past.status, 400);
    assert.equal(past.json.error, 'That time is in the past');

    assert.equal((await s.post(`/api/drafts/${draft.id}/schedule`, { at: T0 + HOUR, nextFree: true })).status, 400);
    assert.equal((await s.post(`/api/drafts/${draft.id}/schedule`, {})).status, 400);
    assert.equal((await s.post(`/api/drafts/${draft.id}/schedule`, { at: 'next tuesday' })).status, 400);
    assert.equal((await s.post(`/api/drafts/${draft.id}/schedule`, { at: T0 + HOUR, mode: 'api' })).status, 400);

    const grace = await s.post(`/api/drafts/${draft.id}/schedule`, { at: T0 - 30_000 });
    assert.equal(grace.status, 200, 'a little clock skew is tolerated');

    const iso = await s.post(`/api/drafts/${draft.id}/schedule`, { at: new Date(T0 + 90 * MINUTE).toISOString() });
    assert.equal(iso.status, 200);
    assert.equal(iso.json.draft.scheduledAt, T0 + 90 * MINUTE);
    assert.equal(iso.json.draft.status, 'scheduled');
    await s.del(`/api/drafts/${draft.id}`);
  });

  it('stores a custom time to the whole minute, so a time a few ms off a slot still occupies it', async () => {
    const a = await s.createDraft([{ text: 'a', media: [] }]);
    const b = await s.createDraft([{ text: 'b', media: [] }]);
    // Slots and the browser's datetime-local input are minute-granular; a script sending 16:00:00.005
    // used to leave the 16:00 slot "free" beside a card showing the same minute, and next-free filled it.
    const stored = await s.post(`/api/drafts/${a.id}/schedule`, { at: MON_16 + 5 });
    assert.equal(stored.status, 200, JSON.stringify(stored.json));
    assert.equal(stored.json.draft.scheduledAt, MON_16);
    assert.deepEqual((await s.get('/api/slots/next')).json, { at: TUE_09, taken: [MON_16] });
    assert.equal((await s.post(`/api/drafts/${b.id}/schedule`, { nextFree: true })).json.draft.scheduledAt, TUE_09);
    const queue = await s.get('/api/queue');
    assert.deepEqual(queue.json.days[0].entries.map((e) => [e.at, e.kind, e.draft?.id ?? null]), [
      [Date.UTC(2026, 8, 7, 9), 'slot', null],
      [MON_16, 'slot', a.id],
    ]);

    // Floored, never rounded up: "now" stays due at the next tick, and the displayed minute is the one asked for.
    const iso = await s.post(`/api/drafts/${b.id}/schedule`, { at: '2026-09-08T09:00:59.999Z' });
    assert.equal(iso.json.draft.scheduledAt, TUE_09);
    assert.equal((await s.post(`/api/drafts/${b.id}/schedule`, { at: T0 + 30_000 })).json.draft.scheduledAt, T0);
    // The past check applies to the time as sent, so the tolerance is not eaten by the flooring.
    assert.equal((await s.post(`/api/drafts/${b.id}/schedule`, { at: T0 - 59_000 })).status, 200);
    assert.equal((await s.post(`/api/drafts/${b.id}/schedule`, { at: T0 - 61_000 })).status, 400);

    await s.del(`/api/drafts/${a.id}`);
    await s.del(`/api/drafts/${b.id}`);
  });

  it('refuses to schedule an invalid thread with details', async () => {
    const draft = await s.createDraft([{ text: '   ', media: [] }, { text: 'x'.repeat(300), media: [] }]);
    const { status, json } = await s.post(`/api/drafts/${draft.id}/schedule`, { nextFree: true });
    assert.equal(status, 400);
    assert.equal(json.error, 'Fix these first');
    assert.deepEqual(json.details, [
      { index: 0, message: 'Post 1 is empty.' },
      { index: 1, message: 'Post 2 is over the 280-character limit (300/280).' },
    ]);
    await s.del(`/api/drafts/${draft.id}`);
  });

  it('refuses a time past what the calendar can show, and a stored one never breaks GET /api/queue', async () => {
    const draft = await s.createDraft();
    // 2^53 and beyond used to reach the database and answer 500; safe integers past the Date range were stored and
    // made every GET /api/queue throw "Invalid time value" until the draft was unscheduled.
    for (const at of [2 ** 53, 1e300, Number.MAX_SAFE_INTEGER, 8_640_000_000_000_001, 8_640_000_000_000_000, '+275760-09-13T00:00:00.000Z']) {
      const { status, json } = await s.post(`/api/drafts/${draft.id}/schedule`, { at });
      assert.equal(status, 400, `at=${at}: ${JSON.stringify(json)}`);
      assert.equal(json.error, '"at" is too far in the future');
    }
    assert.equal((await s.get(`/api/drafts/${draft.id}`)).json.draft.status, 'draft');
    const far = await s.post(`/api/drafts/${draft.id}/schedule`, { at: '9999-12-31T00:00:00.000Z' });
    assert.equal(far.status, 200, JSON.stringify(far.json));
    assert.equal((await s.get('/api/queue')).status, 200);

    // A row stored before the bound existed: the calendar skips it rather than answering 500 for everyone.
    s.db.updateDraft(draft.id, { scheduledAt: 8_640_000_000_000_000 }, T0);
    const queue = await s.get('/api/queue');
    assert.equal(queue.status, 200, JSON.stringify(queue.json));
    assert.ok(!queue.json.days.some((day) => day.entries.some((entry) => entry.draft?.id === draft.id)));
    assert.equal((await s.get('/api/queue?from=0&to=1')).status, 200);
    assert.ok((await s.get('/api/drafts?status=scheduled')).json.drafts.some((d) => d.id === draft.id), 'still listed');
    await s.del(`/api/drafts/${draft.id}`);
  });

  it('reads an ISO "at" without a zone designator in the configured zone, not the server process zone', async () => {
    const ny = await boot({ config: { ...TEST_CONFIG, timezone: 'America/New_York' } });
    try {
      const draft = await ny.createDraft();
      const nineEdt = Date.UTC(2026, 8, 8, 13); // 09:00 in New York (UTC-4 in September)
      const cases = [
        ['2026-09-08T09:00', nineEdt],
        // Seconds and fractions parse (a 400 would mean they did not) but the stored time is floored to the minute.
        ['2026-09-08T09:00:30', nineEdt],
        ['2026-09-08T09:00:59.9999', nineEdt],
        ['2026-09-08T09:01:30.2509', nineEdt + MINUTE],
        ['2026-09-08 09:00', nineEdt],
        ['2026-09-08', Date.UTC(2026, 8, 8, 4)], // midnight in New York, not UTC
        ['2026-09-08T09:00-04:00', nineEdt],
        ['2026-09-08T13:00:00.000Z', nineEdt],
        ['2026-09-08T09:00:00.000+05:30', Date.UTC(2026, 8, 8, 3, 30)],
        ['2028-02-29T09:00', Date.UTC(2028, 1, 29, 14)], // a real leap day, 09:00 EST
        ['2027-03-14T02:30', Date.UTC(2027, 2, 14, 7, 30)], // inside the spring-forward gap: shifted to 03:30 EDT
      ];
      for (const [at, expected] of cases) {
        const { status, json } = await ny.post(`/api/drafts/${draft.id}/schedule`, { at });
        assert.equal(status, 200, `at=${at}: ${JSON.stringify(json)}`);
        assert.equal(json.draft.scheduledAt, expected, `at=${at}`);
      }
      // Impossible dates must not roll over (Feb 30 → Mar 2), and the legacy
      // formats Date.parse reads in the process zone are not accepted at all.
      const rejected = [
        '2026-13-01T09:00', '2026-09-08T09', '2026-09-08T25:00', '2027-09-08T09:60', 'next tuesday',
        '2027-02-30T09:00', '2027-02-29T09:00', '2027-04-31', '2027-00-10T09:00', '2027-09-00T09:00',
        'March 8, 2027 09:00', 'Tue, 08 Sep 2027 09:00:00 GMT', '9/8/2027', '2027-09-08T09:00 GMT',
      ];
      for (const at of rejected) {
        const { status, json } = await ny.post(`/api/drafts/${draft.id}/schedule`, { at });
        assert.equal(status, 400, `at=${at}`);
        assert.equal(json.error, '"at" must be epoch milliseconds or an ISO-8601 date string', `at=${at}`);
      }
    } finally {
      await ny.close();
    }
  });

  it('PUT keeps a queued draft a valid thread; a plain draft may hold half-typed text', async () => {
    const draft = await s.createDraft([{ text: 'fine', media: [] }]);
    const tooLong = [{ text: 'fine', media: [] }, { text: 'x'.repeat(300), media: [] }, { text: '', media: [] }];
    assert.equal((await s.put(`/api/drafts/${draft.id}`, { tweets: tooLong })).status, 200, 'autosave of a draft is unrestricted');
    assert.equal((await s.put(`/api/drafts/${draft.id}`, { tweets: [{ text: 'fine', media: [] }] })).status, 200);
    assert.equal((await s.post(`/api/drafts/${draft.id}/schedule`, { nextFree: true })).status, 200);

    // The late autosave after "Add to queue" must not put an over-limit thread in the queue.
    const rejected = await s.put(`/api/drafts/${draft.id}`, { tweets: tooLong });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.json.error, 'Fix these first');
    assert.deepEqual(rejected.json.details, [
      { index: 1, message: 'Post 2 is over the 280-character limit (300/280).' },
      { index: 2, message: 'Post 3 is empty.' },
    ]);
    const stored = (await s.get(`/api/drafts/${draft.id}`)).json.draft;
    assert.deepEqual([stored.status, stored.tweets.map((t) => t.text)], ['scheduled', ['fine']]);
    const edited = await s.put(`/api/drafts/${draft.id}`, { tweets: [{ text: 'fine', media: [] }, { text: 'and valid', media: [] }] });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.equal((await s.put(`/api/drafts/${draft.id}`, { mode: 'manual' })).status, 200, 'a mode-only patch does not touch the posts');

    s.db.updateDraft(draft.id, { status: 'due', remindedAt: T0 }, T0);
    assert.equal((await s.put(`/api/drafts/${draft.id}`, { tweets: [{ text: '   ', media: [] }] })).status, 400, 'a due reminder stays postable');
    await s.del(`/api/drafts/${draft.id}`);
  });

  it('answers 415 instead of silently dropping a body that is not sent as JSON', async () => {
    const draft = await s.createDraft([{ text: 'original', media: [] }]);
    const body = JSON.stringify({ tweets: [{ text: 'zzz', media: [] }] });
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/octet-stream']) {
      const { status, json } = await s.call('PUT', `/api/drafts/${draft.id}`, { body, raw: true, headers: { 'Content-Type': type } });
      assert.equal(status, 415, type);
      assert.equal(json.error, 'Send the body as application/json');
    }
    const after = (await s.get(`/api/drafts/${draft.id}`)).json.draft;
    assert.deepEqual([after.tweets[0].text, after.updatedAt], ['original', draft.updatedAt], 'nothing was "saved"');
    const schedule = await s.call('POST', `/api/drafts/${draft.id}/schedule`, {
      body: JSON.stringify({ at: T0 + HOUR }), raw: true, headers: { 'Content-Type': 'text/plain' },
    });
    assert.equal(schedule.status, 415);
    // Routes that take no body still work without one.
    assert.equal((await s.post(`/api/drafts/${draft.id}/duplicate`)).status, 201);
    assert.equal((await s.post(`/api/drafts/${draft.id}/schedule`, { at: T0 + HOUR })).status, 200);
    assert.equal((await s.post(`/api/drafts/${draft.id}/unschedule`)).status, 200);
    await s.del(`/api/drafts/${draft.id}`);
  });

  it('unschedules back to a draft', async () => {
    const draft = await s.createDraft();
    await s.post(`/api/drafts/${draft.id}/schedule`, { nextFree: true });
    const { status, json } = await s.post(`/api/drafts/${draft.id}/unschedule`);
    assert.equal(status, 200);
    assert.equal(json.draft.status, 'draft');
    assert.equal(json.draft.scheduledAt, null);
    assert.equal(json.draft.remindedAt, null);
    assert.deepEqual((await s.get('/api/slots/next')).json.taken, []);
    await s.del(`/api/drafts/${draft.id}`);
  });

  it('marks a due reminder as posted and then refuses edits', async () => {
    const draft = await s.createDraft();
    await s.post(`/api/drafts/${draft.id}/schedule`, { at: T0 + MINUTE });
    assert.equal((await s.post(`/api/drafts/${draft.id}/mark-posted`, { url: 'ftp://nope' })).status, 400);

    // The slot arrives: the scheduler fires the reminder.
    s.clock.now = T0 + 2 * MINUTE;
    await s.scheduler.tick();
    assert.equal((await s.get(`/api/drafts/${draft.id}`)).json.draft.status, 'due');

    const marked = await s.post(`/api/drafts/${draft.id}/mark-posted`, { url: 'https://x.com/tester/status/1' });
    assert.equal(marked.status, 200);
    assert.equal(marked.json.draft.status, 'posted');
    assert.equal(marked.json.draft.postedAt, T0 + 2 * MINUTE);
    assert.deepEqual(marked.json.draft.result, { manual: true, url: 'https://x.com/tester/status/1' });

    const edit = await s.put(`/api/drafts/${draft.id}`, { tweets: [{ text: 'too late', media: [] }] });
    assert.equal(edit.status, 409);
    assert.equal(edit.json.error, 'Already posted — duplicate it to edit.');
    assert.equal((await s.post(`/api/drafts/${draft.id}/schedule`, { nextFree: true })).status, 409);
    assert.equal((await s.post(`/api/drafts/${draft.id}/unschedule`)).status, 409);
    assert.equal((await s.post(`/api/drafts/${draft.id}/mark-posted`, {})).status, 409);
    assert.equal((await s.post(`/api/drafts/${draft.id}/retry`)).status, 409);
    assert.equal((await s.post(`/api/drafts/${draft.id}/publish`)).status, 400, 'publishing needs X keys');

    const fresh = await s.createDraft();
    assert.equal((await s.post(`/api/drafts/${fresh.id}/mark-posted`, {})).status, 409, 'unscheduled drafts cannot be marked');
    s.clock.now = T0;
    await s.del(`/api/drafts/${draft.id}`);
    await s.del(`/api/drafts/${fresh.id}`);
  });

  it('GET /api/queue lays out slots, custom times and overdue items by day', async () => {
    const inSlot = await s.createDraft([{ text: 'in slot', media: [] }]);
    const sameTime = await s.createDraft([{ text: 'same time', media: [] }]);
    const custom = await s.createDraft([{ text: 'custom', media: [] }]);
    await s.post(`/api/drafts/${inSlot.id}/schedule`, { at: MON_16 });
    await s.post(`/api/drafts/${sameTime.id}/schedule`, { at: MON_16 });
    await s.post(`/api/drafts/${custom.id}/schedule`, { at: Date.UTC(2026, 8, 8, 10, 30) });
    // An overdue reminder from last week, still waiting in the queue.
    const overdue = s.db.updateDraft(s.db.createDraft({ tweets: [{ text: 'overdue', media: [] }], mode: 'manual' }, T0).id, {
      status: 'due', scheduledAt: Date.UTC(2026, 8, 5, 9), remindedAt: T0,
    }, T0);

    const { status, json } = await s.get('/api/queue');
    assert.equal(status, 200);
    assert.equal(json.timezone, 'UTC');
    assert.equal(json.now, T0);
    assert.equal(json.from, Date.UTC(2026, 8, 7));
    assert.equal(json.to, Date.UTC(2026, 8, 10));
    assert.deepEqual(json.days.map((d) => [d.date, d.startsAt]), [
      ['2026-09-05', Date.UTC(2026, 8, 5)],
      ['2026-09-07', Date.UTC(2026, 8, 7)],
      ['2026-09-08', Date.UTC(2026, 8, 8)],
      ['2026-09-09', Date.UTC(2026, 8, 9)],
    ]);
    const summary = (day) => day.entries.map((e) => [e.at, e.kind, e.draft?.id ?? null]);
    assert.deepEqual(summary(json.days[0]), [[Date.UTC(2026, 8, 5, 9), 'custom', overdue.id]]);
    assert.deepEqual(summary(json.days[1]), [
      [Date.UTC(2026, 8, 7, 9), 'slot', null],
      [MON_16, 'slot', inSlot.id],
      [MON_16, 'custom', sameTime.id],
    ]);
    assert.deepEqual(summary(json.days[2]), [
      [TUE_09, 'slot', null],
      [Date.UTC(2026, 8, 8, 10, 30), 'custom', custom.id],
      [TUE_16, 'slot', null],
    ]);
    assert.deepEqual(summary(json.days[3]), [[Date.UTC(2026, 8, 9, 9), 'slot', null], [Date.UTC(2026, 8, 9, 16), 'slot', null]]);
    assert.equal(json.days[1].entries[1].draft.status, 'scheduled');
    assert.equal(json.days[0].entries[0].draft.status, 'due');

    const ranged = await s.get(`/api/queue?from=${Date.UTC(2026, 8, 12)}&to=${Date.UTC(2026, 8, 14)}`);
    assert.deepEqual(ranged.json.days.map((d) => [d.date, d.entries.length]), [['2026-09-05', 1], ['2026-09-07', 2], ['2026-09-08', 1], ['2026-09-12', 0], ['2026-09-13', 0]]);
    assert.equal((await s.get('/api/queue?from=5&to=1')).status, 400);
    assert.equal((await s.get('/api/queue?from=abc')).status, 400);
    assert.equal((await s.get(`/api/queue?from=0&to=${T0}`)).status, 400, 'range too large');

    for (const d of [inSlot, sameTime, custom, overdue]) await s.del(`/api/drafts/${d.id}`);
  });

  it('uploads, serves and deletes images', async () => {
    const upload = await s.post('/api/media', PNG, { raw: true, headers: { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('my dot.png') } });
    assert.equal(upload.status, 201, upload.text);
    const media = upload.json.media;
    assert.deepEqual(media, { id: media.id, url: `/media/${media.id}`, name: 'my dot.png', type: 'image/png', size: PNG.length, width: 1, height: 1 });

    const res = await fetch(s.url + media.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
    assert.ok(fs.existsSync(path.join(s.dataDir, 'uploads', `${media.id}.png`)));

    assert.equal((await s.del(`/api/media/${media.id}`)).status, 204);
    assert.equal((await s.get(media.url)).status, 404);
    assert.equal((await s.del(`/api/media/${media.id}`)).status, 404);
    assert.ok(!fs.existsSync(path.join(s.dataDir, 'uploads', `${media.id}.png`)));
  });

  it('stores a media reference with the type the upload verified, whatever the client sent', async () => {
    const upload = await s.post('/api/media', GIF, { raw: true, headers: { 'Content-Type': 'image/gif' } });
    assert.equal(upload.status, 201, upload.text);
    const media = upload.json.media;
    const lying = { ...media, type: 'image/png', size: 1, url: '/media/elsewhere' };
    const unknown = { id: 'not-in-the-library', url: '/media/not-in-the-library', name: 'x.gif', type: 'image/gif', size: 1 };
    const draft = await s.createDraft([{ text: 'a', media: [lying, unknown] }]);
    assert.deepEqual(draft.tweets[0].media[0], { id: media.id, url: media.url, name: media.name, type: 'image/gif', size: GIF.length });
    assert.deepEqual(draft.tweets[0].media[1], unknown, 'a reference the library does not know is kept as sent');

    // The GIF rule now reads the real type: a GIF plus another image cannot be queued.
    const queued = await s.post(`/api/drafts/${draft.id}/schedule`, { nextFree: true });
    assert.equal(queued.status, 400);
    assert.deepEqual(queued.json.details, [{ index: 0, message: 'Post 1: a GIF must be the only attachment.' }]);

    const put = await s.put(`/api/drafts/${draft.id}`, { tweets: [{ text: 'a', media: [lying] }] });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(put.json.draft.tweets[0].media[0].type, 'image/gif');
    const copy = (await s.post(`/api/drafts/${draft.id}/duplicate`)).json.draft;
    assert.equal(copy.tweets[0].media[0].type, 'image/gif');
    await s.del(`/api/drafts/${draft.id}`);
    await s.del(`/api/drafts/${copy.id}`);
  });

  it('reads GIF and JPEG dimensions and keeps a sensible name without X-Filename', async () => {
    const gif = await s.post('/api/media', GIF, { raw: true, headers: { 'Content-Type': 'image/gif' } });
    assert.equal(gif.status, 201, gif.text);
    assert.equal(gif.json.media.width, 2);
    assert.equal(gif.json.media.height, 3);
    assert.equal(gif.json.media.name, `${gif.json.media.id}.gif`);
    const jpeg = await s.post('/api/media', JPEG, { raw: true, headers: { 'Content-Type': 'image/jpeg; charset=binary', 'X-Filename': '%E2%9C%93/../photo.jpg' } });
    assert.equal(jpeg.status, 201, jpeg.text);
    assert.equal(jpeg.json.media.width, 7);
    assert.equal(jpeg.json.media.height, 5);
    assert.equal(jpeg.json.media.name, 'photo.jpg');
    await s.del(`/api/media/${gif.json.media.id}`);
    await s.del(`/api/media/${jpeg.json.media.id}`);
  });

  it('rejects wrong magic bytes, unknown types, empty and oversized uploads', async () => {
    const fake = await s.post('/api/media', Buffer.from('hello world'), { raw: true, headers: { 'Content-Type': 'image/png' } });
    assert.equal(fake.status, 415);
    assert.match(fake.json.error, /not a valid PNG/);
    const text = await s.post('/api/media', Buffer.from('hello'), { raw: true, headers: { 'Content-Type': 'text/plain' } });
    assert.equal(text.status, 415);
    const empty = await s.post('/api/media', Buffer.alloc(0), { raw: true, headers: { 'Content-Type': 'image/png' } });
    assert.equal(empty.status, 400);

    const big = Buffer.alloc(5 * 1024 * 1024 + 1);
    PNG.copy(big);
    const tooBig = await s.post('/api/media', big, { raw: true, headers: { 'Content-Type': 'image/png' } });
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.json.error, 'Images must be 5 MB or smaller; GIFs 15 MB');
    const hugeGif = await s.post('/api/media', Buffer.alloc(15 * 1024 * 1024 + 1), { raw: true, headers: { 'Content-Type': 'image/gif' } });
    assert.equal(hugeGif.status, 413);
    assert.equal(hugeGif.json.error, 'Images must be 5 MB or smaller; GIFs 15 MB');
    assert.deepEqual(s.db.listMedia(), []);
  });

  it('DELETE /api/media/:id refuses an image another draft still uses', async () => {
    const media = (await s.post('/api/media', PNG, { raw: true, headers: { 'Content-Type': 'image/png' } })).json.media;
    const original = await s.createDraft([{ text: 'pic', media: [media] }]);
    const copy = (await s.post(`/api/drafts/${original.id}/duplicate`)).json.draft;
    assert.deepEqual(copy.tweets[0].media.map((m) => m.id), [media.id], 'a duplicate shares the media id');

    // What the front end does when the image is removed from the copy: save without it, then release it.
    assert.equal((await s.put(`/api/drafts/${copy.id}`, { tweets: [{ text: 'pic', media: [] }] })).status, 200);
    const refused = await s.del(`/api/media/${media.id}`);
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error, 'A draft still uses this image; remove it from the post first.');
    assert.equal((await s.get(media.url)).status, 200, 'the original keeps its image');
    assert.ok(fs.existsSync(path.join(s.dataDir, 'uploads', `${media.id}.png`)));

    assert.equal((await s.put(`/api/drafts/${original.id}`, { tweets: [{ text: 'pic', media: [] }] })).status, 200);
    assert.equal((await s.del(`/api/media/${media.id}`)).status, 204, 'unreferenced now');
    assert.equal((await s.get(media.url)).status, 404);
    await s.del(`/api/drafts/${original.id}`);
    await s.del(`/api/drafts/${copy.id}`);
  });

  it('GET /api/queue covers whole calendar days when today has no local midnight (DST starting at 00:00)', async () => {
    // America/Santiago: DST starts 2026-09-06 at 00:00, so the day begins at 01:00 (-03). from + 14 days used to land on
    // 01:00 of day 15, whose 00:30 slot then produced a 15th, one-entry day in the calendar.
    const santiago = await boot({
      config: { ...TEST_CONFIG, timezone: 'America/Santiago', slots: [{ days: 'daily', time: '00:30' }], queueDaysAhead: 14 },
      now: Date.UTC(2026, 8, 6, 15), // 12:00 local
    });
    try {
      const { status, json } = await santiago.get('/api/queue');
      assert.equal(status, 200, JSON.stringify(json));
      assert.equal(json.from, Date.UTC(2026, 8, 6, 4), 'the first instant of the day, after the gap');
      assert.equal(json.to, Date.UTC(2026, 8, 20, 3), 'local midnight 14 days on, not 01:00');
      assert.equal(json.days.length, 14);
      assert.deepEqual([json.days[0].date, json.days.at(-1).date], ['2026-09-06', '2026-09-19']);
      assert.ok(json.days.every((day) => day.entries.length === 1), 'one 00:30 slot on every day, none on a day 15');
    } finally {
      await santiago.close();
    }
  });

  it('GET /api/queue serves the full 400-day range even when it ends in standard time', async () => {
    // 400 calendar days from an EDT midnight end at an EST midnight: 400 days and one hour of elapsed time.
    const server = await boot({ config: { ...TEST_CONFIG, timezone: 'America/New_York', queueDaysAhead: 400 }, now: Date.UTC(2026, 9, 20, 16) });
    try {
      const from = Date.UTC(2026, 9, 20, 4);
      const to = Date.UTC(2027, 10, 24, 5);
      const { status, json } = await server.get('/api/queue');
      assert.equal(status, 200, JSON.stringify(json));
      assert.equal(json.from, from);
      assert.equal(json.to, to);
      assert.equal(json.days.length, 400);
      assert.equal((await server.get(`/api/queue?from=${from}&to=${to}`)).status, 200);
      const tooLong = await server.get(`/api/queue?from=${from}&to=${to + HOUR}`);
      assert.equal(tooLong.status, 400);
      assert.equal(tooLong.json.error, 'The queue range cannot exceed 400 days');
    } finally {
      await server.close();
    }
  });

  it('deleting a draft removes the images only it referenced', async () => {
    const one = (await s.post('/api/media', PNG, { raw: true, headers: { 'Content-Type': 'image/png' } })).json.media;
    const shared = (await s.post('/api/media', PNG, { raw: true, headers: { 'Content-Type': 'image/png' } })).json.media;
    const draft = await s.createDraft([{ text: 'pics', media: [one, shared] }]);
    const other = await s.createDraft([{ text: 'pic', media: [shared] }]);

    assert.equal((await s.del(`/api/drafts/${draft.id}`)).status, 204);
    assert.equal((await s.get(one.url)).status, 404);
    assert.equal((await s.get(shared.url)).status, 200);
    await s.del(`/api/drafts/${other.id}`);
    assert.equal((await s.get(shared.url)).status, 404);
  });

  it('GET /api/events completes the SSE handshake with a hello event', async () => {
    const res = await fetch(`${s.url}/api/events`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const reader = res.body.getReader();
    let received = '';
    while (!received.includes('event: hello')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += Buffer.from(value).toString('utf8');
    }
    assert.match(received, /^retry: 3000\n\n/);
    assert.match(received, /event: hello\ndata: \{"time":\d+\}\n\n/);
    assert.equal(s.events.clientCount(), 1);
    await reader.cancel();
  });

  it('answers unknown API routes with JSON 404 and serves the static front end', async () => {
    const nope = await s.get('/api/nope');
    assert.equal(nope.status, 404);
    assert.deepEqual(nope.json, { error: 'No route for GET /api/nope' });
    assert.equal((await s.post('/api/drafts/x/nope')).status, 404);
    assert.equal((await s.get('/api/x/verify')).status, 400, 'verify needs X keys');

    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otf-static-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>t</title>');
    fs.mkdirSync(path.join(staticDir, 'vendor'));
    fs.writeFileSync(path.join(staticDir, 'vendor', 'x.js'), 'window.x = 1;');
    const served = await boot({ staticDir });
    try {
      const index = await served.get('/');
      assert.equal(index.status, 200);
      assert.match(index.headers.get('content-type'), /^text\/html/);
      assert.equal(index.text, '<!doctype html><title>t</title>');
      assert.equal((await served.get('/vendor/x.js')).text, 'window.x = 1;');
      assert.equal((await served.get('/missing.png')).status, 404);
    } finally {
      await served.close();
      fs.rmSync(staticDir, { recursive: true, force: true });
    }
  });
  it('POST /schedule drops trailing empty posts and stores the thread without them; an empty post in the middle is still refused', async () => {
    const post = (text) => ({ text, media: [] });
    const draft = await s.createDraft([post('hello'), post('  \n'), post('')]);
    assert.equal(draft.tweets.length, 3, 'a plain draft keeps its empty cards');
    const queued = await s.post(`/api/drafts/${draft.id}/schedule`, { nextFree: true });
    assert.equal(queued.status, 200, JSON.stringify(queued.json));
    assert.equal(queued.json.draft.status, 'scheduled');
    assert.deepEqual(queued.json.draft.tweets, [post('hello')]);
    assert.deepEqual((await s.get(`/api/drafts/${draft.id}`)).json.draft.tweets, [post('hello')], 'the trimmed thread is what is stored');

    const gap = await s.createDraft([post('a'), post(''), post('c'), post('')]);
    const refused = await s.post(`/api/drafts/${gap.id}/schedule`, { nextFree: true });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, 'Fix these first');
    assert.deepEqual(refused.json.details, [{ index: 1, message: 'Post 2 is empty.' }], 'only the trailing one is dropped');
    assert.equal((await s.get(`/api/drafts/${gap.id}`)).json.draft.tweets.length, 4, 'a refused thread is left as it was');

    const blank = await s.createDraft([post(''), post('')]);
    const nothing = await s.post(`/api/drafts/${blank.id}/schedule`, { nextFree: true });
    assert.equal(nothing.status, 400);
    assert.deepEqual(nothing.json.details, [{ index: 0, message: 'Post 1 is empty.' }], 'the last post is never dropped');

    const image = { id: 'img-only', url: '/media/img-only', name: 'p.png', type: 'image/png', size: 1 };
    const pictured = await s.createDraft([post('see'), { text: '', media: [image] }, post('')]);
    const kept = await s.post(`/api/drafts/${pictured.id}/schedule`, { at: T0 + HOUR });
    assert.equal(kept.status, 200, JSON.stringify(kept.json));
    assert.deepEqual(kept.json.draft.tweets, [post('see'), { text: '', media: [image] }], 'a post with only an image is a post');

    for (const each of [draft, gap, blank, pictured]) await s.del(`/api/drafts/${each.id}`);
  });
});

describe('API (X configured)', () => {
  let s;
  let xClient;
  before(async () => {
    xClient = fakeXClient();
    s = await boot({ xClient, env: { X_HANDLE: '@tester' } });
  });
  after(() => s.close());

  it('reports the handle and defaults new drafts to API mode', async () => {
    const { json } = await s.get('/api/status');
    assert.equal(json.configured, true);
    assert.equal(json.handle, 'tester');
    const draft = await s.createDraft();
    assert.equal(draft.mode, 'api');
    const manual = await s.createDraft([{ text: 'm', media: [] }], { mode: 'manual' });
    assert.equal(manual.mode, 'manual');
    const switched = await s.put(`/api/drafts/${manual.id}`, { mode: 'api' });
    assert.equal(switched.json.draft.mode, 'api');
    await s.del(`/api/drafts/${draft.id}`);
    await s.del(`/api/drafts/${manual.id}`);
  });

  it('POST /publish posts the thread right away', async () => {
    const draft = await s.createDraft([{ text: 'one', media: [] }, { text: 'two', media: [] }]);
    const { status, json } = await s.post(`/api/drafts/${draft.id}/publish`);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.draft.status, 'posted');
    assert.deepEqual(json.draft.result, { tweetIds: ['t-1', 't-2'], url: 'https://x.com/i/status/t-1', error: null, failedIndex: null, attempts: 1 });
    assert.equal((await s.post(`/api/drafts/${draft.id}/publish`)).status, 409, 'cannot publish twice');
    const blank = await s.createDraft([{ text: '', media: [] }]);
    assert.equal((await s.post(`/api/drafts/${blank.id}/publish`)).status, 400, 'validation runs first');
  });

  it('POST /retry resumes a failed thread from the failed post', async () => {
    const draft = await s.createDraft([{ text: 'ok', media: [] }, { text: 'FAIL', media: [] }]);
    const failed = await s.post(`/api/drafts/${draft.id}/publish`);
    assert.equal(failed.json.draft.status, 'failed');
    assert.deepEqual(failed.json.draft.result.tweetIds, ['t-3']);
    assert.equal(failed.json.draft.result.failedIndex, 1);
    assert.match(failed.json.draft.result.error, /Post 2 of 2 failed.*— Check permissions\.$/);

    const fixed = await s.put(`/api/drafts/${draft.id}`, { tweets: [{ text: 'ok', media: [] }, { text: 'fixed', media: [] }] });
    assert.equal(fixed.status, 200, 'failed drafts stay editable');
    const { status, json } = await s.post(`/api/drafts/${draft.id}/retry`);
    assert.equal(status, 200);
    assert.equal(json.draft.status, 'posted');
    assert.deepEqual(json.draft.result.tweetIds, ['t-3', 't-4']);
    assert.equal(json.draft.result.attempts, 2);
    assert.deepEqual(xClient.calls.at(-1), { startIndex: 1, replyToId: 't-3', texts: ['ok', 'fixed'] });
  });

  /** A failed thread whose first post is already on X, as the scheduler records it. */
  async function seedPartialFailure(texts, tweetId = 'x-old') {
    const draft = await s.createDraft(texts.map((text) => ({ text, media: [] })));
    return s.db.updateDraft(draft.id, {
      status: 'failed',
      result: { tweetIds: [tweetId], url: `https://x.com/i/status/${tweetId}`, error: 'Post 2 of 3 failed: X API 429', failedIndex: 1, attempts: 1 },
    }, T0);
  }

  it('POST /unschedule keeps the posts already on X locked and the next publish continues after them', async () => {
    const draft = await seedPartialFailure(['one', 'two', 'three']);
    const back = await s.post(`/api/drafts/${draft.id}/unschedule`);
    assert.equal(back.status, 200);
    assert.equal(back.json.draft.status, 'draft');
    assert.equal(back.json.draft.scheduledAt, null);
    assert.deepEqual(
      back.json.draft.result,
      { tweetIds: ['x-old'], url: 'https://x.com/i/status/x-old', error: null, failedIndex: 1, attempts: 1 },
      'the resume point survives "Back to drafts"; only the error is cleared',
    );

    const post = (text) => ({ text, media: [] });
    const rewritten = await s.put(`/api/drafts/${draft.id}`, { tweets: [post('NEW A'), post('two'), post('three')] });
    assert.equal(rewritten.status, 409, 'post 1 is on X and stays locked in a plain draft too');
    assert.match(rewritten.json.error, /^Post 1 is already on X/);
    assert.equal((await s.put(`/api/drafts/${draft.id}`, { tweets: [post('one'), post('two fixed'), post('three')] })).status, 200, 'later posts are free to change');

    const { status, json } = await s.post(`/api/drafts/${draft.id}/publish`);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.draft.status, 'posted');
    assert.equal(json.draft.result.tweetIds.length, 3);
    assert.equal(json.draft.result.tweetIds[0], 'x-old', 'the thread is continued, not started over');
    assert.deepEqual(xClient.calls.at(-1), { startIndex: 1, replyToId: 'x-old', texts: ['one', 'two fixed', 'three'] });

    // Duplicate is the one way to post everything again: a fresh draft with no result.
    const copy = await s.post(`/api/drafts/${draft.id}/duplicate`);
    assert.equal(copy.status, 201);
    assert.equal(copy.json.draft.result, null);
    assert.equal((await s.put(`/api/drafts/${copy.json.draft.id}`, { tweets: [post('NEW A'), post('two'), post('three')] })).status, 200);
    await s.del(`/api/drafts/${copy.json.draft.id}`);

    // Unscheduling something that never posted leaves no result behind.
    const plain = await s.createDraft([post('later')]);
    await s.post(`/api/drafts/${plain.id}/schedule`, { at: T0 + HOUR });
    assert.equal((await s.post(`/api/drafts/${plain.id}/unschedule`)).json.draft.result, null);
    await s.del(`/api/drafts/${plain.id}`);
  });

  it('a reminder that carries a partial API result resumes when it goes back to API mode, by schedule or by publish', async () => {
    const post = (text) => ({ text, media: [] });
    for (const route of ['schedule', 'publish']) {
      const draft = await s.createDraft([post('one'), post('two'), post('FAIL')]);
      const failed = (await s.post(`/api/drafts/${draft.id}/publish`)).json.draft;
      assert.equal(failed.status, 'failed', route);
      const [id1, id2] = failed.result.tweetIds;
      assert.ok(id1 && id2, 'two posts went out before the failure');

      // Rescheduled as a reminder: the result stays; the reminder fires and the draft is due.
      const reminder = await s.post(`/api/drafts/${draft.id}/schedule`, { at: T0 + HOUR, mode: 'manual' });
      assert.equal(reminder.status, 200, JSON.stringify(reminder.json));
      assert.deepEqual(reminder.json.draft.result.tweetIds, [id1, id2]);
      s.clock.now = T0 + HOUR;
      await s.scheduler.tick();
      const due = (await s.get(`/api/drafts/${draft.id}`)).json.draft;
      assert.equal(due.status, 'due');
      assert.deepEqual(due.result.tweetIds, [id1, id2], 'the reminder keeps the record of what is on X');

      const locked = await s.put(`/api/drafts/${draft.id}`, { tweets: [post('one edited'), post('two'), post('three')] });
      assert.equal(locked.status, 409, 'the published head is locked while due as well');
      assert.equal((await s.put(`/api/drafts/${draft.id}`, { tweets: [post('one'), post('two'), post('three')] })).status, 200);

      let posted;
      if (route === 'schedule') {
        const queued = await s.post(`/api/drafts/${draft.id}/schedule`, { at: T0 + HOUR, mode: 'api' });
        assert.equal(queued.status, 200, JSON.stringify(queued.json));
        assert.deepEqual(queued.json.draft.result.tweetIds, [id1, id2], 'back in API mode, the ids are kept');
        await s.scheduler.tick();
        posted = (await s.get(`/api/drafts/${draft.id}`)).json.draft;
      } else {
        posted = (await s.post(`/api/drafts/${draft.id}/publish`)).json.draft;
      }
      s.clock.now = T0;
      assert.equal(posted.status, 'posted', route);
      assert.deepEqual(posted.result.tweetIds.slice(0, 2), [id1, id2], route);
      assert.equal(posted.result.tweetIds.length, 3, route);
      assert.equal(posted.result.attempts, 2, route);
      assert.deepEqual(xClient.calls.at(-1), { startIndex: 2, replyToId: id2, texts: ['one', 'two', 'three'] }, route);
    }
  });

  it('POST /schedule keeps the posts a failed thread already published and the new slot resumes it', async () => {
    const draft = await seedPartialFailure(['A one', 'B two', 'C three']);
    const kept = { tweetIds: ['x-old'], url: 'https://x.com/i/status/x-old', error: null, failedIndex: 1, attempts: 1 };
    const first = await s.post(`/api/drafts/${draft.id}/schedule`, { at: T0 + HOUR });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.draft.status, 'scheduled');
    assert.deepEqual(first.json.draft.result, kept, 'the error is cleared, the ids and resume point stay');
    const again = await s.post(`/api/drafts/${draft.id}/schedule`, { at: T0 + 2 * HOUR });
    assert.deepEqual(again.json.draft.result, kept, 'rescheduling a resumable item keeps it resumable');

    s.clock.now = T0 + 2 * HOUR;
    await s.scheduler.tick();
    s.clock.now = T0;
    const posted = (await s.get(`/api/drafts/${draft.id}`)).json.draft;
    assert.equal(posted.status, 'posted');
    assert.equal(posted.result.tweetIds[0], 'x-old');
    assert.equal(posted.result.tweetIds.length, 3);
    assert.equal(posted.result.attempts, 2);
    assert.deepEqual(xClient.calls.at(-1), { startIndex: 1, replyToId: 'x-old', texts: ['A one', 'B two', 'C three'] });

    // Nothing posted yet (a missed slot, no keys): scheduling starts clean.
    const missed = await s.createDraft([{ text: 'late', media: [] }]);
    s.db.updateDraft(missed.id, { status: 'failed', result: { tweetIds: [], url: null, error: 'Missed its slot', failedIndex: null, attempts: 0 } }, T0);
    assert.equal((await s.post(`/api/drafts/${missed.id}/schedule`, { at: T0 + HOUR })).json.draft.result, null);
    await s.del(`/api/drafts/${missed.id}`);
  });

  it('POST /publish resumes a scheduled item that carries a partial thread', async () => {
    const draft = await seedPartialFailure(['P one', 'P two']);
    await s.post(`/api/drafts/${draft.id}/schedule`, { at: T0 + HOUR });
    const { status, json } = await s.post(`/api/drafts/${draft.id}/publish`);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.draft.status, 'posted');
    assert.equal(json.draft.result.tweetIds[0], 'x-old');
    assert.deepEqual(xClient.calls.at(-1), { startIndex: 1, replyToId: 'x-old', texts: ['P one', 'P two'] });
  });

  it('PUT refuses to change posts that are already on X, so a retry resumes the right thread', async () => {
    const draft = await seedPartialFailure(['A', 'B', 'C'], 'x-A');
    const post = (text, media = []) => ({ text, media });
    const refused = async (tweets, label) => {
      const res = await s.put(`/api/drafts/${draft.id}`, { tweets });
      assert.equal(res.status, 409, label);
      assert.equal(res.json.error, 'Post 1 is already on X and cannot be changed — duplicate the draft to rewrite them.');
    };
    await refused([post('B'), post('C')], 'removing the live post');
    await refused([post('A edited'), post('B'), post('C')], 'rewriting the live post');
    await refused([post('N'), post('A'), post('B'), post('C')], 'inserting before the live post');
    await refused([post('A', [{ id: 'm1', url: '/media/m1', name: 'x.png', type: 'image/png', size: 1 }]), post('B'), post('C')], 'attaching an image to the live post');
    assert.equal((await s.get(`/api/drafts/${draft.id}`)).json.draft.tweets[0].text, 'A', 'nothing was saved');

    const edited = await s.put(`/api/drafts/${draft.id}`, { tweets: [post('A'), post('B fixed'), post('C'), post('D')] });
    assert.equal(edited.status, 200, 'posts after the live one are free to change');
    const { status, json } = await s.post(`/api/drafts/${draft.id}/retry`);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.draft.status, 'posted');
    assert.equal(json.draft.result.tweetIds[0], 'x-A');
    assert.equal(json.draft.result.tweetIds.length, 4);
    assert.deepEqual(xClient.calls.at(-1), { startIndex: 1, replyToId: 'x-A', texts: ['A', 'B fixed', 'C', 'D'] });

    const two = await s.createDraft([post('A'), post('B'), post('C')]);
    s.db.updateDraft(two.id, { status: 'failed', result: { tweetIds: ['x-1', 'x-2'], url: null, error: 'x', failedIndex: 2, attempts: 1 } }, T0);
    const res = await s.put(`/api/drafts/${two.id}`, { tweets: [post('A'), post('B changed'), post('C')] });
    assert.equal(res.status, 409);
    assert.match(res.json.error, /^Posts 1–2 are already on X/);
  });

  it('two Publish-now requests that wait out a busy tick post the thread once', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let parked;
    const parkedPromise = new Promise((resolve) => { parked = resolve; });
    const gated = fakeXClient();
    const inner = gated.publishThread.bind(gated);
    gated.publishThread = async (input) => {
      if (input.tweets[0].text === 'slow') {
        parked();
        await gate;
      }
      return inner(input);
    };
    const server = await boot({ xClient: gated });
    try {
      const slow = server.db.createDraft({ tweets: [{ text: 'slow', media: [] }] }, T0);
      server.db.updateDraft(slow.id, { status: 'scheduled', scheduledAt: T0 - MINUTE }, T0);
      const mine = await server.createDraft([{ text: 'my 1', media: [] }, { text: 'my 2', media: [] }]);

      const pass = server.scheduler.tick();
      await parkedPromise;
      const requests = [server.post(`/api/drafts/${mine.id}/publish`), server.post(`/api/drafts/${mine.id}/publish`)];
      await new Promise((resolve) => setTimeout(resolve, 100)); // both handlers are now waiting for the pass
      release();
      await pass;
      const responses = await Promise.all(requests);

      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      const ok = responses.find((r) => r.status === 200);
      const conflict = responses.find((r) => r.status === 409);
      assert.equal(ok.json.draft.status, 'posted');
      assert.deepEqual(ok.json.draft.result.tweetIds, ['t-2', 't-3']);
      assert.equal(conflict.json.error, 'Already posted — duplicate it to edit.');
      assert.equal(gated.calls.filter((call) => call.texts[0] === 'my 1').length, 1);
      const final = (await server.get(`/api/drafts/${mine.id}`)).json.draft;
      assert.deepEqual([final.status, final.result.tweetIds, final.result.attempts], ['posted', ['t-2', 't-3'], 1]);
    } finally {
      await server.close();
    }
  });

  /** A fake client whose publishThread parks on a gate while posting the draft whose first post is `slowText`. */
  function gatedClient(slowText = 'slow') {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let parked;
    const parkedPromise = new Promise((resolve) => { parked = resolve; });
    const client = fakeXClient();
    const inner = client.publishThread.bind(client);
    client.publishThread = async (input) => {
      if (input.tweets[0].text === slowText) {
        parked();
        await gate;
      }
      return inner(input);
    };
    return { client, release, parked: parkedPromise };
  }

  it('POST /publish does not post an edit made while the request waited for a busy pass', async () => {
    const { client, release, parked } = gatedClient();
    const server = await boot({ xClient: client });
    try {
      const slow = server.db.createDraft({ tweets: [{ text: 'slow', media: [] }] }, T0);
      server.db.updateDraft(slow.id, { status: 'scheduled', scheduledAt: T0 - MINUTE }, T0);
      const mine = await server.createDraft([{ text: 'second ok', media: [] }]);

      const pass = server.scheduler.tick();
      await parked;
      const publishing = server.post(`/api/drafts/${mine.id}/publish`); // validated, now waiting for the pass
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Still a plain draft, so the autosave is accepted — but it must not be what goes to X.
      assert.equal((await server.put(`/api/drafts/${mine.id}`, { tweets: [{ text: '   ', media: [] }] })).status, 200);
      release();
      await pass;
      const { status, json } = await publishing;

      assert.equal(status, 200);
      assert.equal(json.draft.status, 'failed');
      assert.equal(json.draft.result.error, 'Fix these first: Post 1 is empty.');
      assert.deepEqual(json.draft.result.tweetIds, []);
      assert.deepEqual(client.calls.map((call) => call.texts), [['slow']], 'the blank post never reached X');
    } finally {
      release(); // close() waits for the pass in flight, so never leave the gate shut
      await server.close();
    }
  });

  it('POST /retry during a busy pass publishes in this call instead of waiting for the next interval', async () => {
    const { client, release, parked } = gatedClient();
    const server = await boot({ xClient: client });
    try {
      const failed = await server.createDraft([{ text: 'ok', media: [] }, { text: 'FAIL', media: [] }]);
      assert.equal((await server.post(`/api/drafts/${failed.id}/publish`)).json.draft.status, 'failed');
      assert.equal((await server.put(`/api/drafts/${failed.id}`, { tweets: [{ text: 'ok', media: [] }, { text: 'fixed', media: [] }] })).status, 200);
      const slow = server.db.createDraft({ tweets: [{ text: 'slow', media: [] }] }, T0);
      server.db.updateDraft(slow.id, { status: 'scheduled', scheduledAt: T0 - MINUTE }, T0);

      const pass = server.scheduler.tick();
      await parked;
      const retrying = server.post(`/api/drafts/${failed.id}/retry`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal((await server.get(`/api/drafts/${failed.id}`)).json.draft.status, 'scheduled', 'the pass in flight did its claim step before the retry');
      release();
      await pass;
      const { status, json } = await retrying;

      assert.equal(status, 200);
      assert.equal(json.draft.status, 'posted', 'the response is the outcome, not an interim "scheduled"');
      assert.deepEqual(json.draft.result.tweetIds, ['t-1', 't-3']);
      assert.equal(json.draft.result.attempts, 2);
      assert.deepEqual(client.calls.map((call) => call.texts), [['ok', 'FAIL'], ['slow'], ['ok', 'fixed']]);
      assert.deepEqual(client.calls.at(-1), { startIndex: 1, replyToId: 't-1', texts: ['ok', 'fixed'] });
    } finally {
      release();
      await server.close();
    }
  });

  it('POST /retry re-validates like schedule and publish do', async () => {
    const draft = await s.createDraft([{ text: 'ok', media: [] }, { text: 'FAIL', media: [] }]);
    assert.equal((await s.post(`/api/drafts/${draft.id}/publish`)).json.draft.status, 'failed');
    assert.equal((await s.put(`/api/drafts/${draft.id}`, { tweets: [{ text: 'ok', media: [] }, { text: 'x'.repeat(300), media: [] }] })).status, 200);
    const { status, json } = await s.post(`/api/drafts/${draft.id}/retry`);
    assert.equal(status, 400);
    assert.equal(json.error, 'Fix these first');
    assert.deepEqual(json.details, [{ index: 1, message: 'Post 2 is over the 280-character limit (300/280).' }]);
    assert.equal((await s.get(`/api/drafts/${draft.id}`)).json.draft.status, 'failed');
  });

  it('close() waits for the publish in flight, so a restart does not post it again', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let parked;
    const parkedPromise = new Promise((resolve) => { parked = resolve; });
    const gated = {
      calls: 0,
      async publishThread({ tweets, onProgress }) {
        gated.calls += 1;
        await onProgress({ index: 0, tweetId: 't-1', tweetIds: ['t-1'] });
        parked();
        await gate; // post 2 is on its way to X
        await onProgress({ index: 1, tweetId: 't-2', tweetIds: ['t-1', 't-2'] });
        return { tweetIds: ['t-1', 't-2'] };
      },
    };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otf-close-'));
    try {
      const server = await boot({ xClient: gated, dataDir });
      const draft = await server.createDraft([{ text: 'one', media: [] }, { text: 'two', media: [] }]);
      assert.equal((await server.post(`/api/drafts/${draft.id}/schedule`, { at: T0 })).status, 200);

      const pass = server.scheduler.tick();
      await parkedPromise;
      let closed = false;
      const closing = server.close().then(() => { closed = true; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(closed, false, 'close() waits for the pass');
      release();
      await closing;
      await pass;

      const db = openDb(path.join(dataDir, 'app.db'));
      const stored = db.getDraft(draft.id);
      db.close();
      assert.equal(stored.status, 'posted');
      assert.deepEqual(stored.result.tweetIds, ['t-1', 't-2']);

      const restarted = await boot({ xClient: gated, dataDir });
      try {
        assert.equal(gated.calls, 1, 'nothing is published again after the restart');
        assert.equal((await restarted.get(`/api/drafts/${draft.id}`)).json.draft.status, 'posted');
      } finally {
        await restarted.close();
      }
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('PUT {mode:"api"} on a due reminder puts it back in the queue at its slot, so the loop posts it', async () => {
    const draft = await s.createDraft([{ text: 'switched', media: [] }], { mode: 'manual' });
    assert.equal((await s.post(`/api/drafts/${draft.id}/schedule`, { at: T0 - 30_000 })).status, 200);
    await s.scheduler.tick();
    const due = (await s.get(`/api/drafts/${draft.id}`)).json.draft;
    assert.deepEqual([due.status, due.remindedAt], ['due', T0]);

    const switched = await s.put(`/api/drafts/${draft.id}`, { mode: 'api' });
    assert.equal(switched.status, 200, JSON.stringify(switched.json));
    assert.deepEqual(
      [switched.json.draft.status, switched.json.draft.mode, switched.json.draft.scheduledAt, switched.json.draft.remindedAt],
      ['scheduled', 'api', T0 - MINUTE, null],
    );
    await s.scheduler.tick();
    const posted = (await s.get(`/api/drafts/${draft.id}`)).json.draft;
    assert.equal(posted.status, 'posted');
    assert.equal(posted.result.tweetIds.length, 1);
    assert.deepEqual(xClient.calls.at(-1).texts, ['switched']);

    // Staying a reminder changes nothing about a due draft.
    const other = await s.createDraft([{ text: 'still due', media: [] }], { mode: 'manual' });
    s.db.updateDraft(other.id, { status: 'due', scheduledAt: T0 - MINUTE, remindedAt: T0 }, T0);
    const same = await s.put(`/api/drafts/${other.id}`, { mode: 'manual' });
    assert.deepEqual([same.json.draft.status, same.json.draft.remindedAt], ['due', T0]);
    await s.del(`/api/drafts/${other.id}`);
  });

  it('GET /api/x/verify calls me() and reports failures without a 5xx', async () => {
    const ok = await s.get('/api/x/verify');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.deepEqual(ok.json.user, { id: '42', username: 'tester', name: 'Test Er' });
    assert.match(ok.json.note, /read/);

    xClient.me = async () => { throw Object.assign(new Error('X API 401 on GET /2/users/me: Unauthorized'), { hint: 'Check the keys.' }); };
    const bad = await s.get('/api/x/verify');
    assert.equal(bad.status, 200);
    assert.deepEqual({ ok: bad.json.ok, error: bad.json.error, hint: bad.json.hint }, { ok: false, error: 'X API 401 on GET /2/users/me: Unauthorized', hint: 'Check the keys.' });
  });
  it('POST /publish and /retry drop trailing empty posts before posting, so nothing empty reaches X', async () => {
    const post = (text) => ({ text, media: [] });
    const draft = await s.createDraft([post('now'), post(''), post(' ')]);
    const published = await s.post(`/api/drafts/${draft.id}/publish`);
    assert.equal(published.status, 200, JSON.stringify(published.json));
    assert.equal(published.json.draft.status, 'posted');
    assert.deepEqual(published.json.draft.tweets, [post('now')], 'stored without the empty posts');
    assert.equal(published.json.draft.result.tweetIds.length, 1);
    assert.deepEqual(xClient.calls.at(-1).texts, ['now']);

    const retried = await s.createDraft([post('ok'), post('FAIL')]);
    const failed = await s.post(`/api/drafts/${retried.id}/publish`);
    assert.equal(failed.json.draft.status, 'failed');
    const [first] = failed.json.draft.result.tweetIds;
    // A failed draft is edited like a plain one: the empty card at its end is saved, then dropped by Retry.
    assert.equal((await s.put(`/api/drafts/${retried.id}`, { tweets: [post('ok'), post('fixed'), post('')] })).status, 200);
    const { status, json } = await s.post(`/api/drafts/${retried.id}/retry`);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.draft.status, 'posted');
    assert.deepEqual(json.draft.tweets, [post('ok'), post('fixed')]);
    assert.equal(json.draft.result.tweetIds[0], first, 'the post already on X is continued, not repeated');
    assert.equal(json.draft.result.tweetIds.length, 2);
    assert.deepEqual(xClient.calls.at(-1), { startIndex: 1, replyToId: first, texts: ['ok', 'fixed'] });

    const gap = await s.createDraft([post('a'), post(''), post('c')]);
    const calls = xClient.calls.length;
    const refused = await s.post(`/api/drafts/${gap.id}/publish`);
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.json.details, [{ index: 1, message: 'Post 2 is empty.' }]);
    assert.equal(xClient.calls.length, calls, 'nothing was sent');
    assert.equal((await s.get(`/api/drafts/${gap.id}`)).json.draft.status, 'draft');

    for (const each of [draft, retried, gap]) await s.del(`/api/drafts/${each.id}`);
  });
});

describe('API (APP_PASSWORD set)', () => {
  let s;
  before(async () => { s = await boot({ env: { APP_PASSWORD: 'open sesame' } }); });
  after(() => s.close());

  const auth = (user, pass) => ({ Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` });

  it('requires Basic auth on every route', async () => {
    for (const route of ['/api/status', '/', '/media/x', '/api/events']) {
      const res = await s.get(route);
      assert.equal(res.status, 401, route);
      assert.equal(res.headers.get('www-authenticate'), 'Basic realm="o_typefully", charset="UTF-8"');
      assert.deepEqual(res.json, { error: 'Authentication required' });
    }
    assert.equal((await s.get('/api/status', { headers: auth('me', 'wrong') })).status, 401);
    assert.equal((await s.get('/api/status', { headers: auth('me', 'open sesam') })).status, 401);
    assert.equal((await s.get('/api/status', { headers: { Authorization: 'Bearer abc' } })).status, 401);
    assert.equal((await s.get('/api/status', { headers: auth('anyone', 'open sesame') })).status, 200);
    assert.equal((await s.get('/api/status', { headers: auth('', 'open sesame') })).status, 200);
  });
});

describe('API (Host and cross-site guard)', () => {
  /** A request with full control over the headers: fetch drops Host and Origin overrides. */
  function raw(url, { method = 'GET', path: requestPath, headers = {}, body = '' } = {}) {
    const { port } = new URL(url);
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers: { 'Content-Length': Buffer.byteLength(body), ...headers },
        setHost: false,
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          let json = null;
          try {
            json = text === '' ? null : JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, text });
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  it('bound to loopback, answers only to local host names, so a rebound DNS name gets nothing', async () => {
    const s = await boot();
    try {
      const { port } = new URL(s.url);
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`, 'localhost', '127.0.0.1', '[::1]']) {
        assert.equal((await raw(s.url, { path: '/api/status', headers: { Host: host } })).status, 200, host);
      }
      for (const host of ['evil.example.com', `evil.example.com:${port}`, `8.8.8.8:${port}`, `127.0.0.2:${port}`, 'bad host', `localhost:${port}/x`]) {
        const res = await raw(s.url, { path: '/api/status', headers: { Host: host } });
        assert.equal(res.status, 421, host);
        assert.match(res.json.error, /does not answer to the host name/, host);
      }
      const hint = await raw(s.url, { path: '/api/status', headers: { Host: 'evil.example.com' } });
      assert.match(hint.json.error, /"evil\.example\.com".*ALLOWED_HOSTS=evil\.example\.com/);
      assert.equal((await raw(s.url, { path: '/media/nothing', headers: { Host: 'evil.example.com' } })).status, 421, '/media is guarded too');
      assert.equal((await raw(s.url, { path: '/api/events', headers: { Host: 'evil.example.com' } })).status, 421);
      assert.equal((await raw(s.url, { method: 'POST', path: '/api/drafts', headers: { Host: 'evil.example.com', 'Content-Type': 'application/json' }, body: '{}' })).status, 421);
      assert.equal((await raw(s.url, { path: '/', headers: { Host: 'evil.example.com' } })).status, 200, 'the static page carries nothing worth guarding');
    } finally {
      await s.close();
    }
  });

  it('ALLOWED_HOSTS adds to the local names: listed names are served, ports must match when given, localhost keeps working', async () => {
    const s = await boot({ env: { ALLOWED_HOSTS: 'Posts.example.com, api.example.com:8080 ,, [::1]:3000' } });
    try {
      const { port } = new URL(s.url);
      for (const host of ['posts.example.com', `posts.example.com:${port}`, 'POSTS.example.com:443', 'api.example.com:8080', '[::1]:3000', `127.0.0.1:${port}`, 'localhost', '[::1]:3001']) {
        assert.equal((await raw(s.url, { path: '/api/status', headers: { Host: host } })).status, 200, host);
      }
      for (const host of ['api.example.com', 'api.example.com:9090', 'evil.example.com', `127.0.0.2:${port}`]) {
        assert.equal((await raw(s.url, { path: '/api/status', headers: { Host: host } })).status, 421, host);
      }
    } finally {
      await s.close();
    }
  });

  it('behind a proxy that strips the port from Host, a same-origin Origin with a port still passes', async () => {
    const s = await boot({ env: { ALLOWED_HOSTS: 'posts.example.com' } });
    try {
      const draft = await s.createDraft([{ text: 'proxied', media: [] }]);
      const send = (origin) => raw(s.url, {
        method: 'POST',
        path: `/api/drafts/${draft.id}/duplicate`,
        headers: { Host: 'posts.example.com', Origin: origin },
      });
      assert.equal((await send('https://posts.example.com:8443')).status, 201, 'port only on the Origin side');
      assert.equal((await send('https://posts.example.com')).status, 201, 'no port on either side');
      assert.equal((await send('https://evil.example')).status, 403, 'another host is still refused');
    } finally {
      await s.close();
    }
  });

  it('GET /healthz answers 200 without a password and whatever the Host header says', async () => {
    const s = await boot({ env: { APP_PASSWORD: 'secret', ALLOWED_HOSTS: 'posts.example.com' } });
    try {
      for (const host of ['posts.example.com', 'evil.example.com', '10.0.0.7:3000']) {
        const res = await raw(s.url, { path: '/healthz', headers: { Host: host } });
        assert.equal(res.status, 200, host);
        assert.deepEqual(res.json, { ok: true });
      }
      assert.equal((await raw(s.url, { path: '/api/status', headers: { Host: 'posts.example.com' } })).status, 401, 'the API itself still wants the password');
    } finally {
      await s.close();
    }
  });

  it('bound to an address other machines can reach, any Host is served unless ALLOWED_HOSTS says otherwise', async () => {
    const open = await boot({ host: '0.0.0.0' });
    try {
      for (const host of ['anything.example', '10.0.0.5:3000', 'localhost']) {
        assert.equal((await raw(open.url, { path: '/api/status', headers: { Host: host } })).status, 200, host);
      }
    } finally {
      await open.close();
    }
    const listed = await boot({ host: '0.0.0.0', env: { ALLOWED_HOSTS: 'posts.example.com' } });
    try {
      assert.equal((await raw(listed.url, { path: '/api/status', headers: { Host: 'posts.example.com' } })).status, 200);
      assert.equal((await raw(listed.url, { path: '/api/status', headers: { Host: 'anything.example' } })).status, 421);
    } finally {
      await listed.close();
    }
  });

  it('refuses state-changing requests a browser marks as cross-site, and keeps same-origin and header-less ones', async () => {
    const xClient = fakeXClient();
    const s = await boot({ xClient });
    try {
      const draft = await s.createDraft([{ text: 'csrf', media: [] }]);
      const { port } = new URL(s.url);
      const self = `127.0.0.1:${port}`;
      const send = (method, route, headers, body) => raw(s.url, { method, path: route, headers: { Host: self, ...headers }, body });

      const crossSite = [
        { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
        { 'Sec-Fetch-Site': 'same-site' },
        { 'Sec-Fetch-Site': 'cross-site' },
        { Origin: 'https://evil.example' },
        { Origin: `http://127.0.0.1:${Number(port) + 1}` },
        { Origin: `http://localhost:${port}` },
        { Origin: 'null' },
        { 'Sec-Fetch-Site': 'same-origin', Origin: 'https://evil.example' },
      ];
      for (const route of ['publish', 'unschedule', 'duplicate', 'retry']) {
        for (const headers of crossSite) {
          const res = await send('POST', `/api/drafts/${draft.id}/${route}`, headers, 'a=b');
          assert.equal(res.status, 403, `${route} ${JSON.stringify(headers)}`);
          assert.match(res.json.error, /not allowed/);
        }
      }
      assert.equal((await send('DELETE', `/api/drafts/${draft.id}`, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
      assert.equal((await send('PUT', `/api/drafts/${draft.id}`, { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, '{"tweets":[]}')).status, 403);
      assert.equal((await s.get(`/api/drafts/${draft.id}`)).json.draft.status, 'draft', 'nothing was published or changed');
      assert.equal(xClient.calls.length, 0);
      assert.equal((await s.get('/api/drafts')).json.drafts.length, 1, 'nothing was duplicated');

      // Reads are never blocked: the browser withholds a cross-site reply anyway.
      assert.equal((await send('GET', '/api/status', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' })).status, 200);

      // What the app's own fetch() sends, what a typed URL sends, and what curl sends.
      const sameOrigin = [
        { 'Sec-Fetch-Site': 'same-origin', Origin: `http://${self}` },
        { 'Sec-Fetch-Site': 'none' },
        { Origin: `http://${self}` },
        { Origin: `HTTP://${self}` },
        {},
      ];
      for (const headers of sameOrigin) {
        const res = await send('POST', `/api/drafts/${draft.id}/duplicate`, headers);
        assert.equal(res.status, 201, JSON.stringify(headers));
        await s.del(`/api/drafts/${res.json.draft.id}`);
      }
      const published = await send('POST', `/api/drafts/${draft.id}/publish`, { 'Sec-Fetch-Site': 'same-origin', Origin: `http://${self}` });
      assert.equal(published.status, 200, JSON.stringify(published.json));
      assert.equal(published.json.draft.status, 'posted');
    } finally {
      await s.close();
    }
  });
});

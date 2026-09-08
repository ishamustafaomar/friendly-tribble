import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MODES, NotFoundError, QUEUE_STATUSES, STATUSES, openDb } from '../src/db.js';

const T0 = Date.UTC(2026, 8, 7, 12, 0, 0); // 2026-09-07T12:00:00Z
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const sampleTweets = [
  { text: 'first', media: [{ id: 'm-1', url: '/media/m-1', name: 'a.png', type: 'image/png', size: 10 }] },
  { text: 'second', media: [] },
];

/** Create a draft and move it straight into the given state (test helper, not a Db feature). */
function seed(db, { status = 'draft', mode = 'api', scheduledAt = null, result = null, tweets, at = T0 } = {}) {
  const draft = db.createDraft({ tweets: tweets ?? [{ text: status, media: [] }], mode }, at);
  return db.updateDraft(draft.id, { status, scheduledAt, result }, at);
}

describe('openDb', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otf-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates parent directories, uses WAL, records the schema version and reopens idempotently', () => {
    const file = path.join(dir, 'nested', 'deeper', 'app.db');
    const db = openDb(file);
    const draft = db.createDraft({ tweets: sampleTweets }, T0);
    db.close();
    assert.ok(fs.existsSync(file));

    const raw = new DatabaseSync(file);
    assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '1');
    raw.close();

    const reopened = openDb(file);
    assert.deepEqual(reopened.getDraft(draft.id), draft);
    reopened.close();
  });

  it('accepts :memory: and starts empty', () => {
    const db = openDb(':memory:');
    assert.deepEqual(db.listDrafts(), []);
    assert.deepEqual(db.listMedia(), []);
    db.close();
  });

  it('rejects a non-string path', () => {
    assert.throws(() => openDb(), { name: 'TypeError', message: /file path/ });
    assert.throws(() => openDb(''), { name: 'TypeError' });
  });

  it('close() is idempotent and later calls fail loudly', () => {
    const db = openDb(':memory:');
    db.close();
    db.close();
    assert.throws(() => db.listDrafts(), /not open/);
  });
});

describe('constants', () => {
  it('exports the status and mode vocabularies', () => {
    assert.deepEqual(STATUSES, ['draft', 'scheduled', 'publishing', 'due', 'posted', 'failed']);
    assert.deepEqual(MODES, ['api', 'manual']);
    assert.deepEqual(QUEUE_STATUSES, ['scheduled', 'publishing', 'due']);
  });
});

describe('drafts CRUD', () => {
  let db;
  beforeEach(() => {
    db?.close();
    db = openDb(':memory:');
  });
  after(() => db.close());

  it('createDraft applies defaults and returns the stored shape', () => {
    const draft = db.createDraft({}, T0);
    assert.match(draft.id, UUID_RE);
    assert.deepEqual(draft, {
      id: draft.id,
      tweets: [{ text: '', media: [] }],
      status: 'draft',
      mode: 'api',
      scheduledAt: null,
      postedAt: null,
      remindedAt: null,
      result: null,
      createdAt: T0,
      updatedAt: T0,
    });
    assert.deepEqual(db.createDraft(undefined, T0).tweets, [{ text: '', media: [] }]);
  });

  it('createDraft stores the given tweets and mode as-is', () => {
    const draft = db.createDraft({ tweets: sampleTweets, mode: 'manual' }, T0);
    assert.deepEqual(draft.tweets, sampleTweets);
    assert.notEqual(draft.tweets, sampleTweets, 'returns a fresh parsed copy');
    assert.equal(draft.mode, 'manual');
    assert.deepEqual(db.getDraft(draft.id), draft);
  });

  it('createDraft validates its input', () => {
    assert.throws(() => db.createDraft({ mode: 'carrier-pigeon' }), { name: 'RangeError', message: /mode must be one of api, manual/ });
    assert.throws(() => db.createDraft({ tweets: 'nope' }), { name: 'TypeError', message: /tweets must be an array/ });
    assert.throws(() => db.createDraft({ status: 'posted' }), { name: 'TypeError', message: /unknown key\(s\) status/ });
    assert.throws(() => db.createDraft([]), { name: 'TypeError' });
    assert.throws(() => db.createDraft({}, 1.5), { name: 'TypeError', message: /now must be an integer/ });
    assert.throws(() => db.createDraft({}, '123'), { name: 'TypeError' });
  });

  it('getDraft returns null for unknown ids and rejects bad ids', () => {
    assert.equal(db.getDraft('missing'), null);
    assert.throws(() => db.getDraft(''), { name: 'TypeError', message: /draft id/ });
    assert.throws(() => db.getDraft(42), { name: 'TypeError' });
  });

  it('updateDraft changes only the given keys, clears with null and bumps updatedAt', () => {
    const created = db.createDraft({ tweets: sampleTweets }, T0);
    const scheduled = db.updateDraft(created.id, { status: 'scheduled', scheduledAt: T0 + HOUR, mode: 'manual' }, T0 + MINUTE);
    assert.equal(scheduled.status, 'scheduled');
    assert.equal(scheduled.scheduledAt, T0 + HOUR);
    assert.equal(scheduled.mode, 'manual');
    assert.deepEqual(scheduled.tweets, sampleTweets, 'untouched keys keep their value');
    assert.equal(scheduled.createdAt, T0);
    assert.equal(scheduled.updatedAt, T0 + MINUTE);

    const result = { tweetIds: ['1', '2'], url: 'https://x.com/i/status/1', error: null, failedIndex: null, attempts: 1 };
    const posted = db.updateDraft(created.id, { status: 'posted', postedAt: T0 + 2 * HOUR, result }, T0 + 2 * HOUR);
    assert.deepEqual(posted.result, result);
    assert.equal(posted.postedAt, T0 + 2 * HOUR);

    const cleared = db.updateDraft(created.id, { scheduledAt: null, postedAt: null, remindedAt: null, result: null }, T0 + 3 * HOUR);
    assert.equal(cleared.scheduledAt, null);
    assert.equal(cleared.postedAt, null);
    assert.equal(cleared.remindedAt, null);
    assert.equal(cleared.result, null);
    assert.equal(cleared.status, 'posted', 'status untouched by a patch that does not mention it');
    assert.deepEqual(db.getDraft(created.id), cleared);

    const bumped = db.updateDraft(created.id, {}, T0 + 4 * HOUR);
    assert.equal(bumped.updatedAt, T0 + 4 * HOUR, 'an empty patch still bumps updatedAt');
  });

  it('updateDraft replaces tweets wholesale', () => {
    const draft = db.createDraft({ tweets: sampleTweets }, T0);
    const next = [{ text: 'only one', media: [] }];
    assert.deepEqual(db.updateDraft(draft.id, { tweets: next }, T0).tweets, next);
  });

  it('updateDraft throws NotFoundError (status 404) for unknown ids', () => {
    assert.throws(() => db.updateDraft('nope', { status: 'draft' }), (err) => {
      assert.ok(err instanceof NotFoundError);
      assert.ok(err instanceof Error);
      assert.equal(err.name, 'NotFoundError');
      assert.equal(err.status, 404);
      assert.match(err.message, /nope/);
      return true;
    });
  });

  it('updateDraft validates the patch', () => {
    const { id } = db.createDraft({}, T0);
    assert.throws(() => db.updateDraft(id, { status: 'bogus' }), { name: 'RangeError', message: /status must be one of/ });
    assert.throws(() => db.updateDraft(id, { mode: 'bogus' }), { name: 'RangeError', message: /mode must be one of/ });
    assert.throws(() => db.updateDraft(id, { scheduled_at: T0 }), { name: 'TypeError', message: /unknown key\(s\) scheduled_at/ });
    assert.throws(() => db.updateDraft(id, { scheduledAt: 'tomorrow' }), { name: 'TypeError', message: /scheduledAt must be an integer/ });
    assert.throws(() => db.updateDraft(id, { scheduledAt: 1.25 }), { name: 'TypeError' });
    assert.throws(() => db.updateDraft(id, { result: ['not', 'an', 'object'] }), { name: 'TypeError', message: /result must be an object/ });
    assert.throws(() => db.updateDraft(id, { tweets: {} }), { name: 'TypeError', message: /tweets must be an array/ });
    assert.throws(() => db.updateDraft(id, null), { name: 'TypeError', message: /patch must be an object/ });
    assert.throws(() => db.updateDraft(id, {}, NaN), { name: 'TypeError' });
    assert.equal(db.getDraft(id).status, 'draft', 'a rejected patch changes nothing');
  });

  it('deleteDraft reports whether a row was removed', () => {
    const { id } = db.createDraft({}, T0);
    assert.equal(db.deleteDraft(id), true);
    assert.equal(db.getDraft(id), null);
    assert.equal(db.deleteDraft(id), false);
    assert.throws(() => db.deleteDraft(''), { name: 'TypeError' });
  });

  it('countByStatus returns every status, zero when absent', () => {
    assert.deepEqual(db.countByStatus(), { draft: 0, scheduled: 0, publishing: 0, due: 0, posted: 0, failed: 0 });
    seed(db, { status: 'draft' });
    seed(db, { status: 'draft' });
    seed(db, { status: 'scheduled', scheduledAt: T0 });
    seed(db, { status: 'failed' });
    assert.deepEqual(db.countByStatus(), { draft: 2, scheduled: 1, publishing: 0, due: 0, posted: 0, failed: 1 });
  });
});

describe('listDrafts ordering and filtering', () => {
  let db;
  const ids = {};
  before(() => {
    db = openDb(':memory:');
    // Non-queue rows: ordered by updatedAt DESC regardless of creation order.
    ids.draftOld = seed(db, { status: 'draft', at: T0 + 1 * MINUTE }).id;
    ids.postedNew = seed(db, { status: 'posted', at: T0 + 5 * MINUTE }).id;
    ids.failedMid = seed(db, { status: 'failed', at: T0 + 3 * MINUTE }).id;
    // Queue rows: ordered by scheduledAt ASC regardless of updatedAt.
    ids.dueLate = seed(db, { status: 'due', scheduledAt: T0 + 3 * HOUR, at: T0 + 9 * MINUTE }).id;
    ids.scheduledSoon = seed(db, { status: 'scheduled', scheduledAt: T0 + 1 * HOUR, at: T0 + 8 * MINUTE }).id;
    ids.publishingMid = seed(db, { status: 'publishing', scheduledAt: T0 + 2 * HOUR, at: T0 + 7 * MINUTE }).id;
  });
  after(() => db.close());

  const idsOf = (drafts) => drafts.map((d) => d.id);

  it('with no filter: queue rows by time first, then the rest newest-updated first', () => {
    assert.deepEqual(idsOf(db.listDrafts()), [
      ids.scheduledSoon,
      ids.publishingMid,
      ids.dueLate,
      ids.postedNew,
      ids.failedMid,
      ids.draftOld,
    ]);
  });

  it('filters by status and keeps the group ordering', () => {
    assert.deepEqual(idsOf(db.listDrafts({ statuses: ['draft'] })), [ids.draftOld]);
    assert.deepEqual(idsOf(db.listDrafts({ statuses: ['posted', 'failed'] })), [ids.postedNew, ids.failedMid]);
    assert.deepEqual(idsOf(db.listDrafts({ statuses: QUEUE_STATUSES })), [ids.scheduledSoon, ids.publishingMid, ids.dueLate]);
    assert.deepEqual(idsOf(db.listDrafts({ statuses: ['failed', 'due'] })), [ids.dueLate, ids.failedMid]);
  });

  it('an explicit empty status list matches nothing', () => {
    assert.deepEqual(db.listDrafts({ statuses: [] }), []);
  });

  it('rejects unknown statuses and non-array filters', () => {
    assert.throws(() => db.listDrafts({ statuses: ['draft', 'archived'] }), { name: 'RangeError', message: /archived/ });
    assert.throws(() => db.listDrafts({ statuses: 'draft' }), { name: 'TypeError', message: /must be an array/ });
  });

  it('orders queue rows with the same time by insertion, and other ties newest-inserted first', () => {
    const local = openDb(':memory:');
    const a = seed(local, { status: 'scheduled', scheduledAt: T0, at: T0 }).id;
    const b = seed(local, { status: 'scheduled', scheduledAt: T0, at: T0 }).id;
    const c = seed(local, { status: 'draft', at: T0 }).id;
    const d = seed(local, { status: 'draft', at: T0 }).id;
    assert.deepEqual(idsOf(local.listDrafts()), [a, b, d, c]);
    local.updateDraft(a, { remindedAt: null }, T0 + MINUTE);
    assert.deepEqual(idsOf(local.listDrafts()), [a, b, d, c], 'touching a queued row does not reorder same-time rows');
    local.close();
  });
});

describe('queue operations', () => {
  let db;
  beforeEach(() => {
    db?.close();
    db = openDb(':memory:');
  });
  after(() => db.close());

  it('claimDueApi flips due api drafts to publishing exactly once, oldest slot first', () => {
    const later = seed(db, { status: 'scheduled', mode: 'api', scheduledAt: T0 + 30 * MINUTE });
    const earlier = seed(db, { status: 'scheduled', mode: 'api', scheduledAt: T0 - HOUR });
    const future = seed(db, { status: 'scheduled', mode: 'api', scheduledAt: T0 + 31 * MINUTE });
    const manual = seed(db, { status: 'scheduled', mode: 'manual', scheduledAt: T0 - HOUR });
    seed(db, { status: 'draft', mode: 'api' });
    seed(db, { status: 'due', mode: 'api', scheduledAt: T0 - HOUR });

    const now = T0 + 30 * MINUTE;
    const claimed = db.claimDueApi(now);
    assert.deepEqual(claimed.map((d) => d.id), [earlier.id, later.id]);
    for (const draft of claimed) {
      assert.equal(draft.status, 'publishing');
      assert.equal(draft.updatedAt, now);
      assert.deepEqual(db.getDraft(draft.id), draft, 'returned drafts reflect the stored row');
    }
    assert.equal(db.getDraft(earlier.id).scheduledAt, T0 - HOUR, 'scheduledAt is preserved');

    assert.deepEqual(db.claimDueApi(now), [], 'a second call finds nothing to claim');
    assert.deepEqual(db.claimDueApi(now + HOUR).map((d) => d.id), [future.id], 'later items are claimed when their time comes');
    assert.equal(db.getDraft(manual.id).status, 'scheduled', 'manual drafts are never claimed');
    assert.deepEqual(db.countByStatus(), { draft: 1, scheduled: 1, publishing: 3, due: 1, posted: 0, failed: 0 });
  });

  it('claimDueApi validates its clock', () => {
    assert.throws(() => db.claimDueApi('now'), { name: 'TypeError', message: /nowMs/ });
    assert.deepEqual(db.claimDueApi(T0), []);
  });

  it('dueManual lists due manual drafts ascending without changing them', () => {
    const late = seed(db, { status: 'scheduled', mode: 'manual', scheduledAt: T0 });
    const early = seed(db, { status: 'scheduled', mode: 'manual', scheduledAt: T0 - HOUR });
    seed(db, { status: 'scheduled', mode: 'manual', scheduledAt: T0 + 1 });
    seed(db, { status: 'scheduled', mode: 'api', scheduledAt: T0 - HOUR });
    seed(db, { status: 'due', mode: 'manual', scheduledAt: T0 - HOUR });

    assert.deepEqual(db.dueManual(T0).map((d) => d.id), [early.id, late.id]);
    assert.deepEqual(db.dueManual(T0).map((d) => d.id), [early.id, late.id], 'reads do not consume');
    assert.equal(db.getDraft(early.id).status, 'scheduled');
    assert.throws(() => db.dueManual(null), { name: 'TypeError' });
  });

  it('takenTimes returns distinct queued times, honouring range and excludeId', () => {
    const a = seed(db, { status: 'scheduled', scheduledAt: T0 + 2 * HOUR });
    seed(db, { status: 'due', scheduledAt: T0 + 1 * HOUR });
    seed(db, { status: 'publishing', scheduledAt: T0 + 2 * HOUR });
    seed(db, { status: 'scheduled', scheduledAt: T0 + 3 * HOUR });
    seed(db, { status: 'posted', scheduledAt: T0 + 4 * HOUR });
    seed(db, { status: 'failed', scheduledAt: T0 + 5 * HOUR });
    seed(db, { status: 'draft' });

    assert.deepEqual(db.takenTimes(), [T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR]);
    assert.deepEqual(db.takenTimes({ fromMs: T0 + 2 * HOUR }), [T0 + 2 * HOUR, T0 + 3 * HOUR], 'fromMs is inclusive');
    assert.deepEqual(db.takenTimes({ toMs: T0 + 2 * HOUR }), [T0 + HOUR, T0 + 2 * HOUR], 'toMs is inclusive');
    assert.deepEqual(db.takenTimes({ fromMs: T0 + HOUR + 1, toMs: T0 + 3 * HOUR - 1 }), [T0 + 2 * HOUR]);
    assert.deepEqual(
      db.takenTimes({ excludeId: a.id }),
      [T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR],
      'a time shared with another queued draft stays taken',
    );
    const b = seed(db, { status: 'scheduled', scheduledAt: T0 + 6 * HOUR });
    assert.deepEqual(db.takenTimes({ excludeId: b.id }), [T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR]);
    assert.deepEqual(db.takenTimes({ excludeId: 'unknown-id' }), [T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR, T0 + 6 * HOUR]);
    assert.throws(() => db.takenTimes({ fromMs: 'yesterday' }), { name: 'TypeError', message: /fromMs/ });
    assert.throws(() => db.takenTimes({ excludeId: 7 }), { name: 'TypeError', message: /excludeId/ });
  });

  it('recoverStuck returns publishing drafts to the queue keeping their time and result', () => {
    const result = { tweetIds: ['1'], url: null, error: 'boom', failedIndex: 1, attempts: 1 };
    const stuck = seed(db, { status: 'publishing', scheduledAt: T0 - HOUR, result });
    const stuck2 = seed(db, { status: 'publishing', scheduledAt: T0 - 2 * HOUR });
    const fine = seed(db, { status: 'scheduled', scheduledAt: T0 + HOUR });

    assert.equal(db.recoverStuck(T0), 2);
    const recovered = db.getDraft(stuck.id);
    assert.equal(recovered.status, 'scheduled');
    assert.equal(recovered.scheduledAt, T0 - HOUR);
    assert.deepEqual(recovered.result, result);
    assert.equal(recovered.updatedAt, T0);
    assert.equal(db.getDraft(fine.id).updatedAt, T0, 'untouched rows keep their timestamps');
    assert.equal(db.recoverStuck(T0 + 1), 0);
    assert.deepEqual(db.claimDueApi(T0).map((d) => d.id), [stuck2.id, stuck.id], 'recovered rows are claimable again');
  });
});

describe('media', () => {
  let db;
  const png = { id: 'media-1', filename: 'media-1.png', originalName: 'cat.png', mime: 'image/png', size: 1234, width: 10, height: 20 };
  beforeEach(() => {
    db?.close();
    db = openDb(':memory:');
  });
  after(() => db.close());

  it('insertMedia stores and returns the row; getMedia finds it; deleteMedia removes it', () => {
    const inserted = db.insertMedia(png, T0);
    assert.deepEqual(inserted, { ...png, createdAt: T0 });
    assert.deepEqual(db.getMedia(png.id), inserted);
    assert.equal(db.getMedia('nope'), null);
    assert.equal(db.deleteMedia(png.id), true);
    assert.equal(db.getMedia(png.id), null);
    assert.equal(db.deleteMedia(png.id), false);
  });

  it('insertMedia defaults optional fields to null and rejects bad input', () => {
    const minimal = db.insertMedia({ id: 'm', filename: 'm.gif', mime: 'image/gif', size: 0 }, T0);
    assert.deepEqual(minimal, { id: 'm', filename: 'm.gif', originalName: null, mime: 'image/gif', size: 0, width: null, height: null, createdAt: T0 });

    assert.throws(() => db.insertMedia({ ...png, id: '' }), { name: 'TypeError', message: /media id/ });
    assert.throws(() => db.insertMedia({ ...png, id: 'x', filename: 7 }), { name: 'TypeError', message: /filename/ });
    assert.throws(() => db.insertMedia({ ...png, id: 'x', mime: '' }), { name: 'TypeError', message: /mime/ });
    assert.throws(() => db.insertMedia({ ...png, id: 'x', size: -1 }), { name: 'TypeError', message: /size/ });
    assert.throws(() => db.insertMedia({ ...png, id: 'x', size: '12' }), { name: 'TypeError', message: /size/ });
    assert.throws(() => db.insertMedia({ ...png, id: 'x', width: 1.5 }), { name: 'TypeError', message: /width/ });
    assert.throws(() => db.insertMedia({ ...png, id: 'x', originalName: 5 }), { name: 'TypeError', message: /originalName/ });
    assert.throws(() => db.insertMedia({ ...png, id: 'x', extra: true }), { name: 'TypeError', message: /unknown key\(s\) extra/ });
    assert.throws(() => db.insertMedia({ ...png, id: 'x' }, -0.5), { name: 'TypeError', message: /now/ });
    assert.throws(() => db.insertMedia(png, T0) && db.insertMedia(png, T0), /UNIQUE/);
  });

  it('listMedia returns everything oldest first', () => {
    db.insertMedia({ ...png, id: 'b', filename: 'b.png' }, T0 + 2);
    db.insertMedia({ ...png, id: 'a', filename: 'a.png' }, T0 + 1);
    db.insertMedia({ ...png, id: 'c', filename: 'c.png' }, T0 + 3);
    assert.deepEqual(db.listMedia().map((m) => m.id), ['a', 'b', 'c']);
  });

  it('unreferencedMedia returns old rows no draft references', () => {
    const referenced = db.insertMedia({ ...png, id: 'ref', filename: 'ref.png' }, T0 - 2 * HOUR);
    const referencedInSecondPost = db.insertMedia({ ...png, id: 'ref2', filename: 'ref2.png' }, T0 - 2 * HOUR);
    const orphanOld = db.insertMedia({ ...png, id: 'orphan-old', filename: 'o.png' }, T0 - 2 * HOUR);
    const orphanOlder = db.insertMedia({ ...png, id: 'orphan-older', filename: 'o2.png' }, T0 - 3 * HOUR);
    const orphanBoundary = db.insertMedia({ ...png, id: 'orphan-boundary', filename: 'o3.png' }, T0 - HOUR);
    const orphanFresh = db.insertMedia({ ...png, id: 'orphan-fresh', filename: 'o4.png' }, T0);

    const mediaRef = (m) => ({ id: m.id, url: `/media/${m.id}`, name: m.originalName, type: m.mime, size: m.size });
    db.createDraft({ tweets: [{ text: 'a', media: [mediaRef(referenced)] }, { text: 'b', media: [mediaRef(referencedInSecondPost)] }] }, T0);
    const posted = db.createDraft({ tweets: [{ text: 'c', media: [mediaRef(referenced)] }] }, T0);
    db.updateDraft(posted.id, { status: 'posted' }, T0);

    const cutoff = T0 - HOUR;
    assert.deepEqual(
      db.unreferencedMedia(cutoff).map((m) => m.id),
      [orphanOlder.id, orphanOld.id],
      'only rows strictly older than the cutoff, oldest first',
    );
    assert.deepEqual(db.unreferencedMedia(T0 + 1).map((m) => m.id), [orphanOlder.id, orphanOld.id, orphanBoundary.id, orphanFresh.id]);
    assert.deepEqual(db.unreferencedMedia(T0 - 10 * HOUR), []);

    db.deleteDraft(posted.id);
    assert.ok(!db.unreferencedMedia(T0 + 1).some((m) => m.id === referenced.id), 'still referenced by the other draft');
    db.updateDraft(db.listDrafts()[0].id, { tweets: [{ text: 'no media', media: [] }] }, T0);
    assert.deepEqual(
      db.unreferencedMedia(T0 + 1).map((m) => m.id).sort(),
      ['orphan-boundary', 'orphan-fresh', 'orphan-old', 'orphan-older', 'ref', 'ref2'],
      'dropping the last reference makes media collectable',
    );
    assert.throws(() => db.unreferencedMedia(), { name: 'TypeError', message: /olderThanMs/ });
  });

  it('unreferencedMedia tolerates tweets without a media array', () => {
    db.insertMedia({ ...png, id: 'lonely', filename: 'l.png' }, T0 - HOUR);
    db.createDraft({ tweets: [{ text: 'legacy row without media key' }] }, T0);
    assert.deepEqual(db.unreferencedMedia(T0).map((m) => m.id), ['lonely']);
  });
});

describe('damaged rows', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otf-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('one unreadable JSON cell degrades that draft instead of breaking every listing, the claim step and media GC', () => {
    const file = path.join(dir, 'damaged.db');
    const logged = [];
    const db = openDb(file, { logger: { error: (...args) => logged.push(args.join(' ')) } });
    const bad = seed(db, { status: 'scheduled', scheduledAt: T0 - MINUTE, tweets: sampleTweets });
    const odd = seed(db, { status: 'scheduled', scheduledAt: T0 - MINUTE, result: { attempts: 1 } });
    const good = seed(db, { status: 'scheduled', scheduledAt: T0 });
    db.insertMedia({ id: 'm-1', filename: 'a.png', mime: 'image/png', size: 10 }, T0 - 2 * HOUR);
    // Out-of-band damage: a hand edit through the sqlite3 CLI, a bad restore.
    const raw = new DatabaseSync(file);
    raw.prepare('UPDATE drafts SET tweets = ? WHERE id = ?').run('{not json', bad.id);
    raw.prepare('UPDATE drafts SET tweets = ?, result = ? WHERE id = ?').run('"a string"', '[1, 2]', odd.id);
    raw.close();

    const listed = db.listDrafts();
    assert.deepEqual(listed.map((d) => d.id), [bad.id, odd.id, good.id], 'every row is still listed');
    assert.deepEqual(listed[0].tweets, [], 'unparsable tweets read as an empty thread');
    assert.deepEqual([listed[1].tweets, listed[1].result], [[], null], 'wrong-shaped cells fall back too');
    assert.deepEqual(listed[2].tweets, [{ text: 'scheduled', media: [] }], 'the healthy row is untouched');
    assert.deepEqual(db.getDraft(bad.id).tweets, []);
    assert.equal(db.listDrafts({ statuses: ['scheduled'] }).length, 3);
    assert.deepEqual(db.unreferencedMedia(T0).map((m) => m.id), ['m-1'], 'GC still runs; the damaged reference no longer counts');

    const claimed = db.claimDueApi(T0);
    assert.deepEqual(claimed.map((d) => d.id), [bad.id, odd.id, good.id], 'the claim commits instead of rolling back');
    assert.equal(db.getDraft(good.id).status, 'publishing');
    assert.equal(db.deleteDraft(bad.id), true);

    assert.equal(logged.length, 3, 'each damaged cell is reported once, however often it is read');
    assert.match(logged[0], new RegExp(`db: draft ${bad.id} has an unreadable tweets column`));
    assert.match(logged[1], new RegExp(`db: draft ${odd.id} has an unreadable tweets column \\(unexpected shape\\)`));
    assert.match(logged[2], new RegExp(`db: draft ${odd.id} has an unreadable result column`));
    db.close();
  });
});

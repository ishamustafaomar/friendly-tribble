/**
 * SQLite data layer on top of the built-in `node:sqlite`.
 *
 * Every method is synchronous. Rows are mapped to the camelCase draft/media
 * shapes described in the spec, with JSON columns parsed. Methods that stamp
 * timestamps take an optional `now` (epoch ms) so tests can pin time.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const STATUSES = ['draft', 'scheduled', 'publishing', 'due', 'posted', 'failed'];
export const MODES = ['api', 'manual'];
/** Statuses that occupy a slot in the queue. */
export const QUEUE_STATUSES = ['scheduled', 'publishing', 'due'];

const MEMORY_PATH = ':memory:';

/** Draft patch key (camelCase) → column name; also the list of keys updateDraft accepts. */
const DRAFT_COLUMNS = {
  tweets: 'tweets',
  mode: 'mode',
  status: 'status',
  scheduledAt: 'scheduled_at',
  postedAt: 'posted_at',
  remindedAt: 'reminded_at',
  result: 'result',
};
const DRAFT_PATCH_KEYS = Object.keys(DRAFT_COLUMNS);

/**
 * Thrown when a draft or media row does not exist. Carries `status = 404` so
 * the HTTP layer can map it directly.
 */
export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

/**
 * Migrations run in order; the index + 1 is the schema version stored in `meta`.
 * Each entry must be idempotent so a partially applied step can be re-run.
 */
const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    tweets TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    mode TEXT NOT NULL DEFAULT 'api',
    scheduled_at INTEGER,
    posted_at INTEGER,
    reminded_at INTEGER,
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_drafts_status_sched ON drafts(status, scheduled_at);
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    original_name TEXT,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL
  );
  `,
];

const QUEUE_STATUS_LIST = QUEUE_STATUSES.map((status) => `'${status}'`).join(', ');
const IS_QUEUE_ROW = `status IN (${QUEUE_STATUS_LIST})`;

/**
 * One ordering rule for every listing: queue rows first by scheduled time
 * (insertion order on ties), then everything else newest-updated first
 * (newest insert first on ties). The rowid keys make the order stable when
 * timestamps collide; for queue rows rowid is unique so the later keys are moot.
 */
const DRAFT_ORDER_BY = `
  ORDER BY
    CASE WHEN ${IS_QUEUE_ROW} THEN 0 ELSE 1 END,
    CASE WHEN ${IS_QUEUE_ROW} THEN scheduled_at END ASC,
    CASE WHEN ${IS_QUEUE_ROW} THEN rowid END ASC,
    updated_at DESC,
    rowid DESC
`;

/**
 * @typedef {object} MediaRow
 * @property {string} id
 * @property {string} filename basename inside `uploads/`
 * @property {string | null} originalName
 * @property {string} mime
 * @property {number} size
 * @property {number | null} width
 * @property {number | null} height
 * @property {number} createdAt
 */

/**
 * @typedef {object} Draft
 * @property {string} id
 * @property {Array<{ text: string, media: object[] }>} tweets
 * @property {string} status
 * @property {string} mode
 * @property {number | null} scheduledAt
 * @property {number | null} postedAt
 * @property {number | null} remindedAt
 * @property {object | null} result
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * Open (or create) the database at `filePath`, apply pragmas and migrations.
 *
 * @param {string} filePath a file path (parent directories are created) or ':memory:'
 * @param {{ logger?: { error: Function } }} [options] where a damaged row is reported
 * @returns {Db}
 */
export function openDb(filePath, { logger = console } = {}) {
  if (typeof filePath !== 'string' || filePath === '') {
    throw new TypeError(`openDb expects a file path or ':memory:' (got ${describeValue(filePath)})`);
  }
  const inMemory = filePath === MEMORY_PATH;
  if (!inMemory) fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const db = new DatabaseSync(filePath);
  // WAL is pointless for a memory database and SQLite silently reports 'memory'.
  if (!inMemory) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return createDb(db, logger);
}

/**
 * Apply any migrations newer than the stored `schema_version`.
 * @param {DatabaseSync} db
 */
function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const current = row ? Number(row.value) : 0;
  const setVersion = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)");
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[version]);
      setVersion.run(String(version + 1));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * Build the Db facade around an open connection.
 * @param {DatabaseSync} db
 * @param {{ error: Function }} logger
 * @returns {Db}
 */
function createDb(db, logger) {
  const statements = new Map();
  /** `id:column` of every damaged JSON cell already reported, so the log says it once. */
  const reported = new Set();

  /** Prepared statements are cached by SQL text; dynamic SQL is cached too since its shapes are few. */
  function stmt(sql) {
    let prepared = statements.get(sql);
    if (!prepared) {
      prepared = db.prepare(sql);
      statements.set(sql, prepared);
    }
    return prepared;
  }

  /** Run `fn` inside a transaction unless one is already open (single connection, so nesting just joins). */
  function transaction(fn) {
    if (db.isTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function selectDraft(id) {
    const row = stmt('SELECT * FROM drafts WHERE id = ?').get(id);
    return row ? rowToDraft(row) : null;
  }

  function selectMedia(id) {
    const row = stmt('SELECT * FROM media WHERE id = ?').get(id);
    return row ? rowToMedia(row) : null;
  }

  /**
   * A JSON column of a draft row, or `fallback` when the cell does not hold
   * what the app writes (a hand edit, a bad restore). Every method that maps
   * rows goes through here, so one damaged row can never take down a listing,
   * the claim step or media GC; it is reported once per cell.
   *
   * @param {{ id: string }} row
   * @param {'tweets' | 'result'} column
   * @param {(value: unknown) => boolean} accept shape the column must have
   * @param {unknown} fallback
   */
  function parseColumn(row, column, accept, fallback) {
    let value;
    let problem = null;
    try {
      value = JSON.parse(row[column]);
    } catch (err) {
      problem = err.message;
    }
    if (problem === null && !accept(value)) problem = 'unexpected shape';
    if (problem === null) return value;
    const key = `${row.id}:${column}`;
    if (!reported.has(key)) {
      reported.add(key);
      logger.error(`db: draft ${row.id} has an unreadable ${column} column (${problem}); treating it as ${JSON.stringify(fallback)}`);
    }
    return fallback;
  }

  function parseTweets(row) {
    return parseColumn(row, 'tweets', Array.isArray, []);
  }

  function parseResult(row) {
    return row.result === null ? null : parseColumn(row, 'result', isPlainObject, null);
  }

  /** @returns {Draft} */
  function rowToDraft(row) {
    return {
      id: row.id,
      tweets: parseTweets(row),
      status: row.status,
      mode: row.mode,
      scheduledAt: row.scheduled_at,
      postedAt: row.posted_at,
      remindedAt: row.reminded_at,
      result: parseResult(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Ids of every media entry referenced by any draft. The table is small, and
   * scanning parsed JSON in JS avoids LIKE-pattern escaping; the optional
   * chaining tolerates a draft whose tweets were stored in a foreign shape.
   */
  function referencedMediaIds() {
    const ids = new Set();
    for (const row of stmt('SELECT id, tweets FROM drafts').all()) {
      for (const tweet of parseTweets(row)) {
        for (const media of tweet?.media ?? []) {
          if (typeof media?.id === 'string') ids.add(media.id);
        }
      }
    }
    return ids;
  }

  const api = {
    /**
     * Insert a new draft with status 'draft'.
     * @param {{ tweets?: object[], mode?: string }} [input]
     * @param {number} [now] epoch ms
     * @returns {Draft}
     */
    createDraft(input = {}, now = Date.now()) {
      assertPlainObject(input, 'createDraft input');
      assertOnlyKeys(input, ['tweets', 'mode'], 'createDraft input');
      const { tweets = [{ text: '', media: [] }], mode = 'api' } = input;
      assertTweets(tweets);
      assertOneOf(mode, MODES, 'mode');
      assertTimestamp(now, 'now');

      const id = randomUUID();
      stmt(
        `INSERT INTO drafts (id, tweets, status, mode, created_at, updated_at)
         VALUES (?, ?, 'draft', ?, ?, ?)`,
      ).run(id, JSON.stringify(tweets), mode, now, now);
      return selectDraft(id);
    },

    /**
     * @param {string} id
     * @returns {Draft | null}
     */
    getDraft(id) {
      assertNonEmptyString(id, 'draft id');
      return selectDraft(id);
    },

    /**
     * List drafts, optionally filtered by status. Queue rows (scheduled,
     * publishing, due) come first ordered by scheduled time; all others follow
     * newest-updated first. An explicit empty `statuses` array matches nothing.
     *
     * @param {{ statuses?: string[] }} [options]
     * @returns {Draft[]}
     */
    listDrafts({ statuses } = {}) {
      if (statuses === undefined) {
        return stmt(`SELECT * FROM drafts ${DRAFT_ORDER_BY}`).all().map(rowToDraft);
      }
      if (!Array.isArray(statuses)) {
        throw new TypeError(`listDrafts statuses must be an array (got ${describeValue(statuses)})`);
      }
      if (statuses.length === 0) return [];
      for (const status of statuses) assertOneOf(status, STATUSES, 'status');
      const placeholders = statuses.map(() => '?').join(', ');
      return stmt(`SELECT * FROM drafts WHERE status IN (${placeholders}) ${DRAFT_ORDER_BY}`)
        .all(...statuses)
        .map(rowToDraft);
    },

    /**
     * Change only the provided fields (null clears nullable ones) and bump
     * `updatedAt`. Throws NotFoundError when the id is unknown.
     *
     * @param {string} id
     * @param {{ tweets?: object[], mode?: string, status?: string, scheduledAt?: number|null,
     *           postedAt?: number|null, remindedAt?: number|null, result?: object|null }} patch
     * @param {number} [now] epoch ms
     * @returns {Draft}
     */
    updateDraft(id, patch, now = Date.now()) {
      assertNonEmptyString(id, 'draft id');
      assertPlainObject(patch, 'updateDraft patch');
      assertOnlyKeys(patch, DRAFT_PATCH_KEYS, 'updateDraft patch');
      assertTimestamp(now, 'now');

      const assignments = ['updated_at = ?'];
      const values = [now];
      for (const key of DRAFT_PATCH_KEYS) {
        if (!(key in patch)) continue;
        assignments.push(`${DRAFT_COLUMNS[key]} = ?`);
        values.push(toDraftColumnValue(key, patch[key]));
      }

      return transaction(() => {
        const { changes } = stmt(`UPDATE drafts SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id);
        if (changes === 0) throw new NotFoundError(`Draft not found: ${id}`);
        return selectDraft(id);
      });
    },

    /**
     * @param {string} id
     * @returns {boolean} true when a row was removed
     */
    deleteDraft(id) {
      assertNonEmptyString(id, 'draft id');
      return stmt('DELETE FROM drafts WHERE id = ?').run(id).changes > 0;
    },

    /** @returns {Record<string, number>} a count for every status, zero when absent */
    countByStatus() {
      const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
      for (const row of stmt('SELECT status, COUNT(*) AS n FROM drafts GROUP BY status').all()) {
        counts[row.status] = row.n;
      }
      return counts;
    },

    /**
     * Atomically move every due API-mode draft from 'scheduled' to 'publishing'
     * and return them (already in the new state). A second call for the same
     * instant returns nothing because the rows are no longer 'scheduled'.
     *
     * @param {number} [nowMs]
     * @returns {Draft[]}
     */
    claimDueApi(nowMs = Date.now()) {
      assertTimestamp(nowMs, 'nowMs');
      return transaction(() => {
        const ids = stmt(
          `SELECT id FROM drafts
           WHERE status = 'scheduled' AND mode = 'api' AND scheduled_at <= ?
           ORDER BY scheduled_at ASC, rowid ASC`,
        ).all(nowMs).map((row) => row.id);
        const claim = stmt("UPDATE drafts SET status = 'publishing', updated_at = ? WHERE id = ?");
        for (const id of ids) claim.run(nowMs, id);
        return ids.map(selectDraft);
      });
    },

    /**
     * Manual-mode drafts whose slot has arrived and that have not been reminded yet.
     * @param {number} [nowMs]
     * @returns {Draft[]}
     */
    dueManual(nowMs = Date.now()) {
      assertTimestamp(nowMs, 'nowMs');
      return stmt(
        `SELECT * FROM drafts
         WHERE status = 'scheduled' AND mode = 'manual' AND scheduled_at <= ?
         ORDER BY scheduled_at ASC, rowid ASC`,
      ).all(nowMs).map(rowToDraft);
    },

    /**
     * Distinct scheduled times of queued drafts, ascending. Bounds are inclusive.
     * @param {{ fromMs?: number, toMs?: number, excludeId?: string }} [options]
     * @returns {number[]}
     */
    takenTimes({ fromMs, toMs, excludeId } = {}) {
      const conditions = [IS_QUEUE_ROW, 'scheduled_at IS NOT NULL'];
      const values = [];
      if (fromMs !== undefined) {
        assertTimestamp(fromMs, 'fromMs');
        conditions.push('scheduled_at >= ?');
        values.push(fromMs);
      }
      if (toMs !== undefined) {
        assertTimestamp(toMs, 'toMs');
        conditions.push('scheduled_at <= ?');
        values.push(toMs);
      }
      if (excludeId !== undefined) {
        assertNonEmptyString(excludeId, 'excludeId');
        conditions.push('id != ?');
        values.push(excludeId);
      }
      return stmt(
        `SELECT DISTINCT scheduled_at FROM drafts WHERE ${conditions.join(' AND ')} ORDER BY scheduled_at ASC`,
      ).all(...values).map((row) => row.scheduled_at);
    },

    /**
     * Put drafts left in 'publishing' by a crashed process back into the queue.
     * Their scheduled time and partial result are kept so the next tick resumes them.
     *
     * @param {number} [nowMs]
     * @returns {number} rows recovered
     */
    recoverStuck(nowMs = Date.now()) {
      assertTimestamp(nowMs, 'nowMs');
      return stmt("UPDATE drafts SET status = 'scheduled', updated_at = ? WHERE status = 'publishing'").run(nowMs)
        .changes;
    },

    /**
     * @param {{ id: string, filename: string, originalName?: string|null, mime: string, size: number,
     *           width?: number|null, height?: number|null }} input
     * @param {number} [now] epoch ms
     * @returns {MediaRow}
     */
    insertMedia(input, now = Date.now()) {
      assertPlainObject(input, 'insertMedia input');
      assertOnlyKeys(input, ['id', 'filename', 'originalName', 'mime', 'size', 'width', 'height'], 'insertMedia input');
      const { id, filename, originalName = null, mime, size, width = null, height = null } = input;
      assertNonEmptyString(id, 'media id');
      assertNonEmptyString(filename, 'filename');
      if (originalName !== null && typeof originalName !== 'string') {
        throw new TypeError(`originalName must be a string or null (got ${describeValue(originalName)})`);
      }
      assertNonEmptyString(mime, 'mime');
      assertNonNegativeInteger(size, 'size');
      assertNullableNonNegativeInteger(width, 'width');
      assertNullableNonNegativeInteger(height, 'height');
      assertTimestamp(now, 'now');

      stmt(
        `INSERT INTO media (id, filename, original_name, mime, size, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, filename, originalName, mime, size, width, height, now);
      return selectMedia(id);
    },

    /**
     * @param {string} id
     * @returns {MediaRow | null}
     */
    getMedia(id) {
      assertNonEmptyString(id, 'media id');
      return selectMedia(id);
    },

    /**
     * @param {string} id
     * @returns {boolean} true when a row was removed
     */
    deleteMedia(id) {
      assertNonEmptyString(id, 'media id');
      return stmt('DELETE FROM media WHERE id = ?').run(id).changes > 0;
    },

    /** @returns {MediaRow[]} oldest first */
    listMedia() {
      return stmt('SELECT * FROM media ORDER BY created_at ASC, rowid ASC').all().map(rowToMedia);
    },

    /**
     * Media created before `olderThanMs` that no draft references, oldest first.
     * @param {number} olderThanMs epoch ms (exclusive)
     * @returns {MediaRow[]}
     */
    unreferencedMedia(olderThanMs) {
      assertTimestamp(olderThanMs, 'olderThanMs');
      const referenced = referencedMediaIds();
      return stmt('SELECT * FROM media WHERE created_at < ? ORDER BY created_at ASC, rowid ASC')
        .all(olderThanMs)
        .filter((row) => !referenced.has(row.id))
        .map(rowToMedia);
    },

    /** Close the connection. Safe to call more than once. */
    close() {
      if (!db.isOpen) return;
      statements.clear();
      db.close();
    },
  };
  return api;
}

/**
 * Validate one patch value and convert it to its column representation.
 * @param {string} key camelCase patch key
 * @param {unknown} value
 */
function toDraftColumnValue(key, value) {
  switch (key) {
    case 'tweets':
      assertTweets(value);
      return JSON.stringify(value);
    case 'mode':
      assertOneOf(value, MODES, 'mode');
      return value;
    case 'status':
      assertOneOf(value, STATUSES, 'status');
      return value;
    case 'result':
      if (value === null) return null;
      assertPlainObject(value, 'result');
      return JSON.stringify(value);
    default:
      if (value === null) return null;
      assertTimestamp(value, key);
      return value;
  }
}

/** @returns {MediaRow} */
function rowToMedia(row) {
  return {
    id: row.id,
    filename: row.filename,
    originalName: row.original_name,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}

/** Render a value for an error message without dumping large objects. */
function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    default:
      return typeof value;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPlainObject(value, name) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be an object (got ${describeValue(value)})`);
}

function assertOnlyKeys(object, allowed, name) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new TypeError(`${name} has unknown key(s) ${unknown.join(', ')}; allowed: ${allowed.join(', ')}`);
  }
}

function assertOneOf(value, allowed, name) {
  if (!allowed.includes(value)) {
    throw new RangeError(`${name} must be one of ${allowed.join(', ')} (got ${describeValue(value)})`);
  }
}

function assertTweets(value) {
  if (!Array.isArray(value)) throw new TypeError(`tweets must be an array (got ${describeValue(value)})`);
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${name} must be a non-empty string (got ${describeValue(value)})`);
  }
}

function assertTimestamp(value, name) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${name} must be an integer of epoch milliseconds (got ${describeValue(value)})`);
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer (got ${describeValue(value)})`);
  }
}

function assertNullableNonNegativeInteger(value, name) {
  if (value !== null) assertNonNegativeInteger(value, name);
}

/**
 * @typedef {ReturnType<typeof createDb>} Db
 */

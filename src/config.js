/**
 * `config.json` loading and validation.
 *
 * Everything here is synchronous and side-effect free apart from the single
 * file read in {@link loadConfig}. The server logs a notice when the file is
 * missing; this module stays quiet so it can be used from tests and tools.
 */
import fs from 'node:fs';

/** Thrown for any unusable configuration (bad JSON, bad values). */
export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Raw (un-normalized) defaults. Pass through {@link normalizeConfig} to get the
 * canonical shape — `loadConfig` does that for you.
 */
export const DEFAULT_CONFIG = Object.freeze({
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  slots: Object.freeze([
    Object.freeze({ days: Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri']), time: '09:00' }),
    Object.freeze({ days: Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri']), time: '16:00' }),
  ]),
  schedulerIntervalSeconds: 30,
  missedGraceMinutes: 180, // 0 (or null in the file) = never treat a late item as missed
  queueDaysAhead: 14,
});

/** Longest calendar range the queue endpoint serves, and therefore the ceiling for `queueDaysAhead`. */
export const MAX_QUEUE_DAYS = 400;
/** Longest scheduler interval: Node timers clamp delays above 2^31 - 1 ms to 1 ms, which would spin the loop. */
export const MAX_SCHEDULER_INTERVAL_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKENDS = [0, 6];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** Lower-cased day tokens → weekday numbers (0 = Sunday, JS convention). */
const DAY_TOKENS = new Map([
  ['sun', [0]], ['sunday', [0]],
  ['mon', [1]], ['monday', [1]],
  ['tue', [2]], ['tuesday', [2]],
  ['wed', [3]], ['wednesday', [3]],
  ['thu', [4]], ['thursday', [4]],
  ['fri', [5]], ['friday', [5]],
  ['sat', [6]], ['saturday', [6]],
  ['weekdays', WEEKDAYS],
  ['weekends', WEEKENDS],
  ['daily', EVERY_DAY],
  ['everyday', EVERY_DAY],
]);

/**
 * Read and normalize the slots config file.
 *
 * A missing file yields the normalized defaults (callers may log that). Invalid
 * JSON, unreadable files and invalid values throw {@link ConfigError}.
 *
 * @param {string} [filePath] defaults to `$CONFIG_PATH` or `./config.json`
 * @returns {NormalizedConfig}
 */
export function loadConfig(filePath = process.env.CONFIG_PATH || './config.json') {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return normalizeConfig(DEFAULT_CONFIG);
    throw new ConfigError(`Cannot read config file ${filePath}: ${err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Config file ${filePath} is not valid JSON: ${err.message}`);
  }
  try {
    return normalizeConfig(raw);
  } catch (err) {
    if (err instanceof ConfigError) throw new ConfigError(`Config file ${filePath}: ${err.message}`);
    throw err;
  }
}

/**
 * @typedef {object} NormalizedSlot
 * @property {number[]} days weekday numbers 0..6 (0 = Sunday), sorted, unique
 * @property {number} hour 0..23
 * @property {number} minute 0..59
 * @property {string} time 'HH:MM'
 */

/**
 * @typedef {object} NormalizedConfig
 * @property {string} timezone IANA zone accepted by Intl
 * @property {NormalizedSlot[]} slots
 * @property {number} schedulerIntervalSeconds
 * @property {number} missedGraceMinutes 0 = never treat a late item as missed
 * @property {number} queueDaysAhead
 */

/**
 * Validate a raw config object and fill in defaults. Pure: the input is never
 * mutated and the result is a fresh object with only the known keys.
 *
 * Accepts already-normalized input too (numeric days), so applying it twice is
 * a no-op.
 *
 * @param {unknown} raw parsed JSON (or the DEFAULT_CONFIG shape)
 * @returns {NormalizedConfig}
 * @throws {ConfigError} with a message naming the offending field
 */
export function normalizeConfig(raw) {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`config must be a JSON object (got ${describe(raw)})`);
  }
  return {
    timezone: normalizeTimezone(fieldOrDefault(raw, 'timezone')),
    slots: normalizeSlots(fieldOrDefault(raw, 'slots')),
    schedulerIntervalSeconds: normalizeInterval(fieldOrDefault(raw, 'schedulerIntervalSeconds')),
    // null is documented shorthand for "never" — same meaning as 0.
    missedGraceMinutes: normalizeNumber('missedGraceMinutes', fieldOrDefault(raw, 'missedGraceMinutes'), { nullAs: 0 }),
    queueDaysAhead: normalizeQueueDays(fieldOrDefault(raw, 'queueDaysAhead')),
  };
}

/**
 * The loop runs on a timer, so the interval has to be a delay the timer can
 * honour: 0 is not an interval, sub-second values hammer the database, and
 * anything over MAX_SCHEDULER_INTERVAL_SECONDS is clamped to 1 ms by Node.
 *
 * @param {unknown} value
 * @returns {number} seconds, fractions allowed
 */
function normalizeInterval(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > MAX_SCHEDULER_INTERVAL_SECONDS) {
    throw new ConfigError(`schedulerIntervalSeconds must be a number of seconds between 1 and ${MAX_SCHEDULER_INTERVAL_SECONDS} (got ${describe(value)})`);
  }
  return value;
}

/**
 * The calendar adds whole days to "today", so only an integer works, and the
 * queue endpoint refuses ranges longer than MAX_QUEUE_DAYS.
 *
 * @param {unknown} value
 * @returns {number}
 */
function normalizeQueueDays(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_QUEUE_DAYS) {
    throw new ConfigError(`queueDaysAhead must be a whole number of days between 1 and ${MAX_QUEUE_DAYS} (got ${describe(value)})`);
  }
  return value;
}

/**
 * Only an absent key falls back to the default; an explicit null is a value
 * and gets validated like any other.
 *
 * @param {object} raw
 * @param {keyof typeof DEFAULT_CONFIG} name
 * @returns {unknown}
 */
function fieldOrDefault(raw, name) {
  return raw[name] === undefined ? DEFAULT_CONFIG[name] : raw[name];
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeTimezone(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`timezone must be an IANA name such as "Europe/Paris" (got ${describe(value)})`);
  }
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value });
  } catch {
    throw new ConfigError(`timezone "${value}" is not a known IANA time zone (try e.g. "America/New_York" or "UTC")`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {NormalizedSlot[]}
 */
function normalizeSlots(value) {
  if (!Array.isArray(value)) {
    throw new ConfigError(`slots must be an array of { days, time } objects (got ${describe(value)})`);
  }
  return value.map((slot, index) => normalizeSlot(slot, `slots[${index}]`));
}

/**
 * @param {unknown} slot
 * @param {string} label used in error messages
 * @returns {NormalizedSlot}
 */
function normalizeSlot(slot, label) {
  if (!isPlainObject(slot)) {
    throw new ConfigError(`${label} must be an object like { "days": ["mon"], "time": "09:00" } (got ${describe(slot)})`);
  }
  if (typeof slot.time !== 'string' || !TIME_PATTERN.test(slot.time)) {
    throw new ConfigError(`${label}.time must be a 24-hour "HH:MM" string such as "09:00" or "16:30" (got ${describe(slot.time)})`);
  }
  const [hour, minute] = slot.time.split(':').map(Number);
  return { days: normalizeDays(slot.days, `${label}.days`), hour, minute, time: slot.time };
}

/**
 * @param {unknown} value a day token, a weekday number, or an array of those
 * @param {string} label used in error messages
 * @returns {number[]} sorted unique weekday numbers
 */
function normalizeDays(value, label) {
  const tokens = Array.isArray(value) ? value : [value];
  const days = new Set();
  for (const token of tokens) {
    for (const day of parseDayToken(token, label)) days.add(day);
  }
  if (days.size === 0) {
    throw new ConfigError(`${label} must list at least one day (e.g. ["mon", "wed"] or "weekdays")`);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * @param {unknown} token
 * @param {string} label used in error messages
 * @returns {number[]}
 */
function parseDayToken(token, label) {
  if (Number.isInteger(token) && token >= 0 && token <= 6) return [token];
  if (typeof token === 'string') {
    const days = DAY_TOKENS.get(token.trim().toLowerCase());
    if (days) return days;
  }
  throw new ConfigError(
    `${label} contains ${describe(token)}; use day names ("mon".."sun", "monday".."sunday"), ` +
    'or "weekdays", "weekends", "daily"',
  );
}

/**
 * @param {string} name field name for error messages
 * @param {unknown} value
 * @param {{ nullAs?: number }} [options] value to substitute for null
 * @returns {number}
 */
function normalizeNumber(name, value, { nullAs } = {}) {
  if (value === null && nullAs !== undefined) return nullAs;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${name} must be a finite number >= 0 (got ${describe(value)})`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Short, safe rendering of a bad value for error messages.
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value === undefined) return 'nothing';
  let text;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

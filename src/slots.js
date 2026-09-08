/**
 * Timezone and slot math. Pure functions, no I/O, no libraries: all zone
 * knowledge comes from `Intl.DateTimeFormat`.
 *
 * Every instant is epoch milliseconds (UTC). A "zoned" value is a wall-clock
 * reading in a given IANA time zone.
 */

const DAY_MS = 86_400_000;

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatterCache = new Map();

/**
 * @typedef {object} ZonedTime
 * @property {number} year
 * @property {number} month 1..12
 * @property {number} day 1..31
 * @property {number} hour 0..23
 * @property {number} minute 0..59
 * @property {number} second 0..59
 * @property {number} weekday 0..6, 0 = Sunday
 */

/**
 * @typedef {object} Slot
 * @property {number[]} days weekday numbers 0..6 (0 = Sunday)
 * @property {number} hour
 * @property {number} minute
 */

/**
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    // 'h23' (not hour12:false) so midnight reads "00", never "24".
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function assertFiniteMs(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number of epoch milliseconds (got ${String(value)})`);
  }
  return value;
}

/**
 * Wall-clock reading of an instant in a time zone.
 *
 * @param {number} ms epoch milliseconds
 * @param {string} timeZone IANA zone
 * @returns {ZonedTime}
 */
export function utcToZoned(ms, timeZone) {
  assertFiniteMs(ms, 'ms');
  const fields = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (type !== 'literal') fields[type] = Number(value);
  }
  const { year, month, day, hour, minute, second } = fields;
  // Weekday from the civil date itself, so it never depends on locale strings.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, second, weekday };
}

/**
 * Offset (ms to add to UTC to get local wall-clock time) in force at `ms`.
 * Sub-second parts are ignored because Intl only reports whole seconds.
 *
 * @param {number} ms
 * @param {string} timeZone
 * @returns {number}
 */
function offsetAt(ms, timeZone) {
  const z = utcToZoned(ms, timeZone);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Instant for a wall-clock time in a time zone.
 *
 * The naive guess `Date.UTC(fields)` is within ±14 h of the answer, so the
 * offsets in force one day either side of it cover every transition that could
 * affect the result. Each offset yields a candidate instant; the candidates
 * that really read back as the requested wall-clock time are the valid ones.
 *
 * - Ambiguous time (fall-back overlap, two valid candidates): the earlier one,
 *   i.e. the DST instant.
 * - Non-existent time (spring-forward gap, no valid candidate): the later
 *   candidate, i.e. the wall-clock time shifted forward past the gap.
 *
 * Out-of-range fields overflow the way `Date.UTC` does (day 32 → next month),
 * which `addDays` relies on.
 *
 * @param {{ year: number, month: number, day: number, hour?: number, minute?: number, second?: number }} fields
 *   month is 1..12
 * @param {string} timeZone IANA zone
 * @returns {number} epoch milliseconds
 */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  assertFiniteMs(wall, 'wall-clock fields');
  const offsets = new Set([
    offsetAt(wall - DAY_MS, timeZone),
    offsetAt(wall, timeZone),
    offsetAt(wall + DAY_MS, timeZone),
  ]);
  const candidates = [...offsets].map((offset) => wall - offset);
  const valid = candidates.filter((candidate) => offsetAt(candidate, timeZone) === wall - candidate);
  return valid.length > 0 ? Math.min(...valid) : Math.max(...candidates);
}

/**
 * First instant of the local calendar day containing `ms`.
 * (Where midnight does not exist because of a DST gap, this is the first
 * instant after the gap.)
 *
 * @param {number} ms
 * @param {string} timeZone
 * @returns {number}
 */
export function startOfDay(ms, timeZone) {
  const { year, month, day } = utcToZoned(ms, timeZone);
  return zonedTimeToUtc({ year, month, day }, timeZone);
}

/**
 * Same wall-clock time `n` calendar days later (earlier for negative `n`),
 * so crossing a DST change keeps the local time rather than the elapsed hours.
 *
 * @param {number} ms
 * @param {number} n whole days
 * @param {string} timeZone
 * @returns {number}
 */
export function addDays(ms, n, timeZone) {
  if (!Number.isInteger(n)) throw new TypeError(`n must be an integer number of days (got ${String(n)})`);
  const z = utcToZoned(ms, timeZone);
  return zonedTimeToUtc({ ...z, day: z.day + n }, timeZone);
}

/**
 * Local calendar date of an instant as 'YYYY-MM-DD'.
 *
 * @param {number} ms
 * @param {string} timeZone
 * @returns {string}
 */
export function formatDateKey(ms, timeZone) {
  const { year, month, day } = utcToZoned(ms, timeZone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Every slot occurrence with `fromMs <= t <= toMs`, ascending and deduplicated
 * (two slots at the same time on the same day yield one instant).
 *
 * @param {Slot[]} slots normalized config slots
 * @param {number} fromMs inclusive
 * @param {number} toMs inclusive
 * @param {string} timeZone
 * @returns {number[]}
 */
export function slotTimesBetween(slots, fromMs, toMs, timeZone) {
  if (!Array.isArray(slots)) throw new TypeError('slots must be an array of { days, hour, minute }');
  assertFiniteMs(fromMs, 'fromMs');
  assertFiniteMs(toMs, 'toMs');
  const times = new Set();
  if (slots.length === 0 || fromMs > toMs) return [];

  // Walk civil dates from the day before the range's first local day (a
  // slot late on that day can land inside the range: a DST gap ending at
  // midnight shifts it into the next day) to the last one.
  const first = utcToZoned(fromMs, timeZone);
  const last = utcToZoned(toMs, timeZone);
  const lastDate = Date.UTC(last.year, last.month - 1, last.day);
  for (let offset = -1; ; offset += 1) {
    const date = new Date(Date.UTC(first.year, first.month - 1, first.day + offset));
    if (date.getTime() > lastDate) break;
    for (const t of slotTimesOnDay(slots, date, timeZone)) {
      if (t >= fromMs && t <= toMs) times.add(t);
    }
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * Every slot instant on one civil day, ascending and deduplicated.
 *
 * @param {Slot[]} slots normalized config slots
 * @param {Date} date the civil day as a UTC-midnight Date (its Y/M/D and weekday are read)
 * @param {string} timeZone
 * @returns {number[]}
 */
function slotTimesOnDay(slots, date, timeZone) {
  const fields = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  const weekday = date.getUTCDay();
  const times = new Set();
  for (const slot of slots) {
    if (!slot.days.includes(weekday)) continue;
    times.add(zonedTimeToUtc({ ...fields, hour: slot.hour, minute: slot.minute }, timeZone));
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * Earliest slot occurrence `t` with `t >= now + minLeadMs` that is not taken.
 *
 * @param {object} options
 * @param {Slot[]} options.slots normalized config slots
 * @param {string} options.timeZone
 * @param {number} options.now epoch milliseconds
 * @param {number[] | Set<number>} [options.taken] instants already occupied
 * @param {number} [options.minLeadMs] minimum distance from `now`
 * @param {number} [options.horizonDays] how far ahead to look
 * @returns {number | null} null when there are no slots or none free within the horizon
 */
export function nextFreeSlot({ slots, timeZone, now, taken = [], minLeadMs = 60_000, horizonDays = 365 }) {
  if (!Array.isArray(slots)) throw new TypeError('slots must be an array of { days, hour, minute }');
  assertFiniteMs(now, 'now');
  assertFiniteMs(minLeadMs, 'minLeadMs');
  assertFiniteMs(horizonDays, 'horizonDays');
  if (slots.length === 0) return null;

  const takenSet = taken instanceof Set ? taken : new Set(taken);
  const earliest = now + minLeadMs;
  const horizonEnd = earliest + horizonDays * DAY_MS;

  // Day by day, stopping at the first free instant. Materialising the whole
  // horizon first costs slots × horizonDays zone conversions (tens of
  // thousands with hourly slots) on every call, nearly all of them wasted:
  // the answer is almost always on the first day or two. Days are visited in
  // order, but a day's instants do not always precede the next day's: where
  // a DST gap ends at midnight (America/Nuuk springs forward 23:00 → 00:00)
  // a slot inside the gap is shifted into the next day, past that day's
  // earliest slots. A shift never reaches beyond the next day, so a day's
  // best free instant is the answer once the next day has nothing earlier;
  // and the walk starts a day before `earliest` for an instant shifted into
  // its day. The result matches what the full walk (slotTimesBetween) gives.
  const first = utcToZoned(earliest, timeZone);
  const last = utcToZoned(horizonEnd, timeZone);
  const lastDate = Date.UTC(last.year, last.month - 1, last.day);
  const free = (t) => t >= earliest && t <= horizonEnd && !takenSet.has(t);
  const dayAt = (offset) => new Date(Date.UTC(first.year, first.month - 1, first.day + offset));
  let today = slotTimesOnDay(slots, dayAt(-1), timeZone);
  for (let offset = -1; ; offset += 1) {
    // Every instant of a civil day past the horizon's is past the horizon.
    if (dayAt(offset).getTime() > lastDate) return null;
    const tomorrow = slotTimesOnDay(slots, dayAt(offset + 1), timeZone);
    const best = today.find(free);
    if (best !== undefined) {
      const next = tomorrow.find(free);
      if (next === undefined || best <= next) return best;
    }
    today = tomorrow;
  }
}

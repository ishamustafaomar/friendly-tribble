import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  utcToZoned,
  zonedTimeToUtc,
  startOfDay,
  addDays,
  formatDateKey,
  slotTimesBetween,
  nextFreeSlot,
} from '../src/slots.js';

const NY = 'America/New_York';
const BERLIN = 'Europe/Berlin';
const KOLKATA = 'Asia/Kolkata';
const UTC = 'UTC';

const at = (iso) => Date.parse(iso);
const isoList = (list) => list.map((ms) => new Date(ms).toISOString());

const NINE_AND_FOUR_WEEKDAYS = [
  { days: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
  { days: [1, 2, 3, 4, 5], hour: 16, minute: 0 },
];

describe('utcToZoned', () => {
  test('reads wall-clock fields and weekday in the zone', () => {
    assert.deepEqual(utcToZoned(at('2026-09-07T13:05:09Z'), NY), {
      year: 2026, month: 9, day: 7, hour: 9, minute: 5, second: 9, weekday: 1,
    });
    assert.deepEqual(utcToZoned(at('2026-01-15T03:30:00Z'), KOLKATA), {
      year: 2026, month: 1, day: 15, hour: 9, minute: 0, second: 0, weekday: 4,
    });
  });

  test('midnight is hour 0 and the date rolls over correctly', () => {
    const z = utcToZoned(at('2026-03-08T05:00:00Z'), NY);
    assert.deepEqual([z.year, z.month, z.day, z.hour, z.weekday], [2026, 3, 8, 0, 0]);
    const before = utcToZoned(at('2026-03-08T04:59:59Z'), NY);
    assert.deepEqual([before.day, before.hour, before.minute, before.second, before.weekday], [7, 23, 59, 59, 6]);
  });

  test('UTC is the identity', () => {
    assert.deepEqual(utcToZoned(at('2026-12-31T23:59:59Z'), UTC), {
      year: 2026, month: 12, day: 31, hour: 23, minute: 59, second: 59, weekday: 4,
    });
  });

  test('rejects non-finite input and unknown zones', () => {
    assert.throws(() => utcToZoned(NaN, UTC), TypeError);
    assert.throws(() => utcToZoned('1', UTC), TypeError);
    assert.throws(() => utcToZoned(0, 'Mars/Olympus'), RangeError);
  });
});

describe('zonedTimeToUtc', () => {
  test('America/New_York spring-forward day: 09:00 → 13:00Z (EDT)', () => {
    assert.equal(zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 9 }, NY), at('2026-03-08T13:00:00Z'));
  });

  test('America/New_York fall-back day: 09:00 → 14:00Z (EST)', () => {
    assert.equal(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 9 }, NY), at('2026-11-01T14:00:00Z'));
  });

  test('the days around the transitions keep their offsets', () => {
    assert.equal(zonedTimeToUtc({ year: 2026, month: 3, day: 7, hour: 9 }, NY), at('2026-03-07T14:00:00Z'));
    assert.equal(zonedTimeToUtc({ year: 2026, month: 10, day: 31, hour: 9 }, NY), at('2026-10-31T13:00:00Z'));
  });

  test('non-existent time in the spring gap is shifted forward past the gap', () => {
    // 02:30 does not exist on 2026-03-08 in New York; 03:30 EDT = 07:30Z.
    const ms = zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY);
    assert.equal(ms, at('2026-03-08T07:30:00Z'));
    assert.deepEqual([utcToZoned(ms, NY).hour, utcToZoned(ms, NY).minute], [3, 30]);
    // Same rule in a zone east of UTC: Berlin 02:30 on 2026-03-29 → 03:30 CEST = 01:30Z.
    assert.equal(zonedTimeToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, BERLIN), at('2026-03-29T01:30:00Z'));
  });

  test('ambiguous time in the fall overlap resolves to the earlier (DST) instant', () => {
    // 01:30 happens twice on 2026-11-01 in New York: 05:30Z (EDT) then 06:30Z (EST).
    assert.equal(zonedTimeToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY), at('2026-11-01T05:30:00Z'));
    // Berlin 02:30 on 2026-10-25: 00:30Z (CEST) then 01:30Z (CET).
    assert.equal(zonedTimeToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, BERLIN), at('2026-10-25T00:30:00Z'));
  });

  test('is deterministic', () => {
    const fields = { year: 2026, month: 11, day: 1, hour: 1, minute: 30 };
    const results = new Set(Array.from({ length: 5 }, () => zonedTimeToUtc(fields, NY)));
    assert.equal(results.size, 1);
  });

  test('handles UTC and a non-hour offset (Asia/Kolkata, +05:30)', () => {
    assert.equal(zonedTimeToUtc({ year: 2026, month: 6, day: 1, hour: 12, minute: 34, second: 56 }, UTC), at('2026-06-01T12:34:56Z'));
    assert.equal(zonedTimeToUtc({ year: 2026, month: 1, day: 15, hour: 9 }, KOLKATA), at('2026-01-15T03:30:00Z'));
    assert.equal(zonedTimeToUtc({ year: 2026, month: 1, day: 15, hour: 0, minute: 15 }, KOLKATA), at('2026-01-14T18:45:00Z'));
  });

  test('round-trips through utcToZoned for ordinary instants', () => {
    for (const [iso, tz] of [
      ['2026-07-04T16:00:00Z', NY],
      ['2026-02-01T00:00:00Z', KOLKATA],
      ['2026-12-25T23:00:00Z', BERLIN],
    ]) {
      const ms = at(iso);
      assert.equal(zonedTimeToUtc(utcToZoned(ms, tz), tz), ms);
    }
  });

  test('defaults hour/minute/second to 0 and overflows days like Date.UTC', () => {
    assert.equal(zonedTimeToUtc({ year: 2026, month: 9, day: 7 }, UTC), at('2026-09-07T00:00:00Z'));
    assert.equal(zonedTimeToUtc({ year: 2026, month: 12, day: 32 }, UTC), at('2027-01-01T00:00:00Z'));
  });

  test('rejects unusable fields', () => {
    assert.throws(() => zonedTimeToUtc({ year: NaN, month: 1, day: 1 }, UTC), TypeError);
  });
});

describe('startOfDay', () => {
  test('returns local midnight of the same local day', () => {
    // 03:00Z on Mar 8 is still Mar 7 23:00 in New York.
    assert.equal(startOfDay(at('2026-03-08T03:00:00Z'), NY), at('2026-03-07T05:00:00Z'));
    assert.equal(startOfDay(at('2026-03-08T13:00:00Z'), NY), at('2026-03-08T05:00:00Z'));
    assert.equal(startOfDay(at('2026-01-15T03:30:00Z'), KOLKATA), at('2026-01-14T18:30:00Z'));
    assert.equal(startOfDay(at('2026-01-15T03:30:00Z'), UTC), at('2026-01-15T00:00:00Z'));
  });
});

describe('addDays', () => {
  test('keeps the wall-clock time across DST changes', () => {
    // 09:00 EST on Mar 7 → 09:00 EDT on Mar 8: only 23 elapsed hours.
    const start = at('2026-03-07T14:00:00Z');
    assert.equal(addDays(start, 1, NY), at('2026-03-08T13:00:00Z'));
    assert.equal(addDays(at('2026-10-31T13:00:00Z'), 1, NY), at('2026-11-01T14:00:00Z'));
  });

  test('supports negative and multi-day steps and month boundaries', () => {
    assert.equal(addDays(at('2026-03-08T13:00:00Z'), -1, NY), at('2026-03-07T14:00:00Z'));
    assert.equal(addDays(at('2026-01-30T03:30:00Z'), 3, KOLKATA), at('2026-02-02T03:30:00Z'));
    assert.equal(addDays(at('2026-01-01T00:00:00Z'), 0, UTC), at('2026-01-01T00:00:00Z'));
  });

  test('rejects a non-integer day count', () => {
    assert.throws(() => addDays(0, 1.5, UTC), TypeError);
  });
});

describe('formatDateKey', () => {
  test('formats the local date with zero padding', () => {
    assert.equal(formatDateKey(at('2026-03-08T03:00:00Z'), NY), '2026-03-07');
    assert.equal(formatDateKey(at('2026-03-08T03:00:00Z'), UTC), '2026-03-08');
    assert.equal(formatDateKey(at('2026-12-31T19:00:00Z'), KOLKATA), '2027-01-01');
  });
});

describe('slotTimesBetween', () => {
  test('lists weekday slots ascending and skips the weekend', () => {
    // Fri Sep 4 2026 20:00Z (16:00 EDT) through Tue Sep 8 13:00Z (09:00 EDT).
    const times = slotTimesBetween(NINE_AND_FOUR_WEEKDAYS, at('2026-09-04T20:00:00Z'), at('2026-09-08T13:00:00Z'), NY);
    assert.deepEqual(isoList(times), [
      '2026-09-04T20:00:00.000Z',
      '2026-09-07T13:00:00.000Z',
      '2026-09-07T20:00:00.000Z',
      '2026-09-08T13:00:00.000Z',
    ]);
  });

  test('bounds are inclusive on both ends', () => {
    const slots = [{ days: [0, 1, 2, 3, 4, 5, 6], hour: 12, minute: 0 }];
    const noon = at('2026-09-07T12:00:00Z');
    assert.deepEqual(slotTimesBetween(slots, noon, noon, UTC), [noon]);
    assert.deepEqual(slotTimesBetween(slots, noon + 1, noon + 3_600_000, UTC), []);
    assert.deepEqual(slotTimesBetween(slots, noon - 1, noon, UTC), [noon]);
  });

  test('crosses DST changes with the correct offsets', () => {
    const slots = [{ days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0 }];
    assert.deepEqual(isoList(slotTimesBetween(slots, at('2026-03-07T00:00:00Z'), at('2026-03-09T23:00:00Z'), NY)), [
      '2026-03-07T14:00:00.000Z',
      '2026-03-08T13:00:00.000Z',
      '2026-03-09T13:00:00.000Z',
    ]);
    assert.deepEqual(isoList(slotTimesBetween(slots, at('2026-10-31T00:00:00Z'), at('2026-11-02T23:00:00Z'), NY)), [
      '2026-10-31T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
    ]);
  });

  test('deduplicates slots that coincide', () => {
    const slots = [
      { days: [1], hour: 9, minute: 0 },
      { days: [1, 2], hour: 9, minute: 0 },
    ];
    const times = slotTimesBetween(slots, at('2026-09-07T00:00:00Z'), at('2026-09-08T23:59:59Z'), UTC);
    assert.deepEqual(isoList(times), ['2026-09-07T09:00:00.000Z', '2026-09-08T09:00:00.000Z']);
  });

  test('works in a non-hour-offset zone', () => {
    const slots = [{ days: [4], hour: 9, minute: 15 }];
    const times = slotTimesBetween(slots, at('2026-01-12T00:00:00Z'), at('2026-01-25T00:00:00Z'), KOLKATA);
    assert.deepEqual(isoList(times), ['2026-01-15T03:45:00.000Z', '2026-01-22T03:45:00.000Z']);
  });

  test('returns [] for no slots or an inverted range', () => {
    assert.deepEqual(slotTimesBetween([], 0, 1e12, UTC), []);
    assert.deepEqual(slotTimesBetween(NINE_AND_FOUR_WEEKDAYS, 10, 5, UTC), []);
  });

  test('rejects bad input', () => {
    assert.throws(() => slotTimesBetween(NINE_AND_FOUR_WEEKDAYS, NaN, 1, UTC), TypeError);
    assert.throws(() => slotTimesBetween(null, 0, 1, UTC), TypeError);
  });
});

describe('nextFreeSlot', () => {
  const base = { slots: NINE_AND_FOUR_WEEKDAYS, timeZone: NY };

  test('picks the next slot after now', () => {
    // Saturday Sep 5 2026 → Monday Sep 7 09:00 EDT.
    assert.equal(nextFreeSlot({ ...base, now: at('2026-09-05T00:00:00Z') }), at('2026-09-07T13:00:00Z'));
    // Monday 10:00 EDT → Monday 16:00 EDT.
    assert.equal(nextFreeSlot({ ...base, now: at('2026-09-07T14:00:00Z') }), at('2026-09-07T20:00:00Z'));
  });

  test('skips taken times (array or Set)', () => {
    const now = at('2026-09-05T00:00:00Z');
    const monday9 = at('2026-09-07T13:00:00Z');
    const monday16 = at('2026-09-07T20:00:00Z');
    assert.equal(nextFreeSlot({ ...base, now, taken: [monday9] }), monday16);
    assert.equal(nextFreeSlot({ ...base, now, taken: new Set([monday9, monday16]) }), at('2026-09-08T13:00:00Z'));
  });

  test('minLeadMs pushes now past the current slot', () => {
    const monday9 = at('2026-09-07T13:00:00Z');
    assert.equal(nextFreeSlot({ ...base, now: monday9 - 30_000, minLeadMs: 0 }), monday9);
    assert.equal(nextFreeSlot({ ...base, now: monday9 - 30_000 }), at('2026-09-07T20:00:00Z'));
    assert.equal(nextFreeSlot({ ...base, now: monday9 - 60_000 }), monday9);
  });

  test('returns null for empty slots or nothing within the horizon', () => {
    assert.equal(nextFreeSlot({ slots: [], timeZone: NY, now: 0 }), null);
    assert.equal(nextFreeSlot({ ...base, now: at('2026-09-05T00:00:00Z'), horizonDays: 1 }), null);
    const everyMonday = [{ days: [1], hour: 9, minute: 0 }];
    assert.equal(nextFreeSlot({ slots: everyMonday, timeZone: UTC, now: at('2026-09-05T00:00:00Z'), horizonDays: 3 }), at('2026-09-07T09:00:00Z'));
  });

  test('DST-safe: the first free slot on a transition day carries the new offset', () => {
    const slots = [{ days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0 }];
    assert.equal(nextFreeSlot({ slots, timeZone: NY, now: at('2026-03-08T05:00:00Z') }), at('2026-03-08T13:00:00Z'));
    assert.equal(nextFreeSlot({ slots, timeZone: NY, now: at('2026-11-01T05:00:00Z') }), at('2026-11-01T14:00:00Z'));
  });

  test('a DST gap that ends at midnight (America/Nuuk) neither hides the next day\'s earlier slot nor the slot shifted into it', () => {
    // Nuuk springs forward on 2026-03-29 at 23:00 → 00:00 local (01:00Z), so
    // Saturday's 23:30 slot lands on Sunday at 00:30, after Sunday's own 00:00.
    const NUUK = 'America/Nuuk';
    const daily = [0, 1, 2, 3, 4, 5, 6];
    const slots = [{ days: daily, hour: 23, minute: 30 }, { days: daily, hour: 0, minute: 0 }];
    const now = at('2026-03-29T00:00:00Z'); // Saturday 22:00 local
    const sundayMidnight = at('2026-03-29T01:00:00Z');
    const shiftedSaturday = at('2026-03-29T01:30:00Z');
    assert.deepEqual(
      slotTimesBetween(slots, now + 60_000, now + 60_000 + 2 * 86_400_000, NUUK),
      [sundayMidnight, shiftedSaturday, at('2026-03-30T00:30:00Z'), at('2026-03-30T01:00:00Z')],
      'the full walk lists the shifted Saturday slot after Sunday midnight',
    );
    assert.equal(nextFreeSlot({ slots, timeZone: NUUK, now }), sundayMidnight, 'the earliest instant, not the first day\'s');
    assert.equal(nextFreeSlot({ slots, timeZone: NUUK, now, taken: [sundayMidnight] }), shiftedSaturday);
    // Already past midnight: the slot shifted in from the day before is still an occurrence.
    const afterMidnight = at('2026-03-29T01:10:00Z'); // Sunday 00:10 local
    assert.equal(nextFreeSlot({ slots, timeZone: NUUK, now: afterMidnight }), shiftedSaturday);
    assert.deepEqual(slotTimesBetween(slots, afterMidnight, afterMidnight + 3_600_000, NUUK), [shiftedSaturday]);
    assert.equal(nextFreeSlot({ slots, timeZone: NUUK, now, horizonDays: 1, taken: [sundayMidnight, shiftedSaturday] }), null);
  });

  test('requires a numeric now', () => {
    assert.throws(() => nextFreeSlot({ ...base }), TypeError);
    assert.throws(() => nextFreeSlot({ ...base, now: 'soon' }), TypeError);
  });

  test('stops at the first free instant instead of materialising the whole horizon', () => {
    // 48 half-hour slots every day: the eager walk computed 17,518 instants
    // (~70,000 formatToParts calls, ~0.5 s of blocked event loop) per call.
    const halfHours = [];
    for (let hour = 0; hour < 24; hour += 1) {
      halfHours.push({ days: [0, 1, 2, 3, 4, 5, 6], hour, minute: 0 }, { days: [0, 1, 2, 3, 4, 5, 6], hour, minute: 30 });
    }
    const now = at('2026-09-07T13:12:00Z'); // Monday 09:12 EDT
    const dayStart = at('2026-09-07T04:00:00Z');
    const taken = new Set();
    for (let t = dayStart; t < dayStart + 60 * 3_600_000; t += 1_800_000) taken.add(t); // the next 2.5 days are full

    const original = Intl.DateTimeFormat.prototype.formatToParts;
    let calls = 0;
    Intl.DateTimeFormat.prototype.formatToParts = function counted(...args) {
      calls += 1;
      return original.apply(this, args);
    };
    try {
      const measure = (horizonDays) => {
        calls = 0;
        const result = nextFreeSlot({ slots: halfHours, timeZone: NY, now, taken, horizonDays });
        return { result, calls };
      };
      const week = measure(7);
      const year = measure(365);
      const expected = slotTimesBetween(halfHours, now + 60_000, now + 60_000 + 365 * 86_400_000, NY).find((t) => !taken.has(t));
      assert.equal(week.result, expected);
      assert.equal(year.result, expected);
      assert.equal(year.calls, week.calls, 'the work does not grow with the horizon');
      assert.ok(year.calls < 2_000, `${year.calls} formatToParts calls for a result on day 3`);
    } finally {
      Intl.DateTimeFormat.prototype.formatToParts = original;
    }
  });

  test('agrees with the full slot walk across weekdays, weekends and DST changes', () => {
    const slots = [...NINE_AND_FOUR_WEEKDAYS, { days: [0, 6], hour: 11, minute: 30 }, { days: [1], hour: 9, minute: 0 }];
    for (const now of ['2026-03-07T12:00:00Z', '2026-03-08T13:00:00Z', '2026-10-31T23:59:00Z', '2026-11-01T14:00:00Z', '2026-09-05T15:30:00Z']) {
      const t = at(now);
      const all = slotTimesBetween(slots, t + 60_000, t + 60_000 + 30 * 86_400_000, NY);
      const taken = new Set(all.slice(0, 3));
      assert.equal(nextFreeSlot({ slots, timeZone: NY, now: t, taken, horizonDays: 30 }), all[3], now);
      assert.equal(nextFreeSlot({ slots, timeZone: NY, now: t, taken: new Set(all), horizonDays: 30 }), null, `${now} all taken`);
    }
  });
});

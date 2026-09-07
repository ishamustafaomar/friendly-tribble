import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, ConfigError, MAX_QUEUE_DAYS, MAX_SCHEDULER_INTERVAL_SECONDS, loadConfig, normalizeConfig } from '../src/config.js';

const WEEKDAYS = [1, 2, 3, 4, 5];

/** @param {object} overrides */
const config = (overrides = {}) => ({ timezone: 'UTC', slots: [], ...overrides });

/** @param {object} overrides */
const slot = (overrides = {}) => ({ days: ['mon'], time: '09:00', ...overrides });

describe('DEFAULT_CONFIG', () => {
  test('uses the system timezone and two weekday slots', () => {
    assert.equal(DEFAULT_CONFIG.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.deepEqual(DEFAULT_CONFIG.slots.map((s) => s.time), ['09:00', '16:00']);
    assert.equal(DEFAULT_CONFIG.schedulerIntervalSeconds, 30);
    assert.equal(DEFAULT_CONFIG.missedGraceMinutes, 180);
    assert.equal(DEFAULT_CONFIG.queueDaysAhead, 14);
  });

  test('normalizes cleanly', () => {
    const normalized = normalizeConfig(DEFAULT_CONFIG);
    assert.deepEqual(normalized.slots, [
      { days: WEEKDAYS, hour: 9, minute: 0, time: '09:00' },
      { days: WEEKDAYS, hour: 16, minute: 0, time: '16:00' },
    ]);
  });
});

describe('normalizeConfig', () => {
  test('applies defaults for missing keys and drops unknown ones', () => {
    const normalized = normalizeConfig({ timezone: 'UTC', bogus: 1 });
    assert.deepEqual(Object.keys(normalized).sort(), [
      'missedGraceMinutes', 'queueDaysAhead', 'schedulerIntervalSeconds', 'slots', 'timezone',
    ]);
    assert.equal(normalized.timezone, 'UTC');
    assert.equal(normalized.slots.length, 2);
    assert.equal(normalized.schedulerIntervalSeconds, 30);
  });

  test('returns a fresh object and never mutates the input', () => {
    const raw = config({ slots: [slot({ days: ['Mon', 'sun'] })] });
    const snapshot = structuredClone(raw);
    const normalized = normalizeConfig(raw);
    assert.notEqual(normalized, raw);
    assert.notEqual(normalized.slots, raw.slots);
    assert.notEqual(normalized.slots[0], raw.slots[0]);
    assert.deepEqual(raw, snapshot);
    assert.deepEqual(normalized.slots[0], { days: [0, 1], hour: 9, minute: 0, time: '09:00' });
  });

  test('is idempotent', () => {
    const once = normalizeConfig(config({ slots: [slot({ days: 'weekends', time: '23:59' })] }));
    assert.deepEqual(normalizeConfig(once), once);
  });

  test('rejects non-objects', () => {
    for (const bad of [null, [], 'x', 42, undefined]) {
      assert.throws(() => normalizeConfig(bad), ConfigError);
    }
  });

  describe('timezone', () => {
    test('accepts any zone Intl knows', () => {
      for (const tz of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Europe/Paris']) {
        assert.equal(normalizeConfig(config({ timezone: tz })).timezone, tz);
      }
    });

    test('rejects unknown zones with the name in the message', () => {
      assert.throws(() => normalizeConfig(config({ timezone: 'Mars/Olympus' })), (err) => (
        err instanceof ConfigError && /Mars\/Olympus/.test(err.message)
      ));
    });

    test('rejects non-strings', () => {
      assert.throws(() => normalizeConfig(config({ timezone: 5 })), ConfigError);
      assert.throws(() => normalizeConfig(config({ timezone: '' })), ConfigError);
    });
  });

  describe('slots', () => {
    const days = (value) => normalizeConfig(config({ slots: [slot({ days: value })] })).slots[0].days;

    test('accepts short and full day names case-insensitively', () => {
      assert.deepEqual(days(['mon', 'TUE', 'Wednesday', 'thursday', ' fri ']), [1, 2, 3, 4, 5]);
      assert.deepEqual(days(['Sunday', 'sat']), [0, 6]);
    });

    test('expands the shortcuts', () => {
      assert.deepEqual(days(['weekdays']), WEEKDAYS);
      assert.deepEqual(days(['weekends']), [0, 6]);
      assert.deepEqual(days(['daily']), [0, 1, 2, 3, 4, 5, 6]);
      assert.deepEqual(days(['everyday']), [0, 1, 2, 3, 4, 5, 6]);
    });

    test('accepts a bare string and weekday numbers', () => {
      assert.deepEqual(days('weekends'), [0, 6]);
      assert.deepEqual(days([5, 1]), [1, 5]);
    });

    test('sorts and deduplicates', () => {
      assert.deepEqual(days(['fri', 'mon', 'weekends', 'monday', 0]), [0, 1, 5, 6]);
    });

    test('rejects unknown days, empty days and bad numbers', () => {
      assert.throws(() => days(['funday']), (err) => err instanceof ConfigError && /funday/.test(err.message));
      assert.throws(() => days([]), (err) => err instanceof ConfigError && /at least one day/.test(err.message));
      assert.throws(() => days([7]), ConfigError);
      assert.throws(() => days([1.5]), ConfigError);
      assert.throws(() => days([null]), ConfigError);
    });

    test('parses valid HH:MM times', () => {
      const parsed = normalizeConfig(config({ slots: [slot({ time: '00:00' }), slot({ time: '23:59' })] })).slots;
      assert.deepEqual(parsed.map((s) => [s.hour, s.minute, s.time]), [[0, 0, '00:00'], [23, 59, '23:59']]);
    });

    test('rejects malformed times', () => {
      for (const time of ['9:00', '24:00', '09:60', '0900', '09:00:00', '', 900, null]) {
        assert.throws(() => normalizeConfig(config({ slots: [slot({ time })] })), (err) => (
          err instanceof ConfigError && /slots\[0\]\.time/.test(err.message)
        ), `time ${JSON.stringify(time)} should be rejected`);
      }
    });

    test('allows an empty slots array', () => {
      assert.deepEqual(normalizeConfig(config({ slots: [] })).slots, []);
    });

    test('rejects a non-array or a malformed slot', () => {
      assert.throws(() => normalizeConfig(config({ slots: {} })), ConfigError);
      assert.throws(() => normalizeConfig(config({ slots: 'mon 09:00' })), ConfigError);
      assert.throws(() => normalizeConfig(config({ slots: [null] })), ConfigError);
      assert.throws(() => normalizeConfig(config({ slots: [{ time: '09:00' }] })), (err) => (
        err instanceof ConfigError && /slots\[0\]\.days/.test(err.message)
      ));
    });
  });

  describe('numeric fields', () => {
    test('missedGraceMinutes must be a finite number >= 0', () => {
      assert.equal(normalizeConfig(config({ missedGraceMinutes: 0 })).missedGraceMinutes, 0);
      assert.equal(normalizeConfig(config({ missedGraceMinutes: 7.5 })).missedGraceMinutes, 7.5);
      for (const bad of [-1, NaN, Infinity, '30', true, {}]) {
        assert.throws(() => normalizeConfig(config({ missedGraceMinutes: bad })), (err) => (
          err instanceof ConfigError && err.message.includes('missedGraceMinutes')
        ), `missedGraceMinutes=${String(bad)} should be rejected`);
      }
    });

    test(`schedulerIntervalSeconds must be between 1 and ${MAX_SCHEDULER_INTERVAL_SECONDS} seconds`, () => {
      assert.equal(MAX_SCHEDULER_INTERVAL_SECONDS, 2_147_483, 'the longest delay a Node timer honours, in whole seconds');
      for (const good of [1, 7.5, 30, MAX_SCHEDULER_INTERVAL_SECONDS]) {
        assert.equal(normalizeConfig(config({ schedulerIntervalSeconds: good })).schedulerIntervalSeconds, good);
      }
      // 0 and values past the timer range used to pass here and crash createScheduler with a RangeError;
      // sub-second values passed and spun the loop against SQLite.
      for (const bad of [0, 0.5, 0.0001, MAX_SCHEDULER_INTERVAL_SECONDS + 1, 1e9, -1, NaN, Infinity, '30', true, {}]) {
        assert.throws(() => normalizeConfig(config({ schedulerIntervalSeconds: bad })), (err) => (
          err instanceof ConfigError && /schedulerIntervalSeconds must be a number of seconds between 1 and 2147483/.test(err.message)
        ), `schedulerIntervalSeconds=${String(bad)} should be rejected`);
      }
    });

    test(`queueDaysAhead must be a whole number of days between 1 and ${MAX_QUEUE_DAYS}`, () => {
      assert.equal(MAX_QUEUE_DAYS, 400);
      for (const good of [1, 14, MAX_QUEUE_DAYS]) {
        assert.equal(normalizeConfig(config({ queueDaysAhead: good })).queueDaysAhead, good);
      }
      // 0 and fractions pass a plain ">= 0" check but break the calendar at request time.
      for (const bad of [0, 1.5, MAX_QUEUE_DAYS + 1, -1, NaN, Infinity, '14', true, {}]) {
        assert.throws(() => normalizeConfig(config({ queueDaysAhead: bad })), (err) => (
          err instanceof ConfigError && /queueDaysAhead must be a whole number of days between 1 and 400/.test(err.message)
        ), `queueDaysAhead=${String(bad)} should be rejected`);
      }
    });

    test('missedGraceMinutes: null means never (0)', () => {
      assert.equal(normalizeConfig(config({ missedGraceMinutes: null })).missedGraceMinutes, 0);
    });

    test('null is not accepted for the other numeric fields', () => {
      assert.throws(() => normalizeConfig(config({ schedulerIntervalSeconds: null })), ConfigError);
      assert.throws(() => normalizeConfig(config({ queueDaysAhead: null })), ConfigError);
    });
  });
});

describe('loadConfig', () => {
  let dir;
  let savedConfigPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otf-'));
    savedConfigPath = process.env.CONFIG_PATH;
  });

  afterEach(() => {
    if (savedConfigPath === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = savedConfigPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reads and normalizes an existing file', () => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({
      timezone: 'Asia/Kolkata',
      slots: [{ days: 'daily', time: '07:30' }],
      missedGraceMinutes: null,
    }));
    const loaded = loadConfig(file);
    assert.equal(loaded.timezone, 'Asia/Kolkata');
    assert.deepEqual(loaded.slots, [{ days: [0, 1, 2, 3, 4, 5, 6], hour: 7, minute: 30, time: '07:30' }]);
    assert.equal(loaded.missedGraceMinutes, 0);
    assert.equal(loaded.queueDaysAhead, 14);
  });

  test('returns normalized defaults when the file is missing', () => {
    const loaded = loadConfig(path.join(dir, 'nope.json'));
    assert.deepEqual(loaded, normalizeConfig(DEFAULT_CONFIG));
  });

  test('throws ConfigError for invalid JSON, naming the file', () => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{ "timezone": ');
    assert.throws(() => loadConfig(file), (err) => (
      err instanceof ConfigError && err.message.includes('broken.json') && /JSON/.test(err.message)
    ));
  });

  test('throws ConfigError for invalid values, naming the file and field', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ timezone: 'Nowhere/Land' }));
    assert.throws(() => loadConfig(file), (err) => (
      err instanceof ConfigError && err.message.includes('bad.json') && /Nowhere\/Land/.test(err.message)
    ));
  });

  test('a zero scheduler interval is a config error naming the file, not a timer RangeError at startup', () => {
    const file = path.join(dir, 'zero.json');
    fs.writeFileSync(file, JSON.stringify({ schedulerIntervalSeconds: 0 }));
    assert.throws(() => loadConfig(file), (err) => (
      err instanceof ConfigError && err.message.startsWith(`Config file ${file}: schedulerIntervalSeconds`)
    ));
  });

  test('throws ConfigError when the path is unreadable (a directory)', () => {
    assert.throws(() => loadConfig(dir), ConfigError);
  });

  test('defaults to $CONFIG_PATH', () => {
    const file = path.join(dir, 'env.json');
    fs.writeFileSync(file, JSON.stringify({ timezone: 'UTC', slots: [], queueDaysAhead: 3 }));
    process.env.CONFIG_PATH = file;
    const loaded = loadConfig();
    assert.equal(loaded.timezone, 'UTC');
    assert.equal(loaded.queueDaysAhead, 3);
  });
});

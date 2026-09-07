/**
 * End-to-end test: drives the real front end in headless Chromium against a
 * real server (ephemeral port, throw-away data directory, pinned clock,
 * reminder mode because no X keys are configured).
 *
 * Playwright is not a dependency of this project, so the suite skips itself
 * with a hint when the `playwright` package cannot be resolved. Point
 * NODE_PATH at a global install if you have one:
 *
 *   NODE_PATH=/opt/node22/lib/node_modules node --test test/e2e/browser.test.js
 *
 * Set E2E_SHOTS_DIR to a directory to also save screenshots (editor in light
 * and dark, queue, focus mode, posted view) at 1280x900.
 *
 * A second suite runs against a server with a fake X client (configured mode)
 * and drives both a desktop page and a phone-sized one, for the behaviours
 * that only show up there: the publishing state, the race between the lazy
 * first save and navigation, and the phone layout of the queue, action bar and
 * toasts.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { startServer } from '../../src/server.js';

/** Monday 2026-09-07 12:00Z: between the 09:00 and 16:00 slots, so the next free slot is 16:00 today. */
const T0 = Date.UTC(2026, 8, 7, 12);
const NEXT_SLOT = Date.UTC(2026, 8, 7, 16);
/** How the browser (en-US, UTC) formats T0's day and the next slot's time. */
const TODAY_LABEL = 'Mon, Sep 7';
const NEXT_SLOT_TIME = '4:00 PM';
const THREAD = ['First post', 'Second post', 'Third post'];
const CLIPBOARD_TEXT = THREAD.join('\n\n---\n\n');
const OVER_LIMIT_TEXT = 'x'.repeat(290);
const PNG_SIZE = 64;
const POSTED_URL = 'https://x.com/i/status/1';
const VIEWPORT = { width: 1280, height: 900 };
const PHONE_VIEWPORT = { width: 390, height: 844 };
/** Well inside the 600 ms autosave debounce, so a click right after typing races the first save. */
const AUTOSAVE_MS = 600;
/** Generous per-step budget: a cold Chromium start plus a few network round trips. */
const STEP = { timeout: 30_000 };

const TEST_CONFIG = {
  timezone: 'UTC',
  slots: [{ days: 'daily', time: '09:00' }, { days: 'daily', time: '16:00' }],
  schedulerIntervalSeconds: 3600,
  missedGraceMinutes: 180,
  queueDaysAhead: 7,
};

const SHOTS_DIR = process.env.E2E_SHOTS_DIR || null;
const SKIP_HINT = 'Skipping the browser e2e suite: the "playwright" package cannot be resolved. '
  + 'Install it (npm i -D playwright && npx playwright install chromium) or point NODE_PATH at a global install, '
  + 'e.g. NODE_PATH=/opt/node22/lib/node_modules.';

const silentLogger = { log() {}, info() {}, warn() {}, error() {} };

/**
 * Resolve Playwright the way Node's CJS loader would (which honours NODE_PATH,
 * unlike a bare ESM import) and load it. Returns null when it is not installed.
 *
 * @returns {Promise<{ chromium: import('playwright').BrowserType } | null>}
 */
async function loadPlaywright() {
  let entry;
  try {
    entry = createRequire(import.meta.url).resolve('playwright');
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
  const mod = await import(pathToFileURL(entry).href);
  return mod.chromium ? mod : mod.default;
}

/**
 * A solid-colour RGB PNG, built by hand so the test needs no fixture file.
 *
 * @param {number} size width and height in pixels
 * @param {[number, number, number]} rgb
 * @returns {Buffer}
 */
function makePng(size, [r, g, b]) {
  const row = Buffer.alloc(1 + size * 3); // filter byte 0, then RGB triplets
  for (let x = 0; x < size; x += 1) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Collapse whitespace (Intl may emit narrow no-break spaces) for text comparisons. */
function clean(text) {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The toasts whose text contains `text` (with any whitespace where it has spaces: Intl times may use narrow no-break spaces). */
function toastWith(page, text) {
  return page.locator('#toasts .toast', { hasText: new RegExp(escapeRegExp(text).replace(/ /g, '\\s')) });
}

/**
 * Wait until the cleaned text of the first element matching `selector` equals
 * `expected` (a string) or matches it (a RegExp).
 *
 * @param {import('playwright').Page} page
 * @param {string} selector CSS selector
 * @param {string | RegExp} expected
 */
async function waitForText(page, selector, expected) {
  const source = expected instanceof RegExp ? expected.source : `^${escapeRegExp(expected)}$`;
  try {
    await page.waitForFunction(({ selector: sel, source: src }) => {
      const text = (document.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return new RegExp(src).test(text);
    }, { selector, source });
  } catch (err) {
    const current = await page.locator(selector).first().textContent().catch(() => '(no element)');
    throw new Error(`Timed out waiting for ${selector} to match ${expected}; it reads ${JSON.stringify(clean(current))} (${err.message})`);
  }
}

/** The text of every textarea in the editor, in card order. */
function cardTexts(page) {
  return page.locator('#cards .card textarea').evaluateAll((nodes) => nodes.map((node) => node.value));
}

/** "index:caret" of the focused card, e.g. "3/3:10", or null when no textarea has focus. */
function focusedCard(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLTextAreaElement)) return null;
    return `${active.closest('.card').querySelector('.index').textContent}:${active.selectionStart}`;
  });
}

/** The "n / 280" label of every card, in card order. */
async function cardCounts(page) {
  return (await page.locator('#cards .card .counter-label').allTextContents()).map(clean);
}

/** Wait for the first card's uploaded thumbnail to be decoded at the expected pixel size. */
function waitForThumbnail(page) {
  return page.waitForFunction((size) => {
    const img = document.querySelector('#cards .card .thumb:not(.pending) img');
    return Boolean(img && img.complete && img.naturalWidth === size && img.naturalHeight === size);
  }, PNG_SIZE);
}

/** JSON call against a server; fails the test on a non-2xx response. */
async function callApi(server, route, { method = 'GET', body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(server.url + route, init);
  const json = res.status === 204 ? null : await res.json();
  assert.ok(res.ok, `${method} ${route} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/** Poll `check` (sync or async) until it is truthy. */
async function waitUntil(check, label, { timeout = 10_000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${label}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * A fake X client for configured mode. Posts are numbered t-1, t-2, …; a post
 * whose text is 'FAIL' throws the way the real client does (carrying the ids
 * posted so far), and `hold()` makes publishThread wait until the returned
 * release function is called, to keep a draft in status `publishing`.
 */
function fakeXClient() {
  let counter = 0;
  let gate = null;
  return {
    hold() {
      let release;
      gate = new Promise((resolve) => { release = resolve; });
      return () => { gate = null; release(); };
    },
    async me() {
      return { id: '42', username: 'tester', name: 'Test Er' };
    },
    async publishThread({ tweets, startIndex = 0, onProgress = null }) {
      if (gate) await gate;
      const tweetIds = [];
      for (let index = startIndex; index < tweets.length; index += 1) {
        if (tweets[index].text === 'FAIL') {
          throw Object.assign(new Error(`Post ${index + 1} of ${tweets.length} failed: X API 403 on POST /2/tweets: Forbidden`), { index, tweetIds });
        }
        counter += 1;
        tweetIds.push(`t-${counter}`);
        if (onProgress) await onProgress({ index, tweetId: tweetIds.at(-1), tweetIds: [...tweetIds] });
      }
      return { tweetIds };
    },
  };
}

/**
 * A stand-in for window.Notification, installed before the app loads, so a
 * test can pick the permission state (headless Chromium always reports
 * 'denied') and see what the app asks for and shows. Exposed as
 * `window.__notifications = { requests, shown }`.
 */
function fakeNotificationScript(permission) {
  return `
    window.__notifications = { requests: 0, shown: [] };
    window.Notification = class FakeNotification {
      static permission = ${JSON.stringify(permission)};
      static async requestPermission() {
        window.__notifications.requests += 1;
        if (FakeNotification.permission === 'default') FakeNotification.permission = 'granted';
        return FakeNotification.permission;
      }
      constructor(title, options = {}) { window.__notifications.shown.push({ title, ...options }); }
      addEventListener() {}
      close() {}
    };`;
}

/** A page in its own context (en-US, UTC, light, clipboard allowed, clock pinned at `at`) that reports errors into `errors`. */
async function openPage(browser, contextOptions, errors, at = T0) {
  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    permissions: ['clipboard-read', 'clipboard-write'],
    ...contextOptions,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.clock.setFixedTime(at);
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const { url, lineNumber } = msg.location();
    errors.push(`console.error: ${msg.text()} (${url}:${lineNumber})`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('dialog', (dialog) => {
    errors.push(`native dialog: ${dialog.type()}: ${dialog.message()}`);
    dialog.accept().catch(() => {});
  });
  return { context, page };
}

/** [r, g, b, a] of a computed "rgb(…)" / "rgba(…)" colour. */
function parseColor(text) {
  const m = /rgba?\(([^)]+)\)/.exec(text);
  assert.ok(m, `not a colour: ${text}`);
  const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [r, g, b, a];
}

/** Flatten a translucent colour over an opaque one. */
function composite(top, under) {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1);
}

/** WCAG 2.x contrast ratio of two opaque colours. */
function contrastRatio(a, b) {
  const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const playwright = await loadPlaywright();
if (!playwright) console.log(SKIP_HINT);

describe('o_typefully in a real browser', { skip: playwright ? false : SKIP_HINT, timeout: 240_000 }, () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let server;
  /** @type {import('playwright').Browser} */
  let browser;
  /** @type {import('playwright').BrowserContext} */
  let context;
  /** @type {import('playwright').Page} */
  let page;
  /** id of the draft the whole flow works on */
  let draftId;
  /** console.error output and uncaught page errors, all of which fail the run */
  const consoleErrors = [];
  /** beforeunload prompts would mean a save was still pending at reload time */
  const dialogs = [];

  function api(route, options) {
    return callApi(server, route, options);
  }

  async function getDraft(id = draftId) {
    return (await api(`/api/drafts/${id}`)).draft;
  }

  async function shot(name) {
    if (!SHOTS_DIR) return;
    await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
  }

  before(async () => {
    const bootedAt = Date.now();
    server = await startServer({
      env: {},
      xClient: null,
      config: TEST_CONFIG,
      now: () => T0 + (Date.now() - bootedAt),
      logger: silentLogger,
    });
    if (SHOTS_DIR) fs.mkdirSync(SHOTS_DIR, { recursive: true });

    browser = await playwright.chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: VIEWPORT,
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    // Freeze the browser's Date so "Today"/"Tomorrow" labels and "next free slot" are stable on any real date.
    await page.clock.setFixedTime(T0);
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const { url, lineNumber } = msg.location();
      consoleErrors.push(`console.error: ${msg.text()} (${url}:${lineNumber})`);
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('dialog', (dialog) => {
      dialogs.push(`${dialog.type()}: ${dialog.message()}`);
      dialog.accept().catch(() => {});
    });
  }, STEP);

  after(async () => {
    await context?.close();
    await browser?.close();
    await server?.close();
  }, STEP);

  it('loads the app in reminder mode', STEP, async () => {
    await page.goto(`${server.url}/`);
    await waitForText(page, '#x-status', 'X API: not configured — reminder mode');
    assert.equal(await page.title(), 'o_typefully');
    assert.equal(clean(await page.locator('#view-title').textContent()), 'New draft');
    assert.equal(clean(await page.locator('#tz-label').textContent()), 'UTC');
    assert.equal(await page.locator('#cards .card').count(), 1);
    assert.equal(await page.evaluate(() => Date.now()), T0, 'the browser clock is pinned');
  });

  it('creates a draft with the "New draft" button', STEP, async () => {
    await page.locator('#new-draft').click();
    await page.waitForURL(/#\/draft\/[0-9a-f-]{36}$/);
    draftId = page.url().split('#/draft/')[1];
    await waitForText(page, '#count-drafts', '1');
    const row = page.locator('#sidebar-list .row.active');
    assert.match(clean(await row.textContent()), /Empty draft.*1 post/);
    assert.equal((await getDraft()).status, 'draft');
  });

  it('exposes the sidebar rows as buttons in a list, and each tab with the panel it controls', STEP, async () => {
    const row = page.locator('#sidebar-list .row').first();
    assert.equal(await row.evaluate((n) => n.tagName), 'BUTTON');
    assert.equal(await row.getAttribute('role'), null, 'no role overrides the button semantics');
    assert.equal(await row.evaluate((n) => n.parentElement.tagName === 'LI' && n.closest('ul') !== null), true, 'the rows form a list');
    assert.equal(await page.locator('#sidebar-list [role="list"], #sidebar-list [role="listitem"]').count(), 0);
    const tabs = await page.locator('.tabs [role="tab"]').all();
    assert.equal(tabs.length, 3);
    for (const tab of tabs) {
      const controls = await tab.getAttribute('aria-controls');
      assert.ok(controls, `${clean(await tab.textContent())} names no panel`);
      const panel = page.locator(`#${controls}`);
      assert.equal(await panel.count(), 1, `#${controls} exists`);
      assert.equal(await panel.getAttribute('role'), 'tabpanel');
      assert.equal(await panel.getAttribute('aria-labelledby'), await tab.getAttribute('id'));
    }
    assert.equal(await page.locator('.tabs [role="tab"][aria-selected="true"]').getAttribute('aria-controls'), 'view-editor');
    assert.equal(await page.locator('#view-editor').isVisible(), true);
  });

  it('splits typed "---" separators into cards with live counters', STEP, async () => {
    await page.locator('#cards .card textarea').first().click();
    await page.keyboard.type(THREAD.join('\n---\n'));
    assert.deepEqual(await cardTexts(page), THREAD);
    assert.deepEqual(await cardCounts(page), ['10 / 280', '11 / 280', '10 / 280']);
    assert.deepEqual(
      (await page.locator('#cards .card .index').allTextContents()).map(clean),
      ['1/3', '2/3', '3/3'],
    );
    assert.equal(await page.locator('#cards .card.over').count(), 0);
    // The caret ended up in the third card, ready to keep typing.
    assert.equal(await focusedCard(page), `3/3:${THREAD[2].length}`);

    await page.locator('#add-post').click();
    assert.equal(await page.locator('#cards .card').count(), 4);
    assert.equal(await focusedCard(page), '4/4:0');
    await page.keyboard.press('Backspace'); // empty card, not the first: removed, caret back at the end of post 3
    assert.equal(await page.locator('#cards .card').count(), 3);
    assert.equal(await focusedCard(page), `3/3:${THREAD[2].length}`);
    assert.deepEqual(await cardTexts(page), THREAD);
  });

  it('flags a 290-character post as over the limit', STEP, async () => {
    const third = page.locator('#cards .card').nth(2);
    await third.locator('textarea').fill(OVER_LIMIT_TEXT);
    assert.equal(clean(await third.locator('.counter-label').textContent()), '290 / 280');
    assert.equal(await third.locator('.counter').getAttribute('data-level'), 'over');
    assert.equal(await third.locator('.counter').getAttribute('aria-live'), 'polite');
    assert.ok(await third.evaluate((node) => node.classList.contains('over')), 'the card carries the .over class');
    assert.ok(
      await third.locator('textarea').evaluate((node) => node.scrollHeight <= node.clientHeight + 1),
      'the textarea grew instead of scrolling',
    );
    assert.equal(await page.locator('#cards .card.over').count(), 1, 'only the long card is flagged');

    await third.locator('textarea').fill(THREAD[2]);
    assert.equal(await page.locator('#cards .card.over').count(), 0);
    assert.equal(await third.locator('.counter').getAttribute('aria-live'), null);
  });

  it('reorders posts with the up and down buttons', STEP, async () => {
    await page.locator('button[aria-label="Move post 3 up"]').click();
    assert.deepEqual(await cardTexts(page), [THREAD[0], THREAD[2], THREAD[1]]);
    assert.equal(await page.locator('button[aria-label="Move post 1 up"]').isDisabled(), true);
    assert.equal(await page.locator('button[aria-label="Move post 3 down"]').isDisabled(), true);

    await page.locator('button[aria-label="Move post 2 down"]').click();
    assert.deepEqual(await cardTexts(page), THREAD);
    assert.deepEqual(await cardCounts(page), ['10 / 280', '11 / 280', '10 / 280']);
  });

  it('uploads a PNG through the file input and shows a thumbnail', STEP, async () => {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('button[aria-label="Add image to post 1"]').click(),
    ]);
    await chooser.setFiles({ name: 'swatch.png', mimeType: 'image/png', buffer: makePng(PNG_SIZE, [59, 108, 240]) });
    await waitForThumbnail(page);

    const first = page.locator('#cards .card').first();
    const src = await first.locator('.thumb img').getAttribute('src');
    assert.match(src, /^\/media\/[0-9a-f-]{36}$/);
    assert.equal(await first.locator('.thumb.pending').count(), 0);
    assert.equal(await page.locator('#cards .card .thumb').count(), 1, 'only the first post has an image');
    assert.equal(clean(await first.locator('.thumb-btn').first().textContent()), 'ALT');
  });

  it('autosaves, and the thread survives a reload', STEP, async () => {
    await waitForText(page, '.actionbar .save-status', /^Saved /);
    const before = await getDraft();
    assert.deepEqual(before.tweets.map((t) => t.text), THREAD);
    assert.equal(before.tweets[0].media.length, 1);
    assert.equal(before.tweets[0].media[0].type, 'image/png');

    await page.reload();
    await page.locator('#cards .card').nth(2).waitFor();
    assert.equal(page.url(), `${server.url}/#/draft/${draftId}`, 'the route survives a reload');
    assert.equal(await page.evaluate(() => Date.now()), T0, 'the pinned clock survives a reload');
    assert.deepEqual(await cardTexts(page), THREAD);
    assert.deepEqual(await cardCounts(page), ['10 / 280', '11 / 280', '10 / 280']);
    await waitForThumbnail(page);
    assert.equal(await page.locator('#cards .card .thumb').count(), 1);
    await waitForText(page, '.actionbar .save-status', /^Saved /);
    assert.match(clean(await page.locator('#sidebar-list .row.active').textContent()), /First post.*3 posts/);

    await shot('editor-light');
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMedia({ colorScheme: 'dark' });
    const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(darkBg, lightBg, 'the dark theme changes the page background');
    await shot('editor-dark');
    await page.emulateMedia({ colorScheme: 'light' });
  });

  it('schedules at the next free slot in reminder mode and shows it in the queue', STEP, async () => {
    await page.locator('button[aria-label="Schedule"]').click();
    const form = page.locator('.popover form.schedule-form');
    await form.waitFor();
    await waitForText(page, '.popover label.choice:has(input[value="next"])',
      `Next free slot — ${TODAY_LABEL} · ${NEXT_SLOT_TIME}`);
    assert.equal(await form.locator('input[name="when"][value="next"]').isChecked(), true);
    assert.equal(await form.locator('input[name="mode"][value="api"]').isDisabled(), true, 'API mode is disabled without keys');
    assert.equal(await form.locator('input[name="mode"][value="manual"]').isChecked(), true);
    await form.locator('button[type="submit"]').click();

    await page.locator('#banner .banner.scheduled').waitFor();
    assert.equal(await page.locator('.popover').count(), 0, 'the popover closed');
    assert.equal(clean(await page.locator('#banner .banner-title').textContent()),
      `Scheduled for ${TODAY_LABEL} · ${NEXT_SLOT_TIME} Reminder`);
    assert.equal(clean(await page.locator('#banner .banner-title .badge').textContent()), 'Reminder');
    await waitForText(page, '#view-title', 'Scheduled');
    await waitForText(page, '#count-queue', '1');
    await waitForText(page, '#count-drafts', '0');
    assert.equal(clean(await page.locator('#sidebar-list .row.active .badge').textContent()), NEXT_SLOT_TIME);
    const draft = await getDraft();
    assert.equal(draft.status, 'scheduled');
    assert.equal(draft.mode, 'manual');
    assert.equal(draft.scheduledAt, NEXT_SLOT);

    await page.locator('.tab[data-tab="queue"]').click();
    await page.waitForURL(/#\/queue$/);
    const today = page.locator('#view-queue section.day', { hasText: 'Today' });
    await today.waitFor();
    assert.equal(clean(await today.locator('.day-head').textContent()), `Today · ${TODAY_LABEL}`);
    const entries = today.locator('li.entry');
    assert.equal(await entries.count(), 1, 'the 09:00 slot is past and empty, so only 16:00 is listed');
    assert.equal(clean(await entries.first().locator('time').textContent()), NEXT_SLOT_TIME);
    const card = entries.first().locator('.entry-card');
    const cardText = clean(await card.textContent());
    assert.match(cardText, /First post/);
    assert.match(cardText, /3 posts/);
    assert.match(cardText, /Reminder/);
    assert.doesNotMatch(cardText, /Custom time|Overdue|Due/);
    assert.equal(await card.locator('.entry-thumbs img').count(), 1);

    const tomorrow = page.locator('#view-queue section.day', { hasText: 'Tomorrow' });
    assert.equal(await tomorrow.locator('li.entry').count(), 2);
    assert.equal(await tomorrow.locator('li.entry .entry-card.empty').count(), 2, 'tomorrow has two empty slots');
    assert.equal(await page.locator('#view-queue .attention').count(), 0, 'nothing needs attention');
    await shot('queue');
  });

  it('reschedules from the queue through a popover that names the slot the item holds', STEP, async () => {
    const today = page.locator('#view-queue section.day', { hasText: 'Today' });
    const form = page.locator('.popover form.schedule-form');
    await today.locator('.entry-card button', { hasText: 'Reschedule' }).click();
    await form.waitFor();
    assert.equal(await form.getAttribute('aria-label'), 'Reschedule');
    assert.equal(clean(await form.locator('.schedule-current').textContent()), `Currently scheduled for ${TODAY_LABEL} · ${NEXT_SLOT_TIME}`);
    assert.equal(clean(await form.locator('button[type="submit"]').textContent()), 'Reschedule', 'the item is already in the queue');
    // The server treats the item's own slot as free for it, so "next free" hands the same slot back: say so.
    await waitForText(page, '.popover label.choice:has(input[value="next"])',
      `Next free slot — ${TODAY_LABEL} · ${NEXT_SLOT_TIME} (its current slot)`);
    const successToasts = page.locator('#toasts .toast', { hasText: /^Scheduled for/ });
    const successToastsBefore = await successToasts.count(); // the previous test's may still be on screen
    await form.locator('button[type="submit"]').click();
    await toastWith(page, `Unchanged — still scheduled for ${TODAY_LABEL} · ${NEXT_SLOT_TIME}`).waitFor();
    assert.equal(await successToasts.count(), successToastsBefore, 'a no-op is not announced as a success');
    assert.equal((await getDraft()).scheduledAt, NEXT_SLOT);

    // Picking a time moves it, and that is announced as before.
    await today.locator('.entry-card button', { hasText: 'Reschedule' }).click();
    await form.waitFor();
    await form.locator('input[name="at"]').fill('2026-09-08T10:30');
    assert.equal(await form.locator('input[name="when"][value="custom"]').isChecked(), true);
    await form.locator('button[type="submit"]').click();
    await toastWith(page, 'Scheduled for Tue, Sep 8 · 10:30 AM').waitFor();
    assert.equal((await getDraft()).scheduledAt, Date.UTC(2026, 8, 8, 10, 30));
    const tomorrow = page.locator('#view-queue section.day', { hasText: 'Tomorrow' });
    const moved = tomorrow.locator('.entry-card', { hasText: 'First post' });
    await moved.waitFor();
    assert.match(clean(await moved.textContent()), /Custom time/);

    // Back to the next free slot (16:00 today, free again now) for the tests that follow.
    await moved.locator('button', { hasText: 'Reschedule' }).click();
    await form.waitFor();
    assert.equal(clean(await form.locator('.schedule-current').textContent()), 'Currently scheduled for Tue, Sep 8 · 10:30 AM');
    await waitForText(page, '.popover label.choice:has(input[value="next"])', `Next free slot — ${TODAY_LABEL} · ${NEXT_SLOT_TIME}`);
    await form.locator('button[type="submit"]').click();
    await toastWith(page, `Scheduled for ${TODAY_LABEL} · ${NEXT_SLOT_TIME}`).waitFor();
    assert.equal((await getDraft()).scheduledAt, NEXT_SLOT);
    await today.locator('.entry-card', { hasText: 'First post' }).waitFor();
  });

  it('unschedules from the queue view', STEP, async () => {
    const today = page.locator('#view-queue section.day', { hasText: 'Today' });
    await today.locator('.entry-card button', { hasText: 'Unschedule' }).click();
    await page.locator('#toasts .toast', { hasText: 'Moved back to drafts.' }).waitFor();
    await waitForText(page, '#count-queue', '0');
    await waitForText(page, '#count-drafts', '1');
    await today.locator('li.entry .entry-card.empty').waitFor();
    assert.equal(await today.locator('li.entry').count(), 1, 'the freed 16:00 slot is listed as empty');
    const draft = await getDraft();
    assert.equal(draft.status, 'draft');
    assert.equal(draft.scheduledAt, null);
  });

  it('copies the thread to the clipboard', STEP, async () => {
    await page.locator('.tab[data-tab="drafts"]').click();
    await page.locator('#sidebar-list .row', { hasText: 'First post' }).click();
    await page.waitForURL(`${server.url}/#/draft/${draftId}`);
    await page.locator('#cards .card').nth(2).waitFor();
    assert.deepEqual(await cardTexts(page), THREAD);

    await page.locator('button[aria-label="Copy the whole thread to the clipboard"]').click();
    await page.locator('#toasts .toast', { hasText: 'Thread copied (3 posts)' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), CLIPBOARD_TEXT);
  });

  it('toggles focus mode with the button, Escape and Ctrl+Shift+F', STEP, async () => {
    await page.locator('#focus-btn').click();
    await page.waitForSelector('body.focus');
    assert.equal(await page.locator('#sidebar').isHidden(), true);
    assert.equal(await page.locator('#actionbar').isHidden(), true);
    assert.equal(await page.locator('.topbar').isHidden(), true);
    assert.equal(await page.locator('#cards .card').nth(2).isVisible(), true);
    assert.match(clean(await page.locator('#focus-indicator').textContent()), /^Saved .* · Esc to exit$/);
    assert.equal(await page.locator('#focus-btn').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => localStorage.getItem('otf.focus')), '1');
    await shot('focus');

    // Leaving the editor (Back, a typed hash, another tab's route) only suspends focus
    // mode: the preference is kept and the editor comes back in focus mode.
    await page.evaluate(() => { location.hash = '#/queue'; });
    await page.waitForSelector('body:not(.focus)');
    assert.equal(await page.locator('#view-queue').isVisible(), true);
    assert.equal(await page.locator('#sidebar').isVisible(), true, 'the queue needs the sidebar');
    assert.equal(await page.locator('#focus-indicator').isHidden(), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('otf.focus')), '1', 'the preference survives leaving the editor');
    await page.keyboard.press('Escape'); // outside the editor there is nothing to leave
    assert.equal(await page.evaluate(() => localStorage.getItem('otf.focus')), '1');
    await page.evaluate((id) => { location.hash = `#/draft/${id}`; }, draftId);
    await page.waitForSelector('body.focus');
    assert.equal(await page.locator('#sidebar').isHidden(), true, 'back in the editor, focus mode is back');
    assert.equal(await page.locator('#focus-indicator').isVisible(), true);

    await page.keyboard.press('Escape');
    await page.waitForSelector('body:not(.focus)');
    assert.equal(await page.locator('#sidebar').isVisible(), true);
    assert.equal(await page.locator('#focus-indicator').isHidden(), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('otf.focus')), '0');

    await page.keyboard.press('Control+Shift+F');
    await page.waitForSelector('body.focus');
    assert.equal(await page.locator('#sidebar').isHidden(), true);
    await page.keyboard.press('Escape');
    await page.waitForSelector('body:not(.focus)');
  });

  it('fires a reminder when the post is due, then copies post by post and marks it posted', STEP, async () => {
    // Scheduled elsewhere (here: straight through the API) while the editor is open → the banner updates over SSE.
    const { now } = await api('/api/status');
    await api(`/api/drafts/${draftId}/schedule`, { method: 'POST', body: { at: now } });
    await page.locator('#banner .banner.scheduled').waitFor();
    // Reading with the caret in the text when the reminder lands: the reload keeps the caret.
    await page.locator('#cards .card textarea').first().click();
    await page.keyboard.press('End');
    assert.equal(await focusedCard(page), `1/3:${THREAD[0].length}`);

    await server.scheduler.tick();
    await page.locator('#banner .banner.due').waitFor();
    await page.locator('#toasts .toast', { hasText: 'Time to post: First post' }).waitFor();
    await waitForText(page, '#view-title', 'Time to post');
    assert.equal(clean(await page.locator('#banner .banner-title').textContent()), "It's time to post this.");
    assert.equal((await getDraft()).status, 'due');
    assert.equal(await focusedCard(page), `1/3:${THREAD[0].length}`, 'the caret survived the reload from the server');

    const stepper = page.locator('#banner .btn-primary');
    assert.equal(clean(await stepper.textContent()), 'Copy post 1 of 3');
    await stepper.click();
    await page.locator('#toasts .toast', { hasText: 'Copied post 1 of 3' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), THREAD[0]);
    await waitForText(page, '#banner .btn-primary', 'Copy post 2 of 3');
    // Each card also gets its own copy button while the post is due.
    await page.locator('button[aria-label="Copy post 3"]').click();
    await page.locator('#toasts .toast', { hasText: 'Copied post 3 of 3' }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), THREAD[2]);

    await page.locator('#banner button', { hasText: 'Mark as posted' }).click();
    const dialog = page.locator('#dialog[open]');
    await dialog.waitFor();
    await dialog.locator('input').fill(POSTED_URL);
    await dialog.locator('button', { hasText: 'Mark as posted' }).click();
    await page.locator('#banner .banner.posted').waitFor();
    assert.match(clean(await page.locator('#banner .banner-title').textContent()), /^Marked as posted · /);
    assert.equal(await page.locator('#banner a').getAttribute('href'), POSTED_URL);
    assert.equal(await page.locator('#cards textarea[readonly]').count(), 3, 'a posted thread is read-only');
    assert.equal(await page.locator('#add-post-row').isHidden(), true);
    // A record of what went out, not a greyed-out editor: no handle, tools or counter, only the position in the thread.
    assert.equal(await page.locator('#cards .card.read-only').count(), 3);
    assert.equal(await page.locator('#cards .handle, #cards .card-tools, #cards .counter, #cards .card-remove').count(), 0, 'no editing chrome');
    assert.deepEqual((await page.locator('#cards .card .index').allTextContents()).map(clean), ['1/3', '2/3', '3/3']);
    assert.match(clean(await page.locator('.actionbar .save-status').textContent()), /^Posted Mon, Sep 7 · 12:0\d PM$/,
      'the action bar reports the posting, not the last edit');
    await waitForText(page, '#count-posted', '1');
    await waitForText(page, '#count-queue', '0');
    const draft = await getDraft();
    assert.equal(draft.status, 'posted');
    assert.deepEqual(draft.result, { manual: true, url: POSTED_URL });
  });

  it('lists the posted thread in the Posted view', STEP, async () => {
    await page.locator('.tab[data-tab="posted"]').click();
    await page.waitForURL(/#\/posted$/);
    const item = page.locator('#view-posted .history li.entry-card');
    await item.waitFor();
    assert.equal(await item.count(), 1);
    const text = clean(await item.textContent());
    assert.match(text, /First post/);
    assert.match(text, /3 posts/);
    assert.match(text, /Marked as posted/);
    assert.equal(await item.locator('a', { hasText: 'View on X' }).getAttribute('href'), POSTED_URL);
    assert.match(clean(await page.locator('#sidebar-list .row').first().textContent()), /First post.*3 posts.*Posted/);
    await shot('posted');
  });

  it('logged no console errors, page errors or beforeunload prompts', () => {
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(dialogs, []);
  });
});

describe('o_typefully with the X API configured, on a desktop and on a phone', { skip: playwright ? false : SKIP_HINT, timeout: 240_000 }, () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let server;
  /** @type {import('playwright').Browser} */
  let browser;
  /** @type {import('playwright').BrowserContext[]} */
  const contexts = [];
  /** @type {import('playwright').Page} 1280x900 */
  let desktop;
  /** @type {import('playwright').Page} 390x844, touch */
  let phone;
  /** @type {ReturnType<typeof fakeXClient>} */
  let xClient;
  /** console.error output, uncaught page errors and native dialogs from both pages, all of which fail the run */
  const errors = [];

  const api = (route, options) => callApi(server, route, options);
  const getDraft = async (id) => (await api(`/api/drafts/${id}`)).draft;
  const createDraft = async (texts) => (await api('/api/drafts', {
    method: 'POST', body: { tweets: texts.map((text) => ({ text, media: [] })) },
  })).draft;
  const draftWithText = async (text) => (await api('/api/drafts?status=draft')).drafts.find((d) => d.tweets[0].text === text);
  const box = async (locator) => {
    const rect = await locator.boundingBox();
    assert.ok(rect, `${locator} has no box`);
    return { ...rect, right: rect.x + rect.width, bottom: rect.y + rect.height };
  };

  before(async () => {
    const bootedAt = Date.now();
    xClient = fakeXClient();
    server = await startServer({
      env: {},
      xClient,
      config: TEST_CONFIG,
      now: () => T0 + (Date.now() - bootedAt),
      logger: silentLogger,
    });
    browser = await playwright.chromium.launch({ headless: true });
    const d = await openPage(browser, { viewport: VIEWPORT }, errors);
    const p = await openPage(browser, { viewport: PHONE_VIEWPORT, isMobile: true, hasTouch: true }, errors);
    contexts.push(d.context, p.context);
    desktop = d.page;
    phone = p.page;
  }, STEP);

  after(async () => {
    for (const context of contexts) await context.close();
    await browser?.close();
    await server?.close();
  }, STEP);

  it('leaves a card that only carries an image alone on Backspace', STEP, async () => {
    const draft = await createDraft(['first']);
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await waitForText(desktop, '#x-status', 'X API: connected');
    await desktop.locator('#add-post').click();
    const [chooser] = await Promise.all([
      desktop.waitForEvent('filechooser'),
      desktop.locator('button[aria-label="Add image to post 2"]').click(),
    ]);
    await chooser.setFiles({ name: 'swatch.png', mimeType: 'image/png', buffer: makePng(PNG_SIZE, [200, 40, 40]) });
    await waitForThumbnail(desktop);
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    const second = desktop.locator('#cards .card').nth(1);
    const mediaUrl = await second.locator('.thumb img').getAttribute('src');
    assert.equal((await fetch(server.url + mediaUrl)).status, 200);

    await second.locator('textarea').click();
    assert.equal(await focusedCard(desktop), '2/2:0');
    await desktop.keyboard.press('Backspace');
    await desktop.waitForTimeout(AUTOSAVE_MS + 200); // long enough for a removal to have been saved
    assert.equal(await desktop.locator('#cards .card').count(), 2, 'a card with an image is not "empty"');
    assert.equal(await desktop.locator('#dialog[open]').count(), 0, 'and nothing was asked');
    assert.equal(await desktop.locator('#cards .card .thumb').count(), 1);
    assert.equal(await focusedCard(desktop), '2/2:0');
    assert.equal((await getDraft(draft.id)).tweets[1].media.length, 1);
    assert.equal((await fetch(server.url + mediaUrl)).status, 200, 'the image is still on the server');

    // The remove button still works, after the confirmation it always asked for.
    await desktop.locator('button[aria-label="Remove post 2"]').click();
    const dialog = desktop.locator('#dialog[open]');
    await dialog.waitFor();
    assert.match(clean(await dialog.textContent()), /Remove post 2\?/);
    await dialog.locator('button', { hasText: 'Remove' }).click();
    await desktop.waitForFunction(() => document.querySelectorAll('#cards .card').length === 1);
    await waitUntil(async () => (await fetch(server.url + mediaUrl)).status === 404, 'the removed image is deleted');
  });

  it('keeps the image tools in view on a touch screen, where nothing hovers', STEP, async () => {
    const draft = await createDraft(['Image on a phone']);
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    const [chooser] = await Promise.all([
      desktop.waitForEvent('filechooser'),
      desktop.locator('button[aria-label="Add image to post 1"]').click(),
    ]);
    await chooser.setFiles({ name: 'swatch.png', mimeType: 'image/png', buffer: makePng(PNG_SIZE, [40, 40, 200]) });
    await waitForThumbnail(desktop);
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    // With a mouse the tools appear on hover, as before.
    const opacity = (page) => page.locator('#cards .thumb .thumb-tools').evaluate((n) => getComputedStyle(n).opacity);
    await desktop.mouse.move(VIEWPORT.width - 10, VIEWPORT.height - 10); // off the card: the mouse still sits where "Add image" was
    await desktop.waitForFunction(() => getComputedStyle(document.querySelector('#cards .thumb .thumb-tools')).opacity === '0'); // the 120 ms fade
    await desktop.locator('#cards .thumb').hover();
    await desktop.waitForFunction(() => getComputedStyle(document.querySelector('#cards .thumb .thumb-tools')).opacity === '1');

    // A touch page of its own: the shared phone page is first loaded later, and loading it now
    // would have it collect the SSE toasts of the publish tests in between.
    const { context, page: touch } = await openPage(browser, { viewport: PHONE_VIEWPORT, isMobile: true, hasTouch: true }, errors);
    try {
      await touch.goto(`${server.url}/#/draft/${draft.id}`);
      await waitForThumbnail(touch);
      assert.equal(await touch.evaluate(() => matchMedia('(hover: none)').matches), true, 'the touch context cannot hover');
      assert.equal(await opacity(touch), '1', 'the ALT and remove buttons are visible without a tap');
      const thumb = await box(touch.locator('#cards .thumb'));
      for (const label of ['Add alt text', 'Remove image']) {
        const rect = await box(touch.locator(`#cards .thumb button[aria-label="${label}"]`));
        assert.ok(rect.x >= thumb.x && rect.right <= thumb.right && rect.bottom <= thumb.bottom, `"${label}" sits inside the thumbnail`);
      }
      await touch.locator('#cards .thumb button[aria-label="Remove image"]').tap();
      await touch.waitForFunction(() => document.querySelectorAll('#cards .thumb').length === 0);
      await waitUntil(async () => (await getDraft(draft.id)).tweets[0].media.length === 0, 'the removal was saved');
    } finally {
      await context.close();
    }
  });

  it('keeps the queue route when the first save of a new draft lands after the user left the editor', STEP, async () => {
    await desktop.goto(`${server.url}/#/drafts`);
    await waitForText(desktop, '#view-title', 'New draft');
    await desktop.locator('#cards .card textarea').first().click();
    await desktop.keyboard.type('hello');
    await desktop.locator('.tab[data-tab="queue"]').click(); // inside the autosave debounce: the POST is still to come
    await desktop.waitForURL(/#\/queue$/);
    await waitUntil(async () => draftWithText('hello'), 'the lazy first save created the draft');
    await desktop.waitForTimeout(300); // let the page handle the response

    assert.equal(new URL(desktop.url()).hash, '#/queue', 'the late save did not rewrite the URL');
    assert.equal(clean(await desktop.locator('#view-title').textContent()), 'Queue');
    assert.equal(await desktop.locator('#view-queue').isVisible(), true);
    assert.equal(await desktop.locator('#view-editor').isHidden(), true);
    assert.equal(await desktop.evaluate(() => localStorage.getItem('otf.route')), '#/queue');
    assert.equal(await desktop.locator('#focus-btn').isHidden(), true);
    await desktop.keyboard.press('Control+Shift+F');
    assert.equal(await desktop.evaluate(() => document.body.classList.contains('focus')), false, 'editor shortcuts stay off outside the editor');
    await desktop.reload();
    await desktop.locator('#view-queue .page').waitFor();
    assert.equal(await desktop.locator('#view-editor').isHidden(), true, 'a reload lands in the queue');
    assert.equal(clean(await desktop.locator('#view-title').textContent()), 'Queue');
  });

  it('opens the draft the user clicked even while a brand-new draft is still being saved', STEP, async () => {
    const target = await createDraft(['Target draft']);
    await desktop.goto(`${server.url}/#/drafts`);
    await waitForText(desktop, '#view-title', 'New draft');
    const row = desktop.locator('#sidebar-list .row', { hasText: 'Target draft' });
    await row.waitFor();
    await desktop.locator('#cards .card textarea').first().click();
    await desktop.keyboard.type('x');
    await row.click(); // inside the autosave debounce: the click flushes the POST and races it with the GET

    await desktop.waitForURL(`${server.url}/#/draft/${target.id}`);
    await desktop.waitForFunction(() => document.querySelector('#cards .card textarea')?.value === 'Target draft');
    await waitUntil(async () => draftWithText('x'), 'the typed draft was saved anyway');
    await desktop.waitForTimeout(300);
    assert.equal(new URL(desktop.url()).hash, `#/draft/${target.id}`, 'the late save did not steal the route');
    assert.deepEqual(await cardTexts(desktop), ['Target draft']);
    assert.match(clean(await desktop.locator('#sidebar-list .row.active').textContent()), /Target draft/);
    assert.equal(clean(await desktop.locator('#view-title').textContent()), 'Draft');
  });

  it('shows the read-only "Publishing…" state while Publish now runs, then the thread as it was posted', STEP, async () => {
    const draft = await createDraft(['First post', 'Second post']);
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await desktop.locator('#cards .card').nth(1).waitFor();
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    const release = xClient.hold();
    await desktop.locator('.actionbar button', { hasText: 'Publish now' }).click();
    const dialog = desktop.locator('#dialog[open]');
    await dialog.waitFor();
    await dialog.locator('button', { hasText: 'Publish' }).click();

    await desktop.locator('#banner .banner.publishing').waitFor();
    await waitUntil(async () => (await getDraft(draft.id)).status === 'publishing', 'the server claimed the draft');
    assert.equal(clean(await desktop.locator('#view-title').textContent()), 'Publishing');
    assert.equal(await desktop.locator('#cards textarea[readonly]').count(), 2, 'cards are read-only while publishing');
    assert.equal(await desktop.locator('#add-post-row').isHidden(), true);
    assert.deepEqual((await desktop.locator('.actionbar button').allTextContents()).map(clean), ['Copy thread', '⋯'],
      'Schedule and Publish now are gone while publishing');
    assert.equal(clean(await desktop.locator('.actionbar .save-status').textContent()), 'Publishing…');
    assert.equal(await desktop.locator('#cards .handle, #cards .card-tools, #cards .counter').count(), 0, 'no editing chrome while publishing');

    release();
    await desktop.locator('#banner .banner.posted').waitFor();
    await waitForText(desktop, '#view-title', 'Posted');
    const posted = await getDraft(draft.id);
    assert.equal(posted.status, 'posted');
    assert.deepEqual(await cardTexts(desktop), posted.tweets.map((t) => t.text), 'the read-only thread shows what was posted');
    assert.equal(await desktop.locator('#cards textarea[readonly]').count(), 2);
    assert.match(clean(await desktop.locator('.actionbar .save-status').textContent()), /^Posted Mon, Sep 7 · /);
    await desktop.waitForTimeout(300); // the SSE "posted" announcement and the response both toast the same line
    assert.equal(await desktop.locator('#toasts .toast', { hasText: 'Posted to X: First post' }).count(), 1, 'one toast, not one per announcement');
  });

  it('keeps the publishing state through Retry despite the interim "scheduled" update, after saving pending edits', STEP, async () => {
    const draft = await createDraft(['Retry me', 'FAIL']);
    await api(`/api/drafts/${draft.id}/publish`, { method: 'POST' });
    assert.equal((await getDraft(draft.id)).status, 'failed');
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await desktop.locator('#banner .banner.failed').waitFor();
    assert.match(clean(await desktop.locator('#banner').textContent()),
      /Post 1 is already on X and is locked\. Publishing continues from post 2\. Duplicate the thread to start over\./);

    await desktop.locator('#cards .card').nth(1).locator('textarea').fill('Second try');
    const release = xClient.hold();
    await desktop.locator('#banner button', { hasText: 'Retry' }).click(); // inside the autosave debounce
    await desktop.locator('#banner .banner.publishing').waitFor();
    await waitUntil(async () => (await getDraft(draft.id)).status === 'publishing', 'the server claimed the draft');
    await desktop.waitForTimeout(500); // the retry route's interim "scheduled" write arrives over SSE meanwhile
    assert.equal(await desktop.locator('#banner .banner.publishing').count(), 1, 'still publishing');
    assert.equal(await desktop.locator('#cards textarea[readonly]').count(), 2);
    assert.equal(clean(await desktop.locator('#view-title').textContent()), 'Publishing');

    release();
    await desktop.locator('#banner .banner.posted').waitFor();
    const posted = await getDraft(draft.id);
    assert.equal(posted.status, 'posted');
    assert.deepEqual(posted.tweets.map((t) => t.text), ['Retry me', 'Second try'], 'the pending edit was saved before the retry');
    assert.deepEqual(posted.result.tweetIds.length, 2);
    assert.deepEqual(await cardTexts(desktop), ['Retry me', 'Second try']);
  });

  it('announces a failed publish once, briefly, next to the banner that carries the error', STEP, async () => {
    const draft = await createDraft(['Will fail', 'FAIL']);
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await desktop.locator('#cards .card').nth(1).waitFor();
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    await desktop.evaluate(() => document.getElementById('toasts').replaceChildren());
    await desktop.locator('.actionbar button', { hasText: 'Publish now' }).click();
    const dialog = desktop.locator('#dialog[open]');
    await dialog.waitFor();
    await dialog.locator('button', { hasText: 'Publish' }).click();

    await desktop.locator('#banner .banner.failed').waitFor();
    await desktop.waitForTimeout(300); // the HTTP response and the SSE "failed" event both announce it
    assert.match(clean(await desktop.locator('#banner .banner-error').textContent()), /^Post 2 of 2 failed: X API 403/);
    const toasts = desktop.locator('#toasts .toast');
    assert.equal(await toasts.count(), 1, 'one toast, not one per announcement');
    assert.equal(clean(await toasts.first().textContent()), 'Publishing failed — see the banner for details.');
    assert.equal(await toasts.first().getAttribute('role'), 'alert');
    assert.equal(await desktop.locator('#banner button', { hasText: 'Retry' }).isVisible(), true);
  });

  it('locks the posts already on X of a thread that failed part-way, and keeps the rest editable', STEP, async () => {
    const draft = await createDraft(['Head on X', 'FAIL', 'Tail']);
    await api(`/api/drafts/${draft.id}/publish`, { method: 'POST' });
    const failed = await getDraft(draft.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.result.tweetIds.length, 1);
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await desktop.locator('#banner .banner.failed').waitFor();
    await desktop.locator('#cards .card').nth(2).waitFor();
    assert.match(clean(await desktop.locator('#banner').textContent()),
      /Post 1 is already on X and is locked\. Publishing continues from post 2\. Duplicate the thread to start over\./);

    const first = desktop.locator('#cards .card').first();
    assert.ok(await first.evaluate((node) => node.classList.contains('locked')), 'post 1 is rendered locked');
    assert.equal(await first.locator('textarea').evaluate((node) => node.readOnly), true);
    assert.equal(await first.locator('.handle, .card-tools, .counter, .card-remove').count(), 0, 'no editing chrome on a locked card');
    const badge = first.locator('a.posted-link');
    assert.equal(clean(await badge.textContent()), 'Posted');
    assert.equal(await badge.getAttribute('href'), `https://x.com/i/status/${failed.result.tweetIds[0]}`);
    assert.equal(await badge.getAttribute('target'), '_blank');
    assert.equal(await desktop.locator('#cards .card.locked').count(), 1, 'only the posted head is locked');
    assert.equal(await desktop.locator('#cards textarea[readonly]').count(), 1);
    assert.equal(await desktop.locator('button[aria-label="Move post 2 up"]').isDisabled(), true, 'nothing moves above the locked head');
    assert.equal(await desktop.locator('button[aria-label="Move post 3 up"]').isDisabled(), false);
    assert.equal(await desktop.locator('button[aria-label="Remove post 2"]').count(), 1);

    // The unposted tail is still a normal editor: reorder it and fix it, and the save goes through.
    await desktop.locator('button[aria-label="Move post 3 up"]').click();
    assert.deepEqual(await cardTexts(desktop), ['Head on X', 'Tail', 'FAIL']);
    await desktop.locator('#cards .card').nth(2).locator('textarea').fill('Fixed tail');
    await waitUntil(async () => (await getDraft(draft.id)).tweets.map((t) => t.text).join('|') === 'Head on X|Tail|Fixed tail', 'the edits were saved');
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);

    // "Back to drafts" keeps the ids of what is on X (the server side of that is the API's job; here
    // the state is written straight to the database): a plain draft carrying them is locked the same way.
    server.db.updateDraft(draft.id, { status: 'draft', scheduledAt: null, remindedAt: null });
    await desktop.reload();
    await desktop.locator('#banner .banner.locked').waitFor();
    assert.equal(clean(await desktop.locator('#banner .banner-title').textContent()), 'Post 1 is already on X and is locked.');
    assert.equal(clean(await desktop.locator('#banner .banner-sub').textContent()), 'Publishing continues from post 2. Duplicate the thread to start over.');
    assert.equal(await desktop.locator('#banner button', { hasText: 'Duplicate' }).count(), 1);
    assert.equal(clean(await desktop.locator('#view-title').textContent()), 'Draft');
    assert.equal(await desktop.locator('#cards .card.locked').count(), 1);
    assert.equal(await desktop.locator('#cards .card').first().locator('a.posted-link').getAttribute('href'), `https://x.com/i/status/${failed.result.tweetIds[0]}`);
    assert.equal(await desktop.locator('#cards textarea[readonly]').count(), 1);
  });

  it('recovers when a save is refused because the thread went out part-way meanwhile', STEP, async () => {
    const draft = await createDraft(['Head', 'FAIL']);
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await desktop.locator('#cards .card').nth(1).waitFor();
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    await desktop.locator('#cards .card textarea').first().click();
    await desktop.keyboard.press('End');
    await desktop.keyboard.type(' typo'); // inside the autosave debounce…
    await api(`/api/drafts/${draft.id}/publish`, { method: 'POST' }); // …another tab publishes: post 1 goes out, post 2 fails
    assert.equal((await getDraft(draft.id)).status, 'failed');

    // The PUT with the rewritten post 1 is refused; the editor takes the posted text back and saves the rest.
    await desktop.locator('#cards .card.locked').waitFor();
    await toastWith(desktop, 'Post 1 is already on X and cannot be changed — the posted text was restored').waitFor();
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    // Chromium logs every non-2xx response as a console error; this one is the refusal under test.
    const refused = errors.findIndex((line) => line.includes('409 (Conflict)') && line.includes(`/api/drafts/${draft.id}`));
    assert.ok(refused >= 0, `the browser saw the 409 for the save: ${errors}`);
    errors.splice(refused, 1);
    assert.deepEqual(await cardTexts(desktop), ['Head', 'FAIL']);
    assert.deepEqual((await getDraft(draft.id)).tweets.map((t) => t.text), ['Head', 'FAIL']);
    assert.equal(await desktop.locator('#cards .card').first().locator('textarea').evaluate((node) => node.readOnly), true);

    // Not wedged: the next edit saves and Retry resumes from post 2.
    await desktop.locator('#cards .card').nth(1).locator('textarea').fill('Second try');
    await waitUntil(async () => (await getDraft(draft.id)).tweets[1].text === 'Second try', 'the later edit was saved');
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    await desktop.locator('#banner button', { hasText: 'Retry' }).click();
    await desktop.locator('#banner .banner.posted').waitFor();
    const posted = await getDraft(draft.id);
    assert.equal(posted.status, 'posted');
    assert.equal(posted.result.tweetIds.length, 2, 'post 1 was not posted a second time');
    assert.deepEqual(posted.tweets.map((t) => t.text), ['Head', 'Second try']);
  });

  it('keeps the keyboard on the arrow after a move, so Enter moves the post again instead of typing', STEP, async () => {
    const draft = await createDraft(['A', 'B', 'C']);
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await desktop.locator('#cards .card').nth(2).waitFor();
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    const focusedLabel = () => desktop.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? null);

    await desktop.locator('button[aria-label="Move post 3 up"]').focus();
    await desktop.keyboard.press('Enter');
    assert.deepEqual(await cardTexts(desktop), ['A', 'C', 'B']);
    assert.equal(await focusedLabel(), 'Move post 2 up', 'focus followed the moved card\'s up arrow');
    await desktop.keyboard.press('Enter');
    assert.deepEqual(await cardTexts(desktop), ['C', 'A', 'B'], 'the second Enter moved it again, not a newline into the post');
    assert.equal(await focusedLabel(), 'Move post 1 down', 'at the top the disabled up arrow hands over to down');
    await desktop.keyboard.press('Space');
    assert.deepEqual(await cardTexts(desktop), ['A', 'C', 'B']);
    assert.equal(await focusedLabel(), 'Move post 2 down');
    await waitUntil(async () => (await getDraft(draft.id)).tweets.map((t) => t.text).join('') === 'ACB', 'the order was saved');

    // The ✕ from the keyboard: focus lands on the ✕ of the card that took its place.
    await desktop.locator('button[aria-label="Remove post 2"]').focus();
    await desktop.keyboard.press('Enter');
    const dialog = desktop.locator('#dialog[open]');
    await dialog.waitFor();
    await dialog.locator('button', { hasText: 'Remove' }).click();
    await desktop.waitForFunction(() => document.querySelectorAll('#cards .card').length === 2);
    assert.deepEqual(await cardTexts(desktop), ['A', 'B']);
    assert.equal(await focusedLabel(), 'Remove post 2');
  });

  it('drops the empty card "---" leaves behind before Copy thread and Ctrl+Enter', STEP, async () => {
    await desktop.goto(`${server.url}/#/drafts`);
    await waitForText(desktop, '#view-title', 'New draft');
    await desktop.locator('#cards .card textarea').first().click();
    await desktop.keyboard.type('Hello world, first post\n---\n'); // exactly what the hint under the cards suggests
    await desktop.waitForFunction(() => document.querySelectorAll('#cards .card').length === 2);
    assert.equal(await focusedCard(desktop), '2/2:0', 'the caret went on to the new, empty card');

    await desktop.locator('button[aria-label="Copy the whole thread to the clipboard"]').click();
    await toastWith(desktop, 'Thread copied (1 post)').waitFor();
    assert.equal(await desktop.evaluate(() => navigator.clipboard.readText()), 'Hello world, first post');
    assert.equal(await desktop.locator('#cards .card').count(), 2, 'copying leaves the editor alone');

    await desktop.keyboard.press('Control+Enter');
    await desktop.locator('#banner .banner.scheduled').waitFor();
    assert.equal(await desktop.locator('#toasts .toast', { hasText: 'Post 2 is empty' }).count(), 0);
    assert.equal(await desktop.locator('#cards .card').count(), 1, 'the empty card was scaffolding, not a post');
    const id = desktop.url().split('#/draft/')[1];
    const draft = await getDraft(id);
    assert.equal(draft.status, 'scheduled');
    assert.deepEqual(draft.tweets.map((t) => t.text), ['Hello world, first post']);
  });

  it('refuses Publish now (and Schedule) for an empty or over-limit thread before any dialog or draft', STEP, async () => {
    await desktop.goto(`${server.url}/#/drafts`);
    await waitForText(desktop, '#view-title', 'New draft');
    const draftsBefore = clean(await desktop.locator('#count-drafts').textContent());
    await desktop.locator('.actionbar button', { hasText: 'Publish now' }).click();
    await toastWith(desktop, 'Write something first.').waitFor();
    assert.equal(await desktop.locator('#dialog[open]').count(), 0, 'no confirm dialog for an empty thread');
    await desktop.waitForTimeout(AUTOSAVE_MS + 200);
    assert.equal(new URL(desktop.url()).hash, '#/drafts', 'no "Empty draft" was created for it');
    assert.equal(clean(await desktop.locator('#count-drafts').textContent()), draftsBefore);

    await desktop.locator('#cards .card textarea').first().fill('y'.repeat(295));
    await desktop.locator('.actionbar button', { hasText: 'Publish now' }).click();
    const problem = toastWith(desktop, 'Fix these first');
    await problem.waitFor();
    assert.equal(clean(await problem.textContent()), 'Fix these first • Post 1 is over the 280-character limit (295/280).');
    assert.equal(await desktop.locator('#dialog[open]').count(), 0, 'the limit is reported before the dialog, not after Publish');
    await desktop.locator('button[aria-label="Schedule"]').click();
    assert.equal(await desktop.locator('.popover').count(), 0, 'Schedule says the same instead of opening its popover');
  });

  it('saves an edit made while the thread is due before Snooze and before Mark as posted', STEP, async () => {
    const { now } = await api('/api/status');
    const draft = await createDraft(['H1', 'H2']);
    await api(`/api/drafts/${draft.id}/schedule`, { method: 'POST', body: { at: now, mode: 'manual' } });
    await server.scheduler.tick();
    assert.equal((await getDraft(draft.id)).status, 'due');
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await desktop.locator('#banner .banner.due').waitFor();
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);

    // Snooze inside the autosave debounce: the edit travels with the thread.
    await desktop.locator('#cards .card').nth(1).locator('textarea').fill('H2 fixed');
    await desktop.locator('#banner button', { hasText: 'Snooze to next free slot' }).click();
    await desktop.locator('#banner .banner.scheduled').waitFor();
    await toastWith(desktop, 'Snoozed until').waitFor();
    let saved = await getDraft(draft.id);
    assert.equal(saved.status, 'scheduled');
    assert.deepEqual(saved.tweets.map((t) => t.text), ['H1', 'H2 fixed']);

    // Due again: a typo fixed right before "Mark as posted" (what the stepper copied) reaches the record.
    const { now: later } = await api('/api/status');
    await api(`/api/drafts/${draft.id}/schedule`, { method: 'POST', body: { at: later, mode: 'manual' } });
    await server.scheduler.tick();
    await desktop.locator('#banner .banner.due').waitFor();
    await desktop.locator('#cards .card').first().locator('textarea').fill('H1 fixed typo');
    await desktop.locator('#banner button', { hasText: 'Mark as posted' }).click();
    const dialog = desktop.locator('#dialog[open]');
    await dialog.waitFor();
    await dialog.locator('button', { hasText: 'Mark as posted' }).click();
    await desktop.locator('#banner .banner.posted').waitFor();
    saved = await getDraft(draft.id);
    assert.equal(saved.status, 'posted');
    assert.deepEqual(saved.tweets.map((t) => t.text), ['H1 fixed typo', 'H2 fixed'], 'the edit was saved, not discarded');
    assert.deepEqual(await cardTexts(desktop), ['H1 fixed typo', 'H2 fixed'], 'and the read-only thread shows it');
    assert.equal(await desktop.locator('#cards textarea[readonly]').count(), 2);
  });

  it('keeps the due stepper and the post count in step with posts added or removed', STEP, async () => {
    const { now } = await api('/api/status');
    const draft = await createDraft(['S1', 'S2']);
    await api(`/api/drafts/${draft.id}/schedule`, { method: 'POST', body: { at: now, mode: 'manual' } });
    await server.scheduler.tick();
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await desktop.locator('#banner .banner.due').waitFor();
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    const stepper = desktop.locator('#banner .btn-primary');
    const count = desktop.locator('.actionbar .post-count');
    assert.equal(clean(await count.textContent()), '2 posts');
    await stepper.click();
    await waitForText(desktop, '#banner .btn-primary', 'Copy post 2 of 2');
    await stepper.click();
    await waitForText(desktop, '#banner .btn-primary', 'Copy post 1 of 2'); // wrapped around

    await desktop.locator('#add-post').click();
    await desktop.keyboard.type('S3');
    assert.equal(clean(await count.textContent()), '3 posts', 'the action bar counts the card just added');
    assert.equal(clean(await stepper.textContent()), 'Copy post 3 of 3', 'so does the stepper: posts 1 and 2 were copied, 3 is next');
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    assert.equal((await getDraft(draft.id)).tweets.length, 3);
    await desktop.waitForTimeout(200); // the save's own echo over SSE changes nothing
    assert.equal(clean(await stepper.textContent()), 'Copy post 3 of 3');
    await stepper.click();
    await toastWith(desktop, 'Copied post 3 of 3').waitFor();
    assert.equal(await desktop.evaluate(() => navigator.clipboard.readText()), 'S3');

    await desktop.locator('button[aria-label="Remove post 3"]').click();
    const dialog = desktop.locator('#dialog[open]');
    await dialog.waitFor();
    await dialog.locator('button', { hasText: 'Remove' }).click();
    await desktop.waitForFunction(() => document.querySelectorAll('#cards .card').length === 2);
    assert.equal(clean(await count.textContent()), '2 posts');
    assert.equal(clean(await stepper.textContent()), 'Copy post 2 of 2', 'the label follows the removal too');
  });

  it('pre-fills "Pick a time" with the top of the hour after next in the browser\'s zone, half-hour offsets included', STEP, async () => {
    const draft = await createDraft(['Round hours everywhere']);
    const at = Date.UTC(2026, 8, 7, 10, 15); // 15:45 IST, 16:00 NPT, 06:15 EDT
    const cases = [
      { timezoneId: 'Asia/Kolkata', min: '2026-09-07T15:45', value: '2026-09-07T17:00' },
      { timezoneId: 'Asia/Kathmandu', min: '2026-09-07T16:00', value: '2026-09-07T18:00' },
      { timezoneId: 'America/New_York', min: '2026-09-07T06:15', value: '2026-09-07T08:00' },
    ];
    for (const { timezoneId, min, value } of cases) {
      const { context, page } = await openPage(browser, { viewport: VIEWPORT, timezoneId }, errors, at);
      try {
        await page.goto(`${server.url}/#/draft/${draft.id}`);
        await waitForText(page, '.actionbar .save-status', /^Saved /);
        await page.locator('button[aria-label="Schedule"]').click();
        const input = page.locator('.popover form.schedule-form input[name="at"]');
        await input.waitFor();
        assert.equal(await input.getAttribute('min'), min, `${timezoneId}: the input is in the browser's zone`);
        assert.equal(await input.inputValue(), value, `${timezoneId}: the default is a round local hour`);
      } finally {
        await context.close();
      }
    }
  });

  it('lists drafts the server would refuse as disabled, with the reason, in "Schedule a draft here…"', STEP, async () => {
    const empty = await createDraft(['']);
    const over = await createDraft(['z'.repeat(295)]);
    const longTitle = 'A very long first line that goes on and on well past sixty characters, so the option must be cut short';
    const long = await createDraft([longTitle]);
    const ready = await createDraft(['Ready to go']);
    await desktop.goto(`${server.url}/#/queue`);
    const slot = desktop.locator('#view-queue li.entry:has(.entry-card.empty)').first();
    await slot.waitFor();
    const slotAt = new Date(await slot.locator('time').getAttribute('datetime')).getTime();
    await slot.locator('button', { hasText: 'Schedule a draft here…' }).click();
    const dialog = desktop.locator('#dialog[open]');
    await dialog.waitFor();
    const select = dialog.locator('select');
    const options = await select.locator('option').evaluateAll((nodes) => nodes.map((n) => ({ value: n.value, text: n.textContent, disabled: n.disabled })));
    const option = (id) => options.find((o) => o.value === id);
    assert.deepEqual(option(empty.id), { value: empty.id, text: '(empty draft) — 1 post — Post 1 is empty', disabled: true });
    assert.deepEqual(option(over.id), { value: over.id, text: `${'z'.repeat(59)}… — 1 post — Post 1 is over the 280-character limit (295/280)`, disabled: true });
    assert.deepEqual(option(long.id), { value: long.id, text: `${longTitle.slice(0, 59)}… — 1 post`, disabled: false });
    assert.deepEqual(option(ready.id), { value: ready.id, text: 'Ready to go — 1 post', disabled: false });
    assert.equal(option(await select.inputValue()).disabled, false, 'a draft that can be scheduled is preselected');

    await select.selectOption(ready.id);
    await dialog.locator('button', { hasText: 'Schedule' }).click();
    await toastWith(desktop, 'Scheduled for').waitFor();
    const scheduled = await getDraft(ready.id);
    assert.equal(scheduled.status, 'scheduled');
    assert.equal(scheduled.scheduledAt, slotAt);
    assert.equal((await getDraft(empty.id)).status, 'draft');
  });

  it('names the post a retry continues from, and leaves a failed thread one way to be re-sent', STEP, async () => {
    const draft = await createDraft(['Kept on X', 'FAIL', 'Later']);
    await api(`/api/drafts/${draft.id}/publish`, { method: 'POST' });
    const failed = await getDraft(draft.id);
    assert.equal(failed.result.tweetIds.length, 1);
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await desktop.locator('#banner .banner.failed').waitFor();
    assert.deepEqual((await desktop.locator('#banner .banner-actions button').allTextContents()).map(clean),
      ['Retry from post 2', 'Copy thread', 'Back to drafts']);
    const bar = desktop.locator('.actionbar button');
    assert.equal(await desktop.locator('.actionbar button[aria-label="Schedule retry"]').count(), 1, 'the bar queues the retry for later');
    assert.equal(await bar.filter({ hasText: /Publish now|Copy thread/ }).count(), 0, 'no second Publish now or Copy thread to choose between');
    assert.match(await desktop.locator('.actionbar button[aria-label="Schedule retry"]').getAttribute('title'), /continues from post 2/);

    await desktop.goto(`${server.url}/#/posted`);
    const item = desktop.locator('#view-posted .history li.entry-card', { hasText: 'Kept on X' });
    await item.waitFor();
    assert.equal(clean(await item.locator('button', { hasText: 'Retry' }).textContent()), 'Retry from post 2');

    // "Back to drafts" keeps post 1 on record, so Publish now says what it will and will not send.
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await desktop.locator('#banner button', { hasText: 'Back to drafts' }).click();
    await desktop.locator('#banner .banner.locked').waitFor();
    await desktop.locator('#cards .card').nth(1).locator('textarea').fill('Fixed');
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    await desktop.locator('.actionbar button', { hasText: 'Publish now' }).click();
    const dialog = desktop.locator('#dialog[open]');
    await dialog.waitFor();
    assert.equal(clean(await dialog.locator('p').textContent()),
      'Post 1 is already on X. The remaining 2 posts will be posted through the API right away, continuing that thread from post 2.');
    await dialog.locator('button', { hasText: 'Publish' }).click();
    await desktop.locator('#banner .banner.posted').waitFor();
    const posted = await getDraft(draft.id);
    assert.equal(posted.status, 'posted');
    assert.equal(posted.result.tweetIds.length, 3);
    assert.equal(posted.result.tweetIds[0], failed.result.tweetIds[0], 'post 1 was not posted a second time');
    assert.deepEqual(posted.tweets.map((t) => t.text), ['Kept on X', 'Fixed', 'Later']);
  });

  it('says "tap" instead of naming Esc or Ctrl+Enter on a touch screen', STEP, async () => {
    const draft = await createDraft(['Touch hints']);
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    assert.equal(clean(await desktop.locator('.add-post-hint').innerText()), 'or type --- on its own line · Ctrl/Cmd+Enter adds the thread to the queue');

    // A touch page of its own (the shared phone page is first loaded later, after the publish tests' SSE toasts).
    const { context, page: touch } = await openPage(browser, { viewport: PHONE_VIEWPORT, isMobile: true, hasTouch: true }, errors);
    try {
      await touch.goto(`${server.url}/#/draft/${draft.id}`);
      await waitForText(touch, '.actionbar .save-status', /^Saved /);
      assert.equal(await touch.evaluate(() => matchMedia('(pointer: coarse)').matches), true, 'the touch context has a coarse pointer');
      assert.equal(clean(await touch.locator('.add-post-hint').innerText()), 'or type --- on its own line', 'no Ctrl+Enter on a phone');
      await touch.locator('#focus-btn').tap();
      await touch.waitForSelector('body.focus');
      const indicator = touch.locator('#focus-indicator');
      assert.match(clean(await indicator.textContent()), /^Saved .* · Tap to exit$/);
      assert.equal(await indicator.getAttribute('title'), 'Leave focus mode');
      await indicator.tap();
      await touch.waitForSelector('body:not(.focus)');
      assert.equal(await touch.evaluate(() => localStorage.getItem('otf.focus')), '0');
    } finally {
      await context.close();
    }
  });

  it('keeps the post count on one line and the whole reason readable when a save is refused', STEP, async () => {
    const draft = await createDraft(['Refused save']);
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    const reason = 'Post 1 is already on X and cannot be changed — duplicate the draft to rewrite them.';
    const url = `**/api/drafts/${draft.id}`;
    await desktop.route(url, (route) => (route.request().method() === 'PUT'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: reason }) })
      : route.continue()));
    const errorsBefore = errors.length;
    try {
      await desktop.locator('#cards .card textarea').first().fill('Refused save, edited');
      await waitForText(desktop, '.actionbar .save-status', `Not saved — ${reason}`);
      const status = desktop.locator('.actionbar .save-status');
      const metrics = await status.evaluate((n) => ({
        title: n.title, scrollWidth: n.scrollWidth, clientWidth: n.clientWidth, scrollHeight: n.scrollHeight, clientHeight: n.clientHeight,
      }));
      assert.equal(metrics.title, `Not saved — ${reason}`, 'the full text is there to hover');
      assert.ok(metrics.scrollWidth <= metrics.clientWidth && metrics.scrollHeight <= metrics.clientHeight, `the reason is cut off: ${JSON.stringify(metrics)}`);
      const count = await box(desktop.locator('.actionbar .post-count'));
      assert.ok(count.height < 24, `"1 post" wraps onto two lines (${count.height}px)`);
      assert.equal(clean(await desktop.locator('.actionbar .post-count').textContent()), '1 post');
      for (const button of await desktop.locator('.actionbar button').all()) {
        const rect = await box(button);
        assert.ok(rect.x >= 0 && rect.right <= VIEWPORT.width, `"${clean(await button.textContent())}" spans ${rect.x}..${rect.right}`);
      }
    } finally {
      await desktop.unroute(url);
      // Chromium logs the refused PUT as a console error; that refusal is the point of the test.
      errors.splice(errorsBefore, errors.length - errorsBefore,
        ...errors.slice(errorsBefore).filter((line) => !(line.includes('400') && line.includes(`/api/drafts/${draft.id}`))));
    }
    // Once the server takes the save again, the bar goes back to a plain status.
    await desktop.locator('#cards .card textarea').first().fill('Refused save, then saved');
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    assert.equal(await desktop.locator('.actionbar .save-status').getAttribute('title'), '');
    assert.equal((await getDraft(draft.id)).tweets[0].text, 'Refused save, then saved');
  });

  it('keeps the "Remove post" ✕ in view, at a finger\'s size, on a touch screen', STEP, async () => {
    const draft = await createDraft(['T1', 'T2', 'T3']);
    // With a mouse the ✕ still waits for a hover or the caret, as before.
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await desktop.locator('#cards .card').nth(2).waitFor();
    await desktop.mouse.move(VIEWPORT.width - 10, VIEWPORT.height - 10);
    await desktop.evaluate(() => document.activeElement?.blur());
    await desktop.waitForFunction(() => Array.from(document.querySelectorAll('#cards .card-remove')).every((n) => getComputedStyle(n).opacity === '0'));

    const { context, page: touch } = await openPage(browser, { viewport: PHONE_VIEWPORT, isMobile: true, hasTouch: true }, errors);
    try {
      await touch.goto(`${server.url}/#/draft/${draft.id}`);
      await touch.locator('#cards .card').nth(2).waitFor();
      await waitForText(touch, '.actionbar .save-status', /^Saved /);
      await touch.evaluate(() => document.activeElement?.blur());
      const removes = touch.locator('#cards .card .card-remove');
      assert.equal(await removes.count(), 3);
      for (const [i, node] of (await removes.all()).entries()) {
        assert.equal(await node.evaluate((n) => getComputedStyle(n).opacity), '1', `card ${i + 1}: the ✕ shows without a tap`);
        const rect = await box(node);
        assert.ok(rect.width >= 32 && rect.height >= 32, `card ${i + 1}: the ✕ is ${rect.width}×${rect.height}, too small for a finger`);
        assert.ok(rect.right <= PHONE_VIEWPORT.width, `card ${i + 1}: the ✕ ends at ${rect.right}`);
      }
      await touch.locator('button[aria-label="Remove post 2"]').tap();
      const dialog = touch.locator('#dialog[open]');
      await dialog.waitFor();
      await dialog.locator('button', { hasText: 'Remove' }).click();
      await touch.waitForFunction(() => document.querySelectorAll('#cards .card').length === 2);
      assert.deepEqual(await cardTexts(touch), ['T1', 'T3']);
      await waitUntil(async () => (await getDraft(draft.id)).tweets.length === 2, 'the removal was saved');
    } finally {
      await context.close();
    }
  });

  it('announces each thread a tick posts once, whatever other toasts land in between', STEP, async () => {
    const { now } = await api('/api/status');
    // An API item already overdue but not yet claimed: the tick Publish now triggers posts it too.
    const overdue = await createDraft(['Overdue API item']);
    await api(`/api/drafts/${overdue.id}/schedule`, { method: 'POST', body: { at: now - 30_000, mode: 'api' } });
    const draft = await createDraft(['Publish now item']);
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    await desktop.evaluate(() => document.getElementById('toasts').replaceChildren());
    await desktop.locator('.actionbar button', { hasText: 'Publish now' }).click();
    const dialog = desktop.locator('#dialog[open]');
    await dialog.waitFor();
    await dialog.locator('button', { hasText: 'Publish' }).click();
    await desktop.locator('#banner .banner.posted').waitFor();
    await waitUntil(async () => (await getDraft(overdue.id)).status === 'posted', 'the tick posted the overdue item as well');
    await desktop.waitForTimeout(300); // the response and both "posted" events are in, in whichever order
    const posted = desktop.locator('#toasts .toast', { hasText: /^Posted to X:/ });
    assert.equal(await toastWith(desktop, 'Posted to X: Overdue API item').count(), 1);
    assert.equal(await toastWith(desktop, 'Posted to X: Publish now item').count(), 1, 'the response and the event collapse into one toast');
    assert.equal(await posted.count(), 2);

    // The same rule for any repeated message: a toast still on screen is reused, wherever it sits in the stack.
    await desktop.evaluate(() => document.getElementById('toasts').replaceChildren());
    await desktop.locator('button[aria-label="Copy the whole thread to the clipboard"]').click();
    await toastWith(desktop, 'Thread copied (1 post)').waitFor();
    await desktop.locator('#banner button', { hasText: 'Duplicate' }).click();
    await toastWith(desktop, 'Duplicated — you are now editing the copy.').waitFor();
    await desktop.waitForURL((url) => url.hash.startsWith('#/draft/') && !url.hash.endsWith(draft.id));
    await desktop.locator('button[aria-label="Copy the whole thread to the clipboard"]').click();
    await desktop.waitForTimeout(100);
    assert.deepEqual((await desktop.locator('#toasts .toast').allTextContents()).map(clean),
      ['Thread copied (1 post)', 'Duplicated — you are now editing the copy.'], 'the second copy restarted the first toast instead of stacking a third');
  });

  it('keeps an image whose upload finishes after the user opened another draft', STEP, async () => {
    const target = await createDraft(['Slow image lands here']);
    const other = await createDraft(['The draft opened meanwhile']);
    await desktop.goto(`${server.url}/#/draft/${target.id}`);
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    await desktop.evaluate(() => document.getElementById('toasts').replaceChildren()); // the previous test's error toast lives 7 s
    await desktop.route('**/api/media', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    try {
      const [chooser] = await Promise.all([
        desktop.waitForEvent('filechooser'),
        desktop.locator('button[aria-label="Add image to post 1"]').click(),
      ]);
      await chooser.setFiles({ name: 'slow.png', mimeType: 'image/png', buffer: makePng(PNG_SIZE, [10, 160, 90]) });
      await desktop.locator('#cards .card .thumb.pending').waitFor();
      await desktop.locator('#sidebar-list .row', { hasText: 'The draft opened meanwhile' }).click();
      await desktop.waitForURL(`${server.url}/#/draft/${other.id}`);

      await waitUntil(async () => (await getDraft(target.id)).tweets[0].media.length === 1, 'the image reached the draft it was added to');
      const [media] = (await getDraft(target.id)).tweets[0].media;
      assert.equal((await fetch(server.url + media.url)).status, 200, 'the uploaded file was kept');
      assert.deepEqual(await cardTexts(desktop), ['The draft opened meanwhile'], 'the editor stayed on the draft the user opened');
      assert.equal(await desktop.locator('#cards .card .thumb').count(), 0);
      assert.equal((await getDraft(other.id)).tweets[0].media.length, 0);
      assert.equal(await desktop.locator('#toasts .toast.error').count(), 0, 'nothing failed along the way');
    } finally {
      await desktop.unroute('**/api/media');
    }
  });

  it('keeps the caret when the open draft is updated by another client', STEP, async () => {
    const draft = await createDraft(['Sixteen chars!!!']);
    await desktop.goto(`${server.url}/#/draft/${draft.id}`);
    await waitForText(desktop, '.actionbar .save-status', /^Saved /);
    await desktop.locator('#cards .card textarea').first().click();
    await desktop.keyboard.press('End');
    assert.equal(await focusedCard(desktop), '1/1:16');

    await api(`/api/drafts/${draft.id}`, { method: 'PUT', body: { tweets: [{ text: 'Edited elsewhere', media: [] }] } });
    await desktop.waitForFunction(() => document.querySelector('#cards .card textarea')?.value === 'Edited elsewhere');
    assert.equal(await focusedCard(desktop), '1/1:16', 'the caret is still in the (replaced) card');
    await desktop.keyboard.type('!');
    assert.deepEqual(await cardTexts(desktop), ['Edited elsewhere!'], 'typing goes on where it left off');
  });

  it('splits a multi-line insertText or fill once, not once per input event', STEP, async () => {
    await desktop.goto(`${server.url}/#/drafts`);
    await waitForText(desktop, '#view-title', 'New draft');
    await desktop.locator('#cards .card textarea').first().click();
    await desktop.keyboard.insertText('W1\n---\nW2'); // Chromium fires several input events, most on the detached textarea
    await desktop.waitForFunction(() => document.querySelectorAll('#cards .card').length >= 2);
    await desktop.waitForTimeout(100);
    assert.deepEqual(await cardTexts(desktop), ['W1', 'W2']);
    assert.equal(await focusedCard(desktop), '2/2:0');

    await desktop.locator('#cards .card').nth(1).locator('textarea').fill('A\n---\nB');
    await desktop.waitForTimeout(100);
    assert.deepEqual(await cardTexts(desktop), ['W1', 'A', 'B']);
    await waitUntil(async () => (await draftWithText('W1'))?.tweets.length === 3, 'the three cards were saved');
  });

  it('explains the notification permission when a reminder is scheduled, and offers to enable it', STEP, async () => {
    const { now } = await api('/api/status');
    const draft = await createDraft(['Remind me later']);
    const { context, page } = await openPage(browser, { viewport: VIEWPORT }, errors);
    try {
      await context.addInitScript(fakeNotificationScript('default'));
      await page.goto(`${server.url}/#/draft/${draft.id}`);
      await waitForText(page, '.actionbar .save-status', /^Saved /);
      assert.equal(await page.locator('#notif-btn').isVisible(), true);
      assert.equal(await page.locator('#notif-note').isHidden(), true);

      await page.locator('button[aria-label="Schedule"]').click();
      const form = page.locator('.popover form.schedule-form');
      await form.waitFor();
      await form.locator('input[name="mode"][value="manual"]').check();
      assert.match(clean(await form.locator('label.choice:has(input[value="manual"]) small').textContent()), /enable notifications/i);
      await form.locator('button[type="submit"]').click();

      await page.locator('#banner .banner.scheduled').waitFor();
      assert.equal(await page.evaluate(() => window.__notifications.requests), 0, 'nothing is requested behind the user\'s back');
      await page.locator('#toasts .toast', { hasText: 'Enable notifications to be alerted at that time — see the banner above.' }).waitFor();
      assert.match(clean(await page.locator('#banner .banner-sub').textContent()), /^Enable notifications to be alerted at that time/);
      const enable = page.locator('#banner button', { hasText: 'Enable notifications' });
      assert.equal(await enable.isVisible(), true, 'the banner offers to enable them');
      // Three buttons beside the text: the title still reads on one line, the mode as a badge, no orphaned "reminder".
      assert.equal(await page.locator('#banner .banner-actions button').count(), 3);
      const title = page.locator('#banner .banner-title');
      assert.match(clean(await title.textContent()), /^Scheduled for \w{3}, Sep \d+ · \d+:\d\d [AP]M Reminder$/); // whichever slot is next free
      const titleBox = await title.boundingBox();
      assert.ok(titleBox.height < 30, `the banner title wraps onto two lines (${titleBox.height}px tall)`);
      const badgeBox = await title.locator('.badge').boundingBox();
      assert.ok(badgeBox.y < titleBox.y + titleBox.height / 2, 'the mode badge sits on the title\'s line');

      // The footer's "Enable notifications" and the Focus toggle are bordered controls, not caption-like ghost text.
      for (const selector of ['#notif-btn', '#focus-btn']) {
        const style = await page.locator(selector).evaluate((n) => {
          const s = getComputedStyle(n);
          return { border: s.borderTopColor, borderWidth: s.borderTopWidth, background: s.backgroundColor };
        });
        assert.ok(parseColor(style.border)[3] > 0 && style.borderWidth !== '0px', `${selector} has no visible border: ${JSON.stringify(style)}`);
        assert.ok(parseColor(style.background)[3] > 0, `${selector} is transparent: ${JSON.stringify(style)}`);
        assert.equal(await page.locator(`${selector} svg`).count(), 1, `${selector} carries a glyph`);
      }
      const footWidth = (await page.locator('.sidebar-foot').boundingBox()).width;
      const notifWidth = (await page.locator('#notif-btn').boundingBox()).width;
      assert.ok(notifWidth >= footWidth - 40, `the footer button spans the footer (${notifWidth} of ${footWidth}px)`);

      await enable.click();
      await page.locator('#toasts .toast', { hasText: 'Notifications enabled.' }).waitFor();
      assert.equal(await page.evaluate(() => window.__notifications.requests), 1);
      await enable.waitFor({ state: 'detached' });
      assert.match(clean(await page.locator('#banner .banner-sub').textContent()), /^A browser notification will pop up at that time/);
      assert.equal(await page.locator('#notif-btn').isHidden(), true, 'hidden once granted');
      assert.equal(await page.locator('#notif-note').isHidden(), true);

      // The reminder now reaches the notification API as well as the tab.
      await api(`/api/drafts/${draft.id}/schedule`, { method: 'POST', body: { at: now, mode: 'manual' } });
      await page.locator('#banner .banner.scheduled').waitFor();
      await server.scheduler.tick();
      await page.locator('#banner .banner.due').waitFor();
      await waitUntil(() => page.evaluate(() => window.__notifications.shown.length === 1), 'a Notification was created');
      const shown = await page.evaluate(() => window.__notifications.shown[0]);
      assert.equal(shown.title, 'Time to post');
      assert.equal(shown.tag, draft.id);
      assert.equal(shown.requireInteraction, true);
    } finally {
      await context.close();
    }

    // Blocked: a plain note (not a disabled button) in the footer, and the banner and toast say so.
    const blocked = await createDraft(['Remind me, blocked']);
    const { context: context2, page: page2 } = await openPage(browser, { viewport: VIEWPORT }, errors);
    try {
      await context2.addInitScript(fakeNotificationScript('denied'));
      await page2.goto(`${server.url}/#/draft/${blocked.id}`);
      await waitForText(page2, '.actionbar .save-status', /^Saved /);
      assert.equal(await page2.locator('#notif-btn').isHidden(), true);
      assert.equal(await page2.locator('.sidebar-foot button[disabled]').count(), 0, 'no disabled ghost button');
      assert.match(clean(await page2.locator('#notif-note').textContent()), /^Notifications are blocked for this site/);

      await page2.locator('button[aria-label="Schedule"]').click();
      const form = page2.locator('.popover form.schedule-form');
      await form.waitFor();
      await form.locator('input[name="mode"][value="manual"]').check();
      await form.locator('button[type="submit"]').click();
      await page2.locator('#banner .banner.scheduled').waitFor();
      await page2.locator('#toasts .toast', { hasText: 'Notifications are off in this browser' }).waitFor();
      assert.match(clean(await page2.locator('#banner .banner-sub').textContent()), /^Notifications are blocked for this site/);
      assert.equal(await page2.locator('#banner button', { hasText: 'Enable notifications' }).count(), 0);
      assert.equal(await page2.evaluate(() => window.__notifications.requests), 0);
    } finally {
      await context2.close();
    }
  });

  it('renders secondary text at AA contrast in both themes', STEP, async () => {
    const draft = await createDraft(THREAD);
    for (const scheme of ['light', 'dark']) {
      // One context per scheme, as a user gets it: flipping a live page's scheme leaves some of
      // Chromium's computed var() colours one switch behind, which would only test the switch.
      const { context, page } = await openPage(browser, { viewport: VIEWPORT, colorScheme: scheme }, errors);
      try {
        await page.goto(`${server.url}/#/draft/${draft.id}`);
        await page.locator('#cards .card').nth(2).waitFor();
        await waitForText(page, '.actionbar .save-status', /^Saved /);
        await page.locator('button[aria-label="Schedule"]').click();
        await page.locator('.popover form.schedule-form').waitFor();
        const samples = await page.evaluate(() => {
          const style = (selector, pseudo) => getComputedStyle(document.querySelector(selector), pseudo);
          const probe = document.createElement('button'); // a disabled .btn, like the "notifications blocked" one
          probe.className = 'btn btn-ghost btn-sm';
          probe.disabled = true;
          probe.textContent = 'Notifications blocked in browser settings';
          document.querySelector('.sidebar-foot').append(probe);
          const pairs = [
            ['counter label', '.card .counter-label', null, '.card'],
            ['card index', '.card .index', null, '.card'],
            ['textarea placeholder', '.card textarea', '::placeholder', '.card'],
            ['save status', '.actionbar .save-status', null, 'body'],
            ['post count', '.actionbar-left > span:last-child', null, 'body'],
            ['sidebar row meta', '#sidebar-list .row.active .row-meta', null, '#sidebar-list .row.active', '.sidebar'],
            ['timezone', '#tz-label', null, '.sidebar'],
            ['popover legend', '.schedule-form legend', null, '.popover'],
            ['popover hint', '.schedule-form .choice small', null, '.popover'],
            ['disabled button text', '.sidebar-foot button[disabled]', null, '.sidebar'],
          ];
          const out = pairs.map(([name, sel, pseudo, backdrop, under]) => ({
            name,
            fg: style(sel, pseudo).color,
            bg: style(backdrop).backgroundColor,
            under: under ? style(under).backgroundColor : null,
          }));
          probe.remove();
          return {
            text: out,
            ring: [style('.counter .ring-track').stroke, style('.card').backgroundColor],
          };
        });
        for (const { name, fg, bg, under } of samples.text) {
          const backdrop = under ? composite(parseColor(bg), parseColor(under)) : parseColor(bg);
          assert.equal(backdrop[3], 1, `${name}: opaque backdrop`);
          const ratio = contrastRatio(parseColor(fg), backdrop);
          assert.ok(ratio >= 4.5, `${scheme} ${name}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below AA 4.5:1`);
        }
        const trackRatio = contrastRatio(parseColor(samples.ring[0]), parseColor(samples.ring[1]));
        assert.ok(trackRatio >= 3, `${scheme} ring track ${samples.ring[0]} on ${samples.ring[1]} is ${trackRatio.toFixed(2)}:1, below 3:1`);
      } finally {
        await context.close();
      }
    }
  });

  it('keeps queue cards inside a phone-sized viewport and truncates long titles', STEP, async () => {
    const long = await createDraft(['A first line that is much longer than a phone screen is wide, to make the queue card overflow']);
    await api(`/api/drafts/${long.id}/schedule`, { method: 'POST', body: { nextFree: true, mode: 'api' } });
    await phone.goto(`${server.url}/#/queue`);
    const card = phone.locator('#view-queue .entry-card', { hasText: 'A first line' });
    await card.waitFor();
    const cardBox = await box(card);
    assert.ok(cardBox.right <= PHONE_VIEWPORT.width, `the card ends at ${cardBox.right}, past the ${PHONE_VIEWPORT.width}px viewport`);
    const main = await phone.locator('#main').evaluate((n) => ({ scrollWidth: n.scrollWidth, clientWidth: n.clientWidth }));
    assert.ok(main.scrollWidth <= main.clientWidth, `the main pane scrolls sideways (${main.scrollWidth} > ${main.clientWidth})`);
    assert.ok(await card.locator('.entry-title').evaluate((n) => n.scrollWidth > n.clientWidth), 'the title is truncated with an ellipsis');
    const del = await box(card.locator('button', { hasText: 'Delete' }));
    assert.ok(del.right <= PHONE_VIEWPORT.width, `Delete ends at ${del.right}: unreachable without sideways scrolling`);
  });

  it('keeps every action-bar button on a phone screen with the save status readable', STEP, async () => {
    const draft = await createDraft(THREAD);
    await phone.goto(`${server.url}/#/draft/${draft.id}`);
    await phone.locator('#cards .card').nth(2).waitFor();
    await waitForText(phone, '.actionbar .save-status', /^Saved /);
    const buttons = phone.locator('.actionbar button');
    const labels = (await buttons.allTextContents()).map(clean);
    assert.ok(labels.includes('Publish now') && labels.includes('⋯'), `configured mode shows all four buttons: ${labels}`);
    for (const button of await buttons.all()) {
      const rect = await box(button);
      assert.ok(rect.x >= 0 && rect.right <= PHONE_VIEWPORT.width, `"${clean(await button.textContent())}" spans ${rect.x}..${rect.right}`);
    }
    const inner = await phone.locator('.actionbar-inner').evaluate((n) => ({ scrollWidth: n.scrollWidth, clientWidth: n.clientWidth }));
    assert.ok(inner.scrollWidth <= inner.clientWidth, `the action bar overflows (${inner.scrollWidth} > ${inner.clientWidth})`);
    const status = await phone.locator('.actionbar .save-status').evaluate((n) => ({ text: n.textContent, scrollWidth: n.scrollWidth, clientWidth: n.clientWidth }));
    assert.ok(status.clientWidth >= status.scrollWidth, `the save status is cut off: ${JSON.stringify(status)}`);
    const count = await box(phone.locator('.actionbar-left > span:last-child'));
    assert.ok(count.height < 24, `"3 posts" wraps onto two lines (${count.height}px)`);
  });

  it('stacks toasts above the action bar without swallowing taps, one per distinct message', STEP, async () => {
    const copy = phone.locator('button[aria-label="Copy the whole thread to the clipboard"]');
    for (let i = 0; i < 3; i += 1) await copy.click();
    const toasts = phone.locator('#toasts .toast');
    await toasts.first().waitFor();
    assert.equal(await toasts.count(), 1, `repeated identical messages collapse into one toast: ${JSON.stringify(await toasts.allTextContents())}`);
    assert.equal(clean(await toasts.first().textContent()), 'Thread copied (3 posts)');
    const toastBox = await box(toasts.first());
    const barBox = await box(phone.locator('#actionbar'));
    assert.ok(toastBox.bottom <= barBox.y, `the toast (${toastBox.y}..${toastBox.bottom}) covers the action bar (top ${barBox.y})`);

    const schedule = phone.locator('button[aria-label="Schedule"]');
    const s = await box(schedule);
    const centre = [s.x + s.width / 2, s.y + s.height / 2];
    const hit = await phone.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null, centre);
    assert.equal(hit, 'Schedule', 'a tap on Schedule reaches the button while the toast shows');
    await phone.mouse.click(centre[0], centre[1]);
    await phone.locator('.popover form.schedule-form').waitFor();
    await phone.keyboard.press('Escape');
    await phone.locator('.popover').waitFor({ state: 'detached' });
  });

  it('keeps each card footer on one row on a phone while the thread is due', STEP, async () => {
    const draft = await createDraft(['Due on a phone: the first post', 'Second post', 'Third post']);
    const { now } = await api('/api/status');
    await api(`/api/drafts/${draft.id}/schedule`, { method: 'POST', body: { at: now, mode: 'manual' } });
    await server.scheduler.tick();
    assert.equal((await getDraft(draft.id)).status, 'due');

    await phone.goto(`${server.url}/#/draft/${draft.id}`);
    await phone.locator('#banner .banner.due').waitFor();
    await phone.locator('#cards .card').nth(2).waitFor();
    const feet = await phone.locator('#cards .card').evaluateAll((cards) => cards.map((card) => {
      const lineBoxes = (node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getClientRects().length;
      };
      const foot = card.querySelector('.card-foot').getBoundingClientRect();
      return {
        tools: Array.from(card.querySelectorAll('.card-tools .tool'), (tool) => tool.getAttribute('aria-label')),
        height: foot.height,
        right: foot.right,
        counter: card.querySelector('.counter-label').textContent,
        counterLines: lineBoxes(card.querySelector('.counter-label')),
      };
    }));
    assert.equal(feet.length, 3);
    feet.forEach((foot, i) => {
      assert.deepEqual(foot.tools, [`Add image to post ${i + 1}`, `Move post ${i + 1} up`, `Move post ${i + 1} down`, `Copy post ${i + 1}`]);
      assert.ok(foot.height <= 30, `card ${i + 1}: the footer is ${foot.height}px tall, so something wrapped`);
      assert.equal(foot.counterLines, 1, `card ${i + 1}: the counter "${foot.counter}" wrapped onto ${foot.counterLines} lines`);
      assert.match(foot.counter, /^\d+ \/ 280$/);
      assert.ok(foot.right <= PHONE_VIEWPORT.width, `card ${i + 1}: the footer ends at ${foot.right}`);
    });
  });

  it('lists a due or overdue item once, under "Needs attention", and flags it in the sidebar', STEP, async () => {
    const { now } = await api('/api/status');
    const due = await createDraft(['Due reminder, still not posted']);
    await api(`/api/drafts/${due.id}/schedule`, { method: 'POST', body: { at: now, mode: 'manual' } });
    await server.scheduler.tick();
    assert.equal((await getDraft(due.id)).status, 'due');
    // Scheduled, and its time passed without a scheduler tick (a long interval, a stale tab).
    const overdue = await createDraft(['Overdue reminder nobody ticked']);
    await api(`/api/drafts/${overdue.id}/schedule`, { method: 'POST', body: { at: now + 60_000, mode: 'manual' } });
    assert.equal((await getDraft(overdue.id)).status, 'scheduled');

    // A tab left open overnight: its clock is 26 hours past the server's.
    const { context, page } = await openPage(browser, { viewport: VIEWPORT }, errors, T0 + 26 * 3_600_000);
    try {
      await page.goto(`${server.url}/#/queue`);
      const attention = page.locator('#view-queue .attention');
      await attention.waitFor();
      for (const text of ['Due reminder, still not posted', 'Overdue reminder nobody ticked']) {
        assert.equal(await attention.locator('.entry-card', { hasText: text }).count(), 1, `"${text}" is in the box`);
        assert.equal(await page.locator('#view-queue .entry-card', { hasText: text }).count(), 1, `"${text}" is listed once, not in its day as well`);
      }
      const meta = async (text) => clean(await attention.locator('.entry-card', { hasText: text }).locator('.entry-meta').textContent());
      assert.match(await meta('Due reminder, still not posted'), /Due/);
      assert.match(await meta('Overdue reminder nobody ticked'), /Overdue/);
      // Outside its day group an entry carries its date, not just a time.
      const when = async (text) => clean(await attention.locator('li.entry', { hasText: text }).locator('time').textContent());
      assert.match(await when('Due reminder, still not posted'), /^Mon, Sep 7 12:0\d PM$/);
      assert.match(await when('Overdue reminder nobody ticked'), /^Mon, Sep 7 12:0\d PM$/);
      // As many cards as the sidebar counts queued items: nothing is shown twice.
      const cards = await page.locator('#view-queue .entry-card:not(.empty)').count();
      assert.equal(String(cards), clean(await page.locator('#count-queue').textContent()));

      const row = (text) => page.locator('#sidebar-list .row', { hasText: text }).locator('.badge');
      assert.equal(clean(await row('Overdue reminder nobody ticked').textContent()), 'Overdue');
      assert.ok(await row('Overdue reminder nobody ticked').evaluate((n) => n.classList.contains('warn')), 'amber, not the calm blue of a future time');
      assert.equal(clean(await row('Due reminder, still not posted').textContent()), 'Due');

      // The box exists to get a due reminder done: its card offers "Mark as posted" (an item that is
      // merely overdue, not due yet, does not — the scheduler has not handed it over).
      const dueCard = attention.locator('.entry-card', { hasText: 'Due reminder, still not posted' });
      const overdueCard = attention.locator('.entry-card', { hasText: 'Overdue reminder nobody ticked' });
      assert.equal(await overdueCard.locator('button', { hasText: 'Mark as posted' }).count(), 0);
      assert.deepEqual((await dueCard.locator('.entry-actions button').allTextContents()).map(clean),
        ['Open', 'Mark as posted', 'Reschedule', 'Unschedule', 'Copy', 'Delete']);
      await dueCard.locator('button', { hasText: 'Mark as posted' }).click();
      const dialog = page.locator('#dialog[open]');
      await dialog.waitFor();
      await dialog.locator('button', { hasText: 'Mark as posted' }).click();
      await toastWith(page, 'Marked as posted.').waitFor();
      await dueCard.waitFor({ state: 'detached' });
      assert.equal((await getDraft(due.id)).status, 'posted');
      assert.equal(await page.locator('#view-queue .entry-card', { hasText: 'Due reminder, still not posted' }).count(), 0, 'it left the queue');
      assert.equal(await overdueCard.count(), 1, 'the overdue item is still waiting');
    } finally {
      await context.close();
    }
  });

  it('catches up the open draft and its reminder once the event stream reconnects', STEP, async () => {
    const { now } = await api('/api/status');
    const draft = await createDraft(['Reminder during an outage']);
    await api(`/api/drafts/${draft.id}/schedule`, { method: 'POST', body: { at: now, mode: 'manual' } });
    const { context, page } = await openPage(browser, { viewport: VIEWPORT }, errors);
    const errorsBefore = errors.length;
    try {
      await page.goto(`${server.url}/#/draft/${draft.id}`);
      await page.locator('#banner .banner.scheduled').waitFor();
      // The stream drops and cannot come back for a while; the reminder fires meanwhile and nothing replays it.
      await page.route('**/api/events', (route) => route.abort());
      server.server.closeAllConnections();
      await waitUntil(() => server.events.clientCount() === 0, 'every stream is down');
      await server.scheduler.tick();
      assert.equal((await getDraft(draft.id)).status, 'due');
      await page.waitForTimeout(500);
      assert.equal(await page.locator('#banner .banner.due').count(), 0, 'nothing reached the tab while the stream was down');
      assert.match(clean(await page.locator('#banner .banner-title').textContent()), new RegExp(`^Scheduled for ${TODAY_LABEL} · 12:0\\d PM Reminder$`));

      await page.unroute('**/api/events');
      await page.locator('#banner .banner.due').waitFor({ timeout: 20_000 }); // the browser retries after ~3 s
      await toastWith(page, 'Time to post: Reminder during an outage').waitFor();
      await waitForText(page, '#view-title', 'Time to post');
      assert.equal(clean(await page.locator('#banner .btn-primary').textContent()), 'Copy post 1 of 1');
      assert.equal(clean(await page.locator('#sidebar-list .row.active .badge').textContent()), 'Due');
    } finally {
      await context.close();
      // Cutting the streams (every open page's) is logged by Chromium as failed loads of /api/events: that is the outage under test.
      const cut = errors.slice(errorsBefore).filter((line) => line.includes('/api/events'));
      assert.ok(cut.length > 0, 'the browser saw its stream cut');
      errors.splice(errorsBefore, errors.length - errorsBefore, ...errors.slice(errorsBefore).filter((line) => !line.includes('/api/events')));
    }
  });

  it('labels the next calendar day "Tomorrow" across a DST change', STEP, async () => {
    // America/New_York: Sat Mar 7 2026 23:30 EST (Sunday is a 23-hour day) and Sun Nov 1 2026 00:30 EDT (a 25-hour day).
    const cases = [
      { name: 'spring forward', at: Date.UTC(2026, 2, 8, 4, 30), heads: ['Today · Sat, Mar 7', 'Tomorrow · Sun, Mar 8', 'Mon, Mar 9'] },
      { name: 'fall back', at: Date.UTC(2026, 10, 1, 4, 30), heads: ['Today · Sun, Nov 1', 'Tomorrow · Mon, Nov 2', 'Tue, Nov 3'] },
    ];
    let clock = cases[0].at;
    const dst = await startServer({
      env: {},
      xClient: null,
      config: { ...TEST_CONFIG, timezone: 'America/New_York' },
      now: () => clock,
      logger: silentLogger,
    });
    try {
      for (const { name, at, heads } of cases) {
        clock = at;
        const { context, page } = await openPage(browser, { viewport: VIEWPORT, timezoneId: 'America/New_York' }, errors, at);
        try {
          await page.goto(`${dst.url}/#/queue`);
          await page.locator('#view-queue section.day').nth(2).waitFor();
          const rendered = (await page.locator('#view-queue .day-head').allTextContents()).map(clean);
          assert.deepEqual(rendered.slice(0, 3), heads, name);
        } finally {
          await context.close();
        }
      }
    } finally {
      await dst.close();
    }
  });

  it('logged no console errors, page errors or native dialogs', () => {
    assert.deepEqual(errors, []);
  });
});

/**
 * o_typefully front end.
 *
 * A single vanilla ES module (no build step, no framework). It talks to the
 * JSON API under /api, listens to /api/events (SSE) for live updates, and
 * renders three views: the editor (one draft as a stack of post cards), the
 * queue calendar, and the posted history.
 *
 * Structure: constants → state → DOM/format helpers → API client →
 * toasts/dialogs/popovers → sidebar → editor → queue view → posted view →
 * live updates & notifications → routing, shortcuts and boot.
 *
 * User text is only ever rendered through text nodes / textContent — innerHTML
 * is never used, so nothing needs HTML-escaping.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = '/api';
const MAX_LEN = 280;
const WARN_AT = 260;
const MAX_MEDIA = 4;
const MAX_POSTS = 25;
const AUTOSAVE_MS = 600;
const SAFETY_NET_MS = 60_000;
const RELATIVE_TICK_MS = 30_000;
const REFRESH_COALESCE_MS = 200;
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const QUEUE_STATUSES = ['scheduled', 'publishing', 'due'];
const TAB_STATUSES = { drafts: ['draft'], queue: QUEUE_STATUSES, posted: ['posted', 'failed'] };
const READ_ONLY_STATUSES = ['posted', 'publishing'];
const SCHEDULABLE_STATUSES = ['draft', 'scheduled', 'due', 'failed'];
const STORAGE_KEYS = { focus: 'otf.focus', route: 'otf.route', sidebar: 'otf.sidebar' };
const DRAG_TYPE = 'application/x-otf-card';
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const NARROW_QUERY = window.matchMedia('(max-width: 820px)');
/** A touch screen has no Esc or Ctrl+Enter: the hints that name them say "tap" or go. */
const COARSE_QUERY = window.matchMedia('(pointer: coarse)');
const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 9;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const STATUS_TITLES = {
  draft: 'Draft', scheduled: 'Scheduled', due: 'Time to post', publishing: 'Publishing',
  posted: 'Posted', failed: 'Publishing failed',
};
const VIEW_TITLES = { drafts: 'New draft', queue: 'Queue', posted: 'Posted' };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Draft  Server shape (spec §5).
 * @property {string} id
 * @property {Array<{ text: string, media: object[] }>} tweets
 * @property {string} status
 * @property {string} mode
 * @property {number|null} scheduledAt
 * @property {number|null} postedAt
 * @property {object|null} result
 * @property {number} updatedAt
 */

const state = {
  route: { view: 'drafts', id: null },
  tab: 'drafts',
  /** @type {object|null} last GET /api/status payload */
  status: null,
  lists: { drafts: [], queue: [], posted: [] },
  /** @type {object|null} last GET /api/queue payload */
  queue: null,
  editor: createEditorState(null),
  focus: false,
  sidebarCollapsed: false,
  /** @type {EventSource|null} */
  events: null,
  /** draft ids already announced with a reminder notification */
  notifiedIds: new Set(),
};

/** Element lookups by camel-cased id, filled in once by bindDom(). */
const dom = {};

function bindDom() {
  const ids = ['app', 'sidebar', 'sidebar-backdrop', 'sidebar-collapse', 'sidebar-open', 'new-draft',
    'sidebar-list', 'x-status', 'notif-btn', 'notif-note', 'tz-label', 'main', 'view-title', 'focus-btn',
    'view-editor', 'banner', 'cards', 'add-post-row', 'add-post', 'actionbar', 'view-queue',
    'view-posted', 'focus-indicator', 'toasts', 'popover-root', 'dialog', 'file-input',
    'count-drafts', 'count-queue', 'count-posted'];
  for (const id of ids) dom[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const PROPERTY_KEYS = new Set(['value', 'checked', 'disabled', 'readOnly', 'hidden', 'selected', 'draggable']);

/**
 * Build an element. Attribute keys: `class`, `dataset`, `style`, `on<event>`
 * (lowercase event name) listeners, form-state DOM properties, and plain
 * attributes for everything else. Children may be strings (rendered as text
 * nodes), nodes, nested arrays, or null/false (skipped).
 */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (PROPERTY_KEYS.has(key)) node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  node.append(...children);
  return node;
}

const ICON_PATHS = {
  image: 'M2.5 4.5h11v7h-11zM2.5 10l3-3 3 3 2-2 3 3M10.5 6.5h.01',
  up: 'M8 12.5v-9m0 0L4.5 7M8 3.5 11.5 7',
  down: 'M8 3.5v9m0 0L4.5 9M8 12.5 11.5 9',
  copy: 'M5.5 5.5h8v8h-8zM2.5 10.5v-8h8',
};

function icon(name) {
  return svgEl('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    svgEl('path', {
      d: ICON_PATHS[name], fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
}

/**
 * Small button used in banners, the action bar and list rows. The click
 * handler may be async; failures surface as a toast.
 */
function button(label, onclick, { primary = false, className = '', size = 'sm', ariaLabel, title, hasPopup = false } = {}) {
  return el('button', {
    type: 'button',
    class: `btn ${size === 'sm' ? 'btn-sm' : ''} ${primary ? 'btn-primary' : ''} ${className}`,
    'aria-label': ariaLabel,
    'aria-haspopup': hasPopup ? 'true' : null,
    title,
    onclick: (e) => attempt(() => onclick(e)),
  }, label);
}

function uid() {
  return crypto.randomUUID();
}

function noop() {}

/** Only http(s) links are ever used as hrefs or opened (result.url may be user input). */
function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

function readStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode or quota: preferences are optional */ }
}

// ---------------------------------------------------------------------------
// Text and time formatting
// ---------------------------------------------------------------------------

/** First non-blank line of the first post, or ''. */
function firstLine(tweets) {
  const text = tweets?.[0]?.text ?? '';
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

function postCountLabel(n) {
  return `${n} post${n === 1 ? '' : 's'}`;
}

/** Same format as tweet.js threadToClipboardText (round-trips through splitThread). */
function threadToClipboardText(tweets) {
  return tweets.map((t) => t.text).join('\n\n---\n\n');
}

/** Weighted length via twitter-text; falls back to code points if the vendor bundle did not load. */
function measure(text) {
  const parse = window.twttr?.parseTweet;
  if (typeof parse !== 'function') return { weightedLength: Array.from(text).length, valid: true };
  const parsed = parse(text);
  return { weightedLength: parsed.weightedLength, valid: text.length === 0 || parsed.valid };
}

function formatWith(ms, options) {
  return new Intl.DateTimeFormat(undefined, options).format(new Date(ms));
}

function formatTime(ms) {
  return formatWith(ms, { hour: 'numeric', minute: '2-digit' });
}

/** "Tue, Sep 8" (with the year when it is not the current one). */
function formatDate(ms) {
  const sameYear = new Date(ms).getFullYear() === new Date().getFullYear();
  return formatWith(ms, { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

function formatDateTime(ms) {
  return `${formatDate(ms)} · ${formatTime(ms)}`;
}

/** Compact time for list badges: "9:00 AM" today, "Tue 9:00 AM" within a week, else "Sep 8". */
function formatShortWhen(ms) {
  const diff = ms - Date.now();
  if (dateKeyIn(ms, BROWSER_TZ) === dateKeyIn(Date.now(), BROWSER_TZ)) return formatTime(ms);
  if (diff > 0 && diff < 6 * 86_400_000) return `${formatWith(ms, { weekday: 'short' })} ${formatTime(ms)}`;
  return formatWith(ms, { month: 'short', day: 'numeric' });
}

function formatRelative(ms) {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDate(ms);
}

/** 'YYYY-MM-DD' of an instant in a timezone (browser zone if the zone is unknown here). */
function dateKeyIn(ms, timeZone) {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-CA', { ...options, timeZone }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat('en-CA', options).format(new Date(ms));
  }
}

/** "Mon, Sep 7" for a 'YYYY-MM-DD' key, independent of any timezone offset. */
function formatDateKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  const sameYear = year === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC', ...(sameYear ? {} : { year: 'numeric' }),
  }).format(Date.UTC(year, month - 1, day));
}

function configTimezone() {
  return state.status?.timezone || BROWSER_TZ;
}

/**
 * The 'YYYY-MM-DD' key of the day after `key`. Calendar arithmetic on the key
 * itself: adding 24 h of elapsed time to "now" lands on the wrong day when the
 * configured zone has a 23- or 25-hour DST day.
 */
function nextDateKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/** "Today · Mon, Sep 7", "Tomorrow · Tue, Sep 8", else "Wed, Sep 9". */
function dayLabel(day) {
  const todayKey = dateKeyIn(Date.now(), configTimezone());
  const label = formatDateKey(day.date);
  if (day.date === todayKey) return `Today · ${label}`;
  if (day.date === nextDateKey(todayKey)) return `Tomorrow · ${label}`;
  return label;
}

/** Value for <input type="datetime-local"> in the browser's local time. */
function toLocalInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status = 0, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function request(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers } };
  if (body !== undefined) {
    init.body = raw ? body : JSON.stringify(body);
    if (!raw) init.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(API_BASE + path, init);
  } catch {
    throw new ApiError('Cannot reach the server. Is it running?');
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body: keep null */ }
  if (!res.ok) {
    const message = data?.error || `Request failed with status ${res.status}`;
    throw new ApiError(message, res.status, Array.isArray(data?.details) ? data.details : null);
  }
  return data;
}

const api = {
  status: () => request('/status'),
  listDrafts: (statuses) => request(`/drafts?status=${encodeURIComponent(statuses.join(','))}`).then((r) => r.drafts),
  getDraft: (id) => request(`/drafts/${id}`).then((r) => r.draft),
  createDraft: (body) => request('/drafts', { method: 'POST', body }).then((r) => r.draft),
  updateDraft: (id, body) => request(`/drafts/${id}`, { method: 'PUT', body }).then((r) => r.draft),
  deleteDraft: (id) => request(`/drafts/${id}`, { method: 'DELETE' }),
  duplicateDraft: (id) => request(`/drafts/${id}/duplicate`, { method: 'POST' }).then((r) => r.draft),
  schedule: (id, body) => request(`/drafts/${id}/schedule`, { method: 'POST', body }).then((r) => r.draft),
  unschedule: (id) => request(`/drafts/${id}/unschedule`, { method: 'POST' }).then((r) => r.draft),
  publish: (id) => request(`/drafts/${id}/publish`, { method: 'POST' }).then((r) => r.draft),
  retry: (id) => request(`/drafts/${id}/retry`, { method: 'POST' }).then((r) => r.draft),
  markPosted: (id, body) => request(`/drafts/${id}/mark-posted`, { method: 'POST', body }).then((r) => r.draft),
  queue: () => request('/queue'),
  nextSlot: (excludeId) => request(`/slots/next${excludeId ? `?exclude=${encodeURIComponent(excludeId)}` : ''}`),
  uploadMedia: (file) => request('/media', {
    method: 'POST',
    raw: true,
    body: file,
    headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name || 'image') },
  }).then((r) => r.media),
  deleteMedia: (id) => request(`/media/${id}`, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// Toasts, dialogs, popovers
// ---------------------------------------------------------------------------

const MAX_TOASTS = 3;
/** Dismiss timer of each toast node, so a repeated message restarts it instead of stacking a copy. */
const toastTimers = new WeakMap();

function toast(message, { kind = 'info', duration } = {}) {
  const ms = duration ?? (kind === 'error' ? 7000 : 3200);
  // The same message while its toast is still up (the HTTP response and the
  // SSE event of one publish, a repeated click) restarts that toast wherever
  // it sits in the stack: another one may well have landed in between.
  const same = Array.from(dom.toasts.children).find((node) => node.textContent === message && node.classList.contains(kind));
  if (same) {
    clearTimeout(toastTimers.get(same));
    toastTimers.set(same, setTimeout(() => same.remove(), ms));
    return;
  }
  const node = el('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  while (dom.toasts.children.length >= MAX_TOASTS) dom.toasts.firstElementChild.remove();
  dom.toasts.append(node);
  toastTimers.set(node, setTimeout(() => node.remove(), ms));
}

/** Validation errors arrive as details[].message; list them under the headline. */
function toastError(err) {
  const message = err?.details?.length
    ? `${err.message}\n${err.details.map((d) => `• ${d.message}`).join('\n')}`
    : (err?.message || 'Something went wrong.');
  toast(message, { kind: 'error' });
}

/** Run an async action and surface a failure as a toast instead of an unhandled rejection. */
async function attempt(fn) {
  try {
    await fn();
  } catch (err) {
    toastError(err);
  }
}

/**
 * Modal dialog built on <dialog>. Resolves with the clicked action's value, or
 * null when dismissed with Escape.
 */
function openDialog({ title, message, fields = [], actions }) {
  return new Promise((resolve) => {
    const dialog = dom.dialog;
    const buttons = actions.map((action) => el('button', {
      type: 'button',
      class: `btn ${action.primary ? 'btn-primary' : ''} ${action.danger ? 'btn-danger' : ''}`,
      onclick: () => dialog.close(action.value),
    }, action.label));
    const primary = buttons[actions.findIndex((a) => a.primary)] ?? buttons[buttons.length - 1];
    const body = el('div', { class: 'dialog-body' }, el('h2', {}, title), message ? el('p', {}, message) : null, fields);
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('input')) {
        e.preventDefault();
        primary.click();
      }
    });
    dialog.replaceChildren(body, el('div', { class: 'dialog-actions' }, buttons));
    dialog.addEventListener('close', () => {
      const value = dialog.returnValue;
      dialog.returnValue = '';
      resolve(value === '' ? null : value);
    }, { once: true });
    dialog.showModal();
    (dialog.querySelector('input, select') ?? primary).focus();
  });
}

async function confirmDialog({ title, message, okLabel = 'OK', danger = false }) {
  const value = await openDialog({
    title,
    message,
    actions: [{ label: 'Cancel', value: 'cancel' }, { label: okLabel, value: 'ok', primary: true, danger }],
  });
  return value === 'ok';
}

/** Text prompt. Resolves with the string (possibly empty) or null when cancelled. */
async function promptDialog({ title, message, label, value = '', placeholder = '', type = 'text', okLabel = 'Save', maxLength }) {
  const input = el('input', { type, value, placeholder, maxlength: maxLength, 'aria-label': label });
  const result = await openDialog({
    title,
    message,
    fields: [el('label', { class: 'dialog-field' }, label, input)],
    actions: [{ label: 'Cancel', value: 'cancel' }, { label: okLabel, value: 'ok', primary: true }],
  });
  return result === 'ok' ? input.value : null;
}

/**
 * Pick one draft from a list. Resolves with its id or null. A draft the
 * server would refuse as it is (empty, over the limit) is listed but cannot
 * be chosen, with the reason, instead of failing after the click.
 */
async function pickDraftDialog({ title, message, drafts }) {
  if (drafts.length === 0) {
    toast('There are no drafts to schedule. Write one first.');
    return null;
  }
  const entries = drafts.map((draft) => ({ draft, problem: threadProblems(withoutTrailingEmpty(draft.tweets))[0] ?? null }));
  const ready = entries.filter((entry) => !entry.problem);
  if (ready.length === 0) {
    toast(`${drafts.length === 1 ? 'The only draft is' : 'Every draft is'} empty or over the limit — fix one first, then schedule it.`);
    return null;
  }
  const select = el('select', { 'aria-label': 'Draft' },
    entries.map(({ draft, problem }) => el('option', { value: draft.id, disabled: Boolean(problem) },
      `${truncate(firstLine(draft.tweets) || '(empty draft)', 60)} — ${postCountLabel(draft.tweets.length)}${problem ? ` — ${problem.replace(/\.$/, '')}` : ''}`)));
  select.value = ready[0].draft.id;
  const result = await openDialog({
    title,
    message,
    fields: [el('label', { class: 'dialog-field' }, 'Draft', select)],
    actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Schedule', value: 'ok', primary: true }],
  });
  return result === 'ok' ? select.value : null;
}

let activePopover = null;

/** Anchored popover; closes on Escape, outside click, scroll or resize. */
function openPopover(anchor, content) {
  closePopover();
  const node = el('div', { class: 'popover', role: 'dialog' }, content);
  dom.popoverRoot.append(node);
  positionPopover(node, anchor);
  const onPointerDown = (e) => {
    if (!node.contains(e.target) && !anchor.contains(e.target)) closePopover();
  };
  const onMove = () => closePopover();
  document.addEventListener('pointerdown', onPointerDown);
  dom.main.addEventListener('scroll', onMove, { passive: true });
  window.addEventListener('resize', onMove);
  activePopover = {
    node,
    anchor,
    cleanup() {
      document.removeEventListener('pointerdown', onPointerDown);
      dom.main.removeEventListener('scroll', onMove);
      window.removeEventListener('resize', onMove);
    },
  };
  anchor.setAttribute('aria-expanded', 'true');
  node.querySelector('input:not([disabled]), button, select')?.focus();
  return node;
}

function positionPopover(node, anchor) {
  const rect = anchor.getBoundingClientRect();
  const gap = 6;
  const height = node.offsetHeight;
  const width = node.offsetWidth;
  const fitsBelow = rect.bottom + gap + height <= window.innerHeight;
  const top = fitsBelow ? rect.bottom + gap : Math.max(8, rect.top - gap - height);
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  node.style.top = `${top}px`;
  node.style.left = `${left}px`;
}

function closePopover({ restoreFocus = false } = {}) {
  if (!activePopover) return;
  const { node, anchor, cleanup } = activePopover;
  activePopover = null;
  cleanup();
  node.remove();
  anchor.setAttribute('aria-expanded', 'false');
  if (restoreFocus && anchor.isConnected) anchor.focus();
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* clipboard API unavailable (insecure context) or blocked: fall back */ }
  const area = el('textarea', { class: 'sr-only', value: text, readOnly: true, 'aria-hidden': 'true' });
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

async function copyWithToast(text, label) {
  if (await copyText(text)) toast(label, { kind: 'success' });
  else toast('Could not copy — the browser blocked clipboard access.', { kind: 'error' });
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function tabForStatus(status) {
  return Object.keys(TAB_STATUSES).find((tab) => TAB_STATUSES[tab].includes(status)) ?? 'drafts';
}

function setTab(tab) {
  state.tab = tab;
  for (const tabButton of dom.sidebar.querySelectorAll('.tab')) {
    tabButton.setAttribute('aria-selected', String(tabButton.dataset.tab === tab));
  }
  renderSidebarList();
  loadList(tab);
}

function onTabClick(tab) {
  if (tab === 'queue') navigate('#/queue');
  else if (tab === 'posted') navigate('#/posted');
  else if (state.route.view === 'draft' && state.editor.draft?.status === 'draft') setTab('drafts');
  else navigate('#/drafts');
}

/** Fetch one tab's list and render whatever shows it (sidebar, posted view). */
async function loadList(tab) {
  try {
    state.lists[tab] = await api.listDrafts(TAB_STATUSES[tab]);
  } catch (err) {
    if (err.status) toastError(err); // network failures are already reported by refreshStatus
    return;
  }
  if (state.tab === tab) renderSidebarList();
  if (tab === 'posted' && state.route.view === 'posted') renderPosted();
}

async function refreshStatus() {
  const hadStatus = Boolean(state.status);
  const wasConfigured = Boolean(state.status?.configured);
  try {
    state.status = await api.status();
  } catch (err) {
    if (!state.status) {
      toast(err.message, { kind: 'error' });
      renderFooter();
    }
    return;
  }
  renderCounts();
  renderFooter();
  if (!hadStatus || Boolean(state.status.configured) !== wasConfigured) {
    renderActionBar();
    renderSidebarList(); // the drafts empty state explains reminder mode
  }
}

function renderCounts() {
  const counts = state.status?.counts ?? {};
  const sum = (keys) => keys.reduce((n, key) => n + (counts[key] ?? 0), 0);
  dom.countDrafts.textContent = String(sum(TAB_STATUSES.drafts));
  dom.countQueue.textContent = String(sum(TAB_STATUSES.queue));
  dom.countPosted.textContent = String(sum(TAB_STATUSES.posted));
}

function renderFooter() {
  const status = state.status;
  const pill = dom.xStatus;
  pill.className = 'pill';
  if (!status) {
    pill.textContent = 'Server unreachable';
    pill.classList.add('bad');
  } else if (status.configured) {
    pill.textContent = status.handle ? `X API: connected as @${status.handle}` : 'X API: connected';
    pill.classList.add('ok');
  } else {
    pill.textContent = 'X API: not configured — reminder mode';
    pill.classList.add('warn');
  }
  pill.title = status && !status.configured
    ? 'Reminder mode: at slot time you get a notification here, then copy the posts to X and mark the thread as posted.'
    : 'X API status';
  const tz = status?.timezone;
  dom.tzLabel.textContent = !tz || tz === BROWSER_TZ ? BROWSER_TZ : `${tz} · shown in ${BROWSER_TZ}`;
  renderNotificationButton();
}

/** 'granted' | 'denied' | 'default' | 'unsupported'. */
function notificationState() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

/**
 * Footer: the "Enable notifications" button while permission can still be
 * asked for, nothing once granted, and a plain note (not a disabled button)
 * when they are blocked or unsupported.
 */
function renderNotificationButton() {
  const permission = notificationState();
  dom.notifBtn.hidden = permission !== 'default';
  dom.notifNote.hidden = permission === 'default' || permission === 'granted';
  dom.notifNote.textContent = permission === 'denied'
    ? 'Notifications are blocked for this site, so reminders only show while a tab is open. Allow them in the browser settings to be alerted.'
    : permission === 'unsupported' ? 'This browser cannot show notifications, so reminders only show while a tab is open.' : '';
}

async function requestNotifications() {
  if (!('Notification' in window)) {
    toast('This browser does not support notifications.', { kind: 'error' });
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') toast('Notifications enabled. Keep this tab open to receive reminders.', { kind: 'success' });
    else if (permission === 'denied') toast('Notifications are blocked. Allow them in the browser settings.', { kind: 'error' });
  } catch (err) {
    toast(`Could not request notifications: ${err.message}`, { kind: 'error' });
  }
  renderNotificationButton();
  renderBanner(); // the scheduled banner's reminder hint depends on the permission
}

function renderSidebarList() {
  const items = state.lists[state.tab];
  const activeId = state.editor.draft?.id ?? null;
  const emptyText = { drafts: 'No drafts yet. Start writing.', queue: 'Nothing scheduled.', posted: 'Nothing posted yet.' };
  if (items.length === 0) {
    // First run without X keys: say what "reminder mode" means before the first draft exists.
    const reminderNote = state.tab === 'drafts' && state.status && !state.status.configured
      && el('div', { class: 'list-empty-note' },
        'Reminder mode: no X API keys are configured, so at slot time you get a notification here and post the thread on X yourself.');
    dom.sidebarList.replaceChildren(el('div', { class: 'list-empty' }, emptyText[state.tab], reminderNote));
    return;
  }
  // A real list of buttons: a role="listitem" on the button itself would hide that it can be pressed.
  dom.sidebarList.replaceChildren(el('ul', { class: 'rows' }, items.map((draft) => el('li', {}, buildRow(draft, draft.id === activeId)))));
}

function buildRow(draft, active) {
  const title = firstLine(draft.tweets);
  return el('button', {
    type: 'button',
    class: `row ${active ? 'active' : ''}`,
    'aria-current': active ? 'true' : null,
    onclick: () => {
      navigate(`#/draft/${draft.id}`);
      if (NARROW_QUERY.matches) setSidebarCollapsed(true);
    },
  },
  el('div', { class: 'row-main' },
    el('div', { class: `row-title ${title ? '' : 'empty'}` }, title || 'Empty draft'),
    el('div', { class: 'row-meta' }, postCountLabel(draft.tweets.length))),
  rowBadge(draft));
}

function rowBadge(draft) {
  switch (draft.status) {
    case 'scheduled':
      return isOverdue(draft.scheduledAt, Date.now())
        ? el('span', { class: 'badge warn' }, 'Overdue')
        : el('span', { class: 'badge scheduled' }, formatShortWhen(draft.scheduledAt));
    case 'due': return el('span', { class: 'badge due' }, 'Due');
    case 'publishing': return el('span', { class: 'badge publishing' }, 'Publishing…');
    case 'posted': return el('span', { class: 'badge posted' }, 'Posted');
    case 'failed': return el('span', { class: 'badge failed' }, 'Failed');
    default: return el('span', { class: 'badge' }, formatRelative(draft.updatedAt));
  }
}

/** Keep the sidebar lists in step with a draft we just changed, without a round trip. */
function applyDraftToLists(draft) {
  for (const [tab, statuses] of Object.entries(TAB_STATUSES)) {
    const list = state.lists[tab];
    const index = list.findIndex((d) => d.id === draft.id);
    if (statuses.includes(draft.status)) {
      if (index >= 0) list[index] = draft;
      else list.unshift(draft);
    } else if (index >= 0) {
      list.splice(index, 1);
    }
  }
  renderSidebarList();
}

function removeDraftFromLists(id) {
  for (const list of Object.values(state.lists)) {
    const index = list.findIndex((d) => d.id === id);
    if (index >= 0) list.splice(index, 1);
  }
  renderSidebarList();
}

function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = collapsed;
  dom.app.classList.toggle('sidebar-collapsed', collapsed);
  dom.sidebarOpen.hidden = !collapsed;
  dom.sidebarBackdrop.hidden = collapsed || !NARROW_QUERY.matches;
  writeStorage(STORAGE_KEYS.sidebar, collapsed ? 'collapsed' : 'open');
}

// ---------------------------------------------------------------------------
// Editor: state
// ---------------------------------------------------------------------------

/**
 * Local editor state for one draft. Each tweet carries a stable `key` (for
 * focus and drag bookkeeping) and `pending` uploads, neither of which is saved.
 */
function createEditorState(draft) {
  const tweets = draft?.tweets?.length ? draft.tweets : [{ text: '', media: [] }];
  return {
    draft,
    tweets: tweets.map(toLocalTweet),
    dirty: false,
    saving: false,
    queued: false,
    savePromise: null,
    savedAt: draft?.updatedAt ?? null,
    error: null,
    lastToastedError: null,
    /** true while our own publish/retry request for this draft is in flight */
    publishing: false,
    copyStep: 0,
  };
}

function toLocalTweet(tweet) {
  return { key: uid(), text: tweet.text ?? '', media: (tweet.media ?? []).map((m) => ({ ...m })), pending: [] };
}

function serializeTweets(tweets) {
  return tweets.map((t) => ({
    text: t.text,
    media: t.media.map(({ id, url, name, type, size, alt }) => ({ id, url, name, type, size, ...(alt ? { alt } : {}) })),
  }));
}

/** The status the editor shows: 'publishing' while our own publish/retry request runs, else the draft's. */
function editorStatus() {
  const ed = state.editor;
  if (ed.publishing) return 'publishing';
  return ed.draft?.status ?? 'draft';
}

function isReadOnly() {
  return READ_ONLY_STATUSES.includes(editorStatus());
}

function isEditorView() {
  return state.route.view === 'drafts' || state.route.view === 'draft';
}

function findTweet(key) {
  return state.editor.tweets.find((t) => t.key === key) ?? null;
}

function indexOfKey(key) {
  return state.editor.tweets.findIndex((t) => t.key === key);
}

function cardFor(key) {
  return dom.cards.querySelector(`.card[data-key="${key}"]`);
}

function hasContent(ed) {
  return ed.tweets.some((t) => t.text.trim() || t.media.length);
}

function hasPendingUploads(ed) {
  return ed.tweets.some((t) => t.pending.length);
}

/** No text, no images, nothing uploading: the card `---` leaves for the caret, or one added and never used. */
function isEmptyCard(tweet) {
  return tweet.text.trim() === '' && (tweet.media?.length ?? 0) === 0 && (tweet.pending?.length ?? 0) === 0;
}

/** The thread without the empty cards at its end (never fewer than one post); the server drops them the same way. */
function withoutTrailingEmpty(tweets) {
  let end = tweets.length;
  while (end > 1 && isEmptyCard(tweets[end - 1])) end -= 1;
  return end === tweets.length ? tweets : tweets.slice(0, end);
}

/**
 * How many of a thread's first posts are already on X. A thread that failed
 * part-way (or was moved back to drafts, or rescheduled, afterwards) keeps
 * their ids so the next attempt continues after them; those posts are locked
 * here and refused by the server, since rewriting them would not reach X.
 */
function lockedCount(draft) {
  if (!draft || READ_ONLY_STATUSES.includes(draft.status)) return 0;
  const ids = draft.result?.tweetIds;
  return Array.isArray(ids) ? ids.length : 0;
}

/** The banner lines for a thread whose first posts are already on X, or null. */
function lockedCopy(draft) {
  const k = lockedCount(draft);
  if (k === 0) return null;
  return {
    title: k === 1 ? 'Post 1 is already on X and is locked.' : `Posts 1–${k} are already on X and are locked.`,
    detail: `Publishing continues from post ${k + 1}. Duplicate the thread to start over.`,
  };
}

/**
 * The server's validateThread, mirrored so an empty or over-limit thread is
 * refused before a dialog opens or a draft gets created for it.
 */
function threadProblems(tweets) {
  const problems = [];
  if (tweets.length > MAX_POSTS) problems.push(`A thread can have at most ${MAX_POSTS} posts (this one has ${tweets.length}).`);
  tweets.forEach((tweet, index) => {
    const n = index + 1;
    const hasText = tweet.text.trim() !== '';
    if (!hasText && tweet.media.length === 0) {
      problems.push(`Post ${n} is empty.`);
    } else if (hasText) {
      const { weightedLength, valid } = measure(tweet.text);
      if (weightedLength > MAX_LEN) problems.push(`Post ${n} is over the ${MAX_LEN}-character limit (${weightedLength}/${MAX_LEN}).`);
      else if (!valid) problems.push(`Post ${n} contains characters X does not accept.`);
    }
    if (tweet.media.length > MAX_MEDIA) problems.push(`Post ${n} has more than ${MAX_MEDIA} images.`);
    if (tweet.media.length > 1 && tweet.media.some((m) => m.type === 'image/gif')) problems.push(`Post ${n}: a GIF must be the only attachment.`);
  });
  return problems;
}

/** Whether the editor's thread can be queued or published; explains why not with the server's own wording. */
function editorReady() {
  const ed = state.editor;
  if (!hasContent(ed)) {
    toast('Write something first.');
    return false;
  }
  const problems = threadProblems(withoutTrailingEmpty(ed.tweets));
  if (problems.length > 0) {
    toastError(new ApiError('Fix these first', 400, problems.map((message) => ({ message }))));
    return false;
  }
  return true;
}

function defaultModeFor(draft) {
  if (draft?.mode === 'manual') return 'manual';
  return state.status?.configured ? 'api' : 'manual';
}

// ---------------------------------------------------------------------------
// Editor: loading drafts
// ---------------------------------------------------------------------------

function loadEditor(draft) {
  state.editor = createEditorState(draft);
  renderEditor(isReadOnly() ? null : { index: state.editor.tweets.length - 1 });
  renderSidebarList();
}

/** Save whatever is pending in the current editor before it gets replaced. */
function flushEditor() {
  if (state.editor.dirty) saveNow().catch(noop);
}

/** Bumped on every openDraft() call, so a slow load cannot land after a newer one. */
let openSeq = 0;

async function openDraft(id) {
  const token = ++openSeq;
  flushEditor();
  try {
    const draft = await api.getDraft(id);
    if (token !== openSeq || state.route.id !== id) return; // the user moved on while this was loading
    loadEditor(draft);
    setTab(tabForStatus(draft.status));
    dom.viewTitle.textContent = STATUS_TITLES[draft.status] ?? 'Draft';
  } catch (err) {
    toastError(err);
    if (err.status === 404) navigate('#/drafts');
  }
}

function resetEditor() {
  flushEditor();
  loadEditor(null);
}

/** Coming back to an already-loaded draft: pick up changes a missed SSE event would have carried. */
async function refreshOpenDraft() {
  const ed = state.editor;
  if (!ed.draft) return;
  try {
    const draft = await api.getDraft(ed.draft.id);
    if (state.editor === ed && draft.updatedAt !== ed.draft.updatedAt) reloadOpenDraft(draft);
  } catch (err) {
    if (err.status === 404) onDraftDeleted(ed.draft.id);
  }
}

async function createNewDraft() {
  await attempt(async () => {
    flushEditor();
    const draft = await api.createDraft({ tweets: [{ text: '', media: [] }] });
    loadEditor(draft);
    navigate(`#/draft/${draft.id}`);
    applyDraftToLists(draft);
    refreshStatus();
    if (NARROW_QUERY.matches) setSidebarCollapsed(true);
  });
}

/** Replace the editor's draft metadata (status, times, result) but keep the local text. */
function adoptDraft(draft) {
  const ed = state.editor;
  ed.draft = draft;
  if (!ed.dirty && !ed.saving) ed.savedAt = draft.updatedAt;
}

/** The open draft changed on the server: adopt it, and replace the text only when nothing local is unsaved. */
function reloadOpenDraft(draft) {
  const ed = state.editor;
  const wasReadOnly = isReadOnly();
  const lockedBefore = lockedCount(ed.draft);
  const chromeChanged = bannerSignature(draft) !== bannerSignature(ed.draft);
  const clean = !ed.dirty && !ed.saving && !hasPendingUploads(ed);
  adoptDraft(draft);
  const readOnly = isReadOnly();
  if (readOnly && !clean) discardLocalEdits(ed);
  if (clean) {
    ed.tweets = draft.tweets.map(toLocalTweet);
    renderEditor();
  } else if (readOnly || wasReadOnly !== readOnly || lockedCount(draft) !== lockedBefore) {
    renderEditor(); // the cards change shape (read-only, or the posted head locked), not just the chrome
  } else if (chromeChanged) {
    renderChrome(); // an echo of our own save changes nothing visible: leave open popovers alone
  }
  if (tabForStatus(draft.status) !== state.tab && isEditorView()) setTab(tabForStatus(draft.status));
}

/**
 * The draft is posted or being posted, so the server copy is what went out:
 * unsaved local edits (and uploads still in flight) can no longer apply, and
 * showing them inside the read-only thread would misrepresent what was posted.
 */
function discardLocalEdits(ed) {
  clearTimeout(saveTimer);
  ed.tweets = ed.draft.tweets.map(toLocalTweet);
  ed.dirty = false;
  ed.error = null;
  ed.lastToastedError = null;
}

/** The parts of a draft that the banner and action bar depend on. */
function bannerSignature(draft) {
  return JSON.stringify([draft?.status, draft?.mode, draft?.scheduledAt, draft?.postedAt, draft?.result]);
}

/** Push a draft returned by an action into the editor, the lists and the queue. */
function syncDraft(draft) {
  const ed = state.editor;
  if (ed.draft?.id === draft.id) {
    adoptDraft(draft);
    if (isReadOnly() && (ed.dirty || hasPendingUploads(ed))) discardLocalEdits(ed);
    ed.copyStep = 0;
    renderEditor();
    if (isEditorView()) setTab(tabForStatus(draft.status));
  }
  applyDraftToLists(draft);
  refreshStatus();
  if (state.route.view === 'queue') loadQueue();
}

// ---------------------------------------------------------------------------
// Editor: rendering
// ---------------------------------------------------------------------------

/** Full editor render. focusSpec: undefined = keep focus, null = no focus, or a spec for applyFocus. */
function renderEditor(focusSpec) {
  renderChrome();
  renderCards(focusSpec);
}

/** Everything around the cards: banner, action bar, add-post row, title. */
function renderChrome() {
  renderBanner();
  renderActionBar();
  dom.addPostRow.hidden = isReadOnly();
  if (isEditorView()) dom.viewTitle.textContent = state.editor.draft ? STATUS_TITLES[editorStatus()] : VIEW_TITLES.drafts;
}

function renderCards(focusSpec) {
  const ed = state.editor;
  const restore = focusSpec === undefined ? captureFocus() : focusSpec;
  dom.cards.replaceChildren(...ed.tweets.map((tweet, index) => buildCard(tweet, index, ed.tweets.length)));
  applyFocus(restore);
  renderThreadSize();
}

/**
 * The chrome that counts the cards — the action bar's total and the due
 * banner's "Copy post i of N" stepper — follows every add, split and remove
 * right away; a save of our own never triggers a full render that would.
 */
function renderThreadSize() {
  const count = dom.actionbar.querySelector('.post-count');
  if (count) count.textContent = postCountLabel(state.editor.tweets.length);
  const stepper = dom.banner.querySelector('.banner.due .btn-primary');
  if (stepper) stepper.textContent = stepperLabel();
}

function captureFocus() {
  const active = document.activeElement;
  if (!active || !active.matches('.card textarea')) return null;
  const card = active.closest('.card');
  // The index comes from the DOM rather than ed.tweets: a reload from the server
  // replaces the tweets (and their keys) before the cards are re-rendered.
  const index = Array.prototype.indexOf.call(dom.cards.children, card);
  return { key: card.dataset.key, index, start: active.selectionStart, end: active.selectionEnd };
}

/** focusSpec: { key } and/or { index }, with optional start/end (default: caret at the end). */
function applyFocus(spec) {
  if (!spec) return;
  const card = (spec.key && cardFor(spec.key)) || dom.cards.children[spec.index];
  const textarea = card?.querySelector('textarea');
  if (!textarea) return;
  textarea.focus();
  const start = Math.min(spec.start ?? textarea.value.length, textarea.value.length);
  textarea.setSelectionRange(start, Math.min(spec.end ?? start, textarea.value.length));
}

function buildCard(tweet, index, total) {
  const ed = state.editor;
  const readOnly = isReadOnly();
  const due = editorStatus() === 'due';
  // A post already on X (a thread that failed part-way) is a record like a
  // posted one, with a link to it; the rest of the thread stays editable.
  const locked = !readOnly && index < lockedCount(ed.draft);
  const frozen = readOnly || locked;
  const textarea = el('textarea', {
    rows: 1,
    value: tweet.text,
    readOnly: frozen,
    placeholder: index > 0 ? 'Continue the thread…'
      : total === 1 ? "What's happening? Type --- on its own line to start the next post." : "What's happening?",
    'aria-label': `Post ${index + 1} of ${total}`,
  });
  const wrap = el('div', { class: 'grow-wrap', dataset: { value: tweet.text } }, textarea);
  textarea.addEventListener('input', () => onTextInput(tweet.key, textarea, wrap));
  textarea.addEventListener('keydown', (e) => onTextKeydown(e, tweet.key, textarea));
  textarea.addEventListener('paste', (e) => onPaste(e, tweet.key));

  // Posted and publishing threads are a record of what went out: no reorder
  // handle, tools or counter (they could never become usable again), only the
  // text, the images and the position in the thread.
  const movable = total - lockedCount(ed.draft) > 1; // the locked head never moves, so one free card has nowhere to go
  const handle = !frozen && el('button', {
    type: 'button',
    class: 'handle',
    draggable: movable,
    disabled: !movable,
    'aria-label': `Drag to reorder post ${index + 1} (or use the arrow buttons)`,
    title: 'Drag to reorder',
  }, '⋮⋮');

  const tools = !frozen && el('div', { class: 'card-tools' },
    el('button', {
      type: 'button', class: 'tool', disabled: tweet.media.length + tweet.pending.length >= MAX_MEDIA,
      'aria-label': `Add image to post ${index + 1}`, title: 'Add image', onclick: () => pickImages(tweet.key),
    }, icon('image'), el('span', { class: 'tool-label' }, 'Add image')),
    el('button', {
      type: 'button', class: 'tool', disabled: index <= lockedCount(ed.draft),
      'aria-label': `Move post ${index + 1} up`, title: 'Move up', onclick: () => moveCard(tweet.key, -1),
    }, icon('up')),
    el('button', {
      type: 'button', class: 'tool', disabled: index === total - 1,
      'aria-label': `Move post ${index + 1} down`, title: 'Move down', onclick: () => moveCard(tweet.key, 1),
    }, icon('down')),
    due && el('button', {
      type: 'button', class: 'tool', 'aria-label': `Copy post ${index + 1}`, title: 'Copy this post',
      onclick: () => copyPost(index),
    }, icon('copy'), el('span', { class: 'tool-label' }, 'Copy')));

  const card = el('article', {
    class: `card ${readOnly ? 'read-only' : ''} ${locked ? 'locked' : ''}`,
    dataset: { key: tweet.key },
    'aria-label': `Post ${index + 1} of ${total}${locked ? ' (already on X)' : ''}`,
  },
  el('div', { class: 'card-side' }, handle, el('span', { class: 'index' }, `${index + 1}/${total}`)),
  el('div', { class: 'card-body' },
    wrap,
    buildMediaRow(tweet, frozen),
    locked && el('div', { class: 'card-foot' }, postedBadge(ed.draft.result.tweetIds[index])),
    !frozen && el('div', { class: 'card-foot' }, tools, buildCounter())),
  total > 1 && !frozen && el('button', {
    type: 'button', class: 'card-remove', 'aria-label': `Remove post ${index + 1}`, title: 'Remove post',
    onclick: () => removeCard(tweet.key),
  }, '✕'));

  if (frozen) return card;
  wireDragAndDrop(card, handle, tweet.key);
  updateCounter(card, tweet.text);
  return card;
}

/** "Posted" badge of a locked card, linking to the post on X. */
function postedBadge(tweetId) {
  return el('a', {
    class: 'badge posted posted-link',
    href: `https://x.com/i/status/${encodeURIComponent(String(tweetId))}`,
    target: '_blank',
    rel: 'noopener',
    title: 'This post is already on X — open it in a new tab',
  }, 'Posted');
}

function buildCounter() {
  const ring = svgEl('svg', { viewBox: '0 0 22 22' },
    svgEl('circle', { class: 'ring-track', cx: 11, cy: 11, r: RING_RADIUS, fill: 'none', 'stroke-width': 2 }),
    svgEl('circle', {
      class: 'ring-fill', cx: 11, cy: 11, r: RING_RADIUS, fill: 'none', 'stroke-width': 2, 'stroke-linecap': 'round',
      'stroke-dasharray': RING_LENGTH.toFixed(2), 'stroke-dashoffset': RING_LENGTH.toFixed(2),
    }));
  return el('div', { class: 'counter', dataset: { level: 'ok' } }, ring, el('span', { class: 'counter-label' }, `0 / ${MAX_LEN}`));
}

/** Neutral below 260, amber 260–280, red above 280 (or on characters X rejects). */
function updateCounter(card, text) {
  const counter = card.querySelector('.counter');
  if (!counter) return; // a read-only card has none
  const { weightedLength, valid } = measure(text);
  const over = weightedLength > MAX_LEN || !valid;
  counter.dataset.level = over ? 'over' : weightedLength >= WARN_AT ? 'warn' : 'ok';
  counter.title = !valid && weightedLength <= MAX_LEN ? 'Contains characters X does not accept' : '';
  counter.querySelector('.counter-label').textContent = `${weightedLength} / ${MAX_LEN}`;
  counter.querySelector('.ring-fill').style.strokeDashoffset = (RING_LENGTH * (1 - Math.min(weightedLength / MAX_LEN, 1))).toFixed(2);
  if (over) counter.setAttribute('aria-live', 'polite');
  else counter.removeAttribute('aria-live');
  card.classList.toggle('over', over);
}

function buildMediaRow(tweet, readOnly) {
  return el('div', { class: 'media-row' },
    tweet.media.map((media) => buildThumb(tweet.key, media, readOnly)),
    tweet.pending.map((pending) => el('div', { class: 'thumb pending', title: `Uploading ${pending.name}…` },
      el('img', { src: pending.objectUrl, alt: '' }),
      el('div', { class: 'spinner', role: 'status', 'aria-label': `Uploading ${pending.name}` }))));
}

function buildThumb(key, media, readOnly) {
  return el('div', { class: 'thumb' },
    el('img', { src: media.url, alt: media.alt || media.name || 'Attached image' }),
    !readOnly && el('div', { class: 'thumb-tools' },
      el('button', {
        type: 'button', class: `thumb-btn ${media.alt ? 'has-alt' : ''}`, title: media.alt || 'Add alt text',
        'aria-label': media.alt ? 'Edit alt text' : 'Add alt text', onclick: () => editAlt(key, media.id),
      }, media.alt ? 'ALT ✓' : 'ALT'),
      el('button', {
        type: 'button', class: 'thumb-btn', 'aria-label': 'Remove image', title: 'Remove image',
        onclick: () => removeImage(key, media.id),
      }, '✕')));
}

/** Re-render one card's image row only (the textarea and its caret stay untouched). */
function renderMedia(key) {
  const card = cardFor(key);
  const tweet = findTweet(key);
  if (!card || !tweet) return;
  const frozen = isReadOnly() || isLocked(key);
  card.querySelector('.media-row').replaceWith(buildMediaRow(tweet, frozen));
  const addImage = card.querySelector('.card-tools .tool'); // absent on a read-only or locked card
  if (addImage) addImage.disabled = frozen || tweet.media.length + tweet.pending.length >= MAX_MEDIA;
}

/** Whether the card with this key is a post already on X (see lockedCount). */
function isLocked(key) {
  const index = indexOfKey(key);
  return index >= 0 && index < lockedCount(state.editor.draft);
}

// ---------------------------------------------------------------------------
// Editor: typing, splitting, reordering
// ---------------------------------------------------------------------------

function onTextInput(key, textarea, wrap) {
  // A multi-line insertText (IME commit, text expander, Playwright's fill) is
  // delivered as several input events carrying the full value; once the first
  // one split the card, the rest arrive on the detached textarea and must not
  // split the same value again.
  if (!textarea.isConnected) return;
  const tweet = findTweet(key);
  if (!tweet) return;
  const value = textarea.value;
  if (hasSeparatorLine(value)) {
    splitCard(key, textarea);
    return;
  }
  tweet.text = value;
  wrap.dataset.value = value;
  updateCounter(textarea.closest('.card'), value);
  markDirty();
}

function hasSeparatorLine(value) {
  return value.split('\n').some((line) => line.trim() === '---');
}

function trimBlankLines(text) {
  return text.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
}

/**
 * Split a card at every `---` line (the server's splitThread rule, except that
 * an empty trailing part is kept so the caret can continue there). The caret
 * lands at the start of the part it was in, which for typed `---` is the new
 * empty card.
 */
function splitCard(key, textarea) {
  const ed = state.editor;
  const index = indexOfKey(key);
  const tweet = ed.tweets[index];
  const value = textarea.value.replace(/\r\n?/g, '\n');
  const caretLine = value.slice(0, textarea.selectionStart).split('\n').length - 1;
  const rawParts = [];
  let current = [];
  let caretPart = 0;
  value.split('\n').forEach((line, lineIndex) => {
    if (line.trim() !== '---') {
      current.push(line);
      return;
    }
    rawParts.push(current.join('\n'));
    current = [];
    if (lineIndex <= caretLine) caretPart = rawParts.length;
  });
  rawParts.push(current.join('\n'));

  const parts = [];
  let focusIndex = 0;
  rawParts.forEach((raw, i) => {
    const text = trimBlankLines(raw);
    if (i === caretPart) focusIndex = parts.length;
    if (text === '' && i < rawParts.length - 1) return;
    parts.push(text);
  });
  focusIndex = Math.min(focusIndex, parts.length - 1);

  const replacements = parts.map((text, i) => (i === 0 ? { ...tweet, text } : toLocalTweet({ text, media: [] })));
  // People type `---⏎`: the split already happened on the third dash, so the
  // Enter that follows would only put a blank line at the top of the new card.
  if (parts[focusIndex] === '') replacements[focusIndex].swallowEnter = true;
  ed.tweets.splice(index, 1, ...replacements);
  renderCards({ index: index + focusIndex, start: 0, end: 0 });
  markDirty();
}

function onTextKeydown(e, key, textarea) {
  const tweet = findTweet(key);
  if (tweet?.swallowEnter) {
    tweet.swallowEnter = false;
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      return;
    }
  }
  // Only a truly empty card goes: one still carrying images (or uploads in
  // flight) is left alone, since removing it would delete those images.
  const empty = textarea.value === '' && tweet && tweet.media.length === 0 && tweet.pending.length === 0;
  if (e.key === 'Backspace' && empty && !textarea.readOnly && indexOfKey(key) > 0) {
    e.preventDefault();
    removeCard(key, { silent: true, focusPrevious: true });
  }
}

function addCard() {
  if (isReadOnly()) return;
  state.editor.tweets.push(toLocalTweet({ text: '', media: [] }));
  renderCards({ index: state.editor.tweets.length - 1 });
  markDirty();
}

async function removeCard(key, { silent = false, focusPrevious = false } = {}) {
  const ed = state.editor;
  const index = indexOfKey(key);
  if (index < 0 || ed.tweets.length < 2 || isLocked(key)) return;
  // Activated from the card's ✕: keep the keyboard on a ✕ afterwards rather
  // than dropping it into a textarea, where the next Enter would type.
  const viaRemoveButton = document.activeElement?.matches('.card-remove') ?? false;
  const tweet = ed.tweets[index];
  const hasStuff = tweet.text.trim() || tweet.media.length || tweet.pending.length;
  if (hasStuff && !silent) {
    const ok = await confirmDialog({
      title: `Remove post ${index + 1}?`,
      message: 'Its text and images will be discarded.',
      okLabel: 'Remove',
      danger: true,
    });
    if (!ok || indexOfKey(key) < 0 || ed !== state.editor) return;
  }
  const at = indexOfKey(key);
  const [removed] = ed.tweets.splice(at, 1);
  const focusIndex = focusPrevious ? Math.max(0, at - 1) : Math.min(at, ed.tweets.length - 1);
  renderCards(viaRemoveButton ? null : { index: focusIndex });
  if (viaRemoveButton) focusRemoveButton(focusIndex);
  markDirty();
  releaseMedia(removed.media.map((m) => m.id));
}

/** After a ✕ removed a card: the ✕ of the card now in its place, or its textarea once the thread is down to one post. */
function focusRemoveButton(index) {
  const card = dom.cards.children[index];
  (card?.querySelector('.card-remove') ?? card?.querySelector('textarea'))?.focus();
}

function moveCard(key, delta) {
  const ed = state.editor;
  const from = indexOfKey(key);
  const to = from + delta;
  const locked = lockedCount(ed.draft);
  if (from < locked || to < locked || to >= ed.tweets.length) return;
  const tool = activeToolIndex(key);
  const focused = captureFocus();
  const [tweet] = ed.tweets.splice(from, 1);
  ed.tweets.splice(to, 0, tweet);
  // The keyboard stays on the arrow it pressed (now on the moved card) so the
  // next Enter moves the post again instead of typing a newline into it.
  renderCards(focused?.key === key ? focused : tool === null ? { key } : null);
  if (tool !== null) focusTool(key, tool);
  markDirty();
}

/** Position of the focused button among its card's tools, when that card is `key`'s; else null. */
function activeToolIndex(key) {
  const active = document.activeElement;
  if (!active?.matches('.card-tools .tool') || active.closest('.card')?.dataset.key !== key) return null;
  return Array.prototype.indexOf.call(active.closest('.card-tools').children, active);
}

/** Focus the same tool of a re-rendered card; an arrow that got disabled (first/last card) hands over to the other arrow. */
function focusTool(key, index) {
  const card = cardFor(key);
  const tools = Array.from(card?.querySelectorAll('.card-tools .tool') ?? []);
  let target = tools[index];
  if (target?.disabled) target = tools.find((tool, i) => i !== index && !tool.disabled && /^Move post/.test(tool.getAttribute('aria-label') ?? ''));
  (target ?? card?.querySelector('textarea'))?.focus();
}

let dragKey = null;

function wireDragAndDrop(card, handle, key) {
  handle.addEventListener('dragstart', (e) => {
    dragKey = key;
    e.dataTransfer.setData(DRAG_TYPE, key);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setDragImage(card, 24, 24);
    card.classList.add('dragging');
  });
  handle.addEventListener('dragend', () => {
    dragKey = null;
    card.classList.remove('dragging');
    clearDropMarkers();
  });
  card.addEventListener('dragover', (e) => {
    if (dragKey && dragKey !== key) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const below = isLowerHalf(card, e);
      card.classList.toggle('drop-after', below);
      card.classList.toggle('drop-before', !below);
    } else if (!dragKey && hasFiles(e) && !isReadOnly()) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      card.classList.add('drop-image');
    }
  });
  card.addEventListener('dragleave', (e) => {
    if (!card.contains(e.relatedTarget)) card.classList.remove('drop-before', 'drop-after', 'drop-image');
  });
  card.addEventListener('drop', (e) => {
    card.classList.remove('drop-before', 'drop-after', 'drop-image');
    const source = dragKey ?? e.dataTransfer.getData(DRAG_TYPE);
    if (source && source !== key) {
      e.preventDefault();
      reorderCards(source, key, isLowerHalf(card, e));
    } else if (!source && hasFiles(e) && !isReadOnly()) {
      e.preventDefault();
      addImages(key, e.dataTransfer.files);
    }
  });
}

function hasFiles(e) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

function isLowerHalf(card, e) {
  const rect = card.getBoundingClientRect();
  return e.clientY > rect.top + rect.height / 2;
}

function clearDropMarkers() {
  for (const node of dom.cards.querySelectorAll('.drop-before, .drop-after, .drop-image')) {
    node.classList.remove('drop-before', 'drop-after', 'drop-image');
  }
}

function reorderCards(sourceKey, targetKey, after) {
  const ed = state.editor;
  const from = indexOfKey(sourceKey);
  const locked = lockedCount(ed.draft);
  if (from < locked || indexOfKey(targetKey) < 0) return;
  const [tweet] = ed.tweets.splice(from, 1);
  // Never ahead of a post already on X (locked cards take no drops, but the target's upper half sits right on the line).
  const to = Math.max(locked, Math.min(indexOfKey(targetKey) + (after ? 1 : 0), ed.tweets.length));
  ed.tweets.splice(to, 0, tweet);
  renderCards();
  markDirty();
}

// ---------------------------------------------------------------------------
// Editor: images
// ---------------------------------------------------------------------------

function pickImages(key) {
  dom.fileInput.dataset.key = key;
  dom.fileInput.value = '';
  dom.fileInput.click();
}

function onFilePicked() {
  const key = dom.fileInput.dataset.key;
  if (key && dom.fileInput.files.length) addImages(key, dom.fileInput.files);
}

function onPaste(e, key) {
  if (isReadOnly()) return;
  const files = Array.from(e.clipboardData?.items ?? [])
    .filter((item) => item.kind === 'file' && ACCEPTED_TYPES.includes(item.type))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (files.length === 0) return;
  e.preventDefault();
  addImages(key, files);
}

/** Check the client-side limits, show optimistic thumbnails, and upload each file. */
function addImages(key, fileList) {
  const ed = state.editor;
  const tweet = findTweet(key);
  if (!tweet || isReadOnly() || isLocked(key)) return;
  const files = Array.from(fileList);
  const accepted = files.filter((file) => ACCEPTED_TYPES.includes(file.type));
  if (accepted.length < files.length) toast('Only PNG, JPEG, GIF and WebP images can be attached.', { kind: 'error' });
  for (const file of accepted) {
    const attached = [...tweet.media, ...tweet.pending];
    if (attached.some((m) => m.type === 'image/gif') || (file.type === 'image/gif' && attached.length > 0)) {
      toast('A GIF must be the only attachment on a post.', { kind: 'error' });
      break;
    }
    if (attached.length >= MAX_MEDIA) {
      toast(`A post can have at most ${MAX_MEDIA} images.`, { kind: 'error' });
      break;
    }
    const pending = { key: uid(), name: file.name, type: file.type, objectUrl: URL.createObjectURL(file) };
    tweet.pending.push(pending);
    uploadImage(ed, key, pending, file);
  }
  renderMedia(key);
}

/** Upload one file for a card of editor `ed`, which may no longer be the open one by the time it lands. */
async function uploadImage(ed, key, pending, file) {
  let media = null;
  try {
    media = await api.uploadMedia(file);
  } catch (err) {
    toast(`Upload of ${file.name || 'image'} failed: ${err.message}`, { kind: 'error' });
  }
  const tweet = ed.tweets.find((t) => t.key === key) ?? null;
  if (tweet) {
    tweet.pending = tweet.pending.filter((p) => p.key !== pending.key);
    if (media) tweet.media.push({ id: media.id, url: media.url, name: media.name, type: media.type, size: media.size, alt: '' });
    if (state.editor === ed) {
      if (media) markDirty();
      renderMedia(key);
    } else if (media) {
      saveDetachedEditor(ed); // the user moved on: the image still belongs to the draft it was dropped on
    }
  } else if (media) {
    api.deleteMedia(media.id).catch(noop); // the card vanished mid-upload
  }
  URL.revokeObjectURL(pending.objectUrl);
}

/**
 * An upload finished after the user opened another draft. The editor it was
 * attached to is gone from the screen, so its autosave will never carry the
 * image: save that draft straight to the server instead of dropping the file.
 */
async function saveDetachedEditor(ed) {
  await ed.savePromise; // the flush of that editor may still be creating the draft (runSave never rejects)
  const tweets = serializeTweets(ed.tweets);
  try {
    const draft = ed.draft ? await api.updateDraft(ed.draft.id, { tweets }) : await api.createDraft({ tweets });
    ed.draft = draft;
    applyDraftToLists(draft);
    refreshStatus();
  } catch (err) {
    toast(`The image could not be saved to “${firstLine(ed.tweets) || 'the draft you left'}”: ${err.message}`, { kind: 'error' });
  }
}

async function editAlt(key, mediaId) {
  const media = findTweet(key)?.media.find((m) => m.id === mediaId);
  if (!media) return;
  const alt = await promptDialog({
    title: 'Image description',
    message: 'Alt text is read by screen readers and shown when the image cannot load.',
    label: 'Alt text',
    value: media.alt || '',
    placeholder: 'Describe the image',
    maxLength: 1000,
  });
  if (alt === null) return;
  media.alt = alt.trim();
  renderMedia(key);
  markDirty();
}

function removeImage(key, mediaId) {
  const tweet = findTweet(key);
  if (!tweet) return;
  tweet.media = tweet.media.filter((m) => m.id !== mediaId);
  renderMedia(key);
  markDirty();
  releaseMedia([mediaId]);
}

/** Delete media on the server once the draft has been saved without it. */
function releaseMedia(ids) {
  if (ids.length === 0) return;
  saveNow()
    .then(() => Promise.allSettled(ids.map((id) => api.deleteMedia(id))))
    .catch(noop);
}

// ---------------------------------------------------------------------------
// Editor: autosave
// ---------------------------------------------------------------------------

let saveTimer = null;

function markDirty() {
  const ed = state.editor;
  ed.dirty = true;
  ed.error = null;
  renderSaveStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow().catch(noop), AUTOSAVE_MS);
}

/** Save now (creating the draft on first use). Resolves when every queued save has finished. */
function saveNow() {
  const ed = state.editor;
  clearTimeout(saveTimer);
  if (ed.saving) {
    ed.queued = true;
    return ed.savePromise;
  }
  if (!ed.dirty) return Promise.resolve();
  ed.savePromise = runSave(ed);
  return ed.savePromise;
}

async function runSave(ed, { afterConflict = false } = {}) {
  ed.saving = true;
  renderSaveStatus();
  let conflict = false;
  try {
    do {
      ed.queued = false;
      ed.dirty = false;
      if (ed.draft && READ_ONLY_STATUSES.includes(ed.draft.status)) {
        throw new ApiError('Already posted — duplicate it to edit.', 409); // the server would refuse it too
      }
      const tweets = serializeTweets(ed.tweets);
      const draft = ed.draft
        ? await api.updateDraft(ed.draft.id, { tweets })
        : await createDraftFromEditor(ed, tweets);
      if (state.editor !== ed) return; // the user switched drafts; the request still carried the latest text
      ed.draft = draft;
      ed.savedAt = draft.updatedAt;
      ed.error = null;
      ed.lastToastedError = null;
      applyDraftToLists(draft);
    } while (ed.queued || ed.dirty);
  } catch (err) {
    if (state.editor !== ed) return;
    ed.dirty = true;
    ed.error = err.message;
    // A 409 means the server's copy moved on under us; recoverFromConflict explains it once it knows how.
    conflict = err.status === 409 && Boolean(ed.draft) && !afterConflict;
    if (!conflict && ed.lastToastedError !== err.message) toastError(err); // do not repeat the same failure on every keystroke burst
    ed.lastToastedError = err.message;
  } finally {
    ed.saving = false;
    if (state.editor === ed) renderSaveStatus();
  }
  if (conflict) await recoverFromConflict(ed);
}

/**
 * The server refused the save because the draft changed state elsewhere:
 * it was posted (or is being posted), or its first posts went out to X in
 * a publish that failed part-way. Sitting on "Not saved" would block every
 * later save and Retry, so fetch the server's copy, keep what is still
 * editable (the posts after the locked head, with the local edits), and save
 * that instead.
 */
async function recoverFromConflict(ed) {
  ed.saving = true; // a keystroke meanwhile queues behind this instead of starting a second recovery
  renderSaveStatus();
  let draft;
  try {
    draft = await api.getDraft(ed.draft.id);
  } catch (err) {
    ed.saving = false;
    if (state.editor !== ed) return;
    renderSaveStatus();
    if (err.status === 404) onDraftDeleted(ed.draft.id);
    return;
  }
  ed.saving = false;
  if (state.editor !== ed) return;
  if (READ_ONLY_STATUSES.includes(draft.status)) {
    toast(draft.status === 'posted'
      ? 'This thread was posted meanwhile, so your unsaved edits were dropped — duplicate it to edit.'
      : 'This thread is being published, so your unsaved edits were dropped.', { kind: 'error' });
    reloadOpenDraft(draft); // read-only now: the record is shown as it went out
    return;
  }
  const locked = lockedCount(draft);
  if (locked > 0) {
    ed.tweets = [...draft.tweets.slice(0, locked).map(toLocalTweet), ...ed.tweets.slice(locked)];
    toast(`${locked === 1 ? 'Post 1 is' : `Posts 1–${locked} are`} already on X and cannot be changed — the posted text was restored; the rest of your edits are kept.`, { kind: 'error' });
  }
  adoptDraft(draft);
  ed.error = null;
  ed.lastToastedError = null;
  ed.dirty = true;
  renderEditor();
  ed.savePromise = runSave(ed, { afterConflict: true });
  await ed.savePromise;
}

/**
 * First save of a brand-new draft: create it and, while the editor is still
 * showing it as the unsaved "#/drafts" draft, move the route to its id without
 * a reload. When the user has meanwhile gone elsewhere (the queue, another
 * draft), the route, URL and stored route belong to that view and stay put.
 */
async function createDraftFromEditor(ed, tweets) {
  const draft = await api.createDraft({ tweets });
  ed.draft = draft; // also when the editor was replaced meanwhile: an upload still landing on it needs the id
  if (state.editor === ed) {
    if (state.route.view === 'drafts') {
      state.route = { view: 'draft', id: draft.id };
      history.replaceState(null, '', `#/draft/${draft.id}`);
      writeStorage(STORAGE_KEYS.route, `#/draft/${draft.id}`);
    }
    renderChrome();
    refreshStatus();
  }
  return draft;
}

/** Make sure the editor's draft exists on the server with the current text; returns it. */
async function ensureSaved() {
  const ed = state.editor;
  if (hasPendingUploads(ed)) throw new Error('Wait for the image uploads to finish.');
  dropTrailingEmptyCards(ed);
  if (!ed.draft) ed.dirty = true;
  if (ed.dirty || ed.saving) await saveNow();
  if (ed.error) throw new Error(ed.error);
  if (!ed.draft) throw new Error('The draft could not be saved.');
  return ed.draft;
}

/**
 * Before the thread goes out: the empty card `---` leaves for the caret is
 * scaffolding, not "Post 2 is empty". Empty cards in the middle stay (and
 * fail validation), since dropping those would rewrite the thread.
 */
function dropTrailingEmptyCards(ed) {
  const kept = withoutTrailingEmpty(ed.tweets);
  if (kept === ed.tweets) return;
  const focused = captureFocus();
  ed.tweets = kept;
  renderCards(focused && kept.some((t) => t.key === focused.key) ? focused : { index: kept.length - 1 });
  ed.dirty = true;
}

function saveStatusText() {
  const ed = state.editor;
  if (ed.error) return `Not saved — ${ed.error}`;
  if (ed.saving) return 'Saving…';
  // Once a thread is out, the last edit is history: say what happened to it instead.
  const status = editorStatus();
  if (status === 'publishing') return 'Publishing…';
  if (status === 'posted') return ed.draft.postedAt ? `Posted ${formatDateTime(ed.draft.postedAt)}` : 'Posted';
  if (ed.dirty) return 'Unsaved changes';
  if (!ed.draft) return 'Not saved yet';
  return `Saved ${formatRelative(ed.savedAt)}`;
}

function renderSaveStatus() {
  const ed = state.editor;
  const text = saveStatusText();
  const node = dom.actionbar.querySelector('.save-status');
  if (node) {
    node.textContent = text;
    node.title = ed.error ? text : ''; // the full reason, whatever the bar has room for
    node.className = `save-status ${ed.error ? 'error' : ed.saving || ed.dirty ? 'saving' : ''}`;
  }
  const coarse = COARSE_QUERY.matches;
  dom.focusIndicator.textContent = `${text} · ${coarse ? 'Tap to exit' : 'Esc to exit'}`;
  dom.focusIndicator.title = coarse ? 'Leave focus mode' : 'Leave focus mode (Esc)';
}

// ---------------------------------------------------------------------------
// Editor: banner and action bar
// ---------------------------------------------------------------------------

function renderBanner() {
  const draft = state.editor.draft;
  const node = draft && BANNERS[editorStatus()]?.(draft);
  if (node) dom.banner.replaceChildren(node);
  else dom.banner.replaceChildren();
}

/** One line for the scheduled/due/failed banners of a thread whose first posts are already on X (or null). */
function lockedLine(draft) {
  const copy = lockedCopy(draft);
  return copy && `${copy.title} ${copy.detail}`;
}

const BANNERS = {
  /** A plain draft only gets a banner when it carries posts already on X ("Back to drafts" after a partial publish). */
  draft(draft) {
    const copy = lockedCopy(draft);
    return copy && banner('locked', [copy.title, copy.detail], [button('Duplicate', () => duplicateDraft(draft.id))]);
  },
  scheduled(draft) {
    const manual = draft.mode === 'manual';
    // The mode is a badge after the time: a trailing "· reminder" wrapped onto a line of its own beside the buttons.
    const title = [`Scheduled for ${formatDateTime(draft.scheduledAt)}`, ' ', el('span', { class: 'badge' }, manual ? 'Reminder' : 'X API')];
    return banner('scheduled', [title, manual && reminderHint(), lockedLine(draft)], [
      manual && notificationState() === 'default'
        && button('Enable notifications', () => requestNotifications(), { primary: true }),
      button('Reschedule', (e) => openSchedulePopover(e.currentTarget, draft), { hasPopup: true }),
      button('Unschedule', () => unscheduleDraft(draft.id)),
    ]);
  },
  due(draft) {
    return banner('due', ["It's time to post this.", 'Copy each post, paste it on X, then mark it as posted.', lockedLine(draft)], [
      button(stepperLabel(), () => copyPostStep(), { primary: true }),
      button('Mark as posted', () => markPosted(draft.id), { className: 'btn-success' }),
      button('Snooze to next free slot', () => snoozeDraft(draft.id)),
    ]);
  },
  publishing() {
    return banner('publishing', ['Publishing…', 'The posts are being sent to X. This view updates by itself.'], []);
  },
  failed(draft) {
    const node = banner('failed', ['Publishing failed.', lockedLine(draft)], [
      button(retryLabel(draft), () => retryDraft(draft.id), { primary: true }),
      button('Copy thread', () => copyThread()),
      button('Back to drafts', () => unscheduleDraft(draft.id)),
    ]);
    node.querySelector('.banner-text').append(el('div', { class: 'banner-error' }, draft.result?.error || 'Unknown error'));
    return node;
  },
  posted(draft) {
    const url = safeUrl(draft.result?.url);
    const headline = draft.result?.manual ? 'Marked as posted' : 'Posted to X';
    const when = draft.postedAt ? ` · ${formatDateTime(draft.postedAt)}` : '';
    const node = banner('posted', [headline + when], [button('Duplicate', () => duplicateDraft(draft.id))]);
    if (url) node.querySelector('.banner-text').append(el('div', { class: 'banner-sub' }, el('a', { href: url, target: '_blank', rel: 'noopener' }, url)));
    return node;
  },
};

/** "Copy post i of N" for the due banner's stepper, counting the cards on screen (one added while due counts too). */
function stepperLabel() {
  const total = state.editor.tweets.length;
  return `Copy post ${(state.editor.copyStep % total) + 1} of ${total}`;
}

/** "Retry", or "Retry from post k+1" when the first k posts are already on X: nothing is posted twice. */
function retryLabel(draft) {
  const k = lockedCount(draft);
  return k > 0 ? `Retry from post ${k + 1}` : 'Retry';
}

function banner(kind, [title, ...subs], actions) {
  return el('div', { class: `banner ${kind}`, role: kind === 'failed' || kind === 'due' ? 'alert' : null },
    el('div', { class: 'banner-text' }, el('div', { class: 'banner-title' }, title), subs.filter(Boolean).map((s) => el('div', { class: 'banner-sub' }, s))),
    el('div', { class: 'banner-actions' }, actions));
}

/** How a reminder will reach the user, given the notification permission (shown on the scheduled banner). */
function reminderHint() {
  switch (notificationState()) {
    case 'granted':
      return 'A browser notification will pop up at that time (keep a tab open); then copy each post to X and mark it as posted.';
    case 'default':
      return 'Enable notifications to be alerted at that time. Without them the reminder only shows in this tab while it is open.';
    case 'denied':
      return 'Notifications are blocked for this site, so the reminder only shows in this tab while it is open. Allow them in the browser settings to be alerted.';
    default:
      return 'This browser cannot show notifications, so the reminder only shows in this tab while it is open.';
  }
}

function renderActionBar() {
  const ed = state.editor;
  const status = editorStatus();
  const configured = Boolean(state.status?.configured);
  const canSchedule = SCHEDULABLE_STATUSES.includes(status);
  // A failed thread is re-sent from its banner ("Retry from post k+1", next to
  // Copy thread): the bar only adds the option of queueing that retry for
  // later, not a second Publish now and a second Copy thread to choose between.
  const failed = status === 'failed';
  const locked = lockedCount(ed.draft);
  const scheduleLabel = failed ? 'Schedule retry' : status === 'scheduled' || status === 'due' ? 'Reschedule' : 'Schedule';
  const scheduleTitle = !failed ? 'Ctrl/Cmd+Enter adds it to the next free slot'
    : locked > 0 ? `Queue the retry for a later time — it continues from post ${locked + 1}` : 'Queue the retry for a later time';
  const right = el('div', { class: 'actionbar-right' },
    !failed && button('Copy thread', () => copyThread(), { size: 'md', ariaLabel: 'Copy the whole thread to the clipboard' }),
    canSchedule && button([scheduleLabel, el('span', { class: 'caret', 'aria-hidden': 'true' }, '▾')],
      (e) => openSchedulePopover(e.currentTarget, state.editor.draft),
      { size: 'md', primary: status === 'draft', hasPopup: true, ariaLabel: scheduleLabel, title: scheduleTitle }),
    canSchedule && configured && !failed && button('Publish now', () => publishNow(), { size: 'md' }),
    ed.draft && button('⋯', (e) => openOverflowMenu(e.currentTarget), { size: 'md', hasPopup: true, ariaLabel: 'More actions' }));
  dom.actionbar.replaceChildren(el('div', { class: 'actionbar-inner' },
    el('div', { class: 'actionbar-left' },
      el('span', { class: 'save-status' }),
      el('span', { class: 'dot', 'aria-hidden': 'true' }, '·'),
      el('span', { class: 'post-count' }, postCountLabel(ed.tweets.length))),
    right));
  renderSaveStatus();
}

function openOverflowMenu(anchor) {
  const draft = state.editor.draft;
  if (!draft) return;
  openPopover(anchor, el('div', { class: 'menu', role: 'menu' },
    el('button', { type: 'button', class: 'menu-item', role: 'menuitem', onclick: () => { closePopover(); attempt(() => duplicateDraft(draft.id)); } }, 'Duplicate'),
    el('button', { type: 'button', class: 'menu-item danger', role: 'menuitem', onclick: () => { closePopover(); attempt(() => deleteDraft(draft.id)); } }, 'Delete…')));
}

// ---------------------------------------------------------------------------
// Editor: scheduling and other actions
// ---------------------------------------------------------------------------

/**
 * Schedule popover: next free slot or a custom time, plus the mode. `draft` is
 * null for a not-yet-created editor draft (it gets created on submit).
 */
async function openSchedulePopover(anchor, draft) {
  const isEditorDraft = !draft || draft.id === state.editor.draft?.id;
  if (isEditorDraft && !editorReady()) return;
  const configured = Boolean(state.status?.configured);
  const mode = defaultModeFor(draft);
  // An item already in the queue is being moved, not added: the popover says so
  // and names the time it holds (which "next free slot" may hand back, since the
  // server treats the item's own slot as free for it).
  const rescheduling = Boolean(draft && (draft.status === 'scheduled' || draft.status === 'due'));
  const nextLabel = el('span', {}, 'finding the next free slot…');
  const nextRadio = el('input', { type: 'radio', name: 'when', value: 'next', checked: true });
  const customRadio = el('input', { type: 'radio', name: 'when', value: 'custom' });
  const timeInput = el('input', {
    type: 'datetime-local', name: 'at', 'aria-label': 'Date and time',
    min: toLocalInputValue(Date.now()), value: toLocalInputValue(defaultCustomTime()),
    onfocus: () => { customRadio.checked = true; },
    oninput: () => { customRadio.checked = true; },
  });
  const apiRadio = el('input', { type: 'radio', name: 'mode', value: 'api', checked: mode === 'api', disabled: !configured });
  const manualRadio = el('input', { type: 'radio', name: 'mode', value: 'manual', checked: mode === 'manual' });
  const form = el('form', { class: 'schedule-form', 'aria-label': rescheduling ? 'Reschedule' : 'Schedule' },
    rescheduling && el('p', { class: 'schedule-current' },
      draft.status === 'due' ? `Due since ${formatDateTime(draft.scheduledAt)}` : `Currently scheduled for ${formatDateTime(draft.scheduledAt)}`),
    el('fieldset', {}, el('legend', {}, 'When'),
      el('label', { class: 'choice' }, nextRadio, el('span', { class: 'choice-body' }, 'Next free slot — ', nextLabel)),
      el('label', { class: 'choice' }, customRadio, el('span', { class: 'choice-body' }, 'Pick a time', timeInput))),
    el('fieldset', {}, el('legend', {}, 'How'),
      el('label', { class: `choice ${configured ? '' : 'disabled'}` }, apiRadio,
        el('span', { class: 'choice-body' }, 'Publish via X API',
          !configured && el('small', {}, 'Not configured — add the four X_* keys to .env and restart.'))),
      el('label', { class: 'choice' }, manualRadio,
        el('span', { class: 'choice-body' }, "Remind me (I'll post it myself)",
          el('small', {}, notificationState() === 'granted'
            ? 'Browser notification at slot time, then copy and paste on X.'
            : 'Reminder at slot time (enable notifications to be alerted in the background), then copy and paste on X.')))),
    el('button', { type: 'submit', class: 'btn btn-primary' }, rescheduling ? 'Reschedule' : 'Add to queue'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = { mode: apiRadio.checked ? 'api' : 'manual' };
    if (customRadio.checked) {
      const at = new Date(timeInput.value).getTime();
      if (!timeInput.value || Number.isNaN(at)) return toast('Pick a date and time.', { kind: 'error' });
      if (at < Date.now() - 60_000) return toast('That time is in the past.', { kind: 'error' });
      body.at = at;
    } else {
      body.nextFree = true;
    }
    closePopover();
    return attempt(() => scheduleDraft(draft, body));
  });
  openPopover(anchor, form);

  try {
    const { at } = await api.nextSlot(draft?.id);
    nextLabel.textContent = !at ? 'none available — add slots to config.json'
      : rescheduling && at === draft.scheduledAt ? `${formatDateTime(at)} (its current slot)` : formatDateTime(at);
    if (!at) {
      nextRadio.disabled = true;
      customRadio.checked = true;
    }
  } catch (err) {
    nextLabel.textContent = `unavailable (${err.message})`;
  }
}

/**
 * Default for "Pick a time": the top of the hour after next, in the browser's
 * local time. Rounding epoch milliseconds to the hour lands on the half (or
 * quarter) hour in a +05:30, +05:45 or +09:30 zone; Date's setters carry the
 * local offset, DST changes included.
 */
function defaultCustomTime() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 2);
  return d.getTime();
}

/** POST /schedule for a draft (the editor's, saved first, when it is the open one) and sync the UI. */
async function scheduleDraft(draft, body) {
  let id = draft?.id;
  if (!id || id === state.editor.draft?.id) id = (await ensureSaved()).id;
  const updated = await api.schedule(id, body);
  syncDraft(updated);
  announceScheduled(updated, draft);
}

/**
 * "Scheduled for …", and for a reminder that cannot reach the user as a
 * browser notification, say so right away rather than at slot time. A
 * reschedule that landed on the same time and mode is not a success to report.
 */
function announceScheduled(draft, previous = null) {
  const unchanged = previous?.status === 'scheduled' && previous.scheduledAt === draft.scheduledAt && previous.mode === draft.mode;
  if (unchanged) {
    toast(`Unchanged — still scheduled for ${formatDateTime(draft.scheduledAt)}`);
    return;
  }
  toast(`Scheduled for ${formatDateTime(draft.scheduledAt)}`, { kind: 'success' });
  if (draft.mode !== 'manual') return;
  const permission = notificationState();
  if (permission === 'granted') return;
  if (permission === 'default') {
    const bannerShown = isEditorView() && state.editor.draft?.id === draft.id;
    toast(`Enable notifications to be alerted at that time — ${bannerShown ? 'see the banner above' : 'the button is in the sidebar footer'}.`, { duration: 6000 });
  } else {
    toast('Notifications are off in this browser, so the reminder only shows while a tab is open.', { duration: 6000 });
  }
}

/** Ctrl/Cmd+Enter: straight to the next free slot with the default mode. */
function quickSchedule() {
  const ed = state.editor;
  if (!SCHEDULABLE_STATUSES.includes(editorStatus())) return;
  if (!editorReady()) return;
  attempt(() => scheduleDraft(ed.draft, { nextFree: true, mode: defaultModeFor(ed.draft) }));
}

async function unscheduleDraft(id) {
  syncDraft(await api.unschedule(id));
  toast('Moved back to drafts.');
}

async function snoozeDraft(id) {
  if (state.editor.draft?.id === id) await ensureSaved(); // an edit made while due goes with it
  const updated = await api.schedule(id, { nextFree: true, mode: 'manual' });
  syncDraft(updated);
  toast(`Snoozed until ${formatDateTime(updated.scheduledAt)}`);
}

async function retryDraft(id) {
  if (state.editor.draft?.id === id) await ensureSaved(); // the retry publishes what the server holds
  const updated = await whilePublishing(id, () => api.retry(id));
  syncDraft(updated);
  toastPublishOutcome(updated);
}

async function markPosted(id) {
  // The stepper copied the text as it is on screen: a typo fixed just before
  // must reach the record too, not be dropped once the thread is read-only.
  if (state.editor.draft?.id === id) await ensureSaved();
  const url = await promptDialog({
    title: 'Mark as posted',
    message: 'Optionally paste the link to the post on X.',
    label: 'Post URL (optional)',
    type: 'url',
    placeholder: 'https://x.com/…',
    okLabel: 'Mark as posted',
  });
  if (url === null) return;
  syncDraft(await api.markPosted(id, url.trim() ? { url: url.trim() } : {}));
  toast('Marked as posted.', { kind: 'success' });
}

/** Publish through the API right away; `draft` is null for the open editor draft. */
async function publishNow(draft = null) {
  if (!draft && !editorReady()) return; // before a dialog opens or an "Empty draft" gets created for it
  const target = draft ?? (await ensureSaved());
  const count = draft ? draft.tweets.length : state.editor.tweets.length;
  const locked = lockedCount(target); // posts already on X from an earlier attempt: they stay, the rest follows them
  const ok = await confirmDialog({
    title: 'Publish now?',
    message: locked > 0
      ? `${locked === 1 ? 'Post 1 is' : `Posts 1–${locked} are`} already on X. The remaining ${postCountLabel(count - locked)} will be posted through the API right away, continuing that thread from post ${locked + 1}.`
      : `${postCountLabel(count)} will be posted to X through the API right away.`,
    okLabel: 'Publish',
  });
  if (!ok) return;
  const updated = await whilePublishing(target.id, () => api.publish(target.id));
  syncDraft(updated);
  toastPublishOutcome(updated);
}

/**
 * Show the read-only "Publishing…" state while a publish/retry request runs:
 * the server only answers once the whole thread is posted (seconds, with
 * images) and no event announces the intermediate status. It is a flag on the
 * editor rather than a status copied into the draft because the retry route's
 * interim "scheduled" write does arrive as a `draft.updated` echo meanwhile.
 */
async function whilePublishing(id, action) {
  const ed = state.editor;
  const mine = ed.draft?.id === id;
  if (mine) {
    ed.publishing = true;
    renderEditor(null);
  }
  try {
    return await action();
  } catch (err) {
    if (mine) {
      ed.publishing = false;
      if (state.editor === ed) renderEditor(); // back to the banner and buttons it had
    }
    throw err;
  } finally {
    if (mine) ed.publishing = false;
  }
}

/** Same wording as the SSE announcements, so the two collapse into one toast. */
function toastPublishOutcome(draft) {
  if (draft.status === 'posted') toast(`Posted to X: ${firstLine(draft.tweets) || 'thread'}`, { kind: 'success' });
  else if (draft.status === 'failed') announcePublishFailure(draft);
  else toast('Publishing…');
}

/**
 * The failed banner (and the Posted view) carry the full error, so the toast
 * stays short — and reads the same whether it comes from our own request or
 * from the SSE event, so the two collapse into one instead of stacking two
 * copies of a 400-character X error over the Retry button.
 */
function announcePublishFailure(draft) {
  const bannerShown = isEditorView() && state.editor.draft?.id === draft.id;
  const error = draft.result?.error || 'Unknown error';
  toast(bannerShown ? 'Publishing failed — see the banner for details.' : `Publishing failed: ${truncate(error, 160)}`, { kind: 'error' });
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function duplicateDraft(id) {
  const copy = await api.duplicateDraft(id);
  applyDraftToLists(copy);
  refreshStatus();
  navigate(`#/draft/${copy.id}`);
  toast('Duplicated — you are now editing the copy.');
}

async function deleteDraft(id) {
  const ok = await confirmDialog({
    title: 'Delete this draft?',
    message: 'This cannot be undone. Attached images are removed too.',
    okLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  await api.deleteDraft(id);
  removeDraftFromLists(id);
  refreshStatus();
  if (state.editor.draft?.id === id) clearEditorAfterRemoval();
  if (state.route.view === 'queue') loadQueue();
  toast('Draft deleted.');
}

/** The open draft no longer exists: start a fresh one (and show it if the editor is visible). */
function clearEditorAfterRemoval() {
  state.editor = createEditorState(null);
  renderEditor(isEditorView() ? { index: 0 } : null);
  if (isEditorView()) navigate('#/drafts');
}

function copyThread(draft = null) {
  const tweets = withoutTrailingEmpty(draft ? draft.tweets : state.editor.tweets);
  return copyWithToast(threadToClipboardText(tweets), `Thread copied (${postCountLabel(tweets.length)})`);
}

function copyPost(index) {
  const tweets = state.editor.tweets;
  return copyWithToast(tweets[index].text, `Copied post ${index + 1} of ${tweets.length}`);
}

/** Due-banner stepper: copy the current post and advance to the next one. */
async function copyPostStep() {
  const ed = state.editor;
  const total = ed.tweets.length;
  const index = ed.copyStep % total;
  if (!(await copyText(ed.tweets[index].text))) {
    toast('Could not copy — the browser blocked clipboard access.', { kind: 'error' });
    return;
  }
  ed.copyStep = index + 1;
  toast(index + 1 === total
    ? `Copied post ${total} of ${total} — the last one. Mark it as posted when done.`
    : `Copied post ${index + 1} of ${total}`, { kind: 'success' });
  renderBanner();
  dom.banner.querySelector('.btn-primary')?.focus();
}

// ---------------------------------------------------------------------------
// Queue view
// ---------------------------------------------------------------------------

async function loadQueue() {
  try {
    state.queue = await api.queue();
    renderQueue();
  } catch (err) {
    dom.viewQueue.replaceChildren(el('div', { class: 'page' }, el('div', { class: 'list-empty' }, `Could not load the queue: ${err.message}`)));
  }
}

function renderQueue() {
  const queue = state.queue;
  if (!queue) return;
  const now = Date.now();
  const todayKey = dateKeyIn(now, configTimezone());
  const attention = [];
  const days = [];
  for (const day of queue.days) {
    const entries = [];
    for (const entry of day.entries) {
      if (needsAttention(entry, now)) attention.push(entry); // listed once, at the top, not in its day as well
      else if (entry.draft || entry.at >= now) entries.push(entry); // past empty slots are useless
    }
    if (day.date < todayKey && entries.length === 0) continue;
    days.push({ ...day, entries });
  }
  dom.viewQueue.replaceChildren(el('div', { class: 'page' },
    el('div', { class: 'page-head' },
      el('h2', {}, 'Queue'),
      el('span', { class: 'page-sub' }, `Times shown in ${BROWSER_TZ}`)),
    attention.length > 0 && el('section', { class: 'attention', 'aria-label': 'Needs attention' },
      el('h3', {}, 'Needs attention'),
      el('ul', { class: 'entries' }, attention.map((entry) => buildEntry(entry, now, true)))),
    days.length === 0
      ? el('div', { class: 'list-empty' }, 'No slots coming up. Add slots to config.json.')
      : days.map((day) => buildDay(day, todayKey, now))));
}

function needsAttention(entry, now) {
  const status = entry.draft?.status;
  return status === 'due' || (status === 'scheduled' && isOverdue(entry.at, now));
}

/** Scheduled for more than a minute ago and still not picked up by the scheduler. */
function isOverdue(at, now) {
  return at < now - 60_000;
}

function buildDay(day, todayKey, now) {
  const label = dayLabel(day);
  return el('section', { class: 'day', 'aria-label': label },
    el('h3', { class: `day-head ${day.date === todayKey ? 'today' : ''}` }, label),
    day.entries.length === 0
      ? el('div', { class: 'day-empty' }, 'No slots')
      : el('ul', { class: 'entries' }, day.entries.map((entry) => buildEntry(entry, now))));
}

/** `withDate`: the entry is shown outside its day group (the "Needs attention" box), so the time alone would not place it. */
function buildEntry(entry, now, withDate = false) {
  return el('li', { class: 'entry' },
    el('time', { class: 'entry-time', datetime: new Date(entry.at).toISOString() },
      withDate && [el('span', { class: 'entry-date' }, formatDate(entry.at)), ' '], // the space keeps "Mon, Sep 7 12:00 PM" readable as text
      formatTime(entry.at)),
    entry.draft ? buildQueueCard(entry, now) : buildEmptySlot(entry));
}

function buildQueueCard(entry, now) {
  const draft = entry.draft;
  const configured = Boolean(state.status?.configured);
  const title = firstLine(draft.tweets);
  const overdue = needsAttention(entry, now);
  const busy = draft.status === 'publishing';
  const thumbs = draft.tweets.flatMap((t) => t.media).slice(0, 4);
  return el('div', { class: `entry-card ${overdue ? 'overdue' : ''}` },
    el('div', { class: `entry-title ${title ? '' : 'empty'}` }, title || 'Empty draft'),
    el('div', { class: 'entry-meta' },
      postCountLabel(draft.tweets.length),
      el('span', { class: 'badge' }, draft.mode === 'api' ? 'API' : 'Reminder'),
      entry.kind === 'custom' && el('span', { class: 'badge' }, 'Custom time'),
      draft.status === 'due' && el('span', { class: 'badge due' }, 'Due'),
      busy && el('span', { class: 'badge publishing' }, 'Publishing…'),
      overdue && draft.status === 'scheduled' && el('span', { class: 'badge warn' }, 'Overdue')),
    thumbs.length > 0 && el('div', { class: 'entry-thumbs' }, thumbs.map((m) => el('img', { src: m.url, alt: m.alt || '' }))),
    el('div', { class: 'entry-actions' },
      button('Open', () => navigate(`#/draft/${draft.id}`), { className: 'btn-ghost' }),
      // A due reminder can be finished from the "Needs attention" box, not only from the editor banner.
      draft.status === 'due' && button('Mark as posted', () => markPosted(draft.id), { className: 'btn-success' }),
      !busy && button('Reschedule', (e) => openSchedulePopover(e.currentTarget, draft), { className: 'btn-ghost', hasPopup: true }),
      !busy && button('Unschedule', () => unscheduleDraft(draft.id), { className: 'btn-ghost' }),
      !busy && draft.mode === 'api' && configured && button('Publish now', () => publishNow(draft), { className: 'btn-ghost' }),
      button('Copy', () => copyThread(draft), { className: 'btn-ghost' }),
      !busy && button('Delete', () => deleteDraft(draft.id), { className: 'btn-ghost btn-danger' })));
}

function buildEmptySlot(entry) {
  return el('div', { class: 'entry-card empty' },
    el('span', {}, 'Empty slot'),
    button('Schedule a draft here…', () => scheduleIntoSlot(entry.at), { className: 'btn-ghost', hasPopup: true }));
}

async function scheduleIntoSlot(at) {
  const drafts = await api.listDrafts(['draft']);
  const id = await pickDraftDialog({ title: 'Schedule a draft', message: `For ${formatDateTime(at)}.`, drafts });
  if (!id) return;
  const updated = await api.schedule(id, { at });
  syncDraft(updated);
  announceScheduled(updated);
}

// ---------------------------------------------------------------------------
// Posted view
// ---------------------------------------------------------------------------

function renderPosted() {
  const items = state.lists.posted;
  dom.viewPosted.replaceChildren(el('div', { class: 'page' },
    el('div', { class: 'page-head' },
      el('h2', {}, 'Posted'),
      el('span', { class: 'page-sub' }, `${items.length} item${items.length === 1 ? '' : 's'}`)),
    items.length === 0
      ? el('div', { class: 'list-empty' }, 'Nothing posted yet. Published and failed threads show up here.')
      : el('ul', { class: 'history' }, items.map(buildHistoryItem))));
}

function buildHistoryItem(draft) {
  const title = firstLine(draft.tweets);
  const failed = draft.status === 'failed';
  const url = safeUrl(draft.result?.url);
  return el('li', { class: 'entry-card' },
    el('div', { class: 'history-date' }, formatDateTime(draft.postedAt ?? draft.updatedAt)),
    el('div', { class: `entry-title ${title ? '' : 'empty'}` }, title || 'Empty draft'),
    el('div', { class: 'entry-meta' },
      postCountLabel(draft.tweets.length),
      el('span', { class: `badge ${draft.status}` }, failed ? 'Failed' : draft.result?.manual ? 'Marked as posted' : 'Posted'),
      url && el('a', { href: url, target: '_blank', rel: 'noopener' }, 'View on X')),
    failed && el('div', { class: 'entry-error' }, draft.result?.error || 'Unknown error'),
    el('div', { class: 'entry-actions' },
      failed && button(retryLabel(draft), () => retryDraft(draft.id), { className: 'btn-ghost' }),
      button('Open', () => navigate(`#/draft/${draft.id}`), { className: 'btn-ghost' }),
      button('Duplicate', () => duplicateDraft(draft.id), { className: 'btn-ghost' }),
      button('Delete', () => deleteDraft(draft.id), { className: 'btn-ghost btn-danger' })));
}

// ---------------------------------------------------------------------------
// Live updates and notifications
// ---------------------------------------------------------------------------

let refreshTimer = null;

/** Coalesce bursts of SSE events into one round of refreshes. */
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshAll, REFRESH_COALESCE_MS);
}

function refreshAll() {
  refreshStatus();
  loadList(state.tab);
  if (state.route.view === 'queue') loadQueue();
}

function connectEvents() {
  if (!('EventSource' in window)) return;
  const source = new EventSource(`${API_BASE}/events`);
  const payload = (e) => {
    try { return JSON.parse(e.data); } catch { return null; }
  };
  source.addEventListener('draft.updated', (e) => onDraftUpdated(payload(e)?.draft));
  source.addEventListener('draft.deleted', (e) => onDraftDeleted(payload(e)?.id));
  source.addEventListener('reminder', (e) => {
    const draft = payload(e)?.draft;
    if (!draft) return;
    onDraftUpdated(draft);
    announceReminder(draft);
  });
  source.addEventListener('posted', (e) => {
    const draft = payload(e)?.draft;
    if (!draft) return;
    onDraftUpdated(draft);
    toast(`Posted to X: ${firstLine(draft.tweets) || 'thread'}`, { kind: 'success' });
    notify({ title: 'Posted to X', body: firstLine(draft.tweets), tag: `posted-${draft.id}`, draftId: draft.id, url: safeUrl(draft.result?.url) });
  });
  source.addEventListener('failed', (e) => {
    const draft = payload(e)?.draft;
    if (!draft) return;
    onDraftUpdated(draft);
    announcePublishFailure(draft);
    notify({ title: 'Publishing failed', body: draft.result?.error || 'Unknown error', tag: `failed-${draft.id}`, draftId: draft.id });
  });
  let everOpened = false;
  source.addEventListener('open', () => {
    // On a reconnect the events emitted while the stream was down are gone for
    // good (nothing replays them): the lists are refetched, and so is the open
    // draft — its banner would otherwise keep an old state — and the due
    // reminders, which the stream would have announced meanwhile.
    if (everOpened) {
      refreshOpenDraft();
      safetyNetTick({ force: true });
    }
    everOpened = true;
    scheduleRefresh();
  });
  state.events = source;
}

function onDraftUpdated(draft) {
  if (!draft) return;
  scheduleRefresh();
  const ed = state.editor;
  if (ed.draft?.id === draft.id && draft.updatedAt !== ed.draft.updatedAt) reloadOpenDraft(draft);
}

function onDraftDeleted(id) {
  if (!id) return;
  scheduleRefresh();
  if (state.editor.draft?.id === id) {
    toast('This draft was deleted elsewhere.');
    clearEditorAfterRemoval();
  }
}

function announceReminder(draft) {
  if (state.notifiedIds.has(draft.id)) return;
  state.notifiedIds.add(draft.id);
  toast(`Time to post: ${firstLine(draft.tweets) || 'your thread'}`, { kind: 'success', duration: 8000 });
  notify({
    title: 'Time to post',
    body: (draft.tweets[0]?.text ?? '').slice(0, 100),
    tag: draft.id,
    draftId: draft.id,
    requireInteraction: true,
  });
}

function notify({ title, body, tag, draftId, url = null, requireInteraction = false }) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const notification = new Notification(title, { body, tag, requireInteraction });
    notification.addEventListener('click', () => {
      window.focus();
      if (url) window.open(url, '_blank', 'noopener');
      if (draftId) navigate(`#/draft/${draftId}`);
      notification.close();
    });
  } catch (err) {
    console.warn('Notification failed', err);
  }
}

/** If the event stream is down (or just came back), poll for due reminders so none is missed. */
async function safetyNetTick({ force = false } = {}) {
  if (!force && state.events?.readyState === EventSource.OPEN) return;
  try {
    const due = await api.listDrafts(['due']);
    for (const draft of due) announceReminder(draft);
  } catch { /* the server is probably down as well; the next tick retries */ }
}

// ---------------------------------------------------------------------------
// Routing, focus mode, shortcuts
// ---------------------------------------------------------------------------

function parseHash(hash) {
  const view = /^#\/(drafts|queue|posted)\/?$/.exec(hash);
  if (view) return { view: view[1], id: null };
  const draft = /^#\/draft\/([A-Za-z0-9-]+)$/.exec(hash);
  if (draft) return { view: 'draft', id: draft[1] };
  return null;
}

function hashFor(route) {
  return route.view === 'draft' ? `#/draft/${route.id}` : `#/${route.view}`;
}

function navigate(hash) {
  if (location.hash === hash) applyRoute();
  else location.hash = hash;
}

function applyRoute() {
  const route = parseHash(location.hash) ?? parseHash(readStorage(STORAGE_KEYS.route) ?? '') ?? { view: 'drafts', id: null };
  if (hashFor(route) !== location.hash) history.replaceState(null, '', hashFor(route));
  state.route = route;
  writeStorage(STORAGE_KEYS.route, hashFor(route));
  closePopover();
  showView(route);
}

function showView(route) {
  const editor = isEditorView();
  dom.viewEditor.hidden = !editor;
  dom.viewQueue.hidden = route.view !== 'queue';
  dom.viewPosted.hidden = route.view !== 'posted';
  dom.focusBtn.hidden = !editor;
  applyFocusPresentation();
  if (route.view === 'draft') {
    if (state.editor.draft?.id === route.id) {
      setTab(tabForStatus(editorStatus()));
      renderChrome();
      refreshOpenDraft();
    } else {
      openDraft(route.id);
    }
  } else if (route.view === 'drafts') {
    setTab('drafts');
    if (state.editor.draft) resetEditor();
    else renderChrome();
  } else if (route.view === 'queue') {
    setTab('queue');
    loadQueue();
  } else {
    setTab('posted');
    renderPosted();
  }
  if (route.view !== 'draft') dom.viewTitle.textContent = VIEW_TITLES[route.view];
  dom.main.scrollTop = 0;
}

/** Explicit toggle (button, shortcut, Esc): this is the remembered preference. */
function setFocusMode(on) {
  state.focus = on;
  writeStorage(STORAGE_KEYS.focus, on ? '1' : '0');
  applyFocusPresentation();
  renderSaveStatus();
  if (on && isEditorView()) applyFocus(captureFocus() ?? { index: state.editor.tweets.length - 1 });
}

/**
 * Focus mode only shows while the editor is on screen (it hides the sidebar,
 * which the Queue and Posted views need); leaving the editor suspends it
 * without forgetting the preference, so it is back when the editor is.
 */
function applyFocusPresentation() {
  const shown = state.focus && isEditorView();
  document.body.classList.toggle('focus', shown);
  dom.focusIndicator.hidden = !shown;
  dom.focusBtn.setAttribute('aria-pressed', String(state.focus));
}

function onKeydown(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
    if (!isEditorView()) return;
    e.preventDefault();
    setFocusMode(!state.focus);
  } else if (mod && !e.shiftKey && e.key.toLowerCase() === 's') {
    if (!isEditorView()) return;
    e.preventDefault();
    saveNow().catch(noop);
  } else if (mod && e.key === 'Enter') {
    if (!isEditorView() || dom.dialog.open || activePopover) return;
    e.preventDefault();
    quickSchedule();
  } else if (e.key === 'Escape') {
    if (activePopover) closePopover({ restoreFocus: true });
    else if (!dom.dialog.open && state.focus && isEditorView()) setFocusMode(false);
  }
}

function onBeforeUnload(e) {
  const ed = state.editor;
  if (ed.dirty || ed.saving || hasPendingUploads(ed)) {
    e.preventDefault();
    e.returnValue = '';
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function wireStaticControls() {
  dom.newDraft.addEventListener('click', () => createNewDraft());
  dom.addPost.addEventListener('click', () => addCard());
  dom.focusBtn.addEventListener('click', () => setFocusMode(!state.focus));
  dom.focusIndicator.addEventListener('click', () => setFocusMode(false));
  dom.notifBtn.addEventListener('click', () => requestNotifications());
  dom.sidebarCollapse.addEventListener('click', () => setSidebarCollapsed(true));
  dom.sidebarOpen.addEventListener('click', () => setSidebarCollapsed(false));
  dom.sidebarBackdrop.addEventListener('click', () => setSidebarCollapsed(true));
  dom.fileInput.addEventListener('change', onFilePicked);
  for (const tab of dom.sidebar.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => onTabClick(tab.dataset.tab));
  }
  NARROW_QUERY.addEventListener('change', () => setSidebarCollapsed(NARROW_QUERY.matches));
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('hashchange', applyRoute);
}

function restorePreferences() {
  setSidebarCollapsed(NARROW_QUERY.matches || readStorage(STORAGE_KEYS.sidebar) === 'collapsed');
  if (readStorage(STORAGE_KEYS.focus) === '1') setFocusMode(true);
}

/** Publish the action bar's height as --actionbar-h so toasts stack above it instead of covering its buttons. */
function trackActionBarHeight() {
  if (!('ResizeObserver' in window)) return;
  const update = () => document.documentElement.style.setProperty('--actionbar-h', `${dom.actionbar.offsetHeight}px`);
  new ResizeObserver(update).observe(dom.actionbar);
  update();
}

async function init() {
  bindDom();
  wireStaticControls();
  renderEditor({ index: 0 });
  trackActionBarHeight();
  restorePreferences();
  renderNotificationButton();
  dom.tzLabel.textContent = BROWSER_TZ;
  applyRoute();
  await refreshStatus();
  connectEvents();
  setInterval(safetyNetTick, SAFETY_NET_MS);
  setInterval(() => {
    renderSaveStatus();
    if (state.tab === 'drafts' || state.tab === 'queue') renderSidebarList(); // relative times; "Overdue" badges
  }, RELATIVE_TICK_MS);
}

init().catch((err) => {
  console.error(err);
  toast(`The app failed to start: ${err.message}`, { kind: 'error', duration: 15_000 });
});

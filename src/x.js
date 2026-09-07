/**
 * X API v2 client for user-context posting: `POST /2/tweets`, the chunked
 * media upload flow, and resumable thread publishing. Every request is
 * signed with OAuth 1.0a and sent through an injected `fetch`, so tests never
 * touch the network. No retries live here: the scheduler owns retry policy.
 */
import { sign } from './oauth1.js';

const DEFAULT_BASE_URL = 'https://api.x.com';
const USER_AGENT = 'o_typefully/0.1';
/**
 * Per-request deadline (connect, headers and body). Without one a stalled
 * connection holds the scheduler's only pass for as long as undici's own
 * limits allow (minutes per request), and everything that waits on that
 * pass — reminders, Publish now, Retry, shutdown — with it.
 */
const DEFAULT_TIMEOUT_MS = 60_000;
const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_STATUS_POLLS = 20;
const DEFAULT_CHECK_AFTER_SECS = 1;
// A bogus check_after_secs from the API must not park the scheduler for hours.
const MAX_CHECK_AFTER_SECS = 30;
const MAX_DETAIL_CHARS = 300;
const MEDIA_CATEGORIES = ['tweet_image', 'tweet_gif'];
const REQUIRED_ENV = ['X_API_KEY', 'X_API_KEY_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];

const HINTS = {
  401: "Check the four X_* keys in .env. The access token must be generated AFTER the app's permissions are set to Read and Write.",
  402: 'X is asking for payment: enroll in pay-per-use / add credits in the developer console.',
  403: 'Your app or account cannot post: make sure the app has Read and Write permission and that your developer account is enrolled in a plan that allows writes (pay-per-use or a paid tier). Regenerate the access token after changing permissions.',
  429: 'Rate limited by X. Try again later (the header x-rate-limit-reset says when).',
};
/** For a 403 whose detail says the text is already on X (what a retry after a cut connection produces). */
const DUPLICATE_HINT = 'X rejected this post as a duplicate of one you already published. Change the text, or mark the thread as posted.';

/**
 * @typedef {object} ThreadMedia
 * @property {Uint8Array | ArrayBuffer} buffer image bytes
 * @property {string} mimeType e.g. 'image/png'; 'image/gif' uploads as tweet_gif
 * @property {string | null} [alt] alt text, best effort
 */

/**
 * @typedef {object} ThreadPost
 * @property {string} text
 * @property {ThreadMedia[]} [media]
 */

/**
 * @typedef {object} ProgressEvent
 * @property {number} index index of the post that was just published
 * @property {string} tweetId its id
 * @property {string[]} tweetIds every id published by this publishThread call so far
 */

/**
 * @typedef {object} XClient
 * @property {() => Promise<{ id: string, username: string, name: string }>} me
 * @property {(input: { text: string, mediaIds?: string[], replyToId?: string | null }) => Promise<{ id: string, text: string }>} postTweet
 * @property {(input: { buffer: Uint8Array | ArrayBuffer, mimeType: string, category: 'tweet_image' | 'tweet_gif', altText?: string | null }) => Promise<string>} uploadMedia
 * @property {(input: { tweets: ThreadPost[], startIndex?: number, replyToId?: string | null, onProgress?: ((event: ProgressEvent) => unknown) | null }) => Promise<{ tweetIds: string[] }>} publishThread
 */

/** A non-2xx (or unreachable) X API response, with a human-readable message and hint. */
export class XApiError extends Error {
  /**
   * @param {string} message
   * @param {object} details
   * @param {number} details.status HTTP status; 0 when no response was received
   * @param {string} details.endpoint `METHOD /path?query`
   * @param {unknown} [details.body] parsed JSON, raw text, or null
   * @param {string | null} [details.hint] what the user can do about it
   * @param {Error} [details.cause]
   */
  constructor(message, { status, endpoint, body = null, hint = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'XApiError';
    this.status = status;
    this.endpoint = endpoint;
    this.body = body;
    this.hint = hint;
  }
}

/** A thread publish that stopped part-way; carries what was posted so the caller can resume. */
export class XPublishError extends Error {
  /**
   * @param {string} message
   * @param {object} details
   * @param {number} details.index post index to resume from (the one that failed)
   * @param {string[]} details.tweetIds ids posted by the failed call, in order
   * @param {Error} details.cause the underlying XApiError or Error
   */
  constructor(message, { index, tweetIds, cause }) {
    super(message, { cause });
    this.name = 'XPublishError';
    this.index = index;
    this.tweetIds = tweetIds;
    this.hint = cause?.hint ?? null;
  }
}

/**
 * True when all four X_* credentials are present and non-blank.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isConfigured(env = process.env) {
  return REQUIRED_ENV.every((name) => typeof env?.[name] === 'string' && env[name].trim() !== '');
}

/**
 * Build the JSON body for `POST /2/tweets`; `media` and `reply` are omitted
 * entirely when empty because the API rejects empty objects.
 *
 * @param {{ text: string, mediaIds?: string[] | null, replyToId?: string | null }} input
 * @returns {{ text: string, media?: { media_ids: string[] }, reply?: { in_reply_to_tweet_id: string } }}
 */
export function buildTweetBody({ text, mediaIds = [], replyToId = null } = {}) {
  if (typeof text !== 'string') throw new TypeError(`buildTweetBody: text must be a string (got ${typeof text})`);
  const ids = mediaIds ?? [];
  if (!Array.isArray(ids) || !ids.every(isNonEmptyString)) {
    throw new TypeError('buildTweetBody: mediaIds must be an array of non-empty strings');
  }
  if (replyToId != null && !isNonEmptyString(replyToId)) {
    throw new TypeError('buildTweetBody: replyToId must be a non-empty string or null');
  }
  if (text.trim() === '' && ids.length === 0) throw new RangeError('buildTweetBody: a post needs text or media');
  const body = { text };
  if (ids.length > 0) body.media = { media_ids: [...ids] };
  if (replyToId != null) body.reply = { in_reply_to_tweet_id: replyToId };
  return body;
}

/**
 * Turn an error response into the detail sentence and the hint shown to the user.
 * Detail is the first of body.detail, body.title, body.errors[0].message,
 * body.errors[0].detail, body.errors[0].title, body.error, or the raw body
 * truncated to 300 chars.
 *
 * @param {number} status HTTP status
 * @param {unknown} body parsed JSON, raw text, or null
 * @param {RateLimitHeaders} [headers] the rate-limit headers, for 429s
 * @returns {{ detail: string, hint: string | null }}
 */
export function describeError(status, body, headers = {}) {
  const detail = extractDetail(body);
  return { detail, hint: hintFor(status, headers ?? {}, detail) };
}

/**
 * The rate-limit headers a 429 hint is built from (Unix seconds for resets).
 *
 * @typedef {object} RateLimitHeaders
 * @property {string | number | null} [rateLimitReset] x-rate-limit-reset: end of the current 15-minute window
 * @property {string | number | null} [userLimit24hRemaining] x-user-limit-24hour-remaining
 * @property {string | number | null} [userLimit24hReset] x-user-limit-24hour-reset
 * @property {string | number | null} [appLimit24hRemaining] x-app-limit-24hour-remaining
 * @property {string | number | null} [appLimit24hReset] x-app-limit-24hour-reset
 */

/**
 * Create a client bound to one set of credentials.
 *
 * @param {object} options
 * @param {string} options.apiKey OAuth consumer key
 * @param {string} options.apiKeySecret OAuth consumer secret
 * @param {string} options.accessToken user access token
 * @param {string} options.accessTokenSecret user access token secret
 * @param {typeof globalThis.fetch} [options.fetch] injected for tests
 * @param {string} [options.baseUrl] API origin, default https://api.x.com
 * @param {(ms: number) => Promise<void>} [options.sleep] used between media STATUS polls
 * @param {number} [options.timeoutMs] how long one request may take before it fails, default 60 000
 * @param {{ warn: (...args: unknown[]) => void }} [options.logger]
 * @returns {XClient}
 */
export function createXClient({
  apiKey,
  apiKeySecret,
  accessToken,
  accessTokenSecret,
  fetch = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = console,
} = {}) {
  const credentials = {
    consumerKey: requireNonEmptyString('apiKey', apiKey),
    consumerSecret: requireNonEmptyString('apiKeySecret', apiKeySecret),
    token: requireNonEmptyString('accessToken', accessToken),
    tokenSecret: requireNonEmptyString('accessTokenSecret', accessTokenSecret),
  };
  requireFunction('fetch', fetch);
  requireFunction('sleep', sleep);
  requireFunction('logger.warn', logger?.warn);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`timeoutMs must be a positive number of milliseconds (got ${JSON.stringify(timeoutMs)})`);
  }
  const origin = normalizeBaseUrl(baseUrl);
  // Set once /2/media/upload/initialize answered 404 AND the command-style
  // INIT worked, so later uploads skip the probe. A 404 alone is not enough:
  // latching on it would reroute every upload for the life of the process
  // after one stray 404, even when the legacy endpoint is not there either.
  let commandStyleUpload = false;

  /**
   * Send one signed request. Bodies are JSON or multipart only, which
   * contribute nothing to the OAuth signature, so only the URL query is signed.
   */
  async function request(method, path, { query = {}, json, multipart } = {}) {
    const url = buildUrl(origin, path, query);
    const endpoint = `${method} ${url.slice(origin.length)}`;
    const headers = {
      Authorization: sign({ method, url, ...credentials }).header,
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (multipart !== undefined) {
      body = multipart; // fetch sets the multipart Content-Type and boundary itself
    }

    // One deadline for the whole exchange: reading the body is part of it.
    const signal = AbortSignal.timeout(timeoutMs);
    let response;
    let parsed;
    try {
      response = await fetch(url, { method, headers, body, signal });
      parsed = await parseBody(response);
    } catch (cause) {
      if (signal.aborted || cause?.name === 'TimeoutError') {
        throw new XApiError(`X API request timed out after ${timeoutMs / 1000}s on ${endpoint}`, { status: 0, endpoint, cause });
      }
      throw new XApiError(`X API request failed on ${endpoint}: ${networkReason(cause)}`, { status: 0, endpoint, cause });
    }
    if (!response.ok) {
      const { detail, hint } = describeError(response.status, parsed, rateLimitHeaders(response.headers));
      throw new XApiError(`X API ${response.status} on ${endpoint}: ${detail}`, {
        status: response.status,
        endpoint,
        body: parsed,
        hint,
      });
    }
    return { status: response.status, endpoint, body: parsed };
  }

  async function me() {
    const result = await request('GET', '/2/users/me');
    const data = dataOf(result, 'id');
    return { id: String(data.id), username: data.username, name: data.name };
  }

  async function postTweet({ text, mediaIds = [], replyToId = null } = {}) {
    const payload = buildTweetBody({ text, mediaIds, replyToId });
    const result = await request('POST', '/2/tweets', { json: payload });
    const data = dataOf(result, 'id');
    return { id: String(data.id), text: typeof data.text === 'string' ? data.text : payload.text };
  }

  async function uploadMedia({ buffer, mimeType, category, altText = null } = {}) {
    const bytes = toBytes(buffer, 'uploadMedia: buffer');
    requireNonEmptyString('mimeType', mimeType);
    if (!MEDIA_CATEGORIES.includes(category)) {
      throw new RangeError(`uploadMedia: category must be one of ${MEDIA_CATEGORIES.join(', ')} (got ${JSON.stringify(category)})`);
    }
    const mediaId = await initializeUpload({ totalBytes: bytes.length, mimeType, category });
    for (let index = 0, offset = 0; offset < bytes.length; index += 1, offset += CHUNK_SIZE) {
      await appendChunk(mediaId, index, bytes.subarray(offset, offset + CHUNK_SIZE), mimeType);
    }
    await waitForProcessing(mediaId, await finalizeUpload(mediaId));
    if (typeof altText === 'string' && altText.trim() !== '') await setAltText(mediaId, altText);
    return mediaId;
  }

  async function initializeUpload({ totalBytes, mimeType, category }) {
    if (commandStyleUpload) return commandStyleInit({ totalBytes, mimeType, category });
    let probeError;
    try {
      const result = await request('POST', '/2/media/upload/initialize', {
        json: { media_category: category, media_type: mimeType, total_bytes: totalBytes, shared: false },
      });
      return mediaIdOf(result);
    } catch (error) {
      if (!(error instanceof XApiError && error.status === 404)) throw error;
      probeError = error;
    }
    let mediaId;
    try {
      mediaId = await commandStyleInit({ totalBytes, mimeType, category });
    } catch (error) {
      // Neither endpoint exists: the first 404 describes that best.
      throw error instanceof XApiError && error.status === 404 ? probeError : error;
    }
    logger.warn('x: POST /2/media/upload/initialize answered 404; using the command-style media upload endpoints');
    commandStyleUpload = true;
    return mediaId;
  }

  async function commandStyleInit({ totalBytes, mimeType, category }) {
    const result = await request('POST', '/2/media/upload', {
      query: { command: 'INIT', total_bytes: String(totalBytes), media_type: mimeType, media_category: category },
    });
    return mediaIdOf(result);
  }

  async function appendChunk(mediaId, segmentIndex, chunk, mimeType) {
    const form = new FormData();
    const blob = new Blob([chunk], { type: mimeType });
    if (commandStyleUpload) {
      form.append('media', blob, 'media');
      await request('POST', '/2/media/upload', {
        query: { command: 'APPEND', media_id: mediaId, segment_index: String(segmentIndex) },
        multipart: form,
      });
      return;
    }
    form.append('segment_index', String(segmentIndex));
    form.append('media', blob, 'media');
    await request('POST', `/2/media/upload/${encodeURIComponent(mediaId)}/append`, { multipart: form });
  }

  function finalizeUpload(mediaId) {
    return commandStyleUpload
      ? request('POST', '/2/media/upload', { query: { command: 'FINALIZE', media_id: mediaId } })
      : request('POST', `/2/media/upload/${encodeURIComponent(mediaId)}/finalize`);
  }

  /** Poll STATUS while processing_info says pending/in_progress; at most MAX_STATUS_POLLS requests. */
  async function waitForProcessing(mediaId, finalizeResult) {
    let result = finalizeResult;
    let info = processingInfoOf(result);
    for (let polls = 0; ; polls += 1) {
      if (info?.state === 'failed') {
        throw new XApiError(`X API ${result.status} on ${result.endpoint}: media processing failed: ${processingErrorOf(info)}`, {
          status: result.status,
          endpoint: result.endpoint,
          body: result.body,
        });
      }
      if (info?.state !== 'pending' && info?.state !== 'in_progress') return;
      if (polls === MAX_STATUS_POLLS) {
        throw new XApiError(`X API ${result.status} on ${result.endpoint}: media ${mediaId} is still ${info.state} after ${MAX_STATUS_POLLS} status checks`, {
          status: result.status,
          endpoint: result.endpoint,
          body: result.body,
        });
      }
      await sleep(checkAfterMs(info));
      result = await request('GET', '/2/media/upload', { query: { command: 'STATUS', media_id: mediaId } });
      info = processingInfoOf(result);
    }
  }

  /** Alt text is best effort: a failure here must not lose the post. */
  async function setAltText(mediaId, text) {
    try {
      await request('POST', '/2/media/metadata', { json: { id: mediaId, metadata: { alt_text: { text } } } });
    } catch (error) {
      logger.warn(`x: could not set alt text for media ${mediaId}: ${error.message}`);
    }
  }

  async function publishThread({ tweets, startIndex = 0, replyToId = null, onProgress = null } = {}) {
    validateThreadInput({ tweets, startIndex, replyToId, onProgress });
    const tweetIds = [];
    let previousId = replyToId;
    for (let index = startIndex; index < tweets.length; index += 1) {
      const post = tweets[index];
      let tweetId;
      try {
        const mediaIds = await uploadAll(post.media ?? []);
        ({ id: tweetId } = await postTweet({ text: post.text, mediaIds, replyToId: previousId }));
      } catch (cause) {
        throw new XPublishError(`Post ${index + 1} of ${tweets.length} failed: ${cause.message}`, { index, tweetIds, cause });
      }
      tweetIds.push(tweetId);
      previousId = tweetId;
      if (onProgress) {
        try {
          await onProgress({ index, tweetId, tweetIds: [...tweetIds] });
        } catch (cause) {
          // The post is live, so a resume must start at the next one.
          throw new XPublishError(
            `Post ${index + 1} of ${tweets.length} was published but recording progress failed: ${cause.message}`,
            { index: index + 1, tweetIds, cause },
          );
        }
      }
    }
    return { tweetIds };
  }

  async function uploadAll(media) {
    const mediaIds = [];
    for (const item of media) {
      mediaIds.push(await uploadMedia({
        buffer: item.buffer,
        mimeType: item.mimeType,
        category: item.mimeType === 'image/gif' ? 'tweet_gif' : 'tweet_image',
        altText: item.alt ?? null,
      }));
    }
    return mediaIds;
  }

  return { me, postTweet, uploadMedia, publishThread };
}

/**
 * Client from X_* env vars, or null when they are not all set.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {object} [opts] extra createXClient options (fetch, baseUrl, sleep, logger)
 * @returns {XClient | null}
 */
export function createXClientFromEnv(env = process.env, opts = {}) {
  if (!isConfigured(env)) return null;
  return createXClient({
    apiKey: env.X_API_KEY.trim(),
    apiKeySecret: env.X_API_KEY_SECRET.trim(),
    accessToken: env.X_ACCESS_TOKEN.trim(),
    accessTokenSecret: env.X_ACCESS_TOKEN_SECRET.trim(),
    ...opts,
  });
}

function buildUrl(origin, path, query) {
  const search = new URLSearchParams(query).toString();
  return `${origin}${path}${search ? `?${search}` : ''}`;
}

function normalizeBaseUrl(baseUrl) {
  const trimmed = requireNonEmptyString('baseUrl', baseUrl).replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new TypeError(`baseUrl must be an absolute http(s) URL (got ${JSON.stringify(baseUrl)})`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`baseUrl must use http or https (got ${parsed.protocol})`);
  }
  return trimmed;
}

async function parseBody(response) {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractDetail(body) {
  if (body == null || body === '') return 'empty response body';
  if (typeof body === 'string') return truncate(body);
  if (typeof body === 'object') {
    const first = Array.isArray(body.errors) ? body.errors[0] : undefined;
    const candidates = [body.detail, body.title, first?.message, first?.detail, first?.title, body.error];
    const found = candidates.find((value) => typeof value === 'string' && value.trim() !== '');
    return truncate(found ? found.trim() : JSON.stringify(body));
  }
  return truncate(String(body));
}

/** @param {Headers} headers @returns {RateLimitHeaders} */
function rateLimitHeaders(headers) {
  return {
    rateLimitReset: headers.get('x-rate-limit-reset'),
    userLimit24hRemaining: headers.get('x-user-limit-24hour-remaining'),
    userLimit24hReset: headers.get('x-user-limit-24hour-reset'),
    appLimit24hRemaining: headers.get('x-app-limit-24hour-remaining'),
    appLimit24hReset: headers.get('x-app-limit-24hour-reset'),
  };
}

/**
 * What went wrong before any response arrived. undici's fetch rejects with a
 * bare 'fetch failed' and keeps the real reason (DNS, connection refused, a
 * certificate or proxy problem) in `cause`, so the chain is spelled out,
 * plus the error code when no message names it.
 *
 * @param {unknown} error
 * @returns {string}
 */
function networkReason(error) {
  const messages = [];
  let code = null;
  for (let current = error, depth = 0; current != null && depth < 5; current = current.cause, depth += 1) {
    const message = typeof current === 'string' ? current : current.message;
    if (isNonEmptyString(message) && !messages.includes(message)) messages.push(message);
    if (code === null && isNonEmptyString(current.code)) code = current.code;
  }
  const reason = messages.length > 0 ? messages.join(': ') : String(error);
  return code !== null && !reason.includes(code) ? `${reason} (${code})` : reason;
}

/**
 * @param {number} status
 * @param {RateLimitHeaders} headers
 * @param {string} [detail] the response's detail sentence
 * @returns {string | null}
 */
function hintFor(status, headers, detail = '') {
  // X also answers 403 to a repeat of text it already has — what a retry does
  // when the previous attempt went through but its response never arrived.
  // The permissions hint would send the user to the developer portal for nothing.
  if (status === 403 && /duplicate content/i.test(detail)) return DUPLICATE_HINT;
  if (status !== 429) return HINTS[status] ?? null;
  // Posting is also capped per 24 hours, per user and per app. When one of
  // those caps is what tripped, x-rate-limit-reset still names the end of the
  // current 15-minute window, which would send the user back too early for
  // up to a day; the exhausted cap's own reset is the one that matters.
  const exhausted = [
    { who: 'your account', header: 'x-user-limit-24hour-remaining', remaining: headers.userLimit24hRemaining, reset: headers.userLimit24hReset },
    { who: 'your app', header: 'x-app-limit-24hour-remaining', remaining: headers.appLimit24hRemaining, reset: headers.appLimit24hReset },
  ].filter((cap) => isZero(cap.remaining));
  if (exhausted.length > 0) {
    const who = exhausted.map((cap) => cap.who).join(' and ');
    const evidence = exhausted.map((cap) => `${cap.header}: 0`).join(', ');
    const resetAt = formatResetTime(latestOf(exhausted.map((cap) => cap.reset)));
    const when = resetAt ? `It resets at ${resetAt}.` : 'It resets within 24 hours.';
    return `Rate limited by X: the 24-hour post cap for ${who} is used up (${evidence}). ${when}`;
  }
  const resetAt = formatResetTime(headers.rateLimitReset);
  return resetAt ? `${HINTS[429]} The limit resets at ${resetAt}.` : HINTS[429];
}

/** True for a header value that reads as exactly 0 (absent or blank is not). */
function isZero(value) {
  return value != null && value !== '' && Number(value) === 0;
}

/** The latest of several Unix-seconds values, ignoring unusable ones. */
function latestOf(values) {
  const seconds = values.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return seconds.length > 0 ? Math.max(...seconds) : null;
}

function formatResetTime(value) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function truncate(text) {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}

/** `body.data` with a required key, or an XApiError explaining the odd shape. */
function dataOf(result, requiredKey) {
  const data = result.body?.data;
  if (data && typeof data === 'object' && data[requiredKey] != null) return data;
  throw unexpectedShape(result, `missing data.${requiredKey}`);
}

/**
 * The error for a 2xx whose body lacks what the call needed. A 2xx may carry
 * only `errors` (a suspended account on /2/users/me, a media category the
 * account may not use): then the API's own words are the reason, not the shape.
 *
 * @param {{ status: number, endpoint: string, body: unknown }} result
 * @param {string} missing what the shape lacks
 * @returns {XApiError}
 */
function unexpectedShape(result, missing) {
  const reason = hasErrors(result.body) ? extractDetail(result.body) : `unexpected response shape (${missing})`;
  return new XApiError(`X API ${result.status} on ${result.endpoint}: ${reason}`, {
    status: result.status,
    endpoint: result.endpoint,
    body: result.body,
  });
}

/** True for a body carrying a non-empty `errors` array. */
function hasErrors(body) {
  return Array.isArray(body?.errors) && body.errors.length > 0;
}

/**
 * Media id from an initialize/INIT response: `data.id`, or the v1.1-style
 * `media_id_string`/`media_id` under `data` or at the top level. Strings win
 * over numbers because real ids exceed Number.MAX_SAFE_INTEGER.
 */
function mediaIdOf(result) {
  const containers = [result.body?.data, result.body].filter((value) => value && typeof value === 'object');
  for (const container of containers) {
    for (const key of ['id', 'media_id_string', 'media_id']) {
      const value = container[key];
      if (isNonEmptyString(value)) return value;
      if (Number.isSafeInteger(value)) return String(value);
    }
  }
  throw unexpectedShape(result, 'missing media id');
}

/**
 * `processing_info` of a finalize/STATUS answer, or null when the media
 * needs no (more) processing. A 2xx that carries only `errors` (an unknown
 * or expired media id, say) is neither: X did not confirm the media, and a
 * post made with it would fail one step later with a vaguer error.
 *
 * @param {{ status: number, endpoint: string, body: unknown }} result
 */
function processingInfoOf(result) {
  const { body } = result;
  const info = body?.data?.processing_info ?? body?.processing_info ?? null;
  const hasData = body?.data != null && typeof body.data === 'object';
  if (info === null && !hasData && hasErrors(body)) throw unexpectedShape(result, 'missing processing_info');
  return info;
}

function processingErrorOf(info) {
  const error = info.error;
  if (isNonEmptyString(error?.message)) return error.message;
  if (isNonEmptyString(error?.name)) return error.name;
  return error ? JSON.stringify(error) : 'no error details';
}

function checkAfterMs(info) {
  const seconds = Number(info.check_after_secs);
  const clamped = Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, MAX_CHECK_AFTER_SECS) : DEFAULT_CHECK_AFTER_SECS;
  return clamped * 1000;
}

function validateThreadInput({ tweets, startIndex, replyToId, onProgress }) {
  if (!Array.isArray(tweets) || tweets.length === 0) throw new TypeError('publishThread: tweets must be a non-empty array');
  tweets.forEach(validatePost);
  // startIndex === tweets.length is a no-op resume: every post is already live.
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex > tweets.length) {
    throw new RangeError(`publishThread: startIndex must be an integer between 0 and ${tweets.length} (got ${JSON.stringify(startIndex)})`);
  }
  if (replyToId != null && !isNonEmptyString(replyToId)) {
    throw new TypeError('publishThread: replyToId must be a non-empty string or null');
  }
  // A resume without the last posted id would publish the tail as a standalone tweet.
  if (startIndex > 0 && replyToId == null) {
    throw new RangeError(`publishThread: resuming at startIndex ${startIndex} needs the replyToId of the last published post`);
  }
  if (onProgress != null && typeof onProgress !== 'function') {
    throw new TypeError('publishThread: onProgress must be a function or null');
  }
}

function validatePost(post, index) {
  const label = `publishThread: tweets[${index}]`;
  if (!post || typeof post !== 'object') throw new TypeError(`${label} must be an object`);
  if (typeof post.text !== 'string') throw new TypeError(`${label}.text must be a string`);
  const media = post.media ?? [];
  if (!Array.isArray(media)) throw new TypeError(`${label}.media must be an array`);
  media.forEach((item, mediaIndex) => {
    const itemLabel = `${label}.media[${mediaIndex}]`;
    if (!item || typeof item !== 'object') throw new TypeError(`${itemLabel} must be an object`);
    toBytes(item.buffer, `${itemLabel}.buffer`);
    if (!isNonEmptyString(item.mimeType) || !item.mimeType.startsWith('image/')) {
      throw new TypeError(`${itemLabel}.mimeType must be an image MIME type (got ${JSON.stringify(item.mimeType)})`);
    }
    if (item.alt != null && typeof item.alt !== 'string') throw new TypeError(`${itemLabel}.alt must be a string or null`);
  });
}

function toBytes(value, label) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (!(bytes instanceof Uint8Array)) throw new TypeError(`${label} must be a Buffer, Uint8Array or ArrayBuffer`);
  if (bytes.length === 0) throw new RangeError(`${label} must not be empty`);
  return bytes;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

function requireNonEmptyString(name, value) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string (got ${typeof value})`);
  if (value === '') throw new TypeError(`${name} must not be empty`);
  return value;
}

function requireFunction(name, value) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function (got ${typeof value})`);
  return value;
}

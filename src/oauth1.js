/**
 * OAuth 1.0a request signing with HMAC-SHA1 (RFC 5849 §3.4), as the X API
 * requires for user-context calls. Pure module: no I/O. `nonce` and
 * `timestamp` are injectable so signatures are reproducible in tests.
 */
import { createHmac, randomBytes } from 'node:crypto';

const SIGNATURE_METHOD = 'HMAC-SHA1';
const OAUTH_VERSION = '1.0';
const HTTP_METHOD = /^[A-Za-z]+$/;
const UNSIGNED_INTEGER = /^\d+$/;

/**
 * Percent-encode a value the way OAuth 1.0a requires (RFC 3986 §2.1):
 * `encodeURIComponent` plus `!'()*`, which JavaScript leaves bare.
 *
 * @param {string | number | boolean} value
 * @returns {string}
 */
export function percentEncode(value) {
  const type = typeof value;
  if (type !== 'string' && type !== 'number' && type !== 'boolean') {
    throw new TypeError(`percentEncode expects a string, number or boolean (got ${type})`);
  }
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build the signature base string: `METHOD&<encoded base URL>&<encoded
 * normalized params>`. Params are percent-encoded, sorted by key and (for
 * repeated keys) by value, then joined with `=` and `&`.
 *
 * @param {string} method HTTP method, case-insensitive
 * @param {string} baseUrl `scheme://host[:port]/path` without query string or fragment
 * @param {Record<string, unknown> | Iterable<[string, unknown]> | null | undefined} params
 *   query + form-encoded body params. An object may hold array values and an
 *   iterable may repeat keys; both mean a repeated parameter.
 * @returns {string}
 */
export function buildBaseString(method, baseUrl, params) {
  if (typeof method !== 'string' || !HTTP_METHOD.test(method)) {
    throw new TypeError(`method must be an HTTP method name (got ${JSON.stringify(method)})`);
  }
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    throw new TypeError('baseUrl must be a non-empty string');
  }
  if (baseUrl.includes('?') || baseUrl.includes('#')) {
    throw new TypeError('baseUrl must not carry a query string or fragment; pass query params via params');
  }
  const normalized = toPairs(params)
    .map(([key, value]) => [percentEncode(key), percentEncode(value)])
    .sort(comparePairs)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  return `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(normalized)}`;
}

/**
 * The HMAC-SHA1 key: encoded consumer secret and encoded token secret joined by `&`.
 *
 * @param {string} consumerSecret
 * @param {string} tokenSecret
 * @returns {string}
 */
export function signingKey(consumerSecret, tokenSecret) {
  return `${percentEncode(requireString('consumerSecret', consumerSecret))}&${percentEncode(requireString('tokenSecret', tokenSecret))}`;
}

/**
 * Sign a request and build its `Authorization` header.
 *
 * `url` may carry a query string: it is split off, its pairs are signed
 * together with `params`, and the base string uses the URL without it.
 * `params` must contain only query and form-encoded body params; JSON and
 * multipart bodies contribute nothing to the signature.
 *
 * @param {object} input
 * @param {string} input.method
 * @param {string} input.url absolute http(s) URL, query string allowed
 * @param {Record<string, unknown> | Iterable<[string, unknown]>} [input.params]
 * @param {string} input.consumerKey
 * @param {string} input.consumerSecret
 * @param {string} input.token
 * @param {string} input.tokenSecret
 * @param {string} [input.nonce] defaults to 32 random hex chars
 * @param {number | string} [input.timestamp] Unix seconds; defaults to now
 * @returns {{ header: string, oauthParams: Record<string, string>, signature: string, baseString: string }}
 *   `oauthParams` are the `oauth_*` header params, signature included.
 */
export function sign({
  method,
  url,
  params = {},
  consumerKey,
  consumerSecret,
  token,
  tokenSecret,
  nonce = randomNonce(),
  timestamp = Math.floor(Date.now() / 1000),
} = {}) {
  const oauthParams = {
    oauth_consumer_key: requireNonEmptyString('consumerKey', consumerKey),
    oauth_nonce: requireNonEmptyString('nonce', nonce),
    oauth_signature_method: SIGNATURE_METHOD,
    oauth_timestamp: normalizeTimestamp(timestamp),
    oauth_token: requireNonEmptyString('token', token),
    oauth_version: OAUTH_VERSION,
  };
  requireNonEmptyString('consumerSecret', consumerSecret);
  requireNonEmptyString('tokenSecret', tokenSecret);

  const { baseUrl, queryPairs } = splitUrl(url);
  const baseString = buildBaseString(method, baseUrl, [
    ...queryPairs,
    ...toPairs(params),
    ...Object.entries(oauthParams),
  ]);
  const signature = createHmac('sha1', signingKey(consumerSecret, tokenSecret))
    .update(baseString)
    .digest('base64');

  const headerParams = { ...oauthParams, oauth_signature: signature };
  const header = `OAuth ${Object.keys(headerParams)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(headerParams[key])}"`)
    .join(', ')}`;
  return { header, oauthParams: headerParams, signature, baseString };
}

/**
 * Flatten params into `[key, value]` pairs (still unencoded). Array values of
 * an object become repeated keys. `null`/`undefined` values are rejected
 * rather than skipped so a missing variable cannot silently sign a
 * different request than the one being sent.
 *
 * @param {Record<string, unknown> | Iterable<[string, unknown]> | null | undefined} params
 * @returns {Array<[string, unknown]>}
 */
function toPairs(params) {
  if (params == null) return [];
  if (typeof params !== 'object') {
    throw new TypeError(`params must be an object or an iterable of [key, value] pairs (got ${typeof params})`);
  }
  const entries = typeof params[Symbol.iterator] === 'function'
    ? Array.from(params, checkPair)
    : Object.entries(params);
  const pairs = [];
  for (const [key, value] of entries) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item == null) throw new TypeError(`param ${JSON.stringify(key)} has no value (null or undefined)`);
      pairs.push([String(key), item]);
    }
  }
  return pairs;
}

function checkPair(entry) {
  if (!Array.isArray(entry) || entry.length !== 2) {
    throw new TypeError('each params entry must be a [key, value] pair');
  }
  return entry;
}

/** Byte-order comparison on already-encoded pairs: key first, then value. */
function comparePairs([keyA, valueA], [keyB, valueB]) {
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  if (valueA === valueB) return 0;
  return valueA < valueB ? -1 : 1;
}

/**
 * Split an absolute URL into the base-string URL (lowercase scheme and host,
 * default port dropped, no query or fragment) and its decoded query pairs.
 *
 * @param {string} url
 * @returns {{ baseUrl: string, queryPairs: Array<[string, string]> }}
 */
function splitUrl(url) {
  if (typeof url !== 'string') throw new TypeError(`url must be a string (got ${typeof url})`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`url must be an absolute http(s) URL (got ${JSON.stringify(url)})`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`url must use http or https (got ${parsed.protocol})`);
  }
  // URL already lowercases scheme and host; `host` keeps only a non-default port.
  return {
    baseUrl: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
    queryPairs: [...parsed.searchParams],
  };
}

function normalizeTimestamp(timestamp) {
  if (Number.isSafeInteger(timestamp) && timestamp >= 0) return String(timestamp);
  if (typeof timestamp === 'string' && UNSIGNED_INTEGER.test(timestamp)) return timestamp;
  throw new TypeError(`timestamp must be a non-negative integer of Unix seconds (got ${JSON.stringify(timestamp)})`);
}

function randomNonce() {
  return randomBytes(16).toString('hex');
}

function requireString(name, value) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string (got ${typeof value})`);
  return value;
}

function requireNonEmptyString(name, value) {
  if (requireString(name, value) === '') throw new TypeError(`${name} must not be empty`);
  return value;
}

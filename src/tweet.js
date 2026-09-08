/**
 * Thread text utilities: splitting on `---`, measuring with twitter-text,
 * validating a thread, and sanitizing untrusted JSON into the canonical shape.
 */
import twitterText from 'twitter-text';

export const MAX_WEIGHTED_LENGTH = 280;
export const MAX_MEDIA_PER_TWEET = 4;
export const MAX_TWEETS_PER_THREAD = 25;
export const SEPARATOR = '---';

/** Hard input caps applied by {@link normalizeTweets}; real limits are enforced by {@link validateThread}. */
const MAX_INPUT_TEXT_CHARS = 10_000;
const MAX_INPUT_MEDIA = 10;
const MAX_INPUT_TWEETS = 100;
const MAX_ALT_CHARS = 1000;
const MAX_MEDIA_FIELD_CHARS = 2048;

/**
 * @typedef {object} MediaRef
 * @property {string} id
 * @property {string} url
 * @property {string} name
 * @property {string} type MIME type, e.g. 'image/png'
 * @property {number} size bytes
 * @property {string} [alt]
 */

/**
 * @typedef {object} Tweet
 * @property {string} text
 * @property {MediaRef[]} media
 */

/**
 * Split editor text into posts on lines that are exactly `---` (after trim).
 * Line endings are normalized to `\n`; leading/trailing blank lines of each
 * part are dropped (inner whitespace is kept); empty parts are dropped.
 *
 * @param {string | null | undefined} text
 * @returns {string[]}
 */
export function splitThread(text) {
  if (text == null) return [];
  if (typeof text !== 'string') throw new TypeError(`splitThread expects a string (got ${typeof text})`);
  const parts = [];
  let current = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() === SEPARATOR) {
      parts.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  parts.push(current);
  return parts.map(trimBlankLines).filter((part) => part.length > 0);
}

/**
 * @param {string[]} lines
 * @returns {string}
 */
function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

/**
 * Measure text the way X does (URLs count 23, most emoji/CJK count 2).
 *
 * @param {string | null | undefined} text
 * @returns {{ weightedLength: number, valid: boolean, permillage: number, remaining: number }}
 *   `remaining` may be negative
 */
export function measure(text) {
  const { weightedLength, valid, permillage } = twitterText.parseTweet(text == null ? '' : String(text));
  return { weightedLength, valid, permillage, remaining: MAX_WEIGHTED_LENGTH - weightedLength };
}

/**
 * Check a whole thread; every problem is reported, not just the first.
 * `index` is the 0-based post index, or -1 for thread-level problems.
 *
 * @param {unknown} tweets canonical shape `[{ text, media }]` (tolerates garbage)
 * @returns {{ ok: boolean, errors: Array<{ index: number, message: string }> }}
 */
export function validateThread(tweets) {
  if (!Array.isArray(tweets) || tweets.length === 0) {
    return { ok: false, errors: [{ index: -1, message: 'A thread needs at least one post.' }] };
  }
  const errors = [];
  if (tweets.length > MAX_TWEETS_PER_THREAD) {
    errors.push({
      index: -1,
      message: `A thread can have at most ${MAX_TWEETS_PER_THREAD} posts (this one has ${tweets.length}).`,
    });
  }
  tweets.forEach((tweet, index) => {
    for (const message of postProblems(tweet, index + 1)) errors.push({ index, message });
  });
  return { ok: errors.length === 0, errors };
}

/**
 * @param {unknown} tweet
 * @param {number} n 1-based post number for messages
 * @returns {string[]}
 */
function postProblems(tweet, n) {
  const text = typeof tweet?.text === 'string' ? tweet.text : '';
  const media = Array.isArray(tweet?.media) ? tweet.media : [];
  const problems = [];
  const hasText = text.trim() !== '';

  if (!hasText && media.length === 0) {
    problems.push(`Post ${n} is empty.`);
  } else if (hasText) {
    // twitter-text calls blank text invalid; that case is "empty" above, not bad characters.
    const { weightedLength, valid } = measure(text);
    if (weightedLength > MAX_WEIGHTED_LENGTH) {
      problems.push(`Post ${n} is over the ${MAX_WEIGHTED_LENGTH}-character limit (${weightedLength}/${MAX_WEIGHTED_LENGTH}).`);
    } else if (!valid) {
      problems.push(`Post ${n} contains characters X does not accept.`);
    }
  }
  if (media.length > MAX_MEDIA_PER_TWEET) {
    problems.push(`Post ${n} has more than ${MAX_MEDIA_PER_TWEET} images.`);
  }
  if (media.length > 1 && media.some((m) => m?.type === 'image/gif')) {
    problems.push(`Post ${n}: a GIF must be the only attachment.`);
  }
  return problems;
}

/**
 * Coerce untrusted JSON into the canonical thread shape. Never throws.
 *
 * - Non-array input → a single empty post.
 * - Each entry becomes `{ text, media }`; unknown keys are dropped.
 * - Media entries keep only `{ id, url, name, type, size, alt }`; entries
 *   without a string `id` are dropped; `alt` is kept only when non-empty.
 * - Defensive caps: text 10 000 chars, 10 media per post, 100 posts.
 *   {@link validateThread} reports the real limits.
 *
 * @param {unknown} input
 * @returns {Tweet[]}
 */
export function normalizeTweets(input) {
  if (!Array.isArray(input)) return [{ text: '', media: [] }];
  return input.slice(0, MAX_INPUT_TWEETS).map(normalizeTweet);
}

/**
 * @param {unknown} entry
 * @returns {Tweet}
 */
function normalizeTweet(entry) {
  const raw = isPlainObject(entry) ? entry : {};
  const text = typeof raw.text === 'string' ? raw.text.slice(0, MAX_INPUT_TEXT_CHARS) : '';
  const media = Array.isArray(raw.media)
    ? raw.media.slice(0, MAX_INPUT_MEDIA).map(normalizeMedia).filter(Boolean)
    : [];
  return { text, media };
}

/**
 * @param {unknown} entry
 * @returns {MediaRef | null} null when the entry has no usable id
 */
function normalizeMedia(entry) {
  if (!isPlainObject(entry) || typeof entry.id !== 'string' || entry.id === '') return null;
  const media = {
    id: entry.id.slice(0, MAX_MEDIA_FIELD_CHARS),
    url: stringField(entry.url),
    name: stringField(entry.name),
    type: stringField(entry.type),
    size: typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0 ? entry.size : 0,
  };
  if (typeof entry.alt === 'string' && entry.alt !== '') media.alt = entry.alt.slice(0, MAX_ALT_CHARS);
  return media;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringField(value) {
  return typeof value === 'string' ? value.slice(0, MAX_MEDIA_FIELD_CHARS) : '';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Plain-text form of a thread: posts joined by a blank line, `---`, blank line.
 * Round-trips through {@link splitThread}.
 *
 * @param {Array<Tweet | string>} tweets
 * @returns {string}
 */
export function threadToClipboardText(tweets) {
  if (!Array.isArray(tweets)) throw new TypeError('threadToClipboardText expects an array of posts');
  return tweets
    .map((tweet) => (typeof tweet === 'string' ? tweet : String(tweet?.text ?? '')))
    .join(`\n\n${SEPARATOR}\n\n`);
}

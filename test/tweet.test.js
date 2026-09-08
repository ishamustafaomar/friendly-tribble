import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_WEIGHTED_LENGTH,
  MAX_MEDIA_PER_TWEET,
  MAX_TWEETS_PER_THREAD,
  SEPARATOR,
  splitThread,
  measure,
  validateThread,
  normalizeTweets,
  threadToClipboardText,
} from '../src/tweet.js';

const png = (id = 'a', extra = {}) => ({ id, url: `/media/${id}`, name: `${id}.png`, type: 'image/png', size: 10, ...extra });
const gif = (id = 'g') => ({ ...png(id), name: `${id}.gif`, type: 'image/gif' });
const post = (text, media = []) => ({ text, media });
const messages = (tweets) => validateThread(tweets).errors.map((e) => e.message);

describe('constants', () => {
  test('match the X limits', () => {
    assert.equal(MAX_WEIGHTED_LENGTH, 280);
    assert.equal(MAX_MEDIA_PER_TWEET, 4);
    assert.equal(MAX_TWEETS_PER_THREAD, 25);
    assert.equal(SEPARATOR, '---');
  });
});

describe('splitThread', () => {
  test('splits on --- lines and trims blank lines around each part', () => {
    assert.deepEqual(splitThread('one\n\n---\n\ntwo\n---\nthree'), ['one', 'two', 'three']);
  });

  test('separator lines may carry surrounding whitespace, but nothing else', () => {
    assert.deepEqual(splitThread('a\n  ---  \nb'), ['a', 'b']);
    assert.deepEqual(splitThread('a\n----\nb'), ['a\n----\nb']);
    assert.deepEqual(splitThread('a --- b'), ['a --- b']);
  });

  test('normalizes Windows line endings', () => {
    assert.deepEqual(splitThread('one\r\n---\r\ntwo\r\nstill two'), ['one', 'two\nstill two']);
  });

  test('keeps inner whitespace and indentation', () => {
    assert.deepEqual(splitThread('\n\n  indented\n\n  blank kept above\n\n\n---\n x '), ['  indented\n\n  blank kept above', ' x ']);
  });

  test('drops empty parts', () => {
    assert.deepEqual(splitThread('---\n---\na\n---\n\n---'), ['a']);
    assert.deepEqual(splitThread('---'), []);
    assert.deepEqual(splitThread('   \n\n'), []);
  });

  test('empty, null and undefined give []', () => {
    assert.deepEqual(splitThread(''), []);
    assert.deepEqual(splitThread(null), []);
    assert.deepEqual(splitThread(undefined), []);
  });

  test('rejects non-strings', () => {
    assert.throws(() => splitThread(42), TypeError);
  });
});

describe('measure', () => {
  test('uses twitter-text weighted length', () => {
    assert.deepEqual(measure('hello'), { weightedLength: 5, valid: true, permillage: 17, remaining: 275 });
    // A URL counts 23 regardless of its length; most emoji count 2.
    assert.equal(measure('https://example.com/a/very/long/path/that/goes/on').weightedLength, 23);
    assert.equal(measure('😀').weightedLength, 2);
    assert.equal(measure('日本語').weightedLength, 6);
  });

  test('remaining goes negative past the limit', () => {
    const over = measure('a'.repeat(281));
    assert.equal(over.weightedLength, 281);
    assert.equal(over.remaining, -1);
    assert.equal(over.valid, false);
    assert.equal(measure('a'.repeat(280)).valid, true);
  });

  test('tolerates empty and nullish input', () => {
    assert.equal(measure('').weightedLength, 0);
    assert.equal(measure(null).remaining, 280);
    assert.equal(measure(undefined).weightedLength, 0);
  });
});

describe('validateThread', () => {
  test('accepts a normal thread', () => {
    assert.deepEqual(validateThread([post('one'), post('two', [png()])]), { ok: true, errors: [] });
  });

  test('rejects a missing or empty thread', () => {
    for (const bad of [[], null, undefined, 'x', {}]) {
      assert.deepEqual(validateThread(bad), { ok: false, errors: [{ index: -1, message: 'A thread needs at least one post.' }] });
    }
  });

  test('rejects more than 25 posts at index -1', () => {
    const tweets = Array.from({ length: 26 }, (_, i) => post(`post ${i}`));
    const { ok, errors } = validateThread(tweets);
    assert.equal(ok, false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].index, -1);
    assert.match(errors[0].message, /25/);
    assert.equal(validateThread(tweets.slice(0, 25)).ok, true);
  });

  test('reports empty posts, but not media-only posts', () => {
    assert.deepEqual(messages([post(''), post('   \n\t')]), ['Post 1 is empty.', 'Post 2 is empty.']);
    assert.deepEqual(validateThread([post('', [png()])]), { ok: true, errors: [] });
    assert.deepEqual(validateThread([post('  ', [png()])]).ok, true);
  });

  test('reports over-limit posts with the weighted count', () => {
    assert.deepEqual(messages([post('a'.repeat(281))]), ['Post 1 is over the 280-character limit (281/280).']);
    assert.deepEqual(messages([post('😀'.repeat(141))]), ['Post 1 is over the 280-character limit (282/280).']);
    assert.equal(validateThread([post('a'.repeat(280))]).ok, true);
  });

  test('reports characters X does not accept', () => {
    assert.deepEqual(messages([post('bad ￾ char')]), ['Post 1 contains characters X does not accept.']);
  });

  test('reports too many images and GIFs with company', () => {
    const five = [png('1'), png('2'), png('3'), png('4'), png('5')];
    assert.deepEqual(messages([post('x', five)]), ['Post 1 has more than 4 images.']);
    assert.deepEqual(messages([post('x', [gif(), png()])]), ['Post 1: a GIF must be the only attachment.']);
    assert.equal(validateThread([post('x', [gif()])]).ok, true);
    assert.equal(validateThread([post('x', [png('1'), png('2'), png('3'), png('4')])]).ok, true);
  });

  test('collects every error with 0-based indexes', () => {
    const tweets = [post('fine'), post(''), post('a'.repeat(300), [gif(), png(), png('b'), png('c'), png('d')])];
    const { ok, errors } = validateThread(tweets);
    assert.equal(ok, false);
    assert.deepEqual(errors, [
      { index: 1, message: 'Post 2 is empty.' },
      { index: 2, message: 'Post 3 is over the 280-character limit (300/280).' },
      { index: 2, message: 'Post 3 has more than 4 images.' },
      { index: 2, message: 'Post 3: a GIF must be the only attachment.' },
    ]);
  });

  test('treats malformed entries as empty posts instead of throwing', () => {
    assert.deepEqual(messages([null, 5, { text: 7, media: 'no' }]), ['Post 1 is empty.', 'Post 2 is empty.', 'Post 3 is empty.']);
  });
});

describe('normalizeTweets', () => {
  test('keeps the canonical shape and drops unknown keys', () => {
    const input = [{ text: 'hi', media: [{ ...png(), bogus: true }], extra: 1 }];
    assert.deepEqual(normalizeTweets(input), [{ text: 'hi', media: [png()] }]);
  });

  test('non-array input becomes one empty post; an empty array stays empty', () => {
    for (const bad of [undefined, null, 'text', 42, { text: 'obj' }]) {
      assert.deepEqual(normalizeTweets(bad), [{ text: '', media: [] }]);
    }
    assert.deepEqual(normalizeTweets([]), []);
  });

  test('coerces garbage entries', () => {
    assert.deepEqual(normalizeTweets([null, 'str', 3, [], { text: 12 }, { media: {} }]), [
      { text: '', media: [] },
      { text: '', media: [] },
      { text: '', media: [] },
      { text: '', media: [] },
      { text: '', media: [] },
      { text: '', media: [] },
    ]);
  });

  test('keeps alt only when it is a non-empty string, truncated to 1000 chars', () => {
    const [{ media }] = normalizeTweets([{ media: [png('a', { alt: 'x'.repeat(1200) }), png('b', { alt: '' }), png('c', { alt: 9 })] }]);
    assert.equal(media[0].alt.length, 1000);
    assert.equal('alt' in media[1], false);
    assert.equal('alt' in media[2], false);
  });

  test('drops media without a string id and defaults the other fields', () => {
    const [{ media }] = normalizeTweets([{ media: [{ id: 'ok' }, { id: 5 }, { url: '/media/x' }, null, 'str', { id: '' }] }]);
    assert.deepEqual(media, [{ id: 'ok', url: '', name: '', type: '', size: 0 }]);
    const [{ media: sized }] = normalizeTweets([{ media: [png('s', { size: -1 }), png('t', { size: '12' }), png('u', { size: NaN })] }]);
    assert.deepEqual(sized.map((m) => m.size), [0, 0, 0]);
  });

  test('applies the defensive caps', () => {
    const longText = 'x'.repeat(20_000);
    const manyMedia = Array.from({ length: 12 }, (_, i) => png(String(i)));
    const [tweet] = normalizeTweets([{ text: longText, media: manyMedia }]);
    assert.equal(tweet.text.length, 10_000);
    assert.equal(tweet.media.length, 10);
    assert.equal(normalizeTweets(Array.from({ length: 150 }, () => post('p'))).length, 100);
  });

  test('never throws on hostile input', () => {
    const hostile = [{ text: { toString() { throw new Error('boom'); } }, media: [{ id: 'a', get url() { return 1; } }] }];
    assert.deepEqual(normalizeTweets(hostile), [{ text: '', media: [{ id: 'a', url: '', name: '', type: '', size: 0 }] }]);
  });

  test('returns fresh objects', () => {
    const input = [post('a', [png()])];
    const out = normalizeTweets(input);
    assert.notEqual(out[0], input[0]);
    assert.notEqual(out[0].media[0], input[0].media[0]);
  });
});

describe('threadToClipboardText', () => {
  test('joins posts with blank line, ---, blank line', () => {
    assert.equal(threadToClipboardText([post('one'), post('two')]), 'one\n\n---\n\ntwo');
    assert.equal(threadToClipboardText([post('solo')]), 'solo');
    assert.equal(threadToClipboardText([]), '');
    assert.equal(threadToClipboardText(['a', 'b']), 'a\n\n---\n\nb');
  });

  test('round-trips through splitThread', () => {
    const texts = ['first  post', 'second\n\nwith a blank line', 'third'];
    assert.deepEqual(splitThread(threadToClipboardText(texts.map((t) => post(t)))), texts);
  });

  test('rejects non-arrays', () => {
    assert.throws(() => threadToClipboardText('a'), TypeError);
  });
});

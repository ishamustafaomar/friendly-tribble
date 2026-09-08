import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { percentEncode, buildBaseString, signingKey, sign } from '../src/oauth1.js';

// X's "Creating a signature" worked example. The token below is the one in
// the current docs revision, which is what the documented signature was
// computed from; the earlier revision listed the token ending in
// "KPXXKUOPRwbBhJ7dJ" with the same base-string layout (see the second test).
const DOCS = {
  method: 'POST',
  url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
  params: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
  consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
  consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
  token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
  tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
  nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
  timestamp: 1318622958,
};
const DOCS_SIGNATURE = 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=';
const SPEC_TOKEN = '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPXXKUOPRwbBhJ7dJ';
const SPEC_BASE_STRING = 'POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPXXKUOPRwbBhJ7dJ%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521';

describe('percentEncode', () => {
  test('leaves RFC 3986 unreserved characters alone', () => {
    const unreserved = 'ABCXYZabcxyz0189-._~';
    assert.equal(percentEncode(unreserved), unreserved);
  });

  test('encodes the characters encodeURIComponent leaves bare', () => {
    assert.equal(percentEncode("!'()*"), '%21%27%28%29%2A');
  });

  test('encodes reserved characters with uppercase hex and UTF-8 bytes', () => {
    assert.equal(percentEncode('Hello Ladies + Gentlemen, a signed OAuth request!'), 'Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21');
    assert.equal(percentEncode('a/b?c=d&e'), 'a%2Fb%3Fc%3Dd%26e');
    assert.equal(percentEncode('é'), '%C3%A9');
    assert.equal(percentEncode('☃'), '%E2%98%83');
  });

  test('accepts numbers and booleans, rejects anything else', () => {
    assert.equal(percentEncode(42), '42');
    assert.equal(percentEncode(true), 'true');
    assert.throws(() => percentEncode(null), /string, number or boolean/);
    assert.throws(() => percentEncode({}), TypeError);
    assert.throws(() => percentEncode(undefined), TypeError);
  });
});

describe('buildBaseString', () => {
  test('reproduces the base string from the spec', () => {
    const params = [
      ['include_entities', 'true'],
      ['status', DOCS.params.status],
      ['oauth_consumer_key', DOCS.consumerKey],
      ['oauth_nonce', DOCS.nonce],
      ['oauth_signature_method', 'HMAC-SHA1'],
      ['oauth_timestamp', String(DOCS.timestamp)],
      ['oauth_token', SPEC_TOKEN],
      ['oauth_version', '1.0'],
    ];
    assert.equal(buildBaseString('post', 'https://api.twitter.com/1.1/statuses/update.json', params), SPEC_BASE_STRING);
  });

  test('sorts by encoded key, then by encoded value for repeated keys', () => {
    assert.equal(buildBaseString('GET', 'https://h/p', [['b', '2'], ['a', 'z'], ['b', '1']]), `GET&${percentEncode('https://h/p')}&${percentEncode('a=z&b=1&b=2')}`);
  });

  test('sorts after encoding, so a space sorts as %20', () => {
    const base = buildBaseString('GET', 'https://h/p', { 'a b': '1', 'a-b': '2', 'a%': '3' });
    assert.equal(decodeURIComponent(base.split('&')[2]), 'a%20b=1&a%25=3&a-b=2');
  });

  test('expands array values of an object into repeated keys and stringifies numbers', () => {
    const base = buildBaseString('GET', 'https://h/p', { id: [3, 1], flag: true });
    assert.equal(decodeURIComponent(base.split('&')[2]), 'flag=true&id=1&id=3');
  });

  test('accepts URLSearchParams and null, and produces an empty param section for no params', () => {
    assert.equal(buildBaseString('GET', 'https://h/p', new URLSearchParams('x=1&y=2')), buildBaseString('GET', 'https://h/p', { x: '1', y: '2' }));
    assert.equal(buildBaseString('GET', 'https://h/p', null), `GET&${percentEncode('https://h/p')}&`);
  });

  test('rejects invalid input with helpful errors', () => {
    assert.throws(() => buildBaseString('', 'https://h/p', {}), /HTTP method/);
    assert.throws(() => buildBaseString('GET', '', {}), /baseUrl/);
    assert.throws(() => buildBaseString('GET', 'https://h/p?x=1', {}), /query string/);
    assert.throws(() => buildBaseString('GET', 'https://h/p', 'a=1'), /object or an iterable/);
    assert.throws(() => buildBaseString('GET', 'https://h/p', [['a']]), /\[key, value\] pair/);
    assert.throws(() => buildBaseString('GET', 'https://h/p', { a: undefined }), /"a" has no value/);
    assert.throws(() => buildBaseString('GET', 'https://h/p', { a: { nested: 1 } }), TypeError);
  });
});

describe('signingKey', () => {
  test('joins the encoded secrets with an ampersand', () => {
    assert.equal(signingKey(DOCS.consumerSecret, DOCS.tokenSecret), `${DOCS.consumerSecret}&${DOCS.tokenSecret}`);
    assert.equal(signingKey('a&b', 'c d'), 'a%26b&c%20d');
  });

  test('an empty token secret leaves a trailing ampersand', () => {
    assert.equal(signingKey('secret', ''), 'secret&');
  });

  test('requires strings', () => {
    assert.throws(() => signingKey('a', undefined), /tokenSecret must be a string/);
    assert.throws(() => signingKey(1, 'b'), /consumerSecret must be a string/);
  });
});

describe('sign', () => {
  test("reproduces the golden signature from X's docs", () => {
    const { signature, header, baseString, oauthParams } = sign(DOCS);
    assert.equal(signature, DOCS_SIGNATURE);
    assert.equal(baseString, SPEC_BASE_STRING.replace(SPEC_TOKEN, DOCS.token));
    assert.equal(
      header,
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"',
    );
    assert.deepEqual(oauthParams, {
      oauth_consumer_key: DOCS.consumerKey,
      oauth_nonce: DOCS.nonce,
      oauth_signature: DOCS_SIGNATURE,
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: '1318622958',
      oauth_token: DOCS.token,
      oauth_version: '1.0',
    });
  });

  test("reproduces the spec's base string with the spec's token", () => {
    const { baseString, signature } = sign({ ...DOCS, token: SPEC_TOKEN });
    assert.equal(baseString, SPEC_BASE_STRING);
    assert.equal(signature, createHmac('sha1', signingKey(DOCS.consumerSecret, DOCS.tokenSecret)).update(SPEC_BASE_STRING).digest('base64'));
  });

  test('merges the URL query into the signed params and strips it from the base URL', () => {
    const viaUrl = sign({ ...DOCS, url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true&status=Hello+Ladies+%2B+Gentlemen%2C+a+signed+OAuth+request%21', params: {} });
    assert.equal(viaUrl.signature, DOCS_SIGNATURE);
    assert.equal(viaUrl.baseString.split('&')[1], percentEncode('https://api.twitter.com/1.1/statuses/update.json'));
  });

  test('normalizes scheme and host case and drops the default port; a fragment is ignored', () => {
    const plain = sign(DOCS);
    const shouted = sign({ ...DOCS, url: 'HTTPS://API.Twitter.com:443/1.1/statuses/update.json?include_entities=true#frag' });
    assert.equal(shouted.signature, plain.signature);
    const custom = sign({ ...DOCS, url: 'https://api.twitter.com:8443/1.1/statuses/update.json?include_entities=true' });
    assert.equal(custom.baseString.split('&')[1], percentEncode('https://api.twitter.com:8443/1.1/statuses/update.json'));
  });

  test('accepts the timestamp as a digit string and lower-case method', () => {
    const { signature } = sign({ ...DOCS, method: 'post', timestamp: '1318622958' });
    assert.equal(signature, DOCS_SIGNATURE);
  });

  test('a JSON body contributes nothing: params default to the query only', () => {
    const { baseString } = sign({ ...DOCS, url: 'https://api.x.com/2/tweets', params: undefined });
    const paramString = decodeURIComponent(baseString.split('&')[2]);
    assert.match(paramString, /^oauth_consumer_key=/);
    assert.doesNotMatch(paramString, /status=/);
  });

  test('defaults: a fresh 32-hex nonce per call and a current Unix-seconds timestamp', () => {
    const before = Math.floor(Date.now() / 1000);
    const { nonce: _unused, timestamp: _alsoUnused, ...input } = DOCS;
    const a = sign(input);
    const b = sign(input);
    assert.match(a.oauthParams.oauth_nonce, /^[0-9a-f]{32}$/);
    assert.notEqual(a.oauthParams.oauth_nonce, b.oauthParams.oauth_nonce);
    const stamp = Number(a.oauthParams.oauth_timestamp);
    assert.ok(stamp >= before && stamp <= before + 5, `timestamp ${stamp} should be about ${before}`);
    assert.match(a.header, /^OAuth oauth_consumer_key="[^"]+", oauth_nonce="[0-9a-f]{32}", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d+", oauth_token="[^"]+", oauth_version="1\.0"$/);
  });

  test('percent-encodes header values', () => {
    const { header } = sign({ ...DOCS, consumerKey: 'key with space&amp' });
    assert.match(header, /oauth_consumer_key="key%20with%20space%26amp"/);
  });

  test('rejects missing or malformed inputs with the offending field named', () => {
    assert.throws(() => sign({ ...DOCS, consumerKey: '' }), /consumerKey must not be empty/);
    assert.throws(() => sign({ ...DOCS, consumerSecret: undefined }), /consumerSecret must be a string/);
    assert.throws(() => sign({ ...DOCS, token: 7 }), /token must be a string/);
    assert.throws(() => sign({ ...DOCS, tokenSecret: '' }), /tokenSecret must not be empty/);
    assert.throws(() => sign({ ...DOCS, url: '/2/tweets' }), /absolute http\(s\) URL/);
    assert.throws(() => sign({ ...DOCS, url: 'ftp://api.x.com/2/tweets' }), /http or https/);
    assert.throws(() => sign({ ...DOCS, url: undefined }), /url must be a string/);
    assert.throws(() => sign({ ...DOCS, method: 'P OST' }), /HTTP method/);
    assert.throws(() => sign({ ...DOCS, timestamp: -1 }), /timestamp/);
    assert.throws(() => sign({ ...DOCS, timestamp: '12.5' }), /timestamp/);
    assert.throws(() => sign({ ...DOCS, nonce: '' }), /nonce must not be empty/);
    assert.throws(() => sign(), TypeError);
  });
});

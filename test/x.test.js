import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from '../src/oauth1.js';
import {
  XApiError,
  XPublishError,
  isConfigured,
  createXClient,
  createXClientFromEnv,
  buildTweetBody,
  describeError,
} from '../src/x.js';

const CREDS = { apiKey: 'ck', apiKeySecret: 'cs', accessToken: 'tk', accessTokenSecret: 'ts' };
const ENV = { X_API_KEY: 'ck', X_API_KEY_SECRET: 'cs', X_ACCESS_TOKEN: 'tk', X_ACCESS_TOKEN_SECRET: 'ts' };
const HINT_401 = "Check the four X_* keys in .env. The access token must be generated AFTER the app's permissions are set to Read and Write.";
const HINT_403 = 'Your app or account cannot post: make sure the app has Read and Write permission and that your developer account is enrolled in a plan that allows writes (pay-per-use or a paid tier). Regenerate the access token after changing permissions.';
const HINT_402 = 'X is asking for payment: enroll in pay-per-use / add credits in the developer console.';
const HINT_429 = 'Rate limited by X. Try again later (the header x-rate-limit-reset says when).';
const PNG = Buffer.from('not-really-a-png');
const FOUR_MIB = 4 * 1024 * 1024;

/** Records every call and answers from a queue of Responses (or functions producing one). */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  async function fetch(url, init = {}) {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body ?? null, signal: init.signal ?? null });
    if (queue.length === 0) throw new Error(`no queued response for ${init.method} ${url}`);
    const next = queue.shift();
    return typeof next === 'function' ? next(url, init) : next;
  }
  return { fetch, calls, remaining: () => queue.length };
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const empty = (status = 204) => new Response(null, { status });
const tweet = (id, text = 'ok') => json({ data: { id, text } }, 201);
const initialized = (id = 'm1') => json({ data: { id } });
const finalized = (id = 'm1', processing_info = undefined) =>
  json({ data: processing_info ? { id, processing_info } : { id } });
const status = (state, extra = {}) => json({ data: { id: 'm1', processing_info: { state, ...extra } } });

function makeClient(responses, opts = {}) {
  const { fetch, calls, remaining } = fakeFetch(responses);
  const warnings = [];
  const sleeps = [];
  const client = createXClient({
    ...CREDS,
    fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    ...opts,
  });
  return { client, calls, remaining, warnings, sleeps };
}

function parseOAuthHeader(header) {
  assert.match(header, /^OAuth /);
  const params = {};
  for (const [, key, value] of header.slice('OAuth '.length).matchAll(/([a-z_]+)="([^"]*)"/g)) {
    params[key] = decodeURIComponent(value);
  }
  return params;
}

/** The header is only useful if it signs the URL that was actually requested. */
function assertSigned(call) {
  const params = parseOAuthHeader(call.headers.Authorization);
  assert.ok(params.oauth_signature, 'oauth_signature present');
  assert.equal(params.oauth_consumer_key, CREDS.apiKey);
  assert.equal(params.oauth_token, CREDS.accessToken);
  const expected = sign({
    method: call.method,
    url: call.url,
    consumerKey: CREDS.apiKey,
    consumerSecret: CREDS.apiKeySecret,
    token: CREDS.accessToken,
    tokenSecret: CREDS.accessTokenSecret,
    nonce: params.oauth_nonce,
    timestamp: params.oauth_timestamp,
  });
  assert.equal(params.oauth_signature, expected.signature);
  assert.equal(call.headers['User-Agent'], 'o_typefully/0.1');
  assert.equal(call.headers.Accept, 'application/json');
}

describe('isConfigured', () => {
  test('true only when all four keys are present and non-blank', () => {
    assert.equal(isConfigured(ENV), true);
    assert.equal(isConfigured({ ...ENV, X_ACCESS_TOKEN_SECRET: '' }), false);
    assert.equal(isConfigured({ ...ENV, X_API_KEY: '   ' }), false);
    const { X_API_KEY_SECRET: _dropped, ...partial } = ENV;
    assert.equal(isConfigured(partial), false);
    assert.equal(isConfigured({}), false);
    assert.equal(isConfigured(undefined), false);
  });
});

describe('createXClientFromEnv', () => {
  test('returns null when not configured', () => {
    assert.equal(createXClientFromEnv({}), null);
    assert.equal(createXClientFromEnv({ ...ENV, X_API_KEY: '' }), null);
  });

  test('builds a client from trimmed env values and passes options through', async () => {
    const { fetch, calls } = fakeFetch([json({ data: { id: '1', username: 'u', name: 'n' } })]);
    const client = createXClientFromEnv({ ...ENV, X_API_KEY: ' ck ' }, { fetch, baseUrl: 'http://localhost:9/' });
    assert.deepEqual(await client.me(), { id: '1', username: 'u', name: 'n' });
    assert.equal(calls[0].url, 'http://localhost:9/2/users/me');
    assert.equal(parseOAuthHeader(calls[0].headers.Authorization).oauth_consumer_key, 'ck');
  });
});

describe('buildTweetBody', () => {
  test('omits media and reply when empty', () => {
    assert.deepEqual(buildTweetBody({ text: 'hi' }), { text: 'hi' });
    assert.deepEqual(buildTweetBody({ text: 'hi', mediaIds: [], replyToId: null }), { text: 'hi' });
    assert.deepEqual(buildTweetBody({ text: 'hi', mediaIds: null }), { text: 'hi' });
  });

  test('nests media ids and the reply id under the API key names', () => {
    assert.deepEqual(buildTweetBody({ text: '', mediaIds: ['1', '2'] }), { text: '', media: { media_ids: ['1', '2'] } });
    assert.deepEqual(buildTweetBody({ text: 'hi', replyToId: '9' }), { text: 'hi', reply: { in_reply_to_tweet_id: '9' } });
    assert.deepEqual(buildTweetBody({ text: 'hi', mediaIds: ['1'], replyToId: '9' }), {
      text: 'hi',
      media: { media_ids: ['1'] },
      reply: { in_reply_to_tweet_id: '9' },
    });
  });

  test('rejects invalid input', () => {
    assert.throws(() => buildTweetBody({ text: 5 }), /text must be a string/);
    assert.throws(() => buildTweetBody({ text: '   ' }), /needs text or media/);
    assert.throws(() => buildTweetBody({ text: 'x', mediaIds: [''] }), /mediaIds/);
    assert.throws(() => buildTweetBody({ text: 'x', mediaIds: 'abc' }), /mediaIds/);
    assert.throws(() => buildTweetBody({ text: 'x', replyToId: 12 }), /replyToId/);
    assert.throws(() => buildTweetBody(), /text must be a string/);
  });
});

describe('describeError', () => {
  test('picks the detail in the documented order', () => {
    assert.equal(describeError(400, { detail: 'D', title: 'T', errors: [{ message: 'M' }], error: 'E' }).detail, 'D');
    assert.equal(describeError(400, { title: 'T', errors: [{ message: 'M' }], error: 'E' }).detail, 'T');
    assert.equal(describeError(400, { errors: [{ message: 'M' }], error: 'E' }).detail, 'M');
    assert.equal(describeError(400, { error: 'E' }).detail, 'E');
    assert.equal(describeError(400, { detail: '  ', title: 'T' }).detail, 'T');
  });

  test('falls back to raw text, JSON, or a placeholder, truncated to 300 chars', () => {
    assert.equal(describeError(502, '<html>Bad gateway</html>').detail, '<html>Bad gateway</html>');
    assert.equal(describeError(502, 'x'.repeat(400)).detail, `${'x'.repeat(300)}…`);
    assert.equal(describeError(400, { code: 42 }).detail, '{"code":42}');
    assert.equal(describeError(400, null).detail, 'empty response body');
    assert.equal(describeError(400, '').detail, 'empty response body');
  });

  test('maps status codes to hints', () => {
    assert.equal(describeError(401, null).hint, HINT_401);
    assert.equal(describeError(402, null).hint, HINT_402);
    assert.equal(describeError(403, null).hint, HINT_403);
    assert.equal(describeError(429, null).hint, HINT_429);
    assert.equal(describeError(429, null, { rateLimitReset: '1700000000' }).hint, `${HINT_429} The limit resets at 2023-11-14T22:13:20.000Z.`);
    assert.equal(describeError(429, null, { rateLimitReset: 'soon' }).hint, HINT_429);
    assert.equal(describeError(500, null).hint, null);
    assert.equal(describeError(400, null).hint, null);
  });

  test('reads errors[0].detail and errors[0].title (v2 problem objects) after errors[0].message', () => {
    assert.equal(describeError(400, { errors: [{ title: 'T', detail: 'D' }] }).detail, 'D');
    assert.equal(describeError(400, { errors: [{ title: 'T' }] }).detail, 'T');
    assert.equal(describeError(400, { errors: [{ message: 'M', detail: 'D', title: 'T' }] }).detail, 'M');
    assert.equal(describeError(400, { errors: [{ code: 1 }], error: 'E' }).detail, 'E');
    assert.equal(describeError(400, { errors: 'not a list', error: 'E' }).detail, 'E');
  });

  test('a 429 from an exhausted 24-hour cap names that cap and its own reset, not the 15-minute window', () => {
    const soon = '1700000000'; // the 15-minute window
    const tomorrow = '1700086000';
    const later = '1700090000';
    const user = describeError(429, null, { rateLimitReset: soon, userLimit24hRemaining: '0', userLimit24hReset: tomorrow });
    assert.equal(user.hint, 'Rate limited by X: the 24-hour post cap for your account is used up (x-user-limit-24hour-remaining: 0). It resets at 2023-11-15T22:06:40.000Z.');
    const app = describeError(429, null, { rateLimitReset: soon, appLimit24hRemaining: 0, appLimit24hReset: later, userLimit24hRemaining: '12', userLimit24hReset: tomorrow });
    assert.equal(app.hint, 'Rate limited by X: the 24-hour post cap for your app is used up (x-app-limit-24hour-remaining: 0). It resets at 2023-11-15T23:13:20.000Z.');
    const both = describeError(429, null, {
      rateLimitReset: soon, userLimit24hRemaining: '0', userLimit24hReset: tomorrow, appLimit24hRemaining: '0', appLimit24hReset: later,
    });
    assert.equal(both.hint, 'Rate limited by X: the 24-hour post cap for your account and your app is used up (x-user-limit-24hour-remaining: 0, x-app-limit-24hour-remaining: 0). It resets at 2023-11-15T23:13:20.000Z.');
    const noReset = describeError(429, null, { rateLimitReset: soon, userLimit24hRemaining: '0' });
    assert.equal(noReset.hint, 'Rate limited by X: the 24-hour post cap for your account is used up (x-user-limit-24hour-remaining: 0). It resets within 24 hours.');
    // Caps with posts left, or absent/blank headers, keep the 15-minute hint.
    for (const headers of [
      { rateLimitReset: soon, userLimit24hRemaining: '40', userLimit24hReset: tomorrow, appLimit24hRemaining: '3', appLimit24hReset: later },
      { rateLimitReset: soon, userLimit24hRemaining: '', userLimit24hReset: tomorrow },
      { rateLimitReset: soon, userLimit24hRemaining: null, appLimit24hRemaining: undefined },
    ]) {
      assert.equal(describeError(429, null, headers).hint, `${HINT_429} The limit resets at 2023-11-14T22:13:20.000Z.`);
    }
  });
});

describe('createXClient', () => {
  test('validates credentials and injected collaborators', () => {
    assert.throws(() => createXClient({ ...CREDS, apiKey: '' }), /apiKey must not be empty/);
    assert.throws(() => createXClient({ ...CREDS, accessTokenSecret: undefined }), /accessTokenSecret must be a string/);
    assert.throws(() => createXClient({ ...CREDS, fetch: 'nope' }), /fetch must be a function/);
    assert.throws(() => createXClient({ ...CREDS, fetch: async () => {}, sleep: 1 }), /sleep must be a function/);
    assert.throws(() => createXClient({ ...CREDS, fetch: async () => {}, logger: {} }), /logger\.warn must be a function/);
    assert.throws(() => createXClient({ ...CREDS, fetch: async () => {}, baseUrl: 'api.x.com' }), /baseUrl must be an absolute/);
    assert.throws(() => createXClient({ ...CREDS, fetch: async () => {}, baseUrl: 'ftp://api.x.com' }), /http or https/);
    assert.throws(() => createXClient(), TypeError);
  });

  test('exposes exactly the documented methods', () => {
    const { client } = makeClient([]);
    assert.deepEqual(Object.keys(client).sort(), ['me', 'postTweet', 'publishThread', 'uploadMedia']);
  });
});

describe('client.me', () => {
  test('GETs /2/users/me with a valid OAuth header and returns the user', async () => {
    const { client, calls } = makeClient([json({ data: { id: '42', name: 'Ada', username: 'ada' } })]);
    assert.deepEqual(await client.me(), { id: '42', username: 'ada', name: 'Ada' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.x.com/2/users/me');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].body, null);
    assertSigned(calls[0]);
  });

  test('a 2xx that carries only errors[] reports the API\'s own reason', async () => {
    const problem = { title: 'Forbidden', detail: 'User has been suspended: [123456789].', type: 'https://api.twitter.com/2/problems/resource-not-found' };
    const { client } = makeClient([json({ errors: [problem] })]);
    await assert.rejects(client.me(), (error) => {
      assert.ok(error instanceof XApiError);
      assert.equal(error.message, 'X API 200 on GET /2/users/me: User has been suspended: [123456789].');
      assert.equal(error.status, 200);
      assert.deepEqual(error.body, { errors: [problem] });
      return true;
    });
    const posting = makeClient([json({ errors: [{ message: 'Duplicate content' }] }, 201)]);
    await assert.rejects(posting.client.postTweet({ text: 'again' }), { message: 'X API 201 on POST /2/tweets: Duplicate content' });
    const empty = makeClient([json({ errors: [] })]);
    await assert.rejects(empty.client.me(), /unexpected response shape \(missing data\.id\)/);
  });

  test('a 2xx without data.id is reported as an unexpected shape', async () => {
    const { client } = makeClient([json({ nope: true })]);
    await assert.rejects(client.me(), (error) => {
      assert.ok(error instanceof XApiError);
      assert.equal(error.message, 'X API 200 on GET /2/users/me: unexpected response shape (missing data.id)');
      assert.equal(error.status, 200);
      return true;
    });
  });
});

describe('client.postTweet', () => {
  test('POSTs JSON to /2/tweets with no empty keys and returns id/text', async () => {
    const { client, calls } = makeClient([tweet('100', 'hello')]);
    assert.deepEqual(await client.postTweet({ text: 'hello' }), { id: '100', text: 'hello' });
    const [call] = calls;
    assert.equal(call.url, 'https://api.x.com/2/tweets');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(call.body), { text: 'hello' });
    assertSigned(call);
  });

  test('includes media ids and the reply target when given', async () => {
    const { client, calls } = makeClient([tweet('101')]);
    await client.postTweet({ text: 'with pic', mediaIds: ['m1', 'm2'], replyToId: '100' });
    assert.deepEqual(JSON.parse(calls[0].body), {
      text: 'with pic',
      media: { media_ids: ['m1', 'm2'] },
      reply: { in_reply_to_tweet_id: '100' },
    });
  });

  test('a numeric id in the response is returned as a string', async () => {
    const { client } = makeClient([json({ data: { id: 7 } })]);
    assert.deepEqual(await client.postTweet({ text: 'x' }), { id: '7', text: 'x' });
  });

  test('validates input before sending anything', async () => {
    const { client, calls } = makeClient([]);
    await assert.rejects(client.postTweet({ text: '' }), /needs text or media/);
    await assert.rejects(client.postTweet({ text: 'x', mediaIds: [1] }), /mediaIds/);
    assert.equal(calls.length, 0);
  });

  test('401 → XApiError with the documented message and hint', async () => {
    const { client } = makeClient([json({ title: 'Unauthorized', detail: 'Unauthorized', status: 401 }, 401)]);
    await assert.rejects(client.postTweet({ text: 'x' }), (error) => {
      assert.ok(error instanceof XApiError);
      assert.equal(error.name, 'XApiError');
      assert.equal(error.message, 'X API 401 on POST /2/tweets: Unauthorized');
      assert.equal(error.status, 401);
      assert.equal(error.endpoint, 'POST /2/tweets');
      assert.deepEqual(error.body, { title: 'Unauthorized', detail: 'Unauthorized', status: 401 });
      assert.equal(error.hint, HINT_401);
      return true;
    });
  });

  test('403 → hint about permissions and plan; detail comes from errors[0].message', async () => {
    const { client } = makeClient([json({ errors: [{ message: 'You are not permitted to perform this action.' }] }, 403)]);
    await assert.rejects(client.postTweet({ text: 'x' }), (error) => {
      assert.equal(error.message, 'X API 403 on POST /2/tweets: You are not permitted to perform this action.');
      assert.equal(error.hint, HINT_403);
      return true;
    });
  });

  test('403 for duplicate content → the duplicate hint, not the permissions one', async () => {
    const body = { detail: 'You are not allowed to create a Tweet with duplicate content.', title: 'Forbidden', status: 403 };
    const { client } = makeClient([json(body, 403)]);
    await assert.rejects(client.publishThread({ tweets: [{ text: 'same' }] }), (error) => {
      assert.ok(error instanceof XPublishError);
      assert.equal(error.cause.status, 403);
      assert.equal(error.cause.message, 'X API 403 on POST /2/tweets: You are not allowed to create a Tweet with duplicate content.');
      assert.equal(error.hint, 'X rejected this post as a duplicate of one you already published. Change the text, or mark the thread as posted.');
      return true;
    });
    assert.equal(describeError(403, { errors: [{ message: 'Duplicate Content detected' }] }).hint, describeError(403, body).hint);
    assert.equal(describeError(403, { detail: 'Forbidden' }).hint, HINT_403, 'other 403s keep the permissions hint');
  });

  test('402 → payment hint', async () => {
    const { client } = makeClient([json({ detail: 'Payment required' }, 402)]);
    await assert.rejects(client.postTweet({ text: 'x' }), (error) => {
      assert.equal(error.status, 402);
      assert.equal(error.hint, HINT_402);
      return true;
    });
  });

  test('429 → rate-limit hint including the reset time from the header', async () => {
    const { client } = makeClient([json({ title: 'Too Many Requests' }, 429, { 'x-rate-limit-reset': '1700000000' })]);
    await assert.rejects(client.postTweet({ text: 'x' }), (error) => {
      assert.equal(error.message, 'X API 429 on POST /2/tweets: Too Many Requests');
      assert.equal(error.hint, `${HINT_429} The limit resets at 2023-11-14T22:13:20.000Z.`);
      return true;
    });
  });

  test('429 → the daily-cap hint when x-user-limit-24hour-remaining is 0, whatever x-rate-limit-reset says', async () => {
    const { client } = makeClient([json({ title: 'Too Many Requests' }, 429, {
      'x-rate-limit-remaining': '40',
      'x-rate-limit-reset': '1700000000',
      'x-user-limit-24hour-limit': '17',
      'x-user-limit-24hour-remaining': '0',
      'x-user-limit-24hour-reset': '1700086000',
      'x-app-limit-24hour-remaining': '5',
      'x-app-limit-24hour-reset': '1700086000',
    })]);
    await assert.rejects(client.postTweet({ text: 'hello' }), (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.hint, 'Rate limited by X: the 24-hour post cap for your account is used up (x-user-limit-24hour-remaining: 0). It resets at 2023-11-15T22:06:40.000Z.');
      return true;
    });
  });

  test('non-JSON error bodies are kept as text; unknown statuses have no hint', async () => {
    const { client } = makeClient([new Response('<html>Bad Gateway</html>', { status: 502 })]);
    await assert.rejects(client.postTweet({ text: 'x' }), (error) => {
      assert.equal(error.message, 'X API 502 on POST /2/tweets: <html>Bad Gateway</html>');
      assert.equal(error.body, '<html>Bad Gateway</html>');
      assert.equal(error.hint, null);
      return true;
    });
  });

  test('a network failure becomes an XApiError with status 0 and the cause attached', async () => {
    const { client } = makeClient([() => { throw new TypeError('fetch failed'); }]);
    await assert.rejects(client.postTweet({ text: 'x' }), (error) => {
      assert.ok(error instanceof XApiError);
      assert.equal(error.message, 'X API request failed on POST /2/tweets: fetch failed');
      assert.equal(error.status, 0);
      assert.equal(error.hint, null);
      assert.ok(error.cause instanceof TypeError);
      return true;
    });
  });

  test('a network failure names the underlying cause (DNS, connection, certificate), not just "fetch failed"', async () => {
    const dns = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.x.com'), { code: 'ENOTFOUND' }) });
    const { client } = makeClient([() => { throw dns; }]);
    await assert.rejects(client.postTweet({ text: 'x' }), (error) => {
      assert.ok(error instanceof XApiError);
      assert.equal(error.message, 'X API request failed on POST /2/tweets: fetch failed: getaddrinfo ENOTFOUND api.x.com');
      assert.equal(error.status, 0);
      assert.equal(error.cause, dns);
      return true;
    });
    // The code is appended when no message in the chain names it.
    const tls = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) });
    await assert.rejects(
      makeClient([() => { throw tls; }]).client.postTweet({ text: 'x' }),
      { message: 'X API request failed on POST /2/tweets: fetch failed: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)' },
    );
    const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }) });
    await assert.rejects(
      makeClient([() => { throw refused; }]).client.postTweet({ text: 'x' }),
      { message: 'X API request failed on POST /2/tweets: fetch failed: connect ECONNREFUSED 127.0.0.1:443' },
    );
  });
});

describe('request timeout', () => {
  /**
   * AbortSignal.timeout's timer is unref'd (in the app the HTTP listener keeps
   * the process alive), so a fake fetch that only wakes up on abort needs
   * something ref'd to keep the event loop — and the test runner — going.
   */
  async function keepingLoopAlive(fn) {
    const keepAlive = setInterval(() => {}, 1000);
    try {
      return await fn();
    } finally {
      clearInterval(keepAlive);
    }
  }

  test('every request carries an abort signal with the deadline; a bad timeoutMs is rejected up front', async () => {
    const { client, calls } = makeClient([tweet('1')]);
    await client.postTweet({ text: 'x' });
    assert.ok(calls[0].signal instanceof AbortSignal, 'fetch is given a signal');
    assert.equal(calls[0].signal.aborted, false);
    for (const timeoutMs of [0, -1, NaN, Infinity, '60000']) {
      assert.throws(() => createXClient({ ...CREDS, fetch: async () => tweet('1'), timeoutMs }), TypeError, String(timeoutMs));
    }
  });

  test('a request that outlives timeoutMs fails with a timed-out XApiError instead of hanging the caller', async () => {
    const fetch = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    const client = createXClient({ ...CREDS, fetch, timeoutMs: 20, logger: { warn() {} } });
    const startedAt = Date.now();
    await keepingLoopAlive(() => assert.rejects(client.postTweet({ text: 'x' }), (error) => {
      assert.ok(error instanceof XApiError);
      assert.equal(error.message, 'X API request timed out after 0.02s on POST /2/tweets');
      assert.equal(error.status, 0);
      assert.equal(error.hint, null);
      assert.equal(error.cause?.name, 'TimeoutError');
      return true;
    }));
    assert.ok(Date.now() - startedAt < 5000, 'the deadline, not undici, ended the wait');

    // The default reads as whole seconds in the message.
    const slow = createXClient({ ...CREDS, fetch, logger: { warn() {} } });
    assert.equal(typeof slow.postTweet, 'function');
  });

  test('a body that stalls after the headers is covered by the same deadline', async () => {
    const fetch = (url, init) => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":'));
        init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
      },
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const client = createXClient({ ...CREDS, fetch, timeoutMs: 20, logger: { warn() {} } });
    await keepingLoopAlive(() => assert.rejects(client.postTweet({ text: 'x' }), (error) => {
      assert.ok(error instanceof XApiError);
      assert.equal(error.message, 'X API request timed out after 0.02s on POST /2/tweets');
      assert.equal(error.status, 0);
      return true;
    }));
  });

  test('a thread whose post times out stops with a resumable XPublishError', async () => {
    let requests = 0;
    const fetch = (url, init) => {
      requests += 1;
      if (requests === 1) return Promise.resolve(tweet('1'));
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    };
    const client = createXClient({ ...CREDS, fetch, timeoutMs: 20, logger: { warn() {} } });
    await keepingLoopAlive(() => assert.rejects(client.publishThread({ tweets: [{ text: 'a' }, { text: 'b' }] }), (error) => {
      assert.ok(error instanceof XPublishError);
      assert.equal(error.index, 1);
      assert.deepEqual(error.tweetIds, ['1']);
      assert.equal(error.message, 'Post 2 of 2 failed: X API request timed out after 0.02s on POST /2/tweets');
      return true;
    }));
  });
});

describe('client.uploadMedia', () => {
  test('runs initialize → append → finalize on the v2 endpoints and returns the id', async () => {
    const { client, calls, warnings } = makeClient([initialized('777'), empty(204), finalized('777')]);
    assert.equal(await client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }), '777');
    assert.equal(calls.length, 3);
    assert.deepEqual(warnings, []);

    const [init, append, finalize] = calls;
    assert.equal(init.url, 'https://api.x.com/2/media/upload/initialize');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { media_category: 'tweet_image', media_type: 'image/png', total_bytes: PNG.length, shared: false });
    assertSigned(init);

    assert.equal(append.url, 'https://api.x.com/2/media/upload/777/append');
    assert.equal(append.method, 'POST');
    assert.equal(append.headers['Content-Type'], undefined, 'fetch must set the multipart boundary itself');
    assert.ok(append.body instanceof FormData);
    assert.equal(append.body.get('segment_index'), '0');
    const part = append.body.get('media');
    assert.ok(part instanceof Blob);
    assert.equal(part.name, 'media');
    assert.equal(part.type, 'image/png');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), PNG);
    assertSigned(append);

    const request = new Request(append.url, { method: append.method, headers: append.headers, body: append.body });
    assert.match(request.headers.get('content-type'), /^multipart\/form-data; boundary=/);
    const wire = await request.text();
    assert.match(wire, /Content-Disposition: form-data; name="segment_index"\r\n\r\n0\r\n/);
    assert.match(wire, /Content-Disposition: form-data; name="media"; filename="media"\r\nContent-Type: image\/png\r\n\r\nnot-really-a-png\r\n/);

    assert.equal(finalize.url, 'https://api.x.com/2/media/upload/777/finalize');
    assert.equal(finalize.method, 'POST');
    assert.equal(finalize.body, null);
    assert.equal(finalize.headers['Content-Type'], undefined);
    assertSigned(finalize);
  });

  test('splits the bytes into 4 MiB segments', async () => {
    const big = Buffer.alloc(FOUR_MIB + 1, 1);
    const { client, calls } = makeClient([initialized(), empty(), empty(), finalized()]);
    await client.uploadMedia({ buffer: big, mimeType: 'image/png', category: 'tweet_image' });
    assert.deepEqual(calls.map((c) => c.url.slice('https://api.x.com'.length)), [
      '/2/media/upload/initialize',
      '/2/media/upload/m1/append',
      '/2/media/upload/m1/append',
      '/2/media/upload/m1/finalize',
    ]);
    assert.equal(calls[1].body.get('segment_index'), '0');
    assert.equal(calls[1].body.get('media').size, FOUR_MIB);
    assert.equal(calls[2].body.get('segment_index'), '1');
    assert.equal(calls[2].body.get('media').size, 1);
    assert.equal(JSON.parse(calls[0].body).total_bytes, FOUR_MIB + 1);
  });

  test('sets alt text through /2/media/metadata after finalize', async () => {
    const { client, calls } = makeClient([initialized(), empty(), finalized(), empty(200)]);
    await client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image', altText: 'A cat' });
    const meta = calls[3];
    assert.equal(meta.url, 'https://api.x.com/2/media/metadata');
    assert.equal(meta.method, 'POST');
    assert.deepEqual(JSON.parse(meta.body), { id: 'm1', metadata: { alt_text: { text: 'A cat' } } });
    assertSigned(meta);
  });

  test('alt text failures are logged, not thrown; blank alt text is skipped', async () => {
    const { client, calls, warnings } = makeClient([initialized(), empty(), finalized(), json({ detail: 'nope' }, 400)]);
    assert.equal(await client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image', altText: 'x' }), 'm1');
    assert.equal(calls.length, 4);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /alt text for media m1: X API 400 on POST \/2\/media\/metadata: nope/);

    const blank = makeClient([initialized(), empty(), finalized()]);
    await blank.client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image', altText: '   ' });
    assert.equal(blank.calls.length, 3);
  });

  test('polls STATUS after check_after_secs while processing is pending or in progress', async () => {
    const { client, calls, sleeps } = makeClient([
      initialized(),
      empty(),
      finalized('m1', { state: 'pending', check_after_secs: 2 }),
      status('in_progress', { check_after_secs: 5, progress_percent: 50 }),
      status('succeeded'),
    ]);
    assert.equal(await client.uploadMedia({ buffer: PNG, mimeType: 'image/gif', category: 'tweet_gif' }), 'm1');
    assert.deepEqual(sleeps, [2000, 5000]);
    const polls = calls.slice(3);
    assert.equal(polls.length, 2);
    for (const poll of polls) {
      assert.equal(poll.url, 'https://api.x.com/2/media/upload?command=STATUS&media_id=m1');
      assert.equal(poll.method, 'GET');
      assert.equal(poll.body, null);
      assertSigned(poll);
    }
  });

  test('a failed processing state becomes an XApiError carrying the API error message', async () => {
    const { client } = makeClient([
      initialized(),
      empty(),
      finalized('m1', { state: 'pending', check_after_secs: 1 }),
      status('failed', { error: { code: 1, name: 'InvalidMedia', message: 'Unsupported image' } }),
    ]);
    await assert.rejects(client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }), (error) => {
      assert.ok(error instanceof XApiError);
      assert.equal(error.message, 'X API 200 on GET /2/media/upload?command=STATUS&media_id=m1: media processing failed: Unsupported image');
      assert.equal(error.status, 200);
      return true;
    });
  });

  test('a failed state straight from finalize is reported too', async () => {
    const { client, calls } = makeClient([initialized(), empty(), finalized('m1', { state: 'failed', error: { name: 'Broken' } })]);
    await assert.rejects(client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }), /POST \/2\/media\/upload\/m1\/finalize: media processing failed: Broken/);
    assert.equal(calls.length, 3);
  });

  test('gives up after 20 status polls and clamps absurd check_after_secs', async () => {
    const polls = Array.from({ length: 20 }, () => status('pending', { check_after_secs: 3600 }));
    const { client, calls, sleeps, remaining } = makeClient([initialized(), empty(), finalized('m1', { state: 'pending' }), ...polls]);
    await assert.rejects(client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }), /media m1 is still pending after 20 status checks/);
    assert.equal(calls.length, 23);
    assert.equal(remaining(), 0);
    assert.equal(sleeps[0], 1000, 'missing check_after_secs defaults to 1s');
    assert.ok(sleeps.slice(1).every((ms) => ms === 30_000), 'clamped to 30s');
  });

  test('falls back to the command-style endpoints when initialize answers 404, and remembers it', async () => {
    const { client, calls, warnings } = makeClient([
      json({ title: 'Not Found' }, 404),
      json({ media_id: 9007199254740991, media_id_string: '555' }),
      empty(),
      json({ media_id_string: '555' }),
      // second upload on the same client
      json({ data: { id: '556' } }),
      empty(),
      json({ data: { id: '556' } }),
    ]);
    assert.equal(await client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }), '555');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /404/);

    const [probe, init, append, finalize] = calls;
    assert.equal(probe.url, 'https://api.x.com/2/media/upload/initialize');
    assert.equal(init.url, 'https://api.x.com/2/media/upload?command=INIT&total_bytes=16&media_type=image%2Fpng&media_category=tweet_image');
    assert.equal(init.method, 'POST');
    assert.equal(init.body, null);
    assertSigned(init);
    assert.equal(append.url, 'https://api.x.com/2/media/upload?command=APPEND&media_id=555&segment_index=0');
    assert.ok(append.body instanceof FormData);
    assert.equal(append.body.get('media').name, 'media');
    assert.equal(append.body.get('segment_index'), null, 'segment_index travels in the query on the command-style endpoint');
    assertSigned(append);
    assert.equal(finalize.url, 'https://api.x.com/2/media/upload?command=FINALIZE&media_id=555');
    assert.equal(finalize.method, 'POST');
    assertSigned(finalize);

    assert.equal(await client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }), '556');
    assert.deepEqual(calls.slice(4).map((c) => c.url), [
      'https://api.x.com/2/media/upload?command=INIT&total_bytes=16&media_type=image%2Fpng&media_category=tweet_image',
      'https://api.x.com/2/media/upload?command=APPEND&media_id=556&segment_index=0',
      'https://api.x.com/2/media/upload?command=FINALIZE&media_id=556',
    ]);
    assert.equal(warnings.length, 1, 'no second probe, no second warning');
  });

  test('a 404 from both upload endpoints does not latch the fallback: the next upload probes initialize again', async () => {
    const { client, calls, warnings } = makeClient([
      json({ title: 'Not Found' }, 404), // /2/media/upload/initialize (a stray 404)
      json({ title: 'Not Found' }, 404), // ?command=INIT is not there either
      initialized('1'),
      empty(),
      finalized('1'),
    ]);
    await assert.rejects(client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }), (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.endpoint, 'POST /2/media/upload/initialize', 'the first 404 is the one reported');
      return true;
    });
    assert.deepEqual(calls.map((c) => c.url), [
      'https://api.x.com/2/media/upload/initialize',
      'https://api.x.com/2/media/upload?command=INIT&total_bytes=16&media_type=image%2Fpng&media_category=tweet_image',
    ]);
    assert.equal(warnings.length, 0, 'nothing to announce: no fallback was adopted');

    assert.equal(await client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }), '1');
    assert.deepEqual(calls.slice(2).map((c) => c.url), [
      'https://api.x.com/2/media/upload/initialize',
      'https://api.x.com/2/media/upload/1/append',
      'https://api.x.com/2/media/upload/1/finalize',
    ]);
    assert.equal(warnings.length, 0);
  });

  test('a non-404 failure of the command-style INIT propagates as is, without latching', async () => {
    const { client, calls, warnings } = makeClient([
      json({ title: 'Not Found' }, 404),
      json({ detail: 'Forbidden' }, 403),
      initialized('2'),
      empty(),
      finalized('2'),
    ]);
    await assert.rejects(client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }), (error) => {
      assert.equal(error.status, 403);
      assert.match(error.endpoint, /command=INIT/);
      return true;
    });
    assert.equal(await client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }), '2');
    assert.equal(calls[2].url, 'https://api.x.com/2/media/upload/initialize');
    assert.equal(warnings.length, 0);
  });

  test('other initialize failures propagate unchanged', async () => {
    const { client, calls } = makeClient([json({ detail: 'Forbidden' }, 403)]);
    await assert.rejects(client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }), (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.hint, HINT_403);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  test('accepts media_id_string / safe-integer media_id in place of data.id', async () => {
    const { client } = makeClient([json({ data: { media_id_string: '1' } }), empty(), finalized()]);
    assert.equal(await client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }), '1');
    const numeric = makeClient([json({ media_id: 2 }), empty(), finalized()]);
    assert.equal(await numeric.client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }), '2');
    const none = makeClient([json({ data: {} })]);
    await assert.rejects(none.client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }), /missing media id/);
  });

  test('a 2xx from initialize that carries only errors[] reports the API\'s own reason, not a shape problem', async () => {
    const { client, calls } = makeClient([json({ errors: [{ message: 'Media category tweet_gif is not supported' }] })]);
    await assert.rejects(client.uploadMedia({ buffer: PNG, mimeType: 'image/gif', category: 'tweet_gif' }), (error) => {
      assert.ok(error instanceof XApiError);
      assert.equal(error.message, 'X API 200 on POST /2/media/upload/initialize: Media category tweet_gif is not supported');
      assert.equal(error.status, 200);
      return true;
    });
    assert.equal(calls.length, 1, 'nothing is appended to a media X did not create');
  });

  test('a STATUS or finalize answer that carries only errors[] fails the upload instead of passing as processed', async () => {
    const notFound = json({ errors: [{ title: 'Not Found', detail: 'Could not find media with id m1' }] });
    const { client, calls } = makeClient([initialized(), empty(), finalized('m1', { state: 'pending', check_after_secs: 1 }), notFound]);
    await assert.rejects(client.uploadMedia({ buffer: PNG, mimeType: 'image/gif', category: 'tweet_gif' }), (error) => {
      assert.ok(error instanceof XApiError);
      assert.equal(error.message, 'X API 200 on GET /2/media/upload?command=STATUS&media_id=m1: Could not find media with id m1');
      assert.deepEqual(error.body, { errors: [{ title: 'Not Found', detail: 'Could not find media with id m1' }] });
      return true;
    });
    assert.equal(calls.length, 4);

    const atFinalize = makeClient([initialized(), empty(), json({ errors: [{ message: 'Segments missing' }] })]);
    await assert.rejects(
      atFinalize.client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }),
      { message: 'X API 200 on POST /2/media/upload/m1/finalize: Segments missing' },
    );
    // A finalize answer that names the media and nothing to process is still "done".
    const plain = makeClient([initialized(), empty(), json({ data: { id: 'm1' }, errors: [{ message: 'ignored' }] })]);
    assert.equal(await plain.client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_image' }), 'm1');
  });

  test('validates input before any request', async () => {
    const { client, calls } = makeClient([]);
    await assert.rejects(client.uploadMedia({ buffer: Buffer.alloc(0), mimeType: 'image/png', category: 'tweet_image' }), /must not be empty/);
    await assert.rejects(client.uploadMedia({ buffer: 'bytes', mimeType: 'image/png', category: 'tweet_image' }), /Buffer, Uint8Array or ArrayBuffer/);
    await assert.rejects(client.uploadMedia({ buffer: PNG, mimeType: '', category: 'tweet_image' }), /mimeType/);
    await assert.rejects(client.uploadMedia({ buffer: PNG, mimeType: 'image/png', category: 'tweet_video' }), /category must be one of tweet_image, tweet_gif/);
    assert.equal(calls.length, 0);
  });

  test('accepts an ArrayBuffer', async () => {
    const { client, calls } = makeClient([initialized(), empty(), finalized()]);
    await client.uploadMedia({ buffer: new Uint8Array([1, 2, 3]).buffer, mimeType: 'image/webp', category: 'tweet_image' });
    assert.equal(calls[1].body.get('media').size, 3);
  });
});

describe('client.publishThread', () => {
  const thread = [{ text: 'one', media: [] }, { text: 'two' }, { text: 'three', media: [] }];

  test('posts sequentially, chaining replies and reporting progress', async () => {
    const { client, calls } = makeClient([tweet('1'), tweet('2'), tweet('3')]);
    const progress = [];
    const result = await client.publishThread({ tweets: thread, onProgress: (event) => progress.push(event) });
    assert.deepEqual(result, { tweetIds: ['1', '2', '3'] });
    assert.deepEqual(calls.map((c) => JSON.parse(c.body)), [
      { text: 'one' },
      { text: 'two', reply: { in_reply_to_tweet_id: '1' } },
      { text: 'three', reply: { in_reply_to_tweet_id: '2' } },
    ]);
    assert.deepEqual(progress, [
      { index: 0, tweetId: '1', tweetIds: ['1'] },
      { index: 1, tweetId: '2', tweetIds: ['1', '2'] },
      { index: 2, tweetId: '3', tweetIds: ['1', '2', '3'] },
    ]);
    assert.notEqual(progress[0].tweetIds, progress[1].tweetIds, 'each event gets its own array');
  });

  test('uploads media for a post before posting it and attaches the ids', async () => {
    const { client, calls } = makeClient([
      tweet('1'),
      initialized('p1'), empty(), finalized('p1'), empty(200),
      initialized('g1'), empty(), finalized('g1'),
      tweet('2'),
    ]);
    const tweets = [
      { text: 'one' },
      { text: 'two', media: [{ buffer: PNG, mimeType: 'image/png', alt: 'A cat' }, { buffer: PNG, mimeType: 'image/gif' }] },
    ];
    assert.deepEqual(await client.publishThread({ tweets }), { tweetIds: ['1', '2'] });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url.slice('https://api.x.com'.length)}`), [
      'POST /2/tweets',
      'POST /2/media/upload/initialize',
      'POST /2/media/upload/p1/append',
      'POST /2/media/upload/p1/finalize',
      'POST /2/media/metadata',
      'POST /2/media/upload/initialize',
      'POST /2/media/upload/g1/append',
      'POST /2/media/upload/g1/finalize',
      'POST /2/tweets',
    ]);
    assert.equal(JSON.parse(calls[1].body).media_category, 'tweet_image');
    assert.deepEqual(JSON.parse(calls[4].body), { id: 'p1', metadata: { alt_text: { text: 'A cat' } } });
    assert.equal(JSON.parse(calls[5].body).media_category, 'tweet_gif');
    assert.deepEqual(JSON.parse(calls[8].body), { text: 'two', media: { media_ids: ['p1', 'g1'] }, reply: { in_reply_to_tweet_id: '1' } });
  });

  test('resumes from startIndex replying to replyToId', async () => {
    const { client, calls } = makeClient([tweet('22'), tweet('33')]);
    const progress = [];
    const result = await client.publishThread({ tweets: thread, startIndex: 1, replyToId: '11', onProgress: (e) => progress.push(e.index) });
    assert.deepEqual(result, { tweetIds: ['22', '33'] });
    assert.deepEqual(calls.map((c) => JSON.parse(c.body)), [
      { text: 'two', reply: { in_reply_to_tweet_id: '11' } },
      { text: 'three', reply: { in_reply_to_tweet_id: '22' } },
    ]);
    assert.deepEqual(progress, [1, 2]);
  });

  test('startIndex equal to the length is a no-op resume', async () => {
    const { client, calls } = makeClient([]);
    assert.deepEqual(await client.publishThread({ tweets: thread, startIndex: 3, replyToId: '3' }), { tweetIds: [] });
    assert.equal(calls.length, 0);
  });

  test('a failing post throws XPublishError with the index, partial ids, cause and hint', async () => {
    const { client } = makeClient([tweet('1'), json({ detail: 'Too Many Requests' }, 429, { 'x-rate-limit-reset': '1700000000' })]);
    const progress = [];
    await assert.rejects(client.publishThread({ tweets: thread, onProgress: (e) => progress.push(e.index) }), (error) => {
      assert.ok(error instanceof XPublishError);
      assert.equal(error.name, 'XPublishError');
      assert.equal(error.message, 'Post 2 of 3 failed: X API 429 on POST /2/tweets: Too Many Requests');
      assert.equal(error.index, 1);
      assert.deepEqual(error.tweetIds, ['1']);
      assert.ok(error.cause instanceof XApiError);
      assert.equal(error.cause.status, 429);
      assert.equal(error.hint, `${HINT_429} The limit resets at 2023-11-14T22:13:20.000Z.`);
      return true;
    });
    assert.deepEqual(progress, [0]);
  });

  test('a media upload failure is attributed to the post that owns the media', async () => {
    const { client } = makeClient([tweet('1'), json({ detail: 'Forbidden' }, 403)]);
    const tweets = [{ text: 'one' }, { text: 'two', media: [{ buffer: PNG, mimeType: 'image/png' }] }];
    await assert.rejects(client.publishThread({ tweets }), (error) => {
      assert.equal(error.index, 1);
      assert.deepEqual(error.tweetIds, ['1']);
      assert.match(error.message, /^Post 2 of 2 failed: X API 403 on POST \/2\/media\/upload\/initialize: Forbidden$/);
      assert.equal(error.hint, HINT_403);
      return true;
    });
  });

  test('an onProgress failure after a live post points the resume at the next post', async () => {
    const { client, calls } = makeClient([tweet('1'), tweet('2')]);
    await assert.rejects(
      client.publishThread({ tweets: thread, onProgress: ({ index }) => { if (index === 1) throw new Error('disk full'); } }),
      (error) => {
        assert.ok(error instanceof XPublishError);
        assert.equal(error.message, 'Post 2 of 3 was published but recording progress failed: disk full');
        assert.equal(error.index, 2);
        assert.deepEqual(error.tweetIds, ['1', '2']);
        assert.equal(error.cause.message, 'disk full');
        assert.equal(error.hint, null);
        return true;
      },
    );
    assert.equal(calls.length, 2, 'post 3 was not attempted');
  });

  test('validates the whole thread before posting anything', async () => {
    const { client, calls } = makeClient([]);
    await assert.rejects(client.publishThread({ tweets: [] }), /non-empty array/);
    await assert.rejects(client.publishThread({ tweets: [{ text: 'ok' }, { text: 5 }] }), /tweets\[1\]\.text must be a string/);
    await assert.rejects(client.publishThread({ tweets: [{ text: 'ok', media: [{ buffer: PNG, mimeType: 'video/mp4' }] }] }), /media\[0\]\.mimeType must be an image/);
    await assert.rejects(client.publishThread({ tweets: [{ text: 'ok', media: [{ buffer: Buffer.alloc(0), mimeType: 'image/png' }] }] }), /media\[0\]\.buffer must not be empty/);
    await assert.rejects(client.publishThread({ tweets: [{ text: 'ok', media: [{ buffer: PNG, mimeType: 'image/png', alt: 3 }] }] }), /alt must be a string or null/);
    await assert.rejects(client.publishThread({ tweets: thread, startIndex: 4 }), /startIndex must be an integer between 0 and 3/);
    await assert.rejects(client.publishThread({ tweets: thread, startIndex: -1 }), RangeError);
    await assert.rejects(client.publishThread({ tweets: thread, startIndex: 1 }), /resuming at startIndex 1 needs the replyToId/);
    await assert.rejects(client.publishThread({ tweets: thread, startIndex: 3, replyToId: null }), RangeError);
    await assert.rejects(client.publishThread({ tweets: thread, replyToId: '' }), /replyToId/);
    await assert.rejects(client.publishThread({ tweets: thread, onProgress: 'cb' }), /onProgress/);
    assert.equal(calls.length, 0);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { RETRY_MS, createEventHub } from '../src/events.js';

const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);
const HEARTBEAT = ': ping\n\n';
const EXPECTED_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** Minimal stand-in for http.ServerResponse that records what the hub does to it. */
class FakeRes extends EventEmitter {
  constructor({ failWrites = false } = {}) {
    super();
    this.failWrites = failWrites;
    this.calls = [];
    this.chunks = [];
    this.statusCode = null;
    this.headers = null;
    this.ended = false;
  }
  writeHead(statusCode, headers) {
    this.calls.push('writeHead');
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }
  flushHeaders() {
    this.calls.push('flushHeaders');
  }
  write(chunk) {
    this.calls.push('write');
    if (this.failWrites) throw new Error('write after end');
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.calls.push('end');
    this.ended = true;
  }
}

function connect(hub, options) {
  const req = new EventEmitter();
  const res = new FakeRes(options);
  hub.handler(req, res);
  return { req, res };
}

/** Freeze Date.now and take over setInterval for the duration of one test. */
function pinClock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW });
}

describe('createEventHub options', () => {
  it('rejects a heartbeat interval that is not a positive number within timer range', () => {
    for (const bad of [0, -1, NaN, Infinity, '25000', null, 2 ** 31]) {
      assert.throws(() => createEventHub({ heartbeatMs: bad }), { name: 'RangeError', message: /heartbeatMs/ }, String(bad));
    }
  });

  it('exposes the advertised retry delay', () => {
    assert.equal(RETRY_MS, 3000);
  });
});

describe('handler', () => {
  it('performs the SSE handshake in order and sends retry then hello', (t) => {
    pinClock(t);
    const hub = createEventHub();
    const { res } = connect(hub);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.headers, EXPECTED_HEADERS);
    assert.deepEqual(res.calls, ['writeHead', 'flushHeaders', 'write', 'write']);
    assert.deepEqual(res.chunks, ['retry: 3000\n\n', `event: hello\ndata: {"time":${NOW}}\n\n`]);
    assert.equal(hub.clientCount(), 1);
    hub.close();
  });

  it('requires response and request objects with the methods it uses', () => {
    const hub = createEventHub();
    assert.throws(() => hub.handler(new EventEmitter(), {}), { name: 'TypeError', message: /writeHead, flushHeaders, write, end, on/ });
    assert.throws(() => hub.handler(new EventEmitter(), { ...new FakeRes(), on: undefined }), { name: 'TypeError', message: /\bon\b/ });
    assert.throws(() => hub.handler(null, new FakeRes()), { name: 'TypeError', message: /request object/ });
    assert.throws(() => hub.handler({}, new FakeRes()), { name: 'TypeError', message: /request object/ });
    assert.equal(hub.clientCount(), 0);
  });

  it('removes the client when the response closes, and ignores repeated closes', () => {
    const hub = createEventHub();
    const { res } = connect(hub);
    const other = connect(hub).res;
    assert.equal(hub.clientCount(), 2);

    res.emit('close');
    assert.equal(hub.clientCount(), 1);
    res.emit('close');
    assert.equal(hub.clientCount(), 1);

    hub.emit('draft.deleted', { id: 'd1' });
    assert.equal(res.chunks.length, 2, 'a closed client receives nothing more');
    assert.equal(other.chunks.length, 3);
    hub.close();
  });

  it('also removes the client when the request closes or the response errors', () => {
    const hub = createEventHub();
    const a = connect(hub);
    const b = connect(hub);
    a.req.emit('close');
    assert.equal(hub.clientCount(), 1);
    b.res.emit('error', new Error('ECONNRESET'));
    assert.equal(hub.clientCount(), 0);
    hub.close();
  });

  it('does not throw when the socket dies during the handshake', () => {
    const hub = createEventHub();
    const { res } = connect(hub, { failWrites: true });
    assert.deepEqual(res.calls, ['writeHead', 'flushHeaders', 'write']);
    assert.equal(hub.clientCount(), 0);
    hub.close();
  });
});

describe('emit', () => {
  it('writes event and data lines to every client', (t) => {
    pinClock(t);
    const hub = createEventHub();
    const a = connect(hub).res;
    const b = connect(hub).res;
    const draft = { id: 'd1', tweets: [{ text: 'line one\nline two', media: [] }], status: 'scheduled' };

    hub.emit('draft.updated', { draft });

    const expected = `event: draft.updated\ndata: ${JSON.stringify({ draft })}\n\n`;
    assert.equal(a.chunks[2], expected);
    assert.equal(b.chunks[2], expected);
    assert.equal(expected.split('\n').length, 4, 'newlines inside strings are escaped, keeping one data line');
    hub.close();
  });

  it('serialises a missing payload as null and keeps other JSON values verbatim', () => {
    const hub = createEventHub();
    const { res } = connect(hub);
    hub.emit('reminder');
    hub.emit('posted', null);
    hub.emit('failed', { draft: { id: 'x', result: { error: 'X API 403 on POST /2/tweets: Forbidden' } } });
    assert.deepEqual(res.chunks.slice(2), [
      'event: reminder\ndata: null\n\n',
      'event: posted\ndata: null\n\n',
      'event: failed\ndata: {"draft":{"id":"x","result":{"error":"X API 403 on POST /2/tweets: Forbidden"}}}\n\n',
    ]);
    hub.close();
  });

  it('rejects event types that could break the frame', () => {
    const hub = createEventHub();
    for (const bad of ['', 'has space', 'multi\nline', 'colon:ok\r', 42, null, undefined]) {
      assert.throws(() => hub.emit(bad, {}), { name: 'TypeError', message: /Event type/ }, JSON.stringify(bad));
    }
    assert.doesNotThrow(() => hub.emit('draft.updated', {}), 'no clients is fine');
    assert.doesNotThrow(() => hub.emit('a-b_c:d.e', {}), 'dots, dashes, underscores and colons are allowed');
  });

  it('never throws on a dead socket and drops that client only', () => {
    const hub = createEventHub();
    const healthy = connect(hub).res;
    const dying = connect(hub).res;
    const destroyed = connect(hub).res;
    const ended = connect(hub).res;
    assert.equal(hub.clientCount(), 4);

    dying.failWrites = true;
    destroyed.destroyed = true;
    ended.writableEnded = true;
    assert.doesNotThrow(() => hub.emit('posted', { draft: { id: 'p' } }));

    assert.equal(hub.clientCount(), 1);
    assert.equal(healthy.chunks.length, 3);
    assert.equal(dying.chunks.length, 2);
    assert.equal(destroyed.calls.filter((c) => c === 'write').length, 2, 'a destroyed response is not written to');
    assert.equal(ended.calls.filter((c) => c === 'write').length, 2, 'an ended response is not written to');
    hub.close();
  });
});

describe('heartbeat', () => {
  it('writes a ping comment every heartbeatMs while clients are connected', (t) => {
    pinClock(t);
    const hub = createEventHub({ heartbeatMs: 1000 });
    const a = connect(hub).res;
    const b = connect(hub).res;

    t.mock.timers.tick(999);
    assert.equal(a.chunks.length, 2, 'nothing before the interval elapses');
    t.mock.timers.tick(1);
    assert.equal(a.chunks[2], HEARTBEAT);
    assert.equal(b.chunks[2], HEARTBEAT);
    t.mock.timers.tick(2000);
    assert.deepEqual(a.chunks.slice(2), [HEARTBEAT, HEARTBEAT, HEARTBEAT]);
    hub.close();
  });

  it('defaults to 25 seconds', (t) => {
    pinClock(t);
    const hub = createEventHub();
    const { res } = connect(hub);
    t.mock.timers.tick(24_999);
    assert.equal(res.chunks.length, 2);
    t.mock.timers.tick(1);
    assert.equal(res.chunks[2], HEARTBEAT);
    hub.close();
  });

  it('stops once the last client disconnects and resumes for the next one', (t) => {
    pinClock(t);
    const hub = createEventHub({ heartbeatMs: 1000 });
    const first = connect(hub).res;
    first.emit('close');
    t.mock.timers.tick(5000);
    assert.equal(first.chunks.length, 2, 'no pings after disconnect');

    const second = connect(hub).res;
    t.mock.timers.tick(1000);
    assert.equal(second.chunks[2], HEARTBEAT);
    assert.equal(first.chunks.length, 2);
    hub.close();
  });

  it('drops a client whose socket dies during a ping', (t) => {
    pinClock(t);
    const hub = createEventHub({ heartbeatMs: 1000 });
    const { res } = connect(hub);
    res.failWrites = true;
    assert.doesNotThrow(() => t.mock.timers.tick(1000));
    assert.equal(hub.clientCount(), 0);
    hub.close();
  });

  it('does not keep the process alive (timer is unref-ed)', () => {
    const hub = createEventHub({ heartbeatMs: 60_000 });
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    connect(hub);
    const during = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    assert.equal(during, before, 'an unref-ed interval is not an active resource');
    hub.close();
  });
});

describe('close', () => {
  it('ends every client, clears the count, stops the heartbeat and is idempotent', (t) => {
    pinClock(t);
    const hub = createEventHub({ heartbeatMs: 1000 });
    const a = connect(hub).res;
    const b = connect(hub, { failWrites: true }).res;
    b.failWrites = false;
    b.end = () => {
      throw new Error('socket hang up');
    };

    assert.doesNotThrow(() => hub.close());
    assert.equal(a.ended, true);
    assert.equal(hub.clientCount(), 0);
    t.mock.timers.tick(5000);
    assert.equal(a.chunks.length, 2, 'no heartbeat after close');
    hub.emit('draft.updated', { draft: { id: 'd' } });
    assert.equal(a.chunks.length, 2, 'no broadcast after close');
    assert.doesNotThrow(() => hub.close());
  });

  it('accepts new connections afterwards', (t) => {
    pinClock(t);
    const hub = createEventHub({ heartbeatMs: 1000 });
    connect(hub);
    hub.close();
    const { res } = connect(hub);
    assert.equal(hub.clientCount(), 1);
    t.mock.timers.tick(1000);
    assert.equal(res.chunks[2], HEARTBEAT);
    hub.close();
  });
});

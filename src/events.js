/**
 * Server-Sent Events hub: one Express handler for `GET /api/events`, plus
 * `emit` to broadcast an event to every connected browser tab.
 *
 * Wire format per message: `event: <type>\ndata: <JSON>\n\n`. A comment line
 * (`: ping`) is sent periodically so proxies and browsers keep the idle stream open.
 */

/** Reconnect delay advertised to clients on connect. */
export const RETRY_MS = 3000;

const SSE_HEADERS = Object.freeze({
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});
const HEARTBEAT_CHUNK = ': ping\n\n';
const RETRY_CHUNK = `retry: ${RETRY_MS}\n\n`;
/** Event names go on the wire unescaped, so they must be single-line tokens. */
const EVENT_TYPE_RE = /^[\w.:-]+$/;
/** Node clamps longer timer delays to 1 ms, which would turn the heartbeat into a flood. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const RESPONSE_METHODS = ['writeHead', 'flushHeaders', 'write', 'end', 'on'];

/**
 * @typedef {object} EventHub
 * @property {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler
 * @property {(type: string, payload?: unknown) => void} emit
 * @property {() => number} clientCount
 * @property {() => void} close
 */

/**
 * Create an SSE hub.
 *
 * @param {{ heartbeatMs?: number }} [options] heartbeat interval, default 25 s
 * @returns {EventHub}
 */
export function createEventHub({ heartbeatMs = 25_000 } = {}) {
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs > MAX_TIMER_MS) {
    throw new RangeError(`heartbeatMs must be a number between 1 and ${MAX_TIMER_MS} (got ${String(heartbeatMs)})`);
  }

  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  let heartbeat = null;

  function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => broadcast(HEARTBEAT_CHUNK), heartbeatMs);
    heartbeat.unref();
  }

  function stopHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = null;
  }

  /** Forget a client. Safe to call repeatedly (close events can arrive from several sources). */
  function drop(res) {
    if (!clients.delete(res)) return;
    if (clients.size === 0) stopHeartbeat();
  }

  /** Write to one registered client, dropping it instead of throwing when the socket is gone. */
  function send(res, chunk) {
    if (!clients.has(res)) return;
    if (res.destroyed || res.writableEnded) {
      drop(res);
      return;
    }
    try {
      res.write(chunk);
    } catch {
      drop(res);
    }
  }

  function broadcast(chunk) {
    // Deleting the current element while iterating a Set is well-defined, so no copy is needed.
    for (const res of clients) send(res, chunk);
  }

  /**
   * Express handler for `GET /api/events`: sends the SSE preamble, a `hello`
   * event, and keeps the response open until the client disconnects.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function handler(req, res) {
    assertResponse(res);
    if (typeof req?.on !== 'function') {
      throw new TypeError('events.handler expects a request object with an on() method');
    }

    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();

    clients.add(res);
    startHeartbeat();
    const bye = () => drop(res);
    // 'close' on the response is the disconnect signal; the request fires it too on
    // some Node versions, and an 'error' listener stops a late write from throwing.
    res.on('close', bye);
    res.on('error', bye);
    req.on('close', bye);

    send(res, RETRY_CHUNK);
    send(res, formatEvent('hello', { time: Date.now() }));
  }

  /**
   * Broadcast one event to every connected client.
   *
   * @param {string} type event name, e.g. 'draft.updated'
   * @param {unknown} [payload] JSON-serialisable body (undefined becomes null)
   */
  function emit(type, payload) {
    broadcast(formatEvent(type, payload));
  }

  /** @returns {number} connected clients */
  function clientCount() {
    return clients.size;
  }

  /** End every connection and stop the heartbeat. Idempotent. */
  function close() {
    stopHeartbeat();
    for (const res of clients) {
      try {
        res.end();
      } catch {
        // The socket is already gone; nothing left to end.
      }
    }
    clients.clear();
  }

  return { handler, emit, clientCount, close };
}

/**
 * Serialise one SSE message.
 * @param {string} type
 * @param {unknown} payload
 * @returns {string}
 */
function formatEvent(type, payload) {
  if (typeof type !== 'string' || !EVENT_TYPE_RE.test(type)) {
    throw new TypeError(`Event type must match ${EVENT_TYPE_RE} (got ${JSON.stringify(type)})`);
  }
  // JSON.stringify escapes newlines inside strings, so the data line never breaks the frame.
  return `event: ${type}\ndata: ${JSON.stringify(payload === undefined ? null : payload)}\n\n`;
}

function assertResponse(res) {
  const missing = RESPONSE_METHODS.filter((method) => typeof res?.[method] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(`events.handler expects a response object with ${missing.join(', ')}`);
  }
}

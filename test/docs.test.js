import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The README, .env.example and package.json promise things the code has to keep.
// These checks pin the mechanical parts of those promises to the source they describe.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const readme = read('README.md');
const envExample = read('.env.example');
const pkg = JSON.parse(read('package.json'));

/** @param {number[]} a @param {number[]} b */
const compareVersions = (a, b) => a.map((n, i) => n - (b[i] ?? 0)).find((d) => d !== 0) ?? 0;

describe('Node version floor', () => {
  const enginesMatch = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(pkg.engines.node);
  assert.ok(enginesMatch, `engines.node should be a ">=x.y.z" floor, got ${pkg.engines.node}`);
  const floor = enginesMatch.slice(1).map(Number);

  test('README quick start and package.json engines agree', () => {
    const readmeMatch = /Requires Node (\d+)\.(\d+) or newer/.exec(readme);
    assert.ok(readmeMatch, 'README should say "Requires Node x.y or newer"');
    assert.deepEqual(readmeMatch.slice(1).map(Number), floor.slice(0, 2));
  });

  test('covers every node:sqlite DatabaseSync accessor src/db.js relies on', () => {
    // Per the Node 22 sqlite docs: database.isOpen was added in 22.15.0, database.isTransaction in 22.16.0.
    // On older 22.x both are undefined, so close() silently never closes and the README's shutdown promise breaks.
    const ADDED_IN = { isOpen: [22, 15, 0], isTransaction: [22, 16, 0] };
    const dbSource = read('src/db.js');
    let used = 0;
    for (const [name, addedIn] of Object.entries(ADDED_IN)) {
      if (!new RegExp(`\\.${name}\\b`).test(dbSource)) continue;
      used += 1;
      assert.ok(
        compareVersions(floor, addedIn) >= 0,
        `src/db.js uses database.${name} (added in Node ${addedIn.join('.')}) but engines.node is ${pkg.engines.node}`,
      );
    }
    assert.ok(used > 0, 'expected src/db.js to use at least one of the guarded accessors; update ADDED_IN if that changed');
  });
});

describe('README', () => {
  test('explains every --disable-warning flag the npm scripts pass', () => {
    const flags = new Set();
    for (const script of Object.values(pkg.scripts)) {
      for (const match of script.matchAll(/--disable-warning=(\S+)/g)) flags.add(match[1]);
    }
    assert.ok(flags.has('ExperimentalWarning') && flags.has('DEP0040'));
    for (const flag of flags) {
      assert.match(readme, new RegExp(`\`--disable-warning=${flag}\`\\s+because`), `README should say why ${flag} is silenced`);
    }
  });

  test('documents every variable in .env.example', () => {
    const vars = [...envExample.matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1]);
    assert.ok(vars.includes('X_HANDLE') && vars.includes('APP_PASSWORD'));
    for (const name of vars) assert.ok(readme.includes(`\`${name}\``), `${name} is missing from the README`);
  });

  test('quotes the X-status strings the terminal and the sidebar really show', () => {
    const appJs = read('public/app.js');
    const serverJs = read('src/server.js');
    assert.ok(appJs.includes('X API: connected as @'));
    assert.ok(appJs.includes('X API: not configured — reminder mode'));
    assert.ok(serverJs.includes('X API: configured'));
    assert.ok(readme.includes('`X API: configured (@handle)`'), 'terminal banner text');
    assert.ok(readme.includes('`X API: connected as @handle`'), 'sidebar footer text');
    assert.ok(readme.includes('`X API: not configured — reminder mode`'), 'sidebar footer text without keys');
    assert.ok(envExample.includes('connected as @handle'), '.env.example should describe where X_HANDLE shows up');
    const frontEnd = appJs + read('public/index.html');
    if (!/preview/i.test(frontEnd)) {
      assert.doesNotMatch(envExample, /preview/i, '.env.example mentions a preview the front end does not have');
    }
  });

  test('documents the note field the verify route always returns', () => {
    // src/api.js adds `note` to both the success and the failure shape (test/api.test.js asserts on it).
    assert.match(read('src/api.js'), /res\.json\(\{ ok: true, user: [^}]*\bnote \}\)/);
    assert.ok(readme.includes('`{ ok: true, user, note }`'), 'success shape');
    assert.ok(readme.includes('`{ ok: false, error, hint, note }`'), 'failure shape');
    assert.doesNotMatch(readme, /\{ ok(: true)?, user \}/, 'a verify shape without note is still documented');
  });

  test('describes the Content Security Policy the server actually sends', () => {
    const csp = /const CSP = "([^"]+)"/.exec(read('src/api.js'))?.[1];
    assert.ok(csp, 'expected a CSP constant in src/api.js');
    const paragraph = /\*\*Security headers\*\*[\s\S]*?\n\n/.exec(readme)?.[0];
    assert.ok(paragraph, 'README should have a **Security headers** paragraph');
    const styleSrc = /style-src ([^;]+)/.exec(csp)?.[1] ?? '';
    if (styleSrc.includes("'unsafe-inline'")) {
      assert.match(paragraph, /inline styles/, "style-src allows 'unsafe-inline', so the README must not claim styles are own-origin only");
    } else {
      assert.doesNotMatch(paragraph, /inline styles/);
    }
    assert.ok(paragraph.includes('`data:`') && paragraph.includes('`blob:`'), 'image exceptions');
  });
});

// Round 2: the behaviours added then, pinned to the source the README describes.
describe('README, round-2 behaviour', () => {
  const apiJs = read('src/api.js');
  const appJs = read('public/app.js');
  const xJs = read('src/x.js');
  const configJs = read('src/config.js');
  /** The README with its line wraps folded, for phrases that span lines. */
  const flat = readme.replace(/\s+/g, ' ');
  /** The table row of the README that starts with this key, or undefined. */
  const row = (start) => readme.split('\n').find((line) => line.startsWith(start));

  test('documents the Host and cross-site guard the API really applies, with its status codes', () => {
    assert.match(apiJs, /function originGuard\(/);
    assert.ok(apiJs.includes('res.status(421)'), 'the guard answers 421 to a Host it does not serve');
    assert.ok(apiJs.includes('res.status(403)'), 'the guard answers 403 to a cross-site request');
    const paragraph = /\*\*Host and cross-site checks\*\*[\s\S]*?\n\n/.exec(readme)?.[0];
    assert.ok(paragraph, 'README should have a **Host and cross-site checks** paragraph');
    for (const needle of ['`ALLOWED_HOSTS`', '421', '403', '`Sec-Fetch-Site`', '`Origin`', '`localhost`', '`127.0.0.1`', '`[::1]`']) {
      assert.ok(paragraph.includes(needle), `the paragraph should mention ${needle}`);
    }
    assert.ok(apiJs.includes("'Cross-site requests are not allowed'") && readme.includes('`Cross-site requests are not allowed`'));
    assert.ok(apiJs.includes('This server does not answer to the host name') && readme.includes('This server does not answer to the host name'));
    assert.match(envExample, /^ALLOWED_HOSTS=/m, '.env.example should list ALLOWED_HOSTS');
    assert.match(read('src/server.js'), /env\.ALLOWED_HOSTS/, 'server.js should read ALLOWED_HOSTS');
    // The nginx example passes the public name through, so it must tell the reader to list it.
    const nginx = /```nginx[\s\S]*?```/.exec(readme)?.[0];
    assert.ok(nginx, 'README should keep the nginx example');
    if (nginx.includes('proxy_set_header Host')) assert.match(nginx, /ALLOWED_HOSTS/);
    assert.match(row('| `ALLOWED_HOSTS`') ?? '', /421/);
  });

  test('quotes the X request deadline and the hints the client really produces', () => {
    const timeout = /const DEFAULT_TIMEOUT_MS = ([\d_]+);/.exec(xJs)?.[1];
    assert.ok(timeout, 'x.js should define DEFAULT_TIMEOUT_MS');
    const seconds = Number(timeout.replace(/_/g, '')) / 1000;
    assert.match(xJs, /timed out after \$\{timeoutMs \/ 1000\}s on \$\{endpoint\}/);
    assert.ok(flat.includes(`X API request timed out after ${seconds}s on POST /2/tweets`), 'the timeout message');
    assert.ok(flat.includes(`${seconds}-second deadline`), 'the deadline in the loop description');
    const hint = /const DUPLICATE_HINT = '([^']+)'/.exec(xJs)?.[1];
    assert.ok(hint, 'x.js should define DUPLICATE_HINT');
    assert.match(xJs, /status === 403 && \/duplicate content\/i/);
    assert.ok(flat.includes(hint), 'README should quote the duplicate-content hint');
    assert.ok(xJs.includes('x-user-limit-24hour-remaining') && readme.includes('`x-user-limit-24hour-remaining`'), '24-hour cap');
    assert.match(xJs, /function networkReason\(/);
    assert.ok(flat.includes('fetch failed: getaddrinfo ENOTFOUND api.x.com'), 'a network failure with its cause');
  });

  test('quotes the refusals the JSON API answers', () => {
    const inUse = /const MEDIA_IN_USE = '([^']+)'/.exec(apiJs)?.[1];
    assert.ok(inUse, 'api.js should define MEDIA_IN_USE');
    assert.ok(flat.includes(inUse), 'README should quote MEDIA_IN_USE');
    assert.match(row('| `DELETE /api/media/:id`') ?? '', /409/);
    assert.ok(apiJs.includes("'Send the body as application/json'") && readme.includes('`Send the body as application/json`'));
    assert.ok(apiJs.includes(`'"at" is too far in the future'`) && readme.includes('`"at" is too far in the future`'));
    assert.match(row('| `POST /api/drafts/:id/schedule`') ?? '', /floored to the whole minute/);
    assert.match(row('| `POST /api/drafts/:id/retry`') ?? '', /Fix these first/);
    // The HTTP API overview lists every status the app answers with.
    const overview = /### HTTP API\n\n([\s\S]*?)\n\n/.exec(readme)?.[1] ?? '';
    for (const status of ['400', '401', '403', '404', '409', '413', '415', '421', '500']) assert.match(overview, new RegExp(`\\b${status}\\b`));
  });

  test('keeps the record of posts already on X through unschedule, locks them, and says so', () => {
    const route = /app\.post\('\/api\/drafts\/:id\/unschedule'[\s\S]*?\n  \}\);/.exec(apiJs)?.[0];
    assert.ok(route, 'the unschedule route');
    assert.doesNotMatch(route, /result: null/, 'unschedule must keep the partial result');
    assert.match(route, /resumableResult\(draft\)/);
    assert.doesNotMatch(read('src/scheduler.js'), /RESUMABLE_STATUSES/, 'resumability is a property of the result, not the status');
    const lock = 'already on X and cannot be changed — duplicate the draft to rewrite them.';
    assert.ok(apiJs.includes(lock));
    assert.ok(flat.includes(`Post 1 is ${lock}`), 'README should quote the 409 lock message');
    assert.match(row('| `PUT /api/drafts/:id`') ?? '', /409 `Post 1 is already on X/);
    assert.match(row('| `POST /api/drafts/:id/unschedule`') ?? '', /tweetIds/);
    assert.match(readme, /^#### Partially published threads$/m);
    assert.ok(appJs.includes('are already on X and are locked.') && appJs.includes('Duplicate the thread to start over.'));
    assert.ok(flat.includes('Posts 1–k are already on X and are locked. Publishing continues from post k+1. Duplicate the thread to start over.'), 'the banner copy');
    assert.ok(appJs.includes('https://x.com/i/status/') && readme.includes('`https://x.com/i/status/<id>`'), 'the Posted badge link');
    assert.ok(appJs.includes('`Retry from post ${k + 1}`') && readme.includes('"Retry from post k+1"'));
    assert.ok(appJs.includes("'Schedule retry'") && readme.includes('"Schedule retry ▾"'));
    assert.doesNotMatch(readme, /Posts 1–k were published; Retry continues/, 'the old banner text');
  });

  test('documents the config ranges the validator enforces', () => {
    const maxDays = /MAX_QUEUE_DAYS = (\d+)/.exec(configJs)?.[1];
    assert.ok(maxDays, 'config.js should define MAX_QUEUE_DAYS');
    assert.match(configJs, /MAX_SCHEDULER_INTERVAL_SECONDS = Math\.floor\(\(2 \*\* 31 - 1\) \/ 1000\)/);
    const maxInterval = Math.floor((2 ** 31 - 1) / 1000);
    assert.match(row('| `queueDaysAhead`') ?? '', new RegExp(`1 to ${maxDays}`));
    assert.match(row('| `schedulerIntervalSeconds`') ?? '', new RegExp(`1 to ${maxInterval}`));
    assert.match(row('| `missedGraceMinutes`') ?? '', />= 0/);
  });

  test('quotes the notification texts the front end really shows', () => {
    assert.doesNotMatch(readme, /Notifications blocked in browser settings/, 'a message the app never shows');
    for (const text of [
      'Notifications are blocked for this site, so reminders only show while a tab is open. Allow them in the browser settings to be alerted.',
      'Notifications are blocked. Allow them in the browser settings.',
    ]) {
      assert.ok(appJs.includes(text), `app.js should show: ${text}`);
      assert.ok(flat.includes(text), `README should quote: ${text}`);
    }
  });

  test('describes the calendar, the trailing-empty-card rule and the two-tab limitation as implemented', () => {
    assert.ok(appJs.includes('listed once, at the top, not in its day as well'));
    assert.doesNotMatch(readme, /repeated at the top/, 'due items are no longer listed twice');
    assert.ok(flat.includes('listed once, at the top, under "Needs attention"'));
    assert.match(appJs, /function withoutTrailingEmpty\(/);
    assert.ok(flat.includes('**Trailing empty cards.**'));
    // Client and server drop trailing empty posts the same way, and the README says so for both.
    assert.match(apiJs, /function withoutTrailingEmpty\(/, 'the server drops trailing empty posts too');
    for (const route of ['schedule', 'publish', 'retry']) {
      assert.match(apiJs, new RegExp(`'/api/drafts/:id/${route}'[\\s\\S]{0,300}withoutTrailingEmpty\\(draft\\.tweets\\)`), `/${route} trims before validating`);
    }
    assert.ok(flat.includes('`/schedule`, `/publish` and `/retry` drop trailing empty posts'), 'the README describes the server-side rule');
    assert.doesNotMatch(flat, /empty post anywhere when a thread is sent straight/, 'the old claim that the API refuses trailing empty posts');
    assert.doesNotMatch(appJs, /ifUpdatedAt|If-Match/, 'no conflict detection: the README lists the limitation instead');
    assert.ok(flat.includes('the last save wins'), 'the two-tab limitation');
    assert.doesNotMatch(flat, /anything else that reads from X/, 'verify and STATUS polls do read from X');
    assert.ok(flat.includes('the only reads from X are the optional `GET /api/x/verify` check'));
  });
});

describe('Deployment kit', () => {
  const files = ['Dockerfile', '.dockerignore', 'docker-compose.yml', 'fly.toml', 'railway.toml', 'render.yaml'];

  test('ships every file the README lists, and the README lists every file', () => {
    const table = /## Deploying[\s\S]*?### Docker/.exec(readme)?.[0] ?? '';
    for (const file of files) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} should exist`);
      assert.ok(table.includes(`\`${file}\``), `README should describe ${file}`);
    }
  });

  test('every health check probes /healthz, which the API serves without a password or Host check', () => {
    assert.match(read('src/api.js'), /app\.get\('\/healthz'/);
    assert.match(read('Dockerfile'), /HEALTHCHECK[\s\S]*\/healthz/);
    assert.match(read('fly.toml'), /path = "\/healthz"/);
    assert.match(read('railway.toml'), /healthcheckPath = "\/healthz"/);
    assert.match(read('render.yaml'), /healthCheckPath: \/healthz/);
    assert.ok(readme.includes('`GET /healthz`'));
  });

  test('pins one always-on instance everywhere, because the scheduler runs in-process', () => {
    assert.match(read('fly.toml'), /auto_stop_machines = "off"/);
    assert.match(read('fly.toml'), /min_machines_running = 1/);
    assert.match(read('railway.toml'), /numReplicas = 1/);
    assert.match(read('render.yaml'), /numInstances: 1/);
    assert.match(read('fly.toml'), /destination = "\/data"/);
    assert.match(read('render.yaml'), /mountPath: \/data/);
    assert.match(read('docker-compose.yml'), /\.\/data:\/data/);
  });

  test('the image runs the app with the same flags as npm start and explains why function platforms do not fit', () => {
    const start = JSON.parse(read('package.json')).scripts.start;
    const cmd = /CMD \[(.*)\]/.exec(read('Dockerfile'))?.[1] ?? '';
    for (const flag of start.split(' ').slice(1)) assert.ok(cmd.includes(`"${flag}"`), `Dockerfile CMD should pass ${flag}`);
    assert.match(readme, /Vercel, Netlify and similar function platforms do not fit/);
  });
});

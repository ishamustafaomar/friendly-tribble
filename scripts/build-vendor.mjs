// Bundles twitter-text (Apache-2.0) into a single browser script that exposes
// `window.twttr`. The output is committed so the app needs no build step;
// re-run `npm run build:vendor` only when upgrading twitter-text.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
const entry = require.resolve('twitter-text/dist/esm/index.js');
const version = JSON.parse(readFileSync(require.resolve('twitter-text/package.json'), 'utf8')).version;
const outfile = path.join(root, '..', 'public', 'vendor', 'twitter-text.js');

await build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  platform: 'browser',
  format: 'iife',
  globalName: '__twitterText',
  banner: { js: `/* twitter-text v${version} — Copyright Twitter, Inc. Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Bundled by scripts/build-vendor.mjs. */` },
  footer: { js: 'window.twttr = __twitterText.default || __twitterText;' },
  outfile,
  logLevel: 'info',
});

/**
 * Build the browser bundle.
 *
 * The bundle is committed so the demo works with no toolchain, which also means
 * the upstream licence notices have to travel *inside* it: MIT requires the
 * notice to accompany every copy, and a single bundled file is a copy. esbuild's
 * `legalComments: 'eof'` keeps the notices that live in source comments; the
 * banner below guarantees the three packages are named even if a future upstream
 * build strips them.
 */
import { build } from 'esbuild';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = JSON.parse(readFileSync(resolve(root, 'third_party/INDEX.json'), 'utf8'));

const banner = [
  '/*!',
  ' * cronoscope — browser bundle',
  ' *',
  ...index.packages.map(
    (p) => ` * ${p.name} ${p.version} — ${p.license} — ${p.copyright || 'see licence file'}`,
  ),
  ' *',
  ' * Full licence texts: THIRD_PARTY_NOTICES.md and third_party/<package>/LICENSE',
  ' * in the distribution. This bundle includes those packages unmodified.',
  ' */',
].join('\n');

const outfile = resolve(root, 'demo/bundle.js');

await build({
  entryPoints: [resolve(root, 'demo/app.js')],
  outfile,
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  platform: 'browser',
  minify: true,
  legalComments: 'eof',
  banner: { js: banner },
  logLevel: 'warning',
  metafile: true,
});

const size = statSync(outfile).size;
console.log(`demo/bundle.js  ${(size / 1024).toFixed(1)} KB`);

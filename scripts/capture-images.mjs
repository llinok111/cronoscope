/**
 * Documentation screenshots, captured from the real page.
 *
 * No mock-ups and no generated art: each image is the demo page in a named
 * state (deep link `?job=N`), rendered by headless Chrome against a local HTTP
 * server. Immediately after capture the PNG is decoded and measured with
 * `png-stats.mjs`, so a blank or half-rendered frame fails here instead of
 * shipping. The measurements are printed and also asserted by
 * `test/images.test.js`.
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname, join, extname, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, imageStats } from './png-stats.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs/images');

const SHOTS = [
  { file: 'overview.png', query: '?from=2026-03-01&to=2026-03-31&job=0', note: 'DST shift on a daily job' },
  { file: 'arity-error.png', query: '?from=2026-03-01&to=2026-03-31&job=4', note: '4-field expression, engine pads it' },
  { file: 'dead-schedule.png', query: '?from=2026-03-01&to=2026-03-31&job=5', note: 'parses but never fires; next real run named' },
];

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const VIEWPORT = { width: 1680, height: 1050 };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const file = join(root, rel);
  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) {
  console.error('no Chrome/Edge binary found');
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { port } = server.address();

const capture = (url, file) =>
  new Promise((done, fail) => {
    const child = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      '--virtual-time-budget=6000',
      `--screenshot=${file}`,
      url,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`screenshot timed out for ${url}`));
    }, 60_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!existsSync(file)) fail(new Error(`no file produced for ${url}\n${err.slice(-400)}`));
      else done(code);
    });
  });

const results = [];
for (const shot of SHOTS) {
  const file = join(outDir, shot.file);
  await capture(`http://127.0.0.1:${port}/demo/index.html${shot.query}`, file);
  const png = decodePng(await readFile(file));
  const stats = imageStats(png);
  results.push({ ...shot, stats, path: relative(root, file) });
  console.log(`${shot.file.padEnd(22)} ${stats.width}×${stats.height}  colours=${stats.uniqueColors}  luma=${stats.meanLuma}  sd=${stats.stdevLuma}`);
  console.log(`  bands: ${stats.bands.map((b) => `${b.mean}/${b.stdev}`).join('  ')}`);
}

server.close();

const problems = [];
for (const { file, stats } of results) {
  if (stats.width !== VIEWPORT.width || stats.height !== VIEWPORT.height) {
    problems.push(`${file}: unexpected size ${stats.width}×${stats.height}`);
  }
  if (stats.uniqueColors < 200) problems.push(`${file}: only ${stats.uniqueColors} distinct colours — likely blank`);
  if (stats.stdevLuma < 12) problems.push(`${file}: luma spread ${stats.stdevLuma} — likely a flat frame`);
  if (stats.meanLuma > 120) problems.push(`${file}: mean luma ${stats.meanLuma} — expected the dark theme`);
  for (const [i, band] of stats.bands.entries()) {
    if (band.stdev < 4) problems.push(`${file}: band ${i} is flat (stdev ${band.stdev})`);
  }
}

if (problems.length > 0) {
  console.error(`\ncapture check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`\n${results.length} screenshots captured and measured in docs/images/`);

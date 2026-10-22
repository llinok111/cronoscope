/**
 * Headless smoke test for the demo page.
 *
 * A bundle that builds is not a page that works. This starts a local HTTP
 * server, loads the real page in headless Chrome/Edge, and asserts on the DOM
 * that the browser produced — including strings that can only appear if the
 * audit actually ran in the page (a finding code and a real instant).
 *
 * No screenshot is compared: this machine's image tooling cannot read images
 * back (documented in docs/LIMITS.md), so the check is DOM text, not pixels.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const file = join(root, rel || 'demo/index.html');
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
  console.error('no Chrome/Edge binary found; demo check skipped');
  process.exit(1);
}

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { port } = server.address();

const dump = (path) =>
  new Promise((done, fail) => {
    const child = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--virtual-time-budget=6000',
      '--dump-dom',
      `http://127.0.0.1:${port}/demo/index.html${path}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`browser did not finish in 45s\n${err.slice(-800)}`));
    }, 45_000);
    child.on('exit', () => {
      clearTimeout(timer);
      done(out);
    });
  });

const extraUrl = `http://127.0.0.1:${port}/demo/index.html`;

// Each state is a deep link, so the checks below are the same states the
// documentation screenshots are captured from.
const STATES = [
  {
    name: 'default (nightly-backup)',
    path: '',
    checks: [
      ['page rendered the header', /crono<span>scope<\/span>/],
      ['version banner names the engines', /cron-parser/],
      ['job list rendered', /data-field="expression"/],
      ['all six preset jobs are in the list', /data-index="5"/],
      ['a DST finding is on the page', /dst\.gap\.shifted/],
      ['the finding carries measured evidence', /"deltaMinutes": 60/],
      ['a real local instant is on the page', /2026-03-08 03:30:00 -04:00/],
      ['collision section rendered', /Cross-job collisions/],
      ['systemd translation rendered', /OnCalendar=/],
      ['RRULE translation rendered', /RRULE|FREQ=/],
    ],
  },
  {
    name: '?job=4 (4-field expression)',
    path: '?from=2026-03-01&to=2026-03-31&job=4',
    checks: [
      ['the short-expression error is shown', /arity\.short/],
      ['the padded form is named', /\* 0 3 \* \*/],
      ['the engine/describer disagreement is shown', /engines\.disagree/],
      ['verdict flips to needs fixing', /needs fixing/],
    ],
  },
  {
    name: '?job=5 (dead schedule)',
    path: '?from=2026-03-01&to=2026-03-31&job=5',
    checks: [
      ['the dead-schedule error is shown', /schedule\.dead/],
      ['the next real occurrence is named', /2028-02-29/],
      ['zero occurrences are reported', /0 occurrence\(s\)/],
      ['verdict flips to needs fixing', /needs fixing/],
    ],
  },
];

let failed = 0;
for (const state of STATES) {
  console.log(`\n— ${state.name}`);
  const dom = await dump(state.path);
  for (const [label, pattern] of state.checks) {
    const ok = pattern.test(dom);
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  }
  console.log(`    DOM ${dom.length} bytes`);
}

server.close();
console.log(`\npage base: ${extraUrl.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:<port>')}`);
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('demo page verified in headless browser (3 states)');


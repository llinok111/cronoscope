import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const bin = resolve(root, 'bin/cronoscope.js');

const run = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8' });

describe('cronoscope CLI', () => {
  it('prints its version', () => {
    const out = run(['version']);
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toMatch(/^cronoscope \d+\.\d+\.\d+$/);
  });

  it('prints help with no arguments', () => {
    const out = run([]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('cronoscope audit');
    expect(out.stdout).toContain('Exit codes');
  });

  it('explains an expression in both languages', () => {
    const out = run(['explain', '*/5 * * * *']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('Every 5 minutes');
    expect(out.stdout).toContain('每隔 5 分钟');
    expect(out.stdout).toContain('systemd');
    expect(out.stdout).toContain('rrule');
  });

  it('lists the next occurrences', () => {
    const out = run(['next', '0 0 * * *', '--tz', 'Asia/Shanghai', '--count', '2']);
    expect(out.status).toBe(0);
    const lines = out.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('2026-');
  });

  it('audits a clean job with exit code 0', () => {
    const out = run(['audit', 'examples/jobs.json', '--from', '2026-01-01', '--to', '2026-01-05', '--format', 'json']);
    const report = JSON.parse(out.stdout);
    expect(report.meta.tool.name).toBe('cronoscope');
    // The fixture set contains a deliberately broken job, so errors exist.
    expect(out.status).toBe(3);
  });

  it('honours --fail-on none', () => {
    const out = run(['audit', 'examples/jobs.json', '--from', '2026-01-01', '--to', '2026-01-05', '--fail-on', 'none']);
    expect(out.status).toBe(0);
  });

  it('writes markdown to a file on request', () => {
    const target = 'test/.tmp-report.md';
    const out = run(['audit', 'examples/jobs.json', '--from', '2026-01-01', '--to', '2026-01-05', '--format', 'md', '--out', target, '--fail-on', 'none']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('wrote');
  });

  it('converts an expression to systemd and RRULE', () => {
    const out = run(['convert', '0 9 * * 1-5']);
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.systemd.value).toBe('Mon..Fri *-*-* 09:00:00');
    expect(parsed.rrule.value).toContain('FREQ=WEEKLY');
    expect(parsed.ics).toContain('BEGIN:VCALENDAR');
  });

  it('fails with exit code 2 on a usage error', () => {
    const out = run(['explain']);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('needs a cron expression');

    const unknown = run(['frobnicate']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown command');
  });

  it('reports a bad jobs file instead of crashing', () => {
    const out = run(['audit', 'does-not-exist.json']);
    expect(out.status).toBe(4);
    expect(out.stderr).toMatch(/ENOENT|no such file/i);
  });
});

import { describe, it, expect } from 'vitest';
import { parseExpression } from '../src/expression.js';
import { toSystemd, toRRule, toIcs, toMarkdown, toCsv } from '../src/export.js';
import { audit } from '../src/index.js';

const systemd = (expr) => toSystemd(parseExpression(expr));
const rrule = (expr) => toRRule(parseExpression(expr));

describe('systemd OnCalendar', () => {
  it('translates simple schedules exactly', () => {
    expect(systemd('30 2 * * *').value).toBe('*-*-* 02:30:00');
    expect(systemd('*/15 * * * *').value).toBe('*-*-* *:00,15,30,45:00');
    expect(systemd('0 0 * * 1-5').value).toBe('Mon..Fri *-*-* 00:00:00');
    expect(systemd('0 6 1 * *').value).toBe('*-*-01 06:00:00');
    expect(systemd('* * * * *').value).toBe('*-*-* *:*:00');
    expect(systemd('*/20 * * * * *').value).toBe('*-*-* *:*:00,20,40');
  });

  it('refuses the expressions systemd cannot express, with a reason', () => {
    const both = systemd('0 0 1 * 1');
    expect(both.supported).toBe(false);
    expect(both.reason).toMatch(/ORs day-of-month/);

    expect(systemd('0 23 L * *').reason).toMatch(/no equivalent for L/);
    expect(systemd('0 9 * * 1#1').reason).toMatch(/no equivalent for L/);
    expect(systemd('H * * * *').supported).toBe(false);
  });
});

describe('RFC 5545 RRULE', () => {
  it('picks a frequency that matches the cadence', () => {
    expect(rrule('30 2 * * *').value).toBe('FREQ=DAILY;BYMINUTE=30;BYHOUR=2');
    expect(rrule('*/15 * * * *').value).toBe('FREQ=HOURLY;BYMINUTE=0,15,30,45');
    expect(rrule('* * * * *').value).toBe('FREQ=MINUTELY');
    expect(rrule('0 9 * * 1-5').value).toBe('FREQ=WEEKLY;BYMINUTE=0;BYHOUR=9;BYDAY=MO,TU,WE,TH,FR;WKST=SU');
  });

  it('maps last-day and nth-weekday selectors onto calendar rules', () => {
    expect(rrule('0 23 L * *').value).toBe('FREQ=MONTHLY;BYMINUTE=0;BYHOUR=23;BYMONTHDAY=-1');
    expect(rrule('0 9 * * 1#1').value).toBe('FREQ=MONTHLY;BYMINUTE=0;BYHOUR=9;BYDAY=1MO');
    expect(rrule('0 9 * * 5L').value).toBe('FREQ=MONTHLY;BYMINUTE=0;BYHOUR=9;BYDAY=-1FR');
  });

  it('refuses what a calendar rule cannot represent', () => {
    expect(rrule('0 0 1 * 1').supported).toBe(false);
    expect(rrule('*/20 * * * * *').reason).toMatch(/sub-minute/);
  });
});

describe('iCalendar export', () => {
  const report = audit([{ name: 'nightly', expression: '30 2 * * *', tz: 'America/New_York' }], {
    from: '2026-03-01',
    to: '2026-03-31',
    windowTz: 'America/New_York',
  });
  const ics = toIcs(report.jobs[0], { nowMs: Date.parse('2026-01-01T00:00:00Z') });

  it('emits a well-formed single-event calendar', () => {
    expect(ics.text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.text.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics.text).toContain('BEGIN:VEVENT');
    expect(ics.text).toContain('DTSTAMP:20260101T000000Z');
    expect(ics.text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it('uses a floating local DTSTART so the schedule keeps following the wall clock', () => {
    expect(ics.text).toContain('DTSTART:20260301T023000');
    expect(ics.text).not.toContain('DTSTART:20260301T073000Z');
    expect(ics.text).toContain('RRULE:FREQ=DAILY;BYMINUTE=30;BYHOUR=2');
  });

  it('marks unsupported rules instead of silently dropping them', () => {
    const bad = toIcs(
      { name: 'or-rule', expression: '0 0 1 * 1', tz: 'UTC', timeline: [], description: { en: { text: '' } } },
      { nowMs: 0 },
    );
    expect(bad.supported).toBe(false);
    expect(bad.text).toContain('X-CRONOSCOPE-UNSUPPORTED');
  });
});

describe('markdown report', () => {
  const report = audit(
    [
      { name: 'nightly-backup', expression: '30 2 * * *', tz: 'America/New_York', durationSeconds: 900 },
      { name: 'cache-warm', expression: '0 2 * * *', tz: 'America/New_York', durationSeconds: 600 },
    ],
    { from: '2026-03-01', to: '2026-03-31', windowTz: 'America/New_York' },
  );
  const md = toMarkdown(report);

  it('contains every section a reader needs', () => {
    for (const heading of [
      '# Cronoscope audit',
      '## Summary',
      '## nightly-backup',
      '## Cross-job collisions',
      '## How to read this',
      '## Provenance',
    ]) {
      expect(md).toContain(heading);
    }
  });

  it('shows the finding codes and the licence attribution', () => {
    expect(md).toContain('dst.gap.shifted');
    expect(md).toContain('cron-parser 5.10.2 (MIT, © 2014-2023 Harri Siirak)');
    expect(md).toContain('cRonstrue 3.38.0 (MIT, © 2017 Brady Holt)');
    expect(md).toContain('luxon 3.7.2 (MIT, © 2019 JS Foundation and other contributors)');
  });

  it('never leaves a table cell unescaped', () => {
    const report2 = audit([{ name: 'a|b', expression: '0 0 * * *', tz: 'UTC' }], { from: '2026-01-01', to: '2026-01-02' });
    expect(toMarkdown(report2)).toContain('a\\|b');
  });
});

describe('csv export', () => {
  it('writes a header and one row per occurrence', () => {
    const report = audit([{ name: 'hourly', expression: '0 * * * *', tz: 'UTC' }], {
      from: '2026-01-01',
      to: '2026-01-01T03:00:00Z',
    });
    const csv = toCsv(report.jobs);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('"job","zone","instant_utc","local_wall_clock","offset"');
    expect(lines).toHaveLength(5); // header + 4 occurrences
    expect(lines[1]).toContain('"hourly","UTC","2026-01-01T00:00:00.000Z"');
  });

  it('escapes quotes inside values', () => {
    const csv = toCsv([{ name: 'he said "hi"', tz: 'UTC', timeline: [{ iso: 'x', local: 'y', offset: 'z' }] }]);
    expect(csv).toContain('"he said ""hi"""');
  });
});

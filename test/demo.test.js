import { describe, it, expect } from 'vitest';
import { buildViewModel, runAudit, renderJobList, renderReport, PRESET_JOBS, ZONES } from '../demo/app.js';

// The demo imports the same modules the CLI does and guards its DOM code behind
// `typeof document`, so its pure render functions can be exercised here.

const presets = PRESET_JOBS.map((job) => ({ ...job }));

describe('demo view model', () => {
  const { report, view } = runAudit(presets, {
    from: '2026-03-01',
    to: '2026-03-31',
    windowTz: 'America/New_York',
  });

  it('audits the preset set through the same entry point', () => {
    expect(report.jobs).toHaveLength(PRESET_JOBS.length);
    expect(report.summary.jobs).toBe(PRESET_JOBS.length);
  });

  it('selects the job the user clicked', () => {
    const third = buildViewModel(report, 2);
    expect(third.job.name).toBe('quarter-hour-metrics');
    expect(third.badges).toContain('America/New_York');
  });

  it('derives the verdict from the finding severities', () => {
    expect(view.verdict).toBe('review'); // nightly-backup has a DST warning
    const broken = buildViewModel(report, 4); // the 4-field typo
    expect(broken.verdict).toBe('needs fixing');
    expect(broken.counts.error).toBeGreaterThan(0);
  });

  it('renders both conversions for every job', () => {
    expect(view.systemd).toContain('02:30:00');
    expect(view.rrule).toContain('FREQ=DAILY');
  });

  it('reports collisions for the set', () => {
    expect(view.collisions).toBeTruthy();
    expect(Array.isArray(view.collisions.sameInstant)).toBe(true);
  });
});

describe('demo rendering', () => {
  const { report, view } = runAudit(presets.slice(0, 2), {
    from: '2026-03-01',
    to: '2026-03-31',
    windowTz: 'America/New_York',
  });

  it('lists every job with its inputs and zone options', () => {
    const html = renderJobList(presets, 0);
    expect(html.match(/data-index="/g).length).toBeGreaterThanOrEqual(PRESET_JOBS.length);
    for (const zone of ['America/New_York', 'Australia/Lord_Howe', 'Pacific/Chatham']) {
      expect(ZONES).toContain(zone);
    }
    expect(html).toContain('nightly-backup');
    expect(html).toContain('30 2 * * *');
  });

  it('renders the finding, its evidence and the tables', () => {
    const html = renderReport(view);
    expect(html).toContain('dst.gap.shifted');
    expect(html).toContain('2026-03-08 03:30:00 -04:00');
    expect(html).toContain('OnCalendar=');
    expect(html).toContain('Cross-job collisions');
    expect(html).toContain('Offset changes');
  });

  it('escapes anything that came from the user', () => {
    const html = renderJobList([{ name: '<script>x</script>', expression: '0 0 * * *', tz: 'UTC' }], 0);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

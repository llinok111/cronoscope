import { describe, it, expect } from 'vitest';
import { auditJob, summarise, enumerateDays } from '../src/audit.js';

const w = (from, to) => ({ fromMs: Date.parse(from), toMs: Date.parse(to) });
const codes = (report) => report.findings.map((f) => f.code);
const finding = (report, code) => report.findings.find((f) => f.code === code);

describe('DST behaviour, measured against the engine', () => {
  it('US spring-forward: a 02:30 job is shifted to 03:30, not skipped', () => {
    const report = auditJob(
      { expression: '30 2 * * *', tz: 'America/New_York' },
      w('2026-03-01T00:00:00Z', '2026-03-31T23:59:59Z'),
    );
    expect(report.stats.slots.shifted).toBe(1);
    expect(report.stats.slots.skipped).toBe(0);
    expect(report.stats.slots.missing).toBe(0);
    const f = finding(report, 'dst.gap.shifted');
    expect(f).toBeTruthy();
    expect(f.evidence.day).toBe('2026-03-08');
    expect(f.evidence.samples[0].deltaMinutes).toBe(60);
    expect(f.evidence.samples[0].firedAt).toBe('2026-03-08 03:30:00 -04:00');
  });

  it('US spring-forward: a 30-minute grid skips the missing half hour instead', () => {
    const report = auditJob(
      { expression: '*/30 * * * *', tz: 'America/New_York' },
      w('2026-03-07T00:00:00Z', '2026-03-10T00:00:00Z'),
    );
    expect(report.stats.slots.skipped).toBe(2);
    expect(report.stats.slots.shifted).toBe(0);
    expect(report.stats.slots.missing).toBe(0);
    // A uniform grid keeps its cadence across the gap: 01:30 EST is followed by
    // 03:00 EDT, exactly 30 minutes later. There is a missing *reading*, not a
    // missing interval — so no cadence finding is right here.
    expect(codes(report)).not.toContain('cadence.gap');
    expect(report.stats.typicalDeltaSeconds).toBe(1800);
  });

  it('a 30-minute DST shift drops the missing reading entirely (Lord Howe)', () => {
    const report = auditJob(
      { expression: '15 2 * * *', tz: 'Australia/Lord_Howe' },
      w('2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z'),
    );
    expect(report.stats.slots.skipped).toBe(1);
    expect(report.stats.slots.shifted).toBe(0);
    // 02:15 on Oct 4 does not exist; the engine jumps from Oct 3 to Oct 5.
    expect(report.timeline.map((o) => o.local.slice(0, 16))).toEqual([
      '2026-10-02 02:15',
      '2026-10-03 02:15',
      '2026-10-05 02:15',
      '2026-10-06 02:15',
      '2026-10-07 02:15',
      '2026-10-08 02:15',
    ]);
  });

  it('US fall-back: an ambiguous reading fires once, and the second pass is reported', () => {
    const report = auditJob(
      { expression: '30 1 * * *', tz: 'America/New_York' },
      w('2026-10-30T00:00:00Z', '2026-11-03T00:00:00Z'),
    );
    expect(report.stats.slots.ambiguousOnce).toBe(1);
    expect(report.stats.slots.ambiguousBoth).toBe(0);
    const f = finding(report, 'dst.ambiguous.single');
    expect(f.evidence.day).toBe('2026-11-01');
    expect(f.evidence.samples[0].firedOffset).toBe('-04:00');
    expect(f.evidence.samples[0].skippedInstant).toBe('2026-11-01T06:30:00.000Z');
  });

  it('a zone without DST produces no slot divergence at all', () => {
    const report = auditJob(
      { expression: '30 2 * * *', tz: 'Asia/Shanghai' },
      w('2026-03-01T00:00:00Z', '2026-03-31T23:59:59Z'),
    );
    expect(report.findings).toEqual([]);
    expect(report.stats.slots.skipped).toBe(0);
    expect(report.stats.slots.shifted).toBe(0);
  });

  it('reports a clean transition when the schedule never targets it', () => {
    const report = auditJob(
      { expression: '0 12 * * *', tz: 'America/New_York' },
      w('2026-03-07T00:00:00Z', '2026-03-10T00:00:00Z'),
    );
    expect(report.transitions).toHaveLength(1);
    expect(codes(report)).toContain('dst.clean');
  });
});

describe('expression-level divergences', () => {
  it('flags a 4-field expression and says what the engine will run instead', () => {
    const report = auditJob(
      { expression: '0 3 * *', tz: 'UTC' },
      w('2026-01-01T00:00:00Z', '2026-01-31T23:59:59Z'),
    );
    const f = finding(report, 'arity.short');
    expect(f.severity).toBe('error');
    expect(f.evidence.executedAs).toBe('* 0 3 * *');
    expect(codes(report)).toContain('engines.disagree');
  });

  it('flags an impossible date: the engine refuses what the describer happily describes', () => {
    const report = auditJob(
      { expression: '0 0 31 2 *', tz: 'UTC' },
      w('2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z'),
    );
    expect(report.engine.ok).toBe(false);
    expect(report.description.en.ok).toBe(true);
    expect(codes(report)).toContain('engines.disagree');
  });

  it('flags a schedule that parses but never fires, and names the next real occurrence', () => {
    const report = auditJob(
      { expression: '0 0 29 2 *', tz: 'UTC' },
      w('2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z'),
    );
    expect(report.stats.occurrences).toBe(0);
    const f = finding(report, 'schedule.dead');
    expect(f.severity).toBe('error');
    expect(f.evidence.nextAfterWindow).toBe('2028-02-29T00:00:00.000Z');
  });

  it('notes the H macro and skips slot checks', () => {
    const report = auditJob(
      { expression: 'H * * * *', tz: 'UTC' },
      w('2026-01-01T00:00:00Z', '2026-01-02T23:59:59Z'),
    );
    expect(codes(report)).toContain('expression.nondeterministic');
    expect(report.model.enumerable).toBe(false);
    expect(report.stats.slots.total).toBe(0);
    expect(report.stats.occurrences).toBeGreaterThan(0);
  });
});

describe('cadence and SLA', () => {
  it('reports an SLA breach with the actual gap', () => {
    const report = auditJob(
      { expression: '0 0 * * *', tz: 'UTC', slaMaxGapSeconds: 3600 },
      w('2026-01-01T00:00:00Z', '2026-01-04T00:00:00Z'),
    );
    const f = finding(report, 'cadence.sla_breach');
    expect(f.severity).toBe('error');
    expect(f.evidence.slaMaxGapSeconds).toBe(3600);
    expect(f.evidence.breaches[0].gapSeconds).toBe(86400);
  });

  it('stays quiet when the SLA is met', () => {
    const report = auditJob(
      { expression: '0 0 * * *', tz: 'UTC', slaMaxGapSeconds: 90000 },
      w('2026-01-01T00:00:00Z', '2026-01-04T00:00:00Z'),
    );
    expect(codes(report)).not.toContain('cadence.sla_breach');
  });

  it('measures the typical interval from the timeline, not from the text', () => {
    const report = auditJob(
      { expression: '*/15 * * * *', tz: 'UTC' },
      w('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
    );
    expect(report.stats.typicalDeltaSeconds).toBe(900);
  });
});

describe('coverage budgeting', () => {
  it('samples a dense schedule instead of expanding a year of minutes', () => {
    const report = auditJob(
      { expression: '* * * * *', tz: 'America/New_York' },
      { ...w('2026-03-01T00:00:00Z', '2026-03-31T23:59:59Z'), maxOccurrences: 3000 },
    );
    expect(report.coverage.mode).toBe('sampled');
    expect(report.coverage.reason).toMatch(/budget/);
    expect(report.coverage.estimate.total).toBeGreaterThan(3000);
    expect(report.stats.occurrences).toBeGreaterThan(0);
    expect(report.stats.occurrences).toBeLessThan(report.coverage.estimate.total);
    expect(report.coverage.windows.length).toBeGreaterThan(1);
    // The DST gap still shows up, because that is where sampling looks.
    expect(report.stats.slots.skipped).toBe(60);
  });

  it('honours an explicit sampling request', () => {
    const report = auditJob(
      { expression: '0 * * * *', tz: 'UTC' },
      { ...w('2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z'), mode: 'sample' },
    );
    expect(report.coverage.mode).toBe('sampled');
    expect(report.coverage.reason).toMatch(/requested/);
  });

  it('keeps full coverage for a modest schedule', () => {
    const report = auditJob(
      { expression: '0 */2 * * *', tz: 'UTC' },
      w('2026-01-01T00:00:00Z', '2026-01-31T23:59:59Z'),
    );
    expect(report.coverage.mode).toBe('full');
    expect(report.coverage.windows).toHaveLength(1);
  });
});

describe('report shape', () => {
  it('carries description, model, stats and a sorted finding list', () => {
    const report = auditJob(
      { name: 'nightly', expression: '30 2 * * *', tz: 'America/New_York' },
      w('2026-03-01T00:00:00Z', '2026-03-31T23:59:59Z'),
    );
    expect(report.name).toBe('nightly');
    expect(report.description.en.text).toBe('At 02:30');
    expect(report.model.arity).toBe(5);
    expect(report.stats.occurrences).toBe(31);
    const order = { error: 0, warn: 1, info: 2 };
    const severities = report.findings.map((f) => order[f.severity]);
    expect(severities).toEqual([...severities].sort((a, b) => a - b));
  });

  it('summarises severities across jobs', () => {
    const a = auditJob({ expression: '0 3 * *', tz: 'UTC' }, w('2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z'));
    const b = auditJob({ expression: '30 2 * * *', tz: 'Asia/Shanghai' }, w('2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z'));
    const summary = summarise([a, b]);
    expect(summary.jobs).toBe(2);
    expect(summary.errors).toBeGreaterThan(0);
    expect(summary.highest).toBe('error');
  });

  it('enumerates days in the job zone, clipped to the window', () => {
    const days = enumerateDays('America/New_York', Date.parse('2026-03-01T05:00:00Z'), Date.parse('2026-03-04T04:59:59Z'));
    expect(days).toHaveLength(3);
    expect(days[0].key).toBe('2026-03-01');
    expect(days[0].startMs).toBe(Date.parse('2026-03-01T05:00:00Z'));
    expect(days.at(-1).endMs).toBe(Date.parse('2026-03-04T04:59:59Z'));
  });
});

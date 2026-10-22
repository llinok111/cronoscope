import { describe, it, expect } from 'vitest';
import { audit, explain, resolveWindow, VERSION, UPSTREAMS, SCHEMA_VERSION } from '../src/index.js';

describe('window resolution', () => {
  it('reads a date-only bound as a whole day in the requested zone', () => {
    const w = resolveWindow({ from: '2026-03-01', to: '2026-03-31', windowTz: 'America/New_York' });
    expect(new Date(w.fromMs).toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(new Date(w.toMs).toISOString()).toBe('2026-04-01T03:59:59.999Z');
  });

  it('reads a timestamp bound as an instant', () => {
    const w = resolveWindow({ from: '2026-03-01T00:00:00Z', to: '2026-03-02T00:00:00Z', windowTz: 'Asia/Shanghai' });
    expect(new Date(w.fromMs).toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(w.windowTz).toBe('Asia/Shanghai');
  });

  it('rejects a backwards or unparseable window', () => {
    expect(() => resolveWindow({ from: '2026-03-05', to: '2026-03-01' })).toThrow(/after/);
    expect(() => resolveWindow({ from: 'yesterday', to: 'today' })).toThrow(/cannot parse/);
  });
});

describe('audit()', () => {
  it('validates its input', () => {
    expect(() => audit([], { from: '2026-01-01', to: '2026-01-02' })).toThrow(/at least one job/);
    expect(() => audit([{}], { from: '2026-01-01', to: '2026-01-02' })).toThrow(/no expression/);
    expect(() => audit([{ expression: '0 0 * * *', tz: 'Mars/Olympus' }], { from: '2026-01-01', to: '2026-01-02' }))
      .toThrow(/unknown zone/);
  });

  it('defaults the job zone to the window zone', () => {
    const report = audit([{ expression: '0 0 * * *' }], { from: '2026-01-01', to: '2026-01-02', windowTz: 'Europe/Berlin' });
    expect(report.jobs[0].tz).toBe('Europe/Berlin');
    expect(report.meta.window.windowTz).toBe('Europe/Berlin');
  });

  it('produces a versioned, self-describing report', () => {
    const report = audit([{ expression: '0 0 * * *', tz: 'UTC' }], { from: '2026-01-01', to: '2026-01-03' });
    expect(report.meta.schemaVersion).toBe(SCHEMA_VERSION);
    expect(report.meta.tool.version).toBe(VERSION);
    expect(report.meta.tool.upstreams).toEqual(UPSTREAMS);
    expect(report.meta.window.days).toBe(3);
    expect(report.summary.jobs).toBe(1);
  });

  it('does not ship the raw occurrence list in the report', () => {
    const report = audit([{ expression: '0 0 * * *', tz: 'UTC' }], { from: '2026-01-01', to: '2026-01-03' });
    expect(report.jobs[0].occurrences).toBeUndefined();
    expect(report.jobs[0].timeline.length).toBeLessThanOrEqual(24);
    expect(report.jobs[0].stats.occurrences).toBe(3); // Jan 1, 2, 3
  });

  it('computes collisions across the set', () => {
    const report = audit(
      [
        { name: 'a', expression: '0 * * * *', tz: 'UTC', durationSeconds: 900 },
        { name: 'b', expression: '0 * * * *', tz: 'UTC', durationSeconds: 900 },
      ],
      { from: '2026-01-01T00:00:00Z', to: '2026-01-01T02:00:00Z' },
    );
    expect(report.conflicts.sameInstantTotal).toBe(3);
    expect(report.conflicts.windows).toHaveLength(3);
    expect(report.conflicts.windows[0].peakConcurrency).toBe(2);
  });

  it('skips collision maths for a single job', () => {
    const report = audit([{ expression: '0 * * * *', tz: 'UTC' }], { from: '2026-01-01', to: '2026-01-02' });
    expect(report.conflicts.sameInstantTotal).toBe(0);
    expect(report.conflicts.perJob).toEqual([]);
  });
});

describe('explain()', () => {
  it('describes an expression without needing a window', () => {
    const detail = explain('*/15 * * * *', { tz: 'UTC', count: 3, fromMs: Date.parse('2026-01-01T00:00:00Z') });
    expect(detail.description.en.text).toBe('Every 15 minutes');
    expect(detail.description.zh_CN.text).toBe('每隔 15 分钟');
    expect(detail.next).toHaveLength(3);
    expect(detail.next[0].iso).toBe('2026-01-01T00:15:00.000Z');
    expect(detail.model.arity).toBe(5);
  });

  it('rejects an unknown zone', () => {
    expect(() => explain('0 0 * * *', { tz: 'Nowhere/City' })).toThrow(/unknown zone/);
  });

  it('explains a short expression and exposes the padding', () => {
    const detail = explain('0 3 * *', { tz: 'UTC' });
    expect(detail.model.arity).toBe(4);
    expect(detail.model.arityShift).toBe(1);
    expect(detail.model.normalized).toBe('* 0 3 * *');
    expect(detail.description.en.ok).toBe(false);
  });
});

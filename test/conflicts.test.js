import { describe, it, expect } from 'vitest';
import { analyzeConflicts } from '../src/conflicts.js';

const window = { fromMs: Date.parse('2026-01-01T00:00:00Z'), toMs: Date.parse('2026-01-02T23:59:59Z') };

describe('same-instant collisions', () => {
  it('finds two jobs firing at the same minute', () => {
    const result = analyzeConflicts(
      [
        { name: 'backup', expression: '0 * * * *', tz: 'UTC', durationSeconds: 600 },
        { name: 'cache', expression: '0 * * * *', tz: 'UTC', durationSeconds: 900 },
        { name: 'lonely', expression: '30 * * * *', tz: 'UTC' },
      ],
      window,
    );
    expect(result.sameInstantTotal).toBe(48); // 24 hours × 2 days
    expect(result.sameInstant[0].jobs).toEqual(['backup', 'cache']);
    expect(result.sameInstant.every((c) => !c.jobs.includes('lonely'))).toBe(true);
  });

  it('counts collisions across zones on the same absolute instant', () => {
    const result = analyzeConflicts(
      [
        { name: 'shanghai-9', expression: '0 9 * * *', tz: 'Asia/Shanghai' },
        { name: 'utc-1', expression: '0 1 * * *', tz: 'UTC' },
      ],
      window,
    );
    expect(result.sameInstantTotal).toBe(2);
    expect(result.sameInstant[0].at).toBe('2026-01-01T01:00:00.000Z');
  });

  it('reports nothing when the jobs never meet', () => {
    const result = analyzeConflicts(
      [
        { name: 'a', expression: '0 1 * * *', tz: 'UTC' },
        { name: 'b', expression: '0 2 * * *', tz: 'UTC' },
      ],
      window,
    );
    expect(result.sameInstantTotal).toBe(0);
    expect(result.windows).toEqual([]);
  });
});

describe('overlap windows', () => {
  it('merges concurrency into windows with a peak', () => {
    const result = analyzeConflicts(
      [
        { name: 'a', expression: '0 * * * *', tz: 'UTC', durationSeconds: 600 },
        { name: 'b', expression: '0 * * * *', tz: 'UTC', durationSeconds: 1800 },
        { name: 'c', expression: '0 * * * *', tz: 'UTC', durationSeconds: 60 },
      ],
      window,
    );
    expect(result.windows).toHaveLength(48);
    expect(result.windows[0].peakConcurrency).toBe(3);
    expect(result.windows[0].jobs).toEqual(['a', 'b', 'c']);
    // The window closes when concurrency drops below the threshold — after
    // `a` (10 min) and `c` (1 min) have finished, only `b` is still running.
    expect(result.windows[0].to).toBe('2026-01-01T00:10:00.000Z');
  });

  it('does not treat back-to-back jobs as overlapping', () => {
    const result = analyzeConflicts(
      [
        { name: 'first', expression: '0 * * * *', tz: 'UTC', durationSeconds: 1800 },
        { name: 'second', expression: '30 * * * *', tz: 'UTC', durationSeconds: 1800 },
      ],
      { fromMs: Date.parse('2026-01-01T00:00:00Z'), toMs: Date.parse('2026-01-01T02:00:00Z') },
    );
    expect(result.windows).toEqual([]);
  });

  it('ignores jobs without a declared duration for overlap maths', () => {
    const result = analyzeConflicts(
      [
        { name: 'a', expression: '0 * * * *', tz: 'UTC', durationSeconds: 600 },
        { name: 'b', expression: '0 * * * *', tz: 'UTC', durationSeconds: 600 },
        { name: 'c', expression: '0 * * * *', tz: 'UTC' },
      ],
      window,
    );
    expect(result.windows.every((w) => !w.jobs.includes('c'))).toBe(true);
    // ...but c still shows up in exact-instant collisions.
    expect(result.sameInstant[0].jobs).toEqual(['a', 'b', 'c']);
    expect(result.perJob.find((j) => j.name === 'c').durationSeconds).toBe(0);
  });

  it('respects a higher concurrency threshold', () => {
    const result = analyzeConflicts(
      [
        { name: 'a', expression: '0 * * * *', tz: 'UTC', durationSeconds: 600 },
        { name: 'b', expression: '0 * * * *', tz: 'UTC', durationSeconds: 600 },
      ],
      { ...window, threshold: 3 },
    );
    expect(result.windows).toEqual([]);
    expect(result.sameInstantTotal).toBe(0);
  });

  it('closes an overlap window at the window end when the jobs are still running', () => {
    const result = analyzeConflicts(
      [
        { name: 'a', expression: '0 0 * * *', tz: 'UTC', durationSeconds: 7200 },
        { name: 'b', expression: '0 0 * * *', tz: 'UTC', durationSeconds: 7200 },
      ],
      { fromMs: Date.parse('2026-01-01T00:00:00Z'), toMs: Date.parse('2026-01-01T00:30:00Z') },
    );
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].toMs).toBe(Date.parse('2026-01-01T00:30:00Z'));
    expect(result.windows[0].peakConcurrency).toBe(2);
  });
});

import { describe, it, expect } from 'vitest';
import { expandOccurrences, nextOccurrence } from '../src/expand.js';

const from = Date.parse('2026-01-01T00:00:00Z');
const to = Date.parse('2026-01-01T00:10:00Z');

describe('expandOccurrences', () => {
  it('includes an occurrence exactly on the window start', () => {
    const result = expandOccurrences({
      expression: '0 0 * * *',
      tz: 'UTC',
      fromMs: from,
      toMs: from + 3600_000,
    });
    expect(result.occurrences.map((o) => o.iso)).toEqual(['2026-01-01T00:00:00.000Z']);
  });

  it('includes an occurrence exactly on the window end', () => {
    const result = expandOccurrences({
      expression: '*/5 * * * *',
      tz: 'UTC',
      fromMs: from,
      toMs: from + 300_000,
    });
    expect(result.occurrences).toHaveLength(2);
    expect(result.occurrences.at(-1).iso).toBe('2026-01-01T00:05:00.000Z');
  });

  it('expands in the requested zone', () => {
    const result = expandOccurrences({
      expression: '0 9 * * *',
      tz: 'Asia/Shanghai',
      fromMs: from,
      toMs: from + 86_400_000,
    });
    expect(result.occurrences.map((o) => o.iso)).toEqual(['2026-01-01T01:00:00.000Z']);
    expect(result.occurrences[0].local).toBe('2026-01-01 09:00:00 +08:00');
    expect(result.occurrences[0].offset).toBe('+08:00');
  });

  it('stops at the limit and says so', () => {
    const result = expandOccurrences({ expression: '* * * * *', tz: 'UTC', fromMs: from, toMs: to, limit: 3 });
    expect(result.occurrences).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('does not claim truncation when the window simply ends', () => {
    const result = expandOccurrences({ expression: '*/5 * * * *', tz: 'UTC', fromMs: from, toMs: to, limit: 3 });
    expect(result.occurrences).toHaveLength(3);
    expect(result.truncated).toBe(false);
  });

  it('reports a parse failure instead of throwing', () => {
    const result = expandOccurrences({ expression: '99 99 * * *', tz: 'UTC', fromMs: from, toMs: to });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/constraint/i);
    expect(result.occurrences).toEqual([]);
  });

  it('reports an inverted window', () => {
    const result = expandOccurrences({ expression: '0 0 * * *', tz: 'UTC', fromMs: to, toMs: from });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/empty window/);
  });

  it('returns nothing for a schedule with no valid date (31 February)', () => {
    const result = expandOccurrences({
      expression: '0 0 29 2 *',
      tz: 'UTC',
      fromMs: from,
      toMs: Date.parse('2026-12-31T00:00:00Z'),
    });
    expect(result.occurrences).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('nextOccurrence', () => {
  it('returns the first instant at or after the bound (inclusive)', () => {
    const ms = nextOccurrence({ expression: '0 0 1 1 *', tz: 'UTC', fromMs: from });
    expect(new Date(ms).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    const later = nextOccurrence({ expression: '0 0 1 1 *', tz: 'UTC', fromMs: from + 1 });
    expect(new Date(later).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('returns null when the expression cannot be parsed', () => {
    expect(nextOccurrence({ expression: 'nope', tz: 'UTC', fromMs: from })).toBeNull();
  });

  it('returns null when there is nothing inside the limit', () => {
    expect(nextOccurrence({
      expression: '0 0 29 2 *',
      tz: 'UTC',
      fromMs: from,
      limitMs: Date.parse('2027-01-01T00:00:00Z'),
    })).toBeNull();
  });
});

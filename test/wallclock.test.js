import { describe, it, expect } from 'vitest';
import {
  resolveWallClock,
  findTransitions,
  formatLocal,
  localKey,
  offsetLabel,
  isValidZone,
  iso,
} from '../src/wallclock.js';

const wall = (y, mo, d, h, mi, s = 0) => ({ year: y, month: mo, day: d, hour: h, minute: mi, second: s });

describe('zone validation', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(isValidZone('America/New_York')).toBe(true);
    expect(isValidZone('Europe/London')).toBe(true);
    expect(isValidZone('UTC')).toBe(true);
    expect(isValidZone('Mars/Olympus')).toBe(false);
    expect(isValidZone('')).toBe(false);
    expect(isValidZone(undefined)).toBe(false);
  });
});

describe('resolveWallClock', () => {
  it('resolves an ordinary reading to exactly one instant', () => {
    const r = resolveWallClock('Asia/Shanghai', wall(2026, 5, 1, 12, 0));
    expect(r.kind).toBe('unique');
    expect(r.instants).toHaveLength(1);
    expect(iso(r.instants[0])).toBe('2026-05-01T04:00:00.000Z');
    expect(r.offsets).toEqual([480]);
  });

  it('reports the US spring-forward gap as nonexistent and exposes both would-be instants', () => {
    const r = resolveWallClock('America/New_York', wall(2026, 3, 8, 2, 30));
    expect(r.kind).toBe('nonexistent');
    expect(r.instants).toEqual([]);
    expect(r.candidates).toHaveLength(2);
    const byOffset = Object.fromEntries(r.candidates.map((c) => [c.offset, iso(c.ms)]));
    // The two offsets in force either side of the transition: -05:00 and -04:00.
    expect(byOffset[-300]).toBe('2026-03-08T07:30:00.000Z');
    expect(byOffset[-240]).toBe('2026-03-08T06:30:00.000Z');
    expect(r.candidates.every((c) => c.selfConsistent === false)).toBe(true);
  });

  it('reports the US fall-back hour as ambiguous with one instant per offset', () => {
    const r = resolveWallClock('America/New_York', wall(2026, 11, 1, 1, 30));
    expect(r.kind).toBe('ambiguous');
    expect(r.instants.map(iso)).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
    expect(r.offsets).toEqual([-240, -300]);
  });

  it('handles a 30-minute transition zone (Lord Howe)', () => {
    const gap = resolveWallClock('Australia/Lord_Howe', wall(2026, 10, 4, 2, 15));
    expect(gap.kind).toBe('nonexistent');
    const before = resolveWallClock('Australia/Lord_Howe', wall(2026, 10, 3, 2, 15));
    expect(before.kind).toBe('unique');
    expect(before.offsets).toEqual([630]);
    const after = resolveWallClock('Australia/Lord_Howe', wall(2026, 10, 5, 2, 15));
    expect(after.offsets).toEqual([660]);
  });

  it('never reports ambiguity in a zone without DST', () => {
    for (const minute of [0, 30, 59]) {
      expect(resolveWallClock('Asia/Shanghai', wall(2026, 11, 1, 1, minute)).kind).toBe('unique');
      expect(resolveWallClock('UTC', wall(2026, 3, 8, 2, minute)).kind).toBe('unique');
    }
  });

  it('resolves a reading at the very edge of the gap', () => {
    // 02:00 does not exist on 2026-03-08 in New York; 01:59 and 03:00 do.
    expect(resolveWallClock('America/New_York', wall(2026, 3, 8, 2, 0)).kind).toBe('nonexistent');
    expect(resolveWallClock('America/New_York', wall(2026, 3, 8, 1, 59)).kind).toBe('unique');
    expect(resolveWallClock('America/New_York', wall(2026, 3, 8, 3, 0)).kind).toBe('unique');
  });
});

describe('findTransitions', () => {
  const y2026 = [Date.parse('2026-01-01T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z')];

  it('finds both US transitions at the exact instant', () => {
    const list = findTransitions('America/New_York', ...y2026);
    expect(list).toHaveLength(2);
    expect(list.map((t) => iso(t.at))).toEqual([
      '2026-03-08T07:00:00.000Z',
      '2026-11-01T06:00:00.000Z',
    ]);
    expect(list.map((t) => t.deltaMinutes)).toEqual([60, -60]);
    expect(list.map((t) => t.direction)).toEqual(['forward', 'back']);
  });

  it('finds none in a fixed-offset zone', () => {
    expect(findTransitions('Asia/Shanghai', ...y2026)).toEqual([]);
    expect(findTransitions('UTC', ...y2026)).toEqual([]);
  });

  it('reports 30-minute transitions where they exist', () => {
    const list = findTransitions('Australia/Lord_Howe', ...y2026);
    // April ends DST (-30), October starts it (+30).
    expect(list.map((t) => t.deltaMinutes)).toEqual([-30, 30]);
  });

  it('returns an empty list for an inverted or empty window', () => {
    expect(findTransitions('America/New_York', y2026[1], y2026[0])).toEqual([]);
    expect(findTransitions('America/New_York', y2026[0], y2026[0])).toEqual([]);
  });
});

describe('formatting helpers', () => {
  it('formats local wall clock with an offset label', () => {
    const ms = Date.parse('2026-03-08T07:30:00Z');
    expect(formatLocal(ms, 'America/New_York')).toBe('2026-03-08 03:30:00 -04:00');
    expect(localKey(ms, 'America/New_York')).toBe('2026-03-08 03:30:00');
    expect(offsetLabel(ms, 'America/New_York')).toBe('-04:00');
  });
});

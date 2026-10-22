/**
 * Wall-clock arithmetic in a named IANA zone.
 *
 * A cron expression describes *wall clock* time ("02:30 every day"). Between a
 * wall clock reading and a real instant there is not always a one-to-one
 * mapping:
 *
 *   unique       one instant                (the boring, common case)
 *   ambiguous    two instants               (clocks went back; 01:30 happens twice)
 *   nonexistent  zero instants              (clocks went forward; 02:30 never happens)
 *
 * Everything the audit reports about DST comes from this module: given a zone
 * and a calendar reading, say which of the three cases applies and enumerate
 * the instants. Luxon supplies the tz database; the resolution algorithm here
 * is deliberately explicit so that a wrong answer is a failed test rather than
 * a mysterious off-by-one-hour.
 */
import { DateTime } from 'luxon';

/**
 * Offset probe points around the target reading, in hours.
 * Three points are enough: the largest offset change in the tz database is two
 * hours, so a reading's two candidate offsets are always visible within ±3h.
 */
const PROBE_HOURS = [-3, 0, 3];

/**
 * @param {string} zone IANA zone name
 * @returns {boolean} true when the zone is usable in this runtime
 */
export function isValidZone(zone) {
  if (typeof zone !== 'string' || zone.length === 0) return false;
  return DateTime.local().setZone(zone).isValid;
}

/**
 * Candidate offsets for a wall-clock reading.
 *
 * A reading maps to the instant `naive - offset*60000`, so the offsets that
 * matter are the ones in force around that instant — not around `naive`
 * itself. Starting from the offset at `naive` and probing ±3h around the
 * resulting instant converges in one round for every zone in the tz database
 * (the largest offset change on record is two hours), and two rounds catch the
 * readings that sit exactly on a transition.
 */
function candidateOffsets(zone, naive) {
  const offsets = new Set();
  const seed = DateTime.fromMillis(naive, { zone }).offset;
  for (const d of [-3, 0, 3]) {
    offsets.add(DateTime.fromMillis(naive - seed * 60_000 + d * 3600_000, { zone }).offset);
  }
  for (const offset of [...offsets]) {
    for (const d of [-3, 3]) {
      offsets.add(DateTime.fromMillis(naive - offset * 60_000 + d * 3600_000, { zone }).offset);
    }
  }
  return [...offsets].sort((a, b) => a - b);
}

/**
 * Resolve a wall-clock reading to the instant(s) it denotes.
 * @param {string} zone
 * @param {{year:number,month:number,day:number,hour?:number,minute?:number,second?:number}} parts
 * @returns {{kind:'unique'|'ambiguous'|'nonexistent', instants:number[], offsets:number[], candidates:Array<{offset:number,ms:number,selfConsistent:boolean}>}}
 */
export function resolveWallClock(zone, parts) {
  const { year, month, day, hour = 0, minute = 0, second = 0 } = parts;
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);

  const instants = [];
  const candidates = [];
  for (const offset of candidateOffsets(zone, naive)) {
    const ms = naive - offset * 60_000;
    const back = DateTime.fromMillis(ms, { zone });
    const selfConsistent =
      back.isValid &&
      back.year === year &&
      back.month === month &&
      back.day === day &&
      back.hour === hour &&
      back.minute === minute &&
      back.second === second;
    candidates.push({ offset, ms, selfConsistent });
    if (selfConsistent) instants.push(ms);
  }

  const unique = [...new Set(instants)].sort((a, b) => a - b);
  return {
    kind: unique.length === 0 ? 'nonexistent' : unique.length === 1 ? 'unique' : 'ambiguous',
    instants: unique,
    offsets: unique.map((ms) => DateTime.fromMillis(ms, { zone }).offset),
    candidates,
  };
}

/** Format an instant as local wall clock in a zone, e.g. `2026-03-08 03:30 -04:00`. */
export function formatLocal(ms, zone) {
  const dt = DateTime.fromMillis(ms, { zone });
  if (!dt.isValid) return `invalid(${ms})`;
  return dt.toFormat("yyyy-MM-dd HH:mm:ss ZZ");
}

/** Format an instant as local wall clock without the offset, e.g. `2026-03-08 03:30:00`. */
export function localKey(ms, zone) {
  const dt = DateTime.fromMillis(ms, { zone });
  return dt.toFormat('yyyy-MM-dd HH:mm:ss');
}

/** Short offset label for an instant, e.g. `-04:00`. */
export function offsetLabel(ms, zone) {
  return DateTime.fromMillis(ms, { zone }).toFormat('ZZ');
}

/** ISO-8601 UTC string with milliseconds. */
export function iso(ms) {
  return new Date(ms).toISOString();
}

/**
 * Offset transitions (DST onsets/ends and permanent shifts) between two instants.
 *
 * Day-granular scan first (365 lookups per year — cheap), then a binary search
 * down to the second inside each day that changed. The audit uses the returned
 * instant as evidence; it never guesses "DST is around 2am".
 *
 * @param {string} zone
 * @param {number} fromMs inclusive
 * @param {number} toMs inclusive
 * @returns {Array<{at:number,before:number,after:number,deltaMinutes:number,direction:'forward'|'back'}>}
 */
export function findTransitions(zone, fromMs, toMs) {
  const out = [];
  if (!(toMs > fromMs)) return out;
  const startOfDay = (ms) => {
    const dt = DateTime.fromMillis(ms, { zone });
    return DateTime.fromObject({ year: dt.year, month: dt.month, day: dt.day }, { zone }).toMillis();
  };

  let cursor = startOfDay(fromMs);
  let prevOffset = DateTime.fromMillis(Math.min(cursor, toMs), { zone }).offset;
  while (cursor <= toMs) {
    const nextDay = DateTime.fromMillis(cursor, { zone }).plus({ days: 1 }).toMillis();
    const probeMs = Math.min(nextDay - 1, toMs);
    const offset = DateTime.fromMillis(probeMs, { zone }).offset;
    if (offset !== prevOffset) {
      // Binary search the exact instant of the change inside [cursor, probeMs].
      let lo = cursor;
      let hi = probeMs;
      const atLo = DateTime.fromMillis(lo, { zone }).offset;
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        const midOffset = DateTime.fromMillis(mid, { zone }).offset;
        if (midOffset === atLo) lo = mid;
        else hi = mid;
      }
      const before = DateTime.fromMillis(lo, { zone }).offset;
      const after = DateTime.fromMillis(hi, { zone }).offset;
      out.push({
        at: hi,
        before,
        after,
        deltaMinutes: after - before,
        direction: after > before ? 'forward' : 'back',
      });
      prevOffset = offset;
    }
    cursor = nextDay;
  }
  return out;
}

/**
 * Occurrence expansion, via cron-parser.
 *
 * This is the execution oracle: the only component that decides which instants
 * a schedule really fires. The audit never re-derives this; it compares the
 * oracle against the nominal model from `expression.js`.
 *
 * Measured cost (see docs/FINDINGS.md) is roughly 0.1 ms per occurrence, so a
 * year of `* * * * *` is ~60 s. Every expansion therefore takes a hard limit
 * and reports `truncated` instead of silently running for a minute.
 */
import { CronExpressionParser } from 'cron-parser';
import { formatLocal, offsetLabel } from './wallclock.js';

export const DEFAULT_LIMIT = 5000;

/**
 * @param {object} params
 * @param {string} params.expression
 * @param {string} params.tz IANA zone
 * @param {number} params.fromMs inclusive
 * @param {number} params.toMs inclusive
 * @param {number} [params.limit]
 * @returns {{ok:boolean, error:string|null, occurrences:Array<{ms:number,iso:string,local:string,offset:string}>, truncated:boolean}}
 */
export function expandOccurrences({ expression, tz, fromMs, toMs, limit = DEFAULT_LIMIT }) {
  const out = { ok: false, error: null, occurrences: [], truncated: false };
  if (!(toMs >= fromMs)) {
    out.error = 'empty window: "to" must not be before "from"';
    return out;
  }
  let interval;
  try {
    interval = CronExpressionParser.parse(String(expression ?? ''), {
      tz,
      // currentDate is exclusive in cron-parser, so step one millisecond back
      // to keep an occurrence that lands exactly on the window start.
      currentDate: new Date(fromMs - 1),
      endDate: new Date(toMs),
    });
  } catch (thrown) {
    out.error = thrown?.message ? String(thrown.message) : String(thrown);
    return out;
  }

  out.ok = true;
  while (out.occurrences.length <= limit) {
    let next;
    try {
      next = interval.next();
    } catch (thrown) {
      const message = thrown?.message ? String(thrown.message) : String(thrown);
      if (/out of the time ?span range/i.test(message)) break;
      out.error = message;
      break;
    }
    const ms = next.getTime();
    if (!Number.isFinite(ms) || ms < fromMs) continue;
    if (ms > toMs) break;
    if (out.occurrences.length === limit) {
      // One extra occurrence inside the window proves the result is incomplete.
      out.truncated = true;
      break;
    }
    out.occurrences.push({
      ms,
      iso: new Date(ms).toISOString(),
      local: formatLocal(ms, tz),
      offset: offsetLabel(ms, tz),
    });
  }
  return out;
}

/** First occurrence at or after `fromMs`, or null. Cheap existence probe. */
export function nextOccurrence({ expression, tz, fromMs, limitMs }) {
  try {
    const interval = CronExpressionParser.parse(String(expression ?? ''), {
      tz,
      currentDate: new Date(fromMs - 1),
      ...(limitMs ? { endDate: new Date(limitMs) } : {}),
    });
    return interval.next().getTime();
  } catch {
    return null;
  }
}

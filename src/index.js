/**
 * Public API.
 *
 * The unit of work is a *schedule set*: several cron jobs that are audited on a
 * shared time base so that their interactions (collisions, DST behaviour of one
 * job in one zone) can be reported together.
 */
import { DateTime } from 'luxon';
import { auditJob, summarise, SCHEMA_VERSION, enumerateDays } from './audit.js';
import { analyzeConflicts } from './conflicts.js';
import { parseExpression } from './expression.js';
import { describeBoth, describe } from './describe.js';
import { expandOccurrences, nextOccurrence } from './expand.js';
import { isValidZone, formatLocal, findTransitions, iso } from './wallclock.js';
import { VERSION, TOOL_NAME, UPSTREAMS } from './version.js';

export { auditJob, summarise, SCHEMA_VERSION, SEVERITY_ORDER } from './audit.js';
export { analyzeConflicts } from './conflicts.js';
export {
  parseExpression,
  parseField,
  enumerateSlots,
  matchesDate,
  MACROS,
  FIELD_SPECS,
} from './expression.js';
export { describe, describeBoth, errorMessage } from './describe.js';
export { expandOccurrences, nextOccurrence } from './expand.js';
export {
  resolveWallClock,
  findTransitions,
  formatLocal,
  localKey,
  offsetLabel,
  isValidZone,
  iso,
} from './wallclock.js';
export {
  toSystemd,
  toRRule,
  toIcs,
  toMarkdown,
  toCsv,
} from './export.js';
export { VERSION, TOOL_NAME, UPSTREAMS } from './version.js';

/**
 * Resolve `from` / `to` into an inclusive millisecond window.
 * Date-only strings are read as whole days in `windowTz`, which is what a human
 * means by "audit March".
 */
export function resolveWindow({ from, to, windowTz = 'UTC' }) {
  const zone = windowTz || 'UTC';
  const parse = (value, edge) => {
    if (value == null) throw new Error('window is missing a bound');
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    const text = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const dt = DateTime.fromISO(text, { zone });
      if (!dt.isValid) throw new Error(`invalid date "${text}": ${dt.invalidReason}`);
      return edge === 'start' ? dt.startOf('day').toMillis() : dt.endOf('day').toMillis();
    }
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) throw new Error(`cannot parse date "${text}"`);
    return ms;
  };
  const fromMs = parse(from, 'start');
  const toMs = parse(to, 'end');
  if (!(toMs > fromMs)) throw new Error('window end must be after window start');
  return { fromMs, toMs, windowTz: zone };
}

/**
 * Audit a set of jobs.
 *
 * @param {Array<{name?:string, expression:string, tz?:string, durationSeconds?:number, slaMaxGapSeconds?:number, note?:string}>} jobs
 * @param {object} options
 * @param {string|number|Date} options.from
 * @param {string|number|Date} options.to
 * @param {string} [options.windowTz] zone used for date-only bounds and reporting
 * @param {number} [options.maxOccurrences] per-job expansion budget
 * @param {'auto'|'full'|'sample'} [options.mode]
 * @param {number} [options.threshold] concurrency threshold for collisions
 * @param {number} [options.sampleRadiusHours]
 */
export function audit(jobs, options) {
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error('audit needs at least one job');
  // Validate the jobs before touching the window: a job zone is also the
  // default window zone, and an unknown zone would otherwise surface as a
  // confusing "invalid date" from the date parser.
  for (const [i, job] of jobs.entries()) {
    if (!job || typeof job.expression !== 'string' || job.expression.trim() === '') {
      throw new Error(`job #${i + 1} has no expression`);
    }
    if (job.tz && !isValidZone(job.tz)) {
      throw new Error(`job #${i + 1} has an unknown zone "${job.tz}" (expected an IANA name such as Europe/Berlin)`);
    }
  }
  const windowTz = options.windowTz
    ?? jobs.find((j) => j && j.tz)?.tz
    ?? 'UTC';
  if (!isValidZone(windowTz)) throw new Error(`unknown window zone "${windowTz}"`);
  const { fromMs, toMs } = resolveWindow({ from: options.from, to: options.to, windowTz });

  const jobReports = jobs.map((job) =>
    auditJob({ ...job, tz: job.tz || windowTz }, {
      fromMs,
      toMs,
      maxOccurrences: options.maxOccurrences,
      mode: options.mode,
      sampleRadiusHours: options.sampleRadiusHours,
    }),
  );

  const conflicts = jobs.length > 1
    ? analyzeConflicts(
      jobs.map((j) => ({ ...j, tz: j.tz || windowTz })),
      {
        fromMs,
        toMs,
        maxOccurrences: options.maxOccurrences ?? 5000,
        threshold: options.threshold ?? 2,
        // Reuse the expansions the audit already paid for.
        occurrences: jobReports.map((r) => r.occurrences),
      },
    )
    : { threshold: options.threshold ?? 2, sameInstant: [], sameInstantTotal: 0, windows: [], truncated: false, perJob: [], busySeconds: 0, local: [] };

  // The full occurrence list is only needed for the collision pass; reports
  // stay small enough to paste into a ticket.
  for (const report of jobReports) delete report.occurrences;

  const days = enumerateDays(windowTz, fromMs, toMs).length;
  return {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      tool: { name: TOOL_NAME, version: VERSION, upstreams: { ...UPSTREAMS } },
      window: {
        fromIso: iso(fromMs),
        toIso: iso(toMs),
        fromMs,
        toMs,
        days,
        windowTz,
      },
      options: {
        maxOccurrences: options.maxOccurrences ?? 5000,
        mode: options.mode ?? 'auto',
        threshold: options.threshold ?? 2,
      },
    },
    jobs: jobReports,
    conflicts,
    summary: summarise(jobReports),
  };
}

/** Everything the tool knows about a single expression, without a window. */
export function explain(expression, { tz = 'UTC', count = 5, fromMs = Date.now() } = {}) {
  if (!isValidZone(tz)) throw new Error(`unknown zone "${tz}"`);
  const model = parseExpression(expression);
  const description = describeBoth(expression);
  const expansion = expandOccurrences({
    expression,
    tz,
    // "next" means strictly after now, the way a person reading "next runs"
    // means it; the window functions themselves stay inclusive.
    fromMs: fromMs + 1,
    toMs: fromMs + 366 * 86_400_000,
    limit: Math.max(count, 1),
  });
  return {
    expression,
    tz,
    model: {
      arity: model.arity ?? null,
      normalized: model.normalized ?? null,
      arityShift: model.arityShift ?? 0,
      enumerable: Boolean(model.enumerable),
      errors: model.errors ?? [],
      flags: model.flags ?? null,
    },
    description,
    next: expansion.occurrences.slice(0, count),
    engineError: expansion.error,
  };
}

export default {
  audit,
  explain,
  auditJob,
  parseExpression,
  describe,
  describeBoth,
  expandOccurrences,
  nextOccurrence,
  findTransitions,
  formatLocal,
  VERSION,
  TOOL_NAME,
  UPSTREAMS,
};

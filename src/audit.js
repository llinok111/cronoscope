/**
 * The audit engine.
 *
 * For every job it builds three independent views and then compares them:
 *
 *   intent   the nominal model  (expression.js)  — the wall-clock readings written down
 *   oracle   the execution engine (expand.js)     — the instants that really fire
 *   language the description engine (describe.js) — what the schedule is said to mean
 *
 * Every finding is a *divergence between two of those views*, carrying the
 * evidence that produced it (dates, offsets, instants). Nothing is reported
 * from a heuristic: if the tool says "shifted by 60 minutes", there is an
 * instant in the evidence that shows it.
 */
import { DateTime } from 'luxon';
import {
  parseExpression,
  enumerateSlots,
  slotsPerDay,
  isDailyRegular,
  matchesDate,
  fieldValueList,
} from './expression.js';
import { describeBoth } from './describe.js';
import { expandOccurrences, nextOccurrence } from './expand.js';
import {
  findTransitions,
  resolveWallClock,
  formatLocal,
  localKey,
  offsetLabel,
  iso,
} from './wallclock.js';

export const SCHEMA_VERSION = 1;
export const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

const DAY_MS = 86_400_000;

function mkFinding(code, severity, title, detail, evidence = {}) {
  return { code, severity, title, detail, evidence };
}

/** Calendar days (in `zone`) touched by the window. */
export function enumerateDays(zone, fromMs, toMs) {
  const days = [];
  let cursor = DateTime.fromMillis(fromMs, { zone }).startOf('day');
  const end = DateTime.fromMillis(toMs, { zone });
  let guard = 0;
  while (cursor.toMillis() <= toMs && guard < 4000) {
    const next = cursor.plus({ days: 1 });
    days.push({
      year: cursor.year,
      month: cursor.month,
      day: cursor.day,
      key: cursor.toFormat('yyyy-MM-dd'),
      startMs: Math.max(cursor.toMillis(), fromMs),
      endMs: Math.min(next.toMillis() - 1, toMs),
    });
    cursor = next;
    guard += 1;
  }
  return days;
}

/**
 * Upper bound of occurrences the nominal model asks for across `days`.
 *
 * Edge days matter: a March window in New York starts at 05:00Z, so a 06:00
 * Asia/Shanghai job has not fired yet on March 1 and the window's last day is
 * April 1 locally. Counting matching calendar days alone over-counts by one.
 * For a day whose first or last reading straddles the window edge we keep a
 * per-day count and mark the estimate approximate.
 */
export function estimateOccurrences(model, days, tz, fromMs, toMs) {
  if (!model.enumerable) return null;
  const perDay = slotsPerDay(model);
  let matching = 0;
  let approximate = false;
  for (const day of days) {
    if (!matchesDate(model, day)) continue;
    // First and last reading of the day, straight from the field sets: no need
    // to materialise every slot just to know where the day starts and ends.
    const hours = fieldValueList(model, 'hour');
    const minutes = fieldValueList(model, 'minute');
    const seconds = fieldValueList(model, 'second');
    if (hours.length === 0 || minutes.length === 0) continue;
    const first = resolveWallClock(tz, {
      year: day.year, month: day.month, day: day.day,
      hour: hours[0], minute: minutes[0], second: seconds[0],
    });
    const last = resolveWallClock(tz, {
      year: day.year, month: day.month, day: day.day,
      hour: hours.at(-1), minute: minutes.at(-1), second: seconds.at(-1),
    });
    const firstMs = first.instants[0] ?? first.candidates[0]?.ms ?? null;
    const lastMs = last.instants.at(-1) ?? last.candidates.at(-1)?.ms ?? null;
    if (firstMs !== null && lastMs !== null && (firstMs > toMs || lastMs < fromMs)) continue;
    if (fromMs !== undefined && (firstMs === null || firstMs < fromMs || lastMs === null || lastMs > toMs)) {
      approximate = true;
    }
    matching += 1;
  }
  return { perDay, matchingDays: matching, total: matching * perDay, approximate };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Audit one job.
 *
 * @param {{name?:string, expression:string, tz:string, durationSeconds?:number, slaMaxGapSeconds?:number, note?:string}} job
 * @param {{fromMs:number, toMs:number, maxOccurrences?:number, sampleRadiusHours?:number, mode?:'auto'|'full'|'sample'}} options
 */
export function auditJob(job, options) {
  const { fromMs, toMs } = options;
  const tz = job.tz || 'UTC';
  const maxOccurrences = options.maxOccurrences ?? 5000;
  const sampleRadiusHours = options.sampleRadiusHours ?? 3;
  const mode = options.mode ?? 'auto';

  const findings = [];
  const model = parseExpression(job.expression);
  const description = describeBoth(job.expression);
  const days = enumerateDays(tz, fromMs, toMs);
  const transitions = findTransitions(tz, fromMs, toMs);

  // ---------------------------------------------------------------- arity
  if (model.arity !== undefined && model.arity < 5) {
    const original = model.split?.tokens?.join(' ') ?? job.expression;
    const padded = model.split?.effectiveTokens?.join(' ') ?? model.tokens?.join(' ') ?? original;
    findings.push(
      mkFinding(
        'arity.short',
        'error',
        `Expression has ${model.arity} fields; the engine pads it to 5 instead of rejecting it`,
        `cron-parser prepends ${5 - model.arity} "*" to a short expression, so every field moves one `
          + `position: "${original}" runs as "${padded}" — the first number becomes the hour, not the minute.`,
        { written: job.expression, executedAs: padded, paddedWith: 5 - model.arity },
      ),
    );
  }
  if (model.arity !== undefined && model.arity > 6) {
    findings.push(
      mkFinding(
        'arity.long',
        'error',
        `Expression has ${model.arity} fields`,
        'cron-parser rejects more than 6 fields; cRonstrue accepts 7 (seconds + year). '
          + 'One of the two engines will refuse this schedule.',
        { written: job.expression, fields: model.arity },
      ),
    );
  }

  // ------------------------------------------------------- engine vs words
  const probe = expandOccurrences({
    expression: job.expression,
    tz,
    fromMs,
    toMs,
    limit: 1,
  });
  const engineOk = probe.ok && probe.error === null;
  const descOk = description.en.ok;
  if (engineOk && !descOk) {
    findings.push(
      mkFinding(
        'engines.disagree',
        'warn',
        'The execution engine accepts this expression, the description engine rejects it',
        `cron-parser parses it; cRonstrue refuses with "${description.en.error}". A schedule `
          + 'that cannot be described is usually a schedule whose author meant something else.',
        { engine: 'ok', describer: description.en.error },
      ),
    );
  } else if (!engineOk && descOk) {
    findings.push(
      mkFinding(
        'engines.disagree',
        'warn',
        'The description engine accepts this expression, the execution engine rejects it',
        `cRonstrue reads it as "${description.en.text}"; cron-parser refuses with "${probe.error}".`,
        { engine: probe.error, describer: description.en.text },
      ),
    );
  } else if (!engineOk && !descOk) {
    findings.push(
      mkFinding('engine.parse_failed', 'error', 'Neither engine can read this expression', String(probe.error), {
        engine: probe.error,
        describer: description.en.error,
      }),
    );
  }

  if (model.flags?.nondeterministic) {
    findings.push(
      mkFinding(
        'expression.nondeterministic',
        'info',
        'Expression uses the H (hashed) macro',
        'cron-parser replaces H with a value derived from a hash seed, so the firing times are '
          + 'stable per seed but unknowable from the text. Slot-level checks are skipped; the '
          + 'timeline below is the only truth.',
        { expression: job.expression },
      ),
    );
  }
  if (model.errors?.length) {
    findings.push(
      mkFinding('expression.invalid', 'error', 'The nominal model cannot read this expression', model.errors.join('; '), {
        errors: model.errors,
      }),
    );
  }

  // -------------------------------------------------------------- coverage
  const estimate = estimateOccurrences(model, days, tz, fromMs, toMs);
  let coverageMode = 'full';
  let coverageReason = null;
  if (mode === 'sample') {
    coverageMode = 'sampled';
    coverageReason = 'sampling requested by the caller';
  } else if (estimate && estimate.total > maxOccurrences) {
    coverageMode = 'sampled';
    coverageReason =
      `the expression asks for ~${estimate.total} occurrences (${estimate.perDay}/day over `
      + `${estimate.matchingDays} matching days); expanding all of them exceeds the `
      + `${maxOccurrences}-occurrence budget (measured cost ~0.1 ms each)`;
  }

  /** @type {Array<{fromMs:number,toMs:number,label:string}>} */
  const windows = [];
  if (coverageMode === 'full') {
    windows.push({ fromMs, toMs, label: 'full window' });
  } else {
    // A dense schedule is audited where it can actually break: around offset
    // changes, plus one baseline day so the report has a reference cadence.
    const radius = sampleRadiusHours * 3600_000;
    windows.push({ fromMs, toMs: Math.min(fromMs + DAY_MS - 1, toMs), label: 'baseline day' });
    for (const t of transitions) {
      windows.push({
        fromMs: Math.max(fromMs, t.at - radius),
        toMs: Math.min(toMs, t.at + radius),
        label: `transition ${iso(t.at)} ${t.direction} ${t.deltaMinutes}m`,
      });
    }
  }

  const occurrenceMap = new Map();
  let truncated = false;
  let engineError = probe.error;
  for (const w of windows) {
    const slice = expandOccurrences({
      expression: job.expression,
      tz,
      fromMs: w.fromMs,
      toMs: w.toMs,
      limit: coverageMode === 'full' ? maxOccurrences : Math.max(200, maxOccurrences),
    });
    if (slice.error) engineError = slice.error;
    if (slice.truncated) truncated = true;
    for (const occ of slice.occurrences) occurrenceMap.set(occ.ms, occ);
  }
  if (truncated) {
    findings.push(
      mkFinding('coverage.truncated', 'warn', 'Occurrence list hit the budget', `Only the first occurrences up to the limit were kept; gap statistics cover the covered span only.`, { maxOccurrences }),
    );
  }
  const occurrences = [...occurrenceMap.values()].sort((a, b) => a.ms - b.ms);

  // ------------------------------------------------------- dead schedule
  if (engineOk && occurrences.length === 0) {
    const later = nextOccurrence({ expression: job.expression, tz, fromMs });
    findings.push(
      mkFinding(
        'schedule.dead',
        'error',
        'Parses cleanly, never fires in this window',
        later === null
          ? 'The engine produced no occurrence and cannot produce one at all.'
          : `Nothing fires between ${iso(fromMs)} and ${iso(toMs)}; the next occurrence is ${iso(later)} (${formatLocal(later, tz)}).`,
        { window: { fromIso: iso(fromMs), toIso: iso(toMs) }, nextAfterWindow: later === null ? null : iso(later) },
      ),
    );
  }

  // ------------------------------------------- slot-level wall-clock check
  const slotStats = {
    total: 0,
    matched: 0,
    shifted: 0,
    skipped: 0,
    ambiguousOnce: 0,
    ambiguousBoth: 0,
    missing: 0,
  };
  const grouped = new Map(); // `${code}|${dayKey}` -> {code, severity, dayKey, count, samples}
  const consumed = new Set();
  const addGroup = (code, severity, dayKey, sample) => {
    const key = `${code}|${dayKey}`;
    if (!grouped.has(key)) grouped.set(key, { code, severity, dayKey, count: 0, samples: [] });
    const bucket = grouped.get(key);
    bucket.count += 1;
    if (bucket.samples.length < 3) bucket.samples.push(sample);
  };

  if (model.enumerable && engineOk) {
    const pad = (n) => String(n).padStart(2, '0');
    const coveredIntervals = windows.map((w) => [w.fromMs, w.toMs]);
    const inCoverage = (ms) => coveredIntervals.some(([a, b]) => ms >= a && ms <= b);

    // Pass 1 — resolve every reading, and keep only the ones the audit actually
    // expanded occurrences for. Without this, a sampled job reports every slot
    // of a transition day as "missing" simply because the day was only sampled
    // for three hours around the offset change.
    const entries = [];
    for (const day of days) {
      if (!coveredIntervals.some(([a, b]) => day.startMs <= b && day.endMs >= a)) continue;
      for (const slot of enumerateSlots(model, day)) {
        const reading = resolveWallClock(tz, slot);
        const anchors = reading.kind === 'nonexistent'
          ? reading.candidates.map((c) => c.ms)
          : reading.instants;
        if (anchors.length === 0 || !anchors.some(inCoverage)) continue;
        entries.push({ day, slot, reading });
      }
    }

    // Pass 2 — which instants are already justified by a reading that exists?
    // A gap candidate that coincides with such an instant was not "shifted
    // into" it; the engine simply fired the neighbouring slot on time. Without
    // this, `*/15 * * * *` reports four phantom shifts where it only skipped.
    const claimed = new Set();
    for (const { reading } of entries) {
      if (reading.kind === 'nonexistent') continue;
      for (const ms of reading.instants) claimed.add(ms);
    }

    for (const { day, slot, reading } of entries) {
      slotStats.total += 1;
      const readingText = `${day.key} ${pad(slot.hour)}:${pad(slot.minute)}:${pad(slot.second)}`;
      if (reading.kind === 'unique') {
        if (occurrenceMap.has(reading.instants[0])) {
          slotStats.matched += 1;
          consumed.add(reading.instants[0]);
        } else {
          slotStats.missing += 1;
          addGroup('slot.missing', 'error', day.key, {
            reading: readingText,
            expectedInstant: iso(reading.instants[0]),
            expectedLocal: formatLocal(reading.instants[0], tz),
          });
        }
      } else if (reading.kind === 'ambiguous') {
        const inWindow = reading.instants.filter((ms) => ms >= fromMs && ms <= toMs);
        const hits = inWindow.filter((ms) => occurrenceMap.has(ms));
        for (const ms of hits) consumed.add(ms);
        if (hits.length === inWindow.length && inWindow.length === 2) {
          slotStats.ambiguousBoth += 1;
        } else if (hits.length === 1 && inWindow.length === 2) {
          slotStats.ambiguousOnce += 1;
          const fired = DateTime.fromMillis(hits[0], { zone: tz });
          const notFired = inWindow.find((ms) => ms !== hits[0]);
          addGroup('dst.ambiguous.single', 'warn', day.key, {
            reading: readingText,
            firedOffset: fired.toFormat('ZZ'),
            skippedInstant: iso(notFired),
            note: 'the wall-clock reading happens twice; the engine fires once',
          });
        } else if (hits.length === 0) {
          slotStats.missing += 1;
          addGroup('slot.missing', 'error', day.key, {
            reading: readingText,
            expectedInstants: inWindow.map(iso),
          });
        } else {
          slotStats.matched += 1;
        }
      } else {
        // Nonexistent reading: did the engine land on one of the two
        // "would-have-been" instants, or drop the slot entirely?
        const fired = reading.candidates.find((c) => occurrenceMap.has(c.ms) && !claimed.has(c.ms));
        if (fired) {
          consumed.add(fired.ms);
          slotStats.shifted += 1;
          const landed = DateTime.fromMillis(fired.ms, { zone: tz });
          const deltaMinutes = landed.hour * 60 + landed.minute - (slot.hour * 60 + slot.minute);
          addGroup('dst.gap.shifted', 'warn', day.key, {
            reading: readingText,
            firedAt: formatLocal(fired.ms, tz),
            deltaMinutes,
          });
        } else {
          slotStats.skipped += 1;
          addGroup('dst.gap.skipped', 'warn', day.key, {
            reading: readingText,
            note: 'this wall-clock reading does not exist in the zone and no instant was produced for it',
          });
        }
      }
    }

    for (const occ of occurrences) {
      if (consumed.has(occ.ms)) continue;
      const nearTransition = transitions.find((t) => Math.abs(t.at - occ.ms) < 6 * 3600_000);
      addGroup('occurrence.unexpected', 'info', occ.local.slice(0, 10), {
        instant: occ.iso,
        local: occ.local,
        nearTransition: nearTransition
          ? { at: iso(nearTransition.at), direction: nearTransition.direction, deltaMinutes: nearTransition.deltaMinutes }
          : null,
      });
    }
  }

  const codeTitles = {
    'slot.missing': ['A requested reading never fired', 'error'],
    'dst.gap.shifted': ['A reading inside the DST gap fired at a different wall clock', 'warn'],
    'dst.gap.skipped': ['A reading inside the DST gap fired nowhere', 'warn'],
    'dst.ambiguous.single': ['A reading that happens twice fired once', 'warn'],
    'occurrence.unexpected': ['An occurrence fired that the nominal model did not ask for', 'info'],
  };
  for (const bucket of grouped.values()) {
    const [title, severity] = codeTitles[bucket.code] ?? [bucket.code, bucket.severity];
    findings.push(
      mkFinding(
        bucket.code,
        severity,
        `${title} (${bucket.count}× on ${bucket.dayKey})`,
        bucket.code === 'occurrence.unexpected'
          ? 'These instants are real firings with no corresponding nominal slot. Near an offset change this is normal for grid expressions; elsewhere it means the engine and the text disagree.'
          : `${bucket.count} slot(s) on ${bucket.dayKey} diverged between the nominal model and the engine. The first ${bucket.samples.length} are below.`,
        { day: bucket.dayKey, count: bucket.count, samples: bucket.samples },
      ),
    );
  }

  // ---------------------------------------------------------- cadence
  const deltas = [];
  for (let i = 1; i < occurrences.length; i += 1) deltas.push(occurrences[i].ms - occurrences[i - 1].ms);
  const typical = median(deltas);
  const regular = isDailyRegular(model);

  if (job.slaMaxGapSeconds) {
    const capMs = job.slaMaxGapSeconds * 1000;
    const breaches = [];
    for (let i = 1; i < occurrences.length; i += 1) {
      const delta = occurrences[i].ms - occurrences[i - 1].ms;
      if (delta > capMs) {
        breaches.push({
          from: occurrences[i - 1].iso,
          to: occurrences[i].iso,
          gapSeconds: Math.round(delta / 1000),
        });
      }
    }
    if (breaches.length > 0) {
      findings.push(
        mkFinding(
          'cadence.sla_breach',
          'error',
          `${breaches.length} gap(s) exceed the declared ${job.slaMaxGapSeconds}s SLA`,
          `The job declares it must run at least every ${job.slaMaxGapSeconds}s. Largest gap: ${Math.max(...breaches.map((b) => b.gapSeconds))}s.`,
          { slaMaxGapSeconds: job.slaMaxGapSeconds, breaches: breaches.slice(0, 10), breachCount: breaches.length },
        ),
      );
    }
  }

  if (regular && typical && typical > 0) {
    const gaps = [];
    for (let i = 1; i < occurrences.length; i += 1) {
      const delta = occurrences[i].ms - occurrences[i - 1].ms;
      if (delta > typical * 1.5) {
        const transition = transitions.find((t) => Math.abs(t.at - occurrences[i].ms) < 6 * 3600_000);
        gaps.push({
          from: occurrences[i - 1].iso,
          to: occurrences[i].iso,
          gapSeconds: Math.round(delta / 1000),
          expectedSeconds: Math.round(typical / 1000),
          transition: transition ? { at: iso(transition.at), direction: transition.direction } : null,
        });
      }
    }
    if (gaps.length > 0) {
      findings.push(
        mkFinding(
          'cadence.gap',
          'warn',
          `${gaps.length} interval(s) stretch past 1.5× the typical ${Math.round(typical / 1000)}s cadence`,
          'A hole in a regular cadence is what monitoring notices first; near an offset change it is the DST gap, otherwise it is a month/day boundary or a misread field.',
          { typicalSeconds: Math.round(typical / 1000), gaps: gaps.slice(0, 10) },
        ),
      );
    }
  }

  if (transitions.length > 0 && slotStats.shifted === 0 && slotStats.skipped === 0 && slotStats.ambiguousOnce === 0) {
    findings.push(
      mkFinding(
        'dst.clean',
        'info',
        `${transitions.length} offset change(s) in the window, no slot diverged`,
        'The expression never targets a wall-clock reading that the transition disturbs.',
        { transitions: transitions.map((t) => ({ at: iso(t.at), direction: t.direction, deltaMinutes: t.deltaMinutes })) },
      ),
    );
  }

  const stats = {
    occurrences: occurrences.length,
    firstIso: occurrences.length ? occurrences[0].iso : null,
    lastIso: occurrences.length ? occurrences[occurrences.length - 1].iso : null,
    typicalDeltaSeconds: typical === null ? null : Math.round(typical / 1000),
    transitions: transitions.length,
    slots: slotStats,
  };

  return {
    name: job.name ?? job.expression,
    expression: job.expression,
    tz,
    durationSeconds: job.durationSeconds ?? 0,
    slaMaxGapSeconds: job.slaMaxGapSeconds ?? null,
    note: job.note ?? null,
    model: {
      arity: model.arity ?? null,
      normalized: model.normalized ?? null,
      arityShift: model.arityShift ?? 0,
      enumerable: Boolean(model.enumerable),
      flags: model.flags ?? null,
      errors: model.errors ?? [],
    },
    description,
    engine: { ok: engineOk, error: engineError },
    transitions: transitions.map((t) => ({
      at: iso(t.at),
      direction: t.direction,
      deltaMinutes: t.deltaMinutes,
      before: t.before,
      after: t.after,
      localBefore: formatLocal(t.at - 1, tz),
      localAfter: formatLocal(t.at, tz),
    })),
    coverage: {
      mode: coverageMode,
      reason: coverageReason,
      windows: windows.map((w) => ({ fromIso: iso(w.fromMs), toIso: iso(w.toMs), label: w.label })),
      estimate,
      truncated,
    },
    stats,
    timeline: occurrences.slice(0, 24),
    occurrences,
    findings: findings.sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code),
    ),
  };
}

/** Count findings by severity across job reports. */
export function summarise(jobReports) {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const job of jobReports) {
    for (const f of job.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  return {
    jobs: jobReports.length,
    occurrences: jobReports.reduce((n, j) => n + j.stats.occurrences, 0),
    errors: counts.error,
    warnings: counts.warn,
    infos: counts.info,
    highest: counts.error > 0 ? 'error' : counts.warn > 0 ? 'warn' : counts.info > 0 ? 'info' : 'none',
  };
}

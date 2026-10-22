/**
 * Cross-job collision analysis.
 *
 * Two jobs are only a problem together when they contend for the same resource
 * at the same time. Cron gives no way to see that: each crontab line is
 * independent, and a 02:00 backup plus a 02:00 cache warm reads as two innocent
 * lines. This module expands every job on the same time base and looks for
 * (a) exact-instant collisions and (b) real overlaps once durations are known.
 *
 * Durations are the caller's declaration, not a measurement. A job without a
 * declared duration takes part in `sameInstant` only — it is never given a
 * made-up length.
 */
import { expandOccurrences } from './expand.js';
import { iso, formatLocal } from './wallclock.js';

/**
 * @param {Array<{name?:string, expression:string, tz:string, durationSeconds?:number}>} jobs
 * @param {{fromMs:number,toMs:number,maxOccurrences?:number,threshold?:number,maxWindows?:number,occurrences?:Array<Array<object>>}} options
 *   `occurrences[i]` may carry an already-expanded list for `jobs[i]`, so the
 *   collision pass does not expand the same schedule a second time.
 */
export function analyzeConflicts(jobs, options) {
  const { fromMs, toMs } = options;
  const maxOccurrences = options.maxOccurrences ?? 5000;
  const threshold = options.threshold ?? 2;
  const maxWindows = options.maxWindows ?? 200;

  const perJob = [];
  let truncated = false;

  for (const [index, job] of jobs.entries()) {
    const precomputed = options.occurrences?.[index];
    let occurrences = precomputed;
    let error = null;
    if (!occurrences) {
      const expansion = expandOccurrences({
        expression: job.expression,
        tz: job.tz || 'UTC',
        fromMs,
        toMs,
        limit: maxOccurrences,
      });
      if (expansion.truncated) truncated = true;
      occurrences = expansion.occurrences;
      error = expansion.error;
    }
    perJob.push({
      name: job.name ?? job.expression,
      tz: job.tz || 'UTC',
      durationSeconds: job.durationSeconds ?? 0,
      occurrences,
      error,
    });
  }

  // ---- exact-instant collisions -------------------------------------------
  const byInstant = new Map();
  for (const job of perJob) {
    for (const occ of job.occurrences) {
      if (!byInstant.has(occ.ms)) byInstant.set(occ.ms, new Set());
      byInstant.get(occ.ms).add(job.name);
    }
  }
  const sameInstant = [...byInstant.entries()]
    .filter(([, names]) => names.size >= threshold)
    .sort((a, b) => a[0] - b[0])
    .slice(0, maxWindows)
    .map(([ms, names]) => ({ at: iso(ms), ms, jobs: [...names].sort() }));
  const sameInstantTotal = [...byInstant.values()].filter((names) => names.size >= threshold).length;

  // ---- overlap windows (only jobs with a declared duration) ---------------
  const events = [];
  for (const job of perJob) {
    if (!job.durationSeconds || job.durationSeconds <= 0) continue;
    for (const occ of job.occurrences) {
      events.push({ t: occ.ms, kind: 'start', job: job.name });
      events.push({ t: occ.ms + job.durationSeconds * 1000, kind: 'end', job: job.name });
    }
  }
  // Half-open intervals: an end at t does not overlap a start at t.
  events.sort((a, b) => a.t - b.t || (a.kind === 'end' ? -1 : 1));

  const windows = [];
  const active = new Map(); // job -> concurrent count
  let open = null;
  let openPeak = 0;
  let openMembers = new Set();
  let truncatedWindows = false;

  for (const event of events) {
    if (event.kind === 'start') {
      active.set(event.job, (active.get(event.job) ?? 0) + 1);
    } else {
      const n = (active.get(event.job) ?? 1) - 1;
      if (n <= 0) active.delete(event.job);
      else active.set(event.job, n);
    }
    const concurrency = [...active.values()].reduce((a, b) => a + b, 0);
    if (concurrency >= threshold) {
      if (!open) {
        open = event.t;
        openPeak = concurrency;
        openMembers = new Set(active.keys());
      } else {
        openPeak = Math.max(openPeak, concurrency);
        for (const k of active.keys()) openMembers.add(k);
      }
    } else if (open) {
      // Never report an overlap that extends past the audited window: the
      // events after `toMs` are real, but they are outside the contract.
      const endsAt = Math.min(event.t, toMs);
      if (windows.length < maxWindows) {
        windows.push({
          from: iso(open),
          to: iso(endsAt),
          fromMs: open,
          toMs: endsAt,
          durationSeconds: Math.round((endsAt - open) / 1000),
          peakConcurrency: openPeak,
          jobs: [...openMembers].sort(),
        });
      } else {
        truncatedWindows = true;
      }
      open = null;
      openPeak = 0;
      openMembers = new Set();
    }
  }
  if (open && windows.length < maxWindows) {
    windows.push({
      from: iso(open),
      to: iso(toMs),
      fromMs: open,
      toMs,
      durationSeconds: Math.round((toMs - open) / 1000),
      peakConcurrency: openPeak,
      jobs: [...openMembers].sort(),
    });
  }

  return {
    threshold,
    sameInstant,
    sameInstantTotal,
    windows,
    truncated: truncated || truncatedWindows,
    perJob: perJob.map((j) => ({
      name: j.name,
      tz: j.tz,
      durationSeconds: j.durationSeconds,
      occurrences: j.occurrences.length,
      error: j.error,
    })),
    busySeconds: perJob.reduce((sum, j) => sum + j.occurrences.length * (j.durationSeconds || 0), 0),
    local: windows.slice(0, 5).map((w) => ({
      from: formatLocal(w.fromMs, perJob.find((j) => j.name === w.jobs[0])?.tz ?? 'UTC'),
      to: formatLocal(w.toMs, perJob.find((j) => j.name === w.jobs[0])?.tz ?? 'UTC'),
      jobs: w.jobs,
    })),
  };
}

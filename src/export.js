/**
 * Report formats.
 *
 * Four targets, each with an honest "can I express this at all" answer:
 *
 *   systemd OnCalendar   daemon-side replacement for a crontab line
 *   iCalendar RRULE      calendar-side representation (readable by humans)
 *   Markdown             the human audit artefact
 *   JSON / CSV           the machine artefacts, stable enough to diff
 *
 * Cron, systemd and RFC 5545 do not agree on day-of-month vs day-of-week
 * semantics: cron ORs them, systemd and RRULE AND them. Any expression that
 * restricts both is therefore reported as not convertible instead of being
 * silently mistranslated.
 */
import { fieldValueList, isAnyValue, parseExpression } from './expression.js';

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_ICS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

const pad2 = (n) => String(n).padStart(2, '0');

function compressRuns(values, render) {
  const out = [];
  let i = 0;
  while (i < values.length) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j += 1;
    if (j - i >= 2) out.push(`${render(values[i])}..${render(values[j])}`);
    else for (let k = i; k <= j; k += 1) out.push(render(values[k]));
    i = j + 1;
  }
  return out.join(',');
}

/**
 * Translate the nominal model to a systemd `OnCalendar=` value.
 * @returns {{supported:boolean, value:string|null, reason:string|null, notes:string[]}}
 */
export function toSystemd(model) {
  if (!model.ok || !model.enumerable) {
    return { supported: false, value: null, reason: model.errors?.join('; ') || 'expression is not enumerable', notes: [] };
  }
  const { flags } = model;
  if (flags.domRestricted && flags.dowRestricted) {
    return {
      supported: false,
      value: null,
      reason:
        'cron ORs day-of-month with day-of-week when both are restricted; systemd ANDs them. '
        + 'Translating this expression would change which days it fires on.',
      notes: [],
    };
  }
  if (flags.hasLast || flags.hasNth || flags.hasLastDow) {
    return {
      supported: false,
      value: null,
      reason: 'systemd OnCalendar has no equivalent for L / # day selectors',
      notes: [],
    };
  }

  const hours = fieldValueList(model, 'hour');
  const minutes = fieldValueList(model, 'minute');
  const seconds = fieldValueList(model, 'second');
  const months = fieldValueList(model, 'month');
  const doms = fieldValueList(model, 'dom');

  const hourPart = isAnyValue(model, 'hour') ? '*' : compressRuns(hours, pad2);
  const minutePart = isAnyValue(model, 'minute') ? '*' : compressRuns(minutes, pad2);
  const secondPart = isAnyValue(model, 'second') ? '*' : compressRuns(seconds, pad2);
  const monthPart = isAnyValue(model, 'month') ? '*' : compressRuns(months, pad2);
  const domPart = isAnyValue(model, 'dom') ? '*' : compressRuns(doms, pad2);

  const dowPrefix = flags.dowRestricted
    ? `${compressRuns(fieldValueList(model, 'dow'), (d) => DOW_SHORT[d])} `
    : '';

  const value = `${dowPrefix}*-${monthPart}-${domPart} ${hourPart}:${minutePart}:${secondPart}`;
  const notes = [];
  if (seconds.length > 1) notes.push('systemd will run once per listed second; cron implementations that lack a seconds field will not.');
  if (flags.hasQuestionMark || /\?/.test(model.expression)) notes.push('"?" was treated as "*" (Vixie cron behaviour).');
  notes.push('systemd resolves the wall clock at fire time, exactly like cron: the DST behaviour of the two differs even when the pattern matches.');
  return { supported: true, value, reason: null, notes };
}

/**
 * Translate the nominal model to an RFC 5545 RRULE.
 * @returns {{supported:boolean, value:string|null, reason:string|null}}
 */
export function toRRule(model) {
  if (!model.ok || !model.enumerable) {
    return { supported: false, value: null, reason: model.errors?.join('; ') || 'expression is not enumerable' };
  }
  const { flags } = model;
  if (flags.domRestricted && flags.dowRestricted || flags.domRestricted && flags.nth?.length) {
    return {
      supported: false,
      value: null,
      reason: 'RRULE cannot OR day-of-month with day-of-week; cron can',
    };
  }
  const seconds = fieldValueList(model, 'second');
  const minutes = fieldValueList(model, 'minute');
  const hours = fieldValueList(model, 'hour');
  if (seconds.length > 1) {
    return {
      supported: false,
      value: null,
      reason: 'sub-minute cadences need FREQ=SECONDLY with BYSECOND lists, which most calendar clients ignore',
    };
  }

  const parts = [];
  let freq;
  if (isAnyValue(model, 'minute')) freq = 'MINUTELY';
  else if (isAnyValue(model, 'hour')) freq = 'HOURLY';
  else if (flags.hasNth || flags.hasLastDow) freq = 'MONTHLY'; // "first Monday" is a monthly rule
  else if (flags.dowRestricted) freq = 'WEEKLY';
  else if (flags.domRestricted) freq = 'MONTHLY';
  else freq = 'DAILY';

  parts.push(`FREQ=${freq}`);
  if (!isAnyValue(model, 'month')) parts.push(`BYMONTH=${fieldValueList(model, 'month').join(',')}`);
  if (freq !== 'MINUTELY' && !isAnyValue(model, 'minute')) {
    parts.push(`BYMINUTE=${minutes.join(',')}`);
  }
  if (!isAnyValue(model, 'hour') && freq !== 'HOURLY') {
    parts.push(`BYHOUR=${hours.join(',')}`);
  } else if (!isAnyValue(model, 'hour') && freq === 'HOURLY') {
    parts.push(`BYHOUR=${hours.join(',')}`);
  }
  if (flags.domRestricted) {
    const days = flags.hasLast ? ['-1'] : fieldValueList(model, 'dom').map(String);
    parts.push(`BYMONTHDAY=${days.join(',')}`);
  }
  if (flags.dowRestricted) {
    const spec = [];
    if (flags.hasNth) {
      for (const n of model.fields.dow.nth) spec.push(`${n.n}${DOW_ICS[n.dow]}`);
    } else if (flags.hasLastDow) {
      for (const d of model.fields.dow.lastDow) spec.push(`-1${DOW_ICS[d]}`);
    } else {
      spec.push(...fieldValueList(model, 'dow').map((d) => DOW_ICS[d]));
    }
    parts.push(`BYDAY=${spec.join(',')}`);
  }
  if (seconds.length === 1 && seconds[0] !== 0) parts.push(`BYSECOND=${seconds[0]}`);
  if (freq === 'WEEKLY') parts.push('WKST=SU');
  return { supported: true, value: parts.join(';'), reason: null };
}

function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function icsStamp(ms) {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`
    + `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

/**
 * A calendar file for one job. DTSTART is a *floating* local time on purpose:
 * cron fires on the local wall clock, and a floating time is what a calendar
 * client re-resolves against its own zone. Using UTC here would silently
 * freeze the schedule to one offset for half the year.
 */
export function toIcs(jobReport, { nowMs = Date.now() } = {}) {
  const model = modelOf(jobReport);
  const rule = toRRule(model);
  const first = jobReport.timeline?.[0];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//cronoscope//cronoscope 1.0.0//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${hash32(`${jobReport.name}|${jobReport.expression}|${jobReport.tz}`)}@cronoscope.local`,
    `DTSTAMP:${icsStamp(nowMs)}`,
    `SUMMARY:${escapeIcs(jobReport.name)}`,
    `DESCRIPTION:${escapeIcs(`${jobReport.expression} (${jobReport.tz}) — ${jobReport.description?.en?.text ?? ''}`)}`,
  ];
  if (first) {
    const local = first.local; // "2026-03-01 02:30:00 -05:00"
    const stamp = local.slice(0, 19).replace(/[-: ]/g, '');
    // slash-free floating time: 20260301T023000
    lines.push(`DTSTART:${stamp.slice(0, 8)}T${stamp.slice(8)}`);
  }
  if (rule.supported) lines.push(`RRULE:${rule.value}`);
  else lines.push(`X-CRONOSCOPE-UNSUPPORTED:${escapeIcs(rule.reason ?? 'not expressible')}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return { supported: rule.supported, text: `${lines.join('\r\n')}\r\n`, reason: rule.reason };
}

function escapeIcs(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Rebuild the nominal model from a report (reports carry their expression). */
function modelOf(jobReport) {
  return parseExpression(jobReport.expression);
}

const mdEscape = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * Markdown audit report.
 * @param {object} report output of `audit()` in index.js
 */
export function toMarkdown(report) {
  const lines = [];
  const { meta, jobs, conflicts, summary } = report;
  lines.push('# Cronoscope audit');
  lines.push('');
  lines.push(`Window: \`${meta.window.fromIso}\` → \`${meta.window.toIso}\` — ${meta.window.days} calendar days in \`${meta.window.windowTz}\``);
  lines.push('');
  lines.push(
    `Generated ${meta.generatedAt} by ${meta.tool.name} ${meta.tool.version} `
    + `(cron-parser ${meta.tool.upstreams['cron-parser']}, cRonstrue ${meta.tool.upstreams.cronstrue}, luxon ${meta.tool.upstreams.luxon}).`,
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| # | job | expression | zone | occurrences | errors | warnings | verdict |');
  lines.push('|---|---|---|---|---|---|---|---|');
  jobs.forEach((job, i) => {
    const errors = job.findings.filter((f) => f.severity === 'error').length;
    const warns = job.findings.filter((f) => f.severity === 'warn').length;
    const verdict = errors > 0 ? 'needs fixing' : warns > 0 ? 'review' : 'clean';
    lines.push(
      `| ${i + 1} | ${mdEscape(job.name)} | \`${mdEscape(job.expression)}\` | ${job.tz} | ${job.stats.occurrences} | ${errors} | ${warns} | ${verdict} |`,
    );
  });
  lines.push('');
  lines.push(
    `Totals: **${summary.errors} errors**, **${summary.warnings} warnings**, `
    + `${summary.infos} notes across ${summary.jobs} job(s) and ${summary.occurrences} expanded occurrences.`,
  );
  lines.push('');

  for (const job of jobs) {
    lines.push(`## ${job.name}`);
    lines.push('');
    lines.push(`- expression: \`${job.expression}\``);
    lines.push(`- zone: \`${job.tz}\`  ·  engine reading: ${job.engine.ok ? 'ok' : `**${job.engine.error}**`}`);
    lines.push(`- described (en): ${job.description.en.ok ? job.description.en.text : `_${job.description.en.error}_`}`);
    lines.push(`- 描述 (zh_CN): ${job.description.zh_CN.ok ? job.description.zh_CN.text : `_${job.description.zh_CN.error}_`}`);
    if (job.model.normalized && job.model.normalized !== job.expression) {
      lines.push(`- engine normalises to: \`${job.model.normalized}\``);
    }
    lines.push(
      `- occurrences: ${job.stats.occurrences}${job.coverage.mode === 'sampled' ? ' (sampled)' : ''}`
      + `${job.stats.typicalDeltaSeconds ? `  ·  typical interval: ${job.stats.typicalDeltaSeconds}s` : ''}`,
    );
    if (job.coverage.mode === 'sampled') {
      lines.push(`- coverage: **sampled** — ${job.coverage.reason}`);
      for (const w of job.coverage.windows) lines.push(`  - ${w.label}: ${w.fromIso} → ${w.toIso}`);
    }
    lines.push('');

    if (job.findings.length === 0) {
      lines.push('_No divergence found between the written expression and the fired instants._');
      lines.push('');
    } else {
      for (const f of job.findings) {
        const badge = f.severity === 'error' ? '**ERROR**' : f.severity === 'warn' ? '**WARN**' : 'note';
        lines.push(`### ${badge} ${f.code} — ${f.title}`);
        lines.push('');
        lines.push(f.detail);
        lines.push('');
        const evidence = JSON.stringify(f.evidence, null, 2);
        if (evidence && evidence !== '{}') {
          lines.push('<details><summary>evidence</summary>');
          lines.push('');
          lines.push('```json');
          lines.push(evidence);
          lines.push('```');
          lines.push('');
          lines.push('</details>');
          lines.push('');
        }
      }
    }

    if (job.transitions.length > 0) {
      lines.push('#### Offset changes in window');
      lines.push('');
      lines.push('| instant (UTC) | direction | delta | local before | local after |');
      lines.push('|---|---|---|---|---|');
      for (const t of job.transitions) {
        lines.push(`| ${t.at} | ${t.direction} | ${t.deltaMinutes}m | ${t.localBefore} | ${t.localAfter} |`);
      }
      lines.push('');
    }

    if (job.timeline.length > 0) {
      lines.push(`#### First ${job.timeline.length} occurrences`);
      lines.push('');
      lines.push('| # | local wall clock | UTC | offset |');
      lines.push('|---|---|---|---|');
      job.timeline.forEach((o, i) => {
        lines.push(`| ${i + 1} | ${o.local} | ${o.iso} | ${o.offset} |`);
      });
      lines.push('');
    }
  }

  lines.push('## Cross-job collisions');
  lines.push('');
  if (!conflicts) {
    lines.push('_Not computed._');
  } else {
    lines.push(`Threshold: ${conflicts.threshold} concurrent job(s).`);
    lines.push('');
    lines.push(`- exact-instant collisions: ${conflicts.sameInstantTotal}`);
    lines.push(`- overlap windows: ${conflicts.windows.length}${conflicts.truncated ? ' (truncated)' : ''}`);
    lines.push('');
    if (conflicts.sameInstant.length > 0) {
      lines.push('| instant | jobs |');
      lines.push('|---|---|');
      for (const c of conflicts.sameInstant.slice(0, 20)) {
        lines.push(`| ${c.at} | ${c.jobs.join(', ')} |`);
      }
      lines.push('');
    }
    if (conflicts.windows.length > 0) {
      lines.push('| from | to | peak | jobs |');
      lines.push('|---|---|---|---|');
      for (const w of conflicts.windows.slice(0, 20)) {
        lines.push(`| ${w.from} | ${w.to} | ${w.peakConcurrency} | ${w.jobs.join(', ')} |`);
      }
      lines.push('');
    }
  }

  lines.push('## How to read this');
  lines.push('');
  lines.push('- `slot.missing` / `dst.*`: the written wall clock and the fired instants disagree. Evidence always names the reading and the instant.');
  lines.push('- `cadence.*`: intervals computed from the expanded timeline, not from the expression.');
  lines.push('- Sampled jobs are only checked where offset changes happen plus one baseline day; the reason is printed above each such job.');
  lines.push('');
  lines.push('## Provenance');
  lines.push('');
  lines.push(`- execution engine: cron-parser ${meta.tool.upstreams['cron-parser']} (MIT, © 2014-2023 Harri Siirak)`);
  lines.push(`- description engine: cRonstrue ${meta.tool.upstreams.cronstrue} (MIT, © 2017 Brady Holt)`);
  lines.push(`- time zone engine: luxon ${meta.tool.upstreams.luxon} (MIT, © 2019 JS Foundation and other contributors)`);
  lines.push('- full texts: `THIRD_PARTY_NOTICES.md` and `third_party/*/LICENSE` in the distribution');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/** Occurrence rows for spreadsheets. */
export function toCsv(jobs) {
  const rows = [['job', 'zone', 'instant_utc', 'local_wall_clock', 'offset']];
  for (const job of jobs) {
    for (const occ of job.timeline) {
      rows.push([job.name, job.tz, occ.iso, occ.local, occ.offset]);
    }
  }
  return `${rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')}\n`;
}

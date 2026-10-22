#!/usr/bin/env node
/**
 * CLI.
 *
 * Exit codes are part of the contract, because this is meant to run in CI next
 * to the crontab it audits:
 *
 *   0  nothing at or above the --fail-on level
 *   2  usage / input error
 *   3  findings at or above the --fail-on level
 *   4  unexpected internal error
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  audit,
  explain,
  auditJob,
  resolveWindow,
  toMarkdown,
  toCsv,
  toIcs,
  toSystemd,
  toRRule,
  parseExpression,
  VERSION,
  TOOL_NAME,
  UPSTREAMS,
  SEVERITY_ORDER,
} from './index.js';

const EXIT = { OK: 0, USAGE: 2, FINDINGS: 3, INTERNAL: 4 };

const HELP = `cronoscope ${VERSION} — audit cron schedules against the wall clock

Usage
  cronoscope audit <jobs.json> [options]
  cronoscope explain <expression> [--tz <zone>] [--lang en|zh_CN|both]
  cronoscope next <expression> [--tz <zone>] [--count <n>]
  cronoscope convert <expression> [--tz <zone>]
  cronoscope version

audit options
  --from <date>            window start (YYYY-MM-DD reads as a whole day in --tz)
  --to <date>              window end
  --tz <zone>              default zone for jobs that do not declare one
  --format <fmt>           text | md | json | csv | ics      (default: text)
  --out <file>             write the report instead of stdout
  --fail-on <level>        error | warn | info | none          (default: error)
  --max-occurrences <n>    per-job expansion budget            (default: 5000)
  --mode <mode>            auto | full | sample                 (default: auto)
  --threshold <n>          concurrent jobs that count as a collision (default: 2)

Exit codes: 0 clean, 2 usage, 3 findings, 4 internal
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function fail(message, code = EXIT.USAGE) {
  process.stderr.write(`cronoscope: ${message}\n`);
  process.exit(code);
}

function loadJobs(fileOrJson) {
  const text = fileOrJson.trim().startsWith('{') || fileOrJson.trim().startsWith('[')
    ? fileOrJson
    : readFileSync(resolve(process.cwd(), fileOrJson), 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fail(`cannot parse jobs JSON: ${err.message}`);
  }
  const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) fail('jobs file must be an array or { "jobs": [...] }');
  return jobs;
}

function sevLabel(severity) {
  return severity === 'error' ? 'ERROR' : severity === 'warn' ? ' WARN' : ' note';
}

function renderText(report) {
  const out = [];
  const { meta, jobs, conflicts, summary } = report;
  out.push(`${TOOL_NAME} ${VERSION}  ·  cron-parser ${UPSTREAMS['cron-parser']}  ·  cRonstrue ${UPSTREAMS.cronstrue}  ·  luxon ${UPSTREAMS.luxon}`);
  out.push(`window ${meta.window.fromIso} → ${meta.window.toIso}  (${meta.window.days} days in ${meta.window.windowTz})`);
  out.push('');
  for (const job of jobs) {
    const errs = job.findings.filter((f) => f.severity === 'error').length;
    const warns = job.findings.filter((f) => f.severity === 'warn').length;
    const mark = errs > 0 ? '✗' : warns > 0 ? '!' : '✓';
    out.push(`${mark} ${job.name}  [${job.tz}]  ${job.expression}`);
    out.push(`   ${job.description.en.ok ? job.description.en.text : `(no description: ${job.description.en.error})`}`);
    if (job.description.zh_CN.ok) out.push(`   ${job.description.zh_CN.text}`);
    out.push(
      `   ${job.stats.occurrences} occurrence(s)${job.coverage.mode === 'sampled' ? ' — sampled' : ''}`
      + `${job.stats.typicalDeltaSeconds ? `, typical interval ${job.stats.typicalDeltaSeconds}s` : ''}`
      + `${job.coverage.estimate ? `, nominal demand ~${job.coverage.estimate.total}` : ''}`,
    );
    for (const f of job.findings) {
      out.push(`   [${sevLabel(f.severity)}] ${f.code}: ${f.title}`);
      if (f.severity !== 'info') out.push(`           ${f.detail}`);
    }
    out.push('');
  }
  if (jobs.length > 1) {
    out.push(`collisions: ${conflicts.sameInstantTotal} exact instant(s), ${conflicts.windows.length} overlap window(s)`);
    for (const c of conflicts.sameInstant.slice(0, 5)) out.push(`   ${c.at}  ${c.jobs.join(' + ')}`);
    out.push('');
  }
  out.push(`summary: ${summary.errors} error(s), ${summary.warnings} warning(s), ${summary.infos} note(s)`);
  return `${out.join('\n')}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(HELP);
    return EXIT.OK;
  }
  const command = argv[0];
  const { flags, positional } = parseArgs(argv.slice(1));

  if (command === 'version' || flags.version) {
    process.stdout.write(`${TOOL_NAME} ${VERSION}\n`);
    return EXIT.OK;
  }

  if (command === 'explain') {
    const expression = positional[0];
    if (!expression) fail('explain needs a cron expression');
    const tz = typeof flags.tz === 'string' ? flags.tz : 'UTC';
    const lang = typeof flags.lang === 'string' ? flags.lang : 'both';
    const detail = explain(expression, { tz, count: Number(flags.count ?? 5) });
    if (lang === 'json' || flags.json) {
      process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`);
      return EXIT.OK;
    }
    const lines = [];
    lines.push(`expression   ${expression}`);
    lines.push(`zone         ${tz}`);
    lines.push(`fields       ${detail.model.arity ?? '?'} (engine normalises to "${detail.model.normalized}")`);
    if (detail.model.arityShift) lines.push(`warning      ${detail.model.arityShift} field(s) were left-padded with "*" by the engine`);
    if (lang !== 'zh_CN') lines.push(`en           ${detail.description.en.ok ? detail.description.en.text : `error: ${detail.description.en.error}`}`);
    if (lang !== 'en') lines.push(`zh_CN        ${detail.description.zh_CN.ok ? detail.description.zh_CN.text : `error: ${detail.description.zh_CN.error}`}`);
    if (detail.engineError) lines.push(`engine       ${detail.engineError}`);
    const model = parseExpression(expression);
    const systemd = toSystemd(model);
    const rrule = toRRule(model);
    lines.push(`systemd      ${systemd.supported ? systemd.value : `unsupported — ${systemd.reason}`}`);
    lines.push(`rrule        ${rrule.supported ? rrule.value : `unsupported — ${rrule.reason}`}`);
    lines.push('next:');
    for (const occ of detail.next) lines.push(`  ${occ.local}   ${occ.iso}`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return EXIT.OK;
  }

  if (command === 'next') {
    const expression = positional[0];
    if (!expression) fail('next needs a cron expression');
    const tz = typeof flags.tz === 'string' ? flags.tz : 'UTC';
    const detail = explain(expression, { tz, count: Number(flags.count ?? 5) });
    if (detail.engineError && detail.next.length === 0) fail(detail.engineError);
    process.stdout.write(`${detail.next.map((o) => `${o.local}  ${o.iso}`).join('\n')}\n`);
    return EXIT.OK;
  }

  if (command === 'convert') {
    const expression = positional[0];
    if (!expression) fail('convert needs a cron expression');
    const model = parseExpression(expression);
    if (!model.ok) fail(`expression is not valid: ${(model.errors || []).join('; ')}`);
    const systemd = toSystemd(model);
    const rrule = toRRule(model);
    const jobReport = {
      name: expression,
      expression,
      tz: typeof flags.tz === 'string' ? flags.tz : 'UTC',
      timeline: [],
      description: { en: { text: '' } },
    };
    if (!rrule.supported) {
      process.stdout.write(`${JSON.stringify({ systemd, rrule, reason: rrule.reason }, null, 2)}\n`);
      return EXIT.OK;
    }
    const ics = toIcs(jobReport, { nowMs: Date.now() });
    process.stdout.write(`${JSON.stringify({ systemd, rrule, ics: ics.text }, null, 2)}\n`);
    return EXIT.OK;
  }

  if (command === 'audit') {
    const target = positional[0];
    if (!target) fail('audit needs a jobs file');
    const jobs = loadJobs(target);
    const tz = typeof flags.tz === 'string' ? flags.tz : jobs.find((j) => j.tz)?.tz ?? 'UTC';
    const from = flags.from ?? '2026-01-01';
    const to = flags.to ?? '2026-12-31';
    let report;
    try {
      report = audit(jobs, {
        from,
        to,
        windowTz: tz,
        maxOccurrences: flags['max-occurrences'] ? Number(flags['max-occurrences']) : undefined,
        mode: typeof flags.mode === 'string' ? flags.mode : undefined,
        threshold: flags.threshold ? Number(flags.threshold) : undefined,
      });
    } catch (err) {
      fail(err.message);
    }

    const format = typeof flags.format === 'string' ? flags.format : 'text';
    let payload;
    if (format === 'md') payload = toMarkdown(report);
    else if (format === 'json') payload = `${JSON.stringify(report, null, 2)}\n`;
    else if (format === 'csv') payload = toCsv(report.jobs);
    else if (format === 'ics') {
      payload = report.jobs.map((job) => toIcs(job).text).join('\r\n');
    } else if (format === 'text') payload = renderText(report);
    else fail(`unknown --format "${format}"`);

    if (typeof flags.out === 'string') {
      writeFileSync(resolve(process.cwd(), flags.out), payload, 'utf8');
      process.stdout.write(`wrote ${flags.out} (${payload.length} bytes)\n`);
    } else {
      process.stdout.write(payload);
    }

    const failOn = typeof flags['fail-on'] === 'string' ? flags['fail-on'] : 'error';
    if (failOn === 'none') return EXIT.OK;
    const limit = SEVERITY_ORDER[failOn];
    if (limit === undefined) fail(`unknown --fail-on level "${failOn}"`);
    const hit = report.jobs.some((job) => job.findings.some((f) => SEVERITY_ORDER[f.severity] <= limit));
    return hit ? EXIT.FINDINGS : EXIT.OK;
  }

  if (command === 'job') {
    // audit a single expression without a jobs file — handy in a pipeline
    const expression = positional[0];
    if (!expression) fail('job needs a cron expression');
    const tz = typeof flags.tz === 'string' ? flags.tz : 'UTC';
    const { fromMs, toMs } = resolveWindow({ from: flags.from ?? '2026-01-01', to: flags.to ?? '2026-12-31', windowTz: tz });
    const report = auditJob(
      { name: expression, expression, tz, slaMaxGapSeconds: flags.sla ? Number(flags.sla) : undefined },
      { fromMs, toMs },
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.findings.some((f) => f.severity === 'error') ? EXIT.FINDINGS : EXIT.OK;
  }

  fail(`unknown command "${command}" — try "cronoscope help"`);
  return EXIT.USAGE;
}

try {
  process.exit(main());
} catch (err) {
  process.stderr.write(`cronoscope: unexpected failure: ${err?.stack ?? err}\n`);
  process.exit(EXIT.INTERNAL);
}

/**
 * Browser UI.
 *
 * The page is a thin renderer over the same `audit()` call the CLI uses, so
 * whatever shows up here is what the CLI and the tests see. Anything that is
 * not DOM work lives in exported functions and is exercised by the test suite.
 */
import {
  audit,
  explain,
  parseExpression,
  toSystemd,
  toRRule,
  toMarkdown,
  VERSION,
  UPSTREAMS,
} from '../src/index.js';

export const ZONES = [
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Moscow',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Australia/Sydney',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'Pacific/Auckland',
];

export const PRESET_JOBS = [
  { name: 'nightly-backup', expression: '30 2 * * *', tz: 'America/New_York', durationSeconds: 900 },
  { name: 'cache-warm', expression: '0 2 * * *', tz: 'America/New_York', durationSeconds: 600 },
  { name: 'quarter-hour-metrics', expression: '*/15 * * * *', tz: 'America/New_York', durationSeconds: 30 },
  { name: 'london-settlement', expression: '45 1 * * *', tz: 'Europe/London', durationSeconds: 120 },
  { name: 'typo-four-fields', expression: '0 3 * *', tz: 'UTC' },
  { name: 'dead-feb-29', expression: '0 0 29 2 *', tz: 'UTC' },
];

const pad = (n) => String(n).padStart(2, '0');

/** Convert the audit report into the strings the page prints. */
export function buildViewModel(report, selectedIndex) {
  const job = report.jobs[selectedIndex] ?? report.jobs[0];
  const model = parseExpression(job.expression);
  const systemd = toSystemd(model);
  const rrule = toRRule(model);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of job.findings) counts[f.severity] += 1;

  return {
    job,
    badges: [
      `${job.model.arity ?? '?'} fields`,
      job.model.enumerable ? 'enumerable' : 'not enumerable',
      job.tz,
      job.coverage.mode === 'sampled' ? 'sampled coverage' : 'full coverage',
      `${job.stats.occurrences} occurrence(s)`,
      job.stats.typicalDeltaSeconds ? `~${job.stats.typicalDeltaSeconds}s interval` : 'irregular interval',
    ],
    counts,
    verdict: counts.error > 0 ? 'needs fixing' : counts.warn > 0 ? 'review' : 'clean',
    systemd: systemd.supported ? systemd.value : `unsupported — ${systemd.reason}`,
    rrule: rrule.supported ? rrule.value : `unsupported — ${rrule.reason}`,
    collisions: report.conflicts,
  };
}

/** Run an audit over the given jobs and return both report and view model. */
export function runAudit(jobs, { from, to, windowTz = 'UTC', maxOccurrences = 3000, selectedIndex = 0 } = {}) {
  const report = audit(jobs, { from, to, windowTz, maxOccurrences });
  return { report, view: buildViewModel(report, selectedIndex) };
}

// --------------------------------------------------------------------- DOM

const esc = (text) =>
  String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function escapeHtmlBlock(text) {
  return esc(text);
}

export function renderJobList(jobs, selectedIndex) {
  return jobs
    .map((job, index) => {
      const zones = ZONES.includes(job.tz) ? ZONES : [job.tz, ...ZONES];
      return `
    <div class="job" data-index="${index}" aria-current="${index === selectedIndex}" tabindex="0">
      <div class="row">
        <input class="name" data-field="name" data-index="${index}" value="${esc(job.name)}" aria-label="job name" />
        <button class="ghost" data-remove="${index}" type="button" aria-label="remove job">×</button>
      </div>
      <div class="row" style="margin-top:6px">
        <input type="text" class="expr" data-field="expression" data-index="${index}" value="${esc(job.expression)}" aria-label="cron expression" spellcheck="false" />
      </div>
      <div class="row" style="margin-top:6px">
        <select data-field="tz" data-index="${index}" aria-label="zone">
          ${zones.map((z) => `<option value="${esc(z)}"${z === job.tz ? ' selected' : ''}>${esc(z)}</option>`).join('')}
        </select>
        <input data-field="durationSeconds" data-index="${index}" value="${job.durationSeconds ?? 0}" style="width:88px" aria-label="duration seconds" />
        <span class="chip">duration s</span>
      </div>
    </div>`;
    })
    .join('');
}

export function renderReport(view) {
  const { job, badges, counts, verdict, systemd, rrule, collisions } = view;
  const findings = job.findings.length === 0
    ? '<p class="empty">表达式与真实触发瞬间完全一致，没有发现偏差。</p>'
    : job.findings
      .map(
        (f) => `
      <div class="finding ${f.severity}">
        <h3>${esc(f.title)} <code>${esc(f.code)}</code></h3>
        <p>${esc(f.detail)}</p>
        ${
          f.evidence && Object.keys(f.evidence).length
            ? `<details><summary>证据</summary><pre>${escapeHtmlBlock(JSON.stringify(f.evidence, null, 2))}</pre></details>`
            : ''
        }
      </div>`,
      )
      .join('');

  const transitions = job.transitions.length
    ? `<table>
        <thead><tr><th>instant (UTC)</th><th>dir</th><th>delta</th><th>local before</th><th>local after</th></tr></thead>
        <tbody>${job.transitions
          .map((t) => `<tr><td>${esc(t.at)}</td><td>${esc(t.direction)}</td><td>${t.deltaMinutes}m</td><td>${esc(t.localBefore)}</td><td>${esc(t.localAfter)}</td></tr>`)
          .join('')}</tbody>
      </table>`
    : '<p class="empty">窗口内该时区没有偏移变化。</p>';

  const timeline = job.timeline.length
    ? `<table>
        <thead><tr><th>#</th><th>local wall clock</th><th>UTC</th></tr></thead>
        <tbody>${job.timeline
          .slice(0, 12)
          .map((o, i) => `<tr><td>${i + 1}</td><td>${esc(o.local)}</td><td>${esc(o.iso)}</td></tr>`)
          .join('')}</tbody>
      </table>`
    : '<p class="empty">窗口内没有触发。</p>';

  const collisionRows = collisions?.sameInstant?.length
    ? `<table><thead><tr><th>instant</th><th>jobs</th></tr></thead><tbody>${collisions.sameInstant
      .slice(0, 10)
      .map((c) => `<tr><td>${esc(c.at)}</td><td>${esc(c.jobs.join(' + '))}</td></tr>`)
      .join('')}</tbody></table>`
    : '<p class="empty">窗口内没有两个任务撞在同一瞬间。</p>';

  return `
    <div class="meta">
      ${badges.map((b) => `<span class="chip">${esc(b)}</span>`).join('')}
      <span class="chip ${counts.error ? 'err' : counts.warn ? 'warn' : 'ok'}">${esc(verdict)}</span>
    </div>
    <div class="desc">
      ${esc(job.description.en.text ?? `(${job.description.en.error})`)}
      <div class="zh">${esc(job.description.zh_CN.text ?? `(${job.description.zh_CN.error})`)}</div>
    </div>
    <div class="cols" style="margin-top:10px">
      <div><div class="chip">systemd</div><pre>OnCalendar=${esc(systemd)}</pre></div>
      <div><div class="chip">RRULE</div><pre>${esc(rrule)}</pre></div>
    </div>
    <h3 style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:16px 0 4px">Findings</h3>
    ${findings}
    <h3 style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:16px 0 4px">Offset changes</h3>
    ${transitions}
    <h3 style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:16px 0 4px">First occurrences</h3>
    ${timeline}
    <h3 style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:16px 0 4px">Cross-job collisions</h3>
    ${collisionRows}
  `;
}

function mount() {
  const state = {
    jobs: PRESET_JOBS.map((j) => ({ ...j })),
    selected: 0,
    report: null,
    error: null,
  };

  const jobsHost = document.getElementById('jobs');
  const reportHost = document.getElementById('report');
  const fromInput = document.getElementById('from');
  const toInput = document.getElementById('to');
  const versions = document.getElementById('versions');

  versions.innerHTML = `v${VERSION}<br>cron-parser ${UPSTREAMS['cron-parser']} · cRonstrue ${UPSTREAMS.cronstrue} · luxon ${UPSTREAMS.luxon}`;

  // Deep links: ?job=<index>&from=<date>&to=<date>. Used by the screenshot
  // script so the documentation images are reproducible states of the real
  // page rather than hand-assembled mock-ups.
  const params = new URLSearchParams(window.location.search);
  if (params.has('from')) fromInput.value = params.get('from');
  if (params.has('to')) toInput.value = params.get('to');
  if (params.has('job')) {
    const wanted = Number(params.get('job'));
    if (Number.isInteger(wanted) && wanted >= 0 && wanted < state.jobs.length) state.selected = wanted;
  }

  const windowTz = () => state.jobs[state.selected]?.tz || 'UTC';

  function draw() {
    jobsHost.innerHTML = renderJobList(state.jobs, state.selected);
    if (state.error) {
      reportHost.innerHTML = `<div class="finding error"><h3>无法审计</h3><p>${esc(state.error)}</p></div>`;
      return;
    }
    if (!state.report) return;
    const view = buildViewModel(state.report, state.selected);
    reportHost.innerHTML = renderReport(view);
  }

  function run() {
    state.error = null;
    try {
      state.report = audit(state.jobs, {
        from: fromInput.value,
        to: toInput.value,
        windowTz: windowTz(),
        maxOccurrences: 3000,
      });
    } catch (err) {
      state.report = null;
      state.error = err?.message ?? String(err);
    }
    draw();
  }

  jobsHost.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      const index = Number(remove.dataset.remove);
      if (state.jobs.length > 1) {
        state.jobs.splice(index, 1);
        state.selected = Math.min(state.selected, state.jobs.length - 1);
        run();
      }
      return;
    }
    const card = event.target.closest('.job');
    if (card && !event.target.closest('input, select, button')) {
      state.selected = Number(card.dataset.index);
      draw();
    }
  });

  jobsHost.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('input[data-field]')) {
      commit(event.target);
    }
  });

  function commit(input) {
    const index = Number(input.dataset.index);
    const field = input.dataset.field;
    if (!state.jobs[index] || !field) return;
    state.jobs[index][field] = field === 'durationSeconds' ? Number(input.value) || 0 : input.value;
    run();
  }

  jobsHost.addEventListener('change', (event) => {
    const target = event.target;
    if (target.matches('select, input[data-field]')) {
      if (target.matches('select')) {
        state.selected = Number(target.dataset.index);
      }
      commit(target);
    }
  });

  document.getElementById('run').addEventListener('click', run);
  document.getElementById('add').addEventListener('click', () => {
    state.jobs.push({ name: `job-${state.jobs.length + 1}`, expression: '0 4 * * *', tz: windowTz(), durationSeconds: 0 });
    state.selected = state.jobs.length - 1;
    run();
  });
  document.getElementById('preset').addEventListener('click', () => {
    state.jobs = PRESET_JOBS.map((j) => ({ ...j }));
    state.selected = 0;
    run();
  });

  run();

  // Expose a tiny debug hook so a headless check can read the current report.
  window.__cronoscope = {
    get report() {
      return state.report;
    },
    get selected() {
      return state.selected;
    },
    run,
    markdown: () => (state.report ? toMarkdown(state.report) : ''),
    explain: (expression, tz) => explain(expression, { tz }),
  };
}

if (typeof document !== 'undefined' && document.getElementById('jobs')) mount();

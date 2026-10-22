/**
 * Benchmark the two costs that decide the architecture:
 * how fast the engine can expand occurrences, and how fast a full audit runs.
 *
 * Numbers printed here are the ones quoted in README.md and docs/FINDINGS.md.
 * They are single-run wall-clock measurements on one machine; treat them as an
 * order of magnitude, not a spec.
 */
import { cpus, totalmem } from 'node:os';
import { audit, expandOccurrences, resolveWallClock } from '../src/index.js';

const now = (fn) => {
  const t0 = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, value };
};

const year = {
  fromMs: Date.parse('2026-01-01T00:00:00Z'),
  toMs: Date.parse('2026-12-31T23:59:59Z'),
};

console.log(`node ${process.version} · ${cpus()[0].model.trim()} · ${cpus().length} threads · ${(totalmem() / 2 ** 30).toFixed(1)} GiB`);
console.log('');

// 1. raw expansion throughput
const dense = now(() =>
  expandOccurrences({ expression: '* * * * *', tz: 'America/New_York', ...year, limit: 600000 }),
);
const denseCount = dense.value.occurrences.length;
console.log(
  `expand "* * * * *" for a year      ${dense.ms.toFixed(0)} ms  ${denseCount} occurrences  `
  + `${(denseCount / (dense.ms / 1000)).toFixed(0)}/s  ${(dense.ms / denseCount * 1000).toFixed(0)} µs each`,
);

const daily = now(() =>
  expandOccurrences({ expression: '30 2 * * *', tz: 'America/New_York', ...year, limit: 1000 }),
);
console.log(`expand "30 2 * * *" for a year     ${daily.ms.toFixed(1)} ms  ${daily.value.occurrences.length} occurrences`);

// 2. wall-clock resolution throughput (the slot classifier calls this per slot)
const wall = now(() => {
  let n = 0;
  for (let day = 0; day < 365; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      resolveWallClock('America/New_York', { year: 2026, month: 3, day: 1 + (day % 28), hour, minute: 30 });
      n += 1;
    }
  }
  return n;
});
console.log(`resolve 8760 wall-clock readings  ${wall.ms.toFixed(0)} ms  ${(wall.ms / wall.value * 1000).toFixed(1)} µs each`);

// 3. whole audits
const one = now(() =>
  audit([{ name: 'nightly', expression: '30 2 * * *', tz: 'America/New_York' }], {
    from: '2026-03-01',
    to: '2026-03-31',
    windowTz: 'America/New_York',
  }),
);
console.log(`audit 1 daily job, 1 month        ${one.ms.toFixed(0)} ms`);

const many = now(() =>
  audit(
    [
      { name: 'a', expression: '30 2 * * *', tz: 'America/New_York', durationSeconds: 900 },
      { name: 'b', expression: '0 2 * * *', tz: 'America/New_York', durationSeconds: 600 },
      { name: 'c', expression: '*/15 * * * *', tz: 'America/New_York', durationSeconds: 30 },
      { name: 'd', expression: '45 1 * * *', tz: 'Europe/London', durationSeconds: 120 },
      { name: 'e', expression: '0 3 * *', tz: 'UTC' },
      { name: 'f', expression: '0 6 1 * *', tz: 'Asia/Shanghai', durationSeconds: 300 },
      { name: 'g', expression: '0 23 L * *', tz: 'Asia/Shanghai' },
      { name: 'h', expression: '0 9 * * 1#1', tz: 'Europe/Berlin' },
      { name: 'i', expression: '0 0 29 2 *', tz: 'UTC' },
      { name: 'j', expression: '* * * * *', tz: 'America/New_York', durationSeconds: 5 },
    ],
    { from: '2026-03-01', to: '2026-03-31', windowTz: 'America/New_York', maxOccurrences: 3000 },
  ),
);
console.log(`audit 10 mixed jobs, 1 month      ${many.ms.toFixed(0)} ms  (${many.value.summary.occurrences} occurrences, ${many.value.conflicts.sameInstantTotal} collisions)`);

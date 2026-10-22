# What the upstreams actually do

Everything below was measured in this repository against the installed packages,
not read off a README or a star count. Each row names the probe; the probe is
either a command you can re-run or a test that pins the behaviour.

Environment: Node v22.22.2, Windows 11, `cron-parser@5.10.2`,
`cronstrue@3.38.0`, `luxon@3.7.2`, tz database as bundled with the runtime.

| # | Upstream claim | What it does | Probe |
|---|---|---|---|
| 1 | cron-parser: "DST handling" | True, but it branches on the shape of the expression (see 1a–1c) | `test/audit.test.js` |
| 1a | — | Fixed readings inside a 60-minute spring-forward gap are **shifted**: `30 2 * * *` in `America/New_York` fires at `03:30 -04:00` on 2026-03-08 | audit of `30 2 * * *` |
| 1b | — | Grids simply **skip** the gap: `*/30 * * * *` goes 01:30 EST → 03:00 EDT, no firing at all for 02:00/02:30 | audit of `*/30 * * * *` |
| 1c | — | A 30-minute gap **drops** the fixed reading: `15 2 * * *` in `Australia/Lord_Howe` jumps from 2026-10-03 to 2026-10-05 | audit of `15 2 * * *` |
| 2 | cron-parser: rejects invalid crontabs | Not for arity. A 4-field input is **left-padded with `*`**: `0 3 * *` behaves exactly like `* 0 3 * *`, so the first number becomes the hour. Verified by comparing the occurrence lists of the two strings (identical) and by `interval.stringify()` | `test/expression.test.js`, `test/audit.test.js` |
| 3 | cron-parser: timezone support | True. `?` is an alias for `*`, `0` and `7` are both Sunday, day-of-month and day-of-week are **OR**ed when both are restricted (`0 0 1 * 1` fires on the 1st *and* every Monday) | `test/expression.test.js` |
| 4 | cron-parser: `H` macro | True. `H * * * *` stringifies to a concrete minute (`49` with the default seed) | `test/expression.test.js` |
| 5 | cronstrue: 5, 6 or 7 parts | True, and the boundaries are the **opposite** of the engine: it rejects the 4-part expression the engine silently accepts, and accepts the 7-part expression the engine rejects | `test/describe.test.js` |
| 6 | cronstrue: "zero dependencies" | True (`dependencies: {}` in its package manifest) | `scripts/collect-licenses.mjs` output |
| 7 | cronstrue: error handling | It throws **strings**, not `Error` objects. `err.message` is `undefined`; the message is the thrown value itself | `test/describe.test.js` |
| 8 | cronstrue: supports `W`, `L-n` | It *describes* `15W` and `L-3` correctly, but cron-parser **rejects both** (`Invalid characters, got value: 15W`, `Constraint error … NaN-3`). A schedule the describer explains happily cannot run | `test/audit.test.js` (engines.disagree) |
| 9 | luxon: IANA data | True for the zones under test, including 30-minute (`Australia/Lord_Howe`) and 45-minute (`Pacific/Chatham`) base offsets | `test/wallclock.test.js` |

## Measured cost

`node scripts/bench.mjs`, single run, Ryzen 7 255H, Node 22.22.2:

| operation | result |
|---|---|
| expand `* * * * *` over a year (`America/New_York`) | 525,600 occurrences in **80.1 s** → 6,560/s → ~152 µs each |
| expand `30 2 * * *` over a year | 365 occurrences in **171.7 ms** (~0.47 ms each) |
| `resolveWallClock` | 8,760 readings in **632 ms** → ~72 µs each |
| audit 1 daily job, 1 month | **44 ms** |
| audit 10 mixed jobs, 1 month | **1.4 s** (4,929 occurrences, 216 collisions) |

An earlier run of the same first benchmark gave 60.2 s / 115 µs, so treat the
throughput as ~6–9 k occurrences/s on this class of machine, not a constant.
The number that matters for the design is the order of magnitude: a year of
every-minute expansion is a minute of wall time, which is why the audit budgets
occurrences and samples around offset changes instead (see
`docs/ARCHITECTURE.md`, "coverage budgeting").

## Is the second look worth it?

Yes, for a specific reason rather than a general one. Both libraries are good at
what they claim, and their claims do not overlap:

* cron-parser answers **"which instants fire"** and has no opinion about how to
  say it.
* cRonstrue answers **"what does this mean in words"** and never enumerates an
  instant.

Neither answers the question an operator actually has — *"is the thing I wrote
the thing that runs, in the zone it runs in?"* That question needs both answers
plus the wall clock, and the disagreements found above (1a–1c, 2, 5, 8) are
exactly the cases where the three views split. That split is the product.

The integration is therefore real work, not a wrapper: a nominal field model,
a wall-clock resolver that classifies readings as unique/ambiguous/nonexistent,
a slot-by-slot diff against the engine, and formats that refuse to mistranslate
(see `docs/LIMITS.md` for where they refuse).

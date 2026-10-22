# Known limits

Written down rather than hidden, because a scheduling tool that overstates
itself is worse than no tool.

## The audit cannot be faster than the engine

`docs/FINDINGS.md` records the measurement: expanding a year of `* * * * *`
through cron-parser takes ~80 s on this machine. The audit therefore budgets
occurrences (`--max-occurrences`, default 5000) and, when the nominal demand
exceeds it, samples: one baseline day plus ±3 h around every offset change.
The report marks such jobs `sampled`, prints the reason, and lists the windows.
A sampled job's cadence statistics only cover the sampled spans — a gap in the
unsampled part of the month will not be reported.

## What is not modelled

* **The year field.** Seven-field expressions are accepted by cRonstrue and
  rejected by cron-parser; the tool reports the disagreement and does not model
  a year field.
* **`W` (nearest weekday) and `L-n`.** Both are described by cRonstrue and
  rejected by cron-parser. The tool reproduces that disagreement as a finding;
  it does not implement the semantics.
* **`H` (hashed) values.** The minute is derived from a hash seed, so the
  reading is not recoverable from the text. Slot checks are skipped; the
  timeline is still real.
* **Quartz-specific semantics.** `dayOfWeekStartIndexZero`, `monthStartIndexZero`
  and the Quartz year field are not configurable here. The audit uses Vixie
  conventions (0 and 7 are Sunday, months 1–12) and cRonstrue is called with
  matching options.
* **Sub-minute RRULE.** Refused, with a reason, instead of emitted wrongly.

## Where the three targets disagree with cron

| aspect | cron | systemd | RFC 5545 |
|---|---|---|---|
| dom + dow both restricted | OR | AND | AND |
| `L` (last day) | yes | no | `BYMONTHDAY=-1` |
| `#` (nth weekday) | yes | no | `BYDAY=1MO` |
| seconds | sometimes | yes | yes, but clients vary |

The exporters encode exactly this table and refuse the first row.

## iCalendar specifics

`DTSTART` is written as a **floating** local time (no `Z`, no `TZID`). That is
the representation closest to cron's semantics: a calendar client re-resolves a
floating time against its own zone, so the schedule keeps following the wall
clock. A UTC `DTSTART` would freeze the schedule to one offset for half the year
— which is the bug the tool exists to find. The trade-off: a client that treats
floating times as UTC will shift everything by its own offset.

No `VTIMEZONE` block is emitted. Generating a correct one requires shipping tz
data, and a wrong one is worse than none.

## Verification limits of this build

* `scripts/verify-demo.mjs` drives **three deep-linked states** of the real page
  in headless Chrome/Edge and checks the **DOM text** it produces. That is a
  functional check, not a visual one.
* The three README screenshots are captured from those same states by
  `npm run docs:images` and measured numerically (`scripts/png-stats.mjs`:
  size, distinct colours, mean luminance, per-band spread; re-asserted by
  `test/images.test.js`). This proves the frames are real, dark, non-blank and
  not half-rendered. It does **not** prove they look good: this machine's
  image-reading tool cannot accept an image, so nobody — human or model — has
  looked at them.
* The benchmarks in `docs/FINDINGS.md` are single-run wall-clock measurements on
  one machine with an unknown background load. They are quoted to justify an
  architectural decision, not as a performance guarantee.
* Time zone behaviour depends on the tz database bundled with the Node/ICU build
  in use. A runtime with an outdated tz database will disagree with this
  repository's test expectations — the tests are the check for that.

## What the tool does not do

* It does not read a crontab file from a host, nor connect to a scheduler. Input
  is a JSON job list; output is a report.
* It does not measure whether jobs actually ran. There is no execution history,
  no log parsing, no alerting. Overlaps are computed from declared durations,
  not observed ones.
* It does not rewrite crontabs. `convert` prints a target representation; the
  user decides whether to apply it.
* It does not detect that an expression is *semantically* what the author
  wanted — only that the three views agree. `0 0 * * *` at 04:00 because someone
  meant `0 4 * * *` is a human problem, not a divergence.

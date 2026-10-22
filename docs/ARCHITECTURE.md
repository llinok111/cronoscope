# Architecture

## One sentence

Three views of the same schedule — what was written, what fires, what it is
called — are built independently and then diffed; every reported item is a
divergence between two of them, with the instants that prove it.

```
                     expression text
                            │
        ┌───────────────────┼────────────────────┐
        │                   │                    │
   nominal model      execution oracle     description
 (src/expression.js)   (src/expand.js)     (src/describe.js)
        │                   │                    │
        │  wall-clock       │  instants          │  English / 中文
        │  readings         │                    │
        └──────────┬────────┴────────┬───────────┘
                   │                 │
             wall clock          diff (src/audit.js)
        (src/wallclock.js)             │
                   │                  ▼
                   └────────────► findings + evidence
                                       │
                     ┌─────────────────┼──────────────────┐
                     ▼                 ▼                  ▼
              markdown / json     csv / ics         systemd / rrule
```

## Why three views and not one

A single library cannot answer "did I write what I meant", because it is the
thing deciding what "meant" is. Splitting the question lets the tool be wrong in
a *detectable* way: if the model and the engine disagree, one of them is wrong
and the report says which reading is in dispute. That is why
`docs/FINDINGS.md` can list concrete divergences instead of asserting
correctness.

The nominal model is a second implementation of cron field parsing. This is
deliberate duplication: an independent implementation is the only way to detect
that the engine's reading of an expression differs from the text. It is kept
small (approximately 250 lines) and is never used to decide firing times.

## Modules

| module | responsibility | does not |
|---|---|---|
| `src/wallclock.js` | classify a wall-clock reading in a zone (`unique` / `ambiguous` / `nonexistent`), enumerate candidate instants, find offset transitions to the exact instant | know anything about cron |
| `src/expression.js` | parse fields into value sets + structural flags (`L`, `#`, `nL`, `H`, `?`), reproduce the engine's left-padding, decide which calendar days match | decide instants |
| `src/describe.js` | call cRonstrue in `en` and `zh_CN`, normalise its string throws | validate a schedule |
| `src/expand.js` | wrap cron-parser: inclusive window, hard occurrence budget, `truncated` flag | interpret the expression |
| `src/audit.js` | the diff: slot-by-slot classification, cadence statistics, finding aggregation, coverage budgeting | render anything |
| `src/conflicts.js` | sweep-line over job intervals for same-instant collisions and overlap windows | guess a duration |
| `src/export.js` | systemd / RRULE / iCalendar / Markdown / CSV, each with a `supported: false` path | mistranslate silently |
| `src/cli.js` | argument parsing, exit-code contract | compute |
| `demo/app.js` | render the same `audit()` result in a browser | duplicate logic |

## Data flow for one job

1. `parseExpression` produces the nominal model. A 4-field expression is padded
   the way the engine pads it, so the model describes what will *run*, and the
   `arity.short` finding explains the shift.
2. `describeBoth` produces the two descriptions. Failures are values
   (`{ok:false,error}`), never exceptions.
3. `estimateOccurrences` counts the readings the model asks for. Edge days are
   checked against the window so a March window in New York does not count a
   06:00 Shanghai job twice.
4. If the estimate exceeds `maxOccurrences`, coverage switches to sampling:
   one baseline day plus ±3 h around every offset change in the window. The
   reason string is printed in the report.
5. Every reading in coverage is resolved. For each one the classifier asks a
   precise question:
   * `unique` → is that instant in the engine's output?
   * `ambiguous` → how many of the two instants fired, and which one was left?
   * `nonexistent` → did the engine land on one of the two "would-have-been"
     instants **and was that instant not already claimed by a reading that
     exists**? The second half is what separates a genuine shift (a daily 02:30
     pushed to 03:30) from a grid that simply had nothing to do at 02:00.
6. Cadence is measured from the expanded timeline, not from the text: median
   delta, then intervals beyond 1.5× (only for day-regular schedules) and
   breaches of a declared `slaMaxGapSeconds`.
7. Findings are aggregated per code per day, because a dense job can produce
   hundreds of identical divergences and a report that repeats itself is a
   report nobody reads.

## Report schema

`schemaVersion: 1`. Top level: `meta`, `jobs[]`, `conflicts`, `summary`.

A job report carries `model` (arity, normalised form, enumerability),
`description` (both locales), `engine` (ok, error), `transitions`,
`coverage` (mode, reason, windows, estimate), `stats`, `timeline` (first 24),
and `findings[]`. Each finding is
`{code, severity, title, detail, evidence}` and `evidence` is plain JSON that
can be pasted into a ticket.

The full occurrence list is deliberately **not** in the report: it is passed to
the collision pass and then dropped, so a 30-day dense audit stays small enough
to attach.

## Exit codes

| code | meaning |
|---|---|
| 0 | nothing at or above `--fail-on` |
| 2 | usage or input error |
| 3 | findings at or above `--fail-on` (default `error`) |
| 4 | unexpected internal failure |

`--fail-on none` exists so the same command can run in "report only" mode in a
pipeline that is still adopting the tool.

## Deliberate refusals

The exporter refuses rather than approximates:

* `0 0 1 * 1` → no systemd, no RRULE, because cron ORs day-of-month with
  day-of-week and both targets AND them.
* `L`, `#`, `nL` → no systemd (no equivalent); RRULE gets `BYMONTHDAY=-1` and
  `BYDAY=1MO` / `-1FR`, which are exact.
* `*/20 * * * * *` → RRULE refuses sub-minute cadences instead of emitting a
  rule most clients will drop.

Every refusal carries the reason, and the report keeps the original expression
next to it.

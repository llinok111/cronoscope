# Verification log

What was actually executed for this build, in order, with the observed result.
Nothing here is inferred from a README; if a step was not run, it is listed under
"Not done".

## Environment

| item | value |
|---|---|
| OS | Windows 11 (Git Bash, PowerShell 7) |
| Node | v22.22.2 |
| npm | 10.9.7 |
| CPU | AMD Ryzen 7 255H, 16 threads |
| RAM | 15.3 GiB |
| tz database | the one bundled with this Node/ICU build |
| headless browser | Chrome (`C:/Program Files/Google/Chrome/Application/chrome.exe`) |

## Commands and results

```text
$ npm run licenses
collected 3 package licences:
  cron-parser@5.10.2  MIT  1084B
  cronstrue@3.38.0  MIT  1077B
  luxon@3.7.2  MIT  1076B

$ npm test
Test Files  12 passed (12)
Tests       138 passed (138)

$ npm run build:demo
demo/bundle.js  435.0 KB

$ node scripts/verify-demo.mjs
— default (nightly-backup)
ok    page rendered the header
ok    version banner names the engines
ok    job list rendered
ok    all six preset jobs are in the list
ok    a DST finding is on the page
ok    the finding carries measured evidence
ok    a real local instant is on the page
ok    collision section rendered
ok    systemd translation rendered
ok    RRULE translation rendered
    DOM 20897 bytes

— ?job=4 (4-field expression)
ok    the short-expression error is shown
ok    the padded form is named
ok    the engine/describer disagreement is shown
ok    verdict flips to needs fixing
    DOM 20771 bytes

— ?job=5 (dead schedule)
ok    the dead-schedule error is shown
ok    the next real occurrence is named
ok    zero occurrences are reported
ok    verdict flips to needs fixing
    DOM 19086 bytes

demo page verified in headless browser (3 states)

$ npm run docs:images
overview.png           1680×1050  colours=654  luma=28.8  sd=29
  bands: 25.2/20.1  28.3/28.1  30.9/34.3  30.7/31.4
arity-error.png        1680×1050  colours=650  luma=28.9  sd=29.4
  bands: 26.1/23.5  28.9/29.6  29.9/31.2  30.6/32.1
dead-schedule.png      1680×1050  colours=640  luma=25.1  sd=22.3
  bands: 25.7/22.3  27/23.3  26.5/24.8  21/17.7

3 screenshots captured and measured in docs/images/

$ node scripts/bench.mjs
node v22.22.2 · AMD Ryzen 7 255H w/Radeon780M Graphics · 16 threads · 15.3 GiB
expand "* * * * *" for a year      80125 ms  525600 occurrences  6560/s  152 µs each
expand "30 2 * * *" for a year     171.7 ms  365 occurrences
resolve 8760 wall-clock readings  632 ms  72.2 µs each
audit 1 daily job, 1 month        44 ms
audit 10 mixed jobs, 1 month      1406 ms  (4929 occurrences, 216 collisions)
```

`npm run verify` runs the first four steps in order and exits non-zero on the
first failure; the log above is that run.

The CLI exit codes were exercised by `test/cli.test.js` (spawned as a real child
process): `0` clean, `3` when findings meet the threshold, `2` for usage errors,
`4` for an unreadable jobs file.

`examples/report-2026-03.md` is real output, not a mock: it was produced by
`npm run audit:sample` over `examples/jobs.json` for March 2026.

## What the tests pin

138 assertions across 12 files. By area:

| file | pins |
|---|---|
| `test/wallclock.test.js` | unique / ambiguous / nonexistent resolution, exact transition instants, 30-minute DST |
| `test/expression.test.js` | macros, left-padding, ranges/steps/lists/names, `L`/`#`/`nL`/`H`, dom-dow OR semantics, slot enumeration |
| `test/describe.test.js` | both locales, string-throw normalisation, per-engine boundary differences |
| `test/expand.test.js` | inclusive bounds, budgets, truncation, parse failures, next-occurrence probes |
| `test/audit.test.js` | the six measured DST cases, dead schedules, arity, cadence, sampling, SLA, report shape |
| `test/conflicts.test.js` | same-instant collisions across zones, overlap sweep, thresholds, window clamping |
| `test/export.test.js` | systemd/RRULE/ICS/Markdown/CSV, and every refusal path |
| `test/index.test.js` | window resolution, input validation, report shape, `explain()` |
| `test/cli.test.js` | commands, formats, exit codes, error surfaces |
| `test/licenses.test.js` | licence files present, hashes match, notices complete, no dev leakage, no secrets |
| `test/demo.test.js` | the browser view model and render functions (HTML escaping included) |
| `test/images.test.js` | the three screenshots: size, colour count, dark theme, per-band variation |

## How the screenshots are checked

`scripts/png-stats.mjs` is a PNG reader written for this repo (8-bit RGB/RGBA,
non-interlaced). `npm run docs:images` captures each state with headless Chrome,
decodes the file and measures it. A capture fails the script when it is the wrong
size, has fewer than 200 distinct colours, has a luminance spread below 12, is
not dark (mean luma > 120), or has any horizontal quarter with a flat band.
`test/images.test.js` re-asserts the same properties on the committed files.

What this proves: the images are real captures of the rendered page, not blank,
not white, not half-painted. What it does not prove: that they look good. No
human or model has looked at them (see "Not done").

## Deployment

| item | value |
|---|---|
| repository | https://github.com/llinok111/cronoscope (public, MIT) |
| branch / commit | `main` / `c450010` |
| Pages build type | `workflow` (`.github/workflows/pages.yml`, artifact = `demo/`) |
| workflow run | `39838397809` — success |
| live URL | https://llinok111.github.io/cronoscope/ |

Checks against the live site, from this machine:

```text
$ curl -o page.html -w '%{http_code} %{size_download}' https://llinok111.github.io/cronoscope/
200 6711

$ curl -o bundle.js -w '%{http_code} %{size_download}' https://llinok111.github.io/cronoscope/bundle.js
200 445466        # starts with the MIT licence banner for the three upstreams

$ chrome --headless=new --dump-dom https://llinok111.github.io/cronoscope/
21136 bytes of DOM, containing "dst.gap.shifted", "2026-03-08 03:30:00 -04:00"
and "cron-parser 5.10.2"
```

The first workflow run failed, and the reason is worth recording: a new
repository has no Pages site, so `actions/configure-pages` returned `Get Pages
site failed … Not Found`. Creating the site with `build_type=workflow` and
re-dispatching the same workflow fixed it — no code change was involved.

`docs/images/` is not served by the site (the Pages artifact is `demo/` only);
the screenshots exist for the README on GitHub.

## Not done

* **No human visual review of the screenshots.** This machine's image-reading
  tool cannot accept an image (`the selected model cannot receive images`), so
  the three PNGs are verified numerically only.
* **No real scheduler integration.** Nothing was run against systemd, cron, or a
  job runner; the `systemd`/`RRULE` outputs are string translations that are
  unit-tested, not validated by `systemctl` or a calendar client.
* **No multi-machine benchmarking.** All timings are single-run on the machine
  above with unknown background load.

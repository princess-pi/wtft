# Spec 264 — pad the CLI chart to its row limit

**Issue:** [#264](https://github.com/princess-pi/wtft/issues/264) · **Tests:** `tests/wtft-264-pad-rows.test.ts`

## Behaviour

- **The CLI chart always shows its row limit.** A report and `--watch` pass `padRowsTo` equal to
  the effective limit. With fewer intervals than that, the chart gets placeholder rows after the
  last interval row (and after its cache-miss divider, when it has one).
- **A placeholder row** is a dash under the time label and under each shown column, padded to that
  column's width, and nothing in the bar area. A hidden column pair (`--no-cost`, `--no-tokens`)
  gets no dash.
- **The effective limit** is `chartLimit`: `-l` when given, else the session config's `limit`, else
  `CLI_DEFAULT_LIMIT`, 17 (was 100).
- **The Pi widget does not pad** and keeps its own default of 10. Pi caps a string-array widget at
  10 lines; fitting under that is #269.
- **`--json` is unchanged**: it renders no chart.

## Closer

On a session whose tag holds 2 intervals, `wtft -l 5` and `wtft --watch -l 5` render exactly 5
chart rows, `wtft` and `wtft --watch` exactly 17, and the rows past the second carry a dash under
each label and an empty bar area. The seam test checks the rows; the closer is checked by hand on
this host after merge.

# Spec 264 — pad the CLI chart to its row limit

**Issue:** [#264](https://github.com/princess-pi/wtft/issues/264) · **Tests:** `tests/wtft-264-pad-rows.test.ts`

## Behaviour

- **The CLI chart always shows its row limit.** A report and `--watch` pass `padRowsTo` equal to
  the effective limit. With fewer intervals than that, the chart gets placeholder rows after the
  last interval row (and after its cache-miss divider, when it has one).
- **A placeholder row** is a dash under the time label and under each shown column, padded to that
  column's width, and nothing in the bar area. A hidden column pair (`--no-cost`, `--no-tokens`)
  gets no dash.
- **The effective limit** is `chartLimit`: `-l` when given, else the wtft config's `limit`, else
  `CLI_DEFAULT_LIMIT`, 17 (was 100). `--watch` also lets a `wtft-settings` entry in the session log
  override the config, as it did before. `wholeLimit` rounds any of them down to a whole number, at
  least 0, so the slice and the padding agree.
- **`--watch` never grows past the terminal for padding.** Its redraw moves the cursor up over the
  last frame, which cannot reach lines scrolled off the top, so when a frame is taller than the
  terminal it drops placeholder rows (`isPlaceholderRow`) first. No test drives this; it runs only
  under a real terminal height.
- **The Pi widget does not pad** and keeps its own default of 10. Pi caps a string-array widget at
  10 lines; fitting under that is #269.
- **`--json` is unchanged**: it renders no chart.

## Closer

On a session whose tag holds 2 intervals, `wtft -l 5` and `wtft --watch -l 5` render exactly 5
chart rows, `wtft` and `wtft --watch` exactly 17, and the rows past the second carry a dash under
each label and an empty bar area. The seam test checks the rows; the closer is checked by hand on
this host after merge.

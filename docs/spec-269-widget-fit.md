# Spec 269 — the Pi widget under Pi's line cap

**Issue:** [#269](https://github.com/princess-pi/wtft/issues/269) · **Tests:** `tests/wtft-269-widget-fit.test.ts`
· **Module:** `extensions/lib/widget-fit.ts`. Vocabulary: `CONTEXT.md` (Widget).

Pi shows at most 10 lines of a string-array widget (`MAX_WIDGET_LINES`, Pi 0.87.1) and replaces the
rest with `... (widget truncated)`. The widget handed Pi its whole chart: title, legend, ticks and a
row per interval, plus any status, divider and provisional lines. With 8 or more intervals, or
fewer when those extra lines appear, Pi cut the oldest rows and everything below them.

## 1. Interface

| Export | What it is |
|---|---|
| `PI_WIDGET_MAX_LINES` | 10 |
| `widgetLines(chart, status, width, tail)` | The chart lines with the daemon status appended to the title line when both fit in `width - 2` columns, else as its own line under the legend (third line), and `tail` (the provisional lines) at the end |
| `fitWidget(renderChart, status, width, tail, limit, max?)` | The widget's whole line array. Asks `renderChart(rows)` for `min(limit, max)` rows down to 1 (a limit that is not a finite number starts at `max`), puts each through `widgetLines`, and returns the first result of at most `max` lines. Fewer rows drop the oldest, since the chart is newest-first. If one row still overflows, `keepTail` cuts it. `null` when there is no chart |
| `keepTail(lines, tailLength, max?)` | Cuts to `max` lines from the middle, keeping the first lines and the last `tailLength` (the provisional lines), so a provisional total never loses its warning |

- **Title and legend stay the first two lines.** The status line moved from under the title to
  under the legend so that holds when it does not fit the title line.
- **The widget reads its session once per update** and hands the same interactions to every
  render `fitWidget` asks for.
- **The empty widget** ("Cache Empty" or "No Cache (local model)", the status, the provisional
  lines) is cut to 10 lines by `keepTail` too.
- **The widget is not padded** to its limit (#264); only the CLI chart is.

## 2. Tests

`tests/wtft-269-widget-fit.test.ts`: 20 hourly intervals across midnight, a status line wider than
the widget, and a provisional line. The unfitted widget overflows and carries a date divider (both
asserted as preconditions); the fitted one has at most 10 lines, title then legend, keeps the
status and provisional lines, and keeps the newest rows in order. Also: a short status joins the
title; a render that overflows at one row is cut to 10 keeping the provisional line; a NaN limit
ends; `null` stays `null`. End to end: `/wtft -w 80 -l 20` over 20 intervals through the extension
hands `setWidget` at most 10 lines, title then legend.

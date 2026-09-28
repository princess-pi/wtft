# Spec 362: a label area over 25% of the width is compacted

Module: `extensions/lib/wtft-chart.ts` (`renderWtftChart`). Test: `tests/wtft-362-compact-label-columns.test.ts`.

## Behaviour

The **label area** is everything on a chart row left of the bar: the time label and the number
columns (cost delta, cost total, token delta, token total). The **width** is the width the chart
is rendered for (the terminal's, 40 at the least).

When the label area is more than 25% of the width, the chart applies these steps in order. It stops
at the first step that brings the label area to 25% or less:

1. **Single spacing:** one space between columns instead of two.
2. **Whole units:** a cost of $1 or more loses its cents (`$487.25` → `$487`). A token count of
   1k or more loses its decimal (`778.8M` → `779M`, `589.5k` → `590k`). Rounding is to the
   nearest whole unit. A cost under $1 and a count under 1k keep their digits, so a real spend
   never reads `$0`. A negative delta keeps its sign and rounds the same way as a positive one
   (`-589.5k` → `-590k`).
3. **No `+`** on the cost and token deltas.
4. **No `$`** on the cost delta.
5. **`t` for ` tok`** on the token total (`802M tok` → `802Mt`).

After step 5 nothing more is removed. Every row, the tick line and the placeholder rows use the same
step.

## Interaction with the existing fallbacks

- **Dropping columns:** when the bar would still be under 15 cells, the token columns are dropped,
  then the cost columns, as before. The steps above are chosen again for the columns that remain.
  So a narrow terminal can now keep columns it used to drop: at 40 cells, a `$487.25` chart keeps
  its cost columns as `244 $487`.
- **Surge bolt:** the ⚡ on a surge-priced row is two cells wide and fills a two-space gap. At
  single spacing it is left out. The row keeps its orange colour.

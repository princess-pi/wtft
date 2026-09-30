# Spec 389: one option-to-chart function

Module: `extensions/lib/chart-call.ts`. Seam: `chartLines`, tested in `tests/wtft-389-chart-call.test.ts`.

The chart's callers turn parsed options into a `buildWtftLines` call in one function, `chartLines`. No output changes, but one: see *Changed on purpose*.

## Callers

- The CLI report arm (`extensions/lib/cli/report.ts`), the `--watch` renderer (`extensions/lib/wtft-daemon-lib.ts`), the Pi widget (`extensions/wtft.ts`) and the chart picker's `renderReport` (`artifacts/renderer/report.ts`) call `chartLines`.
- `bin/wtft.ts` resolves the unit with `chartUnit`, and so do the Pi widget and `renderReport`.
- `artifacts/renderer/fair.ts` calls `buildWtftLines` itself: the booth is the library page's use of the chart by an app that is not wtft.

## The rule

Each of interval, limit, mode, timezone and emoji is what was asked, else the fallback, else a default. Width is what was asked, else the fallback, which every caller gives.

| Setting | Default |
|---|---|
| interval | `1h` |
| limit | 17 rows, rounded to a whole count of at least one |
| mode | `cumulative` |
| timezone | none |
| emoji | on |

- `askedOf(options)` turns a parsed command line, or the `--watch` settings, into what was asked: a `has*` flag that is false leaves its key out, and `enableEmoji` or the negation of `disabledEmoji` carries the emoji choice. The two column switches come from `showCostColumns`, else the negation of `hideCostColumns`.
- The fallback is the caller's persisted config; `--watch` puts the session's own settings ahead of it.
- Width is capped at 1023.
- `padRows` pads to the limit, or to `padRowsCap` when that is fewer. `--watch` caps at the terminal's rows.
- The title's session suffix is the last `/` or `\` segment of `sessionFile`; with none, the title has none. `--watch` passes none.
- `chartUnit`: `--cost` over `--tokens` over the config's `tokens`.

## Verified by

- `tests/wtft-389-chart-call.test.ts`: the rule, `askedOf`, `chartUnit`, and a scan that no product file under `bin/`, `extensions/` and `artifacts/renderer/` mentions `buildWtftLines` but `chart-call.ts`, its definition in `wtft-renderer.ts`, `bin/wtft.ts`'s import and re-export, and the booth.
- The existing suite, with no expected output edited, and `tests/wtft-386-chart-artifacts.test.ts`, which compares the picker's lines to `buildWtftLines` called the CLI's way.

## Changed on purpose

The Pi widget's limit is rounded to a whole count at least one, as the CLI and `--watch` already did. A config limit of 3.5 drew a fractional slice there before.

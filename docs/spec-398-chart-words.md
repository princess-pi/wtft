# Spec 398: the chart takes its own words and category list

Module: `extensions/lib/wtft-chart.ts`. Seam: `buildWtftLines` (`extensions/lib/wtft-renderer.ts`) with `words`, tested in `tests/wtft-398-chart-words.test.ts`.

`renderWtftChart`, and `buildWtftLines` and `chartLines` above it, take a `words` option. Every field left out is wtft's own text, so wtft passes nothing and its output does not change. `tokenFooter`, `cacheLine` and `otherWarning` are read by `buildWtftLines`, which builds those three lines; `renderWtftChart` draws the lines it is handed and ignores the three fields.

## Fields

| Field | Replaces |
|---|---|
| `title` | the title's icon and `WTF Tokens?`, and the `[$]` and `[#]` forms under `--no-emoji`; the session suffix and the timeline strip still follow |
| `categories` | the 14 legend names and colours; a list of `{ slot, label, fg, char? }`; `char` is the legend swatch only; the bars draw `█`, `✨` (`*` under `--no-emoji`) on a shade of `fg` at one fixed luminance, and a token bar's `$` |
| `tokenUnit` | `tok`, and `t` at the tightest compaction: `{ name, short }` |
| `currency` | `$` in amounts, cost scale labels, the cost-only marker and its key, and the Other warning's cost; compaction step 4 drops it from the incremental-cost column; an empty currency leaves the marker and its key at `$`, so the marker still draws |
| `cacheMissLabel` | `Cache Miss` |
| `key` | `earlier bins`, `this bin`, and the cost-only note's text after `$ = `: `{ earlier, thisBin, costOnly? }` |
| `tokenFooter` | `false` drops the `↑ ↓ R CH%` line |
| `cacheLine` | `false` drops the `CH:` line |
| `otherWarning` | the warning's text after its prefix: a template whose every `{pct}` and `{cost}` is filled, or `false` for none; the warning keeps its prefix, `⚠️` or `!!` with emoji off, and its bold yellow |

## Categories

- A category borrows one of wtft's 14 slots by name, so the set stays 14 and `_cat` still names a slot.
- The list sets the category order: the legend's, the stack's, and which category wins a tie on a scatter column, a trim or a leftover cell (`artifacts/chart-spec/spec.mdx`). A slot left out of the list keeps its colour, follows the listed ones, and has no legend entry. A `label` of null leaves a listed slot out of the legend too.
- A list that is present is the whole legend, even when it is empty, every entry is dropped, or every label is null; the legend line is then blank.
- An entry whose slot is not one of the 14, or repeats an earlier entry's slot, is dropped.

## Not covered

- The timeline strip and its surge badge stay on wtft's title line; a header line from the caller is later work.
- Width and clock as inputs, and importing the chart without the parser, are later work.
- `Other` as a category name in the default warning, and `wtft --other`, stay wtft's unless `otherWarning` replaces them.

## The fair page

`artifacts/renderer/fair.ts` calls the chart with no words, then with the booth's. The second picture is the chart's own draw, so the mockup's substitution rules are gone.

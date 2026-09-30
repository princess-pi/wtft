# Spec 398: the chart takes its own words and category list

Module: `extensions/lib/wtft-chart.ts`. Seam: `buildWtftLines` with `words`, tested in `tests/wtft-398-chart-words.test.ts`.

`renderWtftChart`, and `buildWtftLines` and `chartLines` above it, take a `words` option. Every field left out is wtft's own text, so wtft passes nothing and its output does not change.

## Fields

| Field | Replaces |
|---|---|
| `title` | the title's icon and `WTF Tokens?`; the session suffix still follows |
| `categories` | the 14 legend names and colours; a list of `{ slot, label, fg, char? }` |
| `tokenUnit` | `tok`, and `t` at the tightest compaction: `{ name, short }` |
| `currency` | `$` in amounts, scale labels, the cost-only marker and its key |
| `cacheMissLabel` | `Cache Miss` |
| `key` | `earlier bins`, `this bin` and the cost-only note: `{ earlier, thisBin, costOnly? }` |
| `tokenFooter` | `false` drops the `↑ ↓ CH%` line |
| `cacheLine` | `false` drops the `CH:` line |
| `otherWarning` | a template with `{pct}` and `{cost}`, or `false` for none |

## Categories

- A category borrows one of wtft's 14 slots by name, so the set stays 14 and `_cat` still names a slot.
- The list sets the legend and stack order. A slot left out of the list keeps its colour, follows the listed ones, and has no legend entry. A `label` of null leaves a listed slot out of the legend too.

## Not covered

- The timeline strip and its surge badge stay on wtft's title line; a header line from the caller is later work.
- Width and clock as inputs, and importing the chart without the parser, are later work.
- `Other` as a category name in the default warning, and `wtft --other`, stay wtft's unless `otherWarning` replaces them.

## The fair page

`artifacts/renderer/fair.ts` calls the chart with no words, then with the booth's. The second picture is the chart's own draw, so the mockup's substitution rules are gone.

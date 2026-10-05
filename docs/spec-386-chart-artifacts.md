# Spec 386: the chart pages run the production chart

Module: `artifacts/renderer/` (`entry.ts` and what it exports) and `build-artifacts.ts`. Test: `tests/wtft-386-chart-artifacts.test.ts`.

The chart spec pages are two uses of the chart code, and each one is a test of the seam around it.
The wtft page is the app's own chart on the app's own flags. The library page is a use by an app
that is not wtft. Neither page has a painter of its own: both call `buildWtftLines`.

## 1. The bundle

`bun run artifacts` bundles `artifacts/renderer/entry.ts` for the browser, as minified ESM, and writes
`artifacts/renderer/wtft-chart.mjs`. The file is tracked, because `serve` publishes the
`artifacts/` directory as it stands. The bundle's first line names a sha-256 over every repo file it was built from outside
`node_modules`, plus this build script and `package.json`; a test recomputes it and fails when the two differ, so an edit
to anything it carries (the chart, the parser, the pricing and cost code, and what they import) or to `package.json`
needs a rebuild. A dependency that moves under an unchanged `package.json` is not seen. The hash, unlike the bundle's bytes, is the same under every bun version. `node:url` is replaced by a two-function shim, and
`node:fs` and `node:child_process` become empty objects, so the bundle reads no config or pricing file.

The bundle exports:

- `renderReport(argv, env)`: the CLI report arm's option-to-chart step, `chartLines`, called on the flags
  and the env. `argv` is a wtft command line, split into words and read by `parseWtftCliArgs`.
  `env` is the terminal's columns, the session file's full path, the interactions, and optionally a clock and a config of
  interval, limit, mode, timezone and tokens. It returns `{ opts, unit, lines }`: the parsed flags, the chart's unit, and
  the session path line followed by the chart lines, pad included. It leaves out what the CLI prints after the chart:
  the token summary, the `--other` histogram, and warnings. With no `--emoji` or `--no-emoji` it draws emoji, where the
  CLI reads the config.
- `withTerminal(columns, now, run)`: runs `run` with a stand-in terminal width and, when `now` is set, a pinned clock.
- `parseWtftCliArgs`: the CLI's own flag parser.
- `wtftSession(model)`: a fake session of tag-file interactions (`_cat` set, as a tag file sets it), the same every
  time. The model prices every turn and, when it has a surge schedule, marks surge-priced turns. `WTFT_MODELS` lists
  the models the picker offers.
- `fairBooth({ souvenirs })`: the state-fair booth's sales as the same interaction type. `FAIR_ITEMS`, `SOUVENIRS` and
  `FAIR_TZ` are its items and its timezone.
- `renderFair(state)`: the fair page's draw, in two views (the chart with no words, then with the booth's `words`), the list
  of words the booth passes with how many lines of the first view carried wtft's, and the `buildWtftLines` calls as text. `FAIR_DEFAULTS` is the page's first state.
- `PRESETS`, `SPEC_PIN`: the four presets as command lines, and the terminal, clock, model and session file the spec
  page's blocks are drawn under.
- `CATEGORY_STYLE`: each category's colour and legend name.
- `ansiToHtml(text)`, `stripAnsi(text)`, `xtermRgb(n)`: the terminal's colour codes to HTML. `ansiToHtml` handles bold,
  reverse video, the 16 basic foreground colours and 256-colour foregrounds and backgrounds, and drops the rest, blink
  included. It honours the resets 0, 22, 27, 39 and 49, and reads an empty `\x1b[m` as 0. It paints the chart's block and box-drawing glyphs as cells (`docs/spec-392-cell-glyphs.md`).

- The parser's per-line half, for the parser playground: `parseEntryToInteraction`, `newParseStreamState`,
  `applyControlEntry`, `readControlEntry`, `isInterruptMarker`, `INTERRUPT_PREFIX`, `deduplicateInteractions`,
  `classifyInteraction`, `splitOverheadCost`, `normalizeCommand` and `commandSpawnsAgent` from `wtft-parser.ts`, and
  `extractRealCommands` and `splitCommandWords` from `wtft-command-shapes.ts`. Nothing that reads a file is exported:
  in the bundle `node:fs` is empty.
- `parseJsonlText(text)`: the per-line loop `parseSessionFile` runs, over pasted text, then the dedupe, the classifier
  and the overhead split as the daemon applies them. It notes what it did with each line, which input decided each
  category (`decidedBy`), and which lines a merged turn came from. It skips the `claude -p` fold, which reads other
  transcripts from disk. `PARSER_PRESETS` and `presetText(preset)` are the playground's examples.

The harness registry resolves its config path inside its own guard (`loadHarnessConfig`), so a page with no `process`
reads no harness config and the built-in adapters still parse.

`renderReport` installs a stand-in for the terminal (`process.stdout.columns`) only while it runs, because
`buildWtftLines` asks the terminal for its width. In a page with no `process`, the stand-in is a whole `process`
with an empty `env`, removed afterwards. It pins `Date.now` only when the caller passes a clock.

## 2. The wtft page

`artifacts/chart-spec/picker.html`. The controls are the chart's flags, `--pad`, the terminal's width, the fake
session's model and file name, four preset buttons, and a copy button. The command line shows the flags and can be
edited; an edit is read by `parseWtftCliArgs` and moves the controls. A change to a flag's control rewrites the command
line from the controls, so a typed flag with no control, such as `-o`, is dropped. A typed limit or pad past its
slider's end moves that end.
The chart shown is `renderReport`'s output for that command line with no config: the session path line, the title
with its timeline strip and session-name suffix, the legend, the scale line, the rows, the rules, and the footers. The
page adds a column ruler above and a line count below. It passes no clock, so the strip follows the reader's.
`paint.mjs` is deleted.

`artifacts/chart-spec/spec.mdx` prints the four presets as the chart draws them under a pinned clock,
timezone, width, model and session file. A test finds each block in the page.

## 3. The library page

`artifacts/chart-lib/spec.mdx` and `artifacts/chart-lib/fair.html`. The data is the sales of a
state-fair booth: six items and, optionally, souvenirs, over three days. One sale is one interaction: its
revenue is `cost` and its units are `inputTokens`. The page draws it twice:

- **As the chart draws it today**: `buildWtftLines` output, unchanged.
- **With the booth's own words**: the same call with `words` (docs/spec-398-chart-words.md).
  Each word is one place the chart says something only wtft means, and the page counts how many lines
  of the first view carried wtft's. The timeline strip stays.

The spec page lists what the chart cannot say in the fair's terms, and gives each finding a fix shape or marks it standing.
The decisions the findings raise are on the spec page's *Decisions* list.

## 3b. The parser pages

`artifacts/parser/spec.mdx` explains the session log parser: the pipeline, the adapter seam, the functions that carry
the weight, the classifier's priority ladder, control entries, cache misses and the `claude -p` fold. It embeds
`artifacts/parser/playground.html`, which reads pasted JSONL with `parseJsonlText` and shows each interaction with its
category in `CATEGORY_STYLE`'s colour, and strips a typed Bash command with `extractRealCommands`.

## 4. Verification

- `tests/wtft-386-chart-artifacts.test.ts` asserts:
  - the committed bundle names the current sources hash, and its `renderReport`, `parseWtftCliArgs` and `wtftSession` give what
    the source gives;
  - the bundle draws at 79, 80 and 81 columns in a page with no `process`, and leaves none behind;
  - `renderReport`'s lines for a fixed command line equal `buildWtftLines` called with the arguments the report arm
    passes; `-c` and `-b` under `--tokens`, `-i`, `-l`, `--no-emoji`, `--no-cost`, `--no-tokens` and `--pad` each show in
    the output, and `--tz` and the terminal width each change it;
  - `renderReport` restores the terminal width and the clock;
  - each of the four presets, colour codes stripped and trailing spaces trimmed, appears in `spec.mdx`;
  - the picker imports `parseWtftCliArgs` from the bundle and calls it on the command line;
  - the fake session spans three dates, a cache miss, surge turns and server-tool cost;
  - the fair data feeds `buildWtftLines`, every word fires in some view and is a row of the findings table,
    and in the units view with souvenirs the second view carries none of the test's list of wtft words;
  - the two library pages are listed in `artifacts/docs.json`, and `paint.mjs` is gone;
  - `ansiToHtml` colours, bolds, reverses and escapes.
- `tests/wtft-parser-artifact.test.ts` asserts:
  - the two parser pages are listed in `artifacts/docs.json` under "Parser", and the explainer embeds the playground;
  - the playground imports only names the bundle exports, and the bundle parses every preset with no `process`, as the
    source does;
  - for every preset, `parseJsonlText` gives what `parseSessionFile`, `deduplicateInteractions`, `classifyInteraction`
    and `splitOverheadCost` give on the same lines written to a file, and the category the preset names.
- By eye: both pages open at https://wtft-artifacts.princess-pi.dev/.

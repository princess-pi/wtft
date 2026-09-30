# Spec 386: the chart pages run the production chart

Module: `artifacts/renderer/` (`entry.ts` and what it exports) and `build-artifacts.ts`. Test: `tests/wtft-386-chart-artifacts.test.ts`.

The chart spec pages are two uses of the chart code, and each one is a test of the seam around it.
The wtft page is the app's own chart on the app's own flags. The library page is a use by an app
that is not wtft. Neither page has a painter of its own: both call `buildWtftLines`.

## 1. The bundle

`bun run artifacts` bundles `artifacts/renderer/entry.ts` for the browser, as minified ESM, and writes
`artifacts/renderer/wtft-chart.mjs`. The file is tracked, because `serve` publishes the
`artifacts/` directory as it stands. A test builds the bundle again in memory and fails when the
committed file differs, so an edit to anything it carries (the chart, the parser, the pricing and
cost code, and what they import) needs a rebuild. `node:url` is replaced by a two-function shim;
every other `node:` import becomes an empty object, so the bundle reads no config or pricing file.

The bundle exports:

- `renderReport(argv, env)`: a copy of the CLI report arm's option-to-chart step, then `buildWtftLines`. A change to
  the CLI's step does not reach it (#389). `argv` is a wtft command line, split into words and read by `parseWtftCliArgs`.
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
- `renderFair(state)`: the fair page's draw, in two views, the list of substitutions the second view made with a count
  each, and the `buildWtftLines` call as text. `FAIR_DEFAULTS` is the page's first state.
- `PRESETS`, `SPEC_PIN`: the four presets as command lines, and the terminal, clock, model and session file the spec
  page's blocks are drawn under.
- `CATEGORY_STYLE`: each category's colour and legend name.
- `ansiToHtml(text)`, `stripAnsi(text)`, `xtermRgb(n)`: the terminal's colour codes to HTML. `ansiToHtml` handles bold,
  reverse video, the 16 basic colours and the 256-colour palette, and drops the rest, blink included.

`renderReport` installs a stand-in for the terminal (`process.stdout.columns`) only while it runs, because
`buildWtftLines` asks the terminal for its width. In a page with no `process`, the stand-in is a whole `process`
with an empty `env`, removed afterwards. It pins `Date.now` only when the caller passes a clock.

## 2. The wtft page

`artifacts/chart-spec/picker.html`. The controls are the chart's flags, `--pad`, the terminal's width, the fake
session's model and file name, four preset buttons, and a copy button. The command line shows the flags and can be
edited; an edit is read by `parseWtftCliArgs` and moves the controls. A control change rewrites the command line from
the controls, so a typed flag with no control, such as `-o` or `--by-model`, is dropped. A typed limit or pad past its
slider's end moves that end.
The chart shown is `renderReport`'s output for that command line with no config: the session path line, the title
with its timeline strip and session-name suffix, the legend, the scale line, the rows, the rules, and the footers. The
page adds a column ruler above and a line count below. It passes no clock, so the strip follows the viewer's.
`paint.mjs` is deleted.

`artifacts/chart-spec/spec.mdx` prints the four presets as the chart draws them under a pinned clock,
timezone, width, model and session file. A test finds each block in the page.

## 3. The library page

`artifacts/chart-lib/spec.mdx` and `artifacts/chart-lib/fair.html`. The data is the sales of a
state-fair booth: six items and, optionally, souvenirs, over three days. One sale is one interaction: its
revenue is `cost` and its units are `inputTokens`. The page draws it twice:

- **As the chart draws it today**: `buildWtftLines` output, unchanged.
- **As a generic library would draw it**: a mockup, the same lines after a table of substitutions.
  Each substitution is one place the chart says something only wtft means, and the page counts how
  often each one fired. They cover 8 of the 17 findings; two of them delete a line rather than
  rewrite it, and the timeline strip, the `$` and the compacted `t` stay.

The spec page lists what the chart cannot say in the fair's terms, and gives each finding a fix shape or marks it standing.
The decisions the findings raise are not made here: Q-A, Q-B and Q-D are #388, and F15's one
option-to-chart function is #389.

## 4. Verification

- `tests/wtft-386-chart-artifacts.test.ts` asserts:
  - the committed bundle equals a fresh build, and its `renderReport`, `parseWtftCliArgs` and `wtftSession` give what
    the source gives;
  - the bundle draws at 79, 80 and 81 columns in a page with no `process`, and leaves none behind;
  - `renderReport`'s lines for a fixed command line equal `buildWtftLines` called with the arguments the report arm
    passes, and each chart flag, `--pad`, `--tz` and the terminal width changes the output;
  - `renderReport` restores the terminal width and the clock;
  - each of the four presets, colour codes stripped and trailing spaces trimmed, appears in `spec.mdx`;
  - the picker imports `parseWtftCliArgs` from the bundle and calls it on the command line;
  - the fake session spans three dates, a cache miss, surge turns and server-tool cost;
  - the fair data feeds `buildWtftLines`, every substitution fires in some view and is a row of the findings table,
    and the second view carries none of the wtft words the first view does;
  - both pages are listed in `artifacts/docs.json`, and `paint.mjs` is gone;
  - `ansiToHtml` colours, bolds, reverses and escapes.
- By eye: both pages open at https://wtft-artifacts.princess-pi.dev/.

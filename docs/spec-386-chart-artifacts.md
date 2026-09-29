# Spec 386: the chart pages run the production chart

Module: `artifacts/renderer/` (`report.ts`, the bundle entry). Test: `tests/wtft-386-chart-artifacts.test.ts`.

The chart spec pages are two uses of the chart code, and each one is a test of the seam around it.
The wtft page is the app's own use. The library page is a use by an app that is not wtft. Neither
page has a painter of its own: both call `buildWtftLines`.

## 1. The bundle

`bun run artifacts` bundles `artifacts/renderer/entry.ts` for the browser and writes
`artifacts/renderer/wtft-chart.mjs`. The file is tracked, because `serve` publishes the
`artifacts/` directory as it stands. A test builds the bundle again in memory and fails when the
committed file differs.

The bundle exports:

- `renderReport(argv, env)`: the CLI report arm's option-to-chart step, then `buildWtftLines`. `argv` is a wtft
  command line, split into words and read by `parseWtftCliArgs`. `env` is the terminal's columns, the session file
  name, the interactions, and optionally a clock and a config. It returns the lines the CLI would print.
- `wtftSession(model)`: a fake session of tag-file interactions (`_cat` set, as a tag file sets it).
- `fairBooth(options)`: the state-fair booth's sales as the same interaction type.
- `renderFair(state)`: the fair page's draw, in two views, the list of substitutions the second view made with a count each, and the `buildWtftLines` call as text.
- `PRESETS`, `SPEC_PIN`: the four presets as command lines, and the terminal, clock and session file the spec page's blocks are drawn under.
- `ansiToHtml(text)`, `stripAnsi(text)`, `xtermRgb(n)`: the terminal's colour codes to HTML.

`renderReport` installs a stand-in for the terminal (`process.stdout.columns`) only while it runs, because
`buildWtftLines` asks the terminal for its width. It pins `Date.now` only when the caller passes a clock.

## 2. The wtft page

`artifacts/chart-spec/picker.html`. Every control is a chart flag or the terminal's width. The
command line shows the flags and can be edited; an edit is read by `parseWtftCliArgs` and moves the controls.
The chart shown is the CLI's output for that command line: the session path line, the title with
its timeline strip and session-name suffix, the legend, the scale line, the rows, the rules, and
the footers. `paint.mjs` is deleted.

`artifacts/chart-spec/spec.mdx` prints the four presets as the chart draws them under a pinned clock,
timezone and width. A test compares each block to `renderReport`'s output.

## 3. The library page

`artifacts/chart-lib/spec.mdx` and `artifacts/chart-lib/fair.html`. The data is the sales of a
state-fair booth: six items and, optionally, souvenirs, over three days. One sale is one interaction: its
revenue is `cost` and its units are `inputTokens`. The page draws it twice:

- **As the chart draws it today**: `buildWtftLines` output, unchanged.
- **As a generic library would draw it**: the same lines after a table of substitutions. Each
  substitution is one place the chart says something only wtft means. The table is the list of
  findings, and the page counts how often each one fired.

The spec page lists what the chart cannot say in the fair's terms, and gives each finding a fix shape or marks it standing.

## 4. Verification

- `tests/wtft-386-chart-artifacts.test.ts` asserts: the committed bundle equals a fresh build; `renderReport`'s lines for a fixed
  command line equal `buildWtftLines` called directly with the CLI's own arguments; each of the four presets in `spec.mdx` equals the
  chart's output; `parseWtftCliArgs` is the parser the picker uses; the fair data feeds `buildWtftLines`, every substitution fires in some view and is a row of
  the findings table; `paint.mjs` is gone.
- By eye: both pages open at https://wtft-artifacts.princess-pi.dev/.

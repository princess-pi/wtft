# Spec 390: the chart's glyph key

Module: extensions/lib/wtft-chart.ts

The key under a chart names what the glyphs encode.

- A running-total chart (the default mode, or `-c`), cost or tokens, prints `█ earlier bins  ✨ this bin`, with `**` in place of `✨` under `--no-emoji`. `✨` is this bin's share and `█` is earlier bins', whatever their cache status; rounding the `✨` run to an even count moves the split by up to a cell or two either way. The key prints whether or not a row drew a `✨`. #413 brought the cost chart in and changed the glyphs from `▃`/`▇`.
- A bucket chart (`-b`) draws no `✨`, so it prints no `█`/`✨` key.
- `$ = cost-only (web tools)` prints only when the chart drew a `$`, on the same line after the glyph key, or alone in a bucket chart.
- A bucket chart with no `$` prints no key line, so a bucket cost chart never prints one.

Verified by `tests/wtft-390-glyph-key.test.ts`.

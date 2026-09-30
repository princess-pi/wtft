# Spec 390: the token chart's glyph key

Module: extensions/lib/wtft-chart.ts

The key under a token chart names what the glyphs encode.

- A running-total token chart (`-c --tokens`) prints `▃ earlier bins  ▇ this bin`. `▇` is this bin's tokens and `▃` is the tokens of earlier bins, whatever their cache status.
- A bucket token chart (`-b --tokens`) draws neither glyph, so it prints no `▃`/`▇` key.
- `$ = cost-only (web tools)` prints only when the chart drew a `$`, on the same line after the glyph key, or alone in a bucket chart.
- A chart with nothing to say prints no key line. A cost chart never prints one.

Verified by `tests/wtft-390-glyph-key.test.ts`.

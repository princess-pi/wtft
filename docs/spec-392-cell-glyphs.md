# Spec 392: the chart's block and box glyphs are painted as cells

Module: `artifacts/assets/cell-glyphs.mjs`. Test: `tests/wtft-392-cell-glyphs.test.ts`.

A terminal draws `█`, the lower eighths and the box-drawing lines itself, filling the whole cell,
so neighbouring cells meet. A browser draws them from the font, inside a line box taller than the
glyph and an advance wider than it, so the chart pages show hairlines between `█` cells, a band
between bar rows, and broken `─` and `┼` lines.

## 1. `cellsHtml(text)`

Takes plain text and returns HTML: `&`, `<` and `>` escaped, and each paintable character below
wrapped in a span that paints it. The span is `display:inline-block`, `N` `ch` wide for a run of
`N` (1 for a character that forms no run), one line tall (`1lh`), top-aligned, clipped
(`overflow:hidden`), with the character kept as transparent text so a selection still copies it.
The paint is CSS background layers in the current text colour:

- **Blocks.** `█` and the lower eighths `▁`–`▇` fill the bottom `n`/8 of the cell. `▀` and `▔`
  fill the top half and eighth. `▉`–`▏` fill the left `n`/8, `▐` and `▕` the right half and
  eighth. The quadrants `▖`–`▟` fill their quarters.
- **Box drawing.** `─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼` and the half lines `╴ ╵ ╶ ╷` draw a light line through
  the cell centre to each edge they name, `max(1px, .08em)` thick; `━ ┃` draw a heavy one,
  `max(2px, .16em)`. The other box-drawing characters (heavy corners and junctions, doubles,
  dashes, rounded corners) stay text: the chart draws none of them.

Only `█`, the lower eighths, `▀`, `▔`, `─` and `━` form runs: repeats of one of them share a
span. Every other paintable character gets a span of its own, repeated or not. Any other character,
the shades `░ ▒ ▓` included, stays text.

## 2. Where it runs

- `ansiToHtml` passes each chunk of text through `cellsHtml`, so the charts on the chart picker and
  the fair page paint. Their column ruler and the fair page's printed call are set as text and do
  not.
- The spec browser (`artifacts/assets/browser.js`) replaces the contents of every `pre code`
  block with `cellsHtml` of its text, so the preset blocks in `chart-spec/spec.mdx`
  paint too. Markup inside such a block is flattened to its text. Inline `code` is not painted.
- Each of those `pre` blocks has a whole-pixel font size and line height (`14px/19px` on the two
  chart pages, `13px/17px` in the spec browser, whose `code` inherits it). A fractional line
  height puts row edges between pixels, and the anti-aliased seam shows as a line between rows.

## 3. Verification

- `tests/wtft-392-cell-glyphs.test.ts`: the painted set is exactly the characters listed in §1,
  with their fills and arms; runs; escaping; the characters left as text; `ansiToHtml` painting
  inside a coloured span; `browser.js` calling `cellsHtml` on code blocks; and the whole-pixel font
  rules on the three pages.
- By pixel: a headless-Chrome screenshot of the chart picker, the fair page and
  `chart-spec/spec.mdx` at 1800×1400, cropped to the bars, counting 1–3 pixel runs of another
  colour between two pixels of the same bar colour along a pixel row (hairlines) and 1–8 pixel runs
  down a pixel column (row bands). All three read 0 and 0 after this change.
  `research/392-cell-gaps/` holds `shot.mjs` (screenshot), `counts.py` (count) and `RESULTS.md`
  (the commands and the before and after counts, also on
  https://github.com/princess-pi/wtft/issues/392#issuecomment-5913515463).

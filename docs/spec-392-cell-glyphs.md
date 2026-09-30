# Spec 392: block and box glyphs are painted as cells

Module: `artifacts/assets/cell-glyphs.mjs`. Test: `tests/wtft-392-cell-glyphs.test.ts`.

A terminal draws `█`, the lower eighths and the box-drawing lines itself, filling the whole cell,
so neighbouring cells meet. A browser draws them from the font, inside a line box taller than the
glyph and an advance wider than it, so the chart pages show hairlines between `█` cells, a band
between bar rows, and broken `─` and `┼` lines (#392).

## 1. `cellsHtml(text)`

Takes plain text and returns HTML: the text escaped, and every run of one paintable character
wrapped in a span that paints it. The span is `display:inline-block`, `N` `ch` wide for a run of
`N`, one line tall (`1lh`), top-aligned, with the character kept as transparent text so a
selection still copies it. The paint is CSS background layers in the current text colour:

- **Blocks.** `█` and the lower eighths `▁`–`▇` fill the bottom `n`/8 of the cell. `▀` and `▔`
  fill the top half and eighth. `▉`–`▏` fill the left `n`/8, `▐` and `▕` the right half and
  eighth. The quadrants `▖`–`▟` fill their quarters.
- **Box drawing.** `─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼` and the half lines `╴ ╵ ╶ ╷` draw a light line through
  the cell centre to each edge they name; `━ ┃` draw a heavy one.

Only a character whose paint spans the whole cell width (`█`, the lower eighths, `▀`, `▔`, `─`,
`━`) forms a run; every other paintable character gets a span of its own. Any other character,
the shades `░ ▒ ▓` included, stays text.

## 2. Where it runs

- `ansiToHtml` passes each chunk of text through `cellsHtml`, so the wtft picker and the fair page
  paint their charts.
- The spec browser (`artifacts/assets/browser.js`) passes the text of every code block except
  mermaid through `cellsHtml`, so the preset blocks in the spec pages paint too.
- Each of those `pre` blocks has a whole-pixel font size and line height (`14px/19px` on the two
  chart pages, `13px/17px` in the spec browser, whose `code` inherits it). A fractional line
  height puts row edges between pixels, and the anti-aliased seam shows as a line between rows.

## 3. Verification

- `tests/wtft-392-cell-glyphs.test.ts`: runs, single cells, escaping, the characters left as text,
  `ansiToHtml` painting inside a coloured span, and `browser.js` calling `cellsHtml` on code blocks.
- By pixel: a headless-Chrome screenshot of the picker, the fair page and `chart-spec/spec.mdx` at
  1800×1400, counting 1–3 pixel runs of another colour between two pixels of the same saturated
  colour along a pixel row (hairlines) and 1–8 pixel runs down a pixel column (row bands).
  The counts before and after are recorded on #392.

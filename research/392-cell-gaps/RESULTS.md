# 392 cell gaps: measured 2026-09-30

Before: `main` at `e204ef9`, served on one loopback port. After: branch `392-cell-glyph-gaps`, served on another.

```
node shot.mjs http://127.0.0.1:<port>/chart-spec/picker.html picker.png "#chart span"
node shot.mjs http://127.0.0.1:<port>/chart-lib/fair.html fair.png "#today span"
node shot.mjs "http://127.0.0.1:<port>/index.html#chart-spec/spec.mdx" spec.png "#content pre" "#content pre"
python3 counts.py picker.png 358,535,1200,815
python3 counts.py fair.png 358,398,1340,890
INK=dark python3 counts.py spec.png 615,80,1080,130
```

| Page | Before hgaps / vgaps | After |
|---|---|---|
| chart picker, cost cumulative | 8543 / 2999 | 0 / 0 |
| fair page, by the hour | 25723 / 12120 | 0 / 0 |
| `chart-spec/spec.mdx`, first preset block | 2301 / 605 | 0 / 0 |

The rectangles are the bar areas at 1800×1400; they move if the page layout changes.

`counts.py` scores only saturated bar colours (black with `INK=dark`), so the grey `Other` category
and the box-drawing lines are not in these numbers. The `──` rules and `┼` ticks were checked by eye
on 3× nearest-neighbour crops of the same screenshots: continuous across cells and rows after the
change, broken before it.

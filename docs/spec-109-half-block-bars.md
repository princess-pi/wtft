# Spec: Half-Block Resolution Stacked Bars (#109)

## Problem

Current cost-mode bar rendering uses one character per cell — one FG color, one category per terminal column.
Small categories with < 1 char share disappear entirely. Adjacent-category colors at boundaries have no
way to share a cell.

## Solution

Double resolution inside each cell using half-block Unicode glyphs:
- `█` (U+2588, full block): both half-slots are the same category → FG color only
- `▌` (U+258C, left half block): left half-slot is one category (FG), right half-slot is another (BG)

Each terminal cell = 2 half-slots. `barWidth` stays the same; internal precision doubles.

## Scope

- **Cost mode only** (cumulative + bucket). Token mode is untouched (density chars remain; braille planned separately).
- Both `wtft` CLI and Pi TUI widget.

## Design decisions

### 1. Distribution at half-slot level

New function `distributeHalfSlots(costs, barWidth * 2)` distributes proportional counts across half-slots.
Existing `distributeChars` stays for token mode.

### 2. Single-glyph per cell

`renderHalfBlockBar(halfSlots, styles)` walks pairs left-to-right:
- `halfSlots[2n] == halfSlots[2n+1]` → `█` with FG = category color
- `halfSlots[2n] != halfSlots[2n+1]` → `▌` with FG = left category, BG = right category

No `▐` (right half block) needed — the left half covers both categories via FG+BG.

### 3. Cumulative clamping at half-slot resolution

Same algorithm (#106), operating on `barWidth × 2` half-slots. No structural change.

### 4. Bucket mode: cost-based top-2

Two-pass: (1) accumulate categories per position, (2) pick top-2 by cost per position.
Replaces the old reverse-CATEGORY_ORDER overwrite loop.

### 5. New palette

14 colors optimized for adjacent-pair distinctness, no red/green adjacency:

| Category    | ANSI | Description   |
|-------------|------|---------------|
| plan        | 75   | cool blue     |
| spec        | 117  | cyan          |
| research    | 141  | purple        |
| web         | 209  | orange (kept) |
| grep        | 68   | blue-green    |
| code        | 179  | gold          |
| tests       | 149  | teal          |
| git         | 110  | muted blue    |
| agents      | 204  | hot pink      |
| prompt      | 216  | salmon        |
| compaction  | 143  | mustard (kept)|
| interrupted | 197  | rose          |
| overhead    | 180  | tan           |
| other       | 245  | light grey    |

### 6. CATEGORY_STYLE changes

- `fg`: updated to new palette
- `char`: all set to `"█"` (was mixed `█`/`▓`/`░`)
- `bg`: unchanged (token mode still uses it via `TOKEN_BG_COLORS`)

### 7. Legend

All entries render as `█` in their FG color: `█Plan █Spec █Research ...`

## Road not taken

- **Quadrant blocks** — 4 sub-cells per character but still one FG color. Fails at 3+ categories per cell.
- **Braille (2×4)** — 8-dot patterns per glyph, arbitrary stacking, but different aesthetic. Saved for token-mode experiment.
- **Literal 2× width** — doubling barWidth defeats the purpose; same result achievable with current full-char rendering.
- **Coalesce-runs pairing** — merges consecutive same-category half-slots into full blocks, but greedy left-to-right with `▌` boundaries is simpler and the boundary artifact is a feature (shows where categories meet).
- **CATEGORY_ORDER tiebreaker for bucket mode** — cost magnitude is the right signal for "what matters at this position."

## Verification

1. Data-layer: `distributeHalfSlots` unit tests (input costs → expected half-slot counts)
2. Render-layer: `renderHalfBlockBar` structural tests (cell count, █ vs ▌ choice, ANSI color codes)
3. Smoke test: `./wtft -n 5` visual inspection

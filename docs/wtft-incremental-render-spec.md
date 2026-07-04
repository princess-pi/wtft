# WTFT `--watch` Polling TUI Rendering

**Status:** Spec Approved

## Goal

Provide a live-updating cost chart in wtft `--watch` mode that feels responsive and self-correcting. Every 667ms (~90bpm), the session file is read for new interactions and the full terminal chart is rebuilt from scratch and written in one `process.stdout.write()` call.

## Why polling, not fs.watch

| Concern | Polling answer |
|---|---|
| Platform quirks with inotify/kqueue | Polling works identically on Linux, macOS, Windows, WSL, NFS, and Docker mounts |
| Throttle / coalesce rapid writes | 667ms interval naturally throttles to 90bpm |
| Terminal buffer corruption (other programs writing) | Full redraws repair the buffer every tick |
| Per-row incremental ANSI complexity | Eliminated — no scroll regions, no diff state, no `prevChartLines` |
| Latency | At 667ms, the worst case before a new bar appears is 1.3s; the chart-build cost dominates rendering I/O either way |

## Architecture

```
setInterval(render, 667)

render():
  1. parseInteractions(sessionPath) — read only new bytes from the file
  2. buildWtftLines(allInteractions, ...) — full chart from scratch
  3. \x1b[2J\x1b[H + header + "\n" + chartLines.join("\n") — single write()
```

No incremental diff state. No scroll regions. No `fs.watch`. One `setInterval`, one `process.stdout.write()` per tick.

## Terminal Layout (watch mode)

```
Row 1:  sessionPath  (N interactions, $X.XX) — Ctrl+C to exit   (24h timeline)
Row 2:  [legend: Spec, Mixed, Code, Tests, Research, Git, Grep, Prompt, Other]
Row 3+:  ticks line (if --ticks), date dividers, bucket rows
```

The legend is always on its own row (`forceLegendRow: true`) so the 24-hour surge timeline fits inline on row 1 without wrapping. Chart lines from `buildWtftLines` begin at row 2; the gap between header and chart is a single empty string element in the output buffer.

## SIGWINCH (terminal resize)

The handler calls `render()` directly (not via the interval). Since Node's event loop is single-threaded, this cannot interleave with an interval-triggered `render()`. The user sees the chart resize immediately.

## SIGINT

Hides cursor (`\x1b[?25l` at start), clears screen on exit, restores cursor, prints summary line.

## Settings changes

Settings (interval, limit, mode, showTicks, timezone, disabledEmoji) are stored in the session JSONL file as `custom` entries. Each `render()` call calls `parseInteractions()` which checks for `emoji-settings` and `wtft-settings` entries in the new bytes, updating the accumulator variables before rebuilding the chart. Since we do a full rebuild every tick anyway, any settings change is picked up within 667ms.

## Edge cases

| Situation | Handling |
|---|---|
| File rotated/deleted | `parseInteractions` resets `lastSize = 0`; next render shows "Waiting for session data..." |
| File doesn't exist at start | `render()` skips parse; next tick retries |
| Empty session (no interactions yet) | "Waiting for session data..." placeholder line |
| Scale max boundary crossed ($9.99 → $10.00) | Full redraw is the only path — handled naturally |
| New bucket (time boundary crossed) | Full redraw — handled naturally |
| Rapid bursts of interactions | All caught in the next poll, parsed in batch via incremental file read |

## Verification

Test with a growing JSONL file:

1. Start `wtft --watch` against a known session file
2. Append single interactions at varying rates (100ms, 500ms, 2s intervals)
3. Verify: terminal shows correct bars, no flicker, no leftover characters, total cost & count accurate
4. Cross a scale boundary (e.g., add enough cost to push $9.99 → $10.00) → verify bars re-scale
5. Cross a time boundary (e.g., next hour) → verify new bucket line appears
6. Resize terminal → verify immediate chart resize
7. No interaction activity for multiple poll cycles → verify no visible flicker (terminal vsync)

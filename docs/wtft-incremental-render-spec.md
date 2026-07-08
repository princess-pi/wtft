# WTFT `--watch` Live Render + Log Parser Health Monitoring

**Status:** Spec Approved (Code and Spec Approved, Step 5)

## Goal

Provide a live-updating cost chart in wtft `--watch` mode, backed by a persistent log parser daemon that pre-classifies session entries into a harness-agnostic tag file. The TUI watches the tag file via inotify (`fs.watch`) for zero-latency updates, and monitors the log parser's health with a colored status indicator on the title line.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  wtft-daemon (log parser) — detached, singleton per     │
│  session. Polls session.jsonl every 667ms, classifies   │
│  entries, writes to wtft-tags/<session>.tag.v2.3.2.jsonl│
│  Tag format includes message.id for cross-run dedup.    │
│  Heartbeats every idle cycle via _hb lines.              │
│  Idle exit: 30 min of no new data → clean shutdown.     │
│  Startup grace: 60s before idle exit can fire.          │
└────────────┬────────────────────────────────────────────┘
             │  tag file (fs.watch / inotify)
             ▼
┌─────────────────────────────────────────────────────────┐
│  wtft --watch (TUI consumer)                             │
│  Reads initial classified entries from tag file, then   │
│  watches for changes via fs.watch. Renders full chart   │
│  on every new data event + per-minute timeline refresh. │
│  Monitors daemon health via PID file + _hb heartbeat.   │
│  'r' key restarts the log parser (5s fast-poll after).  │
└─────────────────────────────────────────────────────────┘
```

**Why daemon + fs.watch, not polling:**
- Polling directly on session.jsonl required re-parsing classified data on every tick
- The daemon does the expensive classification once, consumers read pre-computed entries
- `fs.watch` on the tag file gives zero-latency updates vs. 667ms poll worst-case
- Same classified tag file format works across Pi (in-memory) and CLI (daemon-backed)

## Log Parser Lifecycle

| Event | Behavior |
|---|---|
| `wtft` or `wtft --watch` invoked | Auto-spawns daemon if not already running (singleton via PID file) |
| New session data arrives | Daemon parses, classifies, flushes to tag file at 90bpm throttle |
| No new data for 30 min | Daemon cleanly exits ("idle timeout") |
| Daemon just spawned (< 60s) | Idle exit suppressed (startup grace period) |
| Session file deleted | Daemon exits ("session removed") |
| Press `r` in `--watch` | Kills stale daemon, spawns fresh, fast-polls health at 1s × 5 |

## Terminal Layout (watch mode)

```
Row 1:  sessionPath  (dim)
Row 2:  💸 WTF Tokens?  (24h timeline)  ● live  (green/red/yellow)
Row 3:  [legend: Spec, Mixed, Code, Tests, Research, Git, Grep, Prompt, Other]
Row 4+: ticks line (if --ticks), date dividers, bucket rows
Footer: q/Ctrl+C to exit, r to restart log parser  (r in red when daemon dead)
```

The daemon status indicator is appended inline to the title line if it fits within terminal width; otherwise it wraps to a separate line between title and legend.

## Daemon Status States

| State | Indicator | Trigger |
|---|---|---|
| Alive | `🟢 live` (green) | PID alive |
| Dead | `🔴 stopped HH:MM` (red) | PID dead, last _hb timestamp shown |
| Restarting | `🟡 restarting...` (yellow) | User pressed `r`, waiting for daemon to come online |

Health is checked:
- 10s after `--watch` startup
- Every 60s on the minute-boundary re-render
- After pressing `r`: every 1s for 5s (fast-poll)

## Pi Widget Integration

The Pi `/wtft` widget also spawns a log parser daemon on `session_start`, using `ctx.sessionManager.getSessionFile()` to determine the session path. This keeps the wtft-tag file warm for CLI use. The widget renders its own daemon status indicator on the title line (inline or wrapped), using the same `checkDaemonHealth`/`getTagPath` functions.

## SIGWINCH (terminal resize)

Handler calls `render()` directly. Daemon status indicator reflows — may move from inline to separate line or vice versa depending on available width.

## SIGINT / 'q'

Clears alt screen, restores cursor, prints final chart + summary line.

## Edge Cases

| Situation | Handling |
|---|---|
| Daemon exits (idle timeout) | Title shows `● stopped HH:MM` in red; footer shows red `r to restart log parser` |
| User presses `r` | Daemon restarts, status shows `● restarting...`, clears to `● live` within 5s |
| Tag file deleted/truncated | `fs.watch` handler re-reads from zero |
| Daemon never started | PID check fails, status shows "log parser not found" |
| Terminal too narrow for inline status | Status wraps to separate line between title and legend |
| Session file gone | Daemon exits cleanly; TUI continues showing last-known data with stopped indicator |

## Verification

1. Start `wtft --watch` → confirm `● live` on title line
2. `kill <daemon-pid>` → within 60s, title shows `● stopped HH:MM` in red
3. Press `r` → status shows `● restarting...`, clears to `● live` within 5s
4. Wait 30+ min with no session activity → daemon exits, title shows stopped indicator
5. Run `wtft --list` → shows running parsers with idle times
6. Pi `/wtft` widget → shows `● live` on title line
7. Terminal resize → status reflows correctly (inline vs. separate line)

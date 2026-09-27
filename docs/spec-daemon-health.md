# DaemonHealth — is this session's log parser daemon alive, idle or stopped

The live spec for `extensions/lib/daemon-health.ts`. A behaviour change in this module edits this
file; the per-issue specs behind it are change records (§6). Vocabulary: `CONTEXT.md` (Lease,
Daemon, Session, Tag).

Module: `extensions/lib/daemon-health.ts` · Seam: `decideHealth`, tested in `tests/wtft-270-daemon-health.test.ts`

## 1. Interface

| Export | What it is |
|---|---|
| `readHealthFacts(sessionPath, pidPath, tagPath) → HealthFacts` | The adapter: one lease read, the tag's last 8 KiB, the session file's mtime, and a thunk for the session's model |
| `decideHealth(facts, now) → DaemonStatus` | The pure decision (§2). No I/O except the model thunk |
| `DaemonHealthReason` | The machine-readable codes (§3). Control flow compares these |
| `DAEMON_REASON_TEXT`, `daemonReasonText` | Display text per code. No control flow reads it |
| `IDLE_THRESHOLD_MS` | 122,000 (2m2s) |
| `getModelCacheTtlMs(model)` | A cache-TTL guess from a model name; `null` for a local model |

`health(sessionPath, now, {tagPath?})` in `extensions/lib/wtft-daemon-lib.ts` composes the two over
the session's own lease and tag path. These readers use it:

- the Pi widget (`getDaemonStatus`, which answers `not-started` until it has spawned a daemon);
- `--watch` and `ensureDaemonRunning`;
- the CLI's startup wait (`awaitDaemonUp`), which does not ask `decideHealth`: it applies §2's `alive` rule itself and reads `readHealthFacts` over the current-version tag for a heartbeat of its own child;
- `wtft-daemon --list`'s idle column, which runs `decideHealth` over the row's own lease with no model read.

## 2. The decision

`alive` is the lease fact and nothing else: `holdsLease(classifyPid(pid))` from
`extensions/lib/holder.ts` (`docs/spec-297-holder-module.md`), so a live process that is not a
daemon holds no lease. A `rebuild` token (`wtft -F` on a harness session) names no pid, so it reads
as no live holder until the daemon adopts the session. No clock window sets `alive`; the spawner
claims the lease for its child at spawn.

| Lease | Session file | Tag | Answer |
|---|---|---|---|
| alive | absent | any | `alive`, `reason: waiting-session` |
| alive | present | non-empty, and its tail idle ≥ `IDLE_THRESHOLD_MS` or the session mtime that old | `alive`, `idle`, `idleMs`, `idleSinceMs`, `cacheTtlMs` |
| alive | present | otherwise, or unreadable | `alive` |
| dead | any | a heartbeat with a `last` in the tail | `reason: idle-timeout`, `lastHbMs`, `lastHbTime` from the newest such heartbeat |
| dead | any | otherwise | `reason: not-found` |

- **Tail** is the tag's last 8 KiB.
- **Tail idle** is the `first` of the newest heartbeat after the newest record that is neither a
  heartbeat nor a stop, raised to that record's `t` when it is a later turn. A `first` of 0 counts
  as none.
- **`cacheTtlMs`** is the recorded TTL of the newest tail turn carrying one (`1h` → 3,600,000,
  `5m` → 300,000), else `getModelCacheTtlMs` of the newest tail turn naming a model, else of the
  session file's last assistant model (read only then), else `null`.

## 3. Reason codes

`DaemonHealthReason` is the contract. Adding a member is a feature; renaming or removing one is a
breaking change. The text beside each is free to change. Nothing outside this repo reads the
codes, so `starting`, which nothing had set since spec-281, was deleted rather than kept.

| Code | Set by | Meaning |
|---|---|---|
| `not-started` | the widget's `getDaemonStatus` | no daemon spawned for this session yet |
| `waiting-session` | `decideHealth` | a live holder, no session file yet |
| `not-found` | `decideHealth` | no live holder and no heartbeat with a `last` |
| `idle-timeout` | `decideHealth` | no live holder, however it stopped; `lastHbTime` says when it last beat |
| `restart-failed` | `--watch` | `r` could not stop the holder or start a new daemon |

## 4. What a reader shows

`renderDaemonStatus` in `extensions/lib/wtft-daemon-lib.ts` turns a `DaemonStatus` into the
coloured indicator. The list of what it can show, with colours and meanings, is
`docs/manifests/wtft-status.json`, rendered on `docs/EXT_WTFT.html` and pinned to the code by
`tests/wtft-278-status-manifest.test.ts`.

## 5. Tests

- `tests/wtft-270-daemon-health.test.ts`: `decideHealth` along each axis of §2 with no process
  spawned, and `health` over temp files for the adapter.
- `tests/wtft-179-daemon-health-reason.test.ts`: the codes, their text, and a spawned stand-in's
  status from spawn to exit.
- `tests/wtft-278-status-manifest.test.ts`: §4.

## 6. Change records

These describe how the module got here, and each says so in its header. They are history, not
spec; where one disagrees with this file, this file is current.

- `docs/spec-179-daemon-health-reason-codes.md` — the reason became a code.
- `docs/spec-270-daemon-health.md` — S5 made one decision for every reader.

## 7. Related

Live specs this module reads from, not replaced by it: spec-281 (the spawner claims the lease,
`docs/spec-281-spawner-claims-lease.md`) and spec-297 (what holds a lease,
`docs/spec-297-holder-module.md`).

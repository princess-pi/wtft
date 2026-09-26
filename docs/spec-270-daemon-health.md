# Spec 270 S5 — DaemonHealth

Issue: https://github.com/princess-pi/wtft/issues/270, slice S5 of
`docs/spec-270-daemon-ownership.md` §3b. The parent spec's rows for S5 are the commitment; this
document is the design and the closer. Vocabulary: the `codebase-design` skill's (module,
interface, seam, adapter) and `CONTEXT.md`.

## 1. What moves, and what the seam is

On `main` @ `c8f2071` "is the daemon alive" (R4 in the parent spec §2) has four answers:

- `checkDaemonHealth(sessionPath, tagPath)` — the lease pid answers `kill 0`; then a scan of the
  tag's last 8 KiB for idle (T4 `first` against the last T1 `t`, else the session file's mtime)
  and the cache TTL; when dead, the last heartbeat's `last` decides `idle-timeout` or
  `not-found`.
- `getDaemonStatus` (widget) — adds `waiting-session` for a live lease with no session file, a
  5 s grace after its own spawn (only over `not-found`), and a 2 s tag-mtime grace that reports
  a dead lease as alive and idle.
- `watchTagFile`'s `updateDaemonHealth` (`--watch`) — its own 2 s tag-mtime grace, which keeps
  the previous answer, and a `restarting` flag held until the lease is alive.
- `wtft-daemon --list` — `kill 0` on the lease pid for RUNNING, and an idle age from the mtime of
  the first tag file `readdir` returns. The heartbeat's in-place write moves that mtime every
  poll, so a live daemon reads a few seconds idle however long its session has been quiet.

**DaemonHealth** (`extensions/lib/daemon-health.ts`) is one decision over one set of facts:

```ts
export interface HealthFacts {
  holderAlive: boolean;                    // the lease pid answers kill 0
  tag: { size: number; mtimeMs: number; tail: TagRecord[] } | null;   // last 8 KiB; null: no tag
  sessionMtimeMs: number | null;           // null: no session file
  sessionModel: () => string | undefined;  // read only when an idle answer needs a TTL
}
export interface HealthOptions { tagPath?: string; spawnedAt?: number | null }
export function readHealthFacts(sessionPath, pidPath, tagPath): HealthFacts;   // the fs adapter
export function decideHealth(facts, now, opts?): DaemonStatus;                  // pure
export function health(sessionPath, now, opts?): DaemonStatus;                  // in wtft-daemon-lib
```

`DaemonStatus`, `DaemonHealthReason`, `DAEMON_REASON_TEXT`, `daemonReasonText`,
`IDLE_THRESHOLD_MS` and `getModelCacheTtlMs` move into the module; `wtft-daemon-lib.ts`
re-exports them, so its importers and `tests/wtft-179-daemon-health-reason.test.ts` are
unchanged. `health` lives in `wtft-daemon-lib.ts` because the lease and tag paths
(`getDaemonPidPath`, `getTagPath`) do. `daemon-health.ts` imports `node:fs`, `lease.ts` and
`tag-log.ts`; `tag-log.ts` already imports `classifiedToInteraction` from `wtft-daemon-lib.ts`, so
the module sits on that existing cycle rather than opening a new one, and every cross-module use is
inside a function, so load order does not matter. `checkDaemonHealth` is removed; every caller calls
`health`.

## 2. The one answer

`alive` is the lease fact and nothing else: a live process holds this session's lease. No grace
sets it. `awaitDaemonUp`, `ensureDaemonRunning` and `watchTagFile`'s wait for the tag file read
`alive` and nothing else, so they see what they saw before.

| Lease | Session file | Tag | Caller spawned < 5 s ago | Answer |
|---|---|---|---|---|
| alive | absent | any | any | `alive`, `reason: waiting-session` |
| alive | present | non-empty, and its tail idle ≥ `IDLE_THRESHOLD_MS` or the session mtime that old | any | `alive`, `idle`, `idleMs`, `idleSinceMs`, `cacheTtlMs` |
| alive | present | otherwise, or unreadable | any | `alive` |
| dead | any | any | yes | `reason: waiting-session` with no session file, else `starting` |
| dead | any | size > 0, mtime < 2 s ago | no | `reason: starting` |
| dead | any | a heartbeat with a `last` in the tail | no | `reason: idle-timeout`, `lastHbMs`, `lastHbTime` from the newest such heartbeat |
| dead | any | otherwise | no | `reason: not-found` |

"Tail" is the tag's last 8 KiB. Tail idle is the `first` of the newest heartbeat after the newest
record that is neither a heartbeat nor a stop (any kind: turn, offset, sweep, fold, generation),
raised to that record's `t` when it is a later turn; a `first` of 0 counts as none. `cacheTtlMs`
is the recorded TTL of the newest tail turn carrying one (`1h` → 3,600,000, `5m` → 300,000),
else `getModelCacheTtlMs` of the newest tail turn naming a model, else of the session file's last
assistant model (read only then), else `null`. The widget's `getDaemonStatus` answers
`not-started` until it has spawned a daemon, then passes its last spawn's time as `spawnedAt`.

Behaviour that changes, each in the direction of one rule for every reader:

- **The 2 s tag-mtime grace answers `starting`, not alive.** The widget reported a dead lease
  as `alive, idle`; `--watch` kept whatever it showed last. Both now show `starting...` until the
  lease is claimed or the 2 s pass. The widget applied it only after its own spawn; now every
  reader does.
- **The spawn grace covers every dead answer, not only `not-found`.** After a spawn over a tag
  with an old heartbeat, the widget showed `stopped HH:MM` until the new daemon claimed the
  lease; now `starting...`.
- **`waiting-session` for a live lease with no session file** comes from `health`, so `--watch`
  shows it too; it was the widget's alone.
- **`--watch`'s `r` restart uses the spawn grace.** On `main` the `restarting` flag was cleared
  only by a live lease, polled once a second five times; with none by then, the view showed
  `starting...` for as long as it ran. Now the restart passes its time as `spawnedAt` and the
  view shows what `health` finds from the first ask; the five-poll interval is gone, and the
  watchdog asks as it does at any other time. `--watch` started with a daemon it just spawned
  passes its own start time the same way.
- **`waiting-session` in `--watch`** renders only once there are chart lines; before that
  `--watch` prints its waiting line instead.
- **`--watch`'s idle countdown counts from `idleSinceMs` at each render**, as the widget's
  did; it counted from the `idleMs` of the last health check.
- **`wtft-daemon --list`'s idle age is the session's idle age.** A row whose holder names a
  `--session` (resolved against the holder's cwd) whose lease is that row's lease gets its idle
  column from `health` of that session: the time since `idleSinceMs`
  while idle, `0s` while live, the time since `lastHbMs` when `health` has one, else `?` (`waiting-session` included). Any
  other row prints `?`. RUNNING
  and DEAD are unchanged and are not `health`'s: they are `--list`'s own `kill 0`. Which session a
  harness-held lease line names is #276.

## 3. Closer

- `tests/wtft-270-daemon-health.test.ts`: `decideHealth` at hand-picked points along each axis
  (lease alive or dead; tag absent, empty, freshly written, turn only, idle heartbeat, clamped
  heartbeat, heartbeat with `last` or `first` only, stop after a heartbeat; inside and outside
  each grace; session file present, absent, old), with no process spawned, and `health` over temp
  files (this process as the lease holder) for the adapter. It is not the full product of the
  axes.
- `tests/wtft-179-daemon-health-reason.test.ts` unchanged and passing.
- The widget (`getDaemonStatus`), `--watch` (`updateDaemonHealth`), `awaitDaemonUp`,
  `ensureDaemonRunning` and `wtft-daemon --list`'s idle column call `health`; `grep checkDaemonHealth` over
  `bin/` and `extensions/` finds nothing.
- The golden tags suite (S0) and the daemon suites pass unchanged.

## 4. Decisions made while building, and roads not taken

- **`alive` stays `kill 0` on the lease pid; #266 stays standing.** #266 is `wtft -F` signalling
  a pid it has not verified is a `wtft-daemon`, off Linux. Folding a process-identity check into
  `alive` would make `alive` false for every suite that stands in for a daemon with its own pid
  (`wtft-daemon-lifecycle`, `wtft-179`, `wtft-308`), and it is a signalling question, not a
  health one. *Road not taken:* an identity-checked `alive`, which would close #266 here at the
  cost of rewriting those fixtures.
- **The interface returns `DaemonStatus`, not `{ alive, idle, since, reason }`.** The parent
  spec's plan named a `since`; `DaemonStatus` already carries `idleSinceMs`, and
  `renderDaemonStatus` and the 179 suite read its field names. One field is added:
  `lastHbMs`, the dead holder's last heartbeat, which `--list` needs and `lastHbTime` was
  formatted from.
- **The graces answer with a reason, never with `alive`.** `awaitDaemonUp` treats `alive` as
  "the lease is claimed"; a grace that set it would report a daemon up before it claimed
  anything. *Road not taken:* a separate `shown` field for display, which would have put two
  liveness answers back on the interface.
- **`decideHealth` is pure and `readHealthFacts` is its adapter.** The matrix in §3 is facts in
  memory, so it runs with no daemon and no clock. The session model is a thunk so the whole
  session file is read only when an idle answer needs a TTL and the tail names neither a TTL nor
  a model, as on `main`.

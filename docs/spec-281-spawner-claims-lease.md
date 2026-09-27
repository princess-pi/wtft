# Spec 281 — the spawner claims the lease

Issue: https://github.com/princess-pi/wtft/issues/281 (design approved by Duppy 2026-09-26). It
builds on spec-270 S5 (`docs/spec-270-daemon-health.md`), whose `decideHealth` held both clock rules
this removes. Vocabulary: `CONTEXT.md` (Lease, Daemon, Session).

## 1. The gap, and the change

A daemon claims its session's lease as one of its first acts. Between `spawn()` returning in the
reader and that claim, the lease names nobody, so health read "dead". S5 masked the gap with two
grace periods in `decideHealth`:
- **Spawn grace:** 5 s after the caller's own spawn (`spawnedAt`, passed by the widget and by
  `--watch` for its startup spawn and after `r`). It answered `waiting-session` with no session
  file, else `starting`.
- **Tag-write grace:** 2 s after a non-empty tag was written, for every reader. It answered
  `starting`.

**The change:** every place that spawns a daemon claims the session's lease for the child's pid
the moment `spawn()` returns, through one helper:

```ts
// extensions/lib/lease.ts
export function pidAlive(pid: number): boolean;
export function claimLeaseForChild(file: string, childPid: number): "claimed" | "busy";
```

- **Alive:** `pidAlive` is true when `kill 0` accepts the pid or refuses it with EPERM (a live
  process of another user), and `/proc/<pid>/stat` does not show a zombie (where `/proc` is
  absent, `kill 0` alone decides). A spawner's child that has exited stays a zombie until the
  spawner's event loop reaps it. `claimLeaseForChild`,
  `readHealthFacts` and `restartDaemon`'s wait all use `pidAlive`.
- **What it claims:** `claimLease(file, String(childPid), holderIsLive)`, where `holderIsLive`
  answers true for `rebuild` and for a holder that is a pid (`leasePid`: `/^[1-9]\d*$/`, the
  per-session child's own rule, which `readHealthFacts`, `restartDaemon` and `awaitDaemonUp`
  also use; a harness child's adoption reads the holder with `Number`, #290) and `pidAlive`. So it takes an absent, empty, non-pid or dead-pid lease, answers
  `claimed` for one already naming the child, and leaves a `rebuild` token and a live holder
  alone. The child then meets those two as it would without the claim.
- **A child already gone:** if the child is not `pidAlive` once the claim lands, the helper
  unlinks it again and answers `busy`.
- **Callers:** `spawnWtftDaemon` (the widget, `--watch`, the CLI startup, and `wtft -F` over a
  `rebuild` lease), `restartDaemon` (`--watch`'s `r`) and `wtft-daemon --restart`. Each ignores a
  throw: the child then claims for itself, as before.
- **The child, per-session:** `claimLease` already answers `claimed` for a lease naming its own
  `owner`. The newer-version check that runs before it skips a lease naming the child itself, so
  a child beside a newer tag with no other live daemon holding the lease serves, as it did
  before. When another live daemon holds the lease beside a newer tag, the child exits 0. The
  holder is not checked to be the newer version.
- **The child, harness:** adoption (`takeOverLease`) already returns true for
  `holder === process.pid`. A `--harness` start that exits before serving (missing root,
  `--session` outside the root, a sixth busy answer for the root pid file) unlinks a lease still
  naming it. The hand-off exit runs the same unlink, which finds the lease already republished.
- **The one trap:** a `--harness` start that finds a live harness points the session at it
  (`pointSessionAt`). That function published the harness pid only when
  `held || !procIsDaemon(holder)`. A lease naming the starting process is a live daemon that is
  not the harness, so it would be left naming a process about to exit. `pointSessionAt` now
  also publishes when `holder === process.pid`.
- **Restart:**
  - `restartDaemon` sends SIGTERM to a lease holder whose cmdline has no `--harness`, and waits
    up to 2 s for it to stop being `pidAlive`. If it is still alive it sends SIGKILL and waits up
    to 2 s more. Only then does it spawn and claim; it no longer unlinks the lease itself, and
    the claim takes a dead holder's lease. A holder alive after both waits,
    including one it may not signal (EPERM), is left alone: `restartDaemon` returns false and
    `--watch` shows `restart-failed`. The old order was signal, unlink, spawn at once, which let
    the child start while the old daemon was still flushing into the same tag.
  - `restartDaemon` does not check that the holder is a daemon before signalling it, and off
    Linux it cannot tell a harness either (#289). A harness holder is never signalled on Linux;
    the spawn points it at the session.
  - `wtft-daemon --restart` already waited before this change, for every live daemon holder,
    harness included: SIGTERM, 2 s, SIGKILL, then up to 2 s while the pid is still a daemon. A holder
    still a daemon after that now keeps its lease, is not respawned, and prints `Not stopped`. It now also claims for the child it
    respawns, which serves the holder's own `--session`, without unlinking that lease first; a
    harness's other leases are unlinked. Its output line says how the respawn went (below).
  - The wait is async: the caller's event loop runs, so a holder that is its own child is reaped
    on any OS (off Linux `pidAlive` cannot see a zombie), and `--watch` keeps rendering. A
    second `r` during a restart is ignored, and `q` or Ctrl+C exits only once the restart has
    spawned, so a stopped daemon is never left without its replacement.
  - `wtft-daemon --restart` prints `Restarted` only when its claim for the respawn landed,
    `Respawned … left to claim the lease itself` when the claim was busy or threw with the child
    alive, and `the respawn … failed` when no child is alive.
  - The gap left is the time between the old daemon's exit and `spawn()` returning. That is not a
    clock rule. Health reports the daemon stopped for that time, which is true.
- **The startup wait:** `awaitDaemonUp` used to treat any live lease holder as up. A lease naming
  its own child now proves only that the child is alive, so for that holder "up" also needs a
  heartbeat record in the last 8 KiB of the current-version tag with `last` at or after the
  wait's start. Any other live holder is up at once, as before. When the child exits without
  being up, the wait unlinks the claim made for it and answers `dead`. The one-shot call with
  ceiling 0 (`extensions/lib/cli/report.ts`, after a tag wait of up to about 2 s, skipped when the first read found data) can answer `unknown` for a child whose beats
  all predate it; the CLI prints the same "no data yet" line for `unknown` and `up`.

**Then both grace periods go.** `HealthOptions.spawnedAt`, `SPAWN_GRACE_MS` and
`TAG_WRITE_GRACE_MS` are deleted, and `decideHealth(facts, now)` takes no options.
`getDaemonStatus` and `--watch` stop passing a spawn time. `decideHealth` never answers
`starting`. The reason code stays in the `DaemonHealthReason` union (#179 contract: removing a
member is a breaking change), and `renderDaemonStatus` still renders it for a caller that sets it.

`--watch` counts the daemon dead exactly when health says not alive. Before, `starting` and
`waiting-session` did not count as dead.

## 2. Behaviour after the change

| Moment | Before (S5) | After |
|---|---|---|
| Just spawned, child not yet at its claim | the widget and `--watch`: `starting` (or `waiting-session` with no session file) for up to 5 s; other readers: `not-found` or `stopped` | the claim landed: alive (`waiting-session` with no session file); the claim was `busy` on `rebuild`: `not-found` or `stopped` until the child adopts; `busy` on a live holder: that holder's health |
| Child exits without serving (crash, bad args) | for the spawner, `starting` (or `waiting-session`) until 5 s pass | `not-found` or `stopped HH:MM`; a crash with nobody waiting leaves the claim naming a dead pid, read as dead |
| A daemon that really stopped, tag written under 2 s ago | `starting` for up to 2 s | `stopped HH:MM` at once, or `not-found` when the tag tail has no heartbeat |
| A reader that did not spawn, during another reader's spawn | `stopped` / `not-found` unless the tag was written under 2 s ago | alive, when the claim landed |
| `--watch` `r` on a per-session daemon | `starting` up to 5 s | while the old one exits (up to 4 s) the view shows it alive, then stopped, then the new daemon alive; other readers see the old daemon alive, `stopped` only between its exit and the new claim |
| Spawn with a `rebuild` lease | the child reads `rebuild` and rebuilds | unchanged: the spawner leaves `rebuild` for the child |
| Spawn over a live holder | the child exits busy, takes the lease over when an older-version tag exists, or (a harness start) hands off, or takes a per-session holder's lease by SIGTERM (`takeOverLease`) | unchanged: the spawner claims nothing |
| `ensureDaemonRunning` called twice in one process within one spawn | the second call spawned again; the second child lost the claim and exited | when the first claim landed, the second call finds the lease alive and does not spawn (#261 lead O). Over a `rebuild` lease it still spawns again, and a first call in another process spawns without reading the lease |

## 3. Closer

- `tests/wtft-281-spawner-claims-lease.test.ts`:
  - **C1:** `claimLeaseForChild` over {absent, empty, dead pid, `rebuild`, live pid}. It claims
    the first three and leaves the last two, byte for byte. **C1f:** a reaped child is not left
    named. **C1g:** nor is an exited child not yet reaped (a zombie). **C1h:** a holder with a
    leading zero is taken, as the child takes it. **C1i:** health reads that holder as no pid.
  - **C2:** `spawnWtftDaemon` with a stand-in daemon that claims nothing. The lease names the
    child's pid when `spawn` returns, and the stand-in's first line finds its own pid there.
  - **C3:** a `--harness` start that finds a live harness ends with the lease naming the harness
    pid (the `pointSessionAt` trap). The harness is stopped with SIGSTOP so it cannot adopt the
    lease itself, which is what makes the check fail without the fix.
  - **C4:** `restartDaemon` on a per-session daemon. The new daemon starts only after the old one
    has exited, and the lease names the new daemon when `restartDaemon` returns.
  - **C4b:** a holder that ignores SIGTERM is gone when `restartDaemon` returns.
  - **C4c:** a holder that is the caller's own child (a zombie once it exits) is replaced, not
    reported `restart-failed`.
  - **C4e:** the caller's event loop runs during the wait and reaps its own exited child.
  - **C4d:** a holder the caller may not signal (pid 1, EPERM) is left alone and the restart
    fails. Skipped when run as root.
  - **C6:** a per-session child beside a newer-version tag, with the lease naming itself, is
    alive and holds the lease 1.5 s later.
  - **C7:** a `--harness` start whose root does not exist leaves no lease naming it.
  - **C9:** `q` pressed during an `r` restart in `--watch` still leaves a live new daemon holding
    the lease.
  - **C8:** after `wtft-daemon --restart` returns, the lease names the live respawned daemon.
- `tests/wtft-308-lagging-session.test.ts` §7 d–f cover `awaitDaemonUp` with the lease naming
  its child: a beat from before the wait answers `unknown`, a beat during the wait answers `up`,
  and a child that exits answers `dead` and leaves no lease.
- `tests/wtft-270-daemon-health.test.ts` has no `spawnedAt` and no tag-write-grace case, and
  asserts that a dead lease with a fresh tag answers `idle-timeout` or `not-found`. **F4a:** a
  lease naming pid 1 (EPERM to `kill 0`) reads alive; it asserts nothing when run as root.
- `tests/wtft-179-daemon-health-reason.test.ts` V3 is rewritten, because the grace it tested is
  gone. With a stand-in that lives 1.5 s: `waiting-session` right after the spawn with no session
  file; alive right after a spawn with one; `not-found` once the second stand-in has exited.
  V1, V2 and V4 are unchanged.
- `grep -rn "SPAWN_GRACE_MS\|TAG_WRITE_GRACE_MS\|spawnedAt" extensions bin` finds nothing.
- The golden tags suite and the daemon suites pass unchanged.

## 4. Decisions made while building, and roads not taken

- **The spawner claims only what the child would claim anyway.** A `rebuild` token and a live
  holder are left alone, so every rule the child applies to them stays in one place (the
  child). *Road not taken:* the spawner replacing a live holder, which would have made the
  reader decide version takeovers.
- **One liveness rule, `pidAlive`, for the claim, health and `restartDaemon`'s wait.** They
  disagreed on EPERM and on zombies until the audit found it; each disagreement produced a wrong answer (a restart
  beside a live holder, a restart that failed on its own child). The restart wait is also
  async, which reaps the caller's own child where `/proc` cannot show a zombie. The
  child's own claim, `--restart`'s wait, `-F`'s wait and `--list` still use a bare `kill 0`
  (#290).
- **The restart does not rename over the old lease.** The approved design had both restart
  paths rename the new pid over the old, so the lease is never absent. The old daemon's own
  shutdown unlinks its lease on SIGTERM, so after it exits the lease is absent whatever the
  restarter does. Keeping it present would need a placeholder holder during the stop, which
  health would read as alive while nothing serves. Absent and naming a dead pid read the same
  to every reader. So the restarter stops unlinking and claims after the spawn, and the gap
  between the old daemon's exit and the claim stays, reported truthfully as stopped. *Road not
  taken:* the placeholder, measured as a failing check (the lease was absent on thousands of
  reads during `--restart`) before this was decided.
- **Restart waits for the old daemon, and kills one that will not go.** Up to 4 s of waiting
  beats two writers on one tag. *Roads not taken:* swapping the lease to the child
  before the old daemon exits, which leaves no gap but runs both at once; and spawning after 2 s
  regardless, which the first cut did and the audit caught.
- **The startup wait asks for a heartbeat from its own child.** A claimed lease no longer proves
  the daemon started, so `awaitDaemonUp` needs a sign of work. The heartbeat must postdate the
  wait's start, so a previous daemon's last beat cannot pass for the new one's.
- **Whoever claimed for a child that will not serve takes the claim back:** the helper for a
  child already dead, the startup wait for one that exited, the harness start for itself.
  A crash with nobody waiting leaves the claim naming a dead pid, which every reader reads as
  dead. A recycled pid would read as alive; that hazard predates this change and is #289.
- **`starting` is not re-derived from the start heartbeat.** The approved design had it mean "a
  live holder that has not written its start heartbeat yet". A daemon beats once at start
  (ownership spec T4), so that state lasts about as long as the daemon's boot, and only the
  startup wait acts on it; it asks for the heartbeat itself. Every other reader shows the
  claimed daemon as alive. *Road not taken:* a tag-derived `starting` in `decideHealth`, which
  would put a heartbeat read into every health answer for a state readers do not act on.
- **`starting` stays in the union and leaves `decideHealth`.** Deleting the member would break
  the #179 contract for any reader that compares it.

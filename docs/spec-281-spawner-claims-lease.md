# Spec 281 — the spawner claims the lease

Issue: https://github.com/princess-pi/wtft/issues/281 (design approved by Duppy 2026-09-26). It
builds on #270 S5 (`docs/spec-270-daemon-health.md`), whose `decideHealth` held both windows
this removes. Vocabulary: `CONTEXT.md` (Lease, Daemon, Session).

## 1. The gap, and the change

A daemon claims its session's lease as one of its first acts. Between `spawn()` returning in the
reader and that claim, the lease names nobody, so health read "dead". S5 masked the gap with two
clock windows in `decideHealth`:
- **Spawn window:** 5 s after the caller's own spawn (`spawnedAt`, passed only by the widget and
  by `--watch` after `r`). It answered `waiting-session` with no session file, else `starting`.
- **Tag-write window:** 2 s after a non-empty tag was written, for every reader. It answered
  `starting`.

**The change:** every place that spawns a daemon claims the session's lease for the child's pid
the moment `spawn()` returns, through one helper:

```ts
// extensions/lib/lease.ts
export function claimLeaseForChild(file: string, childPid: number): "claimed" | "busy";
```

- **What it claims:** `claimLease(file, String(childPid), holderIsLive)`, where `holderIsLive`
  answers true for `rebuild` and for a pid that `kill 0` accepts or refuses with EPERM (a live
  process of another user). So it takes an absent, empty, non-numeric or dead-pid lease, and
  leaves a `rebuild` token and a live holder alone. The child then meets those two as it would
  without the claim.
- **A child already gone:** if the child is dead once the claim lands, the helper unlinks it
  again and answers `busy`. No lease is left naming a pid that never ran.
- **Callers:** `spawnWtftDaemon` (the widget, `--watch`, the CLI startup), `restartDaemon`
  (`--watch`'s `r`) and `wtft-daemon --restart`. Each ignores a throw: the child then claims for
  itself, as before.
- **The child, per-session:** `claimLease` already answers `claimed` for a lease naming its own
  `owner`. The newer-version check that runs before it skips a lease naming the child itself, so
  a child beside a newer tag with no live newer holder serves, as it did before. When a live
  newer holder does own the session, the child unlinks the claim made for it and exits 0.
- **The child, harness:** adoption (`takeOverLease`) already returns true for
  `holder === process.pid`. A `--harness` start that exits before serving (missing root,
  `--session` outside the root, root pid file busy 5 times) unlinks the claim made for it.
- **The one trap:** a `--harness` start that finds a live harness points the session at it
  (`pointSessionAt`). That function published the harness pid only when
  `held || !procIsDaemon(holder)`. A lease naming the starting process is a live daemon that is
  not the harness, so it would be left naming a process about to exit. `pointSessionAt` now
  also publishes when `holder === process.pid`.
- **Restart:**
  - `restartDaemon` sends SIGTERM to a per-session holder and waits up to 2 s. If the holder is
    still alive it sends SIGKILL and waits up to 2 s more. Only then does it unlink, spawn and
    claim. A holder alive after both waits is left alone: `restartDaemon` returns false and
    `--watch` shows `restart-failed`. The old order was signal, unlink, spawn at once, which let
    the child start while the old daemon was still flushing into the same tag.
  - `restartDaemon` does not check that the per-session holder is a daemon before signalling it
    (#289). A harness holder is never signalled; the spawn points it at the session.
  - `wtft-daemon --restart` already waited (SIGTERM, 2 s, SIGKILL, 2 s) before this change, for
    every live daemon holder, harness included. It now also claims for the child it respawns.
  - The wait blocks the caller: `--watch` neither renders nor reads keys for up to 4 s.
  - The gap left is the time between the old daemon's exit and `spawn()` returning. That is not a
    clock window. Health reports the daemon stopped for that time, which is true.
- **The startup wait:** `awaitDaemonUp` used to treat any live lease holder as up. A lease naming
  its own child now proves only that the child is alive, so for that holder "up" also needs a
  heartbeat in the current-version tag with `last` at or after the wait's start. Any other live
  holder is up at once, as before. When the child exits without being up, the wait unlinks the
  claim made for it and answers `dead`.

**Then both windows go.** `HealthOptions.spawnedAt`, `SPAWN_GRACE_MS` and `TAG_WRITE_GRACE_MS`
are deleted, and `decideHealth(facts, now)` takes no options. `getDaemonStatus` and `--watch` stop
passing a spawn time. `decideHealth` never answers `starting`. The reason code stays in the
`DaemonHealthReason` union (#179 contract: removing a member is a breaking change), and
`renderDaemonStatus` still renders it for a caller that sets it.

`--watch` counts the daemon dead exactly when health says not alive. Before, `starting` and
`waiting-session` did not count as dead.

## 2. Behaviour after the change

| Moment | Before (S5) | After |
|---|---|---|
| Just spawned, child not yet at its claim | the widget and `--watch` after `r`: `starting` (or `waiting-session` with no session file) for up to 5 s; other readers: `not-found` or `stopped` | the claim landed: alive (`waiting-session` with no session file); the claim was `busy` on `rebuild`: `not-found` or `stopped` until the child adopts; `busy` on a live holder: that holder's health |
| Child exits without serving (crash, bad args) | `starting` until 5 s pass, for the spawner | `not-found` or `stopped HH:MM` at the next ask; a crash leaves the claim naming a dead pid, read as dead |
| A daemon that really stopped, tag written under 2 s ago | `starting` for up to 2 s | `stopped HH:MM` at once, or `not-found` when the tag tail has no heartbeat |
| A reader that did not spawn, during another reader's spawn | `stopped` / `not-found` unless the tag was written under 2 s ago | alive, when the claim landed |
| `--watch` `r` on a per-session daemon | `starting` up to 5 s | the view is frozen while the old one exits (up to 4 s), then alive; other readers see the old daemon alive, `stopped` only between its exit and the new claim |
| Spawn with a `rebuild` lease | the child reads `rebuild` and rebuilds | unchanged: the spawner leaves `rebuild` for the child |
| Spawn over a live holder | the child exits busy | unchanged: the spawner claims nothing |
| `ensureDaemonRunning` called twice in one process within one spawn | the second call spawned again; the second child lost the claim and exited | the second call finds the lease alive and does not spawn (#261 lead O). A first call in another process still spawns without reading the lease |

## 3. Closer

- `tests/wtft-281-spawner-claims-lease.test.ts`:
  - **C1:** `claimLeaseForChild` over {absent, empty, dead pid, `rebuild`, live pid}. It claims
    the first three and leaves the last two, byte for byte. **C1f:** a child already dead is
    not left named.
  - **C2:** `spawnWtftDaemon` with a stand-in daemon that claims nothing. The lease names the
    child's pid when `spawn` returns, and the stand-in's first line finds its own pid there.
  - **C3:** a `--harness` start that finds a live harness ends with the lease naming the harness
    pid (the `pointSessionAt` trap). The harness is stopped with SIGSTOP so it cannot adopt the
    lease itself, which is what makes the check fail without the fix.
  - **C4:** `restartDaemon` on a per-session daemon. The new daemon starts only after the old one
    has exited, and the lease names the new daemon when `restartDaemon` returns.
  - **C4b:** a holder that ignores SIGTERM is gone when `restartDaemon` returns.
  - **C6:** a per-session child beside a newer-version tag, with the lease naming itself, is
    alive and holds the lease 1.5 s later.
  - **C7:** a `--harness` start whose root does not exist leaves no lease naming it.
  - **C8:** after `wtft-daemon --restart` returns, the lease names the live respawned daemon.
- `tests/wtft-308-lagging-session.test.ts` §7 d–f cover `awaitDaemonUp` with the lease naming
  its child: a beat from before the wait answers `unknown`, a beat during the wait answers `up`,
  and a child that exits answers `dead` and leaves no lease.
- `tests/wtft-270-daemon-health.test.ts` has no `spawnedAt` and no tag-write-window case, and
  asserts that a dead lease with a fresh tag answers `idle-timeout` or `not-found`. **F4a:** a
  lease naming pid 1 (EPERM to `kill 0`) reads alive.
- `tests/wtft-179-daemon-health-reason.test.ts` V3 is rewritten, because the window it tested is
  gone. With a stand-in that lives 1.5 s, `waiting-session` holds while it lives with no session
  file; with a session file the answer is alive; after it exits, `not-found`. V1, V2 and V4 are
  unchanged.
- `grep -rn "SPAWN_GRACE_MS\|TAG_WRITE_GRACE_MS\|spawnedAt" extensions bin` finds nothing.
- The golden tags suite and the daemon suites pass unchanged.

## 4. Decisions made while building, and roads not taken

- **The spawner claims only what the child would claim anyway.** A `rebuild` token and a live
  holder are left alone, so every rule the child applies to them stays in one place (the
  child). *Road not taken:* the spawner replacing a live holder, which would have made the
  reader decide version takeovers.
- **Restart waits for the old daemon, and kills one that will not go.** Up to 4 s of a frozen
  `--watch` beats two writers on one tag. *Roads not taken:* swapping the lease to the child
  before the old daemon exits, which leaves no gap but runs both at once; and spawning after 2 s
  regardless, which the first cut did and the audit caught.
- **The startup wait asks for a heartbeat from its own child.** A claimed lease no longer proves
  the daemon started, so `awaitDaemonUp` needs a sign of work. The heartbeat must postdate the
  wait's start, so a previous daemon's last beat cannot pass for the new one's.
- **Whoever claimed for a child that will not serve takes the claim back:** the helper for a
  child already dead, the startup wait for one that exited, the harness start for itself.
  A crash with nobody waiting leaves the claim naming a dead pid, which every reader reads as
  dead. A recycled pid would read as alive; that hazard predates #281 and is #289.
- **`starting` stays in the union and leaves `decideHealth`.** Deleting the member would break
  the #179 contract for any reader that compares it.

# Spec 281 — the spawner claims the lease

Issue: https://github.com/princess-pi/wtft/issues/281 (design approved by Duppy 2026-09-26). It
builds on #270 S5 (`docs/spec-270-daemon-health.md`), whose `decideHealth` holds both windows
this removes. Vocabulary: `CONTEXT.md` (Lease, Daemon, Session).

## 1. The gap, and the change

A daemon claims its session's lease as one of its first acts. Between `spawn()` returning in the
reader and that claim, the lease names nobody, so health reads "dead". S5 masks the gap with two
clock windows in `decideHealth`: 5 s after the caller's own spawn (`spawnedAt`), and 2 s after a
non-empty tag was written. Both answer `starting`.

**The change:** every place that spawns a daemon claims the session's lease for the child's pid
the moment `spawn()` returns, through one helper:

```ts
// extensions/lib/lease.ts
export function claimLeaseForChild(file: string, childPid: number): "claimed" | "busy";
```

- **What it claims:** `claimLease(file, String(childPid), holderIsLive)`, where `holderIsLive`
  answers true for `rebuild` and for any pid `kill 0` accepts. So it takes an absent, empty or
  dead-pid lease, and leaves a `rebuild` token and a live holder alone. The child then meets
  them as it does today.
- **The child:** `claimLease` already answers `claimed` for a lease naming its own `owner`, and
  harness adoption (`takeOverLease`) already returns true for `holder === process.pid`. No
  change there.
- **The one trap:** a `--harness` start that finds a live harness points the session at it
  (`pointSessionAt`). That function publishes the harness pid only when `held || !procIsDaemon(holder)`.
  A lease naming the starting child itself is a live daemon that is not the harness, so it
  would be left naming a process about to exit. `pointSessionAt` also treats
  `holder === process.pid` as its own.
- **Restart:** `restartDaemon` (`--watch`'s `r`) and `wtft-daemon --restart` stop a per-session
  holder, wait for it to exit (up to 2 s, as `-F` does), then spawn and claim. The old order
  (signal, unlink, spawn at once) let the child start while the old daemon was still flushing
  into the same tag. The wait closes that overlap. The gap left is the time between the old
  daemon's exit and `spawn()` returning. That is not a clock window: health reports the
  daemon stopped for that time, which is true.

**Then both windows go.** `HealthOptions.spawnedAt`, `SPAWN_GRACE_MS` and `TAG_WRITE_GRACE_MS`
are deleted. `getDaemonStatus` and `--watch` stop passing a spawn time. `decideHealth` no longer
answers `starting`. The reason code stays in the `DaemonHealthReason` union (#179 contract:
removing a member is a breaking change). `renderDaemonStatus` still renders it for a caller
that sets it.

## 2. Behaviour after the change

| Moment | Before (S5) | After |
|---|---|---|
| Just spawned, child not yet at its claim | `starting` for up to 5 s (the spawner only) | alive: the lease names the child |
| Child exits without serving (crash, bad args) | `starting` until 5 s pass | `not-found` or `stopped HH:MM` at the next ask |
| A daemon that really stopped, tag written under 2 s ago | `starting` for up to 2 s | `stopped HH:MM` at once |
| A reader that did not spawn, during another reader's spawn | `stopped` / `not-found` unless the tag was written under 2 s ago | alive |
| `--watch` `r` on a per-session daemon | `starting` up to 5 s | `stopped HH:MM` while the old one exits, then alive |
| Spawn with a `rebuild` lease | the child reads `rebuild` and rebuilds | unchanged: the spawner leaves `rebuild` for the child |
| Spawn over a live holder | the child exits busy | unchanged: the spawner claims nothing |
| `ensureDaemonRunning` called twice within one spawn | spawns twice; the second child loses the claim and exits | the second call finds the lease alive and does not spawn (#261 lead O) |

## 3. Closer

- `tests/wtft-281-spawner-claims-lease.test.ts`:
  - **C1:** `claimLeaseForChild` over {absent, empty, dead pid, `rebuild`, live pid}. It claims
    the first three and leaves the last two, byte for byte.
  - **C2:** `spawnWtftDaemon` with a stand-in daemon that sleeps and claims nothing. The lease
    names the child's pid when `spawn` returns, and the stand-in's first line, which reads the
    lease and writes what it found to a file, finds its own pid there.
  - **C3:** a `--harness` start that finds a live harness ends with the lease naming the harness
    pid (the `pointSessionAt` trap). Process-level, sandboxed.
  - **C4:** `restartDaemon` on a per-session daemon: the old pid has exited before the new
    lease is written, and the lease names the new child.
- `tests/wtft-270-daemon-health.test.ts` has no `spawnedAt` and no tag-write-grace case, and
  asserts that a dead lease with a fresh tag answers `idle-timeout` or `not-found`.
- `tests/wtft-179-daemon-health-reason.test.ts` V3 is rewritten, because the window it tests is
  gone. With a stand-in that sleeps, `waiting-session` holds while it lives with no session file;
  with a session file the answer is alive; after it exits, `not-found`. There is no sleep past
  a clock window. V1, V2 and V4 are unchanged.
- `grep -rn "SPAWN_GRACE_MS\|TAG_WRITE_GRACE_MS\|spawnedAt" extensions bin` finds nothing.
- The golden tags suite and the daemon suites pass unchanged.

## 4. Decisions made while building, and roads not taken

- **The spawner claims only what the child would claim anyway.** A `rebuild` token and a live
  holder are left alone, so every rule the child applies to them stays in one place (the
  child). *Road not taken:* the spawner replacing a live holder, which would have made the
  reader decide version takeovers.
- **Restart waits for the old daemon.** A few milliseconds of an honest `stopped` beat two
  writers on one tag. *Road not taken:* swapping the lease to the child before the old daemon
  exits, which leaves no gap but runs both at once.
- **`starting` stays in the union and leaves `decideHealth`.** Deleting the member would break
  the #179 contract for any reader that compares it.

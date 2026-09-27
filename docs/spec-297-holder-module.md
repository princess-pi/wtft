# Spec 297: one holder module behind a process-table port

A lease names a pid. Before this spec, each caller decided for itself whether that pid is a live
daemon. The callers used about ten different rules: a bare `kill 0`, `kill 0` with EPERM counted
as alive, `pidAlive`, and `/proc/<pid>/cmdline` checks with and without `kill 0`. Every #281
regression came through the differences between them. This spec puts the whole decision in
`extensions/lib/holder.ts`, behind a port that a test can replace with an in-memory process
table.

*Make vs buy:* the bundles may import only `node:` builtins (CLAUDE.md), so a process-listing
package is not an option. The port is about 60 lines over `process.kill`, `/proc` and `spawn`.

## 1. The port

```ts
interface ProcessTable {
  signal(pid, sig: 0 | "SIGTERM" | "SIGKILL"): "sent" | "gone" | "denied"; // ESRCH gone, EPERM denied
  state(pid): "running" | "zombie" | "gone" | null;  // null: this host cannot tell (no /proc)
  cmdline(pid): string[] | null;                      // null: unreadable
  spawn(command, args, env): number;                  // detached, unref'd; 0 when it failed
}
```

- **Production:** `linuxProcessTable`. Off Linux, `state` and `cmdline` are always `null`.
- **Tests:** `fakeProcessTable()` in `tests/lib/fake-process-table.ts`. A test adds processes with
  a cmdline and says how each one reacts to a signal: it dies, it ignores SIGTERM, it becomes a
  zombie, or it refuses (EPERM). Its `spawn` creates a live daemon entry.
- `useProcessTable(table)` swaps the table in and returns a function that restores the previous
  one. Production code never calls it. `processTable()` returns the current table.

## 2. The decision

`classifyPid(pid)` returns one `HolderKind`:

| Kind | When |
|---|---|
| `gone` | `signal 0` says gone, or `state` says zombie or gone (a process that exits between the two reads). A pid that is not a positive safe integer is `gone` too |
| `daemon` | alive, and its cmdline names `wtft-daemon` (`.mjs`, `.js`, `.ts` or bare) without `--harness` |
| `harness` | alive, and its cmdline names `wtft-daemon` with `--harness` |
| `other` | alive, and its cmdline is readable and names something else. A recycled pid lands here |
| `unverified` | alive, but its cmdline cannot be read. This is always the case off Linux |

"Alive" means `signal 0` was sent or denied, and `state` does not say otherwise. EPERM is another
user's live process.

Three rules cover every caller:
- `holdsLease(kind)`: `daemon`, `harness` or `unverified`. A lease naming such a pid is not
  stale. `other` is stale: that process is not the daemon the lease was written for. Used by
  health, the startup wait, the spawner's claim, the per-session child's claim, the newer-tag
  check, `--list`, `--cleanup` and the reaper.
- `mayStop(kind)`: `daemon` or `unverified`. These are the only kinds a one-session caller
  (`restartDaemon`, `-F`) signals. A harness is never stopped on behalf of one session.
- **A verified daemon:** `daemon` or `harness`, with the cmdline read. The harness's own claims
  (`holderIsLiveDaemon`, `takeOverLease`, the root claim, `pointSessionAt`) and the daemon
  management commands act only on these. `--restart` stops a harness as well, as its `--help`
  says. Off Linux nothing is verified, so these callers do nothing there, as before.

An `other` is never signalled by anyone.

`leasePid(holder)` (`/^[1-9]\d*$/`) stays the only way a lease's text becomes a pid.

## 3. Stopping

`stopHolder(pid, opts)` sends SIGTERM and waits up to `termMs` (2000 ms) for `classifyPid` to
say `gone`. If the pid is still there, it sends SIGKILL and waits up to `killMs` (2000 ms) more.
The wait yields to the event loop, so a holder that is the caller's own child gets reaped.
`stopHolderSync` is the same without yielding, for the daemon's synchronous paths. Both return:
- `stopped`: gone before the time ran out;
- `denied`: a signal was refused. A refused SIGTERM returns at once; a refused SIGKILL returns after the SIGTERM wait;
- `survived`: still there after SIGKILL.

## 4. Callers, and what changes for each

Slice 1 (`extensions/lib/`) and slice 2 (`bin/wtft-daemon.ts`) are two commits in one PR. They
cannot be two PRs, because a branch starts only from main, and slice 2 needs slice 1.

| Caller | Was | Is now | Behaviour change |
|---|---|---|---|
| `readHealthFacts`, and `awaitDaemonUp`'s lease check | `pidAlive` | `holdsLease(classifyPid)` | **C1:** a lease naming a recycled, non-daemon pid reads not alive, so the widget respawns and the startup wait does not call it up (#289) |
| `claimLeaseForChild` | live by `pidAlive` | `holdsLease` | **C2:** the spawner's claim displaces a lease naming a non-daemon pid |
| `restartDaemon` | SIGTERM/SIGKILL any non-harness pid | `mayStop`, then `stopHolder` | **C3:** a non-daemon pid is not signalled; the claim for the new child displaces it (#289). An EPERM holder returns false, as a survivor does |
| `forceRebuildSession` (`-F`) | cmdline, then bare `kill 0` wait | `classifyPid`, then `stopHolderSync` without SIGKILL | **C4:** the wait counts EPERM as alive, and an `other` holder is neither signalled nor waited for (#290 J) |
| slice 2: the per-session child's claim | any live pid keeps the lease | `holdsLease` | **C5:** a recycled pid or a zombie no longer keeps a session unserved (#290 J) |
| slice 2: `holderIsLiveDaemon`, `takeOverLease`, harness root claim, `pointSessionAt` | `Number()` + `kill 0` + cmdline | `leasePid` + `classifyPid` | **C6:** `0123` is not pid 123 (#290 K) |
| slice 2: `--restart`, `--cleanup`, `--stop`; `waitUntilExited` is gone | bare `kill 0`, `parseInt` | `leasePid`, `classifyPid`; `--restart` waits with `stopHolderSync`, `--cleanup` and `--stop` signal once | **C7:** EPERM is alive. A lease or root pid file whose daemon refuses the signal is left in place, and the line says "Not stopped: PID n refused the signal (EPERM)". It used to be removed, with "no live daemon found", "Stopped" or "Cleaned up" (#290 J). A harness still running after SIGKILL keeps its root pid file too |
| slice 2: `--list` RUNNING/DEAD | bare `kill 0` | `holdsLease` | **C8:** the column agrees with health on EPERM, zombies and recycled pids (#290 A) |
| slice 2: `reapAndWarn` | ESRCH only | `holdsLease(classifyPid)` | **C9:** a lease naming a zombie, or a live process that is not a daemon, is unlinked |
| slice 2: the newer-tag check at startup | `Number()` + `liveDaemonOrUnknown` | `leasePid` + `holdsLease(classifyPid)` | **C10:** a `0123` holder no longer counts, and on Linux a live pid whose cmdline cannot be read now keeps the session for the newer build |

## 5. Verification

- `tests/wtft-297-holder.test.ts`, entirely in memory:
  - each `HolderKind` from the fake table, off Linux included;
  - `stopHolder`'s three outcomes;
  - C1 to C4 through the real callers with the fake table swapped in, with each test taking
    milliseconds.
- **Slice 2:** `tests/wtft-297-daemon-holders.test.ts` runs the real daemon, because
  `bin/wtft-daemon.ts` runs when it is imported. It covers:
  - C5: the child claims a lease naming a live `sleep`, and leaves it running;
  - C8: `--list` says DEAD for that lease;
  - the closer: no `process.kill(` in `bin/*.ts` or `extensions/**` outside
    `extensions/lib/holder.ts`.
- **C6, C7 and C9 have no test of their own.** Their sites now call `leasePid`, `classifyPid`
  and `stopHolderSync`, which the in-memory suite covers. An EPERM daemon needs a second user,
  which the test host does not have.
- **The process-level suites keep running real processes.** They used any live process as a
  stand-in holder, which is exactly what C1 to C3 now reject. So each stand-in's script is now
  named `wtft-daemon.mjs` (`tests/lib/stand-in-daemon.ts`). A suite that used the test process
  itself as the holder swaps in the fake table instead: `useProcessTable` is re-exported from
  `bin/wtft.ts` for suites that import the bundle. #281's C4d, where pid 1 is the EPERM holder,
  moved to the in-memory C3: pid 1 is not a daemon, so it is no longer an EPERM daemon case.
- #277's record for each PR goes into its body, compared with #281's (spec-277 §7: $53.38 over
  401 turns).

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
| `gone` | `signal 0` says gone, or `state` says zombie. A pid that is not a positive safe integer is `gone` too |
| `daemon` | alive, and its cmdline names `wtft-daemon` (`.mjs`, `.js`, `.ts` or bare) without `--harness` |
| `harness` | alive, and its cmdline names `wtft-daemon` with `--harness` |
| `other` | alive, and its cmdline is readable and names something else. A recycled pid lands here |
| `unverified` | alive, but its cmdline cannot be read. This is always the case off Linux |

"Alive" means `signal 0` was sent or denied. EPERM is another user's live process.

Two predicates cover every caller:
- `holdsLease(kind)`: `daemon`, `harness` or `unverified`. A lease naming such a pid is not
  stale. `other` is stale: that process is not the daemon the lease was written for.
- `mayStop(kind)`: `daemon` or `unverified`. Only these get signalled. A harness is never stopped
  on behalf of one session, and an `other` is never signalled at all.

`leasePid(holder)` (`/^[1-9]\d*$/`) stays the only way a lease's text becomes a pid.

## 3. Stopping

`stopHolder(pid, opts)` sends SIGTERM and waits up to `termMs` (2000 ms) for `classifyPid` to
say `gone`. If the pid is still there, it sends SIGKILL and waits up to `killMs` (2000 ms) more.
The wait yields to the event loop, so a holder that is the caller's own child gets reaped.
`stopHolderSync` is the same without yielding, for the daemon's synchronous paths. Both return:
- `stopped`: gone before the time ran out;
- `denied`: the signal was refused, and nothing was waited for;
- `survived`: still there after SIGKILL.

## 4. Callers, and what changes for each

Slice 1 (`extensions/lib/`) and slice 2 (`bin/wtft-daemon.ts`) are separate PRs, and this
issue closes with slice 2.

| Caller | Was | Is now | Behaviour change |
|---|---|---|---|
| `readHealthFacts`, and `awaitDaemonUp`'s lease check | `pidAlive` | `holdsLease(classifyPid)` | **C1:** a lease naming a recycled, non-daemon pid reads not alive, so the widget respawns and the startup wait does not call it up (#289) |
| `claimLeaseForChild` | live by `pidAlive` | `holdsLease` | **C2:** the spawner's claim displaces a lease naming a non-daemon pid |
| `restartDaemon` | SIGTERM/SIGKILL any non-harness pid | `mayStop`, then `stopHolder` | **C3:** a non-daemon pid is not signalled; the claim for the new child displaces it (#289). An EPERM holder returns false, as a survivor does |
| `forceRebuildSession` (`-F`) | cmdline, then bare `kill 0` wait | `classifyPid`, then `stopHolderSync` without SIGKILL | **C4:** the wait counts EPERM as alive, and an `other` holder is neither signalled nor waited for (#290 J) |
| slice 2: the per-session child's claim | any live pid keeps the lease | `holdsLease` | **C5:** a recycled pid or a zombie no longer keeps a session unserved (#290 J) |
| slice 2: `holderIsLiveDaemon`, `takeOverLease`, harness root claim, `pointSessionAt` | `Number()` + `kill 0` + cmdline | `leasePid` + `classifyPid` | **C6:** `0123` is not pid 123 (#290 K) |
| slice 2: `--restart`, `--cleanup`, `--stop`, `waitUntilExited` | bare `kill 0` | `classifyPid`, `stopHolderSync` | **C7:** EPERM is alive. Another user's daemon is reported "Not stopped" and keeps its lease, where it used to have its lease removed with "no live daemon found" (#290 J) |
| slice 2: `--list` RUNNING/DEAD | bare `kill 0` | `holdsLease` | **C8:** the column agrees with health on EPERM, zombies and recycled pids (#290 A) |
| slice 2: `reapAndWarn` | ESRCH only | `classifyPid` | **C9:** a zombie holder's lease is unlinked |

## 5. Verification

- `tests/wtft-297-holder.test.ts`, entirely in memory:
  - each `HolderKind` from the fake table, off Linux included;
  - `stopHolder`'s three outcomes;
  - C1 to C4 through the real callers with the fake table swapped in, with each test taking
    milliseconds.
- **Slice 2 adds:** C5 to C9. The closer is that `grep` finds no `process.kill(` outside
  `extensions/lib/holder.ts`.
- **The process-level suites keep running real processes.** They used any live process as a
  stand-in holder, which is exactly what C1 to C3 now reject. So each stand-in's script is now
  named `wtft-daemon.mjs` (`tests/lib/stand-in-daemon.ts`). A suite that used the test process
  itself as the holder swaps in the fake table instead: `useProcessTable` is re-exported from
  `bin/wtft.ts` for suites that import the bundle. #281's C4d, where pid 1 is the EPERM holder,
  moved to the in-memory C3: pid 1 is not a daemon, so it is no longer an EPERM daemon case.
- #277's record for each PR goes into its body, compared with #281's (spec-277 §7: $53.38 over
  401 turns).

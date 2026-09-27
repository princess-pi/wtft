# Holder — who a lease's pid is

The live spec for `extensions/lib/holder.ts`. A behaviour change in this module edits this file;
the per-issue specs behind it are change records (§6). Vocabulary: `CONTEXT.md` (Lease, Daemon,
Harness).

Module: `extensions/lib/holder.ts` · Seam: `classifyPid`, tested in `tests/wtft-297-holder.test.ts`

Every liveness and identity decision about a lease holder is made here, over a process-table port
a test replaces. The bundles import only `node:` builtins, so the port is a thin layer over
`process.kill`, `/proc` and `spawn` rather than a process-listing package.

## 1. The port

```ts
interface ProcessTable {
  signal(pid, sig: 0 | "SIGTERM" | "SIGKILL"): "sent" | "gone" | "denied"; // ESRCH gone, EPERM denied
  state(pid): "running" | "zombie" | "gone" | null;  // null: this host cannot tell, or /proc/<pid>/stat is unreadable
  cmdline(pid): string[] | null;                      // null: unreadable
  inspectable(): boolean;                             // a /proc to read at all
  startTime(pid): string | null;                      // changes when the pid is reused
  spawn(command, args, env): number;                  // detached, unref'd; 0 when it failed
}
```

- **Production:** `linuxProcessTable`. Off Linux, `state`, `cmdline` and `startTime` are always `null`.
- **Tests:** `fakeProcessTable()` in `tests/lib/fake-process-table.ts`. A test adds processes with
  a cmdline and says how each reacts to a signal: it dies, it ignores SIGTERM, it becomes a
  zombie, or it refuses (EPERM). Its `spawn` creates a live entry with the given command line,
  which is a daemon when it names `wtft-daemon`.
- `useProcessTable(table)` swaps the table in and returns a function that restores the previous
  one. Production code never calls it. `processTable()` returns the current table.

## 2. The decision

`classifyPid(pid)` returns one `HolderKind`:

| Kind | When |
|---|---|
| `gone` | `signal 0` says gone, or `state` says gone or zombie. An unreadable `/proc/<pid>/stat` (hidepid) is not evidence either way, so `signal 0` decides. A pid that is not a positive safe integer is `gone` too |
| `daemon` | alive, and its cmdline names `wtft-daemon` (`.mjs`, `.js`, `.ts` or bare) without `--harness` |
| `harness` | alive, and its cmdline names `wtft-daemon` with `--harness` |
| `other` | alive, and its cmdline is readable and names something else. A recycled pid lands here |
| `unverified` | alive, but its cmdline cannot be read. This is always the case off Linux |

"Alive" means `signal 0` was sent or denied, and `state` does not say otherwise. EPERM is another
user's live process. `pidAlive(pid)` is `classifyPid(pid) !== "gone"`.

Three rules cover every caller:
- **`holdsLease(kind)`:** `daemon`, `harness` or `unverified`. A lease naming such a pid is not
  stale. `other` is stale: that process is not the daemon the lease was written for. Health
  (`docs/spec-daemon-health.md`), the startup wait, the spawner's claim, the per-session child's
  claim, the newer-tag check, `--list`, `--cleanup` and the reaper use it.
- **`mayStop(kind)`:** `daemon`, or `unverified` on a host with no `/proc` at all (off Linux).
  These are the only kinds a one-session caller (`restartDaemon`, `-F`) signals. On Linux an
  `unverified` pid (hidepid) may be anything, so it is never signalled. A harness is never
  stopped on behalf of one session.
- **A verified daemon:** `daemon` or `harness`, with the cmdline read. The harness's own claims
  and the daemon management commands act only on these. `--restart` stops a harness as well. Off
  Linux nothing is verified, so these callers stop nothing there; `--restart` still removes the
  leases and root pid files.

An `other` is never signalled by anyone. `leasePid(holder)` in `extensions/lib/lease.ts`
(`/^[1-9]\d*$/`, else 0) is the only way a lease's text becomes a pid.

## 3. Stopping

`stopHolder(pid, opts)` sends SIGTERM and waits up to `termMs` (2000 ms) for `classifyPid` to
say `gone`. If the pid is still there, it sends SIGKILL and waits up to `killMs` (2000 ms) more;
`killMs: 0` skips SIGKILL. The wait yields to the event loop, so a holder that is the caller's own
child gets reaped. `stopHolderSync` is the same without yielding, for the daemon's synchronous
paths. Before SIGKILL it checks the pid is still the process it signalled: the same kind and the
same start time. If either changed, the pid was reused during the wait, and nothing more is sent.

Both return:
- `stopped`: gone before the time ran out;
- `denied`: a signal was refused. A refused SIGTERM returns at once; a refused SIGKILL returns
  after the SIGTERM wait;
- `survived`: still there after SIGKILL.

## 4. Tests

- `tests/wtft-297-holder.test.ts`, in memory: each `HolderKind` from the fake table, off Linux
  included; `stopHolder`'s outcomes; the callers (health, the startup wait, the spawner's claim,
  `restartDaemon`, `-F`) with the fake table swapped in.
- `tests/wtft-297-daemon-holders.test.ts` runs the real daemon for the per-session child's claim
  and `--list`, and checks that no product code outside this module calls `process.kill(`.

## 5. Related

`docs/spec-daemon-health.md` reads `holdsLease(classifyPid)` as `alive`.
`docs/spec-281-spawner-claims-lease.md` is the spawner's claim, which uses `holdsLease`.

## 6. Change records

These describe how the module got here, and each says so in its header. Where one disagrees with
this file, this file is current.

- `docs/spec-297-holder-module.md` — one holder module replaced about ten liveness rules; its §4
  lists what changed for each caller.

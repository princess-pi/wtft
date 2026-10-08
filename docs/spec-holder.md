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
  psCmdline(pid): string[] | null;                    // `ps -o command=`, split on whitespace; for a host with no /proc
  startTime(pid): string | null;                      // changes when the pid is reused
  spawn(command, args, env): number;                  // detached, unref'd, stderr to docs/spec-daemon-log.md's log; 0 when it failed
}
```

- **Production:** `linuxProcessTable`. Off Linux, `state`, `cmdline` and `startTime` are always `null`; `psCmdline` still reads.
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
| `gone` | `signal 0` says gone, or `state` says zombie (a test's table may also say gone). An unreadable `/proc/<pid>/stat` (hidepid) is not evidence either way, so `signal 0` decides. A pid that is not a positive safe integer is `gone` too |
| `daemon` | alive, and its cmdline names `wtft-daemon` (`.mjs`, `.js`, `.ts` or bare) without `--harness` |
| `harness` | alive, and its cmdline names `wtft-daemon` with `--harness` |
| `other` | alive, and its cmdline is readable and names something else. A recycled pid lands here |
| `unverified` | alive, but its cmdline cannot be read. This is always the case off Linux; `verifiedKind` below reads it again for two callers |

"Names `wtft-daemon`" means the program's basename is one, or the program's basename starts with
`node`, `nodejs` or `bun` and its script's basename is one. The script is the first argument that
is not an option and not `run`; the value of `-r`, `--require`, `--import`, `--preload`, `--loader`
and `--experimental-loader` is skipped. Inline code (`--eval`, `--print`, their `=` forms, or a
short option starting a cluster that holds `e` or `p`) means there is no script. So
`node app.js --input /tmp/wtft-daemon.js` and `vim wtft-daemon.ts` are `other`. Off Linux the
`ps` command line is split on whitespace and cannot be read by position, so there any word naming
`wtft-daemon` counts.

`isFixtureDaemon({ session, roots }, tmpDir)` is `--cleanup`'s rule for a test's leftover: the
session or a harness root is under `tmpDir`, the caller's `os.tmpdir()`. A test run gives each
suite its own `TMPDIR`, so a suite's `--cleanup` reaches only its own fixtures
(`tests/wtft-96-fixture-daemons.test.ts`).

`decideUnleased(proc, { tmpDir, cleanup, stopSession })` is what `--cleanup` and `--stop` do with
a daemon from the process table that holds no lease in `tmpDir`: `clean` under `--cleanup` for a
per-session fixture (`isFixtureDaemon`) or a sandboxed harness, else `stop` for a per-session
daemon whose resolved `--session` is `stopSession`, else `keep`. "Sandboxed" and the daemon's own
tmp dir are defined in `docs/spec-387-private-tmpdir.md`.

"Alive" means `signal 0` was sent or denied, and `state` does not say otherwise. EPERM is another
user's live process. `pidAlive(pid)` is `classifyPid(pid) !== "gone"`.

Three rules cover every caller:
- **`holdsLease(kind)`:** `daemon`, `harness` or `unverified`. A lease naming such a pid is not
  stale. `other` is stale: that process is not the daemon the lease was written for. Health
  (`docs/spec-daemon-health.md`), the startup wait, the spawner's claim, the per-session child's
  claim, the newer-tag check, `--list`, `--cleanup` and the reaper use it.
- **`mayStop(kind)`:** `daemon` only: the one kind a one-session caller (`restartDaemon`, `-F`)
  signals. Those two classify with **`verifiedKind(pid)`**: `classifyPid`, except that on a host
  with no `/proc` an `unverified` pid is read again through `psCmdline`. A pid still `unverified`
  may be anything, so it is never signalled, on any host; `-F` then answers `busy` and
  `restartDaemon` fails. On Linux a harness is never stopped on behalf of one session; with no
  `/proc` a harness start cannot hand it the session, so there it is stopped like a daemon, with
  no SIGKILL, since a reused pid cannot be told apart. An `other` holder's lease is removed.
- **A verified daemon:** `daemon` or `harness`, with the cmdline read. The harness's own claims
  and the daemon management commands signal only these. `--restart` stops a harness as well. They
  use `classifyPid` alone, so off Linux they verify nothing and stop nothing. Removing a lease is not
  signalling: `--stop` removes the lease of any live non-harness holder, `--cleanup` that of an
  `unverified` holder whose session is gone, and `--restart` removes the leases and root pid files
  off Linux too.

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
- `tests/wtft-387-private-tmpdir.test.ts`: `decideUnleased` in memory, then real daemons in tmp
  dirs of their own stopped by `--stop` and `--cleanup`.

## 5. Related

`docs/spec-daemon-health.md` reads `holdsLease(classifyPid)` as `alive`.
`docs/spec-281-spawner-claims-lease.md` is the spawner's claim, which uses `holdsLease`.

## 6. Change records

These describe how the module got here, and each says so in its header. Where one disagrees with
this file, this file is current.

- `docs/spec-297-holder-module.md` — one holder module replaced about ten liveness rules; its §4
  lists what changed for each caller.

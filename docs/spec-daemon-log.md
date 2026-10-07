# DaemonLog — where a detached daemon's stderr goes

The live spec for `extensions/lib/daemon-log.ts`. A behaviour change in this module edits this
file. Vocabulary: `CONTEXT.md` (Daemon, Harness).

Module: `extensions/lib/daemon-log.ts` · Seam: `rotateDaemonLog`, tested in `tests/wtft-260-daemon-log.test.ts`

Every daemon is spawned detached. Its stderr used to be `"ignore"`, so a harness's warnings,
hand-off failures included, reached no reader. Each spawn now appends the child's stderr to one
shared log; stdout stays ignored.

## 1. Interface

| Export | What it is |
|---|---|
| `DAEMON_LOG_MAX_BYTES` | 1,000,000 |
| `wtftStateDir(env = process.env)` | `$XDG_STATE_HOME/wtft`, defaulting to `~/.local/state/wtft`: the directory the two logs below live in, and the daemon roster's `roster/` subdirectory (`docs/spec-442-daemon-roster.md`) |
| `daemonLogPath(env = process.env)` | `$XDG_STATE_HOME/wtft/daemon.log`, defaulting to `~/.local/state/wtft/daemon.log` |
| `reapLogPath(env = process.env)` | `$XDG_STATE_HOME/wtft/reap.log`, defaulting to `~/.local/state/wtft/reap.log`: the reap warnings `reapAndWarn` appends and the CLI's `showReapWarnings` prints the last hour's lines of, truncating it when it printed any |
| `rotateDaemonLog(file, maxBytes)` | When `file` holds `maxBytes` or more: copies it to `file.1` (replacing any earlier one), then truncates `file` to 0. The copy is set to 0600. Otherwise does nothing, and a path that is not a regular file (a symlink included: it is not followed) is never rotated. Rotates only while holding `file.lock` (created exclusively), and checks the size again under it. A lock older than a minute is removed and raced for again; two takers of the same stale lock can still both rotate, the second copying a short file over `.1`, a window accepted as rare. Never throws |
| `daemonStdio(file?)` | Rotates, then opens `file` for append, creating its directory (mode 0700) and the file (0600), and setting an existing file to 0600: it holds session paths. Anything at the path that is not a regular file (a FIFO, a directory, a symlink) is left alone: opening a FIFO with no reader would block the spawn forever. Returns the `stdio` for a spawn, `["ignore", "ignore", fd]`, and a `close()` the spawner calls once the child has it. On any failure: `"ignore"`, as before |

- **Truncate, not rename.** Every daemon on the host appends to the same file with `O_APPEND`. A
  rename would leave the running ones writing into `file.1`; a truncate lets each one's next write
  land at the new end of `file`. A line written between the copy and the truncate is lost, which
  is the price of not coordinating writers.
- **When it rotates:** at every spawn, and in a running daemon at most once a minute, from every
  poll of every session it serves, so a harness that runs for days still keeps the file near 1 MB. That second call has
  no test of its own; it is the same `rotateDaemonLog`.

## 2. Spawn sites

All three spawn a daemon with `daemonStdio()`:
- `spawnWtftDaemon` (`extensions/lib/wtft-cli-shared.ts`): the CLI and the Pi widget;
- `restartDaemon` (`extensions/lib/wtft-daemon-lib.ts`), through the process-table port's
  `spawn` (`docs/spec-holder.md` §1): `--watch`'s `r`;
- `wtft-daemon --restart`'s respawn (`bin/wtft-daemon.ts`).

## 3. Tests

`tests/wtft-260-daemon-log.test.ts`:
- `rotateDaemonLog` below, at and above the cap, and twice (the second `.1` replaces the first);
  a held lock is left alone and a stale one taken over; a symlink's target is untouched; `.1` is 0600;
- `daemonStdio` on a FIFO returns `"ignore"` at once; it creates the file 0600 in a 0700 directory and tightens an existing one;
- `daemonLogPath` and `reapLogPath` under `XDG_STATE_HOME` and without it;
- a spawn through `spawnWtftDaemon` and `restartDaemon` whose stand-in daemon writes to stderr:
  the text is in the log. `--restart`'s respawn runs the real daemon, so it has no test here.

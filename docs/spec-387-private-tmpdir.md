# A daemon in another tmp dir can be stopped

Issue: https://github.com/princess-pi/wtft/issues/387 ·
Module: `extensions/lib/holder.ts` · Seam: `decideUnleased`, tested in
`tests/wtft-387-private-tmpdir.test.ts` · Also: `bin/wtft-daemon.ts`, the management pass

## Words

- **A daemon's tmp dir** is what `os.tmpdir()` gives in that daemon's environment (`TMPDIR`, `TMP`
  or `TEMP`, else `/tmp`), read from `/proc/<pid>/environ`. Its leases and root pid file live
  there. **Here** is the caller's own tmp dir. An unreadable environment gives no tmp dir.
- A daemon's tmp dir, root variables and `--session` are resolved against its working directory.
  When that cannot be read, only an absolute `--session` is kept, and it has no roots and no tmp
  dir. **Inside here** means here or under it.
- **A harness's roots** are its own harness's root variable only (`WTFT_CLAUDE_PROJECTS_DIR` for
  `claude`, `WTFT_PI_SESSIONS_DIR` for `pi`, none for any other name); a per-session daemon's are
  both, when set.
- **A sandboxed harness** has a tmp dir inside here that is not here itself, sets its root
  variable inside here, and has a `--session` inside here or none.

## Behaviour

On Linux (`/proc`), a per-session daemon that `--list` shows can be stopped by `--stop` on the
session it shows, and a sandboxed harness by `--cleanup`:

- **S1. `--stop <session>` stops a per-session daemon that holds no lease here,** found in the
  process table by its `--session`. It is sent SIGTERM without a wait and reported
  `Stopped: PID <pid> — <session>`; the daemon removes its own lease as it exits. One that
  refuses the signal (EPERM) is reported `Not stopped` and the command exits 1. A harness is not
  stopped this way: its `--session` is only the session it was started for.
- **S2. `--cleanup` sends SIGTERM to a sandboxed harness that holds no lease here,** reported
  `Cleaned up: PID <pid> — fixture daemon: <where>`, like the per-session fixtures it already
  stops. A harness that is not sandboxed is still never sent a signal by `--cleanup`.
- **S3. `--restart --pid <pid>` also reaches that pid's leases and root pid file in its own tmp
  dir**, and in that dir only the files naming it. Like every respawn, its respawn runs with the
  holder's `TMPDIR`, `TMP` and `TEMP` as well as its root variables and `XDG_STATE_HOME`; its
  lease is claimed, and the settle check reads it, in the dir the old one was found in.
  `Not found: PID <pid> — holds no lease or root pid file here or in its own tmp dir`, which
  makes the command exit 1, is printed for a pid found in neither.
- **S4. A `--list` row for a per-session daemon holding no lease here names its `--session`
  resolved against its working directory**, as a lease row already does, so the session `--stop`
  takes is the one `--list` printed. A harness's row names its root (`harness <root>`), never its
  start-up `--session`.
- **S5. `--restart` takes precedence in the process-table pass too.** Its respawns are judged
  before that pass runs. A daemon `--restart` reaches through a root pid file, a respawn it
  started, and a harness a respawn handed its session to are not listed by `--list`, cleaned by
  `--cleanup` or stopped by `--stop` in the same command.

The process-table pass signals a pid only when `classifyPid` still reads it as a daemon or a
harness and its start time is the one the scan read; a pid gone by the signal is not reported. `--list`, `--cleanup`, `--stop`, and `--restart` without `--pid` still read leases and
root pid files only here.

## Test

`tests/wtft-387-private-tmpdir.test.ts`:
- in memory, `decideUnleased` over each case of S1 and S2, the inverse cases included (a harness
  with no root variable, one whose tmp dir is here, a session outside here);
- with real daemons, each with its own tmp dir inside the suite's: a per-session daemon gone
  within 5 s of `--stop <its session>` and a harness gone within 5 s of `--cleanup`, then `--list`
  printing no line for either; a per-session daemon restarted by `--restart --pid --list`, exit 0,
  its respawn holding the lease in that tmp dir, running with it, and not listed; under
  `--restart --pid --cleanup`, a sandboxed harness holding a lease restarted once with its respawn
  left running, one found only through its root pid file stopped once, by `--restart`, and one a
  respawn hands its session to left running.

## Roads not taken

- **Reading every daemon's tmp dir for every flag:** `--restart` without `--pid` would reach
  every test suite's fixture daemons on the host, which each suite's own tmp dir keeps apart.
- **Stopping a harness on `--stop` of its start-up session:** a harness serves other sessions,
  and `--stop` drops one session.

# A daemon in another tmp dir can be stopped

Issue: https://github.com/princess-pi/wtft/issues/387 ·
Module: `bin/wtft-daemon.ts` (the management pass) · Seam: `decideUnleased` in
`extensions/lib/holder.ts`, tested in `tests/wtft-387-private-tmpdir.test.ts`

## Words

- **A daemon's tmp dir** is what `os.tmpdir()` gives in that daemon's environment (`TMPDIR`, `TMP`
  or `TEMP`, else `/tmp`), read from `/proc/<pid>/environ`. Its leases and root pid file live
  there. **Here** is the caller's own tmp dir. An unreadable environment gives no tmp dir.
- **A sandboxed daemon** has a tmp dir inside here and not here itself, sets at least one root
  variable (`WTFT_CLAUDE_PROJECTS_DIR`, `WTFT_PI_SESSIONS_DIR`) and has every one it sets inside
  here, and has a `--session` inside here or none.

## Behaviour

`--list` already shows every daemon in the process table, whatever its tmp dir. Each one it shows
can now be stopped by one command:

- **S1. `--stop <session>` stops a per-session daemon that holds no lease here,** found in the
  process table by its `--session` resolved against its working directory. It is sent SIGTERM
  without a wait and reported `Stopped: PID <pid> — <session>`; the daemon removes its own lease
  as it exits. One that refuses the signal (EPERM) is reported `Not stopped` and the command exits
  1. A harness is not stopped this way: its `--session` is only the session it was started for.
- **S2. `--cleanup` sends SIGTERM to a sandboxed harness that holds no lease here,** reported as a
  fixture daemon, like the per-session fixtures it already stops. A harness whose tmp dir is here,
  or that is not sandboxed, is still never sent a signal by `--cleanup`.
- **S3. `--restart --pid <pid>` also reaches that pid's leases and root pid file in its own tmp
  dir**, and in that dir only the files naming it. Its respawn runs with the holder's `TMPDIR`,
  `TMP` and `TEMP` as well as its root variables and `XDG_STATE_HOME`, so it claims its lease in
  the holder's tmp dir, and the settle check reads it there. `Not found` is printed only for a pid
  holding no lease or root pid file here or in its own tmp dir.
- **S4. A `--list` row for a daemon holding no lease here names its `--session` resolved against
  its working directory**, as a lease row already does, so the session `--stop` takes is the one
  `--list` printed.

`--list` and `--restart` without `--pid` still read leases and root pid files only here.

## Test

`tests/wtft-387-private-tmpdir.test.ts`:
- in memory, `decideUnleased` over each case of S1 and S2, the inverse cases included (a harness
  with no root variable, one whose tmp dir is here, a session outside here);
- with real daemons, each with its own tmp dir inside the suite's: a per-session daemon gone after
  `--stop <its session>`, a harness gone after `--cleanup`, and in both cases `--list` printing
  no line for the pid within 5 s; a per-session daemon restarted by `--restart --pid`, exit 0,
  its respawn holding the lease in that daemon's own tmp dir.

## Roads not taken

- **Reading every daemon's tmp dir for every flag:** `--restart` without `--pid` would reach
  every test suite's fixture daemons on the host, which each suite's own tmp dir keeps apart.
- **Stopping a harness on `--stop` of its start-up session:** a harness serves other sessions,
  and `--stop` drops one session.

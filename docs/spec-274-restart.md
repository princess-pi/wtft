# spec-274 — what `wtft-daemon --restart` brings back, and what it reports

Issue: https://github.com/princess-pi/wtft/issues/274 · Module: `bin/wtft-daemon.ts` (the `--restart` pass) · Test: `tests/wtft-274-restart.test.ts`

## Behaviour

- **B. A pid that is not a live daemon is never signalled.** A lease or harness root pid file
  naming such a pid is removed, and the line says `no live daemon found`. The process keeps running.
- **C. A holder is respawned with its own `--harness`, `--session` or not.** A per-session holder
  comes back through `daemonLaunchArgs` for its `--session`. A harness daemon holding a lease with
  no `--session` comes back as `wtft-daemon --harness <name>`, and the line reads
  `Restarted: PID n → fresh harness daemon (<name>)`. A harness found only through its root pid
  file is stopped, not respawned: the next `wtft` or widget spawn starts it.
- **D. A respawn counts only if, `WTFT_RESPAWN_SETTLE_MS` later (default 1 s), it is still running or a live daemon holds what it
  was started for** (the session's lease, or a root pid file for its `--harness`); a child that
  handed off and exited 0 counts. Otherwise (a tag-file `--session`, a crash at start) it is a failed respawn: its claim on the lease is
  removed and the line reads `Stopped: PID n — the respawn for <session> failed`.
- **A respawn runs in the stopped holder's cwd** (read from `/proc/<pid>/cwd`), with its root
  environment, `XDG_STATE_HOME` and tmp dir (below), so a relative `--session` or root directory names what it named before.
- **One wait for all.** Every respawn is started first, then one wait of `WTFT_RESPAWN_SETTLE_MS`,
  then each is judged. A child slower than that to fail is counted as running: on a loaded host
  node's own start can take longer than 1 s, so the suite sets a wait sized as a hang guard.
- **A harness a respawn handed off to is left running,** with the line `Left running: PID n —
  harness …; a respawn handed its session to it`. Every other harness found only through its
  root pid file is stopped.
- **A respawn runs with the holder's root environment, `XDG_STATE_HOME`** (where it publishes
  its daemon roster and its log) **and `TMPDIR`, `TMP` and `TEMP`**: a variable the holder did not have is removed, when its environment is
  readable. A cwd that no longer exists falls back to the
  caller's.
- **E. A holder that refused the signal (EPERM) or outlived SIGKILL is left running with its
  lease or root pid file,** and the line says `Not stopped`.
- **Exit code.** `--restart` exits 1 when a holder refused the signal or outlived SIGKILL (E), or
  a respawn failed (C, D); otherwise 0.

## Roads not taken

- **Respawning a root-only harness.** Kept: nothing is waiting on a harness
  between readers, and the next reader starts one from the current bundle.
- **Re-running the holder's whole argv.** Only `--harness` and `--session` are read back; a
  daemon takes no other launch argument that `--restart` should preserve.
- **A test for E with a second uid.** No second uid is available on the test hosts, so E's
  end-to-end check is a documented skip. `stopHolder`'s `denied` outcome is tested over a fake
  process table in `tests/wtft-297-holder.test.ts`.

# spec-274 — what `wtft-daemon --restart` brings back, and what it reports

Issue: https://github.com/princess-pi/wtft/issues/274 · Module: `bin/wtft-daemon.ts` (the `--restart` pass) · Test: `tests/wtft-274-restart.test.ts`

## Behaviour

- **B. A pid that is not a live daemon is never signalled.** A lease or harness root pid file
  naming such a pid is removed, and the line says `no live daemon found`. The process keeps running.
- **C. A holder is respawned with its own `--harness`, `--session` or not.** A per-session holder
  comes back through `daemonLaunchArgs` for its `--session`. A harness daemon holding a lease with
  no `--session` comes back as `wtft-daemon --harness <name>`, and the line reads
  `Restarted: PID n → fresh harness daemon (<name>)`. A harness found only through its root pid
  file is stopped, not respawned: the next `wtft` or widget spawn starts it (spec-46).
- **D. A respawn counts only if it is still alive 300 ms later.** A child that exits before then
  (a tag-file `--session`, a crash at start) is a failed respawn: its claim on the lease is
  removed and the line reads `Stopped: PID n — the respawn for <session> failed`.
- **E. A holder that refused the signal (EPERM) or outlived SIGKILL is left running with its
  lease or root pid file,** and the line says `Not stopped`.
- **Exit code.** `--restart` exits 1 when any holder was left running (E) or any respawn failed
  (C, D); otherwise 0. It used to exit 0 in every case, with the failure only in its line.

## Roads not taken

- **Respawning a root-only harness.** Kept as spec-46 has it: nothing is waiting on a harness
  between readers, and the next reader starts one from the current bundle.
- **Re-running the holder's whole argv.** Only `--harness` and `--session` are read back; a
  daemon takes no other launch argument that `--restart` should preserve.
- **A test for E with a second uid.** No second uid is available on the test hosts, so E's
  end-to-end check is a documented skip. `stopHolder`'s `denied` outcome is tested over a fake
  process table in `tests/wtft-297-holder.test.ts`.

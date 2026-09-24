# Spec 240 — the startup reaper examines each process once

**Issue:** [#240](https://github.com/princess-pi/wtft/issues/240) ·
**Test:** `tests/wtft-240-reaper-once-per-pid.test.ts`

A per-session daemon runs `reapAndWarn` at startup. It walks every `wtft-daemon-*.pid` lease in
`os.tmpdir()`. A harness daemon holds one lease per session it serves: 10,866 on `overcity`, all
naming one pid. The reaper examined each lease on its own. For each one it read that pid's
`/proc/<pid>/cmdline`, then read and split the tag file of the `--session` it names. That session
is the same one every time, and its tag is 1.4 MB. So a start took **96 s**, and each start added
about 10,866 identical warnings to `reap.log`.

**Now** the leases are grouped by pid first, and each distinct pid is examined once:

- **dead pid:** every lease it holds is removed;
- **pid whose session is gone:** it is sent `SIGTERM` once, and every lease it holds is removed;
- **live pid:** its tag checks run once, and whatever they find (a large tag, a heartbeat-heavy
  tag, no real interactions) goes into **one** `reap.log` line for that pid per start.

A lease is removed only if it is still the same file (device and inode) and still names the pid
it named when it was read, the check the daemon's own claim loop makes. It can be re-claimed by a
new owner while earlier pids are being examined, and removing that new owner's lease would make
the new owner exit. The check narrows that window; it does not close it, since a new owner can
still rename a lease into place between the check and the unlink. A `SIGTERM` to a process that
exits first no longer aborts the daemon's startup. The stale-fixture scan reuses the answers, so a pid killed this pass no
longer counts as owning a fixture directory.

Both the reaper and the `--cleanup` / `--restart` loop now skip a lease whose content is not a pid.
Before, the `rebuild` token parsed as `NaN` and passed their `pid <= 0` guard. It then read as a
dead pid, and the lease was deleted: by every per-session daemon's startup reaper, and by
`--cleanup` and `--restart`. That dropped the rebuild request it carried. `--list` only printed
it as dead.

**Closer, measured 2026-09-24** (`tests/wtft-240-reaper-once-per-pid.test.ts`): 10,000 leases
naming one live process, whose `--session` tag is over 1 MB and all heartbeats. The per-session
daemon logs `started, watching` in about 250 ms. `reap.log` gains one line about that pid, and
the line carries all three findings. The same test against the `main` build at `c7864c0`: 108.7
s, and 30,000 lines about that pid. On `overcity`, with 10,866 real leases: 96 s.

The kill rule is unchanged, including for a harness daemon, whose `--session` is only the session
it was started for. That is #243.

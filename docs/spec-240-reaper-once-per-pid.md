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
- **live pid:** its tag checks run once, and it gets at most one warning of each kind per start.

The stale-fixture scan reuses those answers instead of reading every lease again.

**Closer, measured:** 2,000 leases naming one live process whose `--session` tag is over 1 MB.
The per-session daemon logs `started, watching` in about 100 ms (4.3 s before), and `reap.log`
gains one line about that pid (2,000 before).

The kill rule is unchanged, including for a harness daemon, whose `--session` is only the session
it was started for. That is #243.

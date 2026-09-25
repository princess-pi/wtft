# Spec 248 — the session a reader is waiting on is served first

**Issue:** [#248](https://github.com/princess-pi/wtft/issues/248) ·
**Test:** `tests/wtft-248-focus-first.test.ts`

**Status:** Superseded in part by #239.

> **Superseded in part by [spec-239](spec-239-harness-lifecycle.md).** The harness no longer
> walks or catches up the root: it serves only the sessions it is asked for. The startup walk,
> the catch-up slices and the walk-order Closer below are kept as history. Still live: focus
> requests, `r` never stopping a harness, a newer build replacing an older harness, and the
> `--watch` waiting line. How a focus request is served changed too: the harness watches the
> request directory and serves a request when it is posted, and only a harness that still holds
> the root removes the directory as it stops. Spec-239 carries the current rule.

## What went wrong

After the tagger went to 2.11.0 and `wtft-daemon --restart` ran, `wtft --watch` on a live session
showed `Waiting for session data...` for many minutes. One-shot `wtft` fell back to the stale
v2.10.0 tag, so only `--watch` was affected.

- **Every session was served first, in directory order.** `watchDir(root)` registered the
  watchers and, while it walked the root, woke every session it passed, synchronously. The
  session the reader named with `--session` came after the walk. On this host that meant about
  11,000 tag rebuilds. Two harness processes were contending (#249), and they got through 1,991 in
  the first 2 minutes and the rest in about 14. A one-session `--reparse` of this 6.7 MB session
  took 0.36 s (measured 2026-09-24).
- **A request made during the walk was not heard.** The walk held the event loop, so a
  `--watch` that started meanwhile, and whose spawned daemon pointed the lease at the live harness
  (`pointSessionAt`), waited for the walk to end.
- **`r` in `--watch` stopped the harness daemon.** `restartDaemon` sent `SIGTERM` to whatever
  held the session's lease. Since #219 that is the one process serving every session under the
  root, and the replacement started the whole walk again. A spawn that raced it could also
  report `wtft-daemon exited with code 0 before creating its tag file`.

## The change

- **Focus first.** At startup the harness serves its `--session` before anything else. Only then
  does it catch the rest up in slices: it starts sessions for at least 25 ms, then yields to the
  event loop after the one in progress. `watchDir` no longer wakes
  files at startup; it still does for a directory that appears later.
- **A request mid-walk is served next.** `pointSessionAt` also drops a request file,
  `<harness pid file>.focus.d/<requester pid>.request`, holding the live harness's pid and the
  session's path; one file per requester, so two never overwrite each other. The live harness
  checks that directory before every catch-up session and on its 250 ms sweep. It claims each
  request by renaming it before reading it. It drops a request addressed to another pid or naming
  a path outside its root, and removes the directory when it stops. A request that arrives
  mid-walk waits for the session being rebuilt when it arrives, then its own rebuild; one that
  arrives during the harness's startup also waits for the directory walk and the focus rebuild,
  and one that arrives after the walk waits up to one 250 ms sweep. A requester that cannot post
  one says so on stderr.
- **A newer build replaces an older harness.** The harness records its tagger version beside its
  pid file, keyed by its own pid (`<harness pid file>.<pid>.version`), before it claims the pid
  file, so a harness that holds the pid file always has one. A spawn from a newer build that finds
  a live harness of an older tagger version, or one with no version file (a build from before this
  change), stops it and takes over. It does not hand that harness the session. A spawn that loses
  the claim to another spawn after the stop hands the winner its session, as a same-version spawn
  does. So after an upgrade that
  bumps the tagger, the next `wtft` replaces the old harness, and no `wtft-daemon --restart` is
  needed.
- **`r` never stops a harness.** When the lease names a `--harness` process, `restartDaemon`
  leaves it and the lease alone. Its spawn then points the harness at this session.
- **`--watch` says what it is waiting for.** While the watch has no turns to show, this version's
  tag does not exist yet, and a tag for another tagger version is on disk, the waiting line names
  both versions and says it is waiting for the log parser daemon to build this version's tag
  (`waitingForDataLine`). Once this version's tag exists, the plain line is shown. The harness
  does not remove older tags, so one left beside it says nothing about what the reader waits on.

## Closer

`tests/wtft-248-focus-first.test.ts`, on 1,500 fixture sessions that have only older-version tags,
listed in the harness's walk order:

- The session named at startup, last in walk order, is tagged while fewer than 50 others are.
- Mid-walk, the last untagged session in walk order is requested by a second process. It is
  served ahead of its walk position: fewer than half the sessions ahead of it are rebuilt
  meanwhile.
- A harness whose recorded version is older is replaced by a newer spawn, which then serves its
  `--session`. A same-version spawn after that leaves the new harness running and holding the
  lease.
- The waiting line with and without a stale-version tag, and `r` against a lease held by a
  harness.

#248's own Closer asked for a timed bound, 2 s. On a fixture small enough for the suite, the whole
rebuild finishes in about 2 s, so the time alone could not tell focus-first from walk order.
Order is what the test asserts. The time follows from it: the rebuild in progress, then this
session's, plus a process start.

Not changed here, and since addressed by spec-239: at startup the harness adopted every session
under its root (#239), and two harness processes could race after `--restart` (#249).

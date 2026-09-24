# Spec 248 — the session a reader is waiting on is served first

**Issue:** [#248](https://github.com/princess-pi/wtft/issues/248) ·
**Test:** `tests/wtft-248-focus-first.test.ts`

## What went wrong

After the tagger went to 2.11.0 and `wtft-daemon --restart` ran, `wtft --watch` on a live session
showed `Waiting for session data...` for many minutes. One-shot `wtft` fell back to the stale
v2.10.0 tag, so only `--watch` was affected.

- **Every session was served first, in directory order.** `watchDir(root)` registered the
  watchers and, while it walked the root, woke every session it passed, synchronously. The
  session the reader named with `--session` came after the walk. On this host that meant 11,180
  tag rebuilds, at roughly 250 to 900 a minute as two harness processes contended (#249). A
  one-session `--reparse` of this 6.7 MB session took 0.36 s (measured 2026-09-24).
- **A request made during the walk was not heard.** The walk held the event loop, so a
  `--watch` that started meanwhile, and whose spawned daemon pointed the lease at the live harness
  (`pointSessionAt`), waited for the walk to end.
- **`r` in `--watch` stopped the harness daemon.** `restartDaemon` sent `SIGTERM` to whatever
  held the session's lease. Since #219 that is the one process serving every session under the
  root, and the replacement started the whole walk again. A spawn that raced it could also
  report `wtft-daemon exited with code 0 before creating its tag file`.

## The change

- **Focus first.** At startup the harness serves its `--session` before anything else. Only then
  does it catch the rest up, yielding to the event loop every 25 ms. `watchDir` no longer wakes
  files at startup; it still does for a directory that appears later.
- **A request mid-walk is served next.** `pointSessionAt` also drops a request file,
  `<harness pid file>.focus.d/<requester pid>.request`, holding the session's path; one file per
  requester, so two never overwrite each other. The live harness checks that directory before
  every catch-up session and on its 250 ms sweep. It claims each request by renaming it before
  reading it. It drops a request older than its own start or naming a path outside its root, and
  removes the directory when it stops. A request therefore waits at most for the one session being
  rebuilt when it arrives.
- **`r` never stops a harness.** When the lease names a `--harness` process, `restartDaemon`
  leaves it and the lease alone. Its spawn then points the harness at this session.
- **`--watch` says what it is waiting for.** While the watch has no turns to show and a tag for
  another tagger version is on disk, the waiting line names both versions and says it is waiting
  for the log parser daemon to build this version's tag (`waitingForDataLine`).

## Closer

`tests/wtft-248-focus-first.test.ts`, on 1,500 fixture sessions that have only older-version tags,
listed in the harness's walk order:

- The session named at startup, last in walk order, is tagged while fewer than 50 others are.
- Mid-walk, the last untagged session in walk order is requested by a second process. It is
  served ahead of its walk position: fewer than half the sessions ahead of it are rebuilt
  meanwhile.
- The waiting line with a stale-version tag, and `r` against a lease held by a harness.

#248's own Closer asked for a timed bound, 2 s. On a fixture small enough for the suite, the whole
rebuild finishes in about 2 s, so the time alone could not tell focus-first from walk order.
Order is what the test asserts. The time follows from it: one session's rebuild plus a process
start.

Not changed here: at startup the harness still adopts every session under its root (#239), and
two harness processes can still race after `--restart` (#249).

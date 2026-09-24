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
  tag rebuilds at a few hundred a minute. One session on its own takes 0.36 s.
- **A request made during the walk was not heard.** The walk held the event loop, so a
  `--watch` that started meanwhile, and whose spawned daemon pointed the lease at the live harness
  (`pointSessionAt`), waited for the walk to end.
- **`r` in `--watch` stopped the harness daemon.** `restartDaemon` sent `SIGTERM` to whatever
  held the session's lease. Since #219 that is the one process serving every session under the
  root, and the replacement started the whole walk again. A spawn that raced it could also
  report `wtft-daemon exited with code 0 before creating its tag file`.

## The change

- **Focus first.** At startup the harness serves its `--session` before anything else. Only then
  does it catch the rest up, 20 sessions per turn of the event loop. `watchDir` no longer wakes
  files at startup; it still does for a directory that appears later.
- **A request mid-walk is served next.** `pointSessionAt` also writes the session's path to
  `<harness pid file>.focus`. The live harness reads that file between catch-up batches, and on
  its 250 ms sweep, and serves that session next.
- **`r` never stops a harness.** When the lease names a `--harness` process, `restartDaemon`
  leaves it and the lease alone. Its spawn then points the harness at this session.
- **`--watch` says a rebuild is running.** While the current tag has no turns and a stale-version
  tag exists, the waiting line names the rebuild and both versions (`waitingForDataLine`).

## Closer

- 1,500 fixture sessions with no tags. The session named at startup is tagged while fewer than 50
  of the others are.
- Mid-walk, a request from a second process is served within the time of that process's start-up:
  fewer than 400 others were rebuilt in between. In walk order it would come about 1,000 later.
- The waiting line with a stale-version tag, and `r` against a lease held by a harness.

Not changed here: at startup the harness still adopts every session under its root (#239), and
two harness processes can still race after `--restart` (#249).

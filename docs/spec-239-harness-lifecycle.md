# Spec 239 — the harness daemon serves only the sessions it is asked for

**Issues:** [#239](https://github.com/princess-pi/wtft/issues/239),
[#249](https://github.com/princess-pi/wtft/issues/249),
[#243](https://github.com/princess-pi/wtft/issues/243),
[#250](https://github.com/princess-pi/wtft/issues/250) ·
**Tests:** `tests/wtft-239-harness-lifecycle.test.ts`, `tests/wtft-205-one-daemon-per-harness.test.ts`

## What went wrong

- **#239 — every session stayed adopted.** The harness daemon's startup catch-up adopted every
  session under its root: a slot in memory and a lease in the tmp dir each. A quiet session kept
  both until `WTFT_DAEMON_IDLE_MS` (24 h), and dropping a slot left its lease behind. On
  `overcity` that was 10,866 leases, 215 MB RSS and a 504 MB peak. Nothing needed it: every
  report and widget names one session, and that session's own records find what it spawned.
- **#249 — `--restart` stopped the harness it had just started.** `--restart` walks every lease
  in the tmp dir. For the first lease of a harness it stops that harness and starts a new one.
  While it was still walking thousands of leases, the new harness claimed the root, and the walk
  then met the harness pid file naming the new process: it stopped it and removed the pid file.
  A `wtft` spawn in that window became a second harness.
- **#243 — the startup reaper judged a harness by its `--session`.** A harness daemon's
  `--session` is only the session it was started for. When that transcript was deleted, the next
  per-session daemon's startup reaper stopped the harness that served every other session.
- **#250 — the #205 suite ran its daemons under bun.** The suite spawned the daemon with the test
  runner's own runtime. Under bun 1.3.14 on a loaded host, `fs.watch` lost events: an append, a
  rename onto a session and an unlink each went unseen for 30 s or more, until a later event in the
  same directory. Loaded, with the daemon under bun the suite passed 7 of 10 runs; under node,
  the runtime it ships on, 12 of 12, and 10 of 10 in the Closer run below.

## The change

- **The harness daemon serves only the sessions it is asked for.** It adopts a session when a
  reader names it: its own `--session` at startup, or a focus request from a later `wtft`, Pi
  widget or `--watch` start (`pointSessionAt`). It no longer walks the root at startup, and a
  session nobody asked for is never read, tagged or leased. There is no catch-up to wait behind.
- **It watches only what it serves**: the project directory holding each served transcript, and
  that session's own directory tree (`<id>/`, `<id>/subagents/`, nested ones). An event for a
  file no one asked for is ignored, except that under the Pi root a new or growing sibling file
  wakes the served sessions in its directory, since a Pi child session is a sibling. Dropping a
  session closes its watchers, and a project directory's once no served session is left in it.
- **A reader gets the session's own sum first, then its subagents.** The session's own turns are
  flushed to the tag before any subagent transcript is read, and in a harness the subagent scan
  runs in slices of at least 25 ms (`HARNESS_CATCH_UP_SLICE_MS`), continuing on the next turn
  of the event loop. A one-shot `wtft` that finds turns in the tag reports them at once, marked
  provisional (exit 9, "no subagent transcript has been read since this tag was written") until
  the scan finishes and stamps the tag swept; `--watch` shows the sum grow.
- **A session is dropped after `WTFT_DAEMON_IDLE_MS` (24 h) with no new lines**, as before, and
  dropping a slot now removes its lease, unless another slot shares that lease or another
  process has replaced it since it was read.
- **A focus request goes only to a harness that still holds the root.** After posting, the
  requester checks the harness pid file still names that harness. A request that cannot be
  posted is reported on stderr. Unless the harness still holds the root and already held this
  session's lease, the lease and `.display` the call pointed at it are removed, so the reader is
  not told a session is served when nothing will adopt it. The spawn then waits up to 2 s for
  that harness to exit and tries to claim the root itself, exiting 1 after five attempts.
- **`--reparse` holds the session's lease while it rewrites the tag**, and a harness never stops
  a reparse to take a lease: asked for a session a reparse holds, it tries again every 667 ms
  until the reparse lets go. `--reparse` of a session a daemon is serving is refused.
  `--reparse-range` exits 1, naming how many sessions it left unreparsed, when any was refused,
  failed or could not be stat'd.
- **A harness whose pid file no longer names it stops.** The sweep reads the harness pid file;
  if it was removed or names another process, the harness stops and releases its leases, so two
  harnesses contend for one root only until the displaced one's next sweep, which the event
  loop reaches after whatever wake it is running.
- **`--restart` never stops or unlinks what it started.** A lease or pid file naming a process
  this `--restart` started is skipped, and a lease or pid file is removed only if it still names
  the process that was stopped.
- **Neither the startup reaper nor `--cleanup` acts on a harness daemon for a gone
  `--session`.** The harness drops a gone session itself.
- **The #205 and #239 suites run their long-lived daemons under node** (the #239 suite runs
  every daemon command under node; the #205 suite's one-shot `--stop`, `--reparse` and
  `--restart` still run under the test runner's bun), and the #205 suite waits for the event it
  measures, with wall-time limits of 30 s, instead of a fixed sleep.

## Closer

`tests/wtft-239-harness-lifecycle.test.ts`:

- A root of 2,000 sessions and one being appended to, with the harness started for that one:
  no other session gets a tag, the harness holds one lease, the live session stays classified,
  and the harness's live heap (a heap snapshot) is within 1 MiB of a harness on a root of 10
  sessions. A write to a session nobody asked for is not read. A session asked for later from
  another process is served, its subagent transcript included, and a later write to that
  subagent transcript is read. `--reparse` runs beside the harness on a session it does not
  serve and is refused on one it does. The issue asked for RSS; RSS keeps heap a parse freed
  and did not return (#97), so the test measures live heap.
- A session with 40 subagent transcripts (about 96 MB): the first `wtft --json` returns in
  under 3 s with the session's own sum, marked provisional (exit 9); a later report is complete
  (exit 0) and counts the subagent turns the first did not.
- Removing the harness pid file stops the harness.
- With 40,000 leases naming the running harness, `--restart` followed by a `wtft`-style spawn
  leaves exactly one harness after 5 s: the one `--restart` started, holding the pid file.
- A harness whose `--session` was deleted survives a per-session daemon's startup and keeps its
  live session's lease. The `--cleanup` half is not in the suite: `--cleanup` stops every
  fixture daemon under `/tmp`, including those of suites running beside it.

`tests/wtft-248-focus-first.test.ts`: of 1,500 sessions, only the one named at startup and one
asked for later are rebuilt.

#250: `tests/wtft-205-one-daemon-per-harness.test.ts` passes ten consecutive runs while a
CPU-bound process occupies every core.

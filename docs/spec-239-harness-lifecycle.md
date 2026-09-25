# Spec 239 — the harness daemon serves only the sessions it is asked for

**Issues:** [#239](https://github.com/princess-pi/wtft/issues/239),
[#249](https://github.com/princess-pi/wtft/issues/249),
[#243](https://github.com/princess-pi/wtft/issues/243),
[#250](https://github.com/princess-pi/wtft/issues/250) ·
**Tests:** `tests/wtft-239-harness-lifecycle.test.ts`, `tests/wtft-205-one-daemon-per-harness.test.ts`

**Status:** Superseded in part by #259.

> **Superseded in part by [spec-259](spec-259-daemon-correctness.md).** `--reparse` and
> `--reparse-range` are gone, a harness serves a request whatever harness pid it names, keeps its
> hand-off current, re-arms its request watch after an error, and stops after 24 h serving nothing. Where the two disagree, spec-259 is current.

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
  widget or `--watch` start (`pointSessionAt`). It also adopts what the previous harness on the
  root handed over, and a session it dropped for idling when that session's transcript is written. It no longer walks the root at startup, and a
  session nobody asked for is never adopted, tagged or leased. A subagent session of a
  served session (under `<id>/subagents/`, a `claude -p` session it ran, or a Pi sibling) is read
  into that session's tag, and finding Pi subagent sessions reads the first line of each sibling
  file. There is no catch-up to wait behind.
- **It watches only what it serves**, plus its own request directory and the project directory of
  each session it dropped for idling: the project directory
  holding each served transcript, and that session's own directory tree (`<id>/`,
  `<id>/subagents/`, nested ones; `tool-results/`, `memory/` and `wtft-tags/` are skipped, and a
  symlinked directory that appears under a served session is not followed). A session moved while its subagent scan is cut carries
  that scan on under its new path. An
  event for another `.jsonl` file is ignored, except that under the Pi root any event on a
  sibling wakes the served sessions in its directory, since a Pi subagent session is a sibling.
  An event with no file name wakes every served session; one for a file that no longer exists
  wakes each served session in that directory whose file changed or is gone. Dropping a
  session closes its watchers, and a project directory's once no served session is left in it.
- **A reader gets the session's own sum first, then its subagents.** When a session is adopted,
  its own turns are flushed to the tag before any subagent transcript is read (a later wake
  within 667 ms of the last flush holds new own turns for the next flush, as before). In a
  harness the subagent scan runs in slices: each takes at least one transcript, stops at the
  first transcript boundary after 25 ms (`WTFT_HARNESS_SCAN_SLICE_MS`), and the next slice, on the
  next turn of the event loop, skips the transcripts this pass has already taken. A failure in any slice of a pass keeps the tag
  from being stamped swept when the pass ends, and dropping a session forgets its pass. `WTFT_HARNESS_SCAN_YIELD_MS` (default 0) pauses
  between slices; the suite sets it to make a scan outlast a report. A one-shot `wtft` that finds turns in the tag reports them at once, marked
  provisional (exit 9, "no subagent transcript has been read since this tag was written") until
  the scan finishes and stamps the tag swept; `--watch` shows the sum grow. A session adopted on
  a tag an earlier daemon wrote has that tag's swept verdict retracted first, since whatever was
  written while nothing served it has not been read yet.
- **A session is dropped after `WTFT_DAEMON_IDLE_MS` (24 h) with no new lines** in it or its
  subagent transcripts, once `WTFT_DAEMON_STARTUP_GRACE_MS` has passed since it was adopted, as before, and
  dropping a slot now removes its lease, unless another slot shares that lease or another
  process has replaced it since it was read. A session dropped for idling keeps its project
  directory watched, and the next write to its own transcript adopts it again with no new
  request; a write to one of its subagent transcripts alone does not.
- **A focus request goes only to a harness that still holds the root.** A request is one JSON
  object, `{"pid", "path"}` (the older `<pid>\n<path>` text is still read), and a harness reads requests only while its pid file names it. After posting, the
  requester checks the harness pid file still names that harness. The harness watches its
  request directory, so a request is served when it is posted, not at the next 250 ms sweep (a
  request posted while the harness is starting waits for that sweep, and so does every request
  after its watch of the directory fails); a
  one-shot `wtft` on a session handed to a running harness finds its turns in the tag. A request that cannot be
  posted is reported on stderr. Unless the harness still holds the root and already held this
  session's lease, the lease and `.display` the call pointed at it are removed, so the reader is
  not told a session is served when nothing will adopt it. The spawn then waits up to 2 s for
  that harness to exit and tries to claim the root itself, exiting 1 after five attempts.
- **A focus request never overwrites a `rebuild` lease**, so a session handed to a live harness
  after a failed tag write is rebuilt, not resumed. A failed adoption is retried up to five
  times.
- **A harness whose pid file no longer names it stops.** The sweep reads the harness pid file;
  if it was removed, is empty, or names another process, the harness stops and releases its leases, so two
  harnesses contend for one root only until the displaced one's next sweep, which the event
  loop reaches after whatever wake it is running.
- **`--restart` stops only what was running when it began.** It reads every lease and harness
  pid file before it stops anything, and acts on the process each one named then. A harness that
  claims the root while it is still walking, whether it started it or a `wtft` spawn did, is left
  running. A lease or pid file is removed only if it still names the process that was stopped.
- **The next harness on a root serves what the last one served.** A harness that stops while it
  still holds the root, or exits on a failed tag write, writes the sessions it served, and those
  it dropped for idling, to `<harness pid file>.served` (one JSON object per line), before it
  flushes anything. A failed tag write includes the session being adopted, and a session waiting
  on an adoption retry is included too. The next harness to claim the root adopts the served ones and
  watches for the idle ones' next write, including a served session whose transcript is not
  written yet. So `--restart` and a newer build's replacement pass on what the old harness served, when that
  harness is itself from this change or later,
  unless the hand-off cannot be written or read. `--restart` waits for each harness it stops to exit before it removes that harness's pid file,
  and a hand-off that cannot be written or read is reported on stderr.
- **Neither the startup reaper, `--cleanup` nor `--stop` acts on a harness daemon for its
  start-up `--session`.** `--stop` drops a session from a harness only through that session's
  own lease. The harness drops a gone session itself.
- **The #205 and #239 suites run their long-lived daemons under node** (the #239 suite runs
  every daemon command under node; the #205 suite's one-shot `--stop` and `--restart` still run
  under the test runner's bun), and the #205 suite waits for the event it
  measures, with wall-time limits of 30 s, instead of a fixed sleep.

## Closer

`tests/wtft-239-harness-lifecycle.test.ts`:

- A root of 2,000 sessions and one being appended to, with the harness started for that one:
  no other session gets a tag, the harness holds one lease, the live session stays classified,
  and the harness's live heap (a heap snapshot) is within 1 MiB of a harness on a root of 10
  sessions. A write to a session nobody asked for is not read. A session asked for later from
  another process is served, its subagent transcript included, and a later write to that
  subagent transcript is read. The issue asked for RSS; RSS keeps heap a parse freed
  and did not return (#97), so the test measures live heap.
- A session with 20 subagent transcripts, scanned in 0 ms slices with 300 ms between them: the first `wtft --json` returns in under 3 s with the session's own sum, marked provisional
  (exit 9); a later report is complete (exit 0) and counts the subagent turns the first did not.
  A second session handed to that running harness gets its sum on its first report.
- A session adopted again after its harness stopped has its old swept verdict retracted, then
  its subagent written while nothing served it is read.
- A session with a `rebuild` lease, handed to a harness already serving another session, is
  rebuilt: a row its transcript does not hold is gone.
- A session dropped for idling is read again on its next write, with no new request.
- After `--restart`, a session the old harness was asked for is read on its next write, with no
  new request.
- A symlink to a directory with 40 subdirectories, created under a served session, adds no
  watches: watch events are not followed through symlinks.
- A focus request for a path holding a newline is served.
- After `--restart`, a session whose path holds a tab is read on its next write.
- A session handed to a harness before its project directory exists is read on its first write.
- After `--restart`, a session asked for before its transcript existed is read on its first write,
  with no new request.
- `--restart` of a harness holding no lease, only a session it dropped for idling, waits for it
  to exit, so the next harness reads that session's next write with no new request.
- Removing the harness pid file stops the harness.
- With 40,000 leases naming the running harness, `--restart` followed by a `wtft`-style spawn
  leaves exactly one harness after 5 s: the one `--restart` started, holding the pid file.
- With 40,000 leases naming a harness started with no session, so that `--restart` starts no
  replacement, a harness spawned while `--restart` is still walking claims the root and is the
  one harness left when it exits.
- A harness whose `--session` was deleted survives a per-session daemon's startup and keeps its
  live session's lease. The `--cleanup` half is not in the suite: `--cleanup` stops every
  fixture daemon under `/tmp`, including those of suites running beside it.

`tests/wtft-248-focus-first.test.ts`: of 1,500 sessions, only the one named at startup and one
asked for later are rebuilt.

#250: `tests/wtft-205-one-daemon-per-harness.test.ts` passes ten consecutive runs while a
CPU-bound process occupies every core.

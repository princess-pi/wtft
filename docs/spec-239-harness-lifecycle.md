# Spec 239 — the harness daemon holds only the sessions that are live

**Issues:** [#239](https://github.com/princess-pi/wtft/issues/239),
[#249](https://github.com/princess-pi/wtft/issues/249),
[#243](https://github.com/princess-pi/wtft/issues/243),
[#250](https://github.com/princess-pi/wtft/issues/250) ·
**Tests:** `tests/wtft-239-harness-lifecycle.test.ts`, `tests/wtft-205-one-daemon-per-harness.test.ts`

## What went wrong

- **#239 — every session stayed adopted.** The harness daemon's startup catch-up adopted every
  session under its root: a slot in memory and a lease in the tmp dir each. A quiet session kept
  both until `WTFT_DAEMON_IDLE_MS` (24 h), and dropping a slot left its lease behind. On
  `overcity` that was 10,866 leases, 215 MB RSS and a 504 MB peak.
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

- **A long-idle session is released as soon as the catch-up has served it.** The idle drop was
  already there: after `WTFT_DAEMON_IDLE_MS` (24 h) with no new lines, a slot is dropped. It
  counted from the harness's start, so every session under the root was held for a day. The
  catch-up now counts from the last write instead: right after it serves a session whose
  transcript and every file under its session directory (`subagents/`, at any depth)
  were last written more than `WTFT_DAEMON_IDLE_MS` ago, that no reader asked for, with nothing pending, no partial line held and no child still
  in its discovery window, it drops the slot. A directory that appears later, or is watched again
  after a watcher error, is walked the same way. The idle threshold is unchanged, so a session is
  released only when the running daemon would have dropped it anyway; the in-memory state a
  drop loses (stream state, discovered `claude -p` children) is lost at the same point as
  before. A Claude Code session's next write, or a write to one of its `subagents/`
  transcripts, adopts it again, resuming from the offset in its tag.
- **Dropping a slot removes its lease**, for any reason, unless another slot shares that lease
  or another process has replaced it since it was read.
- **After a watch overflow** the harness also adopts any session written within
  `WTFT_DAEMON_IDLE_MS` that holds no slot, since events for it may have been lost.
- **A focus request that cannot be posted** is reported on stderr. A lease the call pointed at
  the harness is removed, so the reader is not told a session is served when nothing will
  adopt it; a lease the harness already held stays. The spawn then waits up to 2 s for that
  harness to exit and tries to claim the root itself, exiting 1 after five attempts.
- **`--reparse` is refused for a session under a root whose harness is running**, not only for
  one whose lease is held: a released session has no lease, and the harness may adopt it again
  at any write and append to the tag the reparse is rewriting. `--reparse-range` exits 1,
  naming how many sessions it left unreparsed, when any was refused or failed.
- **A harness whose pid file no longer names it stops.** The sweep reads the harness pid file;
  if it was removed or names another process, the harness stops and releases its leases, so two
  harnesses never contend for one root.
- **`--restart` never stops or unlinks what it started.** A lease or pid file naming a process
  this `--restart` started is skipped, and a lease or pid file is removed only if it still names
  the process that was stopped.
- **Neither the startup reaper nor `--cleanup` acts on a harness daemon for a gone
  `--session`.** The harness drops a gone session itself.
- **The #205 and #239 suites run their daemons under node**, and the #205 suite waits for the
  event it measures, with wall-time limits of 30 s, instead of a fixed sleep.

## Closer

`tests/wtft-239-harness-lifecycle.test.ts`:

- A root of 2,000 sessions last written two days ago and one being appended to: after the
  catch-up, the harness holds at most 5 leases, the live session is still classified, and its
  live heap (a heap snapshot) is within 1 MiB of a harness on a root of 10 sessions. The issue
  asked for RSS; RSS keeps heap the parse freed and did not return (#97), so it could not tell the
  two builds apart. Measured on this branch: 6.21 against 5.94 MiB; on `main`, 8.67 against
  5.94 MiB with 2,001 leases held. A session whose subagent transcript was just appended to
  keeps its lease. A released session written again is adopted, classified, and holds its own
  lease. Directory watchers still grow with the number of session directories (#253).
- Removing the harness pid file stops the harness.
- With 40,000 leases naming the running harness, `--restart` followed by a `wtft`-style spawn
  leaves exactly one harness after 5 s: the one `--restart` started, holding the pid file.
- A harness whose `--session` was deleted survives a per-session daemon's startup and keeps its
  live session's lease. The `--cleanup` half is not in the suite: `--cleanup` stops every
  fixture daemon under `/tmp`, including those of suites running beside it.

#250: `tests/wtft-205-one-daemon-per-harness.test.ts` passes ten consecutive runs while a
CPU-bound process occupies every core.

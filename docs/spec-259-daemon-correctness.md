# Spec 259 — daemon correctness

**Issues:** [#259](https://github.com/princess-pi/wtft/issues/259), split out of
[#256](https://github.com/princess-pi/wtft/issues/256) · **Tests:**
`tests/wtft-259-daemon-correctness.test.ts`

The item codes (A2, F14, …) are #256's. The decisions (A–R) are recorded in the #256 body.

## The change

### Removed

- **`--reparse` and `--reparse-range` are gone** (decision L). Nothing called them, and a daemon
  already rebuilds a missing or older-version tag when it adopts the session. A tag that must be
  rebuilt for every session gets a tagger version bump instead. With them go the
  `<lease>.reparse` marker, every wait on it, and the refusals. Either flag is now an unknown
  argument.

### Arguments

- **An unknown argument exits 2** with the usage line on stderr (decision I), and so does a flag
  missing its value (`--session`, `--harness`, `--stop` last on the line).
- **`--harness claude-code` is `--harness claude`** (decision O). Both use one pid file.
- **`--stop <session>` resolves its path**: `~` and `~/…` against `$HOME`, a relative path against
  the working directory (decision K). A per-session daemon matches when its own `--session`,
  resolved against its working directory, is the same path.
- **`--stop` of a harness session reports what happened.** When the lease changed between being
  read and being removed, or could not be removed, it prints `Not stopped: the lease for <session>
  changed or could not be removed` on stderr and exits 1.

### Swept (A2, decision A)

- **A `claude -p` child that moved or was deleted counts as gone**, so a turn it held back is
  written (unless a transcript with the same source was read again in that scan, which read
  the turn itself) and the tag can be stamped swept.
- **Swept means every subagent turn is written.** A scan that holds back a subagent transcript's
  last ordinary turn (the one an interrupt record arriving next would mark; a `claude -p` command
  turn is never held) does not stamp the tag swept.
  The next scan that finds no new bytes writes that turn, and stamps swept if it was clean.
  A transcript no longer found (its session moved) has its held turn written under the source its
  earlier lines carry, so the generation that reads it again under the new path retires it; when
  that read happens in the same scan under the same source, it has read the turn itself and the
  held copy is dropped.

### Resume (A1 residual)

- **A resumed session reads again the `claude -p` transcripts it read before.** A daemon adopting
  a tag at its saved offset finds, from the tag's generation records, each `claude -p` transcript
  an earlier daemon read, in the session's own project directory or another, and reads it again
  from its start, as a new generation; a transcript discovery finds on its own (under
  `<id>/subagents/`, or a Pi sibling) is left to discovery. So what it gained while nothing served the session is counted, and
  so is what it writes from then on. A transcript another one currently folds (a `_fold` record
  under the other's source, not retired by a later generation of it) is left to that one. When the
  projects directory or a transcript cannot be read, that is reported on stderr, the resume is
  tried again at each scan, and the tag is not stamped swept until it succeeds. A `claude -p` lookup still open when a daemon stops
  (its window not yet over, or a candidate unreadable) is resumed too: the tag records
  `{"_meta":{"spawnPending":{…}}}` when a turn's lookup starts and `{"_meta":{"spawnSettled":…}}`
  when it ends, with the children the lookup found, and a resumed daemon looks up every turn left
  open and reads every such child no earlier daemon read. So a `claude -p` session
  not yet on disk at the earlier daemon's last scan is found after the restart.

### Leases

- **Adoption never signals a harness** (decision H, A5). A harness asked for a session whose
  lease names another live harness does not take it; it retries (below). A focus request never
  repoints a lease another live daemon holds; the harness's adoption takes it by these rules. A per-session daemon
  holding the lease is still stopped with SIGTERM and waited for, because it serves only that
  session, and waiting keeps two writers off one tag. On Linux: the liveness check reads
  `/proc/<pid>/cmdline`, so off Linux every holder reads as not a daemon, its lease is taken
  with no retry and no signal, and a start-time focus (`pointSessionAt`) repoints it (#266, as
for A9 and `-F`).
- **An older per-session build never takes over from a newer one** (A9). It takes over only from
  a tag of an older version. With a newer-version tag present and its lease held by a live
  daemon, it exits 0; off Linux, where a daemon cannot be told apart, any live lease holder counts. It never deletes a newer-version tag.
- **A daemon that gives up a lease logs it** (decision G): `gave up <session>: its lease now reads
  "<text>"`. Losing a lease is how a session passes to a newer build, so this is not an error.
- **The tagger version goes from 2.11.0 to 2.12.0.** Swept now means no turn held back, and the
  tag carries `spawnPending` / `spawnSettled` records, so every tag is rebuilt, and a start from
  this build replaces a harness of an older one.
- **The lease race is a known limit** (decision G, H19). Releasing a lease is stat, read, stat,
  unlink. A daemon that claims the same lease between the last stat and the unlink loses it, and
  finds out at its next check (250 ms in a harness, one poll in a per-session daemon). The session
  is then unserved until the next reader asks for it. No two daemons write the tag at once, and
  the next daemon resumes from the tag's saved offset. It needs two daemons acting on one session
  within microseconds, which only a harness handover to a newer build produces.

### Adoption

- **A failed adoption gives up loudly** (A3, F14). After the first try and five retries 667 ms
  apart, the harness
  writes `could not adopt <session>: <reason>` to stderr, and removes the lease and `.display`
  marker if they still name it, so no reader is told the session is served.
- **A served session whose lease reads `rebuild` is adopted again**, whether a wake, the sweep or
  a flush finds it, so the session is rebuilt at once. Any other lease that is not the harness's
  drops the session, as `--stop` means.

### `wtft -F` (decision M)

- **On a session a harness serves, `-F` rebuilds that one session.** It replaces the lease with
  `rebuild` and asks the harness for the session, which rebuilds the tag from the transcript. The
  harness and its other sessions are untouched. The CLI waits until the harness has adopted the
  session before it reads the tag, so its own report is of the rebuild; after 10 s it says the
  harness has not taken the session up, and exits 1 with no report; the harness rebuilds the tag
  as soon as it does, with no new request. A lease an earlier `-F` left
  reading `rebuild`, with no daemon behind it, is treated as no holder. Telling a harness apart
  reads `/proc`, so this holds on Linux; elsewhere the harness is stopped as below.
- **Otherwise `-F` stops a live per-session daemon and deletes every version of the session's
  tag**, beside the transcript and in the sibling project where a moved session's tag lives. The
  CLI says whether a daemon was stopped. On Linux only a lease holder whose command line names
  `wtft-daemon` is signalled; off Linux the lease pid is signalled as before. When the daemon is still running 2 s after the signal,
  or another daemon has claimed the lease meanwhile, nothing is deleted, and `-F` says so and
  exits 1. So does a lease that cannot be read, a rebuild lease that cannot be written, a daemon that
  cannot be signalled, a lease or tag
  file that cannot be deleted, since what is left would be resumed
  rather than rebuilt, and a daemon that cannot be started. A harness lease that changed between
  being read and being replaced is left alone, as busy. The CLI and the Pi widget share one implementation, so
  the widget now deletes every version too, not only the current one.
- **`wtft --list`, `--cleanup`, `--restart` and `--stop` pass `wtft-daemon`'s exit code through**,
  and pass the session path as one argument, so a path with a space is not split.

### Focus requests (A4, F16)

- **A harness serves every request for its root, whichever harness pid it names.** A request
  addressed to a harness that was displaced after it was posted is served by the harness that
  holds the root now.
- **A stopping harness leaves unread requests for the next one.** Its request directory is not
  removed, and the next harness serves any request in it.
- **The request-directory watch is re-armed** by the next sweep after it fails (A10).

### Hand-off (I24, I27)

- **The hand-off is kept current.** A harness rewrites `<harness pid file>.served` whenever the
  set of sessions it serves, has dropped for idling or is retrying to adopt changes, and removes
  it when all three are empty.
  So a harness killed before its SIGTERM handler runs, which `--restart` does after 2 s, still
  passes on what it served.
- **A hand-off that cannot be read is moved aside** to `<hand-off>.unreadable-<UTC time>`, kept,
  and reported on stderr. A line that does not
  parse is reported on stderr. A session waiting on an adoption retry is handed on with the
  displayed flag it was asked with.

### Sweep liveness (A6, A7, G18)

- **The sweep checks each served transcript**, at most once per 667 ms per session. One that is
  gone, has grown, was replaced, or whose last read failed is woken, so a lost watch event only
  delays it. A subagent scan the sweep runs keeps a failed read of the session's own transcript,
  so it never stamps swept over it. That covers a
  deleted session, the 1 h limit on a never-written session, and a directory whose watch failed.
- **A served session whose tree has a directory that cannot be watched has its subagents read**
  by the sweep, at most once per 667 ms, since no watch event comes for a subagent written there.
- **A failed directory watch is retried** by the sweep every 10 s while a served session, or a session dropped for idling, needs it.
  Meanwhile the sweep reads the size, inode and mtime of each session dropped for idling in such a
  directory, and a write adopts it again, a same-length rewrite included.

### Harness exit (A12, decision B; F17; I28, decision F)

- **The hand-off carries each idle session's size, inode and mtime**, so a session written while
  no harness ran is adopted by the next harness at once.
- **A session dropped for idling is forgotten `WTFT_DAEMON_IDLE_MS` after it was dropped** unless
  it is written first. The hand-off carries when it was dropped, so a later harness does not
  restart that clock.
- **A harness with no served session, no adoption pending and no session dropped for idling stops
  after `WTFT_DAEMON_IDLE_MS`** (24 h), after serving any request posted since its last read of
  them, so it hands nothing on. A request posted between that read and the pid file's removal is
  left in the request directory for the next harness; like the lease race, it needs two processes
  inside one short gap. A harness stopped for any other reason hands on the sessions it dropped
  for idling, so the next harness watches them.
- **A harness whose root directory is gone stops** at its next sweep.
- **`--cleanup` never stops a harness** (decision E, I26), fixture or not. A harness drops what it
  no longer serves, and stops when it serves nothing.
- **A harness that cannot read its pid file exits 1** (decision F), for any error but "no such
  file", with the error on stderr. There is no recovery logic.
- **A spawn waiting on a harness sleeps instead of spinning** (F17): after a failed hand-off, and
  while waiting for a stopped daemon to exit.

### Stop reason (decision P)

- **The stop line carries its reason**: `{"_hb":"stop","reason":"<reason>"}`. A per-session
  daemon writes it on shutdown, as before. A harness writes it when it drops a session whose lease
  it still holds for idling, removal or never being written, and when it stops. A stop on a failed
  tag write writes none.

## Closer

`tests/wtft-259-daemon-correctness.test.ts` checks the behaviours above; each check that pins a
fix failed before it. The rest are checked elsewhere, or have no check yet, or none a fixture can
make, as follows:

- **Checked in `tests/wtft-262-daemon-gaps.test.ts`**: a retrying session handed on with its
  displayed flag; the hand-off removed when nothing is served or idle; a per-session lease holder
  still signalled on adoption; the stop line for `session removed`; `-F` deleting a sibling
  project's tag; `-F` on Linux not signalling a lease pid with no command line; an idle session
  rewritten at the same length adopted again; `-F` naming a rebuild lease it cannot write; the
  stale-version remedy for a tag of a newer build.
- **Checked in `tests/wtft-270-session-tagger.test.ts`** (#267, as step sequences over the
  session tagger): the resume leaving a folded `claude -p` transcript to the one folding it; the
  held turn of a transcript no longer found, written under its earlier source and after a
  generation record when it opened none, or skipped when the transcript was read again under that
  source; a later line of a message merging its `claude -p` commands into the open lookup; a moved
  or deleted `claude -p` child's held turn written; reseed of a child sharing an id with a
  discovered transcript; the children a settled lookup found, read after a restart.
- **Checked in `tests/wtft-270-harness-registry.test.ts`** (#267 F): the scan-continuation
  marker re-keyed on a move, as a field of the record `move` re-keys.
- **Pi `/wtft -F` not asking for the session when busy**: busy means a daemon holds the lease or
  took it meanwhile, and asking then starts nothing, so a check cannot tell the two builds apart.
  The one exception, a lease released between two reads, needs two processes inside one syscall
  gap.
- **`-F` exiting 1 on a failed daemon spawn**, and **on a daemon it cannot signal**: node reports
  a spawn that cannot start as an error event, which ends the CLI with that error, so the exit-1
  path is reached only by a spawn that throws at once, which a fixture cannot cause; the second
  needs a `wtft-daemon` owned by another user.
- **An idle harness serving a request posted since its last read** needs two processes inside
  one sweep.
- **The sweep not re-waking a session whose adoption retry is pending** is reachable, without a
  check yet (#267).
- **The sweep reading the subagents of a session whose tree cannot be watched** is reachable,
  without a check yet (#267): a session directory that is searchable but not readable cannot be
  watched, while the `subagents` directory beneath it can still be listed.
- **The 1 h limit on a never-written session**, and the `session never written` stop line it
  writes, take an hour and have no knob.
- **A sweep-driven scan keeping a failed session read**: that scan reads the session's first line
  for Pi discovery, so a transcript that cannot be opened fails the scan by itself; only a read
  that fails past the first line reaches this rule, and a fixture cannot make one.

- **`--cleanup`** stops fixture daemons under `/tmp`, including those of suites running beside
  it, so its harness rule (decision E) is checked by reading the code.
- **The request-directory watch re-arm** changes latency only, under the 250 ms sweep, and so
  does the 10 s retry of a failed directory watch.
- **`--stop`'s `Not stopped` path** needs a lease to change inside one syscall gap.
- **The lease race**, and `-F` finding a harness lease changed before it replaces it, need two
  processes inside one syscall gap.
- **A9 off Linux** needs a host without `/proc`.

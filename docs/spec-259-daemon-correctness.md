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

- **Swept means every subagent turn is written.** A scan that holds back a subagent transcript's
  last turn (the one an interrupt record arriving next would mark) does not stamp the tag swept.
  The next scan that finds no new bytes writes that turn, and stamps swept if it was clean.

### Resume (A1 residual)

- **A resumed session reads again the `claude -p` transcripts it read before.** A daemon adopting
  a tag at its saved offset finds, from the tag's generation records, each subagent transcript an
  earlier daemon read that is not under the session's own directory. Each one written since the
  tag's last swept stamp (less 2 s, for coarse mtimes) is read again from its start, as a new
  generation, so what it gained while nothing served the session is counted. A transcript another
  one folds (a `_fold` record names it under the other's source) is never read on its own: the
  one that folds it is read again when either changed. A `claude -p` session spawned within the 15 s
  discovery window before the restart, and not yet on disk at the earlier daemon's last scan, is
  still missed: that is a known limit.

### Leases

- **Adoption never signals a harness** (decision H, A5). A harness asked for a session whose
  lease names another live harness does not take it; it retries (below). A per-session daemon
  holding the lease is still stopped with SIGTERM and waited for, because it serves only that
  session, and waiting keeps two writers off one tag.
- **An older per-session build never takes over from a newer one** (A9). It takes over only from
  a tag of an older version. With a newer-version tag present and its lease held by a live
  daemon, it exits 0. It never deletes a newer-version tag.
- **A daemon that gives up a lease logs it** (decision G): `gave up <session>: its lease now reads
  "<text>"`. Losing a lease is how a session passes to a newer build, so this is not an error.
- **The lease race is a known limit** (decision G, H19). Releasing a lease is stat, read, stat,
  unlink. A daemon that claims the same lease between the last stat and the unlink loses it, and
  finds out at its next check (250 ms in a harness, one poll in a per-session daemon). The session
  is then unserved until the next reader asks for it. No two daemons write the tag at once, and
  the next daemon resumes from the tag's saved offset. It needs two daemons acting on one session
  within microseconds, which only a harness handover to a newer build produces.

### Adoption

- **A failed adoption gives up loudly** (A3, F14). After the first try and five retries 667 ms
  apart, or as soon as the transcript is gone, the harness
  writes `could not adopt <session>: <reason>` to stderr, and removes the lease and `.display`
  marker if they still name it, so no reader is told the session is served.
- **A wake for a session whose lease reads `rebuild` adopts it again.** The old slot is dropped
  first, so the session is rebuilt on the next request. Any other lease that is not the harness's
  drops the session, as `--stop` means.

### `wtft -F` (decision M)

- **On a session a harness serves, `-F` rebuilds that one session.** It replaces the lease with
  `rebuild` and asks the harness for the session, which rebuilds the tag from the transcript. The
  harness and its other sessions are untouched. The CLI waits until the harness has adopted the
  session before it reads the tag, so its own report is of the rebuild. Telling a harness apart
  reads `/proc`, so this holds on Linux; elsewhere the harness is stopped as below.
- **Otherwise `-F` stops a live per-session daemon and deletes every version of the session's
  tag**, beside the transcript and in the sibling project where a moved session's tag lives. The
  CLI says whether a daemon was stopped. The CLI and the Pi widget share one implementation, so
  the widget now deletes every version too, not only the current one.
- **`wtft --list`, `--cleanup`, `--restart` and `--stop` pass `wtft-daemon`'s exit code through**,
  and pass the session path as one argument, so a path with a space is not split.

### Focus requests (A4, F16)

- **A harness serves every request for its root, whichever harness pid it names.** A request
  addressed to a harness that was displaced after it was posted is served by the harness that
  holds the root now.
- **A stopping harness passes on unread requests.** Requests still in its request directory go
  into its hand-off as served sessions, before the directory is removed.
- **The request-directory watch is re-armed** by the next sweep after it fails (A10).

### Hand-off (I24, I27)

- **The hand-off is kept current.** A harness rewrites `<harness pid file>.served` whenever the
  set of sessions it serves or has dropped for idling changes, and removes it when both are empty.
  So a harness killed before its SIGTERM handler runs, which `--restart` does after 2 s, still
  passes on what it served.
- **A hand-off that cannot be read is moved aside** to `<hand-off>.unreadable-<UTC time>`, kept,
  and reported on stderr. A line that does not
  parse is reported on stderr. A session waiting on an adoption retry is handed on with the
  displayed flag it was asked with.

### Sweep liveness (A6, A7, G18)

- **The sweep checks each served transcript**, at most once per 667 ms per session. One that is
  gone, has grown, or was replaced is woken, so a lost watch event only delays it. That covers a
  deleted session, the 1 h limit on a never-written session, and a directory whose watch failed.
- **A failed directory watch is retried** by the sweep every 10 s while a served session, or a session dropped for idling, needs it.

### Harness exit (A12, decision B; F17; I28, decision F)

- **A harness with no served session and no adoption pending stops after
  `WTFT_DAEMON_IDLE_MS`** (24 h). Sessions it dropped for idling go into its hand-off, so the next
  harness watches them.
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

`tests/wtft-259-daemon-correctness.test.ts`, one check per behaviour above, each failing before
its fix. Not reached by the suite, and why:

- **`--cleanup`** stops fixture daemons under `/tmp`, including those of suites running beside
  it, so its harness rule (decision E) is checked by reading the code.
- **The request-directory watch re-arm** changes latency only, under the 250 ms sweep, and so
  does the 10 s retry of a failed directory watch.
- **`--stop`'s `Not stopped` path** needs a lease to change inside one syscall gap.
- **The lease race** needs two processes inside one syscall gap.
- **A stopping harness passing on unread requests** depends on whether its sweep or its signal
  handler runs first; the suite checks the served-by-the-new-harness outcome only.

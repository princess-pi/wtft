# Spec 146 / 147 / 148 — subagent discovery: unreadable metadata, head reads, unbounded depth

**Issues:** [#146](https://github.com/princess-pi/wtft/issues/146),
[#147](https://github.com/princess-pi/wtft/issues/147),
[#148](https://github.com/princess-pi/wtft/issues/148) ·
**Tests:** `tests/wtft-146-149-subagent-discovery.test.ts`

Three gaps in `discoverSubagentSessionFiles` and its meta reader, each with its own closer.

## #146 — an unreadable `.meta.json` read as an absent one

`readSubagentMeta` returned `null` for every failure, so a consumer could not tell a harness
that writes no record from a record it could not read.

`readSubagentMetaChecked` returns `{ meta, error, metaPath }`. `error` is null for ENOENT and
ENOTDIR — the absent cases — and for a meta that reads but does not parse, which stays
indistinguishable from an absent one because only the read failure is observable as a failure.
A non-null `error` adds a `subagent-meta-unreadable` notice naming the file.

**The notice is emitted independently of whether the rows survive.** Discovery that is
incomplete for another reason withholds `subagents[]` entirely, and the notice still names the
unreadable meta — so a notice is never evidence that a row is listed.

**Closer:** `--json` on a session with a mode-000 meta lists the child with `meta: null` AND
carries a `subagent-meta-unreadable` notice naming it; the same session with the meta absent
carries no notice.

## #147 — discovery read whole transcripts to look at line 1

Both discovery halves and the `claude -p` scan read a file's first lines through
`readHeadLines(file, count)`: chunked `openSync`/`readSync`, stopping at the count. A session
transcript can be hundreds of MB, and discovery runs on every daemon poll and every widget
refresh.

**Closer:** discovery over three 4 MiB transcripts reads under 1 MiB, measured by an `fs` spy
running the bundle under stock node (`tests/lib/fs-read-spy.mjs`).

## #148 — a depth cap cut transcripts off a list that looked complete

The walk had a depth cap, so a transcript nested deeper than the cap was silently absent from
a settled-looking report. The cap is gone. The walk is bounded instead by a `seen` set of real
paths, shared by both discovery halves: each directory is visited once, and a transcript
reachable by two paths — a symlink cycle, a Pi sibling symlinked to a walked Claude child — is
listed once and counted once.

A directory named `*.jsonl`, or a symlink to one, holds no transcript. `isDirectory()` is false
for the symlink, so both halves skip on the read's EISDIR instead: reporting it would brand the
session unreadable and make the daemon withhold its swept marker on every poll from then on.

**Closer:** a transcript nested eight levels deep is listed and the report stays settled; a
`loop -> .` symlink lists its child once; a sibling symlinked to a walked child is listed once.

## One walk per read

`collectSelfAttributedSessionIds` takes an already-discovered file list, so the spawn tree's
double-count guard reuses the list its caller's read produced rather than walking again. Both
the CLI (`discoverOnce`) and the widget pass one.

**Closer:** one `--json` run and one widget render each walk the subagents directory exactly
once, counted by the same `fs` spy.

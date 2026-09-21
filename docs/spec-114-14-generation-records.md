# Spec 114 · 14 — generation records, and nested `claude -p` re-attribution

**Issues:** [#114](https://github.com/princess-pi/wtft/issues/114),
[#14](https://github.com/princess-pi/wtft/issues/14) ·
**Plan:** P4 of [#194](https://github.com/princess-pi/wtft/issues/194), decision D1 ·
**Test:** `tests/wtft-114-generation-records.test.ts`

## The contract

A tag file is append-only. The daemon re-parses a child transcript whole whenever it changes and
appends only the lines it has not written before. Two things break that:

- **#114, rotation.** When a child transcript shrinks or is replaced, the daemon forgets what it
  wrote and appends the new content. The old lines stay. The new run's message ids differ, so
  id dedup cannot merge them: N old interactions plus M new ones are billed N + M.
- **#14, nested `claude -p`.** A child's turn that runs `claude -p` has the nested session's cost
  folded onto it at parse time. The child is re-parsed only when the child's own transcript
  changes. A nested session that keeps writing after the child's last write (a backgrounded
  command, or a child that finished first) stays at the cost it had at that parse. A nested
  session whose transcript did not exist yet at that parse is not folded at all.

So: **each child transcript's lines belong to a generation, and the reader counts only the
latest one. A child is re-parsed whenever a nested transcript folded into it changes, and while
a spawning turn can still gain a nested session.**

## Shape

### Tag format

- **Source field `s`** on every interaction line the daemon writes from a child transcript, and
  inside every fold record: `{"_fold":{"parent","child","s"}}`. `s` is the first 8 hex digits of
  the SHA-1 of the child transcript's absolute path. Lines from the tag's own session carry no
  `s`.
  - **Why a path hash, not the session id D1 named:** two copies of one session in two project
    dirs are two transcripts. Keyed on the session id, one copy's generation would drop the other
    copy's lines. The hash is also shorter than a session id, and it is stable across daemon
    restarts because the path is.
- **Generation record, a fifth line kind:** `{"_gen":{"s":"<hash>","session":"<id>"}}`. It opens
  a new generation for that source. `session` is the transcript's filename without `.jsonl`, for
  a human reading the file.
- **Reader rule:** a line carrying `s` counts only if no `_gen` record for the same `s` follows
  it in the file. This covers interaction lines and fold records alike. A line with no `s` always
  counts.
- **A generation record is data, not a marker**, like a fold record: a tag whose last data line
  is one reads unswept.
- **`WTFT_TAGGER_VERSION` 2.9.0 → 2.10.0.** A 2.9.0 tag reads `stale-version`, the daemon
  rebuilds it, and the run exits 9 until it does, as in the 2.9.0 bump.

### Writing

- **When the daemon writes a generation record:** on the first successful parse of a child
  transcript in a daemon life, and on the first successful parse after the transcript rotated.
  The record goes first in the append, followed by every line of the current parse and every
  fold record it implies. A generation with no lines still writes its record, so a transcript
  rotated to empty drops its old lines.
- **Rotation** is a size decrease or a changed inode since the last parse. The inode check
  catches a replacement that is already larger than the file it replaced.
- **Per-source fold records.** Fold records are deduplicated per source per generation, not per
  daemon life. Two children that both fold one session each record it, so one child's new
  generation cannot drop the only record of a session the other child still holds.
- **Cost.** A daemon restart already re-appended every child line, because the set of written
  lines lives only in memory. It now also writes one generation record per child. That record
  is what makes the restart correct: a restart that re-appended an id-less line used to bill it
  twice.

### Re-attribution (#14)

- **The fold carries its file.** Each `SubAgentFold` the parser produces now carries the
  transcript path it parsed and that file's size and mtime, taken before the read. Nested folds
  carry theirs, at any depth.
- **The daemon re-parses a child when any folded file changed.** Each poll stats the files the
  child's last parse folded. A changed stamp, or a file that no longer stats, counts as a change
  to the child, under the same settle rule as the child's own transcript. Re-parsing puts the
  grown cost on the spawning turn's line; the tag's id dedup keeps the highest-cost copy (§4 of
  `docs/wtft-tag-format.md`), so the grown line supersedes the old one.
- **The daemon re-parses a child while a spawning turn is still open.** Discovery matches a
  nested session whose first timestamp is within `CLAUDE_SUBAGENT_WINDOW_MS` of the spawning
  turn, so until that window plus `MTIME_SETTLE_MS` has passed, a later parse can find a nested
  session this one did not. Each such child is re-parsed every poll until then.
- **The tag's own session gets the same window.** A `claude -p` command in the tag's own session
  stays in `pendingClaudeCommands`, re-discovered every poll, until its window closes. Before
  this change the first discovery that found any file ended the search, so a second child that
  started later in the window was never read.
- **Road not taken: a bound at `IDLE_THRESHOLD_MS`.** #194's plan named it. Growth is tracked by
  stat, so it needs no time bound, and discovery cannot find anything once its window has
  closed, so the window is the bound that fits.

### Out of scope

- **The tag's own transcript rotating.** Its lines carry no `s`, so a rotation of the session
  transcript itself is not covered. Filed as [#202](https://github.com/princess-pi/wtft/issues/202).

## Verification

`tests/wtft-114-generation-records.test.ts`:

- **Reader:** lines and fold records before a `_gen` for their `s` are dropped; lines of another
  `s`, and lines with no `s`, are kept; a `_gen` makes the tag read unswept.
- **#114 closer:** the daemon writes N interactions from a child, the child is replaced by M
  different ones (both by truncation and by a larger file under a new inode), and the tag's total
  equals the M interactions' total.
- **Restart:** a daemon restart does not double an id-less child line.
- **#14 closer:** a child's spawning turn folds a nested session, the child stops writing, the
  nested session grows; the tag's cost for the spawning turn equals a full re-parse within
  $0.000001, with no `wtft -F`.
- **#14 late nested session:** the nested transcript appears after the child's first parse, inside
  the window; the tag folds it.
- **Pending window:** a second `claude -p` child of the tag's own session that starts after the
  first was found is read.

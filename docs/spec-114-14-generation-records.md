# Spec 114 · 14 — generation records, and nested `claude -p` re-attribution

**Issues:** [#114](https://github.com/princess-pi/wtft/issues/114),
[#14](https://github.com/princess-pi/wtft/issues/14) ·
**Plan:** P4 of [#194](https://github.com/princess-pi/wtft/issues/194), decision D1 ·
**Test:** `tests/wtft-114-generation-records.test.ts`

## The contract

A tag file is append-only. The daemon reads a child transcript from a stored byte offset and
appends the lines in the new bytes. A rotation resets that offset and appends the replacement
behind a new generation. Two things break a reader that counts every appended line:

- **#114, rotation.** When a child transcript shrinks or is replaced, the daemon forgets what it
  wrote and appends the new content. The old lines stay. The new run's message ids differ, so
  id dedup cannot merge them: N old interactions plus M new ones are billed N + M.
- **#14, nested `claude -p`.** A child's turn that runs `claude -p` has the spawned subagent
  session's cost folded onto it at attribution time. Before this contract, that fold was taken
  only when the child's own transcript changed. A subagent session that kept writing after the
  child's last write (a backgrounded command, or a child that finished first) stayed at the cost
  it had then. One whose transcript did not exist yet was not folded at all.

So: **each child transcript's lines belong to a generation, and the reader counts only the
latest one. A child is re-attributed whenever a transcript folded into it changes, and while a
spawning turn can still gain a subagent session.** The child's own bytes are read again only
when the file grew or rotated.

## Shape

### Tag format

- **Source field `s`** on every interaction line the daemon writes from a child transcript, and
  inside every fold record: `{"_fold":{"parent","child","s"}}`. `s` is the first 16 hex digits of
  the SHA-1 of the child transcript's path: relative to the session directory when it lies under
  it, absolute when it does not. Lines from the tag's own session carry no `s`.
  - **Why a path hash, not the session id D1 named:** two copies of one session in two project
    dirs are two transcripts. Keyed on the session id, one copy's generation would drop the other
    copy's lines. A child under the session directory is keyed relative to it and one outside is
    keyed absolutely, so `followMovedSession` changes neither: a Task child moves with the session
    and keeps its relative path, a `claude -p` child does not move at all. The hash is also
    shorter than a session id.
- **Generation record, a line kind of its own:** `{"_gen":{"s":"<hash>","session":"<id>"}}`. It opens
  a new generation for that source. `session` is the transcript's filename without `.jsonl`, for
  a human reading the file.
- **Reader rule:** a line carrying `s` counts only if no `_gen` record for the same `s` follows
  it in the file. This covers interaction lines and fold records alike. A line with no `s` always
  counts. Every tag reader applies it, including the session picker's summary, which keeps its own
  collapse rather than importing the daemon library.
- **A generation record is data, not a marker**, like a fold record: a tag whose last data line
  is one reads unswept.
- **`WTFT_TAGGER_VERSION` 2.9.0 → 2.10.0.** A 2.9.0 tag reads `stale-version`; the daemon
  builds a tag at the new version beside it and unlinks the old one, and the run exits 9 until
  it does, as in the 2.9.0 bump.

### Writing

- **When the daemon writes a generation record:** on the first successful read of a child
  transcript in a daemon life, and on the first successful read after the transcript rotated.
  The record goes first in the append, followed by every line of that read and every
  fold record it implies. A generation with no lines still writes its record, so a transcript
  rotated to empty drops its old lines.
- **Rotation is an inode change, a shrink, a content-hash mismatch, or an attributed cost
  that dropped.** A same-length rewrite on the same inode matches neither size nor inode.
  While `readAtMs` is inside `MTIME_SETTLE_MS`, and again when `mtimeMs` moves and `size` does
  not, the whole file is hashed against the bytes already consumed. A mismatch resets the
  offset and opens a generation. A turn re-emitted with growing usage is an ordinary append:
  the new line sits beside the old one, and id dedup keeps the higher cost. A larger
  replacement on a new inode is the rename case. A smaller replacement is the shrink.
- **Per-source fold records.** Fold records are deduplicated per source per generation, not per
  daemon life. Two children that both fold one session each record it, so one child's new
  generation cannot drop the only record of a session the other child still holds.
- **Cost.** A daemon restart already re-appended every child line, because the read offset
  lives only in memory. It now also writes one generation record per child. That record
  is what makes the restart correct: a restart that re-appended an id-less line used to bill it
  twice.

### Re-attribution (#14)

- **The fold carries its file.** Each `SubAgentFold` the parser produces now carries the
  transcript path it parsed and that file's size, mtime and inode, taken before the read. Folds
  at any depth carry theirs.
  - **Residual:** a folded transcript rewritten to the same byte length inside one mtime tick
    has the same stamp, so that rewrite is not seen. The child's own transcript is covered
    against the same case by the settle rule; a folded one is not.
- **The daemon re-attributes a child when any folded file changed.** Each poll stats the files the
  child's last attribution folded. A changed stamp, or a file that no longer stats, counts as a change.
  `attributeClaudeSubAgentCosts` runs again on every retained fold-capable turn. That puts the
  grown cost on the spawning turn's line; the tag's id dedup keeps the highest-cost copy (§4 of
  `docs/wtft-tag-format.md`), so the grown line supersedes the old one. The child's own bytes
  are not read again unless the child grew or rotated. An attributed cost that dropped rotates
  the child, so the old higher line falls into a superseded generation instead of winning the max.
- **The daemon re-attributes a child while a spawning turn is still open.** Discovery matches a
  subagent session whose first timestamp is within `CLAUDE_SUBAGENT_WINDOW_MS` of the spawning
  turn, so until that window plus `MTIME_SETTLE_MS` has passed, a later attribution can find one this
  pass did not. Each such child is re-attributed every poll until then. Since #107 A a bare `claude -p` opens a window
  too, against the session's own cwd. What opens none is a turn whose spawns name no directory the
  fallback stands in for: an unknowable `cd` target, a bare `cd`, a launcher, or a session whose
  own cwd is unreadable.
- **The tag's own session gets the same window.** A `claude -p` command in the tag's own session
  whose discovery has found a transcript stays in `pendingClaudeCommands`, re-discovered every
  poll, until its window closes. Before this change the first discovery that found any file ended
  the search, so a second child that started later in the window was never read. The two arms
  either side were unchanged here: one that has found nothing, and one whose discovery hit an
  unreadable directory, both stayed pending with no time bound. #128 has since bounded the first
  to the same window; the unreadable arm still retries until the read succeeds. Only a turn with nothing to search waits out its
  window (#107) and is then dropped.
- **Road not taken: a bound at `IDLE_THRESHOLD_MS`.** #194's plan named it. Growth is tracked by
  stat, so it needs no time bound, and the window is what discovery matches against, so it is the
  bound that fits.
  - **What the window bound gives up:** discovery matches a transcript's own first timestamp, not
    the moment it reaches disk, so a transcript written inside the window but created after it
    closes is no longer looked for. The alternative is a directory scan every poll for the
    daemon's life.

### Out of scope

- **The tag's own transcript rotating.** Its lines carry no `s`, so a rotation of the session
  transcript itself is not covered. Filed as [#202](https://github.com/princess-pi/wtft/issues/202).

## Verification

`tests/wtft-114-generation-records.test.ts`:

- **Reader:** lines and fold records before a `_gen` for their `s` are dropped; lines of another
  `s`, and lines with no `s`, are kept; a `_gen` makes the tag read unswept.
- **#114 closer:** the daemon writes N interactions from a child, the child is replaced by M
  different ones (by truncation, by a larger file under a new inode, and by a same-length rewrite
  in place), and the tag's total equals the M interactions' total plus the session's own turns.
- **Restart:** a daemon restart does not double an id-less child line.
- **#14 closer:** a child's spawning turn folds a subagent session, the child stops writing, the
  folded session grows; the tag's cost for the spawning turn equals a full re-parse within
  $0.000001, with no `wtft -F`.
- **#14 late subagent session:** the spawned transcript appears after the child's first parse,
  inside the window; the tag folds it.
- **Pending window:** a second `claude -p` child of the tag's own session that starts after the
  first was found is read.

## Reconciliation record

Four fresh-context auditors (daemon, reader, parser, host-scoped documents) and three `pr-review`
rounds ran against this branch. Everything they raised about text or code this branch changed was
fixed here — the source key, the session picker's summary, the watch-mode short read, and the
claims in `docs/wtft-tag-format.md`, `CONTEXT.md`, `docs/wtft-incremental-render-spec.md` and
`CLAUDE.md`. Drift that predates the branch is recorded as leads on
[#200](https://github.com/princess-pi/wtft/issues/200).

**Left standing here, with the reason:**

| Raised | Why it stands |
|---|---|
| A fold record survives into a new generation of the source that wrote it, so the in-self set could name a session the new generation does not hold | It cannot: a generation re-emits the fold records of the parse that opened it, and the reader drops the earlier ones by source. A record written by a *different* source is that source's to supersede |
| A child whose own turns are all untagged is still recorded as folded, while its money is in `untaggedCostUsd` rather than in `total` | No money moves either way — `computeSpawnTree` drops `untaggedCostUsd` from an edge's total too. It is the honesty gap [#180](https://github.com/princess-pi/wtft/issues/180) item 7 owns, P9 of #194 |
| A folded transcript rewritten to the same byte length inside one mtime tick keeps its stamp | Stated as the residual under "The fold carries its file". The child's own transcript is covered against that case by the settle rule; a folded one is not |
| A transcript created after its spawning turn's window closes is no longer looked for | Stated as "What the window bound gives up". The alternative is a directory scan every poll for the daemon's life |
| Two separately discovered copies of one child transcript collapse by `messageId`, said to undercount their combined cost | They are one session found at two paths, so their turns share ids and summing them would double-count. Two distinct children never collide — each has its own session ids. `s` is a supersession key, not an identity: adding it to the dedup key would stop a rotation's pre- and post-rotation copies collapsing |

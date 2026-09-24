# Spec 230 / 231 / 232 — spend the spawn tree walks past, or prices as $0

**Issues:** [#230](https://github.com/princess-pi/wtft/issues/230),
[#231](https://github.com/princess-pi/wtft/issues/231),
[#232](https://github.com/princess-pi/wtft/issues/232) ·
**Found by:** the P9 spec-reconcile of [#194](https://github.com/princess-pi/wtft/issues/194) ·
**Test:** `tests/wtft-230-231-232-spawn-tree-gaps.test.ts`

All three change what `spawned.total` holds, which is money, so none was a doc fix. No schema
moves: `wtft/spawn-tree@4` keeps its shape, and only the amounts an edge carries change.

## 1. #230: a descendant is priced with its Task subagents

A counted edge's `total` is the child's own transcript **plus every transcript
`discoverSubagentSessionFiles(<child>.jsonl)` lists** — the same set a root session's SELF merges.
The folds those subagent parses make count toward the edge exactly as the child's own folds do.
Every part is parsed with the child and all its subagent transcripts as `doNotFold`, so no part
folds another. Which files discovery lists, and which it skips without reporting, is
`discoverSubagentSessionFiles`'s contract (`docs/wtft-incremental-render-spec.md` § *Where the
transcripts are on disk*); this change prices what it lists.

**Each subagent session is billed once.** A subagent transcript's id is its file name without
`.jsonl`. One already in a total (in-self, counted under its own edge, or folded) is left out of
the child's total whole. Any other is marked folded, like a `claude -p` session the child's parse
folds, so a later ledger edge to it reads `already-counted` and its own ledger children are
walked (§2). It is marked folded whatever its turns are: an untagged turn in it is named in the
child's `descendantUntagged` entry, not added to `spawned.total`. A subagent session with an
`unattributed` entry from an earlier edge has that entry removed, and the earlier edge keeps its
skip. A Pi sibling session with a `parentSession` header is one such transcript: before this
change it was priced only under its own edge, and now it is priced inside whichever reaches it
first.

**Whole or null.** If that discovery reports a file it could not read or throws, or any listed
transcript cannot be read, has no parseable line (§3), or cannot be stat-ed, the edge is
`skip: "unreadable"`, `total: null`, with an `unattributed` entry, the same as a child transcript
that cannot be opened. An edge total never leaves out a listed file, because nothing in the report
would say it had. Inside one file, a bad line is still skipped and the good lines priced, as
everywhere else.

**`live`** is true when any of those files, not only the child's own, has an mtime within
`IDLE_THRESHOLD_MS` of now, on either side. A child waiting on a Task subagent writes nothing to
its own transcript while the subagent works. A `claude -p` session the child folded is not one of
those files, so its writes do not set `live`.

## 2. #231: the ledger children of an in-self or folded session are walked

The walk no longer starts from the root alone. Every id in `alreadyAttributed` is queued as a
parent at depth 2, as if it were a depth-1 child, and an id a descendant's parse folds, or a
subagent session priced inside it (§1), is queued when it is folded, at that descendant's
depth + 2. Only that session's own transcript is inside
the total; its ledger children are priced like any other edge.

The walk runs **level by level**, so a session queued at depth `d` is visited after every
shallower one and each is still reached at its minimum depth.

**`alreadyAttributed` thunk:** it is now called whenever the ledger holds any edge (or
`unrecorded` is asked for), not only when the root has one, since any in-self id may be a
parent. The walk still returns before resolving anything when neither the root nor an in-self id
has an edge. The widget's thunk is `collectSelfAttributedSessionIds`, a union over data already
in memory, so no discovery runs either way; the CLI passes a plain Set of the tag's fold records.

## 3. #232: a transcript with no parseable line is unreadable, not $0

`parseSessionFileStrict` is `parseSessionFile`, at the default chunk size, that throws when the
file has non-blank lines and not one of them passes `JSON.parse`. That is the whole test: a file
of JSON lines that are not transcript entries (`{}`, `42`) parses to no turns and is a $0 edge. The walk uses it for the child and its subagent transcripts, so
such a file is `skip: "unreadable"`, `total: null`, with an `unattributed` entry. An empty file,
or one with only blank lines, is still an empty session. `parseSessionFile` itself is unchanged:
the daemon, the root's own parse and the root's subagent loads keep treating a bad line as a bad
line, so a root subagent transcript with no parseable line still reads as $0 in SELF. That is
outside this change, which is about the spawn tree.

**`unrecorded` is left as it is.** #232 named it too, but a transcript is listed as a candidate
only when a line of its head parses and carries a timestamp and a cwd, so a listed file always
has a parseable line and the strict parse could never fire there.

## Closer

`tests/wtft-230-231-232-spawn-tree-gaps.test.ts`:

- **#230** S → C, C with one Task subagent transcript carrying 500 output tokens:
  `edges[0].total.outputTokens` includes the 500. An unreadable subagent transcript under C makes
  the edge `unreadable` with `total: null`.
- **#231** S with no ledger edge, P in S's `alreadyAttributed`, and a ledger edge P → G: G is in
  `edges[]`, counted, and in `total`. The same holds when P is folded by a counted descendant
  rather than being in-self.
- **#232** S → C where every line of `C.jsonl` fails `JSON.parse`: the edge is
  `skip: "unreadable"`, `total: null`, and `unattributed` names C. An empty `C.jsonl` is still
  a counted $0 edge.

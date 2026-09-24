# Spec 230 / 231 / 232 — spend the spawn tree walks past, or prices as $0

**Issues:** [#230](https://github.com/princess-pi/wtft/issues/230),
[#231](https://github.com/princess-pi/wtft/issues/231),
[#232](https://github.com/princess-pi/wtft/issues/232) ·
**Found by:** the P9 spec-reconcile of [#194](https://github.com/princess-pi/wtft/issues/194) ·
**Test:** `tests/wtft-230-231-232-spawn-tree-gaps.test.ts`

All three change what the spawn tree reports about money: what an edge total holds, which edges
are walked, and whether a child reads as $0 or as a gap. None was a doc fix. No schema moves:
`wtft/spawn-tree@4` gains no field and loses none.

## 1. #230: a descendant is priced with its Task subagents

A counted edge's `total` is the child's own transcript **plus every transcript
`discoverSubagentSessionFiles(<child>.jsonl)` lists, and every transcript it lists for those in
turn**. The root session's SELF takes the first level only; the walk follows the chain so that a
Pi sibling's own sibling is priced whichever session the walk reaches first.
The folds those subagent parses make count toward the edge exactly as the child's own folds do.
Every part is parsed with the child and all its subagent transcripts as `doNotFold`, so no part
folds another. The parts are parsed in order, and a `claude -p` session a kept part folds is added
to `doNotFold` for the parts after it, so two parts never fold the same session. Which files discovery lists, and which it skips without reporting, is
`discoverSubagentSessionFiles`'s contract (`docs/wtft-incremental-render-spec.md` § *Where the
transcripts are on disk*; its unreported skips are listed in #236); this change prices what it
lists.

**Each subagent session is billed once.** A subagent transcript's id is its file name without
`.jsonl`. One already in a total (in-self, counted under its own edge, or folded) is left out of
the child's total whole. Any other is marked folded, like a `claude -p` session the child's parse
folds, so a later ledger edge to it reads `already-counted` and its own ledger children are
walked (§2). It is marked folded whatever its turns are: an untagged turn in it is counted in the
child's `descendantUntagged` entry, not added to `spawned.total`, so a later edge onto it reads
`already-counted` although that untagged cost is outside the total. A subagent session with an
`unattributed` entry from an earlier edge has that entry removed, and the earlier edge keeps its
skip. A Pi sibling session with a `parentSession` header is one such transcript: before this
change it was priced only under its own edge. Now it is priced once: in SELF when the caller
names it in `alreadyAttributed` (the tag's fold records name Pi siblings), else inside the
descendant or under its own edge, whichever prices it first. An own edge that could not price it
(unresolved, or depth-capped) leaves it to the descendant.

**Whole or null.** If that discovery reports a file it could not read or throws, or any listed
transcript cannot be read, has non-blank lines and not one that parses (§3), or cannot be
stat-ed, or a `claude -p` transcript one of those parses folds cannot be read or stat-ed, or its
discovery fails, the edge is
`skip: "unreadable"`, `total: null`, with an `unattributed` entry, the same as a child transcript
that cannot be opened. An edge total never leaves out a listed file it could not read, because
nothing in the report would say it had; the only file it leaves out is one already in a total.
Every listed file is read before that exclusion, so one that cannot be read makes the edge
`unreadable` even when its money would have been left out. Inside one file, a bad line is still skipped and the good lines priced, as
everywhere else.

**`live`** is true when any of those files, not only the child's own, has an mtime within
`IDLE_THRESHOLD_MS` of now, on either side. A child waiting on a Task subagent writes nothing to
its own transcript while the subagent works. A `claude -p` session the child folded is not one of
those files, so its writes do not set `live`.

## 2. #231: the ledger children of an in-self or folded session are walked

The walk no longer starts from the root alone. Every id in `alreadyAttributed` is queued as a
parent at depth 2, as if it were a depth-1 child, and an id a descendant's parse folds on a
model-tagged turn, or a
subagent session priced inside it (§1), is queued when it is folded, at that descendant's
depth + 2. Only that session's own transcript is inside
the total; its ledger children are priced like any other edge.

The walk runs **level by level**. A session queued deeper (a fold queues two levels down) and
then reached by a shallower edge is queued again at the shallower depth, and only that entry is
walked, so each session's edges are walked once, at its minimum depth.

**`alreadyAttributed` thunk:** it is now called whenever the ledger holds any edge, or whenever
`unrecorded` is asked for (even on an empty ledger), not only when the root has one, since any in-self id may be a
parent. The walk still returns before resolving anything when neither the root nor an in-self id
has an edge. The widget's thunk is `collectSelfAttributedSessionIds`, a union over data already
in memory, so no discovery runs either way; the CLI passes a plain Set of the tag's fold records
(an empty Set on the pending arm).

## 3. #232: a transcript with no parseable line is unreadable, not $0

`parseSessionFileStrict` is `parseSessionFile`, at the default chunk size, that throws when the
file has non-blank lines and not one of them passes `JSON.parse`. That is the whole test: a file
of JSON lines that are not transcript entries (`{}`, `42`) parses to no turns and is a $0 edge. The walk uses it for the child and its subagent transcripts, so
such a file is `skip: "unreadable"`, `total: null`, with an `unattributed` entry. An empty file,
or one with only blank lines, is still an empty session. `parseSessionFile` itself is unchanged:
the daemon, the root's own parse, the root's subagent loads, the `unrecorded` pricing, and the
`claude -p` transcripts a parse folds (inside the walk too) keep treating a bad line as a bad
line. So a root subagent transcript, or a folded `claude -p` transcript, with no parseable line
still reads as $0: #235.

**`unrecorded` is left as it is.** Its rows still price a candidate's transcript alone, without
the subagent transcripts an edge now adds, so a launcher child can read cheaper there than once
recorded. It is a list, never summed. #232 named it too, but a transcript is listed as a candidate
only when a line of its head parses and carries a timestamp and a cwd, so a listed file always
has a parseable line and the strict parse could never fire there.

## Closer

`tests/wtft-230-231-232-spawn-tree-gaps.test.ts`:

- **#230** S → C, C with one Task subagent transcript carrying 500 output tokens:
  `edges[0].total.outputTokens` includes the 500. An unreadable subagent transcript under C makes
  the edge `unreadable` with `total: null`. When C's transcript and its subagent each fold the
  same `claude -p` session F, the edge bills F once. A Pi sibling's own sibling is priced once
  in both edge orders (H11).
- **#231** S with no ledger edge, P in S's `alreadyAttributed`, and a ledger edge P → G: G is in
  `edges[]`, counted, and in `total`. The same holds when P is folded by a counted descendant
  rather than being in-self. With edges S → D, S → F, F → G, where D folds F, and `maxDepth` 2:
  G is counted at depth 2, not cut, because F's own edges are walked at F's minimum depth.
- **#232** S → C where every line of `C.jsonl` fails `JSON.parse`: the edge is
  `skip: "unreadable"`, `total: null`, and `unattributed` names C. An empty `C.jsonl` is still
  a counted $0 edge.

## Reconcile record

Four fresh-context audit passes, each against `wtft-spawn-tree.ts` and the parse and discovery
functions of `wtft-parser.ts`.

| Pass | Scope | Outcome |
|---|---|---|
| 1 | README, `CONTEXT.md`, manifest, `EXT_WTFT.html`, twelve specs, host documents | Every claim this branch made stale was fixed. Older drift is filed as #236. |
| 2 | Prose changed by pass 1 | Found a code bug: a folded session reached later by a shallower edge kept the deeper depth. Fixed and tested (I12). The rest was wording, fixed. #235 widened to folded `claude -p` transcripts. |
| 3 | Prose changed by pass 2 | Found a code bug: two parts of one descendant folding one session billed it twice. Fixed and tested (H10). The rest was wording, fixed. #237 filed for the same shape in the widget's SELF. |
| 4 | Prose changed by pass 3 | Two contradictions in this spec and three partial summaries, all fixed. The rest are noted below. |

`pr-review` round 1 (before the PR opened) found two Medium and eight Low:

- **Fixed:**
  - A Pi sibling's own sibling was lost when the descendant was reached first. Discovery is now
    followed transitively (H11).
  - Live-check stats stopped at the first live file; every file is now stat-ed.
  - Per-part fold shares disagreed with the cross-part deduplication. Parts are now parsed in
    order, and each skips what an earlier kept part folded.
  - A stale `Outcome` comment was deleted, and issue numbers were removed from test comments.
  - spec-116's `--tokens` trigger and spec-26's `descendantUntagged` and `live` rows are updated.
- **Declined:**
  - "A Pi child recorded under its bare UUID is double-counted": both harnesses resolve an id
    only by exact file basename, so such an edge is `not-found` and nothing is priced twice.
  - "`agent-<hash>` ids may collide across sessions": the harness names a Task transcript by a
    random hash, and no collision has been seen.
  - "spec-128's *as for an edge* is stale": that phrase is about dropping `untaggedCostUsd`,
    which still holds. The subagent difference is stated above.

**Noted, not changed.** Each is a finer point of a summary that points at this spec, or a
behaviour older than this branch:

- The discovery exceptions (`wtft-tags`, symlinked directories, ENOENT/ELOOP) live in
  `docs/wtft-incremental-render-spec.md`; the glossary entry summarises and does not repeat them.
- A fold on an untagged or de-duplicated turn is neither marked folded nor queued. Its cost
  sits in `descendantUntagged`, as `CONTEXT.md` § Self / tree already says.
- "Minimum depth" is the smallest of the assigned queue depths (§2), not a position in the ledger.
- One unreadable unrelated transcript in a `claude -p` child's project directory fails the fold
  discovery, and with it the edge. That behaviour predates this branch; it is on #236.

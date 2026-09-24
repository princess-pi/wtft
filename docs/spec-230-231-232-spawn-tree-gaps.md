# Spec 230 / 231 / 232 — spend the spawn tree walks past, or prices as $0

**Issues:** [#230](https://github.com/princess-pi/wtft/issues/230),
[#231](https://github.com/princess-pi/wtft/issues/231),
[#232](https://github.com/princess-pi/wtft/issues/232) ·
**Found by:** the P9 spec-reconcile of [#194](https://github.com/princess-pi/wtft/issues/194) ·
**Test:** `tests/wtft-230-231-232-spawn-tree-gaps.test.ts`

All three change what `spawned.total` holds, which is money, so none was a doc fix.

## 1. #230: a descendant is priced with its Task subagents

A counted edge's `total` is the child's own transcript **plus every transcript
`discoverSubagentSessionFiles(<child>.jsonl)` lists** — the same set a root session's SELF merges.
The folds those subagent parses make count toward the edge exactly as the child's own folds do.

**Each subagent session is billed once.** A subagent transcript's id is its file name without
`.jsonl`. One already in a total (in-self, counted under its own edge, or folded) is left out of
the child's total whole. Any other is marked folded, like a `claude -p` session the child's parse
folds, so a later ledger edge to it reads `already-counted` and its own ledger children are
walked (§2). A Pi sub-session with a `parentSession` header is one such transcript: before this
change it was priced only under its own edge, and now it is priced inside whichever reaches it
first.

**Whole or null.** If that discovery reports a file it could not read, throws, or any listed
subagent transcript fails to parse, the edge is `skip: "unreadable"`, `total: null`, with an
`unattributed` entry, the same as a child transcript that cannot be opened. An edge total is
never the readable part of a partly-read descendant, because nothing in the report would say
it was partial.

**`live`** is true when any of those files, not only the child's own, was written within
`IDLE_THRESHOLD_MS`. A child waiting on a Task subagent writes nothing to its own transcript
while the subagent works.

## 2. #231: the ledger children of an in-self or folded session are walked

The walk no longer starts from the root alone. Every id in `alreadyAttributed` is queued as a
parent at depth 2, as if it were a depth-1 child, and an id a descendant's parse folds is queued
when it is folded, at that descendant's depth + 2. Only that session's own transcript is inside
the total; its ledger children are priced like any other edge.

The walk runs **level by level**, so a session queued at depth `d` is visited after every
shallower one and each is still reached at its minimum depth.

**`alreadyAttributed` thunk:** it is now called whenever the ledger holds any edge (or
`unrecorded` is asked for), not only when the root has one, since any in-self id may be a
parent. The walk still returns before resolving anything when neither the root nor an in-self id
has an edge. The thunk is `collectSelfAttributedSessionIds`, a union over data already in
memory, so no discovery runs either way.

## 3. #232: a transcript with no parseable line is unreadable, not $0

`parseSessionFileStrict` is `parseSessionFile` that throws when the file has non-blank lines and
not one of them parses as JSON. The walk uses it for the child and its subagent transcripts, so
such a file is `skip: "unreadable"`, `total: null`, with an `unattributed` entry. An empty file,
or one with only blank lines, is still an empty session. `parseSessionFile` itself is unchanged:
the daemon and the root's own parse keep treating a bad line as a bad line.

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

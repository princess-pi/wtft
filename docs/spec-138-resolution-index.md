# Spec — #138: one session index per spawn-tree walk

> **Issue:** [#138](https://github.com/princess-pi/wtft/issues/138) — *spawn-tree resolution is
> O(distinct children) filesystem scans with no cache or work bound.* Part of **P7** of
> [#194](https://github.com/princess-pi/wtft/issues/194); #97 is P7's other half, in its own PR.

## The gap

`computeSpawnTree` resolves each distinct child with `resolveSessionFile(id)`, which asks every
harness's `resolveSessionById`. Both built-ins answer that by walking their **whole** session tree
and keeping the newest file named for the id. So one walk costs one full tree scan per distinct
child. Measured on this host 2026-09-22: **66 ms per unresolved id**. A ledger at its 8 MiB
limit holds roughly 40,000 edges (spec-116), which is about 44 minutes of synchronous scanning on the
`--json`/`--tokens` path; #138's 10,000-edge Closer case alone is about 11 minutes.

## The change

**One index per walk, built lazily.** A harness may implement a new optional seam method:

```ts
indexSessionsById?(): Map<string, string>;  // session id → its newest transcript path
```

It walks the tree once, with the same rules `resolveSessionById` uses: the same files, and the
newest by mtime when one id has two files. The resolver strips a trailing `.jsonl` from the id
first, as every `resolveSessionById` does, so a child recorded as `<uuid>.jsonl` still resolves. Both built-ins implement it and define
`resolveSessionById` as a lookup in a fresh index, so the two cannot disagree.

`computeSpawnTree` builds a resolver when its walk first needs one. For each harness, in registry
order: the index when the harness has the method, else that harness's `resolveSessionById`,
asked per id. The first harness that knows an id wins, which is the order `resolveSessionFile`
already uses. Answers are memoised for the walk. A harness that throws while indexing is treated
the way a throwing `resolveSessionById` is today: it cannot answer, so the next one is asked.

**Scope of the cache: one walk.** The index is thrown away when `computeSpawnTree` returns, so it
can never serve a stale path to a later report. A child that moves during one walk is found where
it was when the walk began, which is the most one walk could promise.

**Road not taken — a work bound.** The issue asked for a cache *plus* a bound that degrades
loudly. Its Closer accepts either outcome — resolve everything, or report a bounded-work skip.
With resolution now one scan per walk, 10,000 edges resolve in well under a second, so the bound
would buy nothing today. It would also add a fifth "tree is a floor" condition that every surface
describing `tree` would have to carry. The remaining cost is a real child's parse, and that is
money being counted, not waste.

## Verification

`tests/wtft-138-resolution-index.test.ts`, with sandboxed session roots and a sandboxed ledger:

- **The Closer, as the issue states it:** a ledger with 10,000 distinct child edges under one
  parent, and `wtft --tokens` on that parent renders the tree naming all 10,000 gaps. Measured
  2026-09-22: the tree walk takes about 40 ms in-process, down from 3.1 s on the same fixture, and
  the whole CLI run, start to exit (process start and the daemon spawn included), takes about
  1 s, against about 11 minutes before. The tests hold both to a loose 5 s so a
  loaded host cannot make them flaky.
- **One walk, not one per child:** the directory-walk counter (`getDirWalkCount`) moves by the
  same amount for a 1-edge tree and a 10,000-edge tree. This, not the clock, is what pins the fix.
- **A `.jsonl` suffix:** a child recorded as `<uuid>.jsonl` resolves as `resolveSessionById` would.
- **Same answers:** a resolvable child still resolves and is priced; with the same id in two
  project directories, the newer copy wins, as before.
- **Seam agreement:** for every id in a fixture tree, `resolveSessionById(id)` equals
  `indexSessionsById().get(id)`, for both built-in harnesses.

## Not in this change

- **A work bound.** Road not taken, above.
- **#97** — reading subagent transcripts by offset in the daemon. P7's other half.

## pr-review round 1 (DeepSeek V4.1 Flash, 2026-09-22)

| Finding | Verdict | Action |
|---|---|---|
| The index lookup skipped the `.jsonl` normalisation `resolveSessionById` applies | Verified — reproduced as R2 | **Code fixed**; ✅ R2 |
| A failed index was marked `null` but only `undefined` was checked | Verified: it worked only by swallowing a TypeError | **Code fixed**: `null` skips the harness |
| The spec restated the Closer over `computeSpawnTree`, not `wtft --tokens` | Verified | ✅ E1, E2 run the CLI |
| The walk-count test used 200 children, not the 10,000 the spec claims | Verified | Now 10,000 |
| A 1 s wall-clock bound is flaky under load | Verified | 5 s bound; the walk count pins the fix |
| The adding-a-harness interface line cites an issue number | Verified | Removed |
| 70,000 vs spec-116's ~40,000 edges at the 8 MiB limit | Verified | Uses spec-116's figure |

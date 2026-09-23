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
newest by mtime when one id has two files — but only a SECOND file for the same id costs a `stat`
at all; the common case, one file per id, records the path on first sight and never stats it.
The resolver strips a trailing `.jsonl` from the id
first, as every `resolveSessionById` does, so a child recorded as `<uuid>.jsonl` still resolves. Both built-ins implement it. Their
`resolveSessionById` stays a single-id scan that stats only the matching files, because a running
daemon calls it to follow a moved session; a test holds the two to the same answer for every id.

**One spelling per session in the ledger.** The writer accepts a session id with or without a
`.jsonl` suffix, and the reader now strips it from `parent` and `child`, so one session recorded
under both spellings is one node in the walk, counted once.

`computeSpawnTree` builds a resolver when its walk first needs one. For each harness, in registry
order: the index when the harness has the method, else that harness's `resolveSessionById`,
asked per id. The first harness that knows an id wins, which is the order `resolveSessionFile`
already uses. Answers are memoised for the walk. **An index that throws, or is not a `Map`,
fails the walk** — the error leaves `computeSpawnTree`, so `wtft --json`/`--tokens` exits 1 with it
(the rule #212 set for the unrecorded scan) and the widget shows no spawn block. A harness with no
index method is asked per id, and a throw there costs only that harness's answer for that id; the
next harness is asked. Each built-in's `indexSessionsById` reads its root directly: ENOENT is an
empty index, and any other failure — permission denied on the root or on a directory above it — is
thrown, so "could not look" never reads as "looked, found nothing". A copy of an id that cannot
be stat-ed (a dangling symlink, a file gone mid-walk) never beats one that can, whichever the walk
meets first.

**Scope of the cache: one walk, built lazily.** Each harness's index is built on first need within
the walk, in registry order: an id no harness knows builds every index, and only a harness after
the one that answers every id is spared. The index is thrown away when `computeSpawnTree` returns, so it can never serve a
stale path to a later report. A child that MOVES after its harness's index was already built is
reported `unreadable`, not silently found: the index still holds the old path, and that path no
longer parses.

**Road not taken — a work bound.** The issue asked for a cache *plus* a bound that degrades
loudly. Its Closer accepts either outcome — resolve everything, or report a bounded-work skip.
With resolution now one scan per walk (about 40–65 ms for 10,000 edges), a bound on resolution
would buy nothing. It would also add a fifth "tree is a floor" condition that every surface
describing `tree` would have to carry. What remains is a resolved child's parse, which is money
being counted, and `--tokens` rendering one row per edge, which is #216.

## Verification

`tests/wtft-138-resolution-index.test.ts`, with sandboxed session roots and a sandboxed ledger:

- **The Closer — met for resolution, not yet end to end.** A ledger with 10,000 distinct child
  edges under one parent: `wtft --tokens` renders the tree naming all 10,000 gaps (E1), and the walk
  itself takes about 40–65 ms in-process, down from 3.1 s on the same 100-transcript fixture (C2);
  at this host's pre-change per-id cost it would have been about 11 minutes. End to end the CLI run
  takes about 1.2–1.4 s against about 0.2–0.3 s over an empty ledger (measured 2026-09-22): most of
  that second is rendering one SPAWNED row per edge. The issue's "renders in under a second" is
  therefore not met end to end; that half is #216. C2 and E2 hold loose 5 s bounds so a loaded host
  cannot make them flaky; the fix itself is pinned by W2's walk count, not by the clock.
- **One walk, not one per child:** the directory-walk counter (`getDirWalkCount`) moves by the
  same amount for a 1-edge tree and a 10,000-edge tree. This, not the clock, is what pins the fix.
  It pins the one-scan property for Claude Code only — Pi's own `collect()` never calls
  `countDirRead()`, so the counter cannot see Pi's walk count at all (`docs/adding-a-harness.md`).
- **A `.jsonl` suffix:** a child recorded as `<uuid>.jsonl` resolves as `resolveSessionById` would,
  and one recorded under both spellings is counted once. The same normalisation applies wherever
  else the walk compares ids: an `alreadyAttributed` id and a `claudeSubAgentFolds` fold id are
  each stripped of a trailing `.jsonl` before being compared against the ledger's (already
  stripped) ids.
- **Same answers:** a resolvable child still resolves and is priced; with the same id in two
  project directories, the newer copy wins, as before. Correct over a tree with no duplicate ids
  too, which is the case the stat-avoidance above changes the most; this bun runtime does not let a
  test spy on `fs.statSync` call counts through `import * as fs`, so that specific case is checked
  for correctness rather than for the number of `stat` calls it made.
- **Seam agreement:** for every id in a fixture tree, `resolveSessionById(id)` equals
  `indexSessionsById().get(id)`, for both built-in harnesses.
- **A loud index failure:** a harness root made unreadable makes `indexSessionsById` throw, and
  the walk fails with that error rather than reporting the affected children `not-found` (Q1, Q2).
- **A dead first copy:** an id whose first-seen copy is a dangling symlink still indexes to its
  live copy, in agreement with `resolveSessionById` (D1, S1).
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

## pr-review round 2

| Finding | Verdict | Action |
|---|---|---|
| One session under both spellings was walked twice and counted twice | Verified — reproduced as R3; the double count predates this change | **Code fixed**: the ledger reader strips `.jsonl`; ✅ R3 |
| `resolveSessionById` now statted every transcript on each single lookup | Verified: the daemon's moved-session follow calls it | **Code fixed**: single lookups scan matches only again; ✅ S1 holds agreement |
| An index that returns a non-Map was rebuilt for every id | Verified | Treated as a failed index for the walk |
| Pre-fix CLI figure mixed the fixture and the host | Verified | Both figures stated, each with its scale |
| Test banner said "under a second" | Verified | Corrected |

## pr-review round 3 (the round limit)

| Finding | Verdict | Action |
|---|---|---|
| adding-a-harness still said the built-ins' single lookup is an index lookup | Verified — round 2 reverted that | Corrected |
| A root passed as `<uuid>.jsonl` matched no edge once the reader stripped the suffix | Verified — a regression from round 2, reproduced as R4 | **Code fixed**: the root id is stripped too; ✅ R4 |
| A harness returning `undefined` from `resolveSessionById` stopped the search as found | Verified | Any non-string is not found |

## Review round 4 (Claude Opus)

| Finding | Verdict | Action |
|---|---|---|
| `indexSessionsById` `stat`s every transcript, not just the ones it needs to compare | Verified | **Code fixed**: a path is recorded on first sight; only a SECOND file for the same id triggers a `stat`. Tested for correctness over a tree with no duplicate ids (I1) — this bun runtime does not let a test spy on `statSync` call counts through `import * as fs` |
| The Closer's 5 s bound does not pin the resolution-vs-parse split the spec claims | Verified | **Test changed**: PART E now diffs a 10,000-edge CLI run against an empty-ledger CLI run (E3), asserting the difference — the tree's added cost — is under 1 s; C2/E2 keep their loose 5 s bounds |
| "treated the way a throwing `resolveSessionById` is today" is not what the code does | Verified | Corrected: a failed or non-`Map` index disables that harness's index for the rest of the walk and warns once; a harness with no index is asked per id, and a throw there costs only that id |
| The "scope of the cache" paragraph's stale-path claim does not match lazy, per-harness building | Verified | Corrected: indexes are built lazily per harness at first need; a child that moves after its harness was indexed is reported `unreadable`, since the index still holds the old path |
| The walk-count test (W2) is stated as if it covered both harnesses | Verified | Corrected: the bullet now says the walk-count property is pinned for Claude Code only — Pi's `collect()` never calls `countDirRead()` |
| The test file's banner comment cites the issue number | Verified | Removed the `#138 — ` prefix |
| An `indexSessionsById` throw was swallowed with no warning, so a broken harness index goes silent for the rest of the walk | Verified | **Code fixed**: `makeSessionResolver` writes one stderr warning per walk, naming the harness and the failure; test Q1/Q2. A root `readdirSync` failure other than `ENOENT` now throws instead of returning an empty index; test Q1 |
| No work bound on the walk | Declined | Road not taken — see "Road not taken — a work bound" above; the issue's Closer accepts either outcome, and a bound would buy nothing at today's per-walk cost |
| `docs/EXT_WTFT.html`'s spec-138 row claims the whole ledger resolves in well under a second | Verified | Corrected: the claim is limited to resolution cost — a ledger of thousands of unresolvable or already-counted edges resolves in well under a second; each resolvable child is still parsed |
| `alreadyAttributed` ids and `claudeSubAgentFolds` fold ids were compared without the `.jsonl` normalisation the ledger and root id already get | Verified | **Code fixed**: both are stripped of a trailing `.jsonl` before being compared; test N1 |

## pr-review round 5 (Claude Opus, the last authorised)

| Finding | Verdict | Action |
|---|---|---|
| A first-seen copy that cannot be stat-ed kept its dead path over a live one (both indexes) | Verified — reproduced as D1 and by S1's agreement check; introduced by round 4's stat-avoidance | **Code fixed**: an un-stat-able copy never wins; ✅ D1, S1 |
| E3's 1 s bound is flaky by the spec's own numbers | Verified | E3 removed; W2 pins the fix |
| The spec declared the Closer met after restating it | Verified | Stated as met for resolution, not end to end; the rendering half filed as #216 |
| An index failure reached only stderr, once per walk, and repeated on every widget refresh | Verified | **Code changed**: an index failure fails the walk (exit 1 in the CLI, no spawn block in the widget); no stderr printing from the library; ✅ Q2 |
| `--json` could not tell a failed index from not-found | Verified | Resolved by the same change: the walk no longer reports not-found for a harness it could not search |
| `existsSync` hid a permission failure above the root | Verified | **Code fixed**: the root is read directly; only ENOENT is empty |
| Docstring said "same as before this change" | Verified | Rewritten without history |
| A per-id throw was said to skip to the next id | Verified: it asks the next harness | Corrected |
| "Never pays for its index" overstated the laziness | Verified | Corrected |

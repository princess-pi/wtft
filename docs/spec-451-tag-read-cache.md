# Spec 451 — Token Budget reuses a tag file's parse while its size and inode are unchanged

Issue: https://github.com/princess-pi/wtft/issues/451.
Status: **Spec Approved** (Duppy, 2026-10-07: "fix it now", on the issue's Expected and Closer).

Module: `extensions/lib/tag-read-cache.ts` · Seam: `createTagReadCache`, tested in `tests/wtft-451-tag-read-cache.test.ts`
Also: `extensions/token-budget.ts` — reads every active tag file through one cache instead of `readClassifiedTagFile`.

## 1. Problem, measured

A per-session daemon keeps writing its heartbeat while idle, so its tag file stays in the roster's
2-minute window while the session is idle. Each uncached Token Budget tick read and parsed every
active tag file in full, and every tick read the hosting session's tag file again for its own TPM.
Duppy's measurement on 2026-10-07 (issue comment): an idle Pi pays roughly 2–5% of one core per
active 2.4 MB tag file, and about 10% with three of them, against the issue's 1% target.

## 2. The cache

`createTagReadCache(io?)` returns a cache of each tag file's classified interactions, keyed by path:

```ts
export interface TagFileStat { ino: number; size: number }
export interface TagReadIo {
  stat(path: string): TagFileStat | null;                               // null: could not stat
  read(path: string): { stat: TagFileStat; content: string } | null;   // null: could not read
}
export interface TagReadCache {
  interactions(path: string): Interaction[];  // classifiedInteractionsFromContent, reused while unchanged
  retain(paths: Iterable<string>): void;      // drops every other path
}
export function createTagReadCache(io?: TagReadIo): TagReadCache;
```

- **Unchanged means same inode and same size.** `interactions` stats the path. When the inode and
  size match the last read, it returns the interactions it parsed then. Otherwise it reads and
  parses again. A heartbeat the daemon rewrites in place changes neither; an append or a truncate
  changes the size; a recreated file has a new inode.
- **A failed stat or read** yields `[]` and leaves no entry.
- **`retain`** drops the entries of tag files no longer active, so the cache holds only the
  active set.
- The default `io` is `node:fs`. The parse is `classifiedInteractionsFromContent`, the same
  collapse every tag reader uses.

## 3. Reader (`extensions/token-budget.ts`)

One cache per process, at module level. `aggregateActiveTpm` and `getHostingSessionTpm` read through it.
`getOrUpdateStats` calls `retain` with the active tag files. The TPM windows, the
stats cache file and the tick are unchanged: the cache keeps parsed interactions, never sums, so
each tick still filters them against its own `now`.

## 4. What does not change

- A tag file that grows is parsed in full again.
- Writes between two reads that leave the inode and the size both unchanged are not seen.

## 5. Verification

- `tests/wtft-451-tag-read-cache.test.ts`, over a fake `io`: an unchanged file is read once
  across calls; a size change, an inode change, and a reappearance after a failed stat each read
  again; a failed read yields `[]`; `retain` drops the other paths. Over real files: after an in-place heartbeat overwrite and
  after an appended turn, the cache returns what a fresh `readClassifiedTagFile` returns.
- The issue's Closer, measured by hand: an idle Pi with `pi/token-budget.js` and one active tag file
  of at least 2 MB uses under 1% of one core over 20 s, and its TPM matches a fresh full read.
  Measured 2026-10-07 with a 3.55 MB tag file kept active by `touch -c`, % of one core over 20 s:
  main 6.10 and 6.85; this branch 0.30, 1.10, 1.05, 0.15 and 0.70; this branch with a one-line tag
  file 0.15, 0.15 and 0.25. An instrumented branch build read the tag file once per run, and the
  widget showed the same TPM on both builds.

## 6. Roads not taken

- **Incremental parse of the appended bytes**, as `--watch` does with its prefix sentinel: also
  cuts the cost while tokens are spent, at the price of re-deriving `_gen` generations and the
  id collapse across the old and new lines. The issue's harm is the idle cost.
- **Caching the sums instead of the interactions:** smaller, but a cached sum goes stale as turns
  age out of the 60 s and 120 s windows, so it would need its own expiry.

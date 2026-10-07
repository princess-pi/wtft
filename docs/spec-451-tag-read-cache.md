# Spec 451 — Token Budget re-parses a tag file only when it changed size or inode

Issue: https://github.com/princess-pi/wtft/issues/451.
Status: **Spec Approved** (Duppy, 2026-10-07: "fix it now", on the issue's Expected and Closer).

Module: `extensions/lib/tag-read-cache.ts` · Seam: `createTagReadCache`, tested in `tests/wtft-451-tag-read-cache.test.ts`
Also: `extensions/token-budget.ts` — reads every active tag file through one cache instead of `readClassifiedTagFile`.

## 1. Problem, measured

A per-session daemon rewrites its heartbeat every poll, so its tag file stays in the roster's
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
  parses again. A heartbeat rewrites its own line in place at the same width, so it changes
  neither; an append changes the size; a replacement by rename changes the inode.
- **The size comes from the bytes read**, and the inode from the open file, so a write landing
  between the stat and the read makes the next stat differ and the next call read again.
- **A path it cannot stat or read** yields `[]` and leaves no entry, as `readClassifiedTagFile` did.
- **`retain`** drops the entries of tag files no longer active, so the cache holds only the
  active set.
- The default `io` is `node:fs`. The parse is `classifiedInteractionsFromContent`, the same
  collapse every tag reader uses.

## 3. Reader (`extensions/token-budget.ts`)

One cache per process, at module level. `aggregateActiveTpm` and `getHostingSessionTpm` read through it.
`getOrUpdateStats` calls `retain` with the active tag files on every tick. The TPM windows, the
stats cache file and the tick are unchanged: the cache keeps parsed interactions, never sums, so
each tick still filters them against its own `now`.

## 4. What does not change

- A tag file that grows is parsed in full again. That happens only while tokens are being spent.
- A daemon rewrite that leaves the inode and the size both unchanged and changes a turn line is
  not seen until the next append. The daemon's only same-size write is the heartbeat.

## 5. Verification

- `tests/wtft-451-tag-read-cache.test.ts`, over a fake `io`: an unchanged file is read once
  across calls; a size change, an inode change, and a reappearance after a failed stat each read
  again; `retain` drops the other paths. Over real files: after an in-place heartbeat overwrite and
  after an appended turn, the cache returns what a fresh `readClassifiedTagFile` returns.
- The issue's Closer, measured by hand: an idle Pi with `pi/token-budget.js` and one active tag file
  of at least 2 MB uses under 1% of one core over 20 s, and its TPM matches a fresh full read.

## 6. Roads not taken

- **Incremental parse of the appended bytes**, as `--watch` does with its prefix sentinel: also
  cuts the cost while tokens are spent, at the price of re-deriving `_gen` generations and the
  id collapse across the old and new lines. The issue's harm is the idle cost.
- **Caching the sums instead of the interactions:** smaller, but a cached sum goes stale as turns
  age out of the 60 s and 120 s windows, so it would need its own expiry.

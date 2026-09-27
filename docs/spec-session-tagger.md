# SessionTagger — one session's tagging, as a state value and a port

The live spec for `extensions/lib/session-tagger.ts`. A behaviour change in this module edits this
file; the per-issue specs behind it are change records (§5). Vocabulary: `CONTEXT.md` (Session,
Tag, Subagent) and the `codebase-design` skill's (module, seam, port, adapter). What a tag line
holds: `docs/wtft-tag-format.md`.

Module: `extensions/lib/session-tagger.ts` · Seam: `stepTagger`, tested in `tests/wtft-270-session-tagger.test.ts`

## 1. Interface

```ts
export interface TaggerState { sessionPath; tagPath; … }   // one session's whole tagging state, a plain object
export interface World { now; stat; readRange; hashPrefix; hashBytes; exists; canonical;
  discoverTask; discoverClaude; attribute; lastCwd; stamp; spawnWindowClosesAt; readTag; projectDirs; projectsRoot }
export function fsWorld(now = Date.now): World;            // the daemon's adapter
export function newTaggerState(sessionPath, tagPath): TaggerState;
export function resumeTagger(state, tagContent, world): { complete; records; log };
export function stepTagger(state, world, { flush, sliceMs? }): { records; cut; wrote; activity; log };
// stepTagger's three parts, exported for the harness timers that run them apart:
export function readSession(state, world): { records; log; activity };
export function flushTurns(state): string;
export function scanChildren(state, world, { sliceMs? }): { records; cut; wrote; log };
```

- **`records`** is the text to append to the tag file, in order, whole lines. The module never
  writes a file; the caller appends `records` after every call, a cut one and the resume included.
- **`World`** is the one place the tagging code touches the filesystem or the clock, path
  canonicalisation included. `fsWorld()` is the daemon's adapter; a test uses `fsWorld(clock)`
  over a sandbox corpus with a clock it advances.
- **`log`** stands in for stderr: `{ level: "warn" | "debug", text }`. The daemon prints warnings
  always and debug lines under `WTFT_DAEMON_DEBUG`. Warn-once latches live in the state, so a
  session dropped and adopted again warns again.
- **`cut`** means the child scan's pass is not finished (the slice ran out, or a transcript grew
  after the pass took it); the caller appends `records` and calls again.
- **`flush`** says whether pending turns may be written this step. The caller owns the write
  cadence; the daemon calls the parts: `readSession`, then `flushTurns` when its cadence allows
  and always at shutdown, then `scanChildren`.
- **`wrote`**: a turn, fold or generation record was produced. **`activity`**: the session
  transcript gained a turn.

What stays with the caller: the lease, the tag file's byte-level writer, the truncate-or-resume
decision at startup and the offset it seeds into `state.lastSize`, the stop line, the idle clock
and heartbeats, session existence and moves (`state.sessionPath` is re-pointed; `state.tagPath` is
fixed for the session's life), the harness registry (`docs/spec-harness-registry.md`) and slicing
timers.

## 2. Behaviour

- **One `now` per part.** The session read and the child scan each read `world.now()` once and
  use it for every settle check, window check and sweep stamp in that part. The slice deadline is
  the exception: it is read live, since it measures the scan's own duration.
- **Scan bookkeeping travels with the state.** The pass's read-set and failure flag
  (`scanPass`, `scanPassFailed`) and the warned-once sets are fields of `TaggerState`, so a
  session move carries them.
- **A sliced pass reads a transcript again when it grew after the pass took it.** When a continued
  pass reaches its end, every transcript an earlier slice read is stat'd once; one whose size,
  mtime or inode moved is due again and the pass stays open. Swept is stamped only after that
  read. A stat that fails for any reason but the file or its directory being gone counts as a
  failed poll. A transcript whose read failed in the slice is not taken for grown.
- **A child transcript keeps one source for the life of its state.** The source is decided at the
  child's first read and carried across a move of the session and the child's own rotations, so a
  later generation retires its earlier lines. A child retired as folded elsewhere, or released as
  gone, loses its state but not its source. On resume, a `_gen` record's source is matched against
  the path relative to the session's directory or to the child's own, and seeds the child's state.
- **The session's own transcript opens a generation too.** When it is replaced (a new inode) or
  shrinks, `readSession` drops the turns it had not written, settles every `claude -p` lookup
  they opened, returns a `_gen` record with source `""` (`OWN_SOURCE`) and an offset marker of 0,
  and reads the transcript from its start. The step reports `wrote`, and the next clean pass
  stamps swept; readers then count only what
  follows that record (`docs/wtft-tag-format.md` §2e). A resume never treats `""` as a child.
- **A registered `claude -p` child that is gone from disk is gone, not a failed read.** Gone means
  a missing file or directory; any other stat error is a failed poll, warned once, which withholds
  the sweep. The scan skips a gone child, writes the turn it held under the source its earlier
  lines carry (unless a transcript with that source was read again in the same scan), and the tag
  can be stamped swept.
- **The swept-marker retraction reads the session's fixed tag path**, not one derived from the
  session's current path.

## 3. Tests

- `tests/wtft-270-session-tagger.test.ts`, no daemon process:
  - **G** every corpus session, stepped until quiet, gives the golden tag's data lines;
  - **P** `flush: false` holds turns; `flush: true` writes them and one offset marker;
  - **C** a zero slice cuts after one transcript; a transcript that grows after the pass took it
    is read again within that pass;
  - **M** a moved session's same-directory `claude -p` child keeps its source;
  - **R** restart, fold, gone-child and lookup-merge sequences;
  - **W** an unreadable transcript warns once and clears when the read succeeds.
- `tests/wtft-270-golden-tags.test.ts` runs the real daemon over the same corpus.

## 4. Related

`docs/wtft-tag-format.md` (what the records say), `docs/spec-harness-registry.md` (the harness
holds one `TaggerState` per served session).

## 5. Change records

These describe how the module got here, and each says so in its header. Where one disagrees with
this file, this file is current.

- `docs/spec-270-session-tagger.md` — slice S3 moved one session's tagging out of the daemon.

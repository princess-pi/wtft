# Spec 270 S4 — HarnessRegistry

Issue: https://github.com/princess-pi/wtft/issues/270, slice S4 of
`docs/spec-270-daemon-ownership.md` §3b. The parent spec's rows for S4 are the commitment; this
document is the design and the closer. Vocabulary: the `codebase-design` skill's (module,
interface, seam, adapter, port) and `CONTEXT.md`; "harness" below is the daemon's harness
process (`CONTEXT.md` Daemon), not the Harness entry's coding-agent runtime.

## 1. What moves, and what the seam is

On `main` @ `7b4b9c9` a harness keeps what it knows about each session in nine module-level
collections keyed by session path — `harnessSlots`, `harnessFlushTimers`,
`subagentScansContinuing`, `adoptionRetries`, `adoptionRetryPending`, `idleDropped`,
`idleDroppedSize`, `idleDroppedAt`, `unwatchedTreeScanAt` — plus the `Slot` each holds. A
session move re-keys some of them by hand in `wake` (the slot, the scan-continuation marker,
the flush timer) and in `followMovedSession` (the marker again); `dropHarnessSlot` deletes from
five. `handOffLines` reads five of them to write the hand-off. Each collection is one more
place a move or a drop can miss; #267 F (the scan-continuation marker re-keyed on a move) is
the check nobody could write because the marker lived in a set the daemon re-keyed in prose.

**HarnessRegistry** (`extensions/lib/harness-registry.ts`) is those collections behind one
seam: one record per session, and functions over a plain registry value.

```ts
export interface SessionRecord {       // the daemon's Slot, plus the per-session side maps
  state: TaggerState; pidPath; rebuildTagOnStartup; lastWriteMs; lastActivityMs; startupTime;
  idleStartMs; sessionExisted; displayed; checkedAtMs;
  scanContinuing: boolean;             // was subagentScansContinuing
  flushTimer: FlushTimer | null;       // was harnessFlushTimers; the daemon creates and clears it
  unwatchedTreeScanAt: number;         // was unwatchedTreeScanAt
}
export interface IdleRecord { displayed; since; sig }            // was idleDropped + Size + At
export interface RetryRecord { tries; displayed; pending }       // was adoptionRetries + Pending
export interface Registry { served: Map<string, SessionRecord>; idle: Map<string, IdleRecord>; retrying: Map<string, RetryRecord> }
export const MAX_ADOPTION_TRIES = 5;

export function newRegistry(): Registry;
export function newSessionRecord(sessionPath, displayed, now): SessionRecord;
export function serve(reg, key, record): void;                   // forgets the key's idle record and retry
export function get(reg, key): SessionRecord | undefined;
export function move(reg, from, to): { record; flushTimer } | null;
export function drop(reg, key): { record | null; flushTimer | null };
export function markIdle(reg, key, displayed, sig, since): void; // keeps an earlier since
export function forgetIdle(reg, key): void;
export function expiredIdle(reg, now, idleMs): string[];
export function beginRetry(reg, key, displayed): { kind: "retry"; tries } | { kind: "pending" } | { kind: "gave-up" };
export function retryFired(reg, key): RetryRecord | null;
export function cancelRetry(reg, key): void;
export function retryPending(reg, key): boolean;
export function isEmpty(reg): boolean;                           // nothing served, idle-known or pending
export function servedOver(reg, dir): string | null;
export function needsDir(reg, dir): boolean;
export function projectInUse(reg, project, except?): boolean;
export function sessionDirOf(file): string;
export function handOff(reg, keep: (record) => boolean, adopting?: { key; displayed }): string[];
export function parseHandOff(text, root): { records: HandOffRecord[]; unreadable: number };
```

- **`move` re-keys one entry.** The record, its scan-continuation flag (#267 F) and its
  unwatched-tree stamp travel together because they are fields of the record; the flush timer
  is taken off the record and handed back for the caller to clear, since a timer is the
  daemon's. `to` must be free: a record already
  there is the daemon's to drop first, as `wake` does, and `move` returns null rather than
  displacing it.
- **`drop` returns what the daemon must close**: the record (for the flush, the stop line and
  the lease release, which are fs work) and the flush timer. It also cancels a retry for that
  key. The idle record is separate on purpose: a session dropped for idling stays idle-known
  until it is served again or the daemon forgets it (`forgetIdle`), which the sweep does for
  the keys `expiredIdle` lists and for one whose transcript is gone.
- **A retry's pending mark outlives its cancel.** `cancelRetry` on a pending retry zeroes the
  count and leaves the mark, so the daemon's timer, which cannot be recalled from here, fires
  into `retryFired` returning null; the next `beginRetry` then counts from 1 again. That is the
  daemon's earlier two-collection behaviour, kept: one retry pending per session at a time,
  and a pending retry keeps the harness alive.
- **`handOff` is the hand-off's whole text**, given the one thing the registry cannot know: which
  served records still hold their lease (`keep`). `parseHandOff` is its read: a line that is not
  a JSON object (not JSON, or a null, number, string or array) counts as unreadable; a record
  whose path is missing, relative, or does not resolve to a path under `root`, or whose kind is
  unknown, is skipped; a kept path is returned resolved. What the daemon does with each record (wake it, or mark it idle after an fs
  check) stays in `takeServedHandOff`.
- **No `fs`, no timers, no clock inside.** The registry stores the timer handle the daemon made
  and hands it back; the clock is a `now` argument. The test is a plain registry value; its
  timers are real ones it clears itself.

What stays in the daemon: the current-slot pointer and `withSlot`, the lease work
(`adoptSession`, `takeOverLease`, `releaseLease`, `leaseStillOurs`), the tag writes on drop and
stop, `wake`'s control flow, `sweepIdleSlots`, the directory watchers (`harnessWatchers`,
`unwatchedDirs`: keyed by directory and shared across sessions, so not a session record's
field; §4), the hand-off file I/O (`persistHandOff`, `writeServedHandOff`,
`takeServedHandOff`), the focus requests, `runHarness` and `stopHarness`.

## 2. Behaviour preserved

The process-level suites (`tests/wtft-205-*`, `wtft-239-harness-lifecycle`,
`wtft-259-daemon-correctness`, `wtft-262-daemon-gaps`) pass unchanged; they are the closer
that the daemon still behaves. Nothing about when a session is adopted, dropped, retried,
handed on or forgotten changes; only where the daemon keeps that. Two hardenings came with the move (§4):
the hand-off read, as `parseHandOff` took it over, and `--restart`'s harness loop waiting only
for a live daemon; the reconcile also reworded `--restart`'s stdout lines and `--help` text,
which said restarts that did not happen. A scan cut in the poll that detects a move continues
under the new key: the continuation holds the record, not a lookup by path.

## 3. Closer

- `tests/wtft-270-harness-registry.test.ts`, in memory, no daemon process:
  - **S** serve → get; `isEmpty` false; `servedOver`, `needsDir` and `projectInUse` answer for
    the session's own tree and its project directory;
  - **M** move: the record is under `to` and not `from`; `scanContinuing` set before the move
    reads true after it (#267 F); the unwatched-tree stamp travels; the flush timer is returned
    and gone from the record; an unknown `from`, or a `to` held by another record, returns null
    and moves nothing; `from === to` is a no-op returning the record;
  - **I** idle: `markIdle` keeps the first `since` and refreshes `sig`; an idle-known key keeps
    `needsDir` and `projectInUse` true for its project directory; `expiredIdle` lists only
    keys idle for at least `idleMs` and removes none; `forgetIdle`; `serve` forgets the idle record;
  - **R** retries: `beginRetry` counts 1, 2, … up to `MAX_ADOPTION_TRIES`, then `gave-up` and
    the retry is forgotten; a second begin while pending is `pending`; `retryFired` clears the
    mark and hands the retry back; `cancelRetry` while pending leaves the mark and the fire
    returns null; `isEmpty` is false while a retry is pending; `serve` cancels the retry;
  - **D** drop: the record and its timer come back, the idle record stays, a retry for the key is
    cancelled, `get` is undefined; dropping an unknown key returns nulls;
  - **H** hand-off round trip: served (only records `keep` accepts, then `adopting` unless
    already served), retrying and idle lines in the documented shapes; `parseHandOff` counts an
    unparsable line and a JSON `null`, skips a relative path and one that resolves outside the
    root through `..`; the parsed records served into a fresh registry hand off the same text.
- `bin/wtft-daemon.ts` no longer defines `harnessSlots`, `harnessFlushTimers`,
  `subagentScansContinuing`, `adoptionRetries`, `adoptionRetryPending`, `idleDropped`,
  `idleDroppedSize`, `idleDroppedAt`, `unwatchedTreeScanAt`, `handOffLines`, `dirStillNeeded`,
  `servedSessionOver` or `freshSlot`.
- `docs/spec-259-daemon-correctness.md` § Closer: #267 F moves from "without a check yet" to
  checked (in memory).
- The full suite is green except the four #214 suites; the shell suite passes.

## 4. Roads not taken, and decisions made while building

- **Folding the directory watchers into the record.** `harnessWatchers` and `unwatchedDirs`
  are keyed by directory and one directory serves several sessions (a project directory
  holding two served transcripts), so a per-session field would either duplicate a watcher or
  close it under the other session. They stay a directory-keyed concern in the daemon; a
  `DirWatcher` module is a later slice if one is ever needed.
- **A `tick(now)` that runs the sweep**, as the parent spec's plan row had it. The sweep is
  mostly filesystem and lease work (stat each transcript, read `.display`, check the lease,
  retry watches); what is pure is the idle expiry, which is `expiredIdle`. Pulling the rest in
  would mean a port the size of S3's for little leverage.
- **`snapshot()` became `handOff` plus `parseHandOff`.** The plan row named one function; the
  read side was a pure parse sitting inside `takeServedHandOff`, and moving it made the
  round-trip check (H) possible with no file.
- **`move` displacing the record at `to` itself.** It would have to hand the displaced record
  back for the daemon to flush and release, after the key it was under now names another
  record; `dropHarnessSlot(key)` looks records up by key. Keeping the daemon's order (drop the
  other first, then move) and having `move` refuse an occupied `to` keeps one drop path.
- **One combined retry record instead of `tries` plus a `pending` set.** Kept as one record
  with a `pending` field whose lifetime differs from the count (§1). A record deleted on cancel
  would let a second timer start while the first is pending, which is one wake more than the
  daemon made before and a harness kept alive by a mark it no longer had.
- **A class.** The repo's modules are functions over a plain state value (`TaggerState`,
  `Registry`); the same shape keeps the test a literal value.
- **The hand-off read is hardened, not moved as it was.** On `main`, `takeServedHandOff`
  parsed each line inline: a JSON `null` line threw a TypeError and the harness start exited 1;
  a number line was skipped silently; a path escaping the root through `..` matched the prefix
  check and was woken under a key outside the root. `parseHandOff` counts every non-object line
  as unreadable and resolves a path before the root check. A move-as-it-was would have carried
  a crash into the module for a later slice to fix.
- **`--restart`'s harness loop waits only for a live daemon.** The reconcile's final pass found
  that the loop called `waitUntilExited` for any pid its root pid file named, which SIGKILLs a
  live pid after two seconds, daemon or not. Guarded on `procIsDaemon` here, as the lease loop
  already was; the check, and two more `--restart` findings, are #274, after the freeze.
- **The current-slot pointer.** `slot` and `withSlot` are the daemon's way of running the
  per-session functions against one record; the registry does not know which record is
  current, and does not need to.

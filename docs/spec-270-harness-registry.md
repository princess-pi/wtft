# Spec 270 S4 — HarnessRegistry

Issue: https://github.com/princess-pi/wtft/issues/270, slice S4 of
`docs/spec-270-daemon-ownership.md` §3b. The parent spec's rows for S4 are the commitment; this
document is the design and the closer. Vocabulary: the `codebase-design` skill's (module,
interface, seam, adapter, port) and `CONTEXT.md`.

## 1. What moves, and what the seam is

On `main` @ `7b4b9c9` a harness keeps what it knows about each session in nine module-level
collections keyed by session path — `harnessSlots`, `harnessFlushTimers`,
`subagentScansContinuing`, `adoptionRetries`, `adoptionRetryPending`, `idleDropped`,
`idleDroppedSize`, `idleDroppedAt`, `unwatchedTreeScanAt` — plus the `Slot` each holds. A
session move re-keys some of them by hand in `wake` (the slot, the scan-continuation marker,
the flush timer) and `dropHarnessSlot` deletes from five. `handOffLines` reads four of them to
write the hand-off. Each collection is one more place a move or a drop can miss; #267 F (the
scan-continuation marker re-keyed on a move) is the check nobody could write because the
marker lived in a set the daemon re-keyed in prose.

**HarnessRegistry** (`extensions/lib/harness-registry.ts`) is those collections behind one
seam: one record per session, and functions over a plain registry value.

```ts
export interface SessionRecord {       // was the daemon's Slot, plus the per-session side maps
  state: TaggerState; pidPath; rebuildTagOnStartup; lastWriteMs; lastActivityMs; startupTime;
  idleStartMs; sessionExisted; displayed; checkedAtMs;
  scanContinuing: boolean;             // was subagentScansContinuing
  flushTimer: Handle | null;           // was harnessFlushTimers; the daemon creates and clears it
  unwatchedTreeScanAt: number;         // was unwatchedTreeScanAt
}
export interface IdleRecord { displayed; since; sig }            // was idleDropped + Size + At
export interface RetryRecord { tries; displayed; pending }       // was adoptionRetries + Pending
export interface Registry { served: Map<string, SessionRecord>; idle: Map<string, IdleRecord>; retrying: Map<string, RetryRecord> }

export function newRegistry(): Registry;
export function newSessionRecord(sessionPath, displayed, now): SessionRecord;
export function serve(reg, key, record): void;
export function move(reg, from, to): { record: SessionRecord; displaced: SessionRecord | null; flushTimer: Handle | null };
export function drop(reg, key): { record: SessionRecord | null; flushTimer: Handle | null };
export function markIdle(reg, key, displayed, since, sig): void;
export function forgetIdle(reg, key): void;
export function expiredIdle(reg, now, idleMs): string[];
export function beginRetry(reg, key, displayed): number;         // the try count, 1-based
export function retryFired(reg, key): RetryRecord | null;
export function cancelRetry(reg, key): void;
export function isEmpty(reg): boolean;
export function servedOver(reg, dir): string | null;
export function needsDir(reg, dir): boolean;
export function handOff(reg, keep: (record) => boolean, adopting?: { key; displayed }): string[];
```

- **`move` re-keys one entry.** The record, its scan-continuation flag (#267 F), its flush timer
  (returned to the caller to clear, since a timer is the daemon's) and its unwatched-tree stamp
  travel together because they are fields of the record. A record already at `to` is returned
  as `displaced` for the caller to drop, as `wake` does today.
- **`drop` returns what the daemon must close**: the record (for the flush, the stop line and
  the lease release, which are fs work) and the flush timer. It also forgets a retry for that
  key. The idle record is separate on purpose: a session dropped for idling stays idle-known
  until it is served again or `expiredIdle` ages it out.
- **`handOff` is the hand-off's whole text**, given the one thing the registry cannot know: which
  served records still hold their lease (`keep`). The daemon's `handOffLines` becomes a call.
- **No `fs`, no timers, no clock inside.** The registry stores the timer handle the daemon made
  and hands it back; the clock is a `now` argument. The test adapter is a plain object and a
  fake handle.

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
handed on or forgotten changes; only where the daemon keeps that.

## 3. Closer

- `tests/wtft-270-harness-registry.test.ts`, in memory, no daemon process:
  - **S** serve → get; `isEmpty` false; `servedOver` and `needsDir` answer for the session's
    own tree and its project directory;
  - **M** move: the record is under `to` and not `from`; `scanContinuing` set before the move
    reads true after it (#267 F); the flush timer is returned and gone from the record; a record
    already at `to` comes back as `displaced`;
  - **D** drop: the record and its timer come back, a retry for the key is forgotten, `get` is
    undefined; dropping an unknown key returns nulls;
  - **I** idle: `markIdle` then `forgetIdle`; `expiredIdle` returns only keys older than
    `idleMs`; an idle-known key keeps `needsDir` true for its project directory;
  - **R** retries: `beginRetry` counts 1, 2, 3…; `retryFired` clears `pending` and returns the
    record; `cancelRetry` forgets it; `isEmpty` is false while a retry is pending;
  - **H** hand-off round trip: served (only records `keep` accepts, plus `adopting`), retrying
    and idle lines in the documented shapes; parsing the lines and serving them into a fresh
    registry gives back the same `handOff` text.
- `bin/wtft-daemon.ts` no longer defines `harnessSlots`, `harnessFlushTimers`,
  `subagentScansContinuing`, `adoptionRetries`, `adoptionRetryPending`, `idleDropped`,
  `idleDroppedSize`, `idleDroppedAt`, `unwatchedTreeScanAt` or `handOffLines`.
- `docs/spec-259-daemon-correctness.md` § Closer: #267 F moves from "without a check yet" to
  checked (in memory).
- The full suite is green except the four #214 suites; the shell suite passes.

## 4. Roads not taken, and decisions made while building

- **Folding the directory watchers into the record.** `harnessWatchers` and `unwatchedDirs`
  are keyed by directory and one directory serves several sessions (a project directory
  holding two served transcripts), so a per-session field would either duplicate a watcher or
  close it under the other session. They stay a directory-keyed concern in the daemon; a
  `DirWatcher` module is a later slice if one is ever needed.
- **A `tick(now)` that runs the sweep.** The sweep is mostly filesystem and lease work (stat
  each transcript, read `.display`, check the lease, retry watches); what is pure is the idle
  expiry, which is `expiredIdle`. Pulling the rest in would mean a port the size of S3's for
  little leverage.
- **A class.** The repo's modules are functions over a plain state value (`TaggerState`,
  `Registry`); the same shape keeps the test adapter a literal object.

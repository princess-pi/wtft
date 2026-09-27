# HarnessRegistry — what a harness knows about each session

The live spec for `extensions/lib/harness-registry.ts`. A behaviour change in this module edits
this file; the per-issue specs behind it are change records (§5). Vocabulary: `CONTEXT.md`
(Daemon, Session); "harness" is the daemon's harness daemon, not a coding-agent runtime.

Module: `extensions/lib/harness-registry.ts` · Seam: `move`, tested in `tests/wtft-270-harness-registry.test.ts`

One record per session a harness serves, has dropped for idling, or is retrying to adopt, and
functions over a plain registry value. No filesystem, no timers, no clock inside: the registry
stores the timer handle the daemon made and hands it back, and the clock is a `now` argument.

## 1. Interface

```ts
export interface SessionRecord {
  state: TaggerState; pidPath; rebuildTagOnStartup; lastWriteMs; lastActivityMs; startupTime;
  idleStartMs; sessionExisted; displayed; checkedAtMs;
  scanContinuing: boolean;             // a subagent scan continues on the next event-loop turn
  flushTimer: FlushTimer | null;       // the daemon creates and clears it
  unwatchedTreeScanAt: number;         // last read of a tree a directory watch cannot cover
}
export interface IdleRecord { displayed; since; sig }
export interface RetryRecord { tries; displayed; pending }
export interface Registry { served: Map<string, SessionRecord>; idle: Map<string, IdleRecord>; retrying: Map<string, RetryRecord> }
export const MAX_ADOPTION_TRIES = 5;

export function newRegistry(): Registry;
export function newSessionRecord(sessionPath, displayed, now): SessionRecord;
export function serve(reg, key, record): void;
export function get(reg, key): SessionRecord | undefined;
export function move(reg, from, to): { record; flushTimer } | null;
export function drop(reg, key): { record | null; flushTimer | null };
export function markIdle(reg, key, displayed, sig, since): void;
export function forgetIdle(reg, key): void;
export function expiredIdle(reg, now, idleMs): string[];
export function beginRetry(reg, key, displayed): { kind: "retry"; tries } | { kind: "pending" } | { kind: "gave-up" };
export function retryFired(reg, key): RetryRecord | null;
export function cancelRetry(reg, key): void;
export function retryPending(reg, key): boolean;
export function isEmpty(reg): boolean;
export function servedOver(reg, dir): string | null;
export function needsDir(reg, dir): boolean;
export function projectInUse(reg, project, except?): boolean;
export function sessionDirOf(file): string;
export function handOff(reg, keep: (record) => boolean, adopting?: { key; displayed }): string[];
export function parseHandOff(text, root): { records: HandOffRecord[]; unreadable: number };
```

The `TaggerState` inside a record is `docs/spec-session-tagger.md`'s.

## 2. Behaviour

- **`serve`** stores the record and forgets the key's idle record and any retry.
- **`move` re-keys one entry.** The record, its scan-continuation flag and its unwatched-tree stamp
  travel together because they are fields of the record. The flush timer is taken off the record
  and handed back for the caller to clear. `to` must be free: `move` returns null rather than
  displace a record there, and moves nothing for an unknown `from`. `from === to` returns the
  record and changes nothing.
- **`drop` returns what the daemon must close**: the record (for the flush, the stop line and the
  lease release) and the flush timer. It also cancels a retry for that key. The idle record is
  separate: a session dropped for idling stays idle-known until it is served again or the daemon
  forgets it (`forgetIdle`).
- **Idle.** `markIdle` keeps the first `since` for a key and refreshes `sig` (size, inode and mtime
  when dropped). `expiredIdle` lists keys idle for at least `idleMs` and removes none. An
  idle-known key keeps `needsDir` and `projectInUse` true for its project directory.
- **Retries.** `beginRetry` counts 1, 2, … up to `MAX_ADOPTION_TRIES`, then answers `gave-up` and
  forgets the retry; while one is pending it answers `pending`. `retryFired` clears the pending mark
  and hands the retry back. **A pending mark outlives its cancel:** `cancelRetry` on a pending retry
  zeroes the count and leaves the mark, so the daemon's timer fires into `retryFired` returning null,
  and the next `beginRetry` counts from 1. One retry is pending per session at a time.
- **`isEmpty`** is true when nothing is served, nothing is idle-known and no retry is pending: the
  harness may stop.
- **`handOff` is the hand-off's whole text**, one JSON line per session: the served records the
  caller's `keep` accepts (the daemon's: those still holding their lease, or holding a `rebuild`
  token, which wants the session adopted again), then `adopting` unless it is already served, then sessions
  being retried (as served), then idle-known ones with `since` and `sig`. `parseHandOff` reads it back: a line that
  is not a JSON object counts as unreadable; a record whose path is missing, relative, or does not
  resolve under `root`, or whose kind is unknown, is skipped; a kept path is returned resolved.

What stays in the daemon: the current-record pointer, the lease work, the tag writes on drop and
stop, the idle sweep's filesystem checks, the directory watchers (keyed by directory and shared
across sessions), the hand-off file I/O, and starting and stopping the harness.

## 3. Tests

`tests/wtft-270-harness-registry.test.ts`, in memory, no daemon process: **S** serve, **M** move,
**I** idle, **R** retries, **D** drop and **H** the hand-off round trip, each as §2 states it. The
process-level suites (`tests/wtft-205-*`, `wtft-239-harness-lifecycle`,
`wtft-259-daemon-correctness`, `wtft-262-daemon-gaps`) check the daemon around it.

## 4. Related

`docs/spec-session-tagger.md` (the state each record holds), `docs/spec-holder.md` (which lease
holders the daemon acts on).

## 5. Change records

These describe how the module got here, and each says so in its header. Where one disagrees with
this file, this file is current.

- `docs/spec-270-harness-registry.md` — slice S4 put nine daemon collections behind one record per session.

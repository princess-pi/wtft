# Spec 270 — daemon ownership map and deep-module refactor

Issue: https://github.com/princess-pi/wtft/issues/270. Measured on `main` @ `0082dee`, 2026-09-25.

Part 1 is the map: every persistent record the daemon, CLI and widgets share, with its writer,
its readers and the moment each acts. Part 2 lists where a reader re-derives a fact a writer
already held. Part 3 is the refactor: which modules, what each one's interface is, and the
test that proves each slice.

Vocabulary is the `codebase-design` skill's: module, interface, seam, adapter, depth.

---

## 1. Ownership map

### 1a. Tag file `<sessionDir>/wtft-tags/<base>.wtft-tag.v<V>.jsonl`

Format contract: `docs/wtft-tag-format.md`. Twelve record kinds share one file. "Moment" is
when the write happens; "reader" names every consumer and what it takes from the record.

| # | Record | Writer (function) | Moment | Readers → what they take |
|---|---|---|---|---|
| T1 | interaction line, no `s` | `flushPending` via `serializeClassifiedWithOverheadSplit` | ≥ 667 ms after the first pending turn | CLI `readTagFileWithVerdict`; widget same; `token-budget` `readClassifiedTagFile`; `--watch` `seedClassifiedTagFile` / `watchTagFile`; `checkDaemonHealth` → `m`, `ttl`, `t`; daemon `initClassified` → "has data"; `reapAndWarn` → `cat` present; `sessionWasEverParsed` → `cat` present |
| T2 | interaction line with `s` | `syncSubagentTranscript` | each child-transcript read that produced turns | as T1, filtered by `currentGenerationRecords` |
| T3 | `#oh` overhead line | `flushPending` | with T1, on a recache or compaction | as T1; never id-collapsed with its bare line |
| T4 | `_hb {first,last}` | `upsertHeartbeat`, `initClassified` | every poll with nothing pending (per-session, or a harness slot that is displayed) | `checkDaemonHealth` → idle since / last beat; `reapAndWarn` → heartbeat ratio, zombie age; `tagProvisionalFromContent` → skipped; `initClassified` → excluded from "has data" |
| T5 | `_hb "stop", reason` | `shutdown`, `dropHarnessSlot`, `stopHarness` | exit or drop | `reapAndWarn` → excluded from the ratio; `--watch` reads nothing from it |
| T6 | `_meta.offset` | `flushPending` | after every T1 batch | daemon `readLastMetaOffset` only |
| T7 | `_meta.swept` | `scanForSubAgents` | a scan with no failure, no held-back turn, and a tag that grew since the last marker | `tagProvisionalFromContent` (CLI, widget) → settled; daemon `invalidateStaleSweptMarker` |
| T8 | `_meta.unswept` | `invalidateStaleSweptMarker` | a session read failed after a swept marker; startup resume | `tagProvisionalFromContent` → `unswept` |
| T9 | `_meta.spawnPending {key,at,commands}` | `queueClaudeCommand` | a turn with a `claude -p` command is read | daemon `resumeClaudeLookups` only |
| T10 | `_meta.spawnSettled key, children[]` | `scanForSubAgents` | the lookup for a turn ends | daemon `resumeClaudeLookups` only |
| T11 | `_fold {parent,child,s}` | `syncSubagentTranscript` | a child parse folded a session this generation had not recorded | CLI and widget `foldedIdsFromRecords` → `computeSpawnTree.alreadyAttributed`; daemon `reseedClaudeChildren` |
| T12 | `_gen {s,session}` | `syncSubagentTranscript`, `skipAsFoldedElsewhere`, the pending-turn release in `scanForSubAgents` | first read of a child in a daemon life; rotation; a child another transcript now folds | `currentGenerationRecords` (CLI, widget, `--watch` reseed); daemon `resumeClaudeLookups` → sources already read; `reseedClaudeChildren` |

Whole-file properties that are also read as state:

| Property | Writer | Readers → what they take |
|---|---|---|
| size, mtime | every append | `getDaemonStatus` → 2 s grace after a lost lease; `watchTagFile` → 2 s grace; `token-budget` → active if mtime < 2 min; `wtft-daemon --list` → idle age |
| truncate to 0 | `initClassified` on rebuild, on a partial tail, on a tag with no offset marker | `watchTagFile` → reseed when size < offset |
| heartbeat overwritten in place | `upsertHeartbeat` | `watchTagFile` → prefix sentinel unchanged |
| file name version | `getCurrentVersionTagPath` | `tagProvisionalFromContent` → `stale-version`; `waitingForDataLine` |

### 1b. Session lease `$TMPDIR/wtft-daemon-<hash>.pid`

Value is a pid or the token `rebuild`. Hash is of the transcript basename when it is a session
id, else of the path.

| Writer | Moment | Effect |
|---|---|---|
| per-session `main` (`tryClaimLease`, hard link) | start | claims |
| `replaceLease` | version takeover at start; `fatalTagMutation` writes `rebuild` | replaces |
| `claimPidFile` | harness `adoptSession`; `runHarness` for the root file | claims, unlinks a dead holder |
| `takeOverLease` | harness adoption against a live per-session daemon | SIGTERMs the holder, then claims |
| `pointSessionAt` | a CLI-spawned daemon that found a live harness | writes the harness pid, plus a `.display` sidecar, plus a focus request |
| `forceRebuildSession` (CLI `-F`) | user | writes `rebuild` for a harness; unlinks for a per-session daemon |
| `wtft-daemon --stop`, `--restart`, `reapAndWarn`, `releaseLease`, `shutdown`, `retryAdoptionLater` | each its own | unlink, each with its own re-prove-then-unlink |

Readers: `checkDaemonHealth` (pid alive → daemon alive), `serviceSession` (holder is me, every
poll), `leaseStillOurs`, `wake` (`rebuild` → adopt afresh), `awaitDaemonUp`, `handOffLines`,
`retryAdoptionLater`, `forceRebuildSession`.

Eight functions implement "read the lease, re-prove the inode, unlink": `unlinkIfHolds`,
`unlinkIfStill`, `unlinkIfNames`, `releaseLease`, `claimPidFile`, `takeOverLease`, `tryClaimLease`,
and `forceRebuildSession`'s inline copy.

### 1c. Harness root files `$TMPDIR/wtft-harness-<which>-<hash>.pid` and sidecars

| File | Writer | Moment | Reader → what it takes |
|---|---|---|---|
| `.pid` | `runHarness` (`claimPidFile`); `stopHarness`, `--restart` unlink | start / stop | `sweepIdleSlots` every 250 ms → holder is me, else stop; `holdsHarnessRoot`; `pointSessionAt`; a later `runHarness` → live pid |
| `.<pid>.version` | `runHarness` | before the claim | a later `runHarness` → `taggerIsOlder` decides replace or hand over |
| `.focus.d/<pid>.request` | `pointSessionAt` (a second daemon process) | a CLI report or `--watch` on a session the harness does not serve | `claimFocusRequests` (rename-claim) on `fs.watch` and every sweep |
| `.served` | `writeServedHandOff` at stop; `persistHandOff` every sweep when the text differs | continuous | `takeServedHandOff` (rename-claim) at the next start |

### 1d. Spawn ledger `$XDG_STATE_HOME/wtft/spawns.jsonl`

Writer: `wtft spawn-record`, called by launchers. Readers: `computeSpawnTree` (CLI report,
widget), `listUnrecordedSpawns` (exclusion set). Format: `docs/spec-116-spawn-ledger.md`.

### 1e. `~/.local/state/wtft/reap.log`

Writer: `reapAndWarn`, at every per-session daemon start. Reader: CLI `showReapWarnings`.

### 1f. Transcripts (harness-owned, read-only here)

Session `.jsonl`, `<id>/subagents/agent-*.jsonl` and `.meta.json`, Pi sibling files, and
`claude -p` children under the projects root. Read by the daemon (`parseNewLines`,
`syncSubagentTranscript`, discovery), by the CLI (`scanSessionUncounted`,
`collectSubagentJson`, `computeSpawnTree` → `parseDescendant`), and by the widget
(`readInteractions` → `loadSubagentInteractionsChecked`).

### 1g. Daemon in-process state

`bin/wtft-daemon.ts` holds 38 module-level `let` bindings and 17 module-level `Map`/`Set`
collections. In harness mode, `install(slot)` / `save(slot)` copy 25 of the `let` bindings into
and out of a `Slot` around every call. The 17 collections are keyed by session path and are not
in the `Slot`: `harnessSlots`, `harnessWatchers`, `harnessFlushTimers`,
`subagentScansContinuing`, `subagentScanPass`, `subagentScanPassFailed`, `reseedPending`,
`adoptionRetries`, `adoptionRetryPending`, `idleDropped`, `idleDroppedSize`, `idleDroppedAt`,
`unwatchedDirs`, `unwatchedTreeScanAt`, and three `warned*` sets. A session move re-keys six of
them by hand in `wake` and two in `followMovedSession`; `dropHarnessSlot` deletes from seven.

---

## 2. Re-derivation table

Each row is a fact one process held at write time that another process (or the same one at a
later time) computes again from the filesystem as it is then. The right column names the open
issue that turns on the row, where one exists.

| # | Fact | Held by | Re-derived by | Turns on |
|---|---|---|---|---|
| R1 | the tag is settled (every subagent turn written, no read failed) | daemon: `pollHadFailure`, `turnHeldBack`, `tagGrewSinceMarker` | `tagProvisionalFromContent` scans the tail backwards for T7/T8; then the CLI overrides it from its own discovery scan (`subagent-unreadable`) and its own spawn-tree stat (`descendant-live`); the widget overrides from its own subagent parse | #235, #257, #169 |
| R2 | which sessions are inside SELF | daemon: `recordedFolds` per child, written as T11 | CLI reads T11 (settled by D1 in #194); the widget reads T11 **and** re-parses every subagent transcript live, merging both copies and relying on message-id collapse to cancel the tag's copy | #237 |
| R3 | a descendant's cost | the descendant's own daemon, in its own tag, when a reader has asked for it | `computeSpawnTree` → `parseDescendant` parses the transcript, and its subagents, on every report; `parseSessionFileStrict` re-runs `attributeClaudeSubAgentCosts`, the same fold the daemon ran | #216, #235 |
| R4 | the daemon is alive | daemon: `running` | four rules: `checkDaemonHealth` (lease pid + `kill 0`, then a T4 tail scan); `getDaemonStatus` adds a 5 s spawn grace and a 2 s tag-mtime grace; `watchTagFile` adds its own 2 s mtime grace and a 1,334 ms watchdog; `--list` reports idle from tag mtime | #266 |
| R5 | the session is idle | daemon: `lastActivityMs`, `idleStartMs` | `checkDaemonHealth` derives it from T4 `first` against the last T1 `t`, else from the session file's mtime | — |
| R6 | which transcript a tag line came from | daemon: `SubagentFileState.source` | `transcriptSourceId` is recomputed from the current path at the next read; a session move changes the answer for a child in the session's own directory | #263 |
| R7 | which `claude -p` lookups are open | daemon: `pendingClaudeCommands` | `resumeClaudeLookups` replays T9, T10 and T12; `reseedClaudeChildren` scans the projects root for every T12 session id | #267 |
| R8 | which process serves a session | the harness: `harnessSlots` | `daemonLaunchArgs` decides by path prefix in the CLI; `runHarness` decides again from the root file and version file; `restartDaemon` decides from `/proc/<pid>/cmdline` | #221, #260 |
| R9 | a held-back turn | daemon: `SubagentFileState.pendingTurn`, memory only | nothing: a crash loses it, and the next life reads from the offset after it | #257 |
| R10 | what the harness serves | the harness: `harnessSlots`, `adoptionRetries`, `idleDropped` | `.served` is rewritten every 250 ms by diffing `handOffLines()` against the file's text | — |
| R11 | the record kind of a tag line | the writer | five sites decide by substring: `includes('"_hb"')`, `includes('"_meta"')`, `includes('"_gen"')`, `includes('"_fold"')`, `includes('"spawnPending"')` | #140 |
| R12 | the lease is mine | the claimer | eight read-reprove-unlink implementations (§1b) | #249, #243 |

Rows R1, R2, R3 and R6 are the spawn-tree chain (#116 → #135 → #178 → #230 → #235 → #237).
Rows R4, R8, R10 and R12 are the daemon chain (#205 → #239 → #249 → #259 → #263 → #266).

---

## 3. Refactor

### 3a. Modules

Six modules. Each row names the interface a caller must know, and what moves behind it.

| Module | Interface | Behind it | Replaces |
|---|---|---|---|
| **TagLog** | `readTag(path) → TagView`; `openTagWriter(path) → { resume(), append(records), heartbeat(now), stop(reason), rebuild() }`; `TagRecord` as a typed union of T1–T12 | line safety, the heartbeat pwrite, generation supersession, id collapse, the offset marker, every substring match | the five R11 sites; `readLastMetaOffset`; `invalidateStaleSweptMarker`; `tagProvisionalFromContent`'s backward scan; `resumeClaudeLookups`' line loop |
| **Lease** | `claim(path, owner) → claimed \| busy \| rebuild`; `holder(path)`; `release(path, owner)`; `markRebuild(path)`; `takeOver(path, owner)` | read, re-prove inode, unlink; hard-link claim; SIGTERM of a per-session holder | the eight R12 implementations |
| **SessionTagger** | `step(state, input) → { state, records, verdict, warnings }` where `input` is `{ now, session?: { stat, bytes }, children: { path, stat, bytes? }[], discovered: string[] }` | `parseNewLines`, `syncSubagentTranscript`, `scanForSubAgents`, `queueClaudeCommand`, the owner/fold/generation/held-turn logic. No `fs`, no `Date.now()`, no `process` | the 25-field `Slot` and `install`/`save`; `serviceSession`'s poll body |
| **HarnessRegistry** | `serve(file, displayed)`; `drop(key, reason)`; `move(from, to)`; `tick(now)`; `snapshot() → HandOff` | one record per session holding its `SessionTagger` state, watchers, timers, retry count, idle stamp, scan cursor | the 17 side collections; `wake`'s re-key block; `handOffLines` |
| **DaemonHealth** | `health(sessionPath, now) → { alive, idle, since, reason }` | lease read, T4 tail read, the spawn and mtime graces | the four R4 rules |
| **CLI arms** | `runReport(opts)`, `runWatch(opts)`, `runForceRebuild(opts)`, `runDaemonCommand(opts)` | what `bin/wtft.ts` `main` does after argument parsing | the 555-line `main` |

`SessionTagger` is the deep one. Its interface is one function over values; its implementation
is the 900 lines that today sit in `syncSubagentTranscript` and `scanForSubAgents`. The daemon
process becomes a shell: stat and read files, call `step`, hand `records` to `TagLog`, sleep.

### 3b. Slices

Each slice is one PR, behaviour-preserving, with the test that proves it named before the
first edit. Order matters: S0 is the safety net every later slice runs against.

| Slice | Change | Test (the closer) |
|---|---|---|
| **S0 golden tags** | A characterization suite: run the current daemon over the fixture transcripts under `tests/fixtures/` (session, Task subagents, Pi siblings, a `claude -p` child, a rotation, an interrupt) and commit the tag files it writes, with T4/T7 timestamps normalised | `tests/wtft-270-golden-tags.test.ts`: the daemon on `main` reproduces the committed tags byte for byte after normalisation. Every later slice must pass it unchanged |
| **S1 TagLog** | `extensions/lib/tag-log.ts`: the typed record union and one parser; every substring site and every tail scan calls it | `tests/wtft-tag-format.test.ts` extended to round-trip all twelve kinds; a parse of every committed golden tag yields the same `TagView` before and after; #140's repro (a command mentioning `_hb`) passes |
| **S2 Lease** | `extensions/lib/lease.ts`; the eight sites call it | `tests/wtft-270-lease.test.ts`: the matrix {absent, live pid, dead pid, `rebuild`, foreign live daemon, harness holder} × {claim, release, takeOver, markRebuild} on temp files, no daemon spawned |
| **S3 SessionTagger** | `extensions/lib/session-tagger.ts` with `step`; the daemon's poll calls it; `Slot` becomes the state value | S0 passes; `tests/wtft-270-session-tagger.test.ts` replays each fixture through `step` in memory and compares records to the golden tag; the cases #257 (growth after a sliced scan), #263 (move changes source), #267 (lookup survives restart) as pure `step` sequences |
| **S4 HarnessRegistry** | one record per session; `move` re-keys one entry; `snapshot` is the hand-off | `tests/wtft-270-harness-registry.test.ts`: serve → move → drop → snapshot round trip in memory; the existing 205/239/259/262 suites stay as the process-level check |
| **S5 DaemonHealth** | one function; CLI, `--watch`, widget and `--list` call it | `tests/wtft-270-daemon-health.test.ts`: {lease state} × {tag tail} × {age} → one answer; `wtft-179-daemon-health-reason.test.ts` unchanged |
| **S6 CLI arms** | `bin/wtft.ts` `main` dispatches to four functions in `extensions/lib/cli/` | the existing CLI suites unchanged; `bin/wtft.ts` `main` under 80 lines |

Freeze: no daemon feature lands between S0 and S4. Issues #257, #263, #266, #267 are closed by
S3–S5, not before.

### 3c. What stays

- The tag file format (`docs/wtft-tag-format.md`) and the tagger version. S1 changes no bytes.
- The harness seam (`extensions/lib/harness/`), discovery, pricing, the renderer, `--json`.
- The spawn ledger and `computeSpawnTree`'s interface. R3 (the walk re-parses descendants) is
  left standing until S3 lands; then a child tag, where one exists, is the cheaper input, as its
  own issue.

### 3d. Closer for the issue

- Every function in #270's table under an approximate cyclomatic count of 30.
- `tests/wtft-270-session-tagger.test.ts` exercises fold, generation, held-turn, rotation and
  interrupt logic with no daemon process spawned.
- The count of suites that spawn `wtft-daemon` falls below 30 (54 on `main` @ `0082dee`).
- Two consecutive weeks with issues opened at or below issues closed, no leads-dump issue
  filed, and no regression-class issue within 48 h of a daemon merge.

---

## 4. Decisions taken while building (Princess Pi, for Duppy's later review)

- **S0–S2 land on the spec branch as one PR.** Branches start only from `main` and the merge
  gate is human, so a slice cannot build on an unmerged earlier slice. S0 is the safety net
  S1 and S2 are checked against, so they travel together. S3 starts from `main` after that
  merge. *Road not taken:* one PR per slice as §3b says, which would have left S1 without S0's
  suite on its branch.
- **The golden compares a normalised line multiset plus a parsed view, not bytes in order.**
  The order children are read is `readdir` order, which the filesystem decides, so a byte-order
  golden would fail on another host with nothing wrong. The multiset catches any content
  change; the view catches an order change that alters meaning. Normalised away: the sandbox
  path and its slug, source hashes (relabelled by child), heartbeat and sweep clocks, the byte
  offset marker (it follows the sandbox path's length), and the order of a `spawnSettled`
  record's `children` array.
- **The golden corpus is static.** Every transcript is written whole before its daemon starts,
  so the run is decided by content. Rotation and interrupt-after-write are timing cases and
  stay with the suites that own them (114, 220). Two runs on this host agree.
- **S1's tests are a new suite, `tests/wtft-270-tag-log.test.ts`,** rather than an extension of
  `tests/wtft-tag-format.test.ts`, which pins the serialise/deserialise round trip of one record
  kind and is left as it is.
- **S1 also replaced the session picker's private tag reader.** `session-selector.ts` carried
  a seventh substring site and its own generation and id-collapse logic, outside the map's
  §1 count. It now calls `classifiedInteractionsFromContent`, and its allowlist entry in
  `tests/wtft-tag-reader-collapse-guard.test.ts` is gone.
- **A sweep marker may share its line with an offset.** `tests/wtft-443-provisional-tag-read.test.ts`
  pins that shape, which no current writer produces. `recordOf` reads the line as `swept` or
  `unswept` and carries the offset on the record, so `lastOffset` still finds it.
- **S2's claim retries once, not forever.** The per-session daemon's old claim loop retried a
  lost race without bound; `claimLease` retries once and reports `busy`, on which the daemon
  exits 0 as it did for a live holder. A reader's `awaitDaemonUp` then sees whichever daemon
  won. *Road not taken:* keeping the unbounded loop inside the module, which would have put a
  process-exit policy behind a file-level interface.
- **S2 changed one behaviour on purpose.** `restartDaemon` unlinked the lease unconditionally
  after signalling its holder; it now unlinks only a lease that still names that holder, the
  same re-prove every other site already did.
- **An observed inode identity is a weak witness on Linux.** ext4 hands a freed inode number
  straight back to the next file created, so unlink-then-write can reproduce the identity the
  caller observed. The module keeps the check because a rename-replacement (the shape every
  wtft writer uses) does get a new inode; `tests/wtft-270-lease.test.ts` U4 builds its fixture
  that way.

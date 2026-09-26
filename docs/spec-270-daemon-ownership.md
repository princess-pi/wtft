# Spec 270 — daemon ownership map and deep-module refactor

Issue: https://github.com/princess-pi/wtft/issues/270. Measured on `main` @ `0082dee`, 2026-09-25.

**Read §1 and §2 as the map measured on `main` @ `0082dee`, corrected where the reconcile
auditors found a cell wrong about `main`, and with the lease rows of §1b, the per-session
`main` row, R11 and R12 saying what S1 and S2 made of them.** The
retired names are `tryClaimLease`, `currentGenerationRecords` and `claimPidFile`'s inline claim;
`unlinkIfStill` and `unlinkIfNames` survive as one-line wrappers over `unlinkLeaseIf`, and
`readLastMetaOffset` still runs, over `tagRecords`. §4 says what each slice replaced, and the
code is the authority for what runs now.

Part 1 is the map: every persistent record the daemon, CLI and widgets share, with its writer,
its readers and the moment each acts. Part 2 lists where a reader re-derives a fact a writer
already held. Part 3 is the refactor: which modules, what each one's interface is, and the
test that proves each slice.

Vocabulary is the `codebase-design` skill's: module, interface, seam, adapter, depth.

---

## 1. Ownership map

### 1a. Tag file `<sessionDir>/wtft-tags/<base>.wtft-tag.v<V>.jsonl`

Format contract: `docs/wtft-tag-format.md`. Twelve record kinds share one file; the reader adds
`meta-other` and `unknown` (§3a). "Moment" is
when the write happens; "reader" names every consumer and what it takes from the record.
The writer functions are named as they stood on `main` @ `bd97904`; since S3 the ones that
decide a record (`parseNewLines`, `queueClaudeCommand`, `syncSubagentTranscript`,
`skipAsFoldedElsewhere`, `scanForSubAgents` as `scanChildren`, `flushPending` as
`flushTurns`, `invalidateStaleSweptMarker`) live in `extensions/lib/session-tagger.ts` and
return the record; the daemon's `flushPending`, `scanForSubAgents` and `appendTagFile` do
the append. Since S4 the harness's session-keyed collections named below are one `registry`
value (`extensions/lib/harness-registry.ts`), and `handOffLines` is `handOff(registry, handedOn)`.

| # | Record | Writer (function) | Moment | Readers → what they take |
|---|---|---|---|---|
| T1 | interaction line, no `s` | `flushPending` via `serializeClassifiedWithOverheadSplit` | ≥ 667 ms after the last flush, scan write or poll heartbeat (`lastWriteMs`; a spawn, retraction or start-heartbeat append leaves it unchanged); at once on `shutdown`, `dropHarnessSlot`, `stopHarness` | CLI `readTagFileWithVerdict`; widget same; `token-budget` `readClassifiedTagFile`; `--watch` `seedClassifiedTagFile` / `watchTagFile`; `checkDaemonHealth` → `m`, `ttl`, `t` (last 8 KiB, lease pid alive, no generation filter); `tagProvisionalFromContent` / `sweepState` → data; daemon `initClassified` → "has data" (any turn, fold, generation or `unknown` record); `invalidateStaleSweptMarker` → ends its backward scan; `reapAndWarn` → any `turn` record; `sessionWasEverParsed` → any turn, offset, sweep, spawn or `meta-other` record |
| T2 | interaction line with `s` | `syncSubagentTranscript`; `scanForSubAgents` for a vanished transcript's held turn | each child-transcript read that produced turns; the last plain turn of a growing read, held back and written by a later read; an owner rewrite with no new bytes when its folded children change; a re-interrupted copy | as T1, filtered by `currentGeneration` |
| T3 | `#oh` overhead line | `flushPending` | with T1, on a recache or compaction | as T1; never id-collapsed with its bare line |
| T4 | `_hb {first,last}` | `upsertHeartbeat`, `initClassified` | every per-session poll with nothing pending, and every poll while the session file does not exist yet; once at every start or adoption, displayed or not; when the sweep finds a `.display` marker. A harness has no timer poll, only `wake`, so an idle displayed slot gets no periodic beat | `checkDaemonHealth` → idle since / last beat; `reapAndWarn` → heartbeat ratio, zombie age; `upsertHeartbeat` → last line's kind, to overwrite in place; `sweepState` / `invalidateStaleSweptMarker` → passed over; `initClassified` → excluded from "has data"; `sessionWasEverParsed` → not parse evidence |
| T5 | `_hb "stop", reason` | `shutdown`, `dropHarnessSlot`, `stopHarness` | exit or drop, only while the lease still names this pid and, for a drop, with a reason: the lost-lease exit, a drop for a `rebuild` lease or a move collision, and `fatalTagMutation` write none | `reapAndWarn` → excluded from the ratio; `checkDaemonHealth` → skipped; `sweepState` → passed over, so a stop after a swept marker stays swept |
| T6 | `_meta.offset` | `flushPending` | after every T1 batch | daemon `readLastMetaOffset` (last 8 KiB only); `sessionWasEverParsed` → parse evidence; `lastOffset` also takes one riding on a sweep marker |
| T7 | `_meta.swept` | `scanForSubAgents` | a scan with no failure, no held-back turn, and a tag that grew since the last marker, or an unswept retraction with no growth; never on a cut harness slice. `tagGrewSinceMarker` starts true in every life and slot, so the first clean scan stamps | `tagProvisionalFromContent` (CLI, widget) → settled, when the file name's version is current and no data or `unknown` record follows; daemon `invalidateStaleSweptMarker`; `sessionWasEverParsed` |
| T8 | `_meta.unswept` | `invalidateStaleSweptMarker` | a session read failed after a swept marker; startup resume | `tagProvisionalFromContent` → `unswept`; `invalidateStaleSweptMarker` → returns at it; `sessionWasEverParsed` |
| T9 | `_meta.spawnPending {key,at,commands}` | `queueClaudeCommand` | a turn of the session's own transcript with a `claude -p` command is read, never one in a subagent transcript; a later line with the same key that adds a command appends a second | daemon `resumeClaudeLookups`; `sessionWasEverParsed` |
| T10 | `_meta.spawnSettled key, children[]` | `scanForSubAgents` | the lookup for a turn ends, or its window closes with nothing searched; `children` is omitted when the lookup registered none | daemon `resumeClaudeLookups`; `sessionWasEverParsed` |
| T11 | `_fold {parent,child,s}` | `syncSubagentTranscript` | a child's first write in a generation records the child itself; then each session a model-tagged turn folded that this generation had not recorded | CLI and widget `foldedIdsFromRecords` → `computeSpawnTree.alreadyAttributed`; daemon `reseedClaudeChildren`; `initClassified` → "has data"; `sweepState` / `invalidateStaleSweptMarker` → data |
| T12 | `_gen {s,session}` | `syncSubagentTranscript`, `skipAsFoldedElsewhere`, the pending-turn release in `scanForSubAgents` | first read of a child in a daemon life, turns or none; rotation; a child another transcript now folds; an interrupt that must mark an id-less turn already written; an owner's attributed cost shrinking | `currentGeneration` (CLI, widget, `--watch` reseed via `appendedGeneration`); daemon `resumeClaudeLookups` → sources already read; `reseedClaudeChildren`; `initClassified` → "has data"; `sweepState` / `invalidateStaleSweptMarker` → data |

Which open issue turns on each record: T4 → #266; T7, T8 → #235, #257; T9, T10, T12 → #267;
T11 → #237; T12 → #263. The lease (§1b) → #249, #243, #221, #260; the harness root files (§1c)
→ #260. Rows without a number have no open issue on them today.

Whole-file properties that are also read as state:

| Property | Writer | Readers → what they take |
|---|---|---|
| size, mtime | every append; the in-place heartbeat write changes mtime with no append | `getDaemonStatus` → 2 s grace after a lost lease; `watchTagFile` → 2 s grace; `token-budget` → active if mtime < 2 min; `wtft-daemon --list` → idle age, from the first tag file of any version `readdir` returns; `reapAndWarn` → warns above 1 MB; `checkDaemonHealth` → size > 0 gate |
| truncate to 0 | `initClassified` on rebuild, on a partial tail (cut to `lastLineStartByte` first), on a tag with no data record, and on a tag whose offset marker is not in the last 8 KiB `readLastMetaOffset` reads (a valid tag rebuilt from scratch; lead on #261) | `watchTagFile` → reseed when size < offset, or when the prefix sentinel changed after a regrowth |
| heartbeat overwritten in place | `upsertHeartbeat` | `watchTagFile` → prefix sentinel unchanged |
| file name version | `getCurrentVersionTagPath` names the writer's path; per-session `main` deletes older-version tags at start and 5 s later, a harness adoption never does | `tagProvisionalFromContent` → `stale-version`; `waitingForDataLine`; `getTagPath` → the other-version fallback; per-session `main` → exit or take over on a newer tag; `--list` → the printed version; `forceRebuildSession` → deletes every version |

### 1b. Session lease `$TMPDIR/wtft-daemon-<hash>.pid`

Value is a pid or the token `rebuild`. Hash is of the transcript basename when it is a session
id, else of the raw `--session` string; `--stop` hashes the resolved path, so a relative
non-session-id path names a different lease (lead on #261). Two transient siblings exist while
`lease.ts` works: `<lease>.claim-<pid>` and `<lease>.replace-<pid>`.

| Writer | Moment | Effect |
|---|---|---|
| per-session `main` (`claimLease`, hard link) | start | claims; a lease that exists but cannot be read fails the start (exit 1); any live pid is busy, EPERM included, and busy exits 0; a dead pid, `rebuild`, empty or non-numeric holder is unlinked and the claim retried once |
| `replaceLease` | version takeover at start, replacing whatever live holder the lease names; `fatalTagMutation` writes `rebuild` for the current slot only, then exits the whole harness with code 1, leaving every other served lease naming a dead pid | replaces |
| `claimPidFile` (`claimLease` with `holderIsLiveDaemon`) | harness `adoptSession`, through `takeOverLease`; `runHarness` for the root file | claims; `rebuild`, empty, a dead pid and a live non-daemon pid are stale and unlinked; off Linux `procIsDaemon` is always false, so every holder is stale |
| `takeOverLease` | harness adoption against a live per-session daemon | SIGTERM up to 20 times, 50 ms apart, then claims; returns false at once for a `--harness` holder, and after about 1 s busy, to `retryAdoptionLater` |
| `pointSessionAt` | any `--harness` start with a session that found a live harness not older than itself | writes the harness pid unless the lease reads `rebuild` or another live daemon holds it, plus a `.display` sidecar, plus a focus request; on a failed request unlinks the lease and `.display` unless the harness held both |
| `forceRebuildSession` (CLI `-F`) | user | writes `rebuild` for a harness (`replaceLease`, expected the value first read); for a per-session daemon SIGTERMs, then `unlinkLeaseIf`: `busy` when the lease changed, `unreadable` when it cannot be re-read, `undeletable` when the unlink fails |
| `wtft-daemon --stop`, `--restart`, `--cleanup`, `reapAndWarn`, `releaseLease`, `shutdown`, `stopHarness`, `retryAdoptionLater`, `pointSessionAt`'s failure path, `claimLease`'s stale unlink, CLI `restartDaemon` | each its own | unlink, all through `unlinkLeaseIf`; only `reapAndWarn` passes an observed inode |

Readers: `checkDaemonHealth` (pid alive → daemon alive), `serviceSession` (holder is me, every
poll), `leaseStillOurs`, `leaseLost`, `logLeaseLost`, `wake` (`rebuild` → adopt afresh),
`awaitDaemonUp`, `handedOn` (the hand-off's keep predicate), `retryAdoptionLater`, `forceRebuildSession`, `restartDaemon`,
the CLI's `-F` adoption wait, `shutdown`, `takeOverLease`, `pointSessionAt`, `reapAndWarn`,
`--stop`, `--list`, `--cleanup`, `--restart`, per-session `main`, and `claimLease` itself.

On `main` nine sites unlinked a lease, each with its own check. Five re-proved the inode
("read the lease, re-prove the inode, unlink"): `unlinkIfHolds`, `unlinkIfStill`,
`unlinkIfNames`, `releaseLease` and `tryClaimLease`. `shutdown` checked the content and not the
inode. `claimPidFile` (which `takeOverLease` reached), `forceRebuildSession`'s per-session path
and `restartDaemon` unlinked unconditionally. S2 left one implementation, `unlinkLeaseIf`, plus
`claimLease`; `forceRebuildSession` keeps three raw reads (§4), and `takeOverLease`,
`pointSessionAt`, the pre-claim guard in per-session `main` and the CLI's `-F` wait read raw too.

### 1c. Harness root files `$TMPDIR/wtft-harness-<which>-<hash>.pid` and sidecars

| File | Writer | Moment | Reader → what it takes |
|---|---|---|---|
| `.pid` | `runHarness` (`claimPidFile`); `stopHarness` (a raw read-compare-unlink, outside `lease.ts`), `--restart` unlink | start / stop; a newer starting harness SIGTERMs an older live one and SIGKILLs it 2 s later, as does `--restart` | `sweepIdleSlots` every 250 ms → holder is me, else stop, and exit 1 on any read error but ENOENT; `holdsHarnessRoot`; `pointSessionAt`; `stopHarness`; `--restart`; a later `runHarness` → live pid |
| `.<pid>.version` | `runHarness`; removed by its `leave()` and by `stopHarness`, not on a `fatalTagMutation` exit | before the claim | a later `runHarness` → `taggerIsOlder` decides replace or hand over; a missing file reads "", which counts as older |
| `.focus.d/<pid>.request` | `pointSessionAt` (a second daemon process), written as `<pid>.tmp` then renamed, withdrawn if the root changed hands | any `--harness` start with a session that found a live harness not older than itself | `claimFocusRequests` (rename to `<name>.<pid>.claimed`) on `fs.watch`, every sweep and at the idle stop; JSON or the older `<pid>\n<path>` text; a path outside the root is dropped silently |
| `.display` | `pointSessionAt` | with the focus request | `sweepIdleSlots` → sets `displayed`, writes a heartbeat, deletes it; removed by `releaseLease`, by `retryAdoptionLater` when no lease is left, by `pointSessionAt`'s failure path; left behind by `--stop` of a harness session |
| `.served` | `writeServedHandOff` at stop, while this process still holds the root; `persistHandOff` at the end of every full sweep when the text differs; `fatalTagMutation`; both writers remove it when it would be empty | continuous | `takeServedHandOff` (rename-claim `.served.<pid>.claimed`) at the next start; `persistHandOff` reads it; an unreadable file is moved to `.served.unreadable-<UTC>`; entries carry `since` and `sig` for idle sessions |
| transient | `.served.<pid>.tmp`, `.focus.d/<pid>.tmp`, `.focus.d/*.<pid>.claimed`; the `.focus.d` directory itself (mode 0700, never removed) | | |

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

On `main` @ `0082dee`, `bin/wtft-daemon.ts` held 38 module-level `let` bindings and 17
module-level `Map`/`Set` collections (after S3: 15 bindings, 11 collections, one
`Slot` holding the `TaggerState`, no `install`/`save`; after S4: 15 bindings, two
directory-keyed collections, `harnessWatchers` and `unwatchedDirs`, and one `registry` value
holding the session-keyed records; this section keeps the measurement). In harness mode, `install(slot)` / `save(slot)` copy 24 of the `let` bindings (all but `checkedAtMs`) into
and out of a `Slot` around every call. The 17 collections are not in the `Slot`, and most are
keyed by session path (`harnessWatchers` and `unwatchedDirs` by directory, the `warned*` sets by
child transcript path): `harnessSlots`, `harnessWatchers`, `harnessFlushTimers`,
`subagentScansContinuing`, `subagentScanPass`, `subagentScanPassFailed`, `reseedPending`,
`adoptionRetries`, `adoptionRetryPending`, `idleDropped`, `idleDroppedSize`, `idleDroppedAt`,
`unwatchedDirs`, `unwatchedTreeScanAt`, and three `warned*` sets. A session move re-keys six of
them by hand in `wake` and two in `followMovedSession`; `dropHarnessSlot` deletes from eight.

---

## 2. Re-derivation table

Each row is a fact one process held at write time that another process (or the same one at a
later time) computes again from the filesystem as it is then. The right column names the open
issue that turns on the row, where one exists.

| # | Fact | Held by | Re-derived by | Turns on |
|---|---|---|---|---|
| R1 | the tag is settled (every subagent turn written, no read failed) | daemon: `pollHadFailure`, `turnHeldBack`, `tagGrewSinceMarker`, `sweptRetracted`, a cut slice, `subagentScanPassFailed`, `reseedPending`, `sessionReadFailed` | `tagProvisionalFromContent` reads the whole content through `sweepState`, and `invalidateStaleSweptMarker` re-derives the same state; then the CLI overrides it from its own discovery scan (`subagent-unreadable`) and its own spawn-tree stat (`descendant-live`); the widget overrides from its own subagent parse | #235, #257, #169 |
| R2 | which sessions are inside SELF | daemon: `recordedFolds` per child, written as T11 | CLI reads T11 (settled by D1 in #194); the widget reads T11 **and** re-parses every subagent transcript live, merging both copies and relying on message-id collapse to cancel the tag's copy | #237 |
| R3 | a descendant's cost | the descendant's own daemon, in its own tag, when a reader has asked for it | `computeSpawnTree` → `parseDescendant` parses the transcript, and its subagents, on every report; `parseSessionFileStrict` re-runs `attributeClaudeSubAgentCosts`, the same fold the daemon ran | #216, #235 |
| R4 | the daemon is alive | daemon: `running` | four rules: `checkDaemonHealth` (lease pid + `kill 0`, then a T4 tail scan); `getDaemonStatus` adds a 5 s spawn grace and a 2 s tag-mtime grace; `watchTagFile` adds its own 2 s mtime grace and a 1,334 ms watchdog; `--list` reports idle from tag mtime | #266 |
| R5 | the session is idle | daemon: `lastActivityMs`, `idleStartMs` | `checkDaemonHealth` derives it from T4 `first` against the last T1 `t`, else from the session file's mtime | — |
| R6 | which transcript a tag line came from | daemon: `SubagentFileState.source` | `transcriptSourceId` is recomputed from the current path at the next read; a session move changes the answer for a child in the session's own directory | #263 |
| R7 | which `claude -p` lookups are open | daemon: `pendingClaudeCommands`, `discoveredClaudeFiles` | `resumeClaudeLookups` replays T9, T10 and T12; `reseedClaudeChildren` checks `<projectsDir>/<dir>/<id>.jsonl` for every T12 id with a matching source, skipping ids T11 says another source folds and ids discovery finds | #267 |
| R8 | which process serves a session | the harness: the registry's `served` map | `daemonLaunchArgs` decides by path prefix in the CLI; `runHarness` decides again from the root file and version file; `restartDaemon` decides from `/proc/<pid>/cmdline`; `wtft-daemon --restart` respawns each lease holder's session with the old process's root env | #221, #260 |
| R9 | a held-back turn, and every subagent read position | daemon: `SubagentFileState`, memory only | nothing: a crash loses it; the next life reads every discovered subagent transcript from byte 0 as a new generation and re-registers `claude -p` children, so the held turn is read again. The T6 offset covers the session transcript only, and it counts a trailing fragment's bytes, so a restart resumes mid-line and drops that line (lead on #261) | #257 |
| R10 | what the harness serves | the harness: the registry's `served`, `retrying` and `idle` maps, each record's lease state | `.served` is rewritten at the end of every full 250 ms sweep, while this process holds the root, by diffing `handOff(registry, handedOn)` against the file's text | — |
| R11 | the record kind of a tag line | the writer | on `main`, four daemon functions (`resumeClaudeLookups`, `reapAndWarn`, `reseedClaudeChildren`, `initClassified`) and `appendedGeneration` tested substrings (`"_hb"`, `"_meta"`, `"_gen"`, `"_fold"`, `"spawnPending"`, `"spawnSettled"`, `"stop"`), and the picker and `watchTagFile` decided kinds on their own; after S1 every reader decides through `tag-log.ts` | #140 |
| R12 | the lease is mine | the claimer | on `main`, nine unlink sites with three different checks (§1b); one implementation after S2 | #249, #243 |

Rows R1, R2, R3 and R6 are the spawn-tree chain (#116 → #135 → #178 → #230 → #235 → #237).
Rows R4, R8, R10 and R12 are the daemon chain (#205 → #239 → #249 → #259 → #263 → #266).

---

## 3. Refactor

### 3a. Modules

Six modules. Each row names the interface a caller must know, and what moves behind it. The
**TagLog**, **Lease**, **SessionTagger** and **HarnessRegistry** rows name what S1–S4 built;
the two below them are the plan, and no symbol in them exists yet.

| Module | Interface | Behind it | Replaces |
|---|---|---|---|
| **TagLog** (`extensions/lib/tag-log.ts`, built) | `TagRecord`, a typed union: `turn`, `heartbeat`, `stop`, `offset`, `swept`, `unswept`, `spawn-pending`, `spawn-settled`, `fold`, `generation`, plus `meta-other` and `unknown`; `parseTagLine(line)`; `recordOf(obj)`; `tagRecords(content)`; `currentGeneration(records)`; `sweepState(records)`; `lastOffset(records)`; `isDataRecord(r)` | shape-decided kinds, generation supersession, the sweep scan, the offset read (an offset may ride on a sweep marker) | the substring sites (R11) and the picker's private reader; `tagProvisionalFromContent`'s backward scan. Id collapse stays `dedupeClassifiedById`; `readLastMetaOffset`, `invalidateStaleSweptMarker` and `resumeClaudeLookups` stay in the daemon and now read through `tagRecords`; the writer (`appendTagFile`, the heartbeat pwrite) stays in the daemon until S3 |
| **Lease** (`extensions/lib/lease.ts`, built) | `claimLease(file, owner, holderIsLive) → claimed \| busy`; `leaseHolder(file)`; `leaseIdentity(file)`; `unlinkLeaseIf(file, value, observed?)`; `replaceLease(file, value, owner, expected?)` | hard-link claim with one retry; content-and-inode re-prove before an unlink; rename publish | the nine R12 unlink sites. The `rebuild` mark is `replaceLease(lease, "rebuild", pid[, expected])`: the CLI passes the value it first read, the daemon's `fatalTagMutation` none; the SIGTERM of a holder stays with the callers (`forceRebuildSession`, `restartDaemon`, `takeOverLease`, `reapAndWarn`, `--stop`, `--cleanup`, `--restart`, and `runHarness` for the root file); `forceRebuildSession` still reads the lease raw where it must tell a missing file from an unreadable one |
| **SessionTagger** (`extensions/lib/session-tagger.ts`, built; design in `docs/spec-270-session-tagger.md`) | `TaggerState` (one session's tagging state, a plain object); `World` (the port: every filesystem and clock read) with `fsWorld(now?)` as the daemon's adapter; `newTaggerState(sessionPath, tagPath)`; `resumeTagger(state, tagContent, world) → { complete, records, log }`; `stepTagger(state, world, { flush, sliceMs? }) → { records, cut, wrote, activity, log }`, composed of the exported `readSession`, `flushTurns`, `scanChildren`, which the daemon calls apart | the session read, the `claude -p` lookup queue, the child sync, the owner/fold/generation/held-turn logic, the scan pass and its slice, the resume's reseed and lookups, the swept stamp and its retraction. The tagging code reaches the filesystem and the clock only through `World`; `fsWorld`, in the same file, is the one place `fs` and `Date.now` appear. No `process`: records come back to the caller, so do log lines | the 24 module-level session bindings, `install`/`save`, `parseNewLines`, `syncSubagentTranscript` and the rest of §1's daemon-side tagging functions (the daemon's `flushPending` and `scanForSubAgents` remain as appenders around `flushTurns` and `scanChildren`); `Slot` was `{ state, pidPath, rebuildTagOnStartup, lastWriteMs, lastActivityMs, startupTime, idleStartMs, sessionExisted, displayed, checkedAtMs }` until S4, and is `SessionRecord` since |
| **HarnessRegistry** (`extensions/lib/harness-registry.ts`, built; design in `docs/spec-270-harness-registry.md`) | `Registry` (a plain value: `served`, `idle`, `retrying` maps); `SessionRecord` (the `Slot` fields plus `scanContinuing`, `flushTimer`, `unwatchedTreeScanAt`); `newRegistry()`; `newSessionRecord(path, displayed, now)`; `serve`, `get`, `move(reg, from, to)`, `drop(reg, key)`; `markIdle`, `forgetIdle`, `expiredIdle`; `beginRetry`, `retryFired`, `cancelRetry`, `retryPending`; `isEmpty`, `servedOver`, `needsDir`, `projectInUse`, `sessionDirOf`; `handOff(reg, keep, adopting?)` and `parseHandOff(text, root)` | one record per session; a move re-keys one entry with its flag and stamp and hands the flush timer back; the retry count and its pending mark; the idle stamp and signature; the hand-off's text and its parse. No `fs`, no timer, no clock: the daemon makes and clears the timers the record holds, and passes `now` | nine session-keyed collections (`harnessSlots`, `harnessFlushTimers`, `subagentScansContinuing`, `adoptionRetries`, `adoptionRetryPending`, `idleDropped`, `idleDroppedSize`, `idleDroppedAt`, `unwatchedTreeScanAt`); `wake`'s re-key block and `followMovedSession`'s marker re-key; `handOffLines`; `dirStillNeeded`, `servedSessionOver`, `freshSlot`. `harnessWatchers` and `unwatchedDirs` stay in the daemon, keyed by directory (`docs/spec-270-harness-registry.md` §4) |
| **DaemonHealth** | `health(sessionPath, now) → { alive, idle, since, reason }` | lease read, T4 tail read, the spawn and mtime graces | the four R4 rules |
| **CLI arms** | `runReport(opts)`, `runWatch(opts)`, `runForceRebuild(opts)`, `runDaemonCommand(opts)` | what `bin/wtft.ts` `main` does after argument parsing | the 555-line `main` |

`SessionTagger` is the deep one. Its interface is a state value, a port and a step over them;
its implementation is what sat in `syncSubagentTranscript` and `scanForSubAgents`. The daemon
is the shell: it calls the step's parts through `fsWorld()`, appends `records`, prints `log`, sleeps.

### 3b. Slices

Each slice is one PR, behaviour-preserving, with the test that proves it named before the
first edit. Order matters: S0 is the safety net every later slice runs against.

| Slice | Change | Test (the closer) |
|---|---|---|
| **S0 golden tags** | A characterization suite: run the built daemon over a static corpus written by `tests/lib/golden-corpus.ts` (a plain session, a session with two Task subagents, a Pi session with a sibling, a `claude -p` child with a grandchild) and commit the tag files it writes under `tests/fixtures/270-golden-tags/` | `tests/wtft-270-golden-tags.test.ts`: the daemon reproduces the committed tags as a normalised line multiset plus a parsed view (§4), and refuses to run on a bundle not newer than `bin/wtft-daemon.ts` and `extensions/lib/**` (the `@princess-pi/libs` package it also bundles is not watched). Every later slice must pass it unchanged |
| **S1 TagLog** | `extensions/lib/tag-log.ts`: the typed record union and one parser; every substring site and every tail scan calls it | `tests/wtft-270-tag-log.test.ts` reads every kind; the golden suite's parsed view is unchanged before and after; #140's repro (a command mentioning `_hb`) passes |
| **S2 Lease** | `extensions/lib/lease.ts`; the nine unlink sites call it | `tests/wtft-270-lease.test.ts`, on temp files, no daemon spawned: `claimLease` over {absent, mine, live, dead, rejected by the predicate, empty, the displaced holder seen by the predicate}; `unlinkLeaseIf` over {mismatch, match, absent, new inode, observed inode}; `replaceLease` over {unconditional, expected mismatch, expected match, absent, write failure}. Liveness is the caller's predicate, so "harness holder" is the daemon's `holderIsLiveDaemon`, tested by the process-level suites |
| **S3 SessionTagger** (built) | `extensions/lib/session-tagger.ts` with `stepTagger` and its parts; the daemon's poll calls the parts; `Slot` holds the state value | S0 passes; `tests/wtft-270-session-tagger.test.ts` replays each fixture through `stepTagger` over the sandbox corpus and compares records to the golden tag; the cases #257 (growth after a sliced scan), #263 (move changes source), #267 A–E, G, H (lookup survives restart, held turns released) as step sequences. Design, behaviour changes and closer: `docs/spec-270-session-tagger.md` |
| **S4 HarnessRegistry** (built) | `extensions/lib/harness-registry.ts`: one record per session; `move` re-keys one entry; `handOff` is the hand-off and `parseHandOff` its read | `tests/wtft-270-harness-registry.test.ts`: serve, move (#267 F), idle, retry, drop and a hand-off round trip in memory; the existing 205/239/259/262 suites stay as the process-level check. Design and closer: `docs/spec-270-harness-registry.md` |
| **S5 DaemonHealth** | one function; CLI, `--watch`, widget and `--list` call it | `tests/wtft-270-daemon-health.test.ts`: {lease state} × {tag tail} × {age} → one answer; `wtft-179-daemon-health-reason.test.ts` unchanged |
| **S6 CLI arms** | `bin/wtft.ts` `main` dispatches to four functions in `extensions/lib/cli/` | the existing CLI suites unchanged; `bin/wtft.ts` `main` under 80 lines |

Freeze: no daemon feature lands between S0 and S4. Issues #257, #263, #266, #267 are closed by
S3–S5, not before. S3 closes #257 and #263 and checks #267 A–E, G, H; S4 checks #267 F; I and J
stay on #267.

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

S3's own decisions and roads not taken are in `docs/spec-270-session-tagger.md` §4. What S3
changed beyond a move of code (each with a check but the last): a sliced pass re-reads a transcript that
grew after it took it (#257); a child transcript keeps one source across a move of its session
and its own rotations for as long as the daemon holds its state, and a resume recovers it (#263);
a registered `claude -p` child gone from disk is gone, not a failed read, so its held turn is
written, unless a transcript with that source was read again in the same scan, and the tag swept
(#267 G, a pre-existing bug the R part exposed); a released held turn records its fold like any
written turn; the swept-marker retraction reads the session's fixed tag
path. `CONTEXT.md` Source and `docs/wtft-tag-format.md` `s` say the source is fixed at the
first read.

S4's decisions and roads not taken are in `docs/spec-270-harness-registry.md` §4. S4 moves
state, not behaviour, with three exceptions, each in `docs/spec-270-harness-registry.md` §2
and §4: the hand-off read is hardened as `parseHandOff` takes it over (a `null` line no longer
crashes the start, a non-object line counts as unreadable, a `..` path is resolved before the
root check); `--restart` stops, waits for and respawns only a live daemon; and a scan cut in
the poll that detects a move continues under the new key. `--restart`'s stdout and `--help`
wording was corrected to what it does. The
process-level suites pass unchanged, and S4's own suite runs in memory;
one check in it is the scan-continuation flag surviving a move (#267 F), which is now a field
of the moved record.

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
  its own kind decisions and its own generation and id-collapse logic, outside the map's
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
- **S2 changed five small behaviours, all in the same direction: unlink only what was read.**
  `restartDaemon` unlinked the lease unconditionally after signalling; `shutdown` checked the
  content but not the inode; `claimPidFile` unlinked a stale holder unconditionally; `forceRebuildSession`'s per-session
  unlink did not re-prove and now answers `busy` when the lease changed since its first read,
  `unreadable` when it cannot re-read it, and `undeletable` when the unlink itself fails;
  `unlinkIfNames`
  and `unlinkIfStill` compared `parseInt` values and now compare the exact string. Each is the
  re-prove the other sites already did.
- **An observed inode identity is a weak witness on Linux.** ext4 hands a freed inode number
  straight back to the next file created, so unlink-then-write can reproduce the identity the
  caller observed. The module keeps the check because a rename over an existing lease (how
  every replacement is published) does get a new inode; a hard-link claim after an unlink may
  get the freed one back, which is the reuse case above. `tests/wtft-270-lease.test.ts` U4
  builds its fixture by rename.
- **`forceRebuildSession` keeps three raw lease reads.** Its `unreadable` outcome tells ENOENT
  from any other read error, and `leaseHolder` folds both into `""`. *Road not taken:* a
  `leaseHolder` that throws on a non-ENOENT error, which would have changed every other caller.
- **`--watch`'s incremental read goes through `parseTagLine`.** The reconcile found it still
  splitting lines and testing `obj._hb` itself, a kind decision the map had not
  counted; it now takes `turn` records only, as before, and leaves generation handling to the
  `appendedGeneration` reseed.
- **Reconcile leftovers are filed, not fixed here.** The tag-reader auditor's findings about
  the writer side of `docs/wtft-tag-format.md` and the daemon-lifecycle entries of
  `CONTEXT.md`, and the daemon auditor's findings on `docs/spec-259-*.md` and the manifest,
  describe code S3–S5 will move; they are on #261, the standing daemon-doc leads issue, so the
  freeze holds.

- **§1d and §1g map by record kind, not by field.** The ledger's fields are
  `docs/spec-116-spawn-ledger.md`'s contract and get one home; the `Slot`'s fields are
  replaced whole by S3, whose state value's fields become its interface, so a field table now
  would be deleted by the slice that needs it. *Road not taken:* the field-by-field table the
  issue asked for, which the review lens counted as missing.
- **A per-session start exits 1 on a lease it cannot read.** `claimLease` folds every read
  error into "no holder", which is right for a claim but turned EACCES or EIO on the lease into
  a silent exit 0 that looked like a live holder. `main` now reads the lease raw once before
  claiming and rethrows any error but ENOENT, as the old claim loop did. The guard is one read:
  an error that begins after it still folds to busy. Under `wtft` the daemon's stderr is
  discarded by the detached spawn, so the CLI sees only that no daemon came up.
- **The rebuild decision comes from the holder the claim judged stale.** A start read the
  lease once for the `rebuild` token and then let `claimLease` read it again to decide what to
  unlink, so a token written between the two reads was consumed without a rebuild. The caller's
  liveness predicate now records the holder it judged stale, and the daemon reads that after
  the claim (`displacedHolder` for the harness, `displaced` in per-session `main`); a lease
  that vanishes between the judgement and the link still counts as judged, so a rebuild may
  run once for nothing. The version takeover, which replaces rather than claims, replaces only
  the value it read and re-reads once on a miss. *Road not taken:* a richer `claimLease`
  return carrying the displaced value, which would have widened the interface for one caller.
- **`unlinkLeaseIf`'s check-then-act window stays.** A stat, a read and a second stat narrow
  it; only a rename-to-private-name-then-verify would close it, and that shape has its own
  failure (a lease that turns out not to be ours must be linked back, which can itself lose a
  race). Every one of the nine sites on `main` had the same window; it is #249's shape and is
  left to it.
- **The PR was opened with `pr-open --reviewed` after the review round limit.** Three rounds
  of the local lens: 18, 8 and 14 findings, every one fixed, declined or filed in the ledger
  with its reason. The third round's findings were on lines the second round's fixes wrote, or
  header comments the first round had not raised, and the memory rule for this loop is to stop
  at that point rather than raise the limit. The Draft is where Duppy reviews.
- **A line whose `f`, `cmd` or `tc` is not an array is no turn.** Macroscope found the id
  merge throwing on a duplicate `{"cmd":{}}` line, which reached it because the decoder took
  any truthy value as a list. The decoder now returns null for a wrong-shape list field, so the
  line reads as `unknown`, is never merged and never rendered, and the sweep state still counts
  it as data. *Road not taken:* coercing the field to `[]`, which would have priced a damaged
  line; `tests/wtft-114-generation-records.test.ts` R5 pins the skip. *Also not taken:* the
  error boundary Macroscope proposed in the picker, which would have left the report and the
  widget with the same abort.

---

## 5. Reconciliation table (S0–S2, 2026-09-25)

Five fresh-context auditors (test variant, picker, host-scoped, tag reader, daemon and lease) and
one re-audit of the edited passages. One row per artifact and claim class; the per-finding lists
are on the issues named.

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| `tests/wtft-270-*.test.ts` | check wording and fixture preconditions | the modules' behaviour (16 findings) | yes, the suites themselves | fixed here |
| `bin/wtft-daemon.ts` | `refusing to watch a tag cache file` | `CONTEXT.md` Tag file _Avoid_ | `tests/wtft-daemon.test.sh` matches the prefix only | fixed here: "tag file as a session" |
| `bin/wtft-daemon.ts` | `[wtft-log-parser]` stderr prefix, ~48 lines | `CONTEXT.md` _Avoid_ bare "log parser" | no | filed on #261 |
| `extensions/lib/wtft-daemon-lib.ts` | every reader decides a line's kind through `tagRecords` | `watchTagFile`'s incremental read tested `obj._hb` itself | `wtft-watch-*` suites, indirectly | fixed here: `parseTagLine` |
| `extensions/lib/wtft-daemon-lib.ts` | every lease read goes through `lease.ts` | raw `readFileSync` reads | no | two fixed here (`checkDaemonHealth`, `restartDaemon`); three kept in `forceRebuildSession`, one added (§4) |
| `docs/wtft-incremental-render-spec.md`, `docs/spec-47-*.md`, `docs/EXT_TOKEN_BUDGET.html` | the picker reimplements the id collapse by hand; `getSessionSummary` returns two fields; non-TTY auto-selects | `session-selector.ts` after S1 | `tests/wtft-270-session-summary-dedup.test.ts`, `wtft-tag-reader-collapse-guard` | fixed here |
| `CONTEXT.md` Session picker | cost column undefined | — | `tests/wtft-75-doc-claims.test.ts` pins the file | defined here |
| `CONTEXT.md` Tag file, Tags dir, Watch mode, status text | per source session; one tags dir per root; tails a session file; text rendered only inside `renderDaemonStatus` | `getTagPath`, `watchTagFile`, `renderDaemonStatus` | `wtft-75` pins the file | fixed here; Lease entry added |
| `CONTEXT.md` Daemon entry, glossary gaps | lifecycle and cadence claims; nine terms undefined | `bin/wtft-daemon.ts` | no | filed on #261 |
| `docs/wtft-tag-format.md` reader side | Claude Code only; re-parse fallback; `_meta` shapes absent; `required` fields; wrong-shape list fields; overhead line carries `sc`; readers skip every `_hb`; append-only; dedup is a subtraction; step 6 absent | `getTagPath`, `recordOf`, `classifiedToInteraction`, `serializeClassifiedWithOverheadSplit`, `deduplicateInteractions`, `sweepState` | `tests/wtft-tag-format.test.ts` (round trip), `tests/wtft-270-tag-log.test.ts` (kinds) | fixed here: §1, §2b, §2c, new §2f, §3, §4, §5, §6 |
| `docs/wtft-tag-format.md` writer side | heartbeat, stop, sweep, spawn and generation moments | `bin/wtft-daemon.ts` | no | filed on #261; S3 moved the sweep, spawn and generation writers into `session-tagger.ts` |
| `docs/spec-270-daemon-ownership.md` §1–§2 | writer moments and reader lists, ~50 cells | `bin/wtft-daemon.ts` on the branch | no | corrected here; header says which names are retired |
| `docs/spec-270-daemon-ownership.md` §3a, §3b | planned interfaces named as built | `tag-log.ts`, `lease.ts` exports | `tests/wtft-270-*` | rewritten here: built rows name the real exports, the rest are marked plan |
| `docs/spec-259-*.md` | argument errors, hand-off and takeover details, ~18 findings | `bin/wtft-daemon.ts` | `tests/wtft-259-*` partly | filed on #261 |
| `docs/manifests/wtft-cmd.json`, README | daemon flag descriptions (`--list`, `--cleanup`, `--restart`, `--stop`), hermetic shell suite, spawned-daemon liveness rule | `bin/wtft-daemon.ts` | `wtft-75` pins README flags, not these sentences | filed on #261 |
| `docs/manifests/wtft-cmd.json`, README, spec-89 | picker rows, keys, window semantics, ~30 findings | `session-selector.ts` | no | filed on #173 |
| host-scoped: `~/.claude/CLAUDE.md`, `~/git-projects/CLAUDE.md`, `~/.claude/settings.json`, other clones' `CLAUDE.md`/`AGENTS.md` | none quote wtft's daemon or tag reader | — | — | checked, nothing to change |

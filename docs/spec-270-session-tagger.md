# Spec 270 S3 — SessionTagger

Issue: https://github.com/princess-pi/wtft/issues/270, slice S3 of
`docs/spec-270-daemon-ownership.md` §3b. Parent spec's rows for S3 are the commitment; this
document is the design and the closer. Vocabulary: the `codebase-design` skill's (module,
interface, seam, adapter, port) and `CONTEXT.md`.

## 1. What moves, and what the seam is

On `main` @ `bd97904` the tagging of one session lives in `bin/wtft-daemon.ts` as 24
module-level `let` bindings copied into and out of a `Slot` around every call, and the
functions `parseNewLines`, `flushPending`, `queueClaudeCommand`, `resumeClaudeLookups`,
`reseedClaudeChildren`, `parseAppendedBytes`, `skipAsFoldedElsewhere`,
`syncSubagentTranscript`, `foldedTranscriptChanged`, `scanForSubAgents` and
`invalidateStaleSweptMarker`. They read transcripts, read the clock, append to the tag file
and write to stderr from inside the same functions that decide what a tag line means.

**SessionTagger** (`extensions/lib/session-tagger.ts`) is those functions behind one seam.
The interface is a state value, a port, and three functions over them:

```ts
export interface TaggerState { … }           // one session's whole tagging state, a plain object
export interface World { … }                 // the port: every read of the filesystem and the clock
export function newTaggerState(sessionPath: string, now: number): TaggerState;
export function resumeTagger(state, tagContent: string, world): { complete: boolean; log: LogLine[] };
export function stepTagger(state, world, opts: { flush: boolean; sliceDeadline?: number })
  : { records: string; cut: boolean; wrote: boolean; activity: boolean; log: LogLine[] };
```

- **`records`** is the text to append to the tag file, in order, whole lines. The module never
  writes a file; the caller appends `records` after every call, including a cut one, so a
  reader sees the sum grow between slices as before.
- **`World`** is the one place the module touches the filesystem or the clock: `now()`, `stat`,
  `readRange`, `hashPrefix`, `hashBytes`, `exists`, `discoverTask`, `discoverClaude`,
  `attribute`, `lastCwd`, `stamp`, `spawnWindowClosesAt`, `tagRecords`, `projectDirs`. Each is
  a thin name over a function that already exists in `wtft-parser.ts` / `wtft-daemon-lib.ts`;
  the daemon's adapter is those functions, the test's adapter is the same functions over a
  sandbox corpus with a settable clock and every append captured.
- **`log`** replaces `process.stderr.write`: `{ level: "warn" | "debug", text }`. The caller
  prints warnings always and debug lines under `WTFT_DAEMON_DEBUG`, exactly as today.
- **`cut`** replaces the harness scan's `setImmediate` continuation: the module reports that its
  slice ran out; the caller schedules the next `stepTagger` with `flush: false`. The pass's
  read-set and failure flag live in `TaggerState`, not in side maps keyed by path, so a session
  move carries them without re-keying.
- **`flush`** replaces the `now - lastWriteMs >= POLL_MS` check: the caller owns the write
  cadence (heartbeats set `lastWriteMs` too) and tells the module whether pending turns may be
  written this step. Shutdown passes `flush: true`.

What stays in the daemon: the lease, the tag file's byte-level writer (`appendTagFile`,
`upsertHeartbeat`, `truncatePartialTail`, `fatalTagMutation`), `initClassified`'s
truncate-or-resume decision, the stop line, the idle clock and heartbeat cadence, session
existence and moves, the harness registry and slicing timers. `Slot` becomes
`{ state: TaggerState, tagPath, pidPath, displayed, rebuildTagOnStartup, lastWriteMs,
lastActivityMs, idleStartMs, startupTime, sessionExisted, checkedAtMs }` and `install`/`save`
are deleted: the daemon calls `stepTagger(slot.state, …)`.

## 2. Behaviour preserved, byte for byte where the golden can see it

S0's golden suite (`tests/wtft-270-golden-tags.test.ts`) must pass unchanged after the daemon
calls the module. Beyond it, `tests/wtft-270-session-tagger.test.ts` replays the same corpus
through `stepTagger` with the test adapter, no daemon process spawned, and asserts the records
equal the golden's normalised multiset and parsed view for every corpus session.

Two behaviours change on purpose, both recorded in §4 of the parent spec when they land:

- **One `now` per step.** `Date.now()` was read many times inside one poll; the module reads
  `world.now()` once per `stepTagger` and uses it for every settle check, window check and
  sweep stamp in that step. No golden line can see the difference (clocks are normalised).
- **Scan bookkeeping travels with the state.** `subagentScanPass`, `subagentScanPassFailed`,
  `reseedPending` and `subagentScansContinuing` were side maps keyed by session path and
  re-keyed by hand on a move; the first three become fields of `TaggerState`. The
  continuation marker stays with the harness (it is about scheduling), keyed as before.

## 3. Closer

- `tests/wtft-270-golden-tags.test.ts` passes unchanged.
- `tests/wtft-270-session-tagger.test.ts`:
  - **G** for every corpus session, the records `stepTagger` returns over the sandbox corpus,
    stepped until quiet, normalise to the committed golden multiset and view;
  - **P** `stepTagger` with `flush: false` returns no turn line and holds the pending turns;
    `flush: true` then returns them, followed by one offset marker;
  - **C** a `sliceDeadline` in the past cuts the scan after one transcript, returns `cut`, and
    the next step resumes after it (#257's growth case: a transcript that grew after the cut is
    read again before the pass stamps swept — closer for #257);
  - **M** a session move (state's `sessionPath` changed by the caller) reads a same-directory
    `claude -p` child again under a source that supersedes the old one, so the tag total equals
    a full parse (closer for #263);
  - **R** `resumeTagger` over the records an earlier state produced re-registers the
    `claude -p` children the settled lookups found and re-queues the open ones; a following step
    reads them (closer for #267 H); #267 A, B, C, D, E, G as step sequences;
  - **W** every `warn` line the daemon printed for a stat, read, parse or serialise failure is
    returned as a log line, once per transcript.
- `bin/wtft-daemon.ts` no longer defines `install`, `save`, `syncSubagentTranscript`,
  `scanForSubAgents` or `parseNewLines`; the module-level session bindings are gone.
- The full suite is green except the four #214 suites; the shell suite passes.

## 4. Roads not taken

- **A `step` over pre-read bytes** (`input: { session: { stat, bytes }, children: [...] }`,
  as §3a first sketched). `attributeClaudeSubAgentCosts` walks the tree it attributes as it
  goes, following what each turn's commands say, so the caller cannot know in advance which
  files to read. Pre-reading would have meant re-designing attribution first, which is its own
  slice. A port lets attribution stay as it is and still be substituted.
- **Keeping `Date.now()` inside the module.** One clock read per step is what makes the test
  adapter's clock meaningful and the spawn-window and settle cases replayable.
- **Moving `initClassified`, heartbeats and the stop line in too.** They are byte-level writes
  to the tag file, the writer half of TagLog, and belong with the daemon until the writer is
  its own module.

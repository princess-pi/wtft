# Spec 270 S3 — SessionTagger

Issue: https://github.com/princess-pi/wtft/issues/270, slice S3 of
`docs/spec-270-daemon-ownership.md` §3b. Parent spec's rows for S3 are the commitment; this
document is the design and the closer. Vocabulary: the `codebase-design` skill's (module,
interface, seam, adapter, port) and `CONTEXT.md`.

## 1. What moved, and what the seam is

On `main` @ `bd97904` the tagging of one session lived in `bin/wtft-daemon.ts` as 24
module-level `let` bindings copied into and out of a `Slot` around every call, and the
functions `parseNewLines`, `flushPending`, `queueClaudeCommand`, `resumeClaudeLookups`,
`reseedClaudeChildren`, `parseAppendedBytes`, `skipAsFoldedElsewhere`,
`syncSubagentTranscript`, `foldedTranscriptChanged`, `scanForSubAgents` and
`invalidateStaleSweptMarker`. They read transcripts, read the clock, appended to the tag file
and wrote to stderr from inside the same functions that decide what a tag line means.

**SessionTagger** (`extensions/lib/session-tagger.ts`) is those functions behind one seam.
The interface is a state value, a port, and functions over them that return tag records:

```ts
export interface TaggerState { sessionPath; tagPath; … }   // one session's whole tagging state, a plain object
export interface World { now(); stat; readRange; hashPrefix; hashBytes; exists; discoverTask;
  discoverClaude; attribute; lastCwd; stamp; spawnWindowClosesAt; readTag; projectDirs; projectsRoot }
export function fsWorld(now = Date.now): World;            // the daemon's adapter
export function newTaggerState(sessionPath, tagPath): TaggerState;
export function resumeTagger(state, tagContent, world): { complete; records; log };
export function stepTagger(state, world, { flush, sliceMs? })
  : { records; cut; wrote; activity; log };
// stepTagger's three parts, exported for the harness timers that run them apart:
export function readSession(state, world): { records; log; activity };
export function flushTurns(state): string;
export function scanChildren(state, world, { sliceMs? }): { records; cut; wrote; log };
```

- **`records`** is the text to append to the tag file, in order, whole lines. The module never
  writes a file; the caller appends `records` after every call, including a cut one and the
  resume, so a reader sees the sum grow between slices as before.
- **`World`** is the one place the module touches the filesystem or the clock. Each member is
  a thin name over a function that already exists in `wtft-parser.ts` / `wtft-daemon-lib.ts`;
  `fsWorld()` is the daemon's adapter, and the test's adapter is `fsWorld(clock)` over a
  sandbox corpus, with the clock the test advances.
- **`log`** replaces `process.stderr.write`: `{ level: "warn" | "debug", text }`. The daemon
  prints warnings always and debug lines under `WTFT_DAEMON_DEBUG`, exactly as before.
- **`cut`** replaces the harness scan's `setImmediate` continuation: the module reports that its
  slice ran out; the caller appends `records` and calls again. The pass's read-set and failure
  flag live in `TaggerState` (`scanPass`, `scanPassFailed`), not in side maps keyed by path, so
  a session move carries them without re-keying. The continuation marker stays with the
  harness, since it is about scheduling.
- **`flush`** replaces the `now - lastWriteMs >= POLL_MS` check: the daemon owns the write
  cadence (heartbeats set `lastWriteMs` too) and tells the module whether pending turns may be
  written this step. Shutdown passes `flush: true`.
- **`sliceMs`** is the harness's slice; the deadline is read from `world.now()` live, since it
  measures the scan's own duration. Everything else in a step uses the one `now` read at its
  start.

What stays in the daemon: the lease, the tag file's byte-level writer (`appendTagFile`,
`upsertHeartbeat`, `truncatePartialTail`, `fatalTagMutation`), `initClassified`'s
truncate-or-resume decision and the offset it seeds into `state.lastSize`, the stop line, the
idle clock and heartbeat cadence, session existence and moves (`state.sessionPath` is
re-pointed; `state.tagPath` is fixed for the session's life), the harness registry and slicing
timers. `Slot` is `{ state: TaggerState, pidPath, rebuildTagOnStartup, lastWriteMs,
lastActivityMs, startupTime, idleStartMs, sessionExisted, displayed, checkedAtMs }` and
`install`/`save` are gone: the daemon holds one current `Slot` and swaps the pointer.

## 2. Behaviour preserved, and what changed on purpose

S0's golden suite (`tests/wtft-270-golden-tags.test.ts`) passes unchanged with the daemon
calling the module. `tests/wtft-270-session-tagger.test.ts` part G replays the same corpus
through `stepTagger` with no daemon process and gets the golden's data lines.

Changed on purpose, each with its check in that suite:

- **One `now` per step.** `Date.now()` was read many times inside one poll; a step reads
  `world.now()` once and uses it for every settle check, window check and sweep stamp. The
  slice deadline is the one exception, above.
- **Scan bookkeeping and the warned-once sets travel with the state.** `subagentScanPass`,
  `subagentScanPassFailed`, `reseedPending` and the four `warned*` sets were side maps keyed
  by session path, re-keyed by hand on a move. They are fields of `TaggerState`.
- **A sliced pass reads a transcript again when it grew after the pass took it** (#257,
  part C). When a continued pass reaches its end, every transcript an earlier slice read is
  stat'd once; one whose size, mtime or inode moved is due again and the pass stays open.
  Swept is stamped only after that read.
- **A child transcript keeps one source for the life of its state** (#263, part M). The
  source is decided at the child's first read and carried across a move of the session and
  the child's own rotations, so a later generation of it retires its earlier lines. On resume,
  a `_gen` record's source is matched against the path relative to the session's directory or
  to the child's own, and the recovered source seeds the child's state, so the resumed read
  opens its generation under the source the earlier lines carry.
- **A registered `claude -p` child that is gone from disk is gone, not a failed read** (#267
  G, part R). The scan skips it, the release writes the turn it held under the source its
  earlier lines carry, and the tag can be stamped swept. Before, its stat failed every poll,
  which withheld the sweep for the session's life; `docs/spec-259-daemon-correctness.md`
  § Swept said the opposite, and no suite had checked it.
- **The swept-marker retraction reads the session's fixed tag path.** It read
  `getCurrentVersionTagPath(sessionPath)`, which names a different file once the session has
  moved. No suite reaches the difference; it is noted for honesty.

## 3. Closer

- `tests/wtft-270-golden-tags.test.ts` passes unchanged.
- `tests/wtft-270-session-tagger.test.ts`, no daemon process spawned:
  - **G** for every corpus session, the records `stepTagger` returns over the sandbox corpus,
    stepped until quiet, normalise to the committed golden's data lines and view;
  - **P** `flush: false` returns no turn line and no offset marker and holds the turns;
    `flush: true` then returns them followed by one offset marker;
  - **C** with a zero slice the first step reads one transcript and reports `cut`; a transcript
    that grows after the pass took it is read again before the step that ends the pass, and
    the tag is not stamped swept until then (#257);
  - **M** a same-directory `claude -p` child is registered again by a resume under the moved
    session, its later turns are read, its new generation carries the source of its earlier
    lines, and the tag total equals a full parse; a child rotated after the move likewise
    (#263);
  - **R** #267 as step sequences: **H** the children a settled lookup found are read after a
    restart, and a child discovery also finds is left to discovery; **A** the resume leaves a
    folded `claude -p` transcript to the one folding it; **B, G** a deleted or moved
    `claude -p` child's held turn is written under the source its earlier lines carry and the
    tag is stamped swept; **C** the generation record precedes that turn when the transcript
    opened none; **D** a held turn is pruned when its transcript was read again under the same
    source in the same scan; **E** a later line of one message merges its `claude -p` commands
    into the open lookup and the merged lookup finds the child;
  - **W** an unreadable session transcript and an unreadable child each come back as one
    `warn` line, once, and the failure clears when the read succeeds.
- `bin/wtft-daemon.ts` no longer defines `install`, `save`, `syncSubagentTranscript`,
  `scanForSubAgents` or `parseNewLines`; the module-level session bindings are gone. The
  source-scan suites that read those functions read the module instead: `wtft-130` A0–A6,
  `wtft-270-single-subagent-reader`, `wtft-420-subagent-call-site`.
- The full suite is green except the four #214 suites; the shell suite passes.

Not closed here, still on #267: **F** (the scan-continuation marker re-keyed on a move, a
harness registry concern, S4) and **I**, **J** (the sweep and the watch, daemon-level).

## 4. Roads not taken, and decisions made while building

- **A `step` over pre-read bytes** (`input: { session: { stat, bytes }, children: [...] }`,
  as §3a first sketched). `attributeClaudeSubAgentCosts` walks the tree it attributes as it
  goes, following what each turn's commands say, so the caller cannot know in advance which
  files to read. Pre-reading would have meant re-designing attribution first, which is its own
  slice. A port lets attribution stay as it is and still be substituted.
- **One `step` only, with the parts private.** The harness runs the flush and the child scan
  on their own timers, apart from the session read, so the three parts are exported and
  `stepTagger` composes them. One adapter of `stepTagger` (the test) and one of the parts (the
  daemon) is still one seam: they share `TaggerState` and `World`.
- **Keeping `Date.now()` inside the module.** One clock read per step is what makes the test
  adapter's clock meaningful and the spawn-window and settle cases replayable.
- **Moving `initClassified`, heartbeats and the stop line in too.** They are byte-level writes
  to the tag file, the writer half of TagLog, and belong with the daemon until the writer is
  its own module.
- **Excluding heartbeats from the tagger compare.** Part G compares data lines; `_hb` records
  are the daemon's cadence, which the module does not produce.
- **A full new pass when a transcript grew after a cut** (#257). Re-reading only the grown
  transcripts costs one stat per transcript the pass read, once, at its end; a full pass would
  read everything again on every growth in a busy harness.
- **Retiring the old source with a `_gen` and re-reading the child under the new one** (#263).
  Carrying the source costs nothing per poll and keeps one generation chain per child; the
  retire-and-rewrite road re-reads every same-directory child on every move.
- **The resumed read of a re-registered child opens a new generation.** It could instead
  resume at the child's saved offset if the tag carried one per child; it does not, and the
  re-read is what `docs/spec-259-daemon-correctness.md` § Resume already promises.
- **Review rounds on this branch** are logged in `docs/spec-270-daemon-ownership.md` §4 with
  the S0–S2 rounds.

# WTFT `--watch` Live Render + Log Parser Daemon Health Monitoring + SURGE Timeline

**Status:** Code and Spec Approved — updated 2026-08-01 with #124 additions

## Goal

Provide a live-updating cost chart in wtft `--watch` mode, backed by a persistent log parser daemon that pre-classifies session entries into a harness-agnostic tag file. The TUI watches the tag file via inotify (`fs.watch`) for zero-latency updates, and monitors the daemon's health with a colored status indicator on the title line. All render paths (Pi widget, CLI non-watch, CLI `--watch`) share a single SURGE timeline rendering inside `buildWtftLines`.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  wtft-daemon — one process per harness root, woken by   │
│  fs.watch. Flushes for one session are ≥667ms apart.    │
│  A session outside the roots keeps its own 667ms poll.  │
│  Tag format includes message.id for cross-run dedup.    │
│  Heartbeats: one _hb line, in place. Harness mode       │
│  writes it only for a session a consumer is displaying. │
│  A failed tag write exits the process. A bad session    │
│  line is skipped. Other poll errors log in debug mode.  │
│  Idle 24h drops that session. A --session process exits.│
│  A harness process stays up. Grace: 60s after startup.  │
│  Costs rounded to 6 decimal places before JSON write    │
│  (eliminates float drift vs in-memory widget).          │
│  Version-aware singleton: detects old tag file, kills    │
│  old daemon, auto-upgrades — no manual restart needed.  │
└────────────┬────────────────────────────────────────────┘
             │  tag file (fs.watch / inotify)
             ▼
┌─────────────────────────────────────────────────────────┐
│  wtft --watch (TUI consumer)                             │
│  Reads initial classified entries from tag file, then   │
│  watches for changes via fs.watch. Collapses lines      │
│  sharing a message.id to one interaction at max cost    │
│  (#270 review) — on the initial read AND on every       │
│  incremental append. Renders full chart                 │
│  on every new data event + per-minute timeline refresh. │
│  Monitors daemon health via PID file + _hb heartbeat.   │
│  'r' key restarts the daemon (5s fast-poll after).      │
└─────────────────────────────────────────────────────────┘
```

**Why daemon + fs.watch, not polling:**
- Polling directly on session.jsonl required re-parsing classified data on every tick
- The daemon does the expensive classification once, consumers read pre-computed entries
- `fs.watch` on the tag file gives zero-latency updates vs. 667ms poll worst-case
- Same classified tag file format works across Pi (in-memory) and CLI (daemon-backed)

## Log Parser Daemon Lifecycle

| Event | Behavior |
|---|---|
| `session_start` (Pi) or `wtft` / `wtft --watch` invoked (CLI) | Starts the daemon if that session's pid lease is not already held. A session under a harness root attaches to that root's one process. |
| New session data arrives | Classifies and flushes that session's tag. Flushes for one session are at least 667ms apart. |
| No new data for 24h | That session is dropped ("idle timeout"). A `--session` process exits. A harness process stays up. It decides from in-memory timestamps on a timer and does not stat the file. A later write adopts the session again. |
| Daemon just spawned (< 60s) | Idle drop suppressed (startup grace period) |
| Session file deleted | A `--session` process exits ("session removed") unless the transcript moved. A harness process drops that session and stays up. |
| Session file not yet created | Waits, and writes a heartbeat when this process is the per-session daemon or the session is the one a consumer is displaying, so the widget can show "waiting for session .jsonl..." (#124). Past the wait cap, a `--session` process exits ("session never written") and a harness process drops the slot. |
| Press `r` in `--watch` | Kills stale daemon, spawns fresh, fast-polls health at 1s × 5 |
| **New activity after idle timeout** | Pi's `agent_end` handler calls `ensureParserRunning`, which checks daemon health via `checkDaemonHealth` and re-spawns if dead |

## Sub-Agent Transcript Read Path (#270 / #420 / #97)

Two kinds of sub-agent transcript exist. They are DISCOVERED differently and READ identically — which is the point, and was not true before #270:

| Kind | Discovery | Read | Per-file state |
|---|---|---|---|
| Task/agent/workflow sub-agents (#82) | `discoverSubagentSessionFiles(sessionPath)`, re-run every poll | `syncSubagentTranscript(file)` | `discoveredSubagentFiles: Map<transcriptPath, SubagentFileState>` (`bin/wtft-daemon.ts`, search `const discoveredSubagentFiles`) |
| `claude -p` bash sub-agents (#138) | `discoverClaudeSubAgentFilesForTurn(commands, ts, ownCwd)` — one `discoverClaudeSubAgentSessionFiles(cwd, ts)` per spawning segment, with the session's own cwd standing in for a spawn that no `cd` precedes and whose own segment runs `claude` itself, never for a launcher that only names it in a flag (#107) — re-run every poll; once a file matches, until the bash turn's discovery window has closed. A turn that searched and found nothing, and one with nothing to search, both wait out the window and are then dropped (#107). An unreadable directory stays pending. Each matched PATH is then kept | `syncSubagentTranscript(file)` — the same function | `discoveredClaudeFiles: Set<path>` for the registry, plus the same `discoveredSubagentFiles` entry as any other transcript |

### Where the transcripts are on disk

- **Claude Code puts a Task subagent in `<session-dir>/<session-id>/subagents/`, never in the parent file.** `discoverSubagentSessionFiles` walks that directory and every directory under it (the `workflows/wf_<id>/` children are two levels down), except a symlinked directory and one named `wtft-tags`, and under it lists only files named `agent-*.jsonl`. So `agent-<id>.meta.json`, the sidecar #137 reads, is never mistaken for a transcript. The parent transcript holds no sidechain record at all: 0 `"isSidechain":true` lines in a 478-record session with two subagents, measured on Claude Code 2.1.281 on 2026-09-23. So a collector that stops at `projects/*/*.jsonl` misses all subagent spend, and still reports a plausible number.
- **Pi puts a subagent beside its parent**, as a sibling `.jsonl` whose first line is a `session` header naming the parent in `parentSession`. The same function lists those siblings, one level only: the parent's own first line must be a `session` header too, and a grandchild is not found.
- **Session discovery skips a directory named `subagents` below a project directory in both harnesses** (`SKIP_DIRS` in `extensions/lib/harness/claude-code/discovery.ts` and `extensions/lib/harness/pi/discovery.ts`). So a Claude Code subagent transcript is never listed as a session of its own. A Pi subagent is a sibling file, not in such a directory, so Pi session discovery does list it as a session of its own.
- **A `claude -p` child is a session of its own**, filed under the slug of the directory it ran in. That is why it is found by cwd and time window rather than by path.

`tests/wtft-15-read-path-doc-claims.test.ts` quotes five sentences from this section and the two sections on `attributeClaudeSubAgentCosts` and `deduplicateInteractions` below, and drives the code each one describes: the Claude Code layout, the `subagents` skip, the per-call rule and the order trap.

**Discovery is one-shot; reading is not.** A matched transcript stays matched — that match cannot un-happen — so `discoveredClaudeFiles` records each path, and discovery for that bash command stops once its window has closed (`docs/spec-114-14-generation-records.md`). Reading that path then happens on every poll, through the same `syncSubagentTranscript` the Task/agent path uses. Each poll stats the file. The only bytes read are those past `SubagentFileState.lastSize`; `parseAppendedBytes` parses the complete lines in that slice and holds a trailing fragment that has no newline yet. Lines from that slice are appended. A rotation — a new inode, a shrink, a same-size content-hash mismatch, a prefix-hash mismatch when the file grew, an attributed cost that dropped, or a lower cost on a plain message id already tagged — resets the offset to 0 and appends the replacement behind a `_gen` record that supersedes what came before. While the read is still inside the settle window and the size is unchanged, and again when mtime moves and the size does not, the whole file is hashed. Growth hashes the bytes already consumed.

Conflating those two — treating "we have matched this file" as "we have finished reading this file" — is precisely #270's bug, and it survived on the `claude -p` path through several rounds of fixing it on the Task/agent path. That is why there is now ONE reader rather than two paths with two different correctness properties: a second reader is a second place for the same bug to live, and the earlier attempt to manage it (an ungated stderr warning announcing that this path silently undercounts) was a note about the defect rather than a fix for it. `writeSessionToTagFile` is retired with it — it was a strict subset of `syncSubagentTranscript` (parse, dedupe, serialize, append) with no change detection, no append filter, and a bare `catch`.

**Parent and sub-agent are both incremental.** The parent `session.jsonl` is one file the daemon owns and only ever appends to; `parseNewLines` (`bin/wtft-daemon.ts`, `parseNewLines`) tracks a byte offset (`lastSize`) and reads only the delta each poll, threading parse state forward. A sub-agent transcript is a file the daemon does not own. It keeps its own offset on `SubagentFileState`, because a fresh process must not resume a sub-agent from the parent's `_meta` offset. An earlier byte-offset reader was built for that file and reverted: every invariant `deduplicateInteractions` and `attributeClaudeSubAgentCosts` provide is scoped to the array one call is handed, and a poll slice is a smaller array than the turns those two have to see together. Three review rounds found the same shape of defect:

- `deduplicateInteractions` (`extensions/lib/wtft-parser.ts`) collapses lines sharing one `message.id`, keeping the max-cost copy. This is the common case, not an edge case — measured across twelve live transcripts, 39–76% of message ids carrying `usage` are re-emitted with growing cost across several lines (`tests/wtft-270-subagent-crosspoll-dedup.test.ts`). Two emissions of the same id landing in *different* poll windows never meet inside one `deduplicateInteractions` call, and get summed instead of collapsed.
- `attributeClaudeSubAgentCosts` (`extensions/lib/wtft-parser.ts`) opens `const seenSessionIds = new Set<string>()` in its own body — scoped to the single call, not global (see below). Calling it once per poll batch — which that cut did, because each batch went through `parseSessionFile` — attributed the same nested `claude -p` grandchild session's cost twice, once from each batch that referenced it (`tests/wtft-270-subagent-nested-claude-attribution.test.ts`).
- A failed tag-file append had to rewind the read offset but could not un-mutate the stream state it had already advanced, silently losing compaction attribution.

**#97 keeps the offset, and does not hand either function a poll slice of the turns it has to see together.** `deduplicateInteractions` runs on the lines of one read. Two emissions of one `message.id` in that read collapse there. Two emissions that land in different polls become two tag lines, and `dedupeClassifiedById` keeps the max-cost copy on every read. Every fold-capable turn of one transcript is retained on `SubagentFileState.owners`, cloned from its pre-fold base. `attributeClaudeSubAgentCosts` runs on all of them in one call when a new one arrived, a folded transcript's stamp changed, the set of children another holder owns changed, a spawning window is open, or an owner has not been serialized yet. A nested session referenced from two polls is inside that one call. `fragment`, stream state, the running content hash, and `lastSize` are assigned only after `appendTagFile` returns. A failed append leaves the offset where it was. A transcript another synced transcript folds is not synced on its own, and if it was synced before that fold was seen, a generation record retires the lines it wrote (#107).

**The read.** `scanForSubAgents` calls `syncSubagentTranscript` for each known transcript. A quiet file costs one `stat`. Growth reads `size - lastSize` bytes from `lastSize` (`subagent delta N bytes` under `WTFT_DAEMON_DEBUG`). A held fragment is offered to the parser again on a quiet poll, so a writer that died without a newline can settle once that fragment parses as JSON. A transcript that has folded children also stats those files. While its spawning window is open, attribution re-runs on the retained owners; the transcript's own bytes are not read again unless they grew or the file rotated (`docs/spec-114-14-generation-records.md`).

**The same-tick window, and why the gate is not just `size`/`mtime`.** A transcript rewritten to exactly the same byte length inside ONE mtime tick (granularity is filesystem-dependent — nanoseconds on ext4/xfs/tmpfs, but 1s on ext3/HFS+ and some network mounts) leaves both `size` and `mtimeMs` unchanged, so a naive gate skips a real content change until some later write happens to move one of them. That is #270's own bug class — silently dropped growth — reappearing inside the fix for it, and two review rounds flagged it.

It is closed without hashing every file every poll, which is the cost the gate exists to avoid. A write can only hide inside the tick if it landed *after* our read and still stamped the mtime we already recorded; once the file has been quiet for longer than the coarsest plausible tick, no such write can exist, because any later write lands in a different tick and moves mtime. So `SubagentFileState` also carries `readAtMs`. While `Date.now() - readAtMs <= MTIME_SETTLE_MS` (2000ms — a full margin over the 1s worst case), and again when `mtimeMs` moves and `size` does not, the whole file is hashed and compared to the running hash of bytes already consumed. A mismatch opens a new generation and the next read starts at offset 0. Once settled, an unchanged size and mtime skips the hash.

That comparison uses **one clock, on purpose**. An earlier cut compared `readAtMs - mtimeMs`, subtracting a filesystem-reported mtime from the daemon's own `Date.now()` — two clocks, and the coarse-granularity case motivating the whole mechanism (a network mount) is exactly where they are also *skewed*. With a lagging server clock a just-written file computed as long-settled and was skipped on the next poll, silently reopening the gap. Elapsed time since our own read, measured only on our own clock, has no such failure mode. `readAtMs` is stamped only when bytes were read or a held fragment was parsed, never on a hash check that matched — otherwise the window restarts on every check and never settles. An actively-written transcript is therefore hashed for roughly three 667ms polls after its last write and then goes quiet; an idle one still costs one `stat` for itself and one per transcript its last attribution folded. A transcript whose turn spawns a `claude -p` is re-attributed every poll until that turn's discovery window closes, whenever its own last write was. Its bytes are read only when they grew or the file rotated. A matching hash appends nothing and does not move the offset. `tests/wtft-420-subagent-call-site.test.ts` allows `parseSessionFile`'s call and the daemon's call on every retained fold-capable turn, and fails when any other production call site appears.

**What the tag file may contain.** There is no per-line map of lines already written. Bytes before the offset are not read again, so an unchanged prefix is not re-appended — that is the bound that keeps a transcript's tag from growing with the square of its length (`tests/wtft-270-subagent-tagfile-growth.test.ts`). Usage growing on a re-emitted `message.id` in a later poll is a new serialized line, appended beside the earlier one. The reader, not the writer, collapses them: `dedupeClassifiedById` (`extensions/lib/wtft-daemon-lib.ts`, `dedupeClassifiedById`) does that on every read, taking max cost. A re-emitted id that already belongs to a fold-capable turn is not written as a plain line: its usage updates that turn and the command stays, so the folded cost is attributed onto the grown usage. A lower copy that omits the command is dropped. Two distinct interactions that serialize identically are both appended. Nothing hashes tag lines, so nothing can drop the second.

So: **a subagent's growing-usage message legitimately appears as multiple tag-file lines sharing one `message.id`, at different costs, written across different polls.** This is expected, not a defect. Every reader of a tag file that may hold sub-agent lines must collapse by `message.id` (max cost) before summing; `readClassifiedTagFile` (`extensions/lib/wtft-daemon-lib.ts`) runs `dedupeClassifiedById` on every read, and `--watch` does the same collapse on both its initial read and every incremental append (see the consumer diagram above).

**That is a strong default, not an enforcement** — an earlier draft of this paragraph said "so no caller can forget it," which this repo's own code contradicts (PR review). `getSessionSummary` in `extensions/lib/session-selector.ts` deliberately does not import `wtft-daemon-lib` (see that file's CONSTANTS comment) and reimplements the max-cost-by-id collapse by hand. Two independent implementations of one rule are kept in step only by `tests/wtft-270-session-summary-dedup.test.ts` asserting value-equivalence against the canonical path — there is no shared code path forcing it. **A new reader that bypasses `readClassifiedTagFile` and does not add a similar pinning test reintroduces the raw-sum overcount.** That used to be prose with nothing behind it, which is a wish rather than a rule — so the violation is now COUNTED. `tests/wtft-tag-reader-collapse-guard.test.ts` enumerates every source file that both resolves a tag path (`getTagPath` / `TAG_SUFFIX` / a literal `.wtft-tag.`) and parses JSON, and fails unless each one either routes through `readClassifiedTagFile` / `dedupeClassifiedById` or appears in an allowlist carrying its reason and its pinning test. The allowlist is checked for rot in the same run, so a stale exemption cannot quietly accumulate.

It earned its place on the first run by catching a live violation nobody had noticed: `extensions/token-budget.ts` read tag lines and summed per-model TOKENS within its 60s TPM window with no collapse (a separate 120s bound governs only whether a line is considered "recently active" at all — `lastActiveAge` tracking, not the sum), so a re-emitted message inflated the reported TPM. Filed as **#454** (princess-pi/wtft#17) rather than fixed blind — the other readers collapse by max COST, and picking a token-specific per-field reduction (max-per-field? the max-cost line's fields as a set? which line's timestamp when two lines straddle the 120s window?) looked like a separate product decision. It closed by **not inventing one**: `aggregateActiveTpm` and `getHostingSessionTpm` now call `readClassifiedTagFile` directly and sum `inputTokens`/`cacheReadTokens` off the returned `Interaction[]`, so whichever answer `dedupeClassifiedById` already gives for cost — max-cost line wins, that line's `in`/`cr`/timestamp travel with it as a set, ties and window-straddling included — is the answer #17 uses for tokens too. That is a real choice, not an absence of one; it is just the same choice every other reader already made, reused rather than re-derived. It no longer needs an allowlist entry.

Route new readers through `readClassifiedTagFile` unless there is a stated reason not to; if there is, pin the copy with a test the way #270 did, and add the allowlist entry so the exception is visible instead of merely absent.

**What bounds tag-file growth.** Nothing does, formally. `discoveredSubagentFiles` holds one `SubagentFileState` per sub-agent transcript ever discovered in the daemon's life, never evicted. Eviction was tried twice and reverted, because `discoverSubagentSessionFiles` re-lists every transcript on disk every poll, so a dropped entry comes back as fresh state at offset 0 and appends the whole transcript again. In practice growth is bounded by how many sub-agents one session spawns and how much each writes. A whole-file `parseSessionFile` of 175 real transcripts on this host (median 424KB, max 2.60MB) costs 1.88ms median / 3.76ms p90 / 21.89ms max per file, 390.4ms total. That is the shape of a read from offset 0 — the first poll, and any rotation. A later poll reads only the new bytes. Re-derive with `bun research/270-subagent-parse-bench.ts`. The daemon does not carry a second copy of these figures.

**The startup batch is reachable, and it is the bound that matters** (PR review). An earlier draft dismissed the all-at-once figure as "a worst case that cannot actually occur, since only changed files are re-read." That reasoning is wrong for exactly one poll: fresh state starts at `lastSize: 0`, `mtimeMs: -1` (`freshSubagentState`), so the first poll reads every discovered file from offset 0. "Only the new bytes are read" is true of every poll after that, and true of none of the first.

What is genuinely unreachable is the 175-file figure itself, for a different reason than the one given: a daemon watches ONE `sessionPath` and discovers only that session's own sub-agent transcripts (recursively), never the host-wide union. 175 is every daemon on this host at once, which no single process ever is. The bound that applies to a process is one parent's whole set: the costliest parent by time is **~60-95ms** (it moves with host load; re-runs here span that band), and the widest is **33 transcripts at ~20-26ms** — both against the same 667ms budget. The benchmark script reports these as `startupWorstFiles` / `startupWorstMs` / `slowestParentMs`, so the reachable case and the aggregate come from one run.

**Those two figures reconcile, and the reconciliation is the point** (PR review): 33 files at the 1.88ms population median would be ~62ms, about **2.4x** what the widest parent actually costs (~26ms, or ~0.80ms/file). It is cheaper because breadth and cost do not track — that parent's transcripts average **95KB**, against a 424KB population median. Note those are two different ratios and an earlier draft of this very paragraph conflated them: the size ratio is ~4.5x, the time ratio only ~2.4x, and the gap between them is the same lesson again — a small transcript still carries proportionally more interactions per byte, so cost follows interaction count rather than bytes. The parent that costs the most has 15 transcripts averaging 608KB. This is the same lesson the slowest-vs-largest pair above teaches: cost follows interaction count, not file count and not bytes, so neither "most files" nor "most bytes" is the worst case on its own. The conclusion is unchanged — the first poll costs about a tenth of one budget — but it now rests on a number that can actually occur (`research/270-subagent-parse-bench.ts`).

## Tag-File Staleness, and Why There Is No Version Bump (#270)

#270 asks for this half explicitly: *"the tag-file staleness needs its own answer — a fix that only corrects live behaviour leaves every already-written tag file wrong, including the ones a future audit will read."* Every tag file written before #270 holds a one-shot subagent parse, and the transcripts it undercounts are finished and will never grow again, so the live fix above cannot reach them.

**The answer is the next daemon start, and it needs no `WTFT_TAGGER_VERSION` bump — for Task/agent sub-agents.** A fresh daemon process starts with an empty `discoveredSubagentFiles`, so it has no memory of what any previous daemon wrote; `discoverSubagentSessionFiles(sessionPath)` re-lists that session's transcripts from disk on the first poll regardless of the parent's read offset, so it reads every one from offset 0 and appends every line it derives, including exact re-statements of lines already on disk. The tag file then holds both the stale low-cost line and the fresh full-cost line for the same `message.id`, and `dedupeClassifiedById` (`extensions/lib/wtft-daemon-lib.ts`) collapses that pair to the max on every read. **Convergence is a property of the reader's collapse, not of the writer having been careful** — which is also why re-appending is safe rather than merely tolerable.

**It does NOT reach already-finished `claude -p` sub-agent transcripts, and this is a real hole rather than a wording problem** (PR review). Those are discovered from the other direction: a bash turn in the PARENT transcript is matched to a transcript path, and `pendingClaudeCommands` is fed only from lines `parseNewLines` has just read (`bin/wtft-daemon.ts`, the `hasClaudeCommand(interaction)` push). On a restart where the tag file yields a `_meta` offset, `initClassified` resumes `lastSize` at that offset — end of file — so no parent line is re-read, no bash turn is re-matched, and `discoveredClaudeFiles` (empty at process start, and never seeded from disk) stays empty. Nothing re-lists `~/.claude/projects` looking for them, because a `claude -p` transcript lives in an arbitrary cwd's project directory with no structural link back to this session. So a `claude -p` sub-agent that finished under a pre-#270 daemon keeps its undercount across every subsequent restart. Filed as **#456**; the convergence claim above is scoped to the Task/agent path until it is closed.

Measured on #270's own specimen, session `7c0c2b7e` (15 Task subagents, finished 2026-08-13), restoring its genuine pre-#270 v2.7.1 tag (1,132,374 bytes) byte-identical before each trial and killing every daemon for that session first:

| | run 1 | run 2+ | `wtft -F` |
|---|---|---|---|
| opus-5 (parent) | $50.81 | $53.23 | $53.23 |
| sonnet-5 (subagents) | $28.81 | $31.23 | $31.23 |
| haiku-4-5 | $0.12 | $0.12 | $0.12 |
| **TOTAL** | **$79.74** | **$84.59** | **$84.59** |
| tag bytes | 1,132,374 | 1,537,246 | — |

All three model tiers are listed so the column reconciles: run 1 is `50.81 + 28.81 + 0.12 = 79.74` exactly. Run 2 sums to `$84.58` against a reported `$84.59` because TOTAL is computed from unrounded per-interaction costs while the per-model rows are each rounded to the cent first — a display artifact of the summary table, not a discrepancy between the two runs. Run 2 equals a forced full re-parse on every per-model line and in the total, and is stable across further reads.

`haiku-4-5` is unchanged across all three columns, which is the useful control: it is the only tier with no Task subagent traffic in this session, so #270's undercount cannot reach it, and it should not move. This is #270's verification bullet *"daemon-cached output equals `-F` output for a finished session, to the token"*, satisfied without `-F`.

**This behaviour is identical on `main` @ `5fd5570` and on the #270 branch, down to the repaired tag's byte count** — restart-repair is pre-existing, and #270's job was not to add it but to avoid breaking it. A new process keeps no offset, so its first read appends every derived line again. That re-append is the repair. It can fail in two directions — writing nothing new, or appending a second full copy the reader fails to collapse. #270 did the append through a per-line hash map; #97 does it by starting at offset 0. `tests/wtft-270-tagfile-staleness.test.ts` is the pin for both directions, and is deliberately a **contract** test (it passes on `main` by design) rather than a bug-fix regression test.

**Soundness condition for re-appending**: every COST-BEARING tag line must carry a `message.id`, because a line without one passes through `dedupeClassifiedById` uncollapsed (`extensions/lib/wtft-daemon-lib.ts`, the `if (!id)` branch) and would double-count on repair. `tests/wtft-270-tagfile-staleness.test.ts` asserts it on the specimen tag — 3,339 of 3,409 rows carried an id, and all 70 without one were zero-cost `_meta` rows, none duplicated.

**That assertion is a contract pin on one tag file, not a population-wide proof** (PR review), so the condition is also measured over every transcript on this host, both harnesses, by `research/270-subagent-parse-bench.ts`. Two results, and they say different things:

- Across all **175 sub-agent transcripts** (6,104 interactions) — the population this repair path actually re-appends — **zero** cost-bearing rows lack a `message.id`. The condition holds where it has to.
- Across **all 1,674 transcripts** (53,780 interactions), **22,318** cost-bearing rows lack one, worth $498.86.

The census is **partitioned by harness root and by role**, so the second line is a read fact rather than an inference (PR review — an earlier draft asserted "every one is a Pi parent transcript" off an unpartitioned total plus a 40-file sample, which could not support a universal claim):

| | transcripts | cost-bearing rows with no `message.id` |
|---|---|---|
| `~/.claude/projects` (Claude Code) | 1,537 | **0** ($0.00) |
| `~/.pi/agent/sessions` (Pi) | 137 | **22,318** ($498.86) |
| of which, in discovered SUB-AGENT transcripts | — | **0** |
| of which, in PARENT transcripts | — | **22,318** |

Claude Code stamps `message.id` on every cost-bearing row it has ever written here; Pi stamps it on none. The split is total, not statistical.

Those parent rows are not exposed, and for a reason worth stating rather than assuming: the parent path does not re-append. `initClassified` (`bin/wtft-daemon.ts`, `initClassified`) recovers `lastSize` from the `_meta` offset recorded in the tag file and RESUMES; when it cannot recover one it truncates the tag file before re-parsing from zero. Neither branch can lay a second copy of a parent row beside the first. Only the sub-agent path starts at offset 0 in a fresh process — which is not an oversight there, it is the repair mechanism itself.

So the zero above is a property of this host's traffic, not of the wire format: `discoverSubagentSessionFiles` already has a Pi `parentSession` branch, and the first Pi session that spawns a discoverable sub-agent would double-count ~100% of its cost-bearing rows on every daemon restart. **Filed as #453**, with the proposed shape (a deterministic synthetic ordinal id for id-less cost-bearing rows, which closes the collapse without collapsing two distinct interactions that serialize identically). It is a tag-file wire-format change, which is why it is not folded in here.

**Why not a version bump.** A `WTFT_TAGGER_VERSION` bump is the remedy #270 lists first, and it is the wrong tool here. It orphans every existing tag file and forces a from-zero re-parse of every session's parent transcript as well as its subagents, and it leaves both the old and new tag files on disk; the in-place repair reaches the identical number incrementally, reusing everything already classified. A bump earns its cost when old tags are *unreadable or mispriced* — the 2.6.0/2.6.1/2.7.0/2.7.1 entries above are all of that kind, where no amount of appending can correct what is already written. #270's staleness is the other kind: the old lines are correct as far as they go, and the missing ones can simply be added.

**Residual, filed as #443**: the FIRST read after a stale tag still reports the pre-repair number. `bin/wtft.ts`'s non-watch path resolves the tag path, spawns the daemon, and reads the tag immediately, so the read races the repair and loses; `awaitDaemonUp` is entered only when the tag yields nothing AND the session file is absent, and a populated-but-stale tag satisfies neither. Pre-existing on `main`, unchanged by #270, and a genuine trap for one-shot audits (#176) — hence its own issue rather than a note here.

## Provisional Reads: Saying So When run 1 Is Not run 2 (#443)

The table above documents the repair. What it does not, on its own, tell the person
reading it is that **run 1 and run 2 are indistinguishable at the point of reading**.
`$79.74` printed exactly like `$84.59` — same table, same formatting, no warning —
so a one-shot audit took the 5.7% undercount and had no signal that it had.

That is #443, and it is a reader-side problem, not a writer-side one. The repair
above is correct and already happens; the gap is that `bin/wtft.ts` spawns the
daemon and reads the tag on the next statement, so the read races the daemon it
started and loses. `awaitDaemonUp` sits on that path but is entered only when
`interactions.length === 0`, and a populated-but-stale tag satisfies neither
condition, so nothing waits.

**The remedy is to say so, not to wait.** Blocking a one-shot CLI on a repair whose
length is proportional to the session's subagent volume is exactly the cost that
read-then-render exists to avoid.

### `_meta.swept`

The daemon appends `{"_meta":{"swept":<epochMs>}}` once, after its first
`scanForSubAgents()` completes. Its **absence** is the honest statement that no
subagent transcript has been read by any daemon since this tag was written — which
is precisely the state run 1 above is in.

**The marker is POSITIONAL, not merely present**, and it is re-stamped rather than
written once. This is the correction that matters, and it came from review after the
first version shipped one-shot.

The one-shot version kept `sweptAtMs` in the daemon **process** while the marker
persists in the **file** — and `flushPending()` runs *before* `scanForSubAgents()` in
the same poll. So a new parent turn, including one that spawns a new subagent, is
appended after a marker left by an earlier sweep or an earlier daemon. A reader that
accepts "a marker exists" then reports SETTLED for data no sweep has covered: #443's own
undercount, through a narrower window. Relocating a bug is not fixing it.

So the contract is: **the marker must be the last significant record in the tag.** The
reader scans backward and stops at the first significant line — a `_meta.swept` settles
the tag, a *classified* line invalidates any marker behind it. Heartbeats and
`_meta.offset` lines carry no cost and are skipped, so an idle session does not drift
back to provisional while nothing is happening.

The daemon therefore re-stamps whenever the tag grew since the last stamp: on a busy
session once per poll that wrote anything (~35 bytes beside the classified lines that
poll already wrote), and not at all on an idle or finished one. `tagGrewSinceMarker`
starts **true**, so a daemon inheriting another daemon's tag re-stamps after its own
first sweep rather than trusting a marker whose coverage it cannot verify.

It cannot ride the existing `_meta.offset` line: that line is written only by
`flushPending()`, which runs only when new PARENT interactions arrive, so on a finished
session — this issue's own case — it never runs again.

**Withheld on a failed poll.** `pollHadFailure` is set by every failure handler —
`syncSubagentTranscript`'s stat/parse/serialize/write, and `flushPending`'s own write —
so a poll that could not write what it was asked to does not claim to have swept: the tag
stays provisional and the next poll retries.

It is reset by the **poll loop**, not on entry to `scanForSubAgents`. Resetting it inside
the sweep was the obvious placement and was wrong: `flushPending()` runs *before* that
function in the same poll, so the reset wiped the flush's own failure a few statements
after it was set, and the marker could stamp the tag settled over a lost parent batch. It
is per *poll* rather than per daemon because a transcript that failed last poll and
succeeds this one must not keep the tag provisional forever — the `warned*` Sets are
cumulative by design and cannot answer "was **this** poll clean".

**`flushPending` no longer clears `pendingItems` before writing.** It did, on `main` and
in this branch's first draft, which lost a whole billed batch permanently whenever the
append threw — the items were gone before anything could fail. That loss predates #443,
but the marker made it worse rather than merely inheriting it: a sweep could stamp over
the gap, turning a silent undercount into an affirmative *settled*. The batch is now kept
for the next poll unless it actually reached disk, and `tagGrewSinceMarker` is set the
moment the classified lines land rather than after the `_meta.offset` line — a failure
*between* the two otherwise left the tag grown and the flag false, so the next sweep
skipped the re-stamp.

**Append failure is terminal, not a retry protocol.** A tag is a transient derived cache,
and re-deriving it from the available harness-specific session logs is assumed cheap in
both time and compute. No tag byte is durable state.

Every tag append therefore uses one fatal helper. If an append throws, that append may
already have left a partial fragment, but the failing process performs no further cleanup
mutation of the shared tag: a successor may already own and be writing it. Instead it
atomically replaces the existing singleton PID lease in the system temporary directory
with the token `rebuild`, then exits immediately. The token invalidates any live successor
at the lease check that begins its next poll. The next daemon invocation claims that token,
clears the disposable tag as its new singleton owner, and follows the ordinary full-source
parse path. Lease publication itself uses an exclusive hard link to a fully written inode,
so another starter cannot mistake a not-yet-populated PID file for a failed owner.

This is fail-and-rederive, not durable transaction machinery. There is no append retry,
rewind, prefix preservation, tag-format error row, or continued polling after a write whose
extent is unknown. The lease is the existing producer-coordination seam, not a renderer
protocol; renderers still know only the harness-agnostic tag. If even the small atomic lease
replacement fails, automatic replay cannot be recorded: the daemon still exits nonzero and
writes a synchronous best-effort diagnostic requiring `wtft -F` after storage is restored.
An ordinary stale numeric PID deliberately retains #124 incremental resume, because process
death alone is not evidence of tag corruption. This relaxed contract supersedes #437's
exact-rewind requirement and #512's retry-after-fragment requirement.

A session with **no subagents** still gets the marker. "Nothing to sweep" and "swept"
are the same state to a reader, and withholding it would strand every subagent-free
session as permanently provisional — which trains the reader to ignore the flag.

The marker is a zero-cost `_meta` row carrying no `message.id`, so it is consistent
with the soundness condition above rather than an exception to it.

**What `swept` does NOT assert.** It says a sweep RAN AND REPORTED NO FAILURES, which
is weaker than "no failures occurred". #457 is closed — an unreadable subagent transcript fails in `syncSubagentTranscript`'s
stat, read, or attribution handler, which sets `pollHadFailure`, and is never mistaken
for an empty one — which strengthened this marker for free, exactly as the pre-fix note
here predicted. That holds for the nested attribution read too: `attributeClaudeSubAgentCosts`
no longer swallows an unreadable nested transcript into a silent zero — the throw
propagates to the same handler, so the SUBAGENT transcript's rows are not written that
poll and the sweep is withheld while any part of the read it depends on is unreadable.
(The MAIN parent's rows are unaffected: `flushPending()` runs before `scanForSubAgents()`
in the same poll, and the subagent reader never parses the parent session.) There is no silent
discovery boundary left (round 5): `discoverClaudeSubAgentSessionFiles` reads the
first ten lines of each candidate for its head scan, warns once per unreadable file per process,
and REPORTS the failure in its result instead of throwing — an unreadable candidate at
discovery still withholds the marker and is retried next poll, never dropped from the
attribution silently, but the readable in-window matches sharing that project dir are
returned alongside the report instead of being discarded with it. `~/.claude/projects/<slug>/`
is shared across many sessions, so an unreadable candidate is usually a DIFFERENT
session's transcript; the old throw stalled every pending claude -p command sharing the
cwd — their costs permanently missing while the unreadable file stayed, every poll
re-reading everything. The daemon registers the readable matches (their costs land) and
still withholds the swept marker for the command whose window held the unreadable
candidate, because that candidate's timestamp window was never checkable — it might BE
that command's transcript. The attribution pass (`attributeClaudeSubAgentCosts`) keeps
the throw: there, the parent turn is this transcript's own command, so its cost must
land or the report is silently incomplete. The Pi-pattern sibling files follow the same
warn-and-report rule (round 6): a per-file read failure warns once per file per process
and REPORTS in the result, with the readable siblings returned alongside it — the same
partial-progress shape, applied to this half of discovery after the round-5 throw
proved to starve the whole subtree over one unreadable file. A sibling whose header
cannot even PARSE (empty file, partial crash header, a non-transcript `.jsonl`) is
skipped silently, same rule as the claude half's per-line JSON swallow: it can never
declare `parentSession`, so it can never contribute cost — warning there would hold the
marker forever over nothing. The dir-level skips went the same way — an unreadable
subagents directory (`walkSubagentDir`, top-level OR nested: the recursion sits outside
the per-entry stat catch since round 5), an unreadable `~/.claude/projects/<slug>/`
(its existence gate was `existsSync` until round 6, which read a stat error — EACCES on
an ancestor, ENOTDIR, ELOOP — as "absent" and stamped the marker over the missing
subtree; the gate is now `statSync`, ENOENT absent, every other error a dir-level
throw), and an unreadable Pi sibling sessionDir warn once per dir per process and
throw; the daemon routes those into `pollHadFailure`, the TUI/CLI degrade to the
warning. `walkSubagentDir`'s stat failure carves out ENOENT (deleted between readdir
and stat) and ELOOP, which hold no cost to miss and stay silent; every other stat error
warns once per file per process. Both discovery halves skip an entry whose read reports
EISDIR the same way — a directory, or a symlink to one, named `*.jsonl` holds no cost. Which read
failures reach the nested read, honestly: (1) the transient discovery→parse race (a
file that vanished, or became unreadable, between the two reads); (2) a statically
unreadable Task/agent transcript — `walkSubagentDir` discovers by name and stat only,
never a content read, so an EACCES file is listed and fails at the nested read; (3) a
registered claude -p transcript re-read every poll for the daemon's life whose
unreadability was acquired after its one-time registration. Cases 1 and 2 retry next
poll — the session id is not marked seen and the daemon's change detector was never
advanced — and make the parent parse throw every poll until readability returns. Case 3
has the same retry shape ONLY when the failure reaches the read: its chmod-only variant
throws ZERO polls, because the sync loop's stat gate skips any registered file whose
size/mtime are unchanged and already settled, and chmod touches ctime, not size/mtime —
the registration read already synced that file in full, so no cost is missing and the
marker stamps correctly. The cost is recovered the poll the file is readable again.

Two cases have no recovery, honestly, and both end the same way — the marker never
stamps again for the daemon's life. (a) The vanished REGISTERED claude -p transcript:
registration is one-shot and never evicted, so a deleted registered file fails its
statSync every poll. (b) A discovery candidate that STAYS unreadable (a permission
change never undone, an unmounted dir): the failure is reported in every discovery
result, so every pending claude -p command sharing that project dir retries forever.
Both are fail-safe (never claim swept while the transcript's cost is missing) but
unending; eviction on ENOENT is deliberately not taken, because an evicted transcript
that returns would never be re-registered (#270's bug class). Round 5 softened the
LOSS, not the verdict: in case (b) the readable in-window candidates sharing that dir
ARE still registered and counted (the unreadable file is usually a different session's
transcript), but the marker still withholds, because the candidate's timestamp window
was never checkable. Case (b) recovers automatically when readability returns — the
candidate is re-read at each retry; case (a) recovers only if the file itself returns.

One limit on the "tag stays provisional" claim: `readTagProvisional` is purely
positional over the tag file and cannot see `pollHadFailure`. `pollHadFailure` only
withholds FUTURE stamps; a marker stamped BEFORE the failure began is not retracted, so
while the parent stays quiet the tag still reads settled with the unreadable
transcript's cost missing. The remaining gap is only the ordinary one: a failure
occurring between the last poll and the marker stamp is still not reflected in it.

### `readTagProvisional`, and what the CLI does with it

`readTagProvisional` (`extensions/lib/wtft-daemon-lib.ts`) returns
`{ provisional, reason }` for two conditions, any sufficient. A third reason,
`subagent-unreadable`, is never returned by it — it is assigned by the CLI's
own render-side degrade (round 7, PR review): the table lists it because the
CLI consumes it, but a reader tracking the code should not look for it at the
`readTagProvisional` layer.

| reason | returned by `readTagProvisional`? | condition |
|---|---|---|
| `stale-version` | yes | the resolved tag is not at `WTFT_TAGGER_VERSION` — `getTagPath` rule 3 falls back to "any-version tag, newest mtime" (#95), so a read can land on superseded semantics while the daemon builds a current-version tag beside it |
| `unswept` | yes | a current-version tag holding classified data but no `_meta.swept` |
| `subagent-unreadable` | no — CLI-assigned | the CLI's own render-side degrade: a subagent transcript could not be read (one file, or a whole directory of them), so the `--tokens` table is missing a subtree's uncounted billables even though the tag still reads settled (#457). Assigned unconditionally on the CLI's own discovery failure — direct evidence that outranks any tag-derived reason, since a permanent unreadability also blocks the daemon's rebuild (round 7) |

**There is no scan window.** The first version scanned only the last 8KB, justified as
"matching `readLastMetaOffset`" — a justification that does not survive contact, since
that function windows because it does a *partial* read and never loads the file, while
this one has already read the whole tag to answer the has-classified-data question.
Windowing already-in-memory content bought no I/O and cost a real failure mode: on a
busy session the marker is buried within minutes and the read would go
false-provisional forever. The scan is the whole file, kept cheap by rejecting any line
without `"_meta"` in it before `JSON.parse`.

A tag holding no classified data is NOT provisional — it yields no total, so there is
nothing to qualify. An unreadable tag reads the same way, for the same reason.

**The verdict comes from the SAME READ as the interactions** (PR review, twice). Both are
derived from one `readFileSync` by `readTagFileWithVerdict`, and the result is carried to
the exit. Two separate corrections landed here, and the second is the one worth
remembering: it is not enough to call the two functions adjacently, because each opened
the file itself — the daemon is a separate OS process appending to that same file, so it
can land the repaired lines *and* the marker in the gap between two adjacent reads, after
which the interactions are stale and the verdict says settled. The same silent undercount,
through a narrower window, is still the bug. Reading the tag a second time at the end of `main` would
straddle everything in between — building the output lines, printing the chart, and under
`--tokens` scanning uncounted billables across the session and every subagent transcript
— which is wall-clock comparable to a daemon poll (~667ms). A sweep landing in that window
would report SETTLED for totals rendered from the pre-sweep read: #443's own failure mode,
wearing a false exit 0.

`bin/wtft.ts` prints the total **in full**, then a warning line, then exits **9**.
Withholding the number would be worse than the undercount: it is usually close and
always better than nothing. The exit code and the prose line address two different
readers, and 9 is distinct from 1 because "the run failed" and "the run succeeded but
the number is not final" are different facts.

The same exit is earned by a render-side degrade with the same shape (#457, round 5):
under `--tokens`, an unreadable subagent transcript — one file (round 6: the failure
is reported, not thrown, and the readable siblings still scan) or a whole unreadable
directory of them — drops uncounted billables from the token table. The parser's
warning is one-shot and
latched; a machine reader must not see a complete-looking report, so the CLI sets
`provisional = { provisional: true, reason: "subagent-unreadable" }` and exits 9 with
the reason named in the warning line — assigned unconditionally on the CLI's own
discovery failure, whatever the tag verdict (round 7): the failure is direct
evidence, and a permanent unreadability also blocks the daemon's rebuild, so the
tag-derived reasons cannot be trusted to point at an action that ends the loop.
The TUI's degrade (main-interactions-only) has no exit surface — its reader is the
interactive widget, and the widget appends a yellow warning line, "some transcripts
could not be counted — total is provisional", whenever discovery reports an
unreadable transcript OR the load drops one (#165): the extension's stderr is not
a user surface, so the parser's latched stderr warning alone left the degrade
invisible. The prose line stays the whole surface — it appears on every render
until the transcripts count again, and the widget has no exit code to set.

The remedy line names **one** action — re-run — and deliberately never mentions `-F`.
`-F` does not return early: it deletes the tag, kills the daemon, and falls through to the
same read path, so a forced run can reach this branch too, and "use `-F`" would then be a
loop told to the person who just did it, about the run that is supposed to be the
authoritative reference. Fixed by deleting the branch rather than by conditioning on
`opts.forceReparse`: that second arm is reachable only inside a race between
`flushPending` and the first `scanForSubAgents`, which no test can hit reliably — and an
arm that always skips is untested, not covered. One sentence true in both cases has no
such arm.

`subagent-unreadable` earns its own remedy line for the same reason (rounds 6/7): it
fires whenever the CLI's own discovery reports an unreadable transcript — one file, or
a whole directory — whatever the tag verdict. The tag-derived "run wtft again in a
moment" line is a loop against a permanent unreadability for the same reason `-F` is:
the daemon's poll fails on the same unreadable file, so no rebuild is coming and the
marker stays stale. The tag total may ALSO be missing this transcript's cost: the swept
marker is not retracted, so the tag can read settled with the cost missing — which is
why the exit code stays provisional either way, and why the remedy names restoring
readability, not waiting. The daemon re-discovers on every poll, and the `--tokens`
scan reads transcript files directly, so a CLI re-run picks the file up once it is
readable.

**Why an exit code and not a field — and what happened next.** When #443 landed, `wtft`
had no `--json`, no `--porcelain`, and no documented exit-code table; every number it
produced was prose. An exit code was the only surface that cost an agent zero tokens and
zero inference. It carries one bit and deliberately did not preempt a structured mode,
which was filed as **#26** (migrated from #510) and has since shipped: `wtft --json`
carries `provisional` as a field alongside the totals — see
[`docs/spec-26-json.md`](spec-26-json.md). The exit code was **not** retired by it. Both
surfaces report the same verdict, so a consumer reading `$?` and one reading
`.provisional.provisional` cannot disagree.

## `attributeClaudeSubAgentCosts`: Per-Call, Not Global

The docstring used to read: *"Sub-agent session IDs are tracked globally to prevent double-counting across multiple interactions that reference the same session."* — true only for a single call, since `seenSessionIds` (declared in `attributeClaudeSubAgentCosts`) is a local `Set` created fresh every time the function runs, with no lifetime beyond that one call. #420 review corrected the docstring itself to say this plainly rather than leaving the false "global" claim standing next to the code it describes; the paragraphs below are the fuller version of that correction.

The invariant the function actually provides: within the array of interactions handed to it in one call, no nested `claude -p` session's cost is attributed twice. That holds for turns not yet attributed: a turn that already carries `claudeSubAgentFolds` is skipped, and its folds do not seed the set, so a later turn in the same array can fold the same child again. A turn whose only child was already counted earlier in the call is left with no folds, so a second call over the same objects attributes that child again. Both production callers hand it unattributed turns — `parseSessionFile` its fresh parse, the daemon clones of each turn's pre-fold base. It provides no protection across two separate calls — whether those calls are seconds apart in the same poll, or a beat apart across two polls.

`parseSessionFile` still calls `attributeClaudeSubAgentCosts` once, over the whole file that function just parsed (`extensions/lib/wtft-parser.ts`, the call inside `parseSessionFile`). The daemon does not go through `parseSessionFile` for a subagent wake. `syncSubagentTranscript` calls `attributeClaudeSubAgentCosts` once on every fold-capable turn retained for that transcript, cloned from the pre-fold base, and passes `doNotFold` containing the transcript itself, the session it is watching, and the children another holder already owns, so this transcript does not fold any of those. `tests/wtft-420-subagent-call-site.test.ts` allows those two call sites and fails when another appears. The bug this recorded (`tests/wtft-270-subagent-nested-claude-attribution.test.ts`) was an earlier cut of #270 that called this path once per poll batch: two bash turns invoking `claude -p` against the same project, landing in different poll windows but resolving to the same nested session file (inside `discoverClaudeSubAgentSessionFiles`'s ±15s matching window), each attributed that nested session's full cost — doubling it, with nothing in the output signaling the double-count.

**Rule for any future caller**: never call `attributeClaudeSubAgentCosts` — directly, or indirectly via `parseSessionFile` — over a poll-sized slice of the fold-capable turns whose nested sessions you intend to dedupe. The daemon's set is every fold-capable turn retained for that transcript, not the plain turns of one read. A partial slice does not error; it silently produces a partial, non-global, `seenSessionIds`.

## `deduplicateInteractions`: Return Order Is Not Chronological

`deduplicateInteractions` returns `[...withoutId, ...oneCollapsedInteractionPerId]`: every interaction with no `messageId` first, in original relative order (`withoutId`), followed by one collapsed interaction per distinct `messageId`, ordered by that id's FIRST occurrence in the input (`Map` insertion order) — not by timestamp, and not interleaved with the `withoutId` items' true chronological position.

**`deduped[deduped.length - 1]` is never guaranteed to be the chronologically last interaction.** Code that indexes the last element of this function's output to mean "the most recent turn" is wrong whenever the input mixes id-bearing and non-id-bearing interactions, or whenever the chronologically-last interaction is not the last distinct id to first appear. A caller that needs chronological order must sort by `timestamp` itself — this function does not provide it.

This is a narrower, different guarantee than `dedupeClassifiedById` (`dedupeClassifiedById` in `extensions/lib/wtft-daemon-lib.ts`), the tag-file reader's own collapse function, whose docstring explicitly promises first-appearance-order preservation ("a pure subtraction... same sequence minus the duplicates") so append-order consumers (bucket rendering, `limit`) see a stable sequence. `dedupeClassifiedById` calls `deduplicateInteractions` only to resolve ONE id-group at a time and reassembles the surrounding order itself via `slots`/`slotIds` — it does not inherit `deduplicateInteractions`'s ordering, it builds its own on top of it.

## Terminal Layout (watch mode)

```
Row 1:  sessionPath  (dim)
Row 2:  💸 WTF Tokens?  (◆--orange--green--|--green---orange--◆) ⚡ SURGE 2x  ● live
Row 3:  [legend: Spec, Mixed, Code, Tests, Research, Git, Grep, Prompt, Other]
Row 4+: ticks line (if --ticks), date dividers, bucket rows
Footer: q/Ctrl+C to exit, 'r' to restart  (r in red when daemon dead)
```

The 24-hour SURGE timeline and daemon status indicator are appended inline to the title line if they fit within terminal width; otherwise they wrap to separate lines between title and legend.

## Daemon Status States

| State | Indicator | Trigger |
|---|---|---|
| Alive | `🟢 live` (green) | PID alive |
| Dead | `🔴 stopped HH:MM` (red) | PID dead, last _hb timestamp shown |
| Restarting / Starting | `🟡 starting...` (yellow) | Daemon spawned but PID file not yet claimed; 5s grace window (#124) |
| Waiting | `🟡 waiting for session .jsonl...` (yellow) | Daemon alive or just spawned, but session file doesn't exist yet (#124) |

Health is checked:
- 10s after `--watch` startup
- Every 60s on the minute-boundary re-render
- After pressing `r`: every 1s for 5s (fast-poll)

## Pi Widget Integration

The Pi `/wtft` widget also spawns a log parser daemon on `session_start`, using `ctx.sessionManager.getSessionFile()` to determine the session path. This keeps the wtft-tag file warm for CLI use. The widget renders its own daemon status indicator on the title line (inline or wrapped), using the same `checkDaemonHealth`/`getTagPath` functions.

**Daemon auto-revive:** If the daemon died from idle timeout (24h), the Pi `agent_end` handler calls `ensureParserRunning`, which now checks actual daemon health via `checkDaemonHealth` before trusting the module-level `_parserSpawned` flag. If the daemon is dead, the flag is reset and the daemon is re-spawned. This keeps `wtft --watch` in an external terminal alive even after long idle periods — just type a new prompt and the daemon wakes up.

## SURGE Timeline (24-hour pricing bar)

The 24-hour timeline on the title line shows DeepSeek peak-valley surge pricing windows:
- **Orange segments**: Local hours that fall within surge windows. The schedule is
  `DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES` in `extensions/lib/wtft-cost.ts`, weekday-gated
  from `DEEPSEEK_WEEKEND_OFFPEAK_FROM` (#495). **The hours are deliberately not written
  here** — read them from those constants: they were hardcoded in four places plus four
  prose copies, and a schedule change had no way to fail when it missed one. The renderer
  asks `getDeepSeekPeakMultiplier` per hour, so the bar's colours cannot disagree with what
  that hour is billed at. It paints the schedule for **the day containing `now`**, while the
  bins below it may be older; on a weekend the bar shows no surge hours even where weekday
  bins are still flagged. Which day the bar should describe is #496.
- **Green segments**: All other hours (normal pricing)
- **Clock-face marker**: The current local hour renders as a clock-face emoji
  (<code>🕐</code>–<code>🕛</code>, including <code>🕛</code> at the noon hour), and is
  additionally bold — which starts its own colour segment. Solar noon is a separate
  `☀️` glyph between hour 11 and hour 12, never a replacement for the noon hour's slot
  (#7). There is no `◆` and has not been for some time; this line said there was (#503).
- **Surge badges**: Appended when in or near a surge window:
  - `⚡ SURGE 2x` — currently in a surge window (2× pricing active)
  - `⚡ SURGE APPROACHING` — within 20 minutes of surge start (blinking orange)
  - `⚡ SURGE ENDING` — within 20 minutes of surge end (blinking green)

**Unified rendering:** The timeline computation lives in `buildWtftLines` (one function, one call site). The `model` opt controls whether DeepSeek surge coloring is applied:
- **Pi widget**: passes `sessionCtx.model.modelId` from the session context
- **CLI paths**: auto-detects model from classified interactions (scans for "deepseek" substring)
- **Non-DeepSeek models**: renders an all-green timeline with no badges

## SIGWINCH (terminal resize)

Handler calls `render()` directly. Daemon status indicator reflows — may move from inline to separate line or vice versa depending on available width.

## Daemon Correctness Verification (#124)

The `--debug` flag was extracted from wtft into a standalone diagnostic script:

```
node debug/verify-daemon-parse.mjs --session <path/to/session.jsonl>
```

It compares three cost totals: tag file (daemon's incremental parse), direct parse+dedup
(fresh full re-parse), and raw parse (no dedup). Mismatch → exit code 1. Uses the same
`parseSessionFile` / `deduplicateInteractions` functions exported from the bundled wtft.mjs.

wtft.mjs gained an entry-point guard so importing it (e.g. from the debug script) does not
trigger `main()`.

## Settings Persistence (Cross-Harness Config)

All WTFT settings are persisted in harness-agnostic JSON config files via the shared `extensions/lib/config.ts` module. No `.jsonl` persistence — settings survive across Pi sessions, Claude Code invocations, and machine restarts. Config hierarchy: code defaults → `~/.config/princess-pi/wtft.json` → `./.princess-pi/wtft.json` → CLI flags. Widget auto-shows on session start if a config file exists. See `EXT_WTFT.html` for the full config reference.

## SIGINT / 'q'

Clears alt screen, restores cursor, prints final chart + summary line.

## Edge Cases

| Situation | Handling |
|---|---|
| Daemon exits (idle timeout, 24h) | Title shows `● stopped HH:MM` in red; footer shows red `'r' to restart` |
| No activity for 2m2s | Status flips to `● idle (M:SS to expire)` — countdown from model cache TTL. Model is read from the most recent classified tag entry (scanning past the consolidated heartbeat line). |
| Local model (no cache) | Status shows `● idle` without countdown |
| User presses `r` | Daemon restarts, status shows `● restarting...`, clears to `● live` within 5s |
| Tag file deleted/truncated | `fs.watch` handler re-reads from zero |
| Daemon spawned before session file exists | Status shows `● waiting for session .jsonl...` (yellow); daemon polls until file created (#124) |
| Daemon never started | PID check fails, status shows "daemon not found" |
| Daemon restarts after crash | Reads `_meta` offset from tag file for exact resume position; falls back to full re-parse if no meta offset found (#124) |
| One-shot read beats the daemon to a stale tag | The total prints in full, a `PROVISIONAL` warning names why, and `wtft` exits **9** rather than 0 — `readTagProvisional` reports `stale-version` or `unswept` (#443). It does NOT wait: blocking a one-shot CLI on a repair proportional to subagent volume is the cost read-then-render avoids |
| `--tokens` blind-spot scan loses a subtree | An unreadable subagent transcript — one file (reported, not thrown, since round 6; the readable siblings still scan) or a whole unreadable directory — drops uncounted billables from the token table; the parser warned (latched), the CLI sets `provisional` with reason `subagent-unreadable` and exits **9** (#457, round 5; assigned unconditionally on the CLI's own discovery failure since round 7 — never already-provisional-superseded) — a machine reader never sees a complete-looking report |
| Daemon encounters transient error | Error logged (debug mode), daemon continues on next poll cycle — does not crash |
| Terminal too narrow for inline status | Status wraps to separate line between title and legend |
| Session file gone | Daemon exits cleanly; TUI continues showing last-known data with stopped indicator |

## Verification

1. Start `wtft --watch` → confirm `● live` on title line
2. `kill <daemon-pid>` → within 60s, title shows `● stopped HH:MM` in red
3. Press `r` → status shows `● restarting...`, clears to `● live` within 5s
4. Wait 2m2s with no session activity → status flips to `● idle (M:SS to expire)`
5. Wait 24h with no session activity → daemon exits, title shows stopped indicator
6. Run `wtft --list` → shows running parsers with idle times
7. Pi `/wtft` widget → shows same idle/stopped states as CLI (shared `renderDaemonStatus`)
8. Terminal resize → width auto-fits; status reflows correctly (inline vs. separate line)
9. Idle for 2m2s with a remote model (Claude/DeepSeek) → countdown timer shows `(M:SS to expire)`
10. Kill daemon, restart Pi, send prompt → daemon auto-revives on agent_end (ensureParserRunning)
11. Start Pi in a git repo on `main` branch → git-guardrails shows warning notification on session_start (#124)
12. Run `node debug/verify-daemon-parse.mjs --session <path>` → reports tag-vs-direct cost match/mismatch (#124)

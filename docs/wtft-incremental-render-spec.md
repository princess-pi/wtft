# WTFT `--watch` Live Render + Log Parser Daemon Health Monitoring + SURGE Timeline

**Status:** Code and Spec Approved — updated 2026-08-01 with #124 additions

## Goal

Provide a live-updating cost chart in wtft `--watch` mode, backed by a persistent log parser daemon that pre-classifies session entries into a harness-agnostic tag file. The TUI watches the tag file via inotify (`fs.watch`) for zero-latency updates, and monitors the daemon's health with a colored status indicator on the title line. All render paths (Pi widget, CLI non-watch, CLI `--watch`) share a single SURGE timeline rendering inside `buildWtftLines`.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  wtft-daemon — detached, singleton per                  │
│  session. Polls session.jsonl every 667ms, classifies   │
│  entries, writes to wtft-tags/<session>.tag.v2.3.4.jsonl│
│  Tag format includes message.id for cross-run dedup.    │
│  Heartbeats: single _hb line updated in-place per idle  │
│  cycle (consolidated, not appended).                     │
│  Poll loop wrapped in try/catch: transient errors       │
│  (disk full, bad JSON) are logged, daemon survives.     │
│  Idle exit: 24h of no new data → clean shutdown.        │
│  Startup grace: 60s before idle exit can fire.          │
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
| `session_start` (Pi) or `wtft` / `wtft --watch` invoked (CLI) | Auto-spawns daemon if not already running (singleton via PID file) |
| New session data arrives | Daemon parses, classifies, flushes to tag file at 90bpm throttle |
| No new data for 24h | Daemon cleanly exits ("idle timeout") |
| Daemon just spawned (< 60s) | Idle exit suppressed (startup grace period) |
| Session file deleted | Daemon exits ("session removed") |
| Session file not yet created | Daemon waits (no exit), writes heartbeats so widget shows "waiting for session .jsonl..." (#124) |
| Press `r` in `--watch` | Kills stale daemon, spawns fresh, fast-polls health at 1s × 5 |
| **New activity after idle timeout** | Pi's `agent_end` handler calls `ensureParserRunning`, which checks daemon health via `checkDaemonHealth` and re-spawns if dead |

## Sub-Agent Transcript Read Path (#270 / #420)

Two kinds of sub-agent transcript exist. They are DISCOVERED differently and READ identically — which is the point, and was not true before #270:

| Kind | Discovery | Read | Per-file state |
|---|---|---|---|
| Task/agent/workflow sub-agents (#82) | `discoverSubagentSessionFiles(sessionPath)`, re-run every poll | `syncSubagentTranscript(file)` | `discoveredSubagentFiles: Map<transcriptPath, {size, mtimeMs, readAtMs, writtenLines}>` (`bin/wtft-daemon.ts`, search `const discoveredSubagentFiles`) |
| `claude -p` bash sub-agents (#138) | `discoverClaudeSubAgentSessionFiles(cwd, ts)`, re-run every poll while a bash turn is pending; the matched PATH is then kept | `syncSubagentTranscript(file)` — the same function | `discoveredClaudeFiles: Set<path>` for the registry, plus the same `discoveredSubagentFiles` entry as any other transcript |

**Discovery is one-shot; reading is not.** A bash command resolves to its transcript once — that match cannot un-happen — so `discoveredClaudeFiles` records the path and stops. Reading that path then happens on every poll, through the same `syncSubagentTranscript` the Task/agent path uses: re-parsed WHOLE on every `size`/`mtimeMs` change, appending only lines not already on disk.

Conflating those two — treating "we have matched this file" as "we have finished reading this file" — is precisely #270's bug, and it survived on the `claude -p` path through several rounds of fixing it on the Task/agent path. That is why there is now ONE reader rather than two paths with two different correctness properties: a second reader is a second place for the same bug to live, and the earlier attempt to manage it (an ungated stderr warning announcing that this path silently undercounts) was a note about the defect rather than a fix for it. `writeSessionToTagFile` is retired with it — it was a strict subset of `syncSubagentTranscript` (parse, dedupe, serialize, append) with no change detection, no append filter, and a bare `catch`.

**Why the parent is incremental and a sub-agent transcript is not.** The parent `session.jsonl` is one file the daemon owns exclusively and only ever appends to; `parseNewLines` (`bin/wtft-daemon.ts`, `parseNewLines`) tracks a byte offset (`lastSize`) and reads only the delta each poll, threading parse state forward. A Task/agent sub-agent transcript is a file the daemon does not own — written by a subprocess the daemon only observes, discovered while that subprocess is still running (`bin/wtft-daemon.ts`, the `SubagentFileState` interface). Byte-offset incremental reading was built for it and reverted: every invariant the parser provides turned out to be scoped to "the whole array `parseSessionFile`/`deduplicateInteractions` is handed," and a poll batch is a smaller, different array than the whole file. Three review rounds found the same shape of defect:

- `deduplicateInteractions` (`extensions/lib/wtft-parser.ts:566`) collapses lines sharing one `message.id`, keeping the max-cost copy. This is the common case, not an edge case — measured across twelve live transcripts, 39–76% of message ids carrying `usage` are re-emitted with growing cost across several lines (`tests/wtft-270-subagent-crosspoll-dedup.test.ts:17-22`). Two emissions of the same id landing in *different* poll windows never meet inside one `deduplicateInteractions` call, and get summed instead of collapsed.
- `attributeClaudeSubAgentCosts` (`extensions/lib/wtft-parser.ts`) opens `const seenSessionIds = new Set<string>()` in its own body — scoped to the single call, not global (see below). Calling it once per poll batch — which happens automatically, since it runs inside `parseSessionFile` — attributed the same nested `claude -p` grandchild session's cost twice, once from each batch that referenced it (`tests/wtft-270-subagent-nested-claude-attribution.test.ts:5-22`).
- A failed tag-file append had to rewind the read offset but could not un-mutate the stream state it had already advanced, silently losing compaction attribution.

**The fix**: on every poll, `scanForSubAgents` (`bin/wtft-daemon.ts`, `scanForSubAgents`) stats each known Task/agent sub-agent file; if `size`/`mtimeMs` moved, it re-parses the file WHOLE — `deduplicateInteractions(parseSessionFile(file))` (`bin/wtft-daemon.ts`, the re-parse call in `scanForSubAgents`), the exact single-call shape both functions above assume — and appends only the serialized lines not already on disk for that file (`bin/wtft-daemon.ts`, the append filter in `scanForSubAgents`). A quiet transcript costs one `stat` and nothing else (`bin/wtft-daemon.ts`, the `size`/`mtimeMs` gate).

**The same-tick window, and why the gate is not just `size`/`mtime`.** A transcript rewritten to exactly the same byte length inside ONE mtime tick (granularity is filesystem-dependent — nanoseconds on ext4/xfs/tmpfs, but 1s on ext3/HFS+ and some network mounts) leaves both `size` and `mtimeMs` unchanged, so a naive gate skips a real content change until some later write happens to move one of them. That is #270's own bug class — silently dropped growth — reappearing inside the fix for it, and two review rounds flagged it.

It is closed without hashing every file every poll, which is the cost the gate exists to avoid. A write can only hide inside the tick if it landed *after* our read and still stamped the mtime we already recorded; once the file has been quiet for longer than the coarsest plausible tick, no such write can exist, because any later write lands in a different tick and moves mtime. So `SubagentFileState` also carries `readAtMs`, and the file is re-read while `Date.now() - readAtMs <= MTIME_SETTLE_MS` (2000ms — a full margin over the 1s worst case), then skipped once settled.

That comparison uses **one clock, on purpose**. An earlier cut compared `readAtMs - mtimeMs`, subtracting a filesystem-reported mtime from the daemon's own `Date.now()` — two clocks, and the coarse-granularity case motivating the whole mechanism (a network mount) is exactly where they are also *skewed*. With a lagging server clock a just-written file computed as long-settled and was skipped on the next poll, silently reopening the gap. Elapsed time since our own read, measured only on our own clock, has no such failure mode. `readAtMs` is stamped only when a change is actually observed, never on the re-reads the window itself causes — otherwise the window restarts on every re-read and never settles. An actively-written transcript is therefore re-parsed for roughly three 667ms polls after its last write and then goes quiet; an idle one still costs exactly one `stat`. Redundant re-parses are free in tag-file terms because the append filter writes nothing when no line changed. The comment at the call site is explicit that this must stay a single call per poll: "do NOT add a second call here, that is the round-3 High" (`bin/wtft-daemon.ts`, the comment above that call).

**The append filter, and what the tag file may contain.** `writtenLines` is a multiset (`Map<hash, count>`) of sha1 hashes of tag-file lines already appended for that transcript (`bin/wtft-daemon.ts`, `writtenLines` and the append filter). Usage growing on a re-emitted `message.id` changes the serialized line, so it hashes differently, so it is appended again alongside the earlier line for that id — the READER, not the writer, is responsible for collapsing them: `dedupeClassifiedById` (`extensions/lib/wtft-daemon-lib.ts:172`) does that collapse on every read, taking max cost, exactly as `deduplicateInteractions` would over the whole file. An unchanged line hashes the same and is skipped — this is the cost bound that makes "re-parse whole every poll" viable at all; without it, re-appending a transcript's unchanged prefix every poll is O(n²) over its lifetime (`tests/wtft-270-subagent-tagfile-growth.test.ts`). The counter is a multiset rather than a plain set because two distinct interactions can serialize identically (no `message.id`, same millisecond, same content) — a set would silently drop the second, the exact bug class this exists to prevent (`bin/wtft-daemon.ts`, the multiset rationale above `discoveredSubagentFiles`).

So: **a subagent's growing-usage message legitimately appears as multiple tag-file lines sharing one `message.id`, at different costs, written across different polls.** This is expected, not a defect. Every reader of a tag file that may hold sub-agent lines must collapse by `message.id` (max cost) before summing; `readClassifiedTagFile` (`extensions/lib/wtft-daemon-lib.ts:204-225`) runs `dedupeClassifiedById` on every read, and `--watch` does the same collapse on both its initial read and every incremental append (see the consumer diagram above).

**That is a strong default, not an enforcement** — an earlier draft of this paragraph said "so no caller can forget it," which this repo's own code contradicts (PR review). `getSessionSummary` in `extensions/lib/session-selector.ts` deliberately does not import `wtft-daemon-lib` (see that file's CONSTANTS comment) and reimplements the max-cost-by-id collapse by hand. Two independent implementations of one rule are kept in step only by `tests/wtft-270-session-summary-dedup.test.ts` asserting value-equivalence against the canonical path — there is no shared code path forcing it. **A new reader that bypasses `readClassifiedTagFile` and does not add a similar pinning test reintroduces the raw-sum overcount.** That used to be prose with nothing behind it, which is a wish rather than a rule — so the violation is now COUNTED. `tests/wtft-tag-reader-collapse-guard.test.ts` enumerates every source file that both resolves a tag path (`getTagPath` / `TAG_SUFFIX` / a literal `.wtft-tag.`) and parses JSON, and fails unless each one either routes through `readClassifiedTagFile` / `dedupeClassifiedById` or appears in an allowlist carrying its reason and its pinning test. The allowlist is checked for rot in the same run, so a stale exemption cannot quietly accumulate.

It earned its place on the first run by catching a live violation nobody had noticed: `extensions/rate-limiter.ts` reads tag lines and sums per-model TOKENS over a 120s window with no collapse, so a re-emitted message inflates the reported TPM. Filed as **#454** rather than fixed here — the other readers collapse by max COST, and the right per-field reduction for tokens is a separate decision. It sits on the allowlist pointing at that issue until it is.

Route new readers through `readClassifiedTagFile` unless there is a stated reason not to; if there is, pin the copy with a test the way #270 did, and add the allowlist entry so the exception is visible instead of merely absent.

**What bounds tag-file growth.** Nothing does, formally. `discoveredSubagentFiles` holds one `SubagentFileState` per sub-agent transcript ever discovered in the daemon's life, never evicted — eviction was tried twice and reverted, because `discoverSubagentSessionFiles` re-lists every transcript on disk every poll, so an evicted entry is simply re-discovered next poll with an empty `writtenLines` and re-appends its whole transcript from scratch (`bin/wtft-daemon.ts`, the eviction rationale above `discoveredSubagentFiles`). In practice it is bounded by how many sub-agents one session spawns and how much each writes: measured at 175 real transcripts on this host (median 424KB, max 2.60MB), whole-parse+dedupe+serialize+hash costs 1.88ms median / 3.76ms p90 / 21.89ms max per file, 390.4ms total for all 175 against the 667ms poll budget — re-derive with `bun research/270-subagent-parse-bench.ts`, which is the single source for these figures and for the identical block in `bin/wtft-daemon.ts`.

**The startup batch is reachable, and it is the bound that matters** (PR review). An earlier draft dismissed the all-at-once figure as "a worst case that cannot actually occur, since only changed files are re-read." That reasoning is wrong for exactly one poll: a fresh daemon initializes every transcript it discovers at `size: -1, mtimeMs: -1` (`bin/wtft-daemon.ts`, the `SubagentFileState` default in `syncSubagentTranscript`), a sentinel no real `stat` can equal, so on the first poll *every* discovered file counts as changed and is re-parsed in one batch. "Only changed files are re-read" is true of every poll after that, and true of none of the first.

What is genuinely unreachable is the 175-file figure itself, for a different reason than the one given: a daemon watches ONE `sessionPath` and discovers only that session's own sub-agent transcripts (recursively), never the host-wide union. 175 is every daemon on this host at once, which no single process ever is. The bound that applies to a process is one parent's whole set: the costliest parent by time is **~60-95ms** (it moves with host load; re-runs here span that band), and the widest is **33 transcripts at ~20-26ms** — both against the same 667ms budget. The benchmark script reports these as `startupWorstFiles` / `startupWorstMs` / `slowestParentMs`, so the reachable case and the aggregate come from one run.

**Those two figures reconcile, and the reconciliation is the point** (PR review): 33 files at the 1.88ms population median would be ~62ms, about **2.4x** what the widest parent actually costs (~26ms, or ~0.80ms/file). It is cheaper because breadth and cost do not track — that parent's transcripts average **95KB**, against a 424KB population median. Note those are two different ratios and an earlier draft of this very paragraph conflated them: the size ratio is ~4.5x, the time ratio only ~2.4x, and the gap between them is the same lesson again — a small transcript still carries proportionally more interactions per byte, so cost follows interaction count rather than bytes. The parent that costs the most has 15 transcripts averaging 608KB. This is the same lesson the slowest-vs-largest pair above teaches: cost follows interaction count, not file count and not bytes, so neither "most files" nor "most bytes" is the worst case on its own. The conclusion is unchanged — the first poll costs about a tenth of one budget — but it now rests on a number that can actually occur (`bin/wtft-daemon.ts`, the benchmark block above `discoveredSubagentFiles`).

## Tag-File Staleness, and Why There Is No Version Bump (#270)

#270 asks for this half explicitly: *"the tag-file staleness needs its own answer — a fix that only corrects live behaviour leaves every already-written tag file wrong, including the ones a future audit will read."* Every tag file written before #270 holds a one-shot subagent parse, and the transcripts it undercounts are finished and will never grow again, so the live fix above cannot reach them.

**The answer is the next daemon start, and it needs no `WTFT_TAGGER_VERSION` bump — for Task/agent sub-agents.** A fresh daemon process starts with an empty `discoveredSubagentFiles`, so it has no memory of what any previous daemon wrote; `discoverSubagentSessionFiles(sessionPath)` re-lists that session's transcripts from disk on the first poll regardless of the parent's read offset, so it re-parses every one WHOLE and appends every line it derives, including exact re-statements of lines already on disk. The tag file then holds both the stale low-cost line and the fresh full-cost line for the same `message.id`, and `dedupeClassifiedById` (`extensions/lib/wtft-daemon-lib.ts:172`) collapses that pair to the max on every read. **Convergence is a property of the reader's collapse, not of the writer having been careful** — which is also why re-appending is safe rather than merely tolerable.

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

**This behaviour is identical on `main` @ `5fd5570` and on the #270 branch, down to the repaired tag's byte count** — restart-repair is pre-existing, and #270's job was not to add it but to avoid breaking it. That is a real risk and not a hypothetical one: the rewrite introduced the per-transcript `writtenLines` hash filter that decides what gets appended, and it could have failed in two opposite directions — suppressing the repair by treating already-on-disk lines as nothing to write, or double-counting it by appending a second full copy the reader fails to collapse. `tests/wtft-270-tagfile-staleness.test.ts` is the pin for both directions, and is deliberately a **contract** test (it passes on `main` by design) rather than a bug-fix regression test.

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

Those parent rows are not exposed, and for a reason worth stating rather than assuming: the parent path does not re-append. `initClassified` (`bin/wtft-daemon.ts`, `initClassified`) recovers `lastSize` from the `_meta` offset recorded in the tag file and RESUMES; when it cannot recover one it truncates the tag file before re-parsing from zero. Neither branch can lay a second copy of a parent row beside the first. Only the sub-agent path starts with an empty `writtenLines` — which is not an oversight there, it is the repair mechanism itself.

So the zero above is a property of this host's traffic, not of the wire format: `discoverSubagentSessionFiles` already has a Pi `parentSession` branch, and the first Pi session that spawns a discoverable sub-agent would double-count ~100% of its cost-bearing rows on every daemon restart. **Filed as #453**, with the proposed shape (a deterministic synthetic ordinal id for id-less cost-bearing rows, which closes the collapse without breaking the multiset invariant that two distinct interactions may serialize identically). It is a tag-file wire-format change, which is why it is not folded in here.

**Why not a version bump.** A `WTFT_TAGGER_VERSION` bump is the remedy #270 lists first, and it is the wrong tool here. It orphans every existing tag file and forces a from-zero re-parse of every session's parent transcript as well as its subagents, and it leaves both the old and new tag files on disk; the in-place repair reaches the identical number incrementally, reusing everything already classified. A bump earns its cost when old tags are *unreadable or mispriced* — the 2.6.0/2.6.1/2.7.0/2.7.1 entries above are all of that kind, where no amount of appending can correct what is already written. #270's staleness is the other kind: the old lines are correct as far as they go, and the missing ones can simply be added.

**Residual, filed as #443**: the FIRST read after a stale tag still reports the pre-repair number. `bin/wtft.ts`'s non-watch path resolves the tag path, spawns the daemon, and reads the tag immediately, so the read races the repair and loses; `awaitDaemonUp` is entered only when the tag yields nothing AND the session file is absent, and a populated-but-stale tag satisfies neither. Pre-existing on `main`, unchanged by #270, and a genuine trap for one-shot audits (#176) — hence its own issue rather than a note here.

## `attributeClaudeSubAgentCosts`: Per-Call, Not Global

The docstring used to read: *"Sub-agent session IDs are tracked globally to prevent double-counting across multiple interactions that reference the same session."* — true only for a single call, since `seenSessionIds` (`extensions/lib/wtft-parser.ts:987`) is a local `Set` created fresh every time the function runs, with no lifetime beyond that one call. #420 review corrected the docstring itself (`extensions/lib/wtft-parser.ts:975-983`) to say this plainly rather than leaving the false "global" claim standing next to the code it describes; the paragraphs below are the fuller version of that correction.

The invariant the function actually provides: within the array of interactions handed to it in one call, no nested `claude -p` session's cost is attributed twice. It provides no protection across two separate calls — whether those calls are seconds apart in the same poll, or a beat apart across two polls.

`attributeClaudeSubAgentCosts` runs exactly once per whole-file parse, invoked internally by `parseSessionFile` (`extensions/lib/wtft-parser.ts:485`). The daemon's Task/agent read path preserves the "one call, whole file" shape by construction — `scanForSubAgents` always calls `parseSessionFile` on the full transcript, never a batch slice (`bin/wtft-daemon.ts`, `scanForSubAgents`). The bug this recorded (`tests/wtft-270-subagent-nested-claude-attribution.test.ts`) was an earlier cut of #270 that called this path once per poll batch: two bash turns invoking `claude -p` against the same project, landing in different poll windows but resolving to the same nested session file (inside `discoverClaudeSubAgentSessionFiles`'s ±15s matching window), each attributed that nested session's full cost — doubling it, with nothing in the output signaling the double-count.

**Rule for any future caller**: never call `attributeClaudeSubAgentCosts` — directly, or indirectly via `parseSessionFile` — over anything less than the complete file whose nested sessions you intend to dedupe. A partial slice does not error; it silently produces a partial, non-global, `seenSessionIds`.

## `deduplicateInteractions`: Return Order Is Not Chronological

`deduplicateInteractions` (`extensions/lib/wtft-parser.ts:566-585`) returns `[...withoutId, ...oneCollapsedInteractionPerId]`: every interaction with no `messageId` first, in original relative order (`withoutId`, declared line 568, spread at line 583), followed by one collapsed interaction per distinct `messageId`, ordered by that id's FIRST occurrence in the input (`Map` insertion order, iterated at line 585) — not by timestamp, and not interleaved with the `withoutId` items' true chronological position.

**`deduped[deduped.length - 1]` is never guaranteed to be the chronologically last interaction.** Code that indexes the last element of this function's output to mean "the most recent turn" is wrong whenever the input mixes id-bearing and non-id-bearing interactions, or whenever the chronologically-last interaction is not the last distinct id to first appear. A caller that needs chronological order must sort by `timestamp` itself — this function does not provide it.

This is a narrower, different guarantee than `dedupeClassifiedById` (`extensions/lib/wtft-daemon-lib.ts:172-202`), the tag-file reader's own collapse function, whose docstring explicitly promises first-appearance-order preservation ("a pure subtraction... same sequence minus the duplicates," lines 167-170) so append-order consumers (bucket rendering, `limit`) see a stable sequence. `dedupeClassifiedById` calls `deduplicateInteractions` only to resolve ONE id-group at a time (line 199) and reassembles the surrounding order itself via `slots`/`slotIds` — it does not inherit `deduplicateInteractions`'s ordering, it builds its own on top of it.

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
  (`☀️` at noon), and is additionally bold — which starts its own colour segment.
  There is no `◆` and has not been for some time; this line said there was (#503).
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

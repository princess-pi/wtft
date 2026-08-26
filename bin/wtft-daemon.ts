#!/usr/bin/env -S node --experimental-strip-types

// bin/wtft-daemon.ts — Tagger daemon: session.jsonl → session.jsonl.wtft-tag.v{N}.jsonl
// Pure Unix pipe: one input file, one output file. No network.
// Throttled writes at 90bpm (667ms). Heartbeat protocol.
// Auto-spawned by wtft CLI; runs detached.
//
// Source file — build.ts (Bun.build) bundles into bin/wtft-daemon.mjs.
// Parsing, classification, and cost calculation live in extensions/lib/wtft-shared.ts
// and are imported here. The daemon owns only: file watching, incremental parsing,
// tag file I/O, heartbeat protocol, singleton PID management, and serialization.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	parseEntryToInteraction,
	parseSessionFile,
	deduplicateInteractions,
	serializeClassified,
	serializeClassifiedWithOverheadSplit,
	applyControlEntry,
	newParseStreamState,
	extractCwdFromBashCommand,
	discoverClaudeSubAgentSessionFiles,
	discoverSubagentSessionFiles,
	loadSubagentInteractions,
	loadUserPricing,
	resolveMovedSession,
	getCurrentVersionTagPath,
	isSessionIdBasename,
	loadExternalHarnesses,
	WTFT_TAGGER_VERSION as TAGGER_VERSION
} from "../extensions/lib/wtft-shared.js";




// ---
// DAEMON CONFIGURATION
// ---

// Bump when classification heuristics or cost model change (#54, #55, etc).
const TAG_SUFFIX = `.wtft-tag.v${TAGGER_VERSION}.jsonl`;
const POLL_MS = 667;              // 90bpm throttle
const IDLE_EXIT_MS = 24 * 60 * 60 * 1000; // exit if session.jsonl unchanged for 24h (polite to ps aux)
// How long to stay parked on a session .jsonl that has NEVER appeared (#308).
// Claude Code writes the transcript only after the first real prompt completes,
// so "absent at spawn" is the normal launch state, not an orphan — but a session
// that never gets a prompt must not pin a daemon forever. One hour matches
// ZERO_INTERACTIONS_AGE (the reaper's own notion of "zombie"), and a later
// `wtft` run respawns for free. Only the never-seen case uses this ceiling; a
// session seen once and then removed exits on the daemon's own knowledge.
const SESSION_WAIT_MAX_MS = 60 * 60 * 1000;

// ---
// DAEMON STATE
// ---

// Empty string = not yet initialized (set once during startup, before the poll loop).
let sessionPath = "";
let tagPath = "";
let pidPath = "";
let lastSize = 0;            // bytes read from session.jsonl
let lastWriteMs = 0;         // last time we flushed to the tag file
let lastActivityMs = Date.now(); // last time we classified a new interaction
let startupTime = Date.now();    // daemon start time (idle exit grace period)
// {interaction, prevCtx} waiting for next flush (#52 Phase 3: serialized at
// flush so late interrupt markers can still stamp the tail interaction).
let pendingItems: { interaction: NonNullable<ReturnType<typeof parseEntryToInteraction>>; prevCtx: number }[] = [];
let idleStartMs = 0;         // start of current idle period (for _hb range)
// Stream state threaded across incremental reads: thinking level (#77), model
// from model_change (#128), compaction tokensBefore (#90), and the pending
// after-compaction flag (#52 Phase 3). Shared shape with parseSessionFile so
// the incremental and whole-file paths cannot drift (#156).
const streamState = newParseStreamState();
let stampInterruptOnPending = false; // interrupt marker seen; assistant turn is in pendingItems (#52 Phase 3)
let prevCtxTokens = 0; // input+cacheRead+cacheWrite of prev non-sidechain interaction (recache signature)
let running = true;
let sessionExisted = false; // becomes true first time we observe the session file (#129 Bug A)

// Claude bash sub-agent discovery (#138): track interactions that spawn
// `claude -p` so we can periodically check for completed sub-agent sessions
// and write their classified interactions to the tag file.
const pendingClaudeCommands: { interaction: NonNullable<ReturnType<typeof parseEntryToInteraction>>; prevCtx: number }[] = [];
// Every `claude -p` transcript this daemon has matched to a bash command (#138).
// PATHS, not a seen-set of ids: discovery is genuinely one-shot (a bash command
// resolves to its transcript once), but the file then stays in here and is
// re-read on every poll by syncSubagentTranscript, exactly like a Task subagent.
// It was a `Set<sessionId>` used to SUPPRESS re-reading, which is #270's bug
// surviving on the path #270 did not measure (PR review).
const discoveredClaudeFiles = new Set<string>();
// When this daemon completed its first full subagent sweep, or 0 before it has
// (#443). Written into the tag as `_meta.swept` so a one-shot reader can tell a
// settled total from one the daemon is still about to repair. Kept in memory
// only to answer "have I already written it", and only set once the append
// actually landed.
// Has anything been appended to the tag since the last `_meta.swept`? (#443)
//
// Starts TRUE, and that matters: a daemon inheriting a tag written by an older
// one has no idea whether that tag's marker still covers its contents, so it
// must re-stamp after its own first sweep rather than trust what it found. Set
// again by every successful append (flushPending, syncSubagentTranscript), and
// cleared only when a marker actually lands.
let tagGrewSinceMarker = true;
// Did the sweep now running report any failure? Reset at the top of each
// scanForSubAgents; set by syncSubagentTranscript's failure handlers. A sweep
// that could not read what it was meant to read must not stamp the tag as
// swept (#443, PR review).
let pollHadFailure = false;
// One ungated warning if that marker cannot be appended (#443, PR review). A
// plain boolean, not one of the per-transcript Sets above: there is one tag file
// per daemon, not one per transcript, so a Set keyed on anything would hold
// exactly one entry.
let warnedSweptMarkerFailure = false;
// One ungated warning if the PARENT batch cannot be flushed to the tag. Same
// policy and same reason as the four subagent warnings above — a persistent
// failure here silently drops billed parent turns while the daemon looks
// healthy.
let warnedParentFlushFailure = false;
/** How long a subagent transcript must have been quiet BEFORE we read it for
 *  that read to be provably complete. Must exceed the coarsest mtime
 *  granularity we expect to meet (1s on ext3/HFS+ and on some network mounts;
 *  ext4/xfs/tmpfs are ns). 2s buys a full margin over the 1s case while keeping
 *  the re-read window to about three 667ms polls after a transcript's last
 *  write. */
const MTIME_SETTLE_MS = 2000;

// One warning per failure class PER TRANSCRIPT, not per daemon process (PR
// review). These were four module-level booleans, which latched on the first
// transcript to fail and then silenced that entire failure class for every
// OTHER transcript for the life of the daemon — so transcript B's permissions
// error printed nothing because unrelated transcript A had already hit a stat
// error. That is a silent, indefinite undercount of B, which is precisely what
// these warnings exist to announce.
//
// Keying per transcript (by full path, see syncSubagentTranscript) keeps the
// property the booleans were actually chosen for:
// these branches run on every poll, so an unlatched warning would print several
// times a second and become its own noise floor. Per-transcript is the smallest
// scope that is still bounded — one line per affected file per class, then quiet.
// WHERE THESE ACTUALLY GO, stated plainly because two review rounds have now
// reasoned about their visibility and the reasoning was incomplete both times
// (PR review): production spawns the daemon with `stdio: "ignore"` at BOTH
// sites — restartDaemon in extensions/lib/wtft-daemon-lib.ts and the
// self-respawn in this file — so this process's stderr is connected to nothing.
// These warnings are therefore NOT visible in normal operation today, and
// ungating them from WTFT_DAEMON_DEBUG (which earlier rounds did, reasoning
// that "a signal only a maintainer who already suspected it would set
// WTFT_DAEMON_DEBUG to see is no signal at all") did not change that: the debug
// flag was never the binding constraint, the closed stream is.
//
// They are kept, ungated, anyway. They are correct as written, they cost
// nothing, and they become visible the moment the transport is fixed — which is
// #436, a deliberate design decision (durable log file under
// ${XDG_STATE_HOME}/wtft/, and/or a machine-readable incompleteness field that
// #428/#432 actually want) and NOT this branch's to make. #436 is pre-existing:
// both `stdio: "ignore"` sites are on main @ 5fd5570 verbatim and this branch
// never touched either line. What would be wrong is a comment here implying the
// warning reaches an operator today. It does not.
const warnedSubagentStatFailure = new Set<string>();
const warnedSubagentParseFailure = new Set<string>();
const warnedSubagentWriteFailure = new Set<string>();
const warnedSubagentSerializeFailure = new Set<string>();

/** What the daemon remembers about one subagent transcript (#270).
 *  `size`/`mtimeMs` are the CHANGE DETECTOR — the file is re-read only when one
 *  of them moves, so a quiet transcript costs one `stat` and nothing else.
 *  `writtenLines` is a multiset of sha1 hashes of the tag-file lines already
 *  appended for this transcript; it is the whole append filter.
 *  `-1` on both counters means "never read", which no real stat can equal. */
interface SubagentFileState {
	size: number;
	mtimeMs: number;
	/** When this file was last actually READ (ms). Paired with `mtimeMs` it is
	 *  what closes the same-tick window: a write landing after our read but
	 *  inside one mtime tick leaves size and mtime unchanged, so the only
	 *  evidence it could exist is that the recorded mtime is too close to the
	 *  read to rule it out. */
	readAtMs: number;
	writtenLines: Map<string, number>;
}

// Task/agent sub-agent discovery (#82), re-parsed WHOLE on every change (#270).
//
// A subagent transcript is discovered while it is still running, so parsing it
// only once — at discovery — makes everything it writes afterward invisible
// forever. The obvious fix, an incremental byte offset per file, was written and
// then removed: it is the parent session's design, and the parent session is a
// single file this daemon owns and appends to in one place. A subagent
// transcript is not that. Three review rounds each found the same shape of
// defect — a whole-file invariant meeting a batch-sized window:
//
//   * deduplicateInteractions collapses lines sharing a `message.id`; two
//     emissions of one id in different poll windows never met, and were summed.
//   * attributeClaudeSubAgentCosts scopes its `seenSessionIds` to ONE CALL, so
//     per-batch calls attributed the same nested `claude -p` session twice.
//   * a failed append had to rewind the byte offset but could not rewind the
//     stream state it had already mutated, losing compaction attribution.
//
// So: on change, re-parse the WHOLE file (parseSessionFile + deduplicateInteractions,
// exactly what discovery-time parsing did pre-#270) and append only the
// serialized lines this transcript has not already put on disk. Every invariant
// above is restored for free, because every one of them holds over a whole file.
//
// Why hash the SERIALIZED LINE rather than track ids, costs, or offsets:
//   * usage grew  -> different line -> new hash -> appended; the reader's
//     dedupeClassifiedById collapses it against the earlier line taking max.
//   * nothing changed -> identical line -> hash present -> skipped. THIS is the
//     cost bound: without it, re-appending a whole transcript every poll is
//     O(n^2) (tests/wtft-270-subagent-tagfile-growth.test.ts pins it).
//   * an interaction with no `message.id` needs no id under this predicate.
//   * a changed `interrupted` flag — or any other field — changes the line and
//     is picked up with no special case.
// A MULTISET (hash -> count), not a set: two distinct interactions that
// serialize identically are rare but possible (no `message.id`, same millisecond,
// same content), and a set would silently drop the second — the exact class of
// bug this rewrite exists to remove.
//
// MEASURED, not assumed — and now REPRODUCIBLE (PR review): every figure below
// comes out of `bun research/270-subagent-parse-bench.ts`, which mirrors this
// loop's per-file work exactly. The first version of this block was an ad-hoc
// run nobody saved, and the review caught that its numbers could not be
// reconciled with each other — it set a "max PER FILE" (by TIME) beside "the
// largest file" (by SIZE) as though they were one transcript, and quoted an
// interaction count with no antecedent. Both are fixed below, and the script is
// committed so the next reader can re-derive rather than trust.
//
// 175 real subagent transcripts on this host, median 424KB / max 2.60MB:
// whole-file parse + dedupe + serialize + sha1 costs 1.88ms median, 3.76ms p90,
// 21.89ms max PER FILE. All 175 re-parsed in the same beat totals 390.4ms
// against the 667ms poll budget. sha1 hex over the line rather than the line
// itself: 238KB vs 3.25MB across those 6,104 interactions.
//
// THE ALL-AT-ONCE FIGURE IS THE WRONG BOUND, in both directions (PR review).
// It used to be dismissed here as "a case that cannot occur, since only files
// that CHANGED are re-read". That is false for exactly one poll: a fresh daemon
// seeds every transcript at size/mtimeMs -1 (see syncSubagentTranscript), a
// sentinel no real stat equals, so the FIRST poll re-parses everything it
// discovered. It is also too pessimistic, for a reason the old text missed: a
// daemon watches ONE sessionPath and sees only that session's own subagents,
// never the host-wide union. 175 is every daemon on this host at once, which no
// single process ever is. The bound that applies to a process is one parent's
// whole set: costliest parent by time ~60-95ms (it moves with host load; re-runs
// span that band); widest parent 33 transcripts at ~20-26ms. Both are about a tenth of one poll budget, so the conclusion stands;
// only the reasoning behind it was wrong. The script reports these as
// startupWorstFiles / startupWorstMs / slowestParentMs.
//
// Those two reconcile (PR review): 33 files at the 1.88ms median would be
// ~62ms, about 2.4x what the widest parent costs (~26ms, ~0.80ms/file).
// Breadth and cost do not track — that parent's transcripts average 95KB
// against a 424KB population median. Two DIFFERENT ratios, and an earlier draft
// here conflated them: size ratio ~4.5x, time ratio ~2.4x. The gap is the same
// lesson again — a small transcript carries proportionally more interactions
// per byte. The costliest parent has 15 transcripts averaging 608KB. Cost
// follows interaction count, not file count and not bytes.
//
// The slowest and the largest transcript NEED NOT be the same file, which is
// the reconciliation the old text was missing: in the run above slowest is
// 1.78MB / 21.89ms (hashing 1.05ms) while largest is 2.60MB but only 14.90ms
// (hashing 0.57ms). Whether they coincide varies run to run — the script prints
// `same file?` per run, and it has answered both ways here — so do not read a
// single run's answer as a property. The durable point is the one that survives
// either answer: cost tracks interaction count, not bytes, so the size ceiling
// is not the thing to watch.
//
// GROWTH, stated plainly: one SubagentFileState per subagent transcript
// discovered during this daemon's life, NEVER evicted, and each one grows by a
// 40-char hash per interaction that transcript ever writes. It is bounded only
// in practice, by how many subagents one session spawns and how much they write.
// Eviction was tried twice and reverted both times: "the subagent finished" is
// unsafe because discoverSubagentSessionFiles re-lists every transcript on disk
// every poll, so an evicted entry is re-discovered on the next poll with an
// empty writtenLines and re-appends the whole transcript; and "the file is gone"
// could not be decided soundly from a scan alone.
//
// The SAME never-evicted argument applies to the other five per-transcript
// structures, so all six are accounted for here rather than leaving a reader to
// assume the smaller ones are managed (PR review). Per daemon process:
//   discoveredSubagentFiles  — one entry per transcript, plus a 40-char hash per
//                              interaction it ever writes. The big one, and the
//                              only one where eviction would be a correctness
//                              bug rather than merely pointless (see above).
//   discoveredClaudeFiles    — one path string per `claude -p` transcript this
//                              daemon matched to a bash turn.
//   warnedSubagent*Failure   — four Sets holding one transcript PATH each, and ONLY for
//     (stat/parse/                transcripts that actually failed that way. On a
//      serialize/write)           healthy run all four stay empty.
// None is capped. All are bounded in practice by one session's subagent count,
// which is tens, not thousands — a daemon lives as long as one session, and the
// widest session measured on this host spawned 33. A cap would need an
// eviction policy, and the one structure where that matters is the one where
// eviction is unsafe, so a cap on the cheap five would buy nothing.
const discoveredSubagentFiles = new Map<string, SubagentFileState>();

// ---
// SIGNAL HANDLING
// ---

function shutdown(reason: string) {
  if (!running) return;
  running = false;
  // Why the daemon stopped is the diagnostic #155 turns on: "session moved" and
  // "session removed" look identical from outside, and only one is a bug.
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] shutdown: ${reason}\n`);
  }
  // Ownership-aware shutdown (#95): a taken-over daemon must exit silently.
  // Writing anything would recreate the tag file the new owner's version
  // hygiene just deleted, and unlinking would destroy the new owner's lease
  // — that unlocked singleton was the daemon-per-restart leak.
  let ownsLease = false;
  try {
    ownsLease = fs.readFileSync(pidPath, "utf8").trim() === String(process.pid);
  } catch (_) {}
  if (ownsLease) {
    flushPending();
    // Stop heartbeat only if our tag file still exists — never recreate.
    try {
      if (fs.existsSync(tagPath)) {
        fs.appendFileSync(tagPath, JSON.stringify({ _hb: "stop" }) + "\n");
      }
    } catch (_) {}
    try { fs.unlinkSync(pidPath); } catch (_) {}
  }
  // Daemon goes silent but exits cleanly
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

// ---
// FILE I/O HELPERS
// ---

/**
 * Update the heartbeat line in the tag file.
 *
 * If the last line is already a heartbeat, truncates it off and appends the
 * updated one (Fork C: no in-place overwrite, no fixed-width contract).
 * If the last line is classified data, appends a new heartbeat line.
 *
 * Scans backwards from EOF for the last newline to handle arbitrarily long
 * preceding lines (classified data lines can be large with `cmd` arrays).
 */
function upsertHeartbeat(now: number) {
  try {
    const hbLine = JSON.stringify({ _hb: { first: idleStartMs, last: now } }) + "\n";
    const stat = fs.statSync(tagPath);
    if (stat.size === 0) {
      fs.appendFileSync(tagPath, hbLine);
      return;
    }

    // Scan backwards from EOF in chunks to find the last complete line.
    // A classified data line can be large (e.g. long `cmd` array), so a
    // fixed-size read window would land mid-line.
    const fd = fs.openSync(tagPath, "r+");
    const CHUNK = 512;
    let searchOffset = stat.size;
    let tail = "";
    let lastNl = -1;

    while (searchOffset > 0 && lastNl === -1) {
      const readSize = Math.min(CHUNK, searchOffset);
      searchOffset -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, searchOffset);
      tail = buf.toString("utf8") + tail;
      lastNl = tail.lastIndexOf("\n");
    }

    // Resolve the last complete line. If the file ends with \n (normal),
    // the last \n is a terminator — step back to the previous \n to find
    // the actual last line. If the file does not end with \n (edge case),
    // the last \n is the separator before the last line.
    let lastLineStart: number;
    if (lastNl === tail.length - 1) {
      // File ends with \n — find the \n that precedes the last line
      const prevNl = tail.lastIndexOf("\n", tail.length - 2);
      lastLineStart = prevNl === -1 ? 0 : prevNl + 1;
    } else if (lastNl === -1) {
      lastLineStart = 0;
    } else {
      lastLineStart = lastNl + 1;
    }

    const lastLine = tail.slice(lastLineStart).trim();

    let isHb = false;
    try {
      const obj = JSON.parse(lastLine);
      isHb = obj._hb !== undefined;
    } catch (_) {}

    if (isHb) {
      // Truncate the stale heartbeat line, then append the updated one.
      // No fixed-width overwrite — the file simply shrinks by one heartbeat
      // line and grows by one (net-zero for equal-length heartbeats).
      const truncAt = searchOffset + lastLineStart;
      fs.ftruncateSync(fd, truncAt);
    }
    fs.appendFileSync(tagPath, hbLine);
    fs.closeSync(fd);
  } catch (_) {
    // Fallback: append if we can't seek/overwrite
    try {
      fs.appendFileSync(tagPath, JSON.stringify({ _hb: { first: idleStartMs, last: now } }) + "\n");
    } catch (_2) {}
  }
}

/**
 * Append `batch` to the tag file, and on failure leave the file byte-identical
 * to how it was found — then rethrow.
 *
 * ONE EXCEPTION, stated here because the sentence above otherwise over-promises
 * and a reviewer read it as a guarantee (PR review): a file this write CREATED
 * is never truncated, so a partial append into a brand-new tag leaves a
 * fragment. See the NEVER UNLINK note below for why that guard is deliberate
 * and must not be relaxed. The residual — the retry glues its first record to
 * that fragment, making one unparseable line that readers skip, so a record is
 * lost rather than duplicated — is #512; closing it means terminating the
 * fragment, not truncating the file.
 *
 * EXTRACTED so there is exactly one of these (#443, PR review). It lived inline
 * on the subagent write path; `flushPending` then needed the same guarantee, and
 * a second hand-rolled copy is the shape this repo keeps getting bitten by (see
 * `dedupeClassifiedById` vs session-selector's duplicate, pinned only by a test).
 *
 * WHY AN EXACT REWIND, rather than letting the reader sort it out. A partial
 * `appendFileSync` can leave whole serialized records on disk before throwing.
 * Retrying the batch then re-appends them, and `dedupeClassifiedById` only
 * collapses lines that carry a `message.id` — its `if (!id)` branch passes
 * no-id entries straight through (`extensions/lib/wtft-daemon-lib.ts`), and
 * `serializeClassified` omits `id` whenever `Interaction.messageId` is absent.
 * So a cost-bearing no-id record would double-count on retry. "Duplicates
 * collapse on read" is true of id-bearing lines only, and leaning on it for the
 * rest was wrong (PR review). Rewinding makes the retry exact instead.
 *
 * THREE states, not two. Conflating any pair of them corrupts something:
 *   * file ABSENT   -> prior length is ZERO, and the file must not outlive a
 *                      failed write. Leaving this "unknown" skipped the rewind
 *                      on the one path the guard exists for (#437).
 *   * length KNOWN  -> cut back to it.
 *   * stat failed
 *     for any other
 *     reason        -> prior length is genuinely UNKNOWN, so do NOT rewind at
 *                      all. The first cut of the #437 fix defaulted this to 0
 *                      while still treating the file as pre-existing, which on a
 *                      write failure truncated the WHOLE session tag file — every
 *                      parent and subagent line already persisted, not just this
 *                      batch — to zero bytes, reported only as one subagent's
 *                      write warning (PR review).
 *
 * ONE stat, not existsSync-then-stat: the two-call form had a window in which
 * the file could vanish between the calls, which is precisely how the UNKNOWN
 * state got misread as zero.
 */
function appendToTagOrRewind(batch: string): void {
  let sizeBeforeWrite: number | null = null;
  let createdByThisWrite = false;
  try {
    sizeBeforeWrite = fs.statSync(tagPath).size;
  } catch (statErr) {
    if ((statErr as { code?: string }).code === 'ENOENT') {
      sizeBeforeWrite = 0;
      createdByThisWrite = true;
    }
    // Anything else leaves it null — the UNKNOWN state above.
  }
  try {
    fs.appendFileSync(tagPath, batch);
  } catch (writeErr) {
    if (sizeBeforeWrite !== null) {
      try {
        // Throws when nothing was created, which is the common failure and
        // needs no cleanup — that catch is this case, not an error.
        const sizeAfter = fs.statSync(tagPath).size;
        if (sizeAfter > sizeBeforeWrite) {
          // PROVE the extra bytes are ours before destroying them (PR review).
          // `sizeBeforeWrite` is stat'd before the append, so there is a window
          // — narrow, but real during the singleton takeover race, where an
          // outgoing daemon can still be mid-append to this same shared tag
          // file. Truncating on arithmetic alone ("the file grew, so the growth
          // is mine") would discard that writer's committed lines and report it
          // as one write warning. Rewinding a failed write must never be able to
          // destroy a successful one.
          const extra = sizeAfter - sizeBeforeWrite;
          const batchBuf = Buffer.from(batch);
          let ours = false;
          if (extra <= batchBuf.length) {
            const seen = Buffer.alloc(extra);
            const fd = fs.openSync(tagPath, 'r');
            try {
              fs.readSync(fd, seen, 0, extra, sizeBeforeWrite);
            } finally {
              fs.closeSync(fd);
            }
            // A partial write is a PREFIX of the batch. Anything else means
            // another writer is interleaved here.
            ours = seen.equals(batchBuf.subarray(0, extra));
          }
          // NEVER UNLINK (PR review). An earlier cut removed the whole file when
          // `createdByThisWrite` was set, reasoning that a file this write
          // created must not survive its own failure. That reasoning has a hole:
          // `createdByThisWrite` only means OUR stat saw ENOENT. Another daemon
          // can create and populate the file between that stat and our failed
          // append — and during a singleton takeover it is writing the SAME
          // lines for the SAME session, so its bytes can legitimately be a
          // prefix-match for our batch and set `ours`. Unlinking then destroys a
          // file another process successfully wrote, on evidence that cannot
          // tell the two apart.
          //
          // So: truncate back only when the file was KNOWN to exist before the
          // append, and never delete one that appeared during the race. The cost
          // of leaving it is a possible partial trailing line — which every
          // reader already skips per-line, and which initClassified handles at
          // the next start anyway (a tag holding no real classified data is
          // truncated and re-parsed whole).
          if (ours && !createdByThisWrite) {
            fs.truncateSync(tagPath, sizeBeforeWrite);
          }
          // Not ours: leave every byte alone. The cost is a possible partial
          // trailing line, which every reader already skips (the per-line
          // JSON.parse guard in readClassifiedTagFile). That is strictly cheaper
          // than deleting data another writer committed.
        }
      } catch { /* best effort — never mask the original write error */ }
    }
    throw writeErr;
  }
}

function flushPending() {
  if (pendingItems.length === 0) return;
  // Serialize at flush: compaction/recache meter-splits emit dual lines,
  // and interrupt markers that arrived after enqueue are already stamped.
  const batch = pendingItems.map(it => serializeClassifiedWithOverheadSplit(it.interaction, it.prevCtx)).join("");
  // pendingItems is NOT cleared here. It was, on main and in this branch's first
  // draft, and that lost a whole billed batch permanently whenever the append
  // threw — the items were already gone before anything could fail (PR review,
  // High). The loss predates #443, but #443 made it worse rather than merely
  // inheriting it: a marker could then be stamped over the gap, turning a silent
  // undercount into an affirmative "settled".
  let batchLanded = false;
  try {
    // Exact rewind on failure (PR review). A partial appendFileSync can leave
    // whole records on disk before throwing, and retrying the batch would
    // re-append them. "Duplicates collapse on read" covers only lines carrying a
    // message.id — dedupeClassifiedById's `if (!id)` branch passes no-id entries
    // straight through, and serializeClassified omits `id` when messageId is
    // absent — so a cost-bearing no-id record would double-count. Rewinding
    // makes the retry exact rather than leaning on the reader.
    appendToTagOrRewind(batch);
    batchLanded = true;
    // Set the MOMENT the tag grew, not after the offset line (PR review,
    // Medium). Classified data landed after whatever marker the tag currently
    // holds, so that marker no longer covers the tag and this poll's sweep must
    // re-stamp (#443) — flushPending runs BEFORE scanForSubAgents in the same
    // poll, which is exactly the window a one-shot marker left open. Setting it
    // after the offset append meant a failure BETWEEN the two left the tag grown
    // and the flag false, so the next sweep skipped the re-stamp and the tag
    // stayed provisional until some later write happened to set it again.
    tagGrewSinceMarker = true;
    // _meta offset tracking (#124): record the byte position processed so the
    // next daemon instance knows exactly where to resume, rather than skipping
    // to sessionPath.size and missing lines written while the daemon was dead.
    fs.appendFileSync(tagPath, JSON.stringify({ _meta: { offset: lastSize } }) + "\n");
    pendingItems = [];
    idleStartMs = 0; // Data arrived — idle period ended
  } catch (err) {
    // Keep the batch for the next poll ONLY if it never reached disk. If the
    // classified lines landed and just the offset line failed, re-appending them
    // would duplicate real cost, so drop them — the missing offset is recoverable
    // (initClassified re-parses from zero when it finds none), a lost batch is
    // not.
    //
    // The retry is EXACT, not merely tolerable: appendToTagOrRewind restores the
    // tag to its pre-append length, so nothing from the failed attempt survives
    // to be re-appended. An earlier version of this comment justified the retry
    // with "duplicates collapse on read" — true only of id-bearing lines, and
    // wrong for the no-id case (PR review).
    pendingItems = batchLanded ? [] : pendingItems;
    // Whatever failed, this poll did not write what it was asked to, so the
    // sweep must not stamp the tag as settled over the gap (#443).
    pollHadFailure = true;
    // Ungated and latched, matching the policy for the sibling subagent failures
    // in this file: the debug flag was never the binding constraint, and a
    // persistent ENOSPC/EACCES here silently drops billed parent turns while the
    // daemon looks healthy. That is the loudest thing this file can fail at.
    if (!warnedParentFlushFailure) {
      warnedParentFlushFailure = true;
      process.stderr.write(
        `[wtft-log-parser] WARNING: this session's classified turns could not be written to the tag file, so its reported cost is behind until it succeeds: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-log-parser] write error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  lastWriteMs = Date.now();
}

/** Check if an interaction has a bash command that spawns `claude -p`. */
function hasClaudeCommand(interaction: NonNullable<ReturnType<typeof parseEntryToInteraction>>): boolean {
  return interaction.commands.some(cmd => {
    // Replicate normalizeCommand + regex from wtft-parser.ts classifyInteraction
    let normalized = cmd.trim();
    let changed = true;
    while (changed) {
      changed = false;
      const stripped = normalized.replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*)+/, '');
      if (stripped !== normalized) { normalized = stripped.trim(); changed = true; }
      const afterSep = normalized.replace(/^(?:&&|;|\|\|?)\s*/, '');
      if (afterSep !== normalized) { normalized = afterSep; changed = true; }
      const afterCd = normalized.replace(/^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/, '');
      if (afterCd !== normalized) { normalized = afterCd; changed = true; }
    }
    if (!normalized) return false;
    return /(?:^|\s)claude(?:\s+-|\s*\||\s*$)/.test(normalized.toLowerCase());
  });
}

/** Bring ONE sub-agent transcript up to date in the tag file (#270).
 *
 *  Shared by BOTH discovery paths (PR review). This logic was inlined in the
 *  Task/agent loop, so the `claude -p` path (#138) kept the one-shot parse this
 *  issue is about: discovered while the invoking command was still running,
 *  parsed once, never re-read, and everything it wrote afterwards dropped
 *  forever. Two paths reading the same kind of file with two different
 *  correctness properties IS the defect — the fix is one reader, not a second
 *  warning about the second reader. This also retires writeSessionToTagFile,
 *  which was a strict subset of this: parse, dedupe, serialize, append, with no
 *  change detection, no append filter, and a bare catch.
 *
 *  Returns true when it appended anything. Never throws — one bad transcript
 *  must not stop the others, or the parent session's own tag writes. */
function syncSubagentTranscript(file: string): boolean {
  let wroteAny = false;
  // FULL PATH is the state key, basename is display only (PR review). Discovery
  // is the union of two independent sources — walkSubagentDir's recursion, which
  // descends into arbitrarily many subagents/workflows/wf_<runId>/ directories,
  // and discoverClaudeSubAgentSessionFiles, which matches transcripts in
  // arbitrary cwds — and nothing in either makes basenames unique across that
  // union. Two transcripts sharing one SubagentFileState would trade size/mtime
  // between unrelated files: one reads as "unchanged, skip" against the other's
  // recorded stat (a silent undercount, #270's own bug class) or trips the
  // truncation branch and clears a writtenLines that was never stale.
  //
  // Measured before changing it: 174 distinct agent-*.jsonl basenames on this
  // host, ONE colliding pair — and that pair sits under two different parent
  // sessions, so no single daemon can see both. Within a parent's discovered
  // set, 0 collisions across all 17 parents. The convention is agent-<hash> and
  // <uuid>, which is why. So this is a latent assumption, not a live bug — but
  // it was an UNSTATED assumption keyed on a name that nothing guarantees, and
  // the full path costs nothing and is unique by construction.
  const stateKey = file;
  const sessionId = path.basename(file, '.jsonl');
  let fileState = discoveredSubagentFiles.get(stateKey);
  if (!fileState) {
    fileState = { size: -1, mtimeMs: -1, readAtMs: 0, writtenLines: new Map<string, number>() };
    discoveredSubagentFiles.set(stateKey, fileState);
  }

  // The cheap-when-idle path: one stat, no read, no parse.
  let size: number;
  let mtimeMs: number;
  try {
    const stat = fs.statSync(file);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch (err) {
    // gone or unreadable this poll — discovery re-lists it next time. Logged
    // like the truncation and write-error branches below (review round 5):
    // a transcript that stays unreadable (e.g. a permissions change) would
    // otherwise silently drop out of coverage with no debug signal at all.
    //
    // Ungated once per transcript, then debug-gated per occurrence. A
    // persistent stat failure is a silent, indefinite undercount of that one
    // transcript. See the note above the warned* sets for where this text
    // actually goes today (nowhere — #436) and why it is written anyway.
    // This sweep is not clean, so it must not stamp the tag as swept (#443).
    pollHadFailure = true;
    if (!warnedSubagentStatFailure.has(stateKey)) {
      warnedSubagentStatFailure.add(stateKey);
      process.stderr.write(
        `[wtft-log-parser] WARNING: a subagent transcript could not be stat'd, so its cost may be missing from this session's total (${sessionId}): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-log-parser] subagent stat failed, will retry next poll (${sessionId}): ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return wroteAny;
  }
  // The cheap gate: unchanged size AND mtime normally means nothing to do.
  //
  // "Normally" used to be a KNOWN GAP that two review rounds flagged: a
  // transcript rewritten to exactly the same byte length inside ONE mtime tick
  // (granularity is filesystem-dependent, 1ms to 1s) reads as unchanged and was
  // skipped until some later write happened to move size or mtime — a real
  // content change dropped silently, which is #270's own bug class.
  //
  // It is now CLOSED rather than merely logged, and without hashing every file
  // every poll (the cost this gate exists to avoid). The observation: a write
  // can only hide inside the tick if it landed AFTER we read and yet still
  // stamped the mtime we already recorded. Once the file has been quiet for
  // longer than the coarsest plausible tick, no such write can exist, because
  // any later write must land in a different tick and move mtime. So the file
  // is re-read while `mtimeMs` is too close to the moment of our read to rule
  // that out, and skipped once it has settled.
  //
  // Cost is bounded and small: after each observed change a transcript is
  // re-parsed for about MTIME_SETTLE_MS (a handful of 667ms polls) and then goes
  // quiet, and re-parsing appends nothing unless content actually changed — the
  // hash filter below is what makes a redundant re-parse free in tag-file terms.
  // An idle transcript still costs exactly one stat per poll.
  //
  // ONE CLOCK, deliberately (PR review). The first cut of this compared
  // `readAtMs - mtimeMs`, which subtracts a filesystem-reported mtime from this
  // process's Date.now(). Those are different clocks, and the coarse-granularity
  // case that motivates the whole mechanism — a network mount — is exactly where
  // they are also SKEWED. If the server clock lagged, a just-written file
  // computed as long-settled and was skipped on the very next poll, silently
  // reopening the gap this exists to close. Elapsed time since OUR read,
  // measured entirely on OUR clock, has no such failure mode: 2s of our own wall
  // time is more than a 1s tick however the two clocks are offset.
  const changed = size !== fileState.size || mtimeMs !== fileState.mtimeMs;
  const settled = Date.now() - fileState.readAtMs > MTIME_SETTLE_MS;
  if (!changed && settled) {
    return wroteAny;
  }
  if (!changed && process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] subagent transcript unchanged but not yet settled, re-reading to close the same-tick window: ${path.basename(file)}\n`);
  }

  if (size < fileState.size) {
    // Truncated or rotated: the lines we recorded describe content that is no
    // longer in this file, so keeping them would suppress the replacement.
    // Duplicates that do survive collapse on read; a suppressed line never
    // arrives at all, which is the worse of the two.
    fileState.writtenLines.clear();
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-log-parser] subagent transcript truncated, re-parsing from zero: ${path.basename(file)}\n`);
    }
  }

  // Parse and write are two separate try/catches (PR review round 2): they
  // were one block, so a read/parse error (e.g. the file vanishing between
  // stat and read) was caught by the same handler as an append failure and
  // unconditionally reported as "could not be written to the tag file" —
  // misdiagnosing the actual failure for anyone debugging a persistent
  // warning. fileState.size/mtimeMs are only advanced after a SUCCESSFUL
  // write below, so a parse failure here still leaves the file marked
  // changed and gets retried next poll, same as before this split.
  let deduped: ReturnType<typeof deduplicateInteractions>;
  try {
    // Whole file, exactly as the pre-#270 discovery-time parse did.
    // parseSessionFile runs attributeClaudeSubAgentCosts internally over the
    // whole result — do NOT add a second call here, that is the round-3 High.
    deduped = deduplicateInteractions(parseSessionFile(file));
  } catch (err) {
    // Keep polling — one bad parse must not stop this subagent, the other
    // subagents in this loop, or the parent session's own tag writes.
    // This sweep is not clean, so it must not stamp the tag as swept (#443).
    pollHadFailure = true;
    if (!warnedSubagentParseFailure.has(stateKey)) {
      warnedSubagentParseFailure.add(stateKey);
      process.stderr.write(
        `[wtft-log-parser] WARNING: a subagent transcript could not be parsed, so its cost may be missing from this session's total until it succeeds (${sessionId}): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-log-parser] subagent parse error (${sessionId}), will retry next poll: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return wroteAny;
  }

  // Serialize+hash sits in its OWN try, separated from the append below (PR
  // review), extending the parse-vs-write split a few lines up for the same
  // reason it was made: a throw out of serializeClassified or the hash would
  // otherwise be reported by the write handler as "could not be written to
  // the tag file", sending anyone debugging a persistent warning after disk
  // space and permissions when the real cause is an interaction shape
  // serializeClassified cannot handle.
  let batch = '';
  const freshHashes: string[] = [];
  try {
    const seenThisParse = new Map<string, number>();
    for (const si of deduped) {
      const line = serializeClassified(si);
      const hash = createHash('sha1').update(line).digest('hex');
      const nth = (seenThisParse.get(hash) || 0) + 1;
      seenThisParse.set(hash, nth);
      if (nth <= (fileState.writtenLines.get(hash) || 0)) continue; // already on disk
      batch += line;
      freshHashes.push(hash);
    }
  } catch (err) {
    // Nothing written and nothing recorded, so the next poll still sees this
    // file as changed and retries it — the same shape as the parse failure
    // above, and the same reason it must not stop the other subagents.
    // This sweep is not clean, so it must not stamp the tag as swept (#443).
    pollHadFailure = true;
    if (!warnedSubagentSerializeFailure.has(stateKey)) {
      warnedSubagentSerializeFailure.add(stateKey);
      process.stderr.write(
        `[wtft-log-parser] WARNING: a subagent's interactions could not be serialized for the tag file, so its cost is missing from this session's total until it succeeds (${sessionId}): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-log-parser] subagent serialize error (${sessionId}), will retry next poll: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return wroteAny;
  }

  try {
    if (batch) {
      // Track the pre-write length so a throw mid-append (e.g. ENOSPC after
      // some bytes already landed) can be cut back to it — otherwise a
      // partial/corrupt trailing JSONL line survives on disk forever,
      // silently skipped by every reader's per-line `catch {}` (PR review
      // round 2).
      //
      // Append with an exact rewind on failure — see appendToTagOrRewind.
      appendToTagOrRewind(batch);
      wroteAny = true;
      // Subagent lines landed after whatever marker the tag holds, so this
      // sweep must re-stamp before a reader can call the tag settled (#443).
      tagGrewSinceMarker = true;
    }
    // Reached only when the append SUCCEEDED. Recording the hashes and the
    // change detector here is the whole failure story: an ENOSPC/EACCES/
    // removed-tag-dir throw records nothing, so the next poll still sees the
    // file as changed, re-parses it, and re-appends exactly the lines that
    // never landed. Idempotent by construction — no offset to rewind, no
    // stream state to un-mutate.
    for (const h of freshHashes) {
      fileState.writtenLines.set(h, (fileState.writtenLines.get(h) || 0) + 1);
    }
    // The stat was taken BEFORE the read, so anything written in between is
    // still ahead of this mark and gets re-parsed next poll.
    fileState.size = size;
    fileState.mtimeMs = mtimeMs;
    // Only a CHANGE restarts the settle window. Stamping this on every sync
    // would restart it on the very re-reads the window causes, so `settled`
    // could never become true and an idle transcript would be re-parsed
    // forever — the window has to measure "time since the last change we saw",
    // not "time since we last looked".
    if (changed) fileState.readAtMs = Date.now();
  } catch (err) {
    // Keep polling — one bad write must not stop this subagent, the other
    // subagents in this loop, or the parent session's own tag writes.
    //
    // But say so, ungated. Retry is only self-healing while the cause is
    // transient; an ENOSPC or a removed tag directory persists, and every poll
    // then re-parses and re-fails while the daemon looks healthy and the
    // reported cost drifts further from the transcripts. Once per transcript:
    // this fires on every poll by construction, and a per-poll warning would
    // bury the one that matters. On where it goes today, see #436 and the note
    // above the warned* sets.
    // This sweep is not clean, so it must not stamp the tag as swept (#443).
    pollHadFailure = true;
    if (!warnedSubagentWriteFailure.has(stateKey)) {
      warnedSubagentWriteFailure.add(stateKey);
      process.stderr.write(
        `[wtft-log-parser] WARNING: a subagent's lines could not be written to the tag file, so this session's reported cost is behind until it succeeds (${sessionId}): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-log-parser] subagent write error (${sessionId}), will re-parse next poll: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return wroteAny;
}

/** Scan for sub-agent sessions (both task/agent/workflow spawns #82 and
 *  claude -p bash commands #138). When found, parse, classify, and write
 *  to the tag file — renderers see them as regular turns. */
function scanForSubAgents() {
  let wroteAny = false;
  // NOTE: pollHadFailure is reset by the POLL LOOP, not here. It was reset here
  // first, and that was wrong — flushPending runs before this function in the
  // same poll and can also fail, so resetting on entry wiped the flush's failure
  // a few statements after it was set, and the marker below could stamp the tag
  // settled over a lost parent batch.

  // --- Claude bash sub-agents (#138) ---
  if (pendingClaudeCommands.length > 0) {
    const stillPending: typeof pendingClaudeCommands = [];
    for (const item of pendingClaudeCommands) {
      const interaction = item.interaction;
      let cwd: string | null = null;
      for (const cmd of interaction.commands) {
        cwd = extractCwdFromBashCommand(cmd);
        if (cwd) break;
      }
      if (!cwd) continue;

      const files = discoverClaudeSubAgentSessionFiles(cwd, interaction.timestamp);
      if (files.length === 0) {
        stillPending.push(item);
        continue;
      }
      for (const file of files) {
        // Register only. The read happens below, in the same loop and through
        // the same function as the Task/agent path, every poll for as long as
        // this daemon lives.
        discoveredClaudeFiles.add(file);
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-log-parser] claude -p subagent registered for re-parse (${path.basename(file, '.jsonl')})\n`);
        }
      }
    }
    pendingClaudeCommands.length = 0;
    if (stillPending.length > 0) pendingClaudeCommands.push(...stillPending);
  }

  // --- Task/agent/workflow sub-agents (#82), re-parsed WHOLE on change (#270) ---
  // See discoveredSubagentFiles above for why this is a whole-file re-parse and
  // not an incremental read. Short version: every invariant the parser provides
  // — id collapse, one nested-session attribution, compaction consumption — is
  // scoped to the array it is handed, and a poll batch is the wrong array.
  const taskAgentFiles = discoverSubagentSessionFiles(sessionPath);
  for (const file of taskAgentFiles) {
    wroteAny = syncSubagentTranscript(file) || wroteAny;
  }

  // The claude -p transcripts discovered above get the SAME treatment, on every
  // poll, through the same function (PR review). Discovery is one-shot by nature
  // — a bash command matches its transcript once — but READING it is not, and
  // conflating those two is exactly what #270 is about.
  for (const file of discoveredClaudeFiles) {
    wroteAny = syncSubagentTranscript(file) || wroteAny;
  }

  if (wroteAny) {
    lastWriteMs = Date.now();
    idleStartMs = 0;
  }

  // Sweep complete — stamp the tag, if anything was appended since the last
  // stamp (#443).
  //
  // A one-shot `wtft` spawns this daemon and reads the tag immediately, so it
  // races us and loses: on #443's specimen that was $79.74 against a true
  // $84.59, reported as a plain total with nothing marking it provisional.
  // `_meta.swept` is what readTagProvisional looks for.
  //
  // THE MARKER IS NOT ONE-SHOT, and the version that made it one-shot was wrong
  // (PR review). `sweptAtMs` was process-local while the marker persists in the
  // FILE, and `flushPending()` runs BEFORE this function in the same poll (see
  // the loop: flushPending, then scanForSubAgents). So a new parent turn —
  // including one spawning a new subagent — could be appended after a HISTORICAL
  // marker left by an earlier sweep or an earlier daemon, and a read landing
  // before this sweep finished would see that old marker and report SETTLED while
  // the new subagent was still unread. #443's own undercount, narrower window.
  //
  // The contract is now POSITIONAL, which is what makes it checkable: the marker
  // must be the last significant record in the tag. The reader scans backward and
  // treats a classified line found before a marker as invalidating it, so a stale
  // marker cannot certify data that arrived after it. This therefore re-stamps
  // whenever the tag grew — on a busy session once per poll that wrote anything,
  // ~35 bytes against the classified lines that poll already wrote, and nothing
  // at all on an idle or finished session.
  //
  // WITHHELD ON A FAILED SWEEP (PR review). `pollHadFailure` is set by
  // syncSubagentTranscript's stat/parse/serialize/write handlers, so a sweep that
  // could not read part of what it was meant to read does not claim to have swept:
  // the tag stays provisional and the next poll retries.
  //
  // What it still does NOT assert, because the name over-promises: this says a
  // sweep RAN AND REPORTED NO FAILURES, still weaker than "no failures occurred".
  // #457 — parseSessionFile's bare catch returns [] on EACCES — makes an
  // unreadable transcript indistinguishable from an empty one, so it never
  // reports a failure and cannot set pollHadFailure. Closing #457 strengthens
  // this marker for free.
  //
  // Not gated on `wroteAny`: a session with no subagents has nothing to sweep,
  // and "nothing to sweep" is the same state to a reader as "swept". Gating on it
  // would leave every subagent-free session reading provisional forever, which
  // trains the reader to ignore the flag.
  if (tagGrewSinceMarker && !pollHadFailure) {
    try {
      fs.appendFileSync(tagPath, JSON.stringify({ _meta: { swept: Date.now() } }) + "\n");
      // Cleared only on a landed append, so a failed write retries next poll.
      tagGrewSinceMarker = false;
    } catch (err) {
      // The WRITE retries; the WARNING latches. Two different things, and an
      // earlier version of this block conflated them (PR review).
      //
      // Warn: ungated and once, matching the policy stated for the sibling
      // stat/parse/serialize/write failures at the top of this file — "the debug
      // flag was never the binding constraint", and they stay ungated so they
      // become visible the moment #436 fixes the transport. Debug-gating this one
      // would be the exact anti-pattern that comment argues against, for a
      // failure with real consequences: a PERSISTENT append failure leaves every
      // read of this tag reporting provisional forever, and the operator would
      // have nothing to go on. Latched by a boolean rather than a per-transcript
      // Set because there is one tag file, not one per transcript — without it
      // this re-prints on every poll and becomes its own noise floor.
      if (!warnedSweptMarkerFailure) {
        warnedSweptMarkerFailure = true;
        process.stderr.write(
          `[wtft-log-parser] WARNING: the swept marker could not be appended, so every read of this session's tag will report a PROVISIONAL total until it succeeds: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }
}

function parseNewLines(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    const currentSize = stat.size;
    if (currentSize < lastSize) {
      // File truncated or rotated — reset
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] session truncated, resetting offset\n`);
      }
      lastSize = 0;
    }
    if (currentSize <= lastSize) return [];
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(currentSize - lastSize);
    // try/finally: a throwing readSync must not leak the descriptor (#270 review).
    try {
      fs.readSync(fd, buf, 0, buf.length, lastSize);
    } finally {
      fs.closeSync(fd);
    }
    lastSize = currentSize;
    const newContent = buf.toString("utf8");
    // Same shape as parseSessionFile's whole-file loop (#156), threading the
    // control entries — thinking level (#77), model_change (#128), compaction
    // (#90), interrupt (#52 Phase 3) — through the session's stream state.
    // Interrupt: the killed turn is either the last interaction of this
    // batch, or still sitting unflushed in pendingItems (stamped in the
    // main loop). If it was already flushed to the tag file, the stamp is
    // dropped — bounded by one 667ms beat.
    const interactions: NonNullable<ReturnType<typeof parseEntryToInteraction>>[] = [];
    for (const line of newContent.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const isControl = applyControlEntry(entry, streamState, () => {
          if (interactions.length > 0) {
            interactions[interactions.length - 1].interrupted = true;
          } else {
            stampInterruptOnPending = true;
          }
        });
        if (isControl) continue;

        const interaction = parseEntryToInteraction(entry, streamState.thinkingLevel, streamState.compactionTokensBefore, streamState.afterCompaction, streamState.model);
        if (interaction) {
          interactions.push(interaction);
          streamState.compactionTokensBefore = undefined; // consumed
          streamState.afterCompaction = false; // consumed
        }
      } catch (_) {
        // Skip unparseable lines (partial writes, non-JSON)
      }
    }
    return interactions;
  } catch (_) {
    // File may not exist yet
    return [];
  }
}

// ---
// META OFFSET TRACKING (#124)
// ---

/**
 * Read the byte offset from the last _meta line in the tag file.
 * Returns null if no _meta line found (tag file predates offset tracking).
 */
function readLastMetaOffset(tagPath: string): number | null {
  try {
    const stat = fs.statSync(tagPath);
    if (stat.size === 0) return null;
    // Scan last ~8KB for the most recent _meta line.
    const readStart = Math.max(0, stat.size - 8192);
    const fd = fs.openSync(tagPath, "r");
    const buf = Buffer.alloc(stat.size - readStart);
    fs.readSync(fd, buf, 0, buf.length, readStart);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj._meta && typeof obj._meta.offset === "number") {
          return obj._meta.offset;
        }
      } catch { continue; }
    }
  } catch { /* tag file unreadable */ }
  return null;
}

// ---
// FOLLOW A MOVED SESSION (#155)
// ---

/**
 * The transcript is MOVED, not copied, when a session changes project dirs
 * (worktree enter/exit). One file, one session id, nothing duplicated — so the
 * right response to a vanished path is to find the file again, not to die.
 *
 * Re-points `sessionPath` and returns true when the session was found
 * elsewhere. Deliberately does NOT re-point `tagPath`: `--watch` binds fs.watch
 * to the tag path once and never re-resolves, so holding the output fixed is
 * what lets an attached watch survive the move. One daemon, moving input, fixed
 * output. A `wtft` started afterwards from the new directory still finds that
 * output — getTagPath() searches sibling project dirs for exactly this case.
 *
 * Incremental parsing is untouched: a move preserves size, so the next poll
 * reads from where the last one stopped.
 */
function followMovedSession(): boolean {
  const moved = resolveMovedSession(sessionPath);
  if (!moved) return false;
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] session moved: ${sessionPath} -> ${moved}\n`);
  }
  sessionPath = moved;
  return true;
}

/**
 * Guard for the two places that SIGTERM a daemon whose `--session` path (read
 * from /proc/<pid>/cmdline) no longer exists. After a move the cmdline still
 * shows the old path, so without this every `wtft` run would kill the very
 * daemon #155 exists to keep alive.
 */
function sessionIsGone(sessionCmdlinePath: string): boolean {
  if (fs.existsSync(sessionCmdlinePath)) return false;
  if (resolveMovedSession(sessionCmdlinePath) !== null) return false;
  // Never written ≠ gone (#308). A daemon parked on a transcript Claude Code has
  // not written yet (#124/#129) is doing its job; before this guard the reaper
  // — which runs at every daemon's startup — SIGTERMed it, and SIGTERMed *itself*
  // in the same pass, so the "waiting for session .jsonl" state could never be
  // reached by a live daemon. "Gone" needs evidence the session once existed:
  // a classified line or a _meta offset in the tag file. Absent that, the owner
  // daemon's own SESSION_WAIT_MAX_MS ceiling is the bound, not this reaper.
  return sessionWasEverParsed(sessionCmdlinePath);
}

/** Does the tag file carry evidence the session existed (a classified entry or a _meta offset)? */
function sessionWasEverParsed(sessionCmdlinePath: string): boolean {
  try {
    const tagsDir = path.join(path.dirname(sessionCmdlinePath), "wtft-tags");
    const prefix = path.basename(sessionCmdlinePath) + ".wtft-tag.v";
    for (const f of fs.readdirSync(tagsDir)) {
      if (!f.startsWith(prefix)) continue;
      const content = fs.readFileSync(path.join(tagsDir, f), "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (o.cat !== undefined || o._meta !== undefined) return true;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return false;
}

// ---
// REAP & WARN (#130)
// ---

const WARN_LOG_DIR = path.join(os.homedir(), ".local", "state", "wtft");
const WARN_LOG = path.join(WARN_LOG_DIR, "reap.log");
const TAG_SIZE_WARN = 1_000_000;     // 1 MB — tag file suspiciously large
const HB_RATIO_WARN = 0.9;            // >90% of lines are heartbeats → malfunction
const ZERO_INTERACTIONS_AGE = 3600000; // 1h with zero real interactions → zombie

function reapAndWarn() {
  const pidDir = os.tmpdir();
  let pidFiles: string[] = [];
  try {
    pidFiles = fs.readdirSync(pidDir).filter(f => f.startsWith("wtft-daemon-") && f.endsWith(".pid"));
  } catch (_) {}

  const warnings: string[] = [];

  for (const pidFile of pidFiles) {
    const fullPath = path.join(pidDir, pidFile);
    let pid = 0;
    try {
      pid = parseInt(fs.readFileSync(fullPath, "utf8").trim(), 10);
    } catch (_) { continue; }
    if (pid <= 0) continue;

    // Check if process is alive
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (_) {}

    // Resolve session path from /proc/<pid>/cmdline
    let sessionFound: string | null = null;
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const args = cmdline.split("\0");
      const sessIdx = args.indexOf("--session");
      if (sessIdx >= 0 && sessIdx + 1 < args.length) {
        sessionFound = args[sessIdx + 1];
      }
    } catch (_) {}

    // HARD: stale pidfile (process dead)
    if (!alive) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
      continue;
    }

    // HARD: session file gone → kill daemon. "Gone" excludes "merely moved" (#155)
    // and "not written yet" (#308). Never our own PID — the owner decides for itself.
    if (pid !== process.pid && sessionFound && sessionIsGone(sessionFound)) {
      process.kill(pid, "SIGTERM");
      try { fs.unlinkSync(fullPath); } catch (_) {}
      warnings.push(`[${new Date().toISOString()}] KILLED PID ${pid}: session gone — ${sessionFound}`);
      continue;
    }

    // SOFT: check alive daemon for warning predicates
    if (sessionFound) {
      // Find tag file for this session
      let tagFound: string | null = null;
      try {
        const tagsDir = path.join(path.dirname(sessionFound), "wtft-tags");
        const sessBase = path.basename(sessionFound);
        const prefix = sessBase + ".wtft-tag.v";
        for (const f of fs.readdirSync(tagsDir)) {
          if (f.startsWith(prefix)) {
            tagFound = path.join(tagsDir, f);
            break;
          }
        }
      } catch (_) {}

      if (tagFound) {
        try {
          const stat = fs.statSync(tagFound);
          const content = fs.readFileSync(tagFound, "utf8");
          const lines = content.trim().split("\n");
          const hbLines = lines.filter(l => l.includes('"_hb"') && !l.includes('"stop"'));
          const hbRatio = lines.length > 0 ? hbLines.length / lines.length : 0;

          // SOFT: tag file suspiciously large
          if (stat.size > TAG_SIZE_WARN) {
            const mb = (stat.size / (1024 * 1024)).toFixed(1);
            warnings.push(`[${new Date().toISOString()}] WARN PID ${pid}: tag file large (${mb} MB) — ${tagFound}`);
          }

          // SOFT: heartbeat ratio too high (malfunctioning daemon writing only heartbeats)
          if (lines.length > 10 && hbRatio >= HB_RATIO_WARN) {
            const pct = Math.round(hbRatio * 100);
            warnings.push(`[${new Date().toISOString()}] WARN PID ${pid}: ${pct}% heartbeats (${hbLines.length}/${lines.length} lines) — possible malfunction — ${tagFound}`);
          }

          // SOFT: daemon age with zero real interactions
          // Check if any line in the tag file is a classified interaction (not _hb, not _meta)
          const hasInteractions = lines.some(l => {
            try { const o = JSON.parse(l.trim()); return o.cat !== undefined; } catch { return false; }
          });
          if (!hasInteractions) {
            // Estimate daemon age from first heartbeat
            const firstHb = hbLines[0];
            if (firstHb) {
              try {
                const hb = JSON.parse(firstHb);
                const startTime = hb._hb?.first;
                if (startTime && (Date.now() - startTime) > ZERO_INTERACTIONS_AGE) {
                  const ageH = Math.round((Date.now() - startTime) / 3600000);
                  warnings.push(`[${new Date().toISOString()}] WARN PID ${pid}: ${ageH}h old with zero real interactions — zombie daemon? — ${sessionFound}`);
                }
              } catch (_) {}
            }
          }
        } catch (_) {}
      }
    }
  }

  // SOFT: stale fixture dirs in /tmp with no owning daemon
  try {
    const tmpEntries = fs.readdirSync(os.tmpdir());
    const liveSessions = new Set<string>();
    for (const pidFile of pidFiles) {
      try {
        const fullPath = path.join(pidDir, pidFile);
        const pid = parseInt(fs.readFileSync(fullPath, "utf8").trim(), 10);
        if (pid > 0) {
          const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
          const args = cmdline.split("\0");
          const sessIdx = args.indexOf("--session");
          if (sessIdx >= 0 && sessIdx + 1 < args.length) {
            liveSessions.add(args[sessIdx + 1]);
          }
        }
      } catch (_) {}
    }
    for (const entry of tmpEntries) {
      if (!entry.startsWith("wtft-")) continue;
      const fullDir = path.join(os.tmpdir(), entry);
      let isDir = false;
      try { isDir = fs.statSync(fullDir).isDirectory(); } catch (_) { continue; }
      if (!isDir) continue;
      // Check if any live daemon's session path contains this dir
      const claimed = [...liveSessions].some(s => s.startsWith(fullDir));
      if (!claimed) {
        // Check age: only warn for dirs older than 1h (avoid fresh test dirs)
        try {
          const mtime = fs.statSync(fullDir).mtimeMs;
          if (Date.now() - mtime > 3600000) {
            warnings.push(`[${new Date().toISOString()}] WARN: stale fixture dir with no owning daemon — ${fullDir}`);
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  if (warnings.length > 0) {
    try {
      fs.mkdirSync(WARN_LOG_DIR, { recursive: true });
      fs.appendFileSync(WARN_LOG, warnings.join("\n") + "\n");
    } catch (_) {}
  }
}

function initClassified() {
  // Version is embedded in filename (TAG_SUFFIX), so no _cv header needed.
  // On startup: if the tag file already exists (same version) AND contains
  // actual classified entries (not just heartbeats or _meta lines), resume
  // incrementally from the recorded _meta offset (#124). If no _meta offset
  // exists, fall back to full re-parse.
  // If tag file is missing or only has heartbeats, do a full re-parse.
  let hasData = false;
  try {
    fs.accessSync(tagPath);
    // Check if tag file has actual classified entries (not just _hb or _meta lines).
    const tagContent = fs.readFileSync(tagPath, "utf8");
    hasData = tagContent.split("\n").some(l => l.trim() && !l.includes('"_hb"') && !l.includes('"_meta"'));
    if (hasData) {
      // Tag file has real data — resume from last known byte offset (#124).
      const metaOffset = readLastMetaOffset(tagPath);
      if (metaOffset !== null) {
        lastSize = metaOffset;
      } else {
        // No _meta found — tag file predates offset tracking.
        // Full re-parse — clear the tag file first so old entries
        // don't duplicate when we re-classify everything from scratch.
        try { fs.truncateSync(tagPath, 0); } catch { /* best effort */ }
        lastSize = 0;
      }
    } else {
      // Tag file exists but no classified data (only heartbeats from a
      // previous daemon that exited before its first poll). Full re-parse.
      // Clear the tag file so previous heartbeat/stop lines don't accumulate.
      try { fs.truncateSync(tagPath, 0); } catch { /* best effort */ }
      lastSize = 0;
    }
  } catch (_) {
    // No tag file for this version — fresh start, full reparse on next poll
    lastSize = 0;
  }

  // Write start heartbeat
  const startNow = Date.now();
  fs.appendFileSync(tagPath, JSON.stringify({ _hb: { first: startNow, last: startNow } }) + "\n");
  idleStartMs = startNow;
}

// ---
// MAIN LOOP
// ---

async function main() {
  // User pricing registry (#140) — the daemon computes every per-turn cost
  // baked into tag files, so overrides must merge before any parsing.
  loadUserPricing();

  // Out-of-tree harnesses (#156) — config-declared modules must register
  // before any discovery or parsing. Built-ins need no load step.
  await loadExternalHarnesses();

  // ---
  // ARG PARSING & MANAGEMENT COMMANDS
  // ---

  let showList = false;
  let showCleanup = false;
  let showRestart = false;
  let stopSession = null;

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--session" || arg === "-s") {
      sessionPath = process.argv[++i];
    } else if (arg === "--list" || arg === "-l") {
      showList = true;
    } else if (arg === "--cleanup") {
      showCleanup = true;
    } else if (arg === "--restart") {
      showRestart = true;
    } else if (arg === "--stop") {
      stopSession = process.argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`wtft-daemon — Log parser daemon for WTFT
Usage: wtft-daemon --session <path> [--debug]

Management:
  --list, -l            List all running daemons (session, PID, idle time)
  --cleanup             Kill daemons whose source session no longer exists
  --restart             Kill all running daemons (fresh spawn on next wtft)
  --stop <session>      Stop the daemon for a specific session path

Daemon mode:
  -s, --session <path>  Path to session.jsonl to watch
  --debug               Enable debug logging to stderr
  -h, --help            Show this help`);
      process.exit(0);
    } else if (arg === "--debug") {
      process.env.WTFT_DAEMON_DEBUG = "1";
    }
  }

// --- Management commands (no session required) ---

if (showList || showCleanup || showRestart || stopSession) {
  const pidDir = os.tmpdir();
  let pidFiles: string[] = [];
  try {
    pidFiles = fs.readdirSync(pidDir).filter(f => f.startsWith("wtft-daemon-") && f.endsWith(".pid"));
  } catch (_) {}

  let found = 0;
  for (const pidFile of pidFiles) {
    const fullPath = path.join(pidDir, pidFile);
    let pid = 0;
    try {
      pid = parseInt(fs.readFileSync(fullPath, "utf8").trim(), 10);
    } catch (_) { continue; }
    if (pid <= 0) continue;

    // Check if process is alive
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (_) {}

    // Try to find session path from cmdline
    let sessionFound = null;
    let tagMtime = 0;
    // The PID file name contains a hash — we need to scan for matching classified files
    // Since the hash is derived from session path, we can't reverse it.
    // Instead, check /proc/<pid>/cmdline to find the --session argument.
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const args = cmdline.split("\0");
      const sessIdx = args.indexOf("--session");
      if (sessIdx >= 0 && sessIdx + 1 < args.length) {
        sessionFound = args[sessIdx + 1];
      }
    } catch (_) {}

    // Get tag file mtime and version (look in wtft-tags/ subdirectory)
    let taggerVersion = "?";
    if (sessionFound) {
      try {
        const tagsDir = path.join(path.dirname(sessionFound), "wtft-tags");
        const sessBase = path.basename(sessionFound);
        const prefix = sessBase + ".wtft-tag.v";
        for (const f of fs.readdirSync(tagsDir)) {
          if (f.startsWith(prefix)) {
            tagMtime = fs.statSync(path.join(tagsDir, f)).mtimeMs;
            // Extract version from filename: ...wtft-tag.v2.3.1.jsonl → 2.3.1
            taggerVersion = f.slice(prefix.length, f.length - 6); // strip '.jsonl'
            break;
          }
        }
      } catch (_) {}
    }

    if (showRestart) {
      if (alive) {
        process.kill(pid, "SIGTERM");
      }
      try { fs.unlinkSync(fullPath); } catch (_) {}
      // Re-launch fresh daemon for same session
      if (sessionFound) {
        try {
          const child = spawn(process.execPath, [process.argv[1], "--session", sessionFound], {
            detached: true,
            stdio: "ignore"
          });
          child.unref();
        } catch (_2) {}
      }
      console.log(`Restarted: PID ${pid} → fresh daemon for ${sessionFound || "(unknown)"}`);
      found++;
      continue;
    }

    if (showCleanup) {
      if (!alive) {
        try { fs.unlinkSync(fullPath); } catch (_) {}
        continue;
      }
      if (sessionFound && sessionIsGone(sessionFound)) {
        process.kill(pid, "SIGTERM");
        try { fs.unlinkSync(fullPath); } catch (_) {}
        console.log(`Cleaned up: PID ${pid} — session gone: ${sessionFound}`);
        found++;
        continue;
      }
    }

    if (stopSession && sessionFound === stopSession) {
      if (alive) {
        process.kill(pid, "SIGTERM");
      }
      try { fs.unlinkSync(fullPath); } catch (_) {}
      console.log(`Stopped: PID ${pid} — ${sessionFound}`);
      found++;
      continue;
    }

    if (showList) {
      found++;
      const status = alive ? "RUNNING" : "DEAD (stale pid)";
      let idleStr = "?";
      if (tagMtime > 0) {
        const idleSec = Math.floor((Date.now() - tagMtime) / 1000);
        if (idleSec < 60) idleStr = `${idleSec}s`;
        else if (idleSec < 3600) idleStr = `${Math.floor(idleSec / 60)}m`;
        else idleStr = `${Math.floor(idleSec / 3600)}h`;
      }
      const sessionDisplay = sessionFound || `(hash: ${pidFile.replace(/^wtft-daemon-/, "").replace(/\.pid$/, "")})`;
      console.log(`PID ${String(pid).padEnd(7)} ${status.padEnd(20)} v${taggerVersion.padEnd(7)} idle: ${idleStr.padEnd(5)} ${sessionDisplay}`);
    }
  }

  if (showRestart) {
    console.log(`Restarted ${found} daemon(s). Run wtft to spawn fresh instances.`);
  }
  if (showCleanup) {
    console.log(`Cleaned up ${found} daemon(s).`);
  }
  if (showList && found === 0) {
    console.log("No daemon processes found.");
  }
  if (stopSession && found === 0) {
    console.log(`No daemon found for: ${stopSession}`);
  }
  process.exit(0);
}

// --- Daemon mode (session required) ---

  if (!sessionPath) {
    process.stderr.write("wtft-daemon: --session <path> is required\n");
    process.exit(1);
  }
  // Session file may not exist yet (e.g. Pi TUI started but no prompt
  // entered — session.jsonl is created on first write). The daemon waits
  // in its poll loop until the file appears, writing heartbeats so the
  // widget can show "waiting for session .jsonl..." (#124).
  //
  // Guard: refuse to watch a wtft-tag file (prevents recursive daemon loops).
  if (sessionPath.includes(".wtft-tag.v")) {
    process.stderr.write(`wtft-daemon: refusing to watch a tag cache file: ${sessionPath}\n`);
    process.exit(1);
  }

  // Determine wtft-tag path (wtft-tags/ subdirectory, version in filename).
  // Subdirectory keeps tag files out of session discovery — no filename filter needed.
  const sessionBase = path.basename(sessionPath);
  // Prefer an existing current-version tag wherever it lives — a session that
  // moved project dirs leaves its tag behind, and adopting it keeps one
  // continuous tag file across the switch instead of stranding the fuller
  // artifact in an abandoned directory (#155).
  tagPath = getCurrentVersionTagPath(sessionPath);
  const tagsDir = path.dirname(tagPath);
  try { fs.mkdirSync(tagsDir, { recursive: true }); } catch (_) {}

  // PID file for singleton detection. Keyed on the transcript BASENAME, not the
  // full path (#155): a worktree switch moves the transcript between project
  // dirs, and a path-keyed hash would change under it — a `wtft` run from the
  // new directory would miss the still-live daemon and spawn a second one on
  // the same transcript. Must stay in step with getDaemonPidPath().
  const sessionHash = createHash("sha256").update(
    isSessionIdBasename(sessionPath) ? sessionBase : sessionPath
  ).digest("hex").slice(0, 12);
  pidPath = path.join(os.tmpdir(), `wtft-daemon-${sessionHash}.pid`);

  // Version-aware spawn takeover (#95): if an old-version tag file exists,
  // an old-build daemon may still own this session (it baked its tag path at
  // startup and would heartbeat into the stale file forever). Claim the PID
  // file by overwriting it — the old daemon notices the lost lease on its
  // next beat and exits via the takeover protocol. No SIGTERM: the signal
  // handler race (dying daemon unlinking the new owner's PID file) was the
  // daemon-per-restart leak.
  const prefix = sessionBase + ".wtft-tag.v";
  let claimedByTakeover = false;
  try {
    for (const f of fs.readdirSync(tagsDir)) {
      if (f.indexOf(prefix) === 0 && f !== sessionBase + TAG_SUFFIX) {
        fs.writeFileSync(pidPath, String(process.pid));
        claimedByTakeover = true;
        break;
      }
    }
  } catch (e) {
    process.stderr.write(`[wtft-log-parser] takeover scan error: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // Singleton check — atomic exclusive-create prevents TOCTOU race.
  // Skipped when takeover already claimed the lease above.

  if (!claimedByTakeover) {
    let fd;
    try {
      fd = fs.openSync(pidPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
    } catch (_) {
      // PID file exists — check if the process is still alive
      try {
        const existingPid = parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
        if (existingPid > 0) {
          try {
            process.kill(existingPid, 0);
            // Process exists — another daemon is running, exit quietly
            process.exit(0);
          } catch (_2) {
            // Stale PID — clean up and retry
            fs.unlinkSync(pidPath);
            fd = fs.openSync(pidPath, "wx");
            fs.writeSync(fd, String(process.pid));
            fs.closeSync(fd);
          }
        }
      } catch (_3) {
        // Couldn't read PID — clean up and retry
        try { fs.unlinkSync(pidPath); } catch (_4) {}
        fd = fs.openSync(pidPath, "wx");
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
      }
    }
  }

  // Version hygiene AFTER claiming the lease (#95): other-version tag files
  // are derived caches — regeneration is the point of the version bump.
  // Re-sweep once after 5s to catch a final heartbeat the outgoing daemon
  // may have written into its old file during its last beat window.
  const sweepOldTagFiles = () => {
    try {
      for (const f of fs.readdirSync(tagsDir)) {
        if (f.startsWith(prefix) && f !== sessionBase + TAG_SUFFIX) {
          try { fs.unlinkSync(path.join(tagsDir, f)); } catch (_) {}
          if (process.env.WTFT_DAEMON_DEBUG) {
            process.stderr.write(`[wtft-log-parser] removed stale tag file: ${f}\n`);
          }
        }
      }
    } catch (_) {}
  };
  sweepOldTagFiles();
  const resweep = setTimeout(sweepOldTagFiles, 5000);
  resweep.unref();

  // Reap orphaned daemons and warn on malfunctioning ones (#130).
  // This is the auto-invocation that was missing — before #130, cleanup
  // only ran when a human explicitly typed `wtft --cleanup`.
  reapAndWarn();

  // Initialize tag file (version check, header, start heartbeat)
  initClassified();

  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] started, watching: ${sessionPath}\n`);
    process.stderr.write(`[wtft-log-parser] classified: ${tagPath}\n`);
    process.stderr.write(`[wtft-log-parser] pid: ${process.pid}\n`);
  }

  // --- Main poll loop ---
  const loop = () => {
    if (!running) return;

    // Takeover protocol (#95): ownership of the PID file IS ownership of the
    // session. If the lease no longer holds our PID (another daemon claimed
    // it, or the file is gone), exit before writing anything — the check runs
    // first each beat so a superseded daemon dies within one beat.
    try {
      if (fs.readFileSync(pidPath, "utf8").trim() !== String(process.pid)) {
        running = false;
        process.exit(0);
      }
    } catch (_) {
      running = false;
      process.exit(0);
    }

    // If session file doesn't exist yet (Pi session just started, no
    // prompt entered), wait for it to be created. Write heartbeats so
    // the widget knows the daemon is alive and waiting (#124).
    if (!fs.existsSync(sessionPath)) {
      // Was it previously seen and then deleted? Distinguish MOVED from DELETED
      // first (#155): a worktree switch moves the transcript to a project dir
      // derived from the new cwd, so the path vanishes while the session is
      // very much alive. Only shut down when no harness can find it.
      // If never seen yet, keep waiting — the session file is just late (#129 Bug A).
      if (sessionExisted) {
        if (!followMovedSession()) {
          shutdown("session removed");
          return;
        }
      }
      const now = Date.now();
      // Never seen, and past the wait ceiling → the session never got a prompt (#308).
      if (!sessionExisted && now - startupTime >= SESSION_WAIT_MAX_MS) {
        shutdown("session never written");
        return;
      }
      if (idleStartMs === 0) idleStartMs = now;
      upsertHeartbeat(now);
      lastWriteMs = now;
      // Update lastActivityMs so the idle-exit timer doesn't kill a daemon
      // that's been waiting for the session file since startup.
      lastActivityMs = now;
      setTimeout(loop, POLL_MS);
      return;
    }
    sessionExisted = true; // confirmed session file present at least once (#129 Bug A)

    try {
      // Per POLL, not per sweep (#443). Reset here rather than at the top of
      // scanForSubAgents, because flushPending runs BEFORE that function and can
      // also fail — resetting inside the sweep wiped the flush's own failure a
      // few statements after it was set, which would have let the marker stamp
      // over a lost parent batch. Per poll rather than per daemon because a
      // transcript that failed last poll and succeeds this one must not keep the
      // tag provisional forever; the warned* Sets are cumulative by design and
      // cannot answer "was THIS poll clean".
      pollHadFailure = false;
      // Read new lines from session, dedup by message.id (#54), then classify.
      const rawInteractions = parseNewLines(sessionPath);
      // Late interrupt marker: the killed turn is the unflushed tail of
      // pendingItems (order is preserved; anything newer would have caught
      // the stamp inside parseNewLines).
      if (stampInterruptOnPending) {
        if (pendingItems.length > 0) {
          pendingItems[pendingItems.length - 1].interaction.interrupted = true;
        }
        stampInterruptOnPending = false;
      }
      const newInteractions = deduplicateInteractions(rawInteractions);
      if (newInteractions.length > 0) {
        lastActivityMs = Date.now();
        for (const interaction of newInteractions) {
          // prevCtx is captured per-interaction in arrival order — the
          // recache signature compares against the previous non-sidechain
          // message's context size (#52 Phase 3).
          pendingItems.push({ interaction, prevCtx: prevCtxTokens });
          if (!interaction.isSidechain) {
            prevCtxTokens = interaction.inputTokens + interaction.cacheReadTokens + interaction.cacheWriteTokens;
          }
          // Track claude -p commands for sub-agent discovery (#138)
          if (hasClaudeCommand(interaction)) {
            pendingClaudeCommands.push({ interaction, prevCtx: prevCtxTokens });
          }
        }
      }

      // Throttled flush: write at most every 667ms
      const now = Date.now();
      if (pendingItems.length > 0 && (now - lastWriteMs) >= POLL_MS) {
        flushPending();
      }

      // Sub-agent discovery (#82, #138): scan for completed sub-agent
      // sessions (task/agent spawns and claude -p bash commands) and
      // write their classified interactions to the tag file.
      scanForSubAgents();

      // Heartbeat: on every poll cycle when idle, update the _hb range line.
      // First idle poll appends {"_hb":{"first":<ts>}}. Subsequent idle polls
      // overwrite the last line in-place with {"_hb":{"first":<ts>,"last":<ts>}}.
      // When data arrives, the idle period ends — next idle starts a new line.
      // NOTE: do NOT update lastActivityMs here — it tracks actual data activity
      // for the idle-exit check below, not heartbeat flushes.
      if (pendingItems.length === 0) {
        if (idleStartMs === 0) idleStartMs = now;
        upsertHeartbeat(now);
        lastWriteMs = now;
      }

      // Idle exit: if no new interactions have been classified in >24h,
      // assume the session is finished and shut down cleanly.
      // Skip idle exit during the first 60s of daemon runtime (startup grace
      // period) so freshly-spawned daemons aren't killed on their first cycle.
      if (now - lastActivityMs >= IDLE_EXIT_MS && now - startupTime >= 60000) {
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-log-parser] no new data for ${Math.round((now - lastActivityMs)/60000)}m, exiting\n`);
        }
        shutdown("idle timeout");
        return;
      }

      // If the session file disappears, follow it if it merely moved (#155);
      // otherwise exit cleanly.
      if (!fs.existsSync(sessionPath) && !followMovedSession()) {
        shutdown("session removed");
        return;
      }
    } catch (err) {
      // Transient error (disk full, permission denied, corrupted JSON) —
      // log and continue. Don't crash the daemon on a single bad poll cycle.
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] poll error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    setTimeout(loop, POLL_MS);
  };

  // Initial full classification if no existing cache
  // parseNewLines handles incremental via lastSize. If this is a fresh start,
  // lastSize is 0 and we'll parse all existing lines.
  loop();
}

main().catch((err) => {
  process.stderr.write(`wtft-daemon: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});

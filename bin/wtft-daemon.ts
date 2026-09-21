#!/usr/bin/env -S node --experimental-strip-types


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
	foldRecordLine,
	foldRecordIds,
	applyControlEntry,
	newParseStreamState,
	extractCwdFromBashCommand,
	cwdForClaudeSpawn,
	commandSpawnsAgent,
	extractRealCommands,
	discoverClaudeSubAgentSessionFiles,
	discoverSubagentSessionFiles,
	clearSubagentCacheMiss,
	loadUserPricing,
	resolveMovedSession,
	getCurrentVersionTagPath,
	isSessionIdBasename,
	loadExternalHarnesses,
	warnUnreadableTranscript,
	WTFT_TAGGER_VERSION as TAGGER_VERSION,
	lastLineStartByte,
} from "../extensions/lib/wtft-shared.js";


// ---

const TAG_SUFFIX = `.wtft-tag.v${TAGGER_VERSION}.jsonl`;
const POLL_MS = 667; // 90bpm throttle
const IDLE_EXIT_MS = 24 * 60 * 60 * 1000;
// Park at most 1h on a session.jsonl that has never appeared; only the never-seen case uses this ceiling.
const SESSION_WAIT_MAX_MS = 60 * 60 * 1000;

// ---

let sessionPath = "";
let tagPath = "";
let pidPath = "";
let rebuildTagOnStartup = false;
let lastSize = 0;
// Trailing partial line as BYTES: advance offset each poll; settle a same-bytes fragment that parses as JSON (writer died without newline).
let pendingFragment: Buffer = Buffer.alloc(0);
let lastWriteMs = 0; // last time we flushed to the tag file
let lastActivityMs = Date.now(); // last time we classified a new interaction
let startupTime = Date.now();
let pendingItems: { interaction: NonNullable<ReturnType<typeof parseEntryToInteraction>>; prevCtx: number }[] = [];
let idleStartMs = 0;
const streamState = newParseStreamState();
let stampInterruptOnPending = false;
let prevCtxTokens = 0;
let running = true;
let sessionExisted = false;

const pendingClaudeCommands: { interaction: NonNullable<ReturnType<typeof parseEntryToInteraction>>; prevCtx: number }[] = [];
const discoveredClaudeFiles = new Set<string>();
/** Session ids this daemon has written a `_fold` record for. The CLI's spawn
 *  walk skips exactly these, so a fold with no record is billed twice. */
const recordedFolds = new Set<string>();
// Starts true: an inherited tag's swept marker is untrusted until this daemon re-stamps after its own sweep.
let tagGrewSinceMarker = true;
// Set when a sweep could not read what it meant to; withholds the swept stamp.
let pollHadFailure = false;
// After unswept retraction, stamp on next clean poll even if the tag did not grow.
let sweptRetracted = false;
/** Quiet longer than coarsest mtime tick before a no-change skip is safe. */
const MTIME_SETTLE_MS = 2000;

const warnedSubagentStatFailure = new Set<string>();
const warnedSubagentParseFailure = new Set<string>();
const warnedSubagentSerializeFailure = new Set<string>();

/** Per-transcript change detector + multiset of written line hashes (append filter). */
interface SubagentFileState {
	size: number;
	mtimeMs: number;
	/** Last read time — closes the same-tick mtime window with MTIME_SETTLE_MS. */
	readAtMs: number;
	writtenLines: Map<string, number>;
}

// Subagent transcripts: re-parse WHOLE on change; incremental windows break id-collapse and nested attribution.
const discoveredSubagentFiles = new Map<string, SubagentFileState>();

// ---

function shutdown(reason: string) {
  if (!running) return;
  running = false;
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] shutdown: ${reason}\n`);
  }
  // Taken-over daemon exits silently — must not recreate the tag or unlink the new owner's lease.
  let ownsLease = false;
  try {
    ownsLease = fs.readFileSync(pidPath, "utf8").trim() === String(process.pid);
  } catch (_) {}
  if (ownsLease) {
    flushPending();
    try {
      if (fs.existsSync(tagPath)) {
        appendTagFile(tagPath, JSON.stringify({ _hb: "stop" }) + "\n");
      }
    } catch (_) {}
    try { fs.unlinkSync(pidPath); } catch (_) {}
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

// ---

/** Overwrite same-width heartbeat in place (fixed-width pwrite); else append. File never shrinks. */
function upsertHeartbeat(now: number) {
  const hbLine = JSON.stringify({ _hb: { first: idleStartMs, last: now } }) + "\n";
  const hbBuf = Buffer.from(hbLine, "utf8");
  try {
    const fd = fs.openSync(tagPath, "r+");
    try {
      const size = fs.fstatSync(fd).size;
      const lineStart = size > 0 ? lastLineStartByte(fd, size) : 0;
      if (size - lineStart === hbBuf.length) {
        const lineBuf = Buffer.alloc(hbBuf.length);
        fs.readSync(fd, lineBuf, 0, lineBuf.length, lineStart);
        let isHb = false;
        try {
          const obj = JSON.parse(lineBuf.toString("utf8").trim());
          isHb = obj !== null && typeof obj === "object" && obj._hb !== undefined;
        } catch (_) { /* not a heartbeat we can recognise — append beside it */ }
        if (isHb) {
          fs.writeSync(fd, hbBuf, 0, hbBuf.length, lineStart);
          return;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
  }
  appendTagFile(tagPath, hbLine);
}

/** Atomically replace the published lease without exposing an empty file. */
function replaceLease(value: string): void {
  const replacement = `${pidPath}.replace-${process.pid}`;
  try {
    fs.writeFileSync(replacement, value);
    fs.renameSync(replacement, pidPath);
  } catch (err) {
    try { fs.unlinkSync(replacement); } catch (_) {}
    throw err;
  }
}

/** Cut an unterminated tag tail left by a killed append. Caller rebuilds the tag — resume after a cut can double-bill id-less turns. */
function truncatePartialTail(path: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(path, "r+");
  } catch (_) {
    return false;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return false;
    const lineStart = lastLineStartByte(fd, size);
    fs.ftruncateSync(fd, lineStart);
    return true;
  } catch (err) {
    fatalTagMutation(path, "partial-tail truncate", err);
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

/** Stop after an append whose on-disk extent is unknowable; publish a rebuild lease for the next owner. */
function fatalTagMutation(filePath: string, operation: "append" | "rebuild truncate" | "partial-tail truncate", err: unknown): never {
  running = false;
  let markedForRebuild = false;
  try {
    replaceLease("rebuild");
    markedForRebuild = true;
  } catch (_) {}
  try {
    fs.writeSync(2,
      `[wtft-log-parser] FATAL: the derived tag ${operation} failed (${err instanceof Error ? err.message : String(err)}). ` +
      (markedForRebuild
        ? "The daemon lease now requires a rebuild; restart wtft to rederive the transient tag."
        : "The rebuild lease could not be recorded; restore storage, then run wtft -F to discard and rederive the transient tag.") +
      ` Tag: ${filePath}\n`,
    );
  } catch (_) {}
  process.exit(1);
}

/** Append whole lines only; readers may assume no mid-file fragment. */
function appendTagFile(filePath: string, batch: string): void {
  if (batch.length > 0 && !batch.endsWith("\n")) {
    fatalTagMutation(filePath, "append", new Error(
      `refusing to append a batch that does not end in a newline (${Buffer.byteLength(batch, "utf8")} bytes) — ` +
      "a tag file is JSONL and its readers presume whole lines (#130)",
    ));
  }
  try {
    fs.appendFileSync(filePath, batch);
  } catch (err) {
    fatalTagMutation(filePath, "append", err);
  }
}

function flushPending() {
  if (pendingItems.length === 0) return;
  const batch = pendingItems.map(it => serializeClassifiedWithOverheadSplit(it.interaction, it.prevCtx)).join("");
  appendTagFile(tagPath, batch);
  tagGrewSinceMarker = true;
  appendTagFile(tagPath, JSON.stringify({ _meta: { offset: lastSize } }) + "\n");
  pendingItems = [];
  idleStartMs = 0;
  lastWriteMs = Date.now();
}

function hasClaudeCommand(interaction: NonNullable<ReturnType<typeof parseEntryToInteraction>>): boolean {
  return interaction.commands.some(commandSpawnsAgent);
}

function syncSubagentTranscript(file: string): boolean {
  let wroteAny = false;
  const stateKey = file;
  const sessionId = path.basename(file, '.jsonl');
  let fileState = discoveredSubagentFiles.get(stateKey);
  if (!fileState) {
    fileState = { size: -1, mtimeMs: -1, readAtMs: 0, writtenLines: new Map<string, number>() };
    discoveredSubagentFiles.set(stateKey, fileState);
  }

  let size: number;
  let mtimeMs: number;
  try {
    const stat = fs.statSync(file);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch (err) {
    // Stat failure: warn once per transcript; mark poll failed; retry next poll.
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
  // Skip only when size+mtime unchanged AND settled past MTIME_SETTLE_MS (one clock: Date.now() since our read).
  const changed = size !== fileState.size || mtimeMs !== fileState.mtimeMs;
  const settled = Date.now() - fileState.readAtMs > MTIME_SETTLE_MS;
  if (!changed && settled) {
    return wroteAny;
  }
  if (!changed && process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] subagent transcript unchanged but not yet settled, re-reading to close the same-tick window: ${path.basename(file)}\n`);
  }

  if (size < fileState.size) {
    fileState.writtenLines.clear();
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-log-parser] subagent transcript truncated, re-parsing from zero: ${path.basename(file)}\n`);
    }
  }

  let deduped: ReturnType<typeof deduplicateInteractions>;
  try {
    deduped = deduplicateInteractions(parseSessionFile(file));
    clearSubagentCacheMiss(deduped);
  } catch (err) {
    pollHadFailure = true;
    if (!warnedSubagentParseFailure.has(stateKey)) {
      warnedSubagentParseFailure.add(stateKey);
      process.stderr.write(
        `[wtft-log-parser] WARNING: a subagent transcript could not be read or parsed, so its cost may be missing from this session's total until it succeeds (${sessionId}): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-log-parser] subagent read or parse error (${sessionId}), will retry next poll: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return wroteAny;
  }

  let batch = '';
  const freshHashes: string[] = [];
  try {
    const seenThisParse = new Map<string, number>();
    for (const si of deduped) {
      const line = serializeClassified(si);
      const hash = createHash('sha1').update(line).digest('hex');
      const nth = (seenThisParse.get(hash) || 0) + 1;
      seenThisParse.set(hash, nth);
      if (nth <= (fileState.writtenLines.get(hash) || 0)) continue;
      batch += line;
      freshHashes.push(hash);
    }
  } catch (err) {
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

  // After the lines, in the same append: a reader never sees a record whose money is not yet in the tag.
  const parent = path.basename(sessionPath, ".jsonl");
  const freshFolds: string[] = [];
  for (const id of foldRecordIds(sessionId, deduped)) {
    if (recordedFolds.has(id)) continue;
    batch += foldRecordLine(parent, id);
    freshFolds.push(id);
  }

  if (batch) {
    appendTagFile(tagPath, batch);
    wroteAny = true;
    tagGrewSinceMarker = true;
  }
  for (const id of freshFolds) recordedFolds.add(id);
  for (const h of freshHashes) {
    fileState.writtenLines.set(h, (fileState.writtenLines.get(h) || 0) + 1);
  }
  fileState.size = size;
  fileState.mtimeMs = mtimeMs;
  if (changed) fileState.readAtMs = Date.now();
  return wroteAny;
}

function scanForSubAgents() {
  let wroteAny = false;
  // pollHadFailure is reset by the poll loop, not here — flushPending runs first and can fail.

  if (pendingClaudeCommands.length > 0) {
    const stillPending: typeof pendingClaudeCommands = [];
    for (const item of pendingClaudeCommands) {
      const interaction = item.interaction;
      const cwd = cwdForClaudeSpawn(interaction.commands);
      if (!cwd) continue;

      let discovered: Awaited<ReturnType<typeof discoverClaudeSubAgentSessionFiles>>;
      try {
        discovered = discoverClaudeSubAgentSessionFiles(cwd, interaction.timestamp);
      } catch (err) {
        pollHadFailure = true;
        stillPending.push(item);
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-log-parser] claude -p discovery failed, will retry next poll (${path.basename(cwd)}): ${err instanceof Error ? err.message : String(err)}\n`);
        }
        continue;
      }
      if (discovered.files.length === 0 && !discovered.unreadable) {
        stillPending.push(item);
        continue;
      }
      for (const file of discovered.files) {
        discoveredClaudeFiles.add(file);
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-log-parser] claude -p subagent registered for re-parse (${path.basename(file, '.jsonl')})\n`);
        }
      }
      if (discovered.unreadable) {
        pollHadFailure = true;
        stillPending.push(item);
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-log-parser] claude -p discovery candidate unreadable, will retry next poll (${path.basename(cwd)}): ${discovered.unreadable.message}\n`);
        }
      }
    }
    pendingClaudeCommands.length = 0;
    if (stillPending.length > 0) pendingClaudeCommands.push(...stillPending);
  }

  let taskAgentFiles: string[] = [];
  try {
    const discoveredPi = discoverSubagentSessionFiles(sessionPath);
    taskAgentFiles = discoveredPi.files;
    if (discoveredPi.unreadable) {
      pollHadFailure = true;
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] Pi discovery candidate unreadable, will retry next poll (${path.basename(sessionPath)}): ${discoveredPi.unreadable.message}\n`);
      }
    }
  } catch (err) {
    pollHadFailure = true;
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-log-parser] subagents dir discovery failed, will retry next poll (${path.basename(sessionPath)}): ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  for (const file of taskAgentFiles) {
    wroteAny = syncSubagentTranscript(file) || wroteAny;
  }

  for (const file of discoveredClaudeFiles) {
    wroteAny = syncSubagentTranscript(file) || wroteAny;
  }

  if (wroteAny) {
    lastWriteMs = Date.now();
    idleStartMs = 0;
  }

  // Stamp _meta.swept when the poll was clean and the tag grew (or an unswept was retracted).
  if (!pollHadFailure && (tagGrewSinceMarker || sweptRetracted)) {
    appendTagFile(tagPath, JSON.stringify({ _meta: { swept: Date.now() } }) + "\n");
    tagGrewSinceMarker = false;
    sweptRetracted = false;
  }
}

function parseNewLines(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    const currentSize = stat.size;
    if (currentSize < lastSize) {
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] session truncated, resetting offset\n`);
      }
      lastSize = 0;
      pendingFragment = Buffer.alloc(0);
    }
    const grew = currentSize > lastSize;
    // With a held fragment, still run — quiet poll is when a dead-writer fragment can settle.
    if (!grew && pendingFragment.length === 0) return [];

    let fresh = Buffer.alloc(0);
    if (grew) {
      const fd = fs.openSync(filePath, "r");
      fresh = Buffer.alloc(currentSize - lastSize);
      try {
        fs.readSync(fd, fresh, 0, fresh.length, lastSize);
      } finally {
        fs.closeSync(fd);
      }
      lastSize = currentSize;
    }
    const buf = pendingFragment.length > 0 ? Buffer.concat([pendingFragment, fresh]) : fresh;
    const lastNl = buf.lastIndexOf(0x0a);
    const fragment = buf.subarray(lastNl + 1);

    // Same-bytes fragment that parses as JSON: writer died without newline — take it.
    let settledFragment = false;
    if (fragment.length > 0 && fragment.equals(pendingFragment)) {
      try { JSON.parse(fragment.toString("utf8")); settledFragment = true; } catch (_) { /* still mid-record */ }
    }

    if (lastNl === -1 && !settledFragment) {
      pendingFragment = Buffer.from(buf);
      return [];
    }
    const consumeTo = settledFragment ? buf.length : lastNl + 1;
    pendingFragment = consumeTo >= buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(consumeTo));
    const newContent = buf.subarray(0, consumeTo).toString("utf8");
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
          streamState.compactionTokensBefore = undefined;
          streamState.afterCompaction = false;
        }
      } catch (_) {
      }
    }
    return interactions;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    warnUnreadableTranscript(filePath, "at discovery", err, "the session transcript");
    pollHadFailure = true;
    invalidateStaleSweptMarker(filePath);
    return [];
  }
}

/** Retract a swept marker stamped before this failure so the tag reads provisional. */
function invalidateStaleSweptMarker(filePath: string) {
  try {
    const tagPath = getCurrentVersionTagPath(filePath);
    const lines = fs.readFileSync(tagPath, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let obj: Record<string, unknown> | null = null;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      // Same backward scan as tagProvisionalFromContent: pass hb/offset; retract swept; stop on classified.
      if (obj?.["_hb"]) continue;
      const meta = (obj?.["_meta"] ?? {}) as Record<string, unknown>;
      if (typeof meta.unswept === "number") return;
      if (typeof meta.swept === "number") {
        appendTagFile(tagPath, JSON.stringify({ _meta: { unswept: Date.now() } }) + "\n");
        sweptRetracted = true;
        return;
      }
      if (obj?.["_meta"]) continue;
      return;
    }
  } catch {
  }
}

// ---

/** Returns null if no _meta line found (tag file predates offset tracking). */
function readLastMetaOffset(tagPath: string): number | null {
  try {
    const stat = fs.statSync(tagPath);
    if (stat.size === 0) return null;
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

/** Session move: re-point sessionPath only; keep tagPath fixed so --watch survives. */
function followMovedSession(): boolean {
  const moved = resolveMovedSession(sessionPath);
  if (!moved) return false;
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] session moved: ${sessionPath} -> ${moved}\n`);
  }
  sessionPath = moved;
  return true;
}

/** Gone means not merely moved, and not never-written. */
function sessionIsGone(sessionCmdlinePath: string): boolean {
  if (fs.existsSync(sessionCmdlinePath)) return false;
  if (resolveMovedSession(sessionCmdlinePath) !== null) return false;
  // Never-written ≠ gone; require tag evidence the session once existed before reaping.
  return sessionWasEverParsed(sessionCmdlinePath);
}

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

const WARN_LOG_DIR = path.join(os.homedir(), ".local", "state", "wtft");
const WARN_LOG = path.join(WARN_LOG_DIR, "reap.log");
const TAG_SIZE_WARN = 1_000_000; // 1 MB — tag file suspiciously large
const HB_RATIO_WARN = 0.9; // >90% of lines are heartbeats → malfunction
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

    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (_) {}

    let sessionFound: string | null = null;
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const args = cmdline.split("\0");
      const sessIdx = args.indexOf("--session");
      if (sessIdx >= 0 && sessIdx + 1 < args.length) {
        sessionFound = args[sessIdx + 1];
      }
    } catch (_) {}

    if (!alive) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
      continue;
    }

    // HARD: session gone (not moved, not never-written). Never our own PID.
    if (pid !== process.pid && sessionFound && sessionIsGone(sessionFound)) {
      process.kill(pid, "SIGTERM");
      try { fs.unlinkSync(fullPath); } catch (_) {}
      warnings.push(`[${new Date().toISOString()}] KILLED PID ${pid}: session gone — ${sessionFound}`);
      continue;
    }

    if (sessionFound) {
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

          if (stat.size > TAG_SIZE_WARN) {
            const mb = (stat.size / (1024 * 1024)).toFixed(1);
            warnings.push(`[${new Date().toISOString()}] WARN PID ${pid}: tag file large (${mb} MB) — ${tagFound}`);
          }

          if (lines.length > 10 && hbRatio >= HB_RATIO_WARN) {
            const pct = Math.round(hbRatio * 100);
            warnings.push(`[${new Date().toISOString()}] WARN PID ${pid}: ${pct}% heartbeats (${hbLines.length}/${lines.length} lines) — possible malfunction — ${tagFound}`);
          }

          const hasInteractions = lines.some(l => {
            try { const o = JSON.parse(l.trim()); return o.cat !== undefined; } catch { return false; }
          });
          if (!hasInteractions) {
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
      const claimed = [...liveSessions].some(s => s.startsWith(fullDir));
      if (!claimed) {
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

  // Mid-line tag tail → rebuild, do not resume (cut alone can double-bill id-less turns).
  if (truncatePartialTail(tagPath)) {
    process.stderr.write(`[wtft-log-parser] ${tagPath} ended mid-line — a previous daemon was killed inside an append; rebuilding this tag from the transcript (#130)\n`);
    rebuildTagOnStartup = true;
  }

  if (rebuildTagOnStartup) {
    try {
      fs.truncateSync(tagPath, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        fatalTagMutation(tagPath, "rebuild truncate", err);
      }
    }
    lastSize = 0;
  } else {
    try {
      fs.accessSync(tagPath);
      const tagContent = fs.readFileSync(tagPath, "utf8");
      const hasData = tagContent.split("\n").some(l => l.trim() && !l.includes('"_hb"') && !l.includes('"_meta"'));
      if (hasData) {
        const metaOffset = readLastMetaOffset(tagPath);
        if (metaOffset !== null) {
          lastSize = metaOffset;
        } else {
          try { fs.truncateSync(tagPath, 0); } catch { /* best effort */ }
          lastSize = 0;
        }
      } else {
        try { fs.truncateSync(tagPath, 0); } catch { /* best effort */ }
        lastSize = 0;
      }
    } catch (_) {
      lastSize = 0;
    }
  }

  const startNow = Date.now();
  appendTagFile(tagPath, JSON.stringify({ _hb: { first: startNow, last: startNow } }) + "\n");
  idleStartMs = startNow;
}

// ---

async function main() {
  loadUserPricing();

  await loadExternalHarnesses();

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

    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (_) {}

    let sessionFound = null;
    let tagMtime = 0;
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const args = cmdline.split("\0");
      const sessIdx = args.indexOf("--session");
      if (sessIdx >= 0 && sessIdx + 1 < args.length) {
        sessionFound = args[sessIdx + 1];
      }
    } catch (_) {}

    let taggerVersion = "?";
    if (sessionFound) {
      try {
        const tagsDir = path.join(path.dirname(sessionFound), "wtft-tags");
        const sessBase = path.basename(sessionFound);
        const prefix = sessBase + ".wtft-tag.v";
        for (const f of fs.readdirSync(tagsDir)) {
          if (f.startsWith(prefix)) {
            tagMtime = fs.statSync(path.join(tagsDir, f)).mtimeMs;
            taggerVersion = f.slice(prefix.length, f.length - 6);
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
  // Session file may not exist yet; wait in the poll loop with heartbeats.
  if (sessionPath.includes(".wtft-tag.v")) {
    process.stderr.write(`wtft-daemon: refusing to watch a tag cache file: ${sessionPath}\n`);
    process.exit(1);
  }

  const sessionBase = path.basename(sessionPath);
  // Prefer an existing current-version tag wherever it lives (session may have moved).
  tagPath = getCurrentVersionTagPath(sessionPath);
  const tagsDir = path.dirname(tagPath);
  try { fs.mkdirSync(tagsDir, { recursive: true }); } catch (_) {}

  // PID lease keyed on transcript basename so a worktree move does not spawn a second daemon.
  const sessionHash = createHash("sha256").update(
    isSessionIdBasename(sessionPath) ? sessionBase : sessionPath
  ).digest("hex").slice(0, 12);
  pidPath = path.join(os.tmpdir(), `wtft-daemon-${sessionHash}.pid`);

  // Old-version tag: claim the lease; old daemon exits on lost lease (no SIGTERM race).
  const prefix = sessionBase + ".wtft-tag.v";
  let claimedByTakeover = false;
  try {
    for (const f of fs.readdirSync(tagsDir)) {
      if (f.indexOf(prefix) === 0 && f !== sessionBase + TAG_SUFFIX) {
        // Honor an existing rebuild lease before version-takeover claim.
        try {
          if (fs.readFileSync(pidPath, "utf8").trim() === "rebuild") {
            rebuildTagOnStartup = true;
          }
        } catch (_) {}
        replaceLease(String(process.pid));
        claimedByTakeover = true;
        break;
      }
    }
  } catch (e) {
    process.stderr.write(`[wtft-log-parser] takeover scan error: ${e instanceof Error ? e.message : String(e)}\n`);
  }


  if (!claimedByTakeover) {
    // Publish a fully-populated inode with an exclusive hard link (no empty-lease window).
    const tryClaimLease = (): boolean => {
      const candidate = `${pidPath}.claim-${process.pid}`;
      try {
        fs.writeFileSync(candidate, String(process.pid));
        fs.linkSync(candidate, pidPath);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw err;
      } finally {
        try { fs.unlinkSync(candidate); } catch (_) {}
      }
    };

    while (!tryClaimLease()) {
      // Only the explicit rebuild token requests replay; a stale numeric PID does not.
      let lease: string;
      let observedLease: fs.Stats;
      try {
        lease = fs.readFileSync(pidPath, "utf8").trim();
        observedLease = fs.statSync(pidPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }

      const existingPid = /^[1-9]\d*$/.test(lease) ? Number(lease) : 0;
      if (lease === "rebuild") {
        rebuildTagOnStartup = true;
      } else if (Number.isSafeInteger(existingPid) && existingPid > 0) {
        try {
          process.kill(existingPid, 0);
          process.exit(0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
            process.exit(0);
          }
        }
      }

      // Re-prove inode+value before unlink — never drop a newer owner's lease on stale evidence.
      try {
        const currentLease = fs.statSync(pidPath);
        if (currentLease.dev !== observedLease.dev || currentLease.ino !== observedLease.ino) continue;
        if (fs.readFileSync(pidPath, "utf8").trim() !== lease) continue;
        fs.unlinkSync(pidPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }

  // Drop other-version tag files after claiming the lease; re-sweep once after 5s for a late heartbeat.
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

  reapAndWarn();

  initClassified();

  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] started, watching: ${sessionPath}\n`);
    process.stderr.write(`[wtft-log-parser] classified: ${tagPath}\n`);
    process.stderr.write(`[wtft-log-parser] pid: ${process.pid}\n`);
  }

  const loop = () => {
    if (!running) return;

    try {
      if (fs.readFileSync(pidPath, "utf8").trim() !== String(process.pid)) {
        running = false;
        process.exit(0);
      }
    } catch (_) {
      running = false;
      process.exit(0);
    }

    if (!fs.existsSync(sessionPath)) {
      // Previously seen and missing: follow a move before treating as removed.
      if (sessionExisted) {
        if (!followMovedSession()) {
          shutdown("session removed");
          return;
        }
      }
      const now = Date.now();
      if (!sessionExisted && now - startupTime >= SESSION_WAIT_MAX_MS) {
        shutdown("session never written");
        return;
      }
      if (idleStartMs === 0) idleStartMs = now;
      upsertHeartbeat(now);
      lastWriteMs = now;
      lastActivityMs = now;
      setTimeout(loop, POLL_MS);
      return;
    }
    sessionExisted = true;

    try {
      // Reset pollHadFailure per poll (flushPending can fail before scanForSubAgents).
      pollHadFailure = false;
      const rawInteractions = parseNewLines(sessionPath);
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
          pendingItems.push({ interaction, prevCtx: prevCtxTokens });
          if (!interaction.isSidechain) {
            prevCtxTokens = interaction.inputTokens + interaction.cacheReadTokens + interaction.cacheWriteTokens;
          }
          if (hasClaudeCommand(interaction)) {
            pendingClaudeCommands.push({ interaction, prevCtx: prevCtxTokens });
          }
        }
      }

      const now = Date.now();
      if (pendingItems.length > 0 && (now - lastWriteMs) >= POLL_MS) {
        flushPending();
      }

      scanForSubAgents();

      // Idle heartbeat always full-width {first,last} so in-place overwrite stays same size.
      if (pendingItems.length === 0) {
        if (idleStartMs === 0) idleStartMs = now;
        upsertHeartbeat(now);
        lastWriteMs = now;
      }

      if (now - lastActivityMs >= IDLE_EXIT_MS && now - startupTime >= 60000) {
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-log-parser] no new data for ${Math.round((now - lastActivityMs)/60000)}m, exiting\n`);
        }
        shutdown("idle timeout");
        return;
      }

      if (!fs.existsSync(sessionPath) && !followMovedSession()) {
        shutdown("session removed");
        return;
      }
    } catch (err) {
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] poll error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    setTimeout(loop, POLL_MS);
  };

  loop();
}

main().catch((err) => {
  process.stderr.write(`wtft-daemon: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});

#!/usr/bin/env -S node --experimental-strip-types


import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { projectsDir } from "../extensions/lib/harness/claude-code/discovery.js";
import {
	parseEntryToInteraction,
	parseSessionFile,
	deduplicateInteractions,
	attributeClaudeSubAgentCosts,
	serializeClassified,
	serializeClassifiedWithOverheadSplit,
	foldRecordLine,
	foldRecordIds,
	generationRecordLine,
	transcriptSourceId,
	fileStamp,
	claudeSpawnWindowClosesAt,
	CLAUDE_SUBAGENT_WINDOW_MS,
	applyControlEntry,
	newParseStreamState,
	extractCwdFromBashCommand,
	resolveLastCwd,
	commandSpawnsAgent,
	extractRealCommands,
	discoverClaudeSubAgentFilesForTurn,
	canonicalTranscriptPath,
	discoverSubagentSessionFiles,
	clearSubagentCacheMiss,
	loadUserPricing,
	resolveMovedSession,
	getCurrentVersionTagPath,
	getDaemonPidPath,
	daemonLaunchArgs,
	isSessionIdBasename,
	loadExternalHarnesses,
	warnUnreadableTranscript,
	WTFT_TAGGER_VERSION as TAGGER_VERSION,
	lastLineStartByte,
} from "../extensions/lib/wtft-shared.js";


// ---

const TAG_SUFFIX = `.wtft-tag.v${TAGGER_VERSION}.jsonl`;
const POLL_MS = 667; // 90bpm throttle
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : fallback;
}
const IDLE_EXIT_MS = envMs("WTFT_DAEMON_IDLE_MS", 24 * 60 * 60 * 1000);
const STARTUP_GRACE_MS = envMs("WTFT_DAEMON_STARTUP_GRACE_MS", 60 * 1000);
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
let streamState = newParseStreamState();
let stampInterruptOnPending = false;
let prevCtxTokens = 0;
let running = true;
let sessionExisted = false;
let sessionIno = -1;
let harnessMode = false;
let displayedSession = true;

let pendingClaudeCommands: { interaction: NonNullable<ReturnType<typeof parseEntryToInteraction>>; prevCtx: number }[] = [];
let discoveredClaudeFiles = new Set<string>();
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

interface FoldOwner {
	base: NonNullable<ReturnType<typeof parseEntryToInteraction>>;
	lastLine: string;
	lastCost: number;
}

interface SubagentFileState {
	lastSize: number;
	mtimeMs: number;
	/** Stamped when new bytes were read. A same-size rewrite can hide inside MTIME_SETTLE_MS. */
	readAtMs: number;
	ino: number;
	contentHash: ReturnType<typeof createHash>;
	fragment: Buffer;
	stream: ReturnType<typeof newParseStreamState>;
	/** The next write opens a generation: a `_gen` record, then every current line. */
	newGeneration: boolean;
	/** Fold ids this generation has recorded. The CLI's spawn walk skips exactly
	 *  the recorded ids, so a fold with no record is billed twice. */
	recordedFolds: Set<string>;
	/** Each nested transcript the last attribution folded, with the stamp it was read at. */
	foldStamps: Map<string, string>;
	/** Until then a spawning turn can still gain a `claude -p` child. */
	spawnWindowClosesAt: number;
	owners: FoldOwner[];
	/** Last ordinary turn not yet written, so a following interrupt can still mark it. */
	pendingTurn: NonNullable<ReturnType<typeof parseEntryToInteraction>> | null;
	/** The last turn read, of any kind, and whether a Claude command made it an
	 *  owner: the turn an interrupt at the head of the next read follows. */
	lastTurn: { turn: NonNullable<ReturnType<typeof parseEntryToInteraction>>; owner: boolean } | null;
	/** Cost already tagged for an ordinary id. A lower correction opens a new generation. */
	plainCost: Map<string, number>;
	/** Which children another holder owned at the last parse — when that set
	 *  changes this transcript's own total does too, so the gate must fire. */
	foldedByAnother: string;
}

function foldSetSignature(files: ReadonlySet<string>): string {
	return [...files].sort().join("\u0000");
}

let discoveredSubagentFiles = new Map<string, SubagentFileState>();

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

process.on("SIGTERM", () => { if (harnessMode) stopHarness("SIGTERM"); else shutdown("SIGTERM"); });
process.on("SIGINT", () => { if (harnessMode) stopHarness("SIGINT"); else shutdown("SIGINT"); });
process.on("SIGHUP", () => { if (harnessMode) stopHarness("SIGHUP"); else shutdown("SIGHUP"); });

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
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] session flush ${Date.now()} ${path.basename(sessionPath)}\n`);
  }
  tagGrewSinceMarker = true;
  appendTagFile(tagPath, JSON.stringify({ _meta: { offset: lastSize } }) + "\n");
  pendingItems = [];
  idleStartMs = 0;
  lastWriteMs = Date.now();
}

function hasClaudeCommand(interaction: NonNullable<ReturnType<typeof parseEntryToInteraction>>): boolean {
  return interaction.commands.some(commandSpawnsAgent);
}

function freshSubagentState(): SubagentFileState {
  return {
    lastSize: 0,
    mtimeMs: -1,
    readAtMs: 0,
    ino: -1,
    contentHash: createHash("sha1"),
    fragment: Buffer.alloc(0),
    stream: newParseStreamState(),
    newGeneration: true,
    recordedFolds: new Set<string>(),
    foldStamps: new Map<string, string>(),
    spawnWindowClosesAt: 0,
    owners: [],
    pendingTurn: null,
    lastTurn: null,
    plainCost: new Map(),
    foldedByAnother: "",
  };
}

function hashFilePrefix(file: string, length: number): string {
  const hash = createHash("sha1");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0;
    while (pos < length) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, length - pos), pos);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function hashFileBytes(file: string): string {
  const hash = createHash("sha1");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function parseAppendedBytes(
  state: SubagentFileState,
  fresh: Buffer,
): {
  interactions: NonNullable<ReturnType<typeof parseEntryToInteraction>>[];
  fragment: Buffer;
  stream: ReturnType<typeof newParseStreamState>;
  stampInterrupt: boolean;
} {
  const stream = { ...state.stream };
  const buf = state.fragment.length > 0 ? Buffer.concat([state.fragment, fresh]) : fresh;
  const lastNl = buf.lastIndexOf(0x0a);
  const tail = buf.subarray(lastNl + 1);
  let settledFragment = false;
  if (tail.length > 0 && tail.equals(state.fragment) && fresh.length === 0) {
    try { JSON.parse(tail.toString("utf8")); settledFragment = true; } catch { /* still mid-record */ }
  }
  if (lastNl === -1 && !settledFragment) {
    return { interactions: [], fragment: Buffer.from(buf), stream, stampInterrupt: false };
  }
  const consumeTo = settledFragment ? buf.length : lastNl + 1;
  const fragment = consumeTo >= buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(consumeTo));
  const newContent = buf.subarray(0, consumeTo).toString("utf8");
  const interactions: NonNullable<ReturnType<typeof parseEntryToInteraction>>[] = [];
  let stampInterrupt = false;
  for (const line of newContent.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const isControl = applyControlEntry(entry, stream, () => {
        if (interactions.length > 0) interactions[interactions.length - 1].interrupted = true;
        else stampInterrupt = true;
      });
      if (isControl) continue;
      const interaction = parseEntryToInteraction(entry, stream.thinkingLevel, stream.compactionTokensBefore, stream.afterCompaction, stream.model);
      if (interaction) {
        interactions.push(interaction);
        stream.compactionTokensBefore = undefined;
        stream.afterCompaction = false;
      }
    } catch { /* one bad line is not a file failure */ }
  }
  return { interactions, fragment, stream, stampInterrupt };
}

/** Set by {@link skipAsFoldedElsewhere} when its skip also wrote a record. */
let retiredThisPoll = false;

/**
 * Whether another synced transcript already folds this one — in which case
 * syncing it too would write its turns a second time, under its own source.
 *
 * One synced BEFORE the parse that showed who folds it has those lines on disk
 * already, so its source opens a new generation, which retires every one.
 */
function skipAsFoldedElsewhere(rawFile: string, foldedElsewhere: Set<string>): boolean {
  retiredThisPoll = false;
  const file = canonicalTranscriptPath(rawFile);
  if (!foldedElsewhere.has(file)) return false;
  if (discoveredSubagentFiles.has(file)) {
    appendTagFile(tagPath, generationRecordLine(
      transcriptSourceId(file, path.dirname(sessionPath)), path.basename(file, ".jsonl")));
    discoveredSubagentFiles.delete(file);
    tagGrewSinceMarker = true;
    retiredThisPoll = true;
  }
  return true;
}

function syncSubagentTranscript(rawFile: string, foldedByAnother: ReadonlySet<string> = new Set()): boolean {
  let wroteAny = false;
  // One transcript, one state entry and one source, however the path that
  // reached us was spelled — discovery joins paths, a fold records the path it
  // parsed, and a symlink makes those two spellings of one file.
  const file = canonicalTranscriptPath(rawFile);
  const stateKey = file;
  const sessionId = path.basename(file, ".jsonl");
  let fileState = discoveredSubagentFiles.get(stateKey);
  if (!fileState) {
    fileState = freshSubagentState();
    discoveredSubagentFiles.set(stateKey, fileState);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let size: number;
    let mtimeMs: number;
    let ino: number;
    try {
      const stat = fs.statSync(file);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
      ino = stat.ino;
    } catch (err) {
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
    const settled = Date.now() - fileState.readAtMs > MTIME_SETTLE_MS;
    let rotate = fileState.mtimeMs !== -1 && (ino !== fileState.ino || size < fileState.lastSize);
    if (!rotate && fileState.mtimeMs !== -1 && size === fileState.lastSize && (mtimeMs !== fileState.mtimeMs || !settled)) {
      try {
        if (hashFileBytes(file) !== fileState.contentHash.copy().digest("hex")) rotate = true;
        else {
          fileState.mtimeMs = mtimeMs;
          fileState.ino = ino;
        }
      } catch (err) {
        pollHadFailure = true;
        if (!warnedSubagentParseFailure.has(stateKey)) {
          warnedSubagentParseFailure.add(stateKey);
          process.stderr.write(
            `[wtft-log-parser] WARNING: a subagent transcript could not be read or parsed, so its cost may be missing from this session's total until it succeeds (${sessionId}): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        return wroteAny;
      }
    }
    if (!rotate && fileState.lastSize > 0 && size > fileState.lastSize) {
      try {
        if (hashFilePrefix(file, fileState.lastSize) !== fileState.contentHash.copy().digest("hex")) rotate = true;
      } catch (err) {
        pollHadFailure = true;
        if (!warnedSubagentParseFailure.has(stateKey)) {
          warnedSubagentParseFailure.add(stateKey);
          process.stderr.write(
            `[wtft-log-parser] WARNING: a subagent transcript could not be read or parsed, so its cost may be missing from this session's total until it succeeds (${sessionId}): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        return wroteAny;
      }
    }
    if (rotate) {
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] subagent transcript rotated, opening a new generation: ${path.basename(file)}\n`);
      }
      fileState = freshSubagentState();
      discoveredSubagentFiles.set(stateKey, fileState);
    }

    const grew = size > fileState.lastSize;
    let fresh = Buffer.alloc(0);
    let parsed: ReturnType<typeof parseAppendedBytes> | null = null;
    if (grew || fileState.fragment.length > 0) {
      try {
        if (grew) {
          const fd = fs.openSync(file, "r");
          fresh = Buffer.alloc(size - fileState.lastSize);
          try {
            fs.readSync(fd, fresh, 0, fresh.length, fileState.lastSize);
          } finally {
            fs.closeSync(fd);
          }
          if (process.env.WTFT_DAEMON_DEBUG) {
            process.stderr.write(`[wtft-log-parser] subagent delta ${fresh.length} bytes ${path.basename(file)}\n`);
          }
        }
        parsed = parseAppendedBytes(fileState, fresh);
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
    }

    const deduped = parsed ? clearSubagentCacheMiss(deduplicateInteractions(parsed.interactions)) : [];
    const plain: typeof deduped = [];
    const state = fileState;
    const absorbIntoOwner = (interaction: (typeof deduped)[number]): boolean => {
      if (!interaction.messageId) return false;
      const prior = state.owners.find(owner => owner.base.messageId === interaction.messageId);
      if (!prior) return false;
      // A full parse ORs `interrupted` across the copies of one id.
      if (interaction.interrupted && !prior.base.interrupted) {
        prior.base.interrupted = true;
        prior.lastLine = "";
      }
      if (interaction.cost + 1e-9 >= prior.base.cost) {
        prior.base.timestamp = interaction.timestamp;
        prior.base.cost = interaction.cost;
        prior.base.model = interaction.model ?? prior.base.model;
        prior.base.inputTokens = interaction.inputTokens;
        prior.base.outputTokens = interaction.outputTokens;
        prior.base.cacheReadTokens = interaction.cacheReadTokens;
        prior.base.cacheWriteTokens = interaction.cacheWriteTokens;
        prior.base.reasoningTokens = interaction.reasoningTokens;
        prior.base.serverToolCost = interaction.serverToolCost;
        prior.lastLine = "";
        prior.lastCost = 0;
      }
      return true;
    };
    // An interrupt marks the turn it follows and never a later one. A turn
    // already in the tag gets a second copy with the mark, which a reader ORs
    // across copies of one id; one with no id cannot be matched, so the
    // transcript is written again as a new generation.
    const reinterrupted: typeof deduped = [];
    if (parsed?.stampInterrupt) {
      const last = fileState.lastTurn;
      const ownerOfLast = last?.owner && last.turn.messageId
        ? fileState.owners.find(o => o.base.messageId === last.turn.messageId)
        : undefined;
      if (last && !last.owner && fileState.pendingTurn
        && (!last.turn.messageId || fileState.pendingTurn.messageId === last.turn.messageId)) {
        fileState.pendingTurn.interrupted = true;
      } else if (ownerOfLast) {
        ownerOfLast.base.interrupted = true;
        ownerOfLast.lastLine = "";
      } else if (last && !last.owner && last.turn.messageId) {
        reinterrupted.push(...clearSubagentCacheMiss([{ ...last.turn, interrupted: true }]));
      } else if (last && attempt === 0) {
        fileState = freshSubagentState();
        discoveredSubagentFiles.set(stateKey, fileState);
        continue;
      }
      parsed = { ...parsed, stampInterrupt: false };
    }
    if (fileState.pendingTurn && !absorbIntoOwner(fileState.pendingTurn)) plain.push(fileState.pendingTurn);
    const newOwners: FoldOwner[] = [];
    for (const interaction of deduped) {
      if (hasClaudeCommand(interaction)) {
        const prior = interaction.messageId
          ? fileState.owners.find(owner => owner.base.messageId === interaction.messageId)
          : undefined;
        if (prior) {
          const interrupted = prior.base.interrupted || interaction.interrupted;
          prior.base = structuredClone(interaction);
          if (interrupted) prior.base.interrupted = true;
          prior.lastLine = "";
        } else {
          newOwners.push({ base: structuredClone(interaction), lastLine: "", lastCost: 0 });
        }
      } else if (!absorbIntoOwner(interaction)) {
        plain.push(interaction);
      }
    }
    if (attempt === 0) {
      const seenCost = fileState.plainCost;
      const retracted = plain.some(interaction => {
        if (!interaction.messageId) return false;
        const prev = seenCost.get(interaction.messageId);
        return prev !== undefined && interaction.cost + 1e-9 < prev;
      });
      if (retracted) {
        fileState = freshSubagentState();
        discoveredSubagentFiles.set(stateKey, fileState);
        continue;
      }
    }
    const holdBack = size > fileState.lastSize && plain.length > 0;
    // Which turns are held and last is committed with the offset below. A mark
    // set on them before a failure is set again, identically, by the re-read.
    const nextPending = holdBack ? plain.pop() ?? null : null;
    const owners = [...fileState.owners, ...newOwners];
    const lastRead = parsed?.interactions[parsed.interactions.length - 1];
    const nextLastTurn = lastRead
      ? {
        turn: lastRead,
        owner: hasClaudeCommand(lastRead)
          || (!!lastRead.messageId && owners.some(o => o.base.messageId === lastRead.messageId)),
      }
      : fileState.lastTurn;
    const windowOpen = Date.now() <= fileState.spawnWindowClosesAt + MTIME_SETTLE_MS;
    const foldSig = foldSetSignature(foldedByAnother);
    const needAttr = owners.length > 0 && (
      newOwners.length > 0 || foldedTranscriptChanged(fileState.foldStamps) || windowOpen
      || fileState.foldedByAnother !== foldSig || owners.some(o => o.lastLine === "")
    );

    let clones: NonNullable<ReturnType<typeof parseEntryToInteraction>>[] = [];
    if (needAttr) {
      try {
        clones = owners.map(o => structuredClone(o.base));
        const doNotFold = new Set([
          canonicalTranscriptPath(sessionPath),
          canonicalTranscriptPath(file),
          ...foldedByAnother,
        ]);
        attributeClaudeSubAgentCosts(clones, resolveLastCwd(file), doNotFold);
      } catch (err) {
        pollHadFailure = true;
        if (!warnedSubagentParseFailure.has(stateKey)) {
          warnedSubagentParseFailure.add(stateKey);
          process.stderr.write(
            `[wtft-log-parser] WARNING: a subagent transcript could not be read or parsed, so its cost may be missing from this session's total until it succeeds (${sessionId}): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        return wroteAny;
      }
      const shrunk = owners.some((o, i) => o.lastCost > 0 && clones[i].cost + 1e-9 < o.lastCost);
      if (shrunk && attempt === 0) {
        fileState = freshSubagentState();
        discoveredSubagentFiles.set(stateKey, fileState);
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-log-parser] subagent transcript rotated, opening a new generation: ${path.basename(file)}\n`);
        }
        continue;
      }
    }

    const source = transcriptSourceId(file, path.dirname(sessionPath));
    let batch = "";
    const nextOwners: FoldOwner[] = owners.map((o, i) => ({ ...o }));
    const consumedQuiet = parsed !== null
      && parsed.fragment.length === 0
      && size > 0
      && nextPending === null;
    const emitGeneration = fileState.newGeneration && (
      plain.length > 0 || clones.length > 0 || rotate || consumedQuiet
    );
    try {
      if (emitGeneration) {
        batch = generationRecordLine(source, sessionId);
      }
      for (const interaction of plain) {
        batch += serializeClassified(interaction, source);
        if (interaction.messageId) fileState.plainCost.set(interaction.messageId, interaction.cost);
      }
      for (const interaction of reinterrupted) batch += serializeClassified(interaction, source);
      clones.forEach((interaction, i) => {
        const line = serializeClassified(interaction, source);
        if (line === nextOwners[i].lastLine) return;
        batch += line;
        nextOwners[i].lastLine = line;
        nextOwners[i].lastCost = interaction.cost;
      });
    } catch (err) {
      pollHadFailure = true;
      if (!warnedSubagentSerializeFailure.has(stateKey)) {
        warnedSubagentSerializeFailure.add(stateKey);
        process.stderr.write(
          `[wtft-log-parser] WARNING: a subagent's interactions could not be serialized for the tag file, so its cost is missing from this session's total until it succeeds (${sessionId}): ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      return wroteAny;
    }

    const parent = path.basename(sessionPath, ".jsonl");
    const freshFolds: string[] = [];
    const foldFrom = clones.length > 0 ? clones : plain;
    if (foldFrom.length > 0) {
      for (const id of foldRecordIds(sessionId, foldFrom)) {
        if (fileState.recordedFolds.has(id)) continue;
        batch += foldRecordLine(parent, id, source);
        freshFolds.push(id);
      }
    }

    if (batch) {
      appendTagFile(tagPath, batch);
      wroteAny = true;
      tagGrewSinceMarker = true;
    }

    if (parsed) {
      fileState.fragment = parsed.fragment;
      fileState.stream = parsed.stream;
      if (fresh.length > 0) fileState.contentHash.update(fresh);
      fileState.lastSize = size;
      fileState.readAtMs = Date.now();
    }
    fileState.mtimeMs = mtimeMs;
    fileState.ino = ino;
    fileState.owners = nextOwners;
    fileState.pendingTurn = nextPending;
    fileState.lastTurn = nextLastTurn;
    for (const id of freshFolds) fileState.recordedFolds.add(id);
    if (emitGeneration) fileState.newGeneration = false;
    if (clones.length > 0) {
      fileState.foldStamps = new Map();
      for (const interaction of clones) {
        for (const fold of interaction.claudeSubAgentFolds ?? []) {
          fileState.foldStamps.set(canonicalTranscriptPath(fold.file), fold.stamp);
        }
      }
      fileState.spawnWindowClosesAt = claudeSpawnWindowClosesAt(clones, resolveLastCwd(file));
    }
    fileState.foldedByAnother = foldSig;
    return wroteAny;
  }
  return wroteAny;
}

/** A nested transcript that grew, or no longer stats, since the parse that folded it. */
function foldedTranscriptChanged(foldStamps: Map<string, string>): boolean {
  for (const [file, stamp] of foldStamps) {
    try {
      if (fileStamp(file) !== stamp) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function scanForSubAgents() {
  let wroteAny = false;
  // pollHadFailure is reset by the poll loop, not here — flushPending runs first and can fail.

  if (pendingClaudeCommands.length > 0) {
    const stillPending: typeof pendingClaudeCommands = [];
    for (const item of pendingClaudeCommands) {
      const interaction = item.interaction;
      const ownCwd = resolveLastCwd(sessionPath);

      let discovered: ReturnType<typeof discoverClaudeSubAgentFilesForTurn>;
      try {
        discovered = discoverClaudeSubAgentFilesForTurn(interaction.commands, interaction.timestamp, ownCwd);
      } catch (err) {
        pollHadFailure = true;
        stillPending.push(item);
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-log-parser] claude -p discovery failed, will retry next poll (${path.basename(sessionPath, '.jsonl')}): ${err instanceof Error ? err.message : String(err)}\n`);
        }
        continue;
      }
      // Nothing to search. One cause can change — a session cwd not yet
      // readable from the transcript — and the rest (a launcher, an unknowable
      // or bare `cd`) cannot, so the turn waits out its window rather than
      // being dropped at the first look or retried forever.
      if (discovered.searched === 0) {
        if (Date.now() <= interaction.timestamp + CLAUDE_SUBAGENT_WINDOW_MS + MTIME_SETTLE_MS) stillPending.push(item);
        continue;
      }
      if (discovered.files.length === 0 && !discovered.unreadable) {
        if (Date.now() <= interaction.timestamp + CLAUDE_SUBAGENT_WINDOW_MS + MTIME_SETTLE_MS) stillPending.push(item);
        continue;
      }
      for (const file of discovered.files) {
        // The searched directory holds this session's own transcript, and
        // discovery matches on a time window. A sourced second copy of the
        // session's own turns then competes with the originals in the reader's
        // max-cost collapse, and for a harness whose turns carry no id there is
        // nothing to collapse them with at all.
        if (canonicalTranscriptPath(file) === canonicalTranscriptPath(sessionPath)) continue;
        discoveredClaudeFiles.add(file);
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-log-parser] claude -p subagent registered for re-parse (${path.basename(file, '.jsonl')})\n`);
        }
      }
      if (discovered.unreadable) {
        pollHadFailure = true;
        stillPending.push(item);
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-log-parser] claude -p discovery candidate unreadable, will retry next poll (${path.basename(sessionPath, '.jsonl')}): ${discovered.unreadable.message}\n`);
        }
      } else if (Date.now() <= interaction.timestamp + CLAUDE_SUBAGENT_WINDOW_MS + MTIME_SETTLE_MS) {
        // A later child in the same window is not on disk yet.
        stillPending.push(item);
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
  // A transcript some other synced transcript folds must not also be synced
  // under its own source: the daemon parses each one in its own call, so the
  // fold pass's within-one-call accounting cannot see across them. Derived from
  // the CURRENT fold state every poll, never accumulated, so a parent that
  // rotates and stops folding hands its child straight back.
  // One child, one holder. Two in-window transcripts in a shared project dir
  // each discover the other's children, and each parse bakes what it folds into
  // its own turns, so without an owner the same child's cost lands in both. The
  // owner is the lexicographically first holder, which cannot flip between polls.
  const holderOf = new Map<string, string>();
  for (const [holder, state] of discoveredSubagentFiles) {
    for (const folded of state.foldStamps.keys()) {
      if (folded === holder) continue;
      // Two transcripts that fold each other would each retire the other, and
      // the poll after would find nothing folding either and re-sync both, for
      // a total that alternates between double and none.
      const other = discoveredSubagentFiles.get(folded);
      if (other?.foldStamps.has(holder) && holder > folded) continue;
      const current = holderOf.get(folded);
      if (current === undefined || holder < current) holderOf.set(folded, holder);
    }
  }
  const foldedElsewhere = new Set(holderOf.keys());
  /** What one transcript must leave alone: every child another holder owns. */
  const notMine = (file: string): Set<string> => {
    const me = canonicalTranscriptPath(file);
    const out = new Set<string>();
    for (const [folded, holder] of holderOf) if (holder !== me) out.add(folded);
    return out;
  };

  for (const file of taskAgentFiles) {
    if (skipAsFoldedElsewhere(file, foldedElsewhere)) { wroteAny = wroteAny || retiredThisPoll; continue; }
    wroteAny = syncSubagentTranscript(file, notMine(file)) || wroteAny;
  }

  for (const file of discoveredClaudeFiles) {
    if (skipAsFoldedElsewhere(file, foldedElsewhere)) { wroteAny = wroteAny || retiredThisPoll; continue; }
    wroteAny = syncSubagentTranscript(file, notMine(file)) || wroteAny;
  }

  if (wroteAny) {
    const now = Date.now();
    lastWriteMs = now;
    lastActivityMs = now;
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
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-log-parser] session stat ${path.basename(filePath)}\n`);
    }
    const currentSize = stat.size;
    if (sessionIno !== -1 && stat.ino !== sessionIno) {
      lastSize = 0;
      pendingFragment = Buffer.alloc(0);
      streamState = newParseStreamState();
      prevCtxTokens = 0;
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] session inode changed, resetting offset ${path.basename(filePath)}\n`);
      }
    }
    sessionIno = stat.ino;
    if (currentSize < lastSize) {
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] session truncated, resetting offset\n`);
      }
      lastSize = 0;
      pendingFragment = Buffer.alloc(0);
      streamState = newParseStreamState();
      prevCtxTokens = 0;
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
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] session delta ${fresh.length} bytes ${path.basename(filePath)}\n`);
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

  // One process can hold many leases (a harness daemon holds one per session),
  // so each distinct pid is examined once and its outcome applied to all of them.
  type Lease = { path: string; dev: number; ino: number };
  const leasesOf = new Map<number, Lease[]>();
  for (const pidFile of pidFiles) {
    const fullPath = path.join(pidDir, pidFile);
    let pid = 0;
    let lease: Lease;
    try {
      const stat = fs.statSync(fullPath);
      lease = { path: fullPath, dev: stat.dev, ino: stat.ino };
      pid = parseInt(fs.readFileSync(fullPath, "utf8").trim(), 10);
    } catch (_) { continue; }
    if (!(pid > 0)) continue;
    const leases = leasesOf.get(pid);
    if (leases) leases.push(lease);
    else leasesOf.set(pid, [lease]);
  }
  const sessionOf = new Map<number, string | null>();
  // Re-proved (same file, same pid) before unlinking, as the claim loop does:
  // a lease read at the start may have been claimed by a new owner since.
  const unlinkIfStill = (lease: Lease, pid: number) => {
    try {
      const now = fs.statSync(lease.path);
      if (now.dev !== lease.dev || now.ino !== lease.ino) return;
      if (parseInt(fs.readFileSync(lease.path, "utf8").trim(), 10) === pid) fs.unlinkSync(lease.path);
    } catch (_) {}
  };

  for (const [pid, leases] of leasesOf) {
    // Only ESRCH means gone, as in the claim loop: EPERM is a live process
    // this user cannot signal, and its leases stay.
    let alive = true;
    try { process.kill(pid, 0); } catch (err) { alive = (err as NodeJS.ErrnoException).code !== "ESRCH"; }

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
      for (const lease of leases) unlinkIfStill(lease, pid);
      continue;
    }

    // HARD: session gone (not moved, not never-written). Never our own PID.
    if (pid !== process.pid && sessionFound && sessionIsGone(sessionFound)) {
      // A process that refuses the signal is still alive, so its leases stay.
      let gone = true;
      try { process.kill(pid, "SIGTERM"); } catch (err) { gone = (err as NodeJS.ErrnoException).code === "ESRCH"; }
      if (gone) {
        for (const lease of leases) unlinkIfStill(lease, pid);
        warnings.push(`[${new Date().toISOString()}] KILLED PID ${pid}: session gone — ${sessionFound}`);
      }
      continue;
    }
    sessionOf.set(pid, sessionFound);
    const findings: string[] = [];

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
            findings.push(`tag file large (${mb} MB) — ${tagFound}`);
          }

          if (lines.length > 10 && hbRatio >= HB_RATIO_WARN) {
            const pct = Math.round(hbRatio * 100);
            findings.push(`${pct}% heartbeats (${hbLines.length}/${lines.length} lines) — possible malfunction — ${tagFound}`);
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
                  findings.push(`${ageH}h old with zero real interactions — zombie daemon? — ${sessionFound}`);
                }
              } catch (_) {}
            }
          }
        } catch (_) {}
      }
    }
    if (findings.length > 0) {
      warnings.push(`[${new Date().toISOString()}] WARN PID ${pid}: ${findings.join("; ")}`);
    }
  }

  try {
    const tmpEntries = fs.readdirSync(os.tmpdir());
    const liveSessions = new Set<string>();
    for (const session of sessionOf.values()) if (session) liveSessions.add(session);
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

function serviceSession(): "continue" | "stop" | "drop" {
  try {
    if (fs.readFileSync(pidPath, "utf8").trim() !== String(process.pid)) {
      if (harnessMode) return "drop";
      running = false;
      process.exit(0);
    }
  } catch (_) {
    if (harnessMode) return "drop";
    running = false;
    process.exit(0);
  }

  if (!fs.existsSync(sessionPath)) {
    if (sessionExisted) {
      if (!followMovedSession()) {
        if (harnessMode) return "drop";
        shutdown("session removed");
        return "stop";
      }
    }
    const now = Date.now();
    if (!sessionExisted && now - startupTime >= SESSION_WAIT_MAX_MS) {
      if (harnessMode) return "drop";
      shutdown("session never written");
      return "stop";
    }
    if (idleStartMs === 0) idleStartMs = now;
    if (!harnessMode || displayedSession) upsertHeartbeat(now);
    lastWriteMs = now;
    lastActivityMs = now;
    return "continue";
  }
  sessionExisted = true;

  try {
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

    if (pendingItems.length === 0 && (!harnessMode || displayedSession)) {
      if (idleStartMs === 0) idleStartMs = now;
      upsertHeartbeat(now);
      lastWriteMs = now;
    }

    if (now - lastActivityMs >= IDLE_EXIT_MS && now - startupTime >= STARTUP_GRACE_MS) {
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] no new data for ${Math.round((now - lastActivityMs) / 60000)}m, exiting\n`);
      }
      if (harnessMode) return "drop";
      shutdown("idle timeout");
      return "stop";
    }

    if (!fs.existsSync(sessionPath) && !followMovedSession()) {
      if (harnessMode) return "drop";
      shutdown("session removed");
      return "stop";
    }
  } catch (err) {
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-log-parser] poll error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return "continue";
}

const HARNESS_SKIP_DIRS = new Set(["subagents", "tool-results", "memory", "wtft-tags"]);

type PendingItem = { interaction: NonNullable<ReturnType<typeof parseEntryToInteraction>>; prevCtx: number };

interface Slot {
  sessionPath: string;
  tagPath: string;
  pidPath: string;
  rebuildTagOnStartup: boolean;
  lastSize: number;
  pendingFragment: Buffer;
  lastWriteMs: number;
  lastActivityMs: number;
  startupTime: number;
  pendingItems: PendingItem[];
  idleStartMs: number;
  streamState: ReturnType<typeof newParseStreamState>;
  stampInterruptOnPending: boolean;
  prevCtxTokens: number;
  sessionExisted: boolean;
  sessionIno: number;
  displayed: boolean;
  pendingClaudeCommands: PendingItem[];
  discoveredClaudeFiles: Set<string>;
  discoveredSubagentFiles: Map<string, SubagentFileState>;
  tagGrewSinceMarker: boolean;
  pollHadFailure: boolean;
  sweptRetracted: boolean;
}

const harnessSlots = new Map<string, Slot>();
const harnessWatchers = new Map<string, fs.FSWatcher>();
const harnessFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
let harnessPidFile = "";
let harnessIdleTimer: ReturnType<typeof setInterval> | null = null;

function freshSlot(file: string, displayed: boolean): Slot {
  const now = Date.now();
  return {
    sessionPath: file,
    tagPath: "",
    pidPath: "",
    rebuildTagOnStartup: false,
    lastSize: 0,
    pendingFragment: Buffer.alloc(0),
    lastWriteMs: 0,
    lastActivityMs: now,
    startupTime: now,
    pendingItems: [],
    idleStartMs: 0,
    streamState: newParseStreamState(),
    stampInterruptOnPending: false,
    prevCtxTokens: 0,
    sessionExisted: false,
    sessionIno: -1,
    displayed,
    pendingClaudeCommands: [],
    discoveredClaudeFiles: new Set(),
    discoveredSubagentFiles: new Map(),
    tagGrewSinceMarker: true,
    pollHadFailure: false,
    sweptRetracted: false,
  };
}

function install(slot: Slot) {
  sessionPath = slot.sessionPath;
  tagPath = slot.tagPath;
  pidPath = slot.pidPath;
  rebuildTagOnStartup = slot.rebuildTagOnStartup;
  lastSize = slot.lastSize;
  pendingFragment = slot.pendingFragment;
  lastWriteMs = slot.lastWriteMs;
  lastActivityMs = slot.lastActivityMs;
  startupTime = slot.startupTime;
  pendingItems = slot.pendingItems;
  idleStartMs = slot.idleStartMs;
  streamState = slot.streamState;
  stampInterruptOnPending = slot.stampInterruptOnPending;
  prevCtxTokens = slot.prevCtxTokens;
  sessionExisted = slot.sessionExisted;
  sessionIno = slot.sessionIno;
  displayedSession = slot.displayed;
  pendingClaudeCommands = slot.pendingClaudeCommands;
  discoveredClaudeFiles = slot.discoveredClaudeFiles;
  discoveredSubagentFiles = slot.discoveredSubagentFiles;
  tagGrewSinceMarker = slot.tagGrewSinceMarker;
  pollHadFailure = slot.pollHadFailure;
  sweptRetracted = slot.sweptRetracted;
}

function save(slot: Slot) {
  slot.sessionPath = sessionPath;
  slot.tagPath = tagPath;
  slot.pidPath = pidPath;
  slot.rebuildTagOnStartup = rebuildTagOnStartup;
  slot.lastSize = lastSize;
  slot.pendingFragment = pendingFragment;
  slot.lastWriteMs = lastWriteMs;
  slot.lastActivityMs = lastActivityMs;
  slot.startupTime = startupTime;
  slot.pendingItems = pendingItems;
  slot.idleStartMs = idleStartMs;
  slot.streamState = streamState;
  slot.stampInterruptOnPending = stampInterruptOnPending;
  slot.prevCtxTokens = prevCtxTokens;
  slot.sessionExisted = sessionExisted;
  slot.sessionIno = sessionIno;
  slot.displayed = displayedSession;
  slot.pendingClaudeCommands = pendingClaudeCommands;
  slot.discoveredClaudeFiles = discoveredClaudeFiles;
  slot.discoveredSubagentFiles = discoveredSubagentFiles;
  slot.tagGrewSinceMarker = tagGrewSinceMarker;
  slot.pollHadFailure = pollHadFailure;
  slot.sweptRetracted = sweptRetracted;
}

function withSlot<T>(slot: Slot, fn: () => T): T {
  install(slot);
  try {
    return fn();
  } finally {
    save(slot);
  }
}

function procIsDaemon(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  let cmd = "";
  try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { return false; }
  return cmd.split("\0").some(arg => {
    const base = path.basename(arg);
    return base === "wtft-daemon.mjs" || base === "wtft-daemon.js" || base === "wtft-daemon" || base === "wtft-daemon.ts";
  });
}

function claimPidFile(file: string): "claimed" | "busy" {
  const aliveDaemon = (pid: number): boolean => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
    try { process.kill(pid, 0); } catch { return false; }
    return procIsDaemon(pid);
  };
  try {
    const existing = Number(fs.readFileSync(file, "utf8").trim());
    if (existing === process.pid) return "claimed";
    if (aliveDaemon(existing)) return "busy";
  } catch { /* no lease yet */ }
  const candidate = `${file}.claim-${process.pid}`;
  try {
    fs.writeFileSync(candidate, String(process.pid));
    try {
      fs.linkSync(candidate, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holderText = "";
      try {
        holderText = fs.readFileSync(file, "utf8").trim();
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code !== "ENOENT") throw readErr;
        try {
          fs.linkSync(candidate, file);
        } catch (linkErr) {
          if ((linkErr as NodeJS.ErrnoException).code === "EEXIST") return "busy";
          throw linkErr;
        }
        return "claimed";
      }
      const holder = Number(holderText);
      if (holder === process.pid) return "claimed";
      if (aliveDaemon(holder)) return "busy";
      try { fs.unlinkSync(file); } catch { /* raced */ }
      try {
        fs.linkSync(candidate, file);
      } catch (linkErr) {
        if ((linkErr as NodeJS.ErrnoException).code === "EEXIST") return "busy";
        throw linkErr;
      }
    }
  } finally {
    try { fs.unlinkSync(candidate); } catch { /* already gone */ }
  }
  return "claimed";
}

function harnessRoot(which: string): string {
  if (which === "claude") {
    return projectsDir();
  }
  if (which === "pi") {
    return process.env.WTFT_PI_SESSIONS_DIR || path.join(os.homedir(), ".pi", "agent", "sessions");
  }
  process.stderr.write("wtft-daemon: --harness must be claude or pi\n");
  process.exit(2);
}

function walkSessions(dir: string, out: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.resolve(dir, ent.name);
    if (ent.isDirectory()) {
      if (HARNESS_SKIP_DIRS.has(ent.name)) continue;
      walkSessions(full, out);
    } else if (ent.name.endsWith(".jsonl") && !ent.name.includes(".wtft-tag.")) {
      out.push(full);
    }
  }
}

function adoptSession(): boolean {
  if (sessionPath.includes(".wtft-tag.v")) return false;
  tagPath = getCurrentVersionTagPath(sessionPath);
  try { fs.mkdirSync(path.dirname(tagPath), { recursive: true }); } catch { /* exists */ }
  pidPath = getDaemonPidPath(sessionPath);
  try {
    if (fs.readFileSync(pidPath, "utf8").trim() === "rebuild") rebuildTagOnStartup = true;
  } catch { /* no lease yet */ }
  if (!takeOverLease(pidPath)) return false;
  initClassified();
  return true;
}

function takeOverLease(pidPath: string): boolean {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (claimPidFile(pidPath) === "claimed") return true;
    let holder = 0;
    try { holder = Number(fs.readFileSync(pidPath, "utf8").trim()); } catch { holder = 0; }
    if (holder === process.pid) return true;
    if (holder > 0 && procIsDaemon(holder)) {
      try { process.kill(holder, "SIGTERM"); } catch { /* already gone */ }
    }
    const until = Date.now() + 50;
    while (Date.now() < until) { /* the previous daemon exits on SIGTERM */ }
  }
  return claimPidFile(pidPath) === "claimed";
}

function scheduleFlush(key: string) {
  if (harnessFlushTimers.has(key)) return;
  const slot = harnessSlots.get(key);
  if (!slot || slot.pendingItems.length === 0) return;
  const wait = Math.max(0, POLL_MS - (Date.now() - slot.lastWriteMs));
  const timer = setTimeout(() => {
    harnessFlushTimers.delete(key);
    const current = harnessSlots.get(key);
    if (!current) return;
    if (!leaseStillOurs(current)) {
      dropHarnessSlot(key);
      return;
    }
    withSlot(current, () => {
      if (pendingItems.length > 0) flushPending();
      scanForSubAgents();
    });
  }, wait);
  timer.unref();
  harnessFlushTimers.set(key, timer);
}

function wake(file: string, displayed: boolean) {
  const key = path.resolve(file);
  let slot = harnessSlots.get(key);
  if (!slot) {
    slot = freshSlot(key, displayed);
    if (!withSlot(slot, () => adoptSession())) return;
    harnessSlots.set(key, slot);
  } else if (displayed) {
    slot.displayed = true;
  }
  const status = withSlot(slot, () => serviceSession());
  if (status === "drop") {
    dropHarnessSlot(key);
    return;
  }
  const movedTo = slot.sessionPath;
  if (movedTo !== key) {
    const other = harnessSlots.get(movedTo);
    if (other && other !== slot) dropHarnessSlot(movedTo);
    harnessSlots.delete(key);
    harnessSlots.set(movedTo, slot);
    const timer = harnessFlushTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      harnessFlushTimers.delete(key);
    }
  }
  if (slot.pendingItems.length > 0) scheduleFlush(movedTo);
}

function watchDir(dir: string) {
  const key = path.resolve(dir);
  if (harnessWatchers.has(key)) return;
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(key, (event, filename) => onWatch(key, filename ? String(filename) : null));
  } catch {
    return;
  }
  watcher.on("error", () => {
    harnessWatchers.delete(key);
    try { watcher.close(); } catch { /* already closed */ }
    try {
      if (fs.statSync(key).isDirectory()) watchDir(key);
    } catch { /* directory is gone */ }
    for (const [file, slot] of harnessSlots) {
      if (file !== key && !file.startsWith(key + path.sep)) continue;
      wake(file, slot.displayed);
    }
  });
  harnessWatchers.set(key, watcher);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(key, { withFileTypes: true });
  } catch {
    return;
  }
  const insideSubagents = key.includes(`${path.sep}subagents${path.sep}`) || key.endsWith(`${path.sep}subagents`);
  for (const ent of entries) {
    const child = path.resolve(key, ent.name);
    if (ent.isDirectory()) {
      if (HARNESS_SKIP_DIRS.has(ent.name) && ent.name !== "subagents") continue;
      watchDir(child);
      continue;
    }
    if (insideSubagents) continue;
    if (ent.name.endsWith(".jsonl") && !ent.name.includes(".wtft-tag.")) wake(child, false);
  }
}

function parentSessionFile(child: string): string | null {
  const marker = `${path.sep}subagents${path.sep}`;
  const at = child.indexOf(marker);
  if (at < 0) return null;
  return `${child.slice(0, at)}.jsonl`;
}

function onWatch(dir: string, filename: string | null) {
  if (!filename) {
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write("[wtft-log-parser] watch overflow, rescanning offsets once\n");
    }
    for (const [file, slot] of harnessSlots) wake(file, slot.displayed);
    return;
  }
  if (HARNESS_SKIP_DIRS.has(filename) && filename !== "subagents") return;
  const full = path.resolve(dir, filename);
  if (filename === "subagents" || full.includes(`${path.sep}subagents${path.sep}`)) {
    if (filename === "subagents") {
      try {
        if (fs.statSync(full).isDirectory()) watchDir(full);
      } catch { /* gone */ }
    }
    const parent = parentSessionFile(full.endsWith(path.sep) ? full : `${full}${path.sep}`);
    if (parent) {
      const slot = harnessSlots.get(parent);
      if (slot) wake(parent, slot.displayed);
    }
    return;
  }
  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(full);
  } catch {
    st = null;
  }
  if (st?.isDirectory()) {
    watchDir(full);
    return;
  }
  if (st && filename.endsWith(".jsonl") && !filename.includes(".wtft-tag.")) {
    wake(full, false);
    return;
  }
  // A replace-via-rename often reports only the path that disappeared.
  const watched = path.resolve(dir);
  for (const [file, slot] of harnessSlots) {
    if (path.dirname(file) !== watched) continue;
    let now: fs.Stats;
    try {
      now = fs.statSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") wake(file, slot.displayed);
      continue;
    }
    if (now.ino !== slot.sessionIno || now.size !== slot.lastSize) wake(file, slot.displayed);
  }
}

function pointSessionAt(livePid: number, file: string) {
  const lease = getDaemonPidPath(file);
  const replacement = `${lease}.replace-${process.pid}`;
  fs.writeFileSync(replacement, String(livePid));
  fs.renameSync(replacement, lease);
  try { fs.writeFileSync(`${lease}.display`, ""); } catch { /* the live process still has the old focus */ }
}

function runHarness(which: string, focus: string) {
  const root = path.resolve(harnessRoot(which));
  if (!fs.existsSync(root)) {
    process.stderr.write(`wtft-daemon: harness root does not exist: ${root}\n`);
    process.exit(1);
  }
  if (focus) {
    const focusKey = path.resolve(focus);
    if (focusKey !== root && !focusKey.startsWith(root + path.sep)) {
      process.stderr.write(`wtft-daemon: --session is outside the harness root: ${focusKey}\n`);
      process.exit(2);
    }
  }
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  harnessPidFile = path.join(os.tmpdir(), `wtft-harness-${which}-${hash}.pid`);
  if (claimPidFile(harnessPidFile) === "busy") {
    const live = Number(fs.readFileSync(harnessPidFile, "utf8").trim());
    if (procIsDaemon(live)) {
      if (focus) pointSessionAt(live, focus);
      process.exit(0);
    }
    if (claimPidFile(harnessPidFile) !== "claimed") process.exit(1);
  }
  harnessMode = true;
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] harness pid ${harnessPidFile}\n`);
    process.stderr.write(`[wtft-log-parser] harness root ${root}\n`);
  }
  watchDir(root);
  const files: string[] = [];
  walkSessions(root, files);
  const focusKey = focus ? path.resolve(focus) : "";
  for (const file of files) wake(file, file === focusKey);
  if (focusKey && !harnessSlots.has(focusKey)) wake(focusKey, true);
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] harness settled ${which}\n`);
  }
  harnessIdleTimer = setInterval(sweepIdleSlots, 250);
  harnessIdleTimer.unref();
}

function dropHarnessSlot(key: string) {
  const slot = harnessSlots.get(key);
  if (slot && slot.pendingItems.length > 0) {
    withSlot(slot, () => {
      if (pendingItems.length > 0) flushPending();
    });
  }
  const timer = harnessFlushTimers.get(key);
  if (timer) clearTimeout(timer);
  harnessFlushTimers.delete(key);
  harnessSlots.delete(key);
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] session drop ${path.basename(key)}\n`);
  }
}

function slotNeedsChildScan(slot: Slot, now: number): boolean {
  if (slot.pendingClaudeCommands.length > 0) return true;
  for (const state of slot.discoveredSubagentFiles.values()) {
    if (state.pendingTurn) return true;
    if (now <= state.spawnWindowClosesAt + MTIME_SETTLE_MS) return true;
  }
  return false;
}

function leaseStillOurs(slot: Slot): boolean {
  if (!slot.pidPath) return true;
  try {
    return fs.readFileSync(slot.pidPath, "utf8").trim() === String(process.pid);
  } catch {
    return false;
  }
}

function sweepIdleSlots() {
  if (!running) return;
  const now = Date.now();
  for (const key of [...harnessSlots.keys()]) {
    const slot = harnessSlots.get(key);
    if (!slot) continue;
    if (!leaseStillOurs(slot)) {
      dropHarnessSlot(key);
      continue;
    }
    if (slot.pidPath && fs.existsSync(`${slot.pidPath}.display`)) {
      slot.displayed = true;
      try { fs.unlinkSync(`${slot.pidPath}.display`); } catch { /* already gone */ }
      withSlot(slot, () => upsertHeartbeat(Date.now()));
    }
    if (slotNeedsChildScan(slot, now)) withSlot(slot, () => scanForSubAgents());
    const current = harnessSlots.get(key);
    if (!current) continue;
    if (current.pendingItems.length > 0) continue;
    if (now - current.startupTime < STARTUP_GRACE_MS) continue;
    if (now - current.lastActivityMs < IDLE_EXIT_MS) continue;
    dropHarnessSlot(key);
  }
}

function stopHarness(reason: string) {
  if (!running) return;
  running = false;
  if (harnessIdleTimer) clearInterval(harnessIdleTimer);
  harnessIdleTimer = null;
  for (const timer of harnessFlushTimers.values()) clearTimeout(timer);
  for (const slot of harnessSlots.values()) {
    withSlot(slot, () => {
      if (pendingItems.length > 0) flushPending();
    });
    try {
      if (slot.pidPath && fs.readFileSync(slot.pidPath, "utf8").trim() === String(process.pid)) {
        fs.unlinkSync(slot.pidPath);
      }
    } catch { /* lease already gone */ }
  }
  for (const watcher of harnessWatchers.values()) {
    try { watcher.close(); } catch { /* already closed */ }
  }
  if (harnessPidFile) {
    try {
      if (fs.readFileSync(harnessPidFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(harnessPidFile);
    } catch { /* already gone */ }
  }
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] harness shutdown: ${reason}\n`);
  }
  process.exit(0);
}

function pathIsUnderTmp(file: string): boolean {
  const resolved = path.resolve(file);
  const tmp = path.resolve(os.tmpdir());
  return resolved === tmp || resolved.startsWith(tmp + path.sep) || resolved.startsWith("/tmp/");
}

function daemonProcs(): { pid: number; session: string | null; harness: boolean; roots: string[] }[] {
  const out: { pid: number; session: string | null; harness: boolean; roots: string[] }[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!/^[1-9]\d*$/.test(ent)) continue;
    const pid = Number(ent);
    let cmd = "";
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    const args = cmd.split("\0").filter(arg => arg.length > 0);
    const isDaemon = args.some(arg => {
      const base = path.basename(arg);
      return base === "wtft-daemon.mjs" || base === "wtft-daemon.js" || base === "wtft-daemon" || base === "wtft-daemon.ts";
    });
    if (!isDaemon) continue;
    const sessIdx = args.indexOf("--session");
    const session = sessIdx >= 0 && sessIdx + 1 < args.length ? args[sessIdx + 1] : null;
    let roots: string[] = [];
    try {
      roots = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")
        .filter(row => row.startsWith("WTFT_CLAUDE_PROJECTS_DIR=") || row.startsWith("WTFT_PI_SESSIONS_DIR="))
        .map(row => row.slice(row.indexOf("=") + 1))
        .filter(row => row.length > 0);
    } catch { /* environ unreadable */ }
    out.push({ pid, session, harness: args.includes("--harness"), roots });
  }
  return out;
}

function tagIsCurrent(file: string): boolean {
  try {
    return fs.statSync(getCurrentVersionTagPath(file)).size > 0;
  } catch {
    return false;
  }
}

function sessionDaemonLive(file: string): boolean {
  let holder = 0;
  try { holder = Number(fs.readFileSync(getDaemonPidPath(file), "utf8").trim()); } catch { return false; }
  return procIsDaemon(holder);
}

function waitUntilExited(pid: number) {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    try { process.kill(pid, 0); } catch { return; }
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

function reparseOne(file: string): boolean {
  if (sessionDaemonLive(file)) {
    process.stderr.write(`wtft-daemon: --reparse refused while a daemon holds ${file}\n`);
    return false;
  }
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] reparse begin ${file}\n`);
  }
  sessionPath = file;
  tagPath = getCurrentVersionTagPath(file);
  try { fs.mkdirSync(path.dirname(tagPath), { recursive: true }); } catch { /* exists */ }
  const parsedSize = fs.statSync(file).size;
  const raw = deduplicateInteractions(parseSessionFile(file));
  fs.writeFileSync(tagPath, "");
  let prev = 0;
  let batch = "";
  pendingClaudeCommands = [];
  for (const interaction of raw) {
    batch += serializeClassifiedWithOverheadSplit(interaction, prev);
    if (!interaction.isSidechain) {
      prev = interaction.inputTokens + interaction.cacheReadTokens + interaction.cacheWriteTokens;
    }
    if (hasClaudeCommand(interaction)) pendingClaudeCommands.push({ interaction, prevCtx: prev });
  }
  if (batch) appendTagFile(tagPath, batch);
  appendTagFile(tagPath, JSON.stringify({ _meta: { offset: parsedSize, swept: Date.now() } }) + "\n");
  discoveredSubagentFiles = new Map();
  discoveredClaudeFiles = new Set();
  scanForSubAgents();
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] reparse end ${file}\n`);
  }
  return true;
}

function runReparse(one: string, from: string, to: string) {
  if (one) {
    if (!reparseOne(path.resolve(one))) process.exit(1);
    return;
  }
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    process.stderr.write("wtft-daemon: --reparse-range needs two YYYY-MM-DD dates\n");
    process.exit(2);
  }
  const files: string[] = [];
  walkSessions(path.resolve(harnessRoot("claude")), files);
  walkSessions(path.resolve(harnessRoot("pi")), files);
  for (const file of files) {
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
    if (mtime < fromMs || mtime >= toMs) continue;
    if (tagIsCurrent(file)) continue;
    try {
      reparseOne(file);
    } catch (err) {
      process.stderr.write(`[wtft-log-parser] reparse failed ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

async function main() {
  loadUserPricing();

  await loadExternalHarnesses();

  // ---

  let showList = false;
  let showCleanup = false;
  let showRestart = false;
  let stopSession = null;
  let harnessName = "";
  let reparsePath = "";
  let reparseFrom = "";
  let reparseTo = "";

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--session" || arg === "-s") {
      sessionPath = process.argv[++i];
    } else if (arg === "--harness") {
      harnessName = process.argv[++i] || "";
    } else if (arg === "--reparse") {
      reparsePath = process.argv[++i] || "";
    } else if (arg === "--reparse-range") {
      reparseFrom = process.argv[++i] || "";
      reparseTo = process.argv[++i] || "";
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
       wtft-daemon --harness <claude|pi> [--session <path>] [--debug]
       wtft-daemon --reparse <session.jsonl>
       wtft-daemon --reparse-range <YYYY-MM-DD> <YYYY-MM-DD>

Management:
  --list, -l            List every running wtft-daemon, including fixture processes
  --cleanup             Kill daemons whose session is gone, and fixture daemons under the tmp dir
  --restart             Kill all running daemons (fresh spawn on next wtft)
  --stop <session>      Drop that session. A per-session process exits. A harness process stays up.

Daemon mode:
  -s, --session <path>  Path to session.jsonl to watch
  --harness <claude|pi> One process for that harness root (WTFT_CLAUDE_PROJECTS_DIR or WTFT_PI_SESSIONS_DIR)
  --reparse <path>      Classify one session at disk speed and exit. No watch.
  --reparse-range <from> <to>
                        Reparse sessions under both harness roots whose mtime is in [from, to),
                        one at a time, and only when the current tag is missing or empty. No watch.
  --debug               Enable debug logging to stderr
  -h, --help            Show this help

Environment:
  WTFT_DAEMON_IDLE_MS          Milliseconds with no new lines before a session is dropped (default 86400000)
  WTFT_DAEMON_STARTUP_GRACE_MS Milliseconds after start before that drop can fire (default 60000)`);
      process.exit(0);
    } else if (arg === "--debug") {
      process.env.WTFT_DAEMON_DEBUG = "1";
    }
  }

// --- Management commands (no session required) ---

function procCmdline(pid: number): string {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { return ""; }
}

function procIsHarness(pid: number): boolean {
  return procCmdline(pid).split("\0").includes("--harness");
}

function procEnvValue(pid: number, key: string): string | null {
  try {
    const row = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find(item => item.startsWith(`${key}=`));
    return row ? row.slice(key.length + 1) : null;
  } catch {
    return null;
  }
}

if (stopSession) {
  const lease = getDaemonPidPath(path.resolve(stopSession));
  let holder = 0;
  try { holder = Number(fs.readFileSync(lease, "utf8").trim()); } catch { holder = 0; }
  if (holder > 0 && procIsHarness(holder)) {
    try { fs.unlinkSync(lease); } catch { /* already gone */ }
    console.log(`Stopped: PID ${holder} — session dropped from harness: ${stopSession}`);
    process.exit(0);
  }
}

if (showList || showCleanup || showRestart || stopSession) {
  const pidDir = os.tmpdir();
  let pidFiles: string[] = [];
  try {
    pidFiles = fs.readdirSync(pidDir).filter(f => f.startsWith("wtft-daemon-") && f.endsWith(".pid"));
  } catch (_) {}

  let found = 0;
  const seenPids = new Set<number>();
  const restarted = new Set<number>();
  for (const pidFile of pidFiles) {
    const fullPath = path.join(pidDir, pidFile);
    let pid = 0;
    try {
      pid = parseInt(fs.readFileSync(fullPath, "utf8").trim(), 10);
    } catch (_) { continue; }
    if (!(pid > 0)) continue;
    seenPids.add(pid);

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
      if (restarted.has(pid)) {
        try { fs.unlinkSync(fullPath); } catch { /* already gone */ }
        continue;
      }
      restarted.add(pid);
      const restartEnv = { ...process.env };
      if (alive) {
        for (const key of ["WTFT_CLAUDE_PROJECTS_DIR", "WTFT_PI_SESSIONS_DIR"]) {
          const value = procEnvValue(pid, key);
          if (value) restartEnv[key] = value;
        }
        try { process.kill(pid, "SIGTERM"); } catch (_) { /* already gone */ }
        waitUntilExited(pid);
      }
      try { fs.unlinkSync(fullPath); } catch (_) {}
      if (sessionFound) {
        try {
          const child = spawn(process.execPath, [process.argv[1], ...daemonLaunchArgs(sessionFound, restartEnv)], {
            detached: true,
            stdio: "ignore",
            env: restartEnv,
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
        if (procIsHarness(pid)) {
          try { fs.unlinkSync(fullPath); } catch (_) {}
          console.log(`Cleaned up: PID ${pid} — session dropped from harness: ${sessionFound}`);
        } else {
          try { process.kill(pid, "SIGTERM"); } catch (_) { /* already gone */ }
          try { fs.unlinkSync(fullPath); } catch (_) {}
          console.log(`Cleaned up: PID ${pid} — session gone: ${sessionFound}`);
        }
        found++;
        continue;
      }
    }

    if (stopSession && sessionFound === stopSession) {
      if (alive && procIsHarness(pid)) {
        try { fs.unlinkSync(fullPath); } catch (_) {}
        console.log(`Stopped: PID ${pid} — session dropped from harness: ${sessionFound}`);
      } else {
        if (alive) { try { process.kill(pid, "SIGTERM"); } catch (_) { /* already gone */ } }
        try { fs.unlinkSync(fullPath); } catch (_) {}
        console.log(`Stopped: PID ${pid} — ${sessionFound}`);
      }
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

  if (showList || showCleanup) {
    for (const proc of daemonProcs()) {
      if (seenPids.has(proc.pid) || proc.pid === process.pid) continue;
      const fixture = (proc.session !== null && pathIsUnderTmp(proc.session)) || proc.roots.some(pathIsUnderTmp);
      if (showCleanup && fixture) {
        try { process.kill(proc.pid, "SIGTERM"); } catch { /* already gone */ }
        const where = proc.session || proc.roots.join(",");
        console.log(`Cleaned up: PID ${proc.pid} — fixture daemon: ${where}`);
        found++;
        continue;
      }
      if (showList) {
        found++;
        const where = proc.session || (proc.harness ? `harness ${proc.roots.join(",") || "(unknown root)"}` : "(no session arg)");
        console.log(`PID ${String(proc.pid).padEnd(7)} ${"RUNNING".padEnd(20)} v${"?".padEnd(7)} idle: ${"?".padEnd(5)} ${where}`);
      }
    }
  }

  if (showRestart) {
    let harnessPidFiles: string[] = [];
    try {
      harnessPidFiles = fs.readdirSync(pidDir).filter(f => f.startsWith("wtft-harness-") && f.endsWith(".pid"));
    } catch { /* tmp dir unreadable */ }
    for (const pidFile of harnessPidFiles) {
      const fullPath = path.join(pidDir, pidFile);
      let pid = 0;
      try { pid = parseInt(fs.readFileSync(fullPath, "utf8").trim(), 10); } catch { continue; }
      if (pid <= 0 || seenPids.has(pid) || pid === process.pid) {
        try { fs.unlinkSync(fullPath); } catch { /* already gone */ }
        continue;
      }
      seenPids.add(pid);
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
      try { fs.unlinkSync(fullPath); } catch { /* already gone */ }
      console.log(`Restarted: PID ${pid} — harness ${pidFile}`);
      found++;
    }
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

  if (reparsePath || reparseFrom) {
    runReparse(reparsePath, reparseFrom, reparseTo);
    return;
  }
  if (harnessName) {
    runHarness(harnessName, sessionPath);
    return;
  }

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
    if (serviceSession() === "stop") return;
    setTimeout(loop, POLL_MS);
  };

  loop();
}

main().catch((err) => {
  process.stderr.write(`wtft-daemon: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});

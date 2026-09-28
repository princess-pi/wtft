#!/usr/bin/env -S node --experimental-strip-types


import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { projectsDir } from "../extensions/lib/harness/claude-code/discovery.js";
import { tagRecords, parseTagLine, lastOffset, isDataRecord } from "../extensions/lib/tag-log.js";
import { claimLease, claimLeaseForChild, unlinkLeaseIf, replaceLease as publishLease, leaseHolder } from "../extensions/lib/lease.js";
import { classifyPid, holdsLease, isDaemonCmdline, pidAlive, processTable, stopHolderSync } from "../extensions/lib/holder.js";
import { leasePid } from "../extensions/lib/lease.js";
import { daemonStdio, daemonLogPath, rotateDaemonLog, DAEMON_LOG_MAX_BYTES } from "../extensions/lib/daemon-log.js";
import { decideHealth, readHealthFacts } from "../extensions/lib/daemon-health.js";
import { readSession, flushTurns, scanChildren, resumeTagger, fsWorld, MTIME_SETTLE_MS, type LogLine } from "../extensions/lib/session-tagger.js";
import {
  newRegistry, newSessionRecord, serve, get, move, drop, markIdle, forgetIdle, expiredIdle, beginRetry, retryFired, cancelRetry,
  retryPending, isEmpty, servedOver, needsDir, projectInUse, sessionDirOf, handOff, parseHandOff, type SessionRecord,
} from "../extensions/lib/harness-registry.js";
import {
	loadUserPricing,
	resolveMovedSession,
	getCurrentVersionTagPath,
	getDaemonPidPath,
	daemonLaunchArgs,
	isSessionIdBasename,
	loadExternalHarnesses,
	WTFT_TAGGER_VERSION as TAGGER_VERSION,
	taggerIsOlder,
	lastLineStartByte,
	getTagPath,
} from "../extensions/lib/wtft-shared.js";


// ---

const TAG_SUFFIX = `.wtft-tag.v${TAGGER_VERSION}.jsonl`;
const USAGE = `Usage: wtft-daemon --session <path> [--debug]
       wtft-daemon --harness <claude|pi> [--session <path>] [--debug]
       wtft-daemon --list | --cleanup | --restart | --stop <session>  (one or more)`;
const POLL_MS = 667; // 90bpm throttle
/** How long one slice of a harness's subagent scan runs before it yields to the event loop. */
const HARNESS_SCAN_SLICE_MS = envMs("WTFT_HARNESS_SCAN_SLICE_MS", 25);
/** Pause between slices; 0 in use. A test sets it to make a scan outlast a
 *  report without writing hundreds of MB of fixture. */
const HARNESS_SCAN_YIELD_MS = envMs("WTFT_HARNESS_SCAN_YIELD_MS", 0);
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

let running = true;
let harnessMode = false;


// ---

function stopLine(reason: string): string {
  return JSON.stringify({ _hb: "stop", reason }) + "\n";
}

function shutdown(reason: string) {
  if (!running) return;
  running = false;
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-daemon] shutdown: ${reason}\n`);
  }
  // Taken-over daemon exits silently — must not recreate the tag or unlink the new owner's lease.
  if (leaseHolder(slot.pidPath) === String(process.pid)) {
    flushPending();
    try {
      if (fs.existsSync(slot.state.tagPath)) {
        appendTagFile(slot.state.tagPath, stopLine(reason));
      }
    } catch (_) {}
    unlinkLeaseIf(slot.pidPath, String(process.pid));
  }
  process.exit(0);
}

process.on("SIGTERM", () => { if (harnessMode) stopHarness("SIGTERM"); else shutdown("SIGTERM"); });
process.on("SIGINT", () => { if (harnessMode) stopHarness("SIGINT"); else shutdown("SIGINT"); });
process.on("SIGHUP", () => { if (harnessMode) stopHarness("SIGHUP"); else shutdown("SIGHUP"); });

// ---

let daemonLogCheckedAt = 0;

/** At most once a minute, from every poll of every served session. */
function rotateLogOnCadence(now: number) {
  if (now - daemonLogCheckedAt < 60_000) return;
  daemonLogCheckedAt = now;
  rotateDaemonLog(daemonLogPath(), DAEMON_LOG_MAX_BYTES);
}

/** Overwrite same-width heartbeat in place (fixed-width pwrite); else append. File never shrinks. */
function upsertHeartbeat(now: number) {
  const hbLine = JSON.stringify({ _hb: { first: slot.idleStartMs, last: now } }) + "\n";
  const hbBuf = Buffer.from(hbLine, "utf8");
  try {
    const fd = fs.openSync(slot.state.tagPath, "r+");
    try {
      const size = fs.fstatSync(fd).size;
      const lineStart = size > 0 ? lastLineStartByte(fd, size) : 0;
      if (size - lineStart === hbBuf.length) {
        const lineBuf = Buffer.alloc(hbBuf.length);
        fs.readSync(fd, lineBuf, 0, lineBuf.length, lineStart);
        if (parseTagLine(lineBuf.toString("utf8"))?.kind === "heartbeat") {
          fs.writeSync(fd, hbBuf, 0, hbBuf.length, lineStart);
          return;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
  }
  appendTagFile(slot.state.tagPath, hbLine);
}

function replaceLease(value: string): void {
  publishLease(slot.pidPath, value, String(process.pid));
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

function fatalTagMutation(filePath: string, operation: "append" | "rebuild truncate" | "partial-tail truncate" | "resume read" | "resume truncate" | "resume", err: unknown): never {
  if (running && harnessMode && holdsHarnessRoot()) writeServedHandOff(path.resolve(slot.state.sessionPath));
  running = false;
  let markedForRebuild = false;
  try {
    replaceLease("rebuild");
    markedForRebuild = true;
  } catch (_) {}
  try {
    fs.writeSync(2,
      `[wtft-daemon] FATAL: the derived tag ${operation} failed (${err instanceof Error ? err.message : String(err)}). ` +
      (markedForRebuild
        ? "The daemon lease now requires a rebuild; restart wtft to rederive the transient tag."
        : "The rebuild lease could not be recorded; restore storage, then run wtft -F to discard and rederive the transient tag.") +
      ` Tag: ${filePath}\n`,
    );
  } catch (_) {}
  process.exit(1);
}

const world = fsWorld();

function printLog(log: LogLine[]) {
  for (const line of log) {
    if (line.level === "warn" || process.env.WTFT_DAEMON_DEBUG) process.stderr.write(line.text + "\n");
  }
}

function flushPending() {
  const batch = flushTurns(slot.state);
  if (!batch) return;
  appendTagFile(slot.state.tagPath, batch);
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-daemon] session flush ${Date.now()} ${path.basename(slot.state.sessionPath)}\n`);
  }
  slot.idleStartMs = 0;
  slot.lastWriteMs = Date.now();
}

function scanForSubAgents() {
  const scan = scanChildren(slot.state, world, harnessMode ? { sliceMs: HARNESS_SCAN_SLICE_MS } : {});
  printLog(scan.log);
  if (scan.records) appendTagFile(slot.state.tagPath, scan.records);
  if (scan.wrote) {
    const now = Date.now();
    slot.lastWriteMs = now;
    slot.lastActivityMs = now;
    slot.idleStartMs = 0;
  }
  if (!scan.cut) return;
  // The record in hand, not a lookup: in the poll that detects a move the
  // registry still keys it by the old path until wake re-keys it.
  const owner = slot;
  if (owner.scanContinuing) return;
  owner.scanContinuing = true;
  const next = () => {
    // The record may have moved since the cut; the flag travels with it.
    const current = path.resolve(owner.state.sessionPath);
    if (get(registry, current) !== owner || !running) return;
    owner.scanContinuing = false;
    if (!leaseStillOurs(owner)) {
      leaseLost(current, owner);
      return;
    }
    withSlot(owner, () => scanForSubAgents());
  };
  if (HARNESS_SCAN_YIELD_MS > 0) setTimeout(next, HARNESS_SCAN_YIELD_MS);
  else setImmediate(next);
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


// ---


// ---

/** Session move: re-point sessionPath only; keep tagPath fixed so --watch survives. */
function followMovedSession(): boolean {
  const moved = resolveMovedSession(slot.state.sessionPath);
  if (!moved) return false;
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-daemon] session moved: ${slot.state.sessionPath} -> ${moved}\n`);
  }
  slot.state.sessionPath = moved;
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
      for (const r of tagRecords(content)) {
        if (r.kind === "turn" || r.kind === "offset" || r.kind === "swept" || r.kind === "unswept"
          || r.kind === "spawn-pending" || r.kind === "spawn-settled" || r.kind === "meta-other") return true;
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

  // One process can hold many leases (a harness daemon holds one per session
  // it serves), so each distinct pid is examined once and its outcome applied to all of them.
  type Lease = { path: string; dev: number; ino: number };
  const leasesOf = new Map<number, Lease[]>();
  for (const pidFile of pidFiles) {
    const fullPath = path.join(pidDir, pidFile);
    let pid = 0;
    let lease: Lease;
    try {
      const stat = fs.statSync(fullPath);
      lease = { path: fullPath, dev: stat.dev, ino: stat.ino };
      pid = leasePid(fs.readFileSync(fullPath, "utf8").trim());
    } catch (_) { continue; }
    if (!(pid > 0)) continue;
    const leases = leasesOf.get(pid);
    if (leases) leases.push(lease);
    else leasesOf.set(pid, [lease]);
  }
  const sessionOf = new Map<number, string | null>();
  const unlinkIfStill = (lease: Lease, pid: number) => { unlinkLeaseIf(lease.path, String(pid), lease); };

  for (const [pid, leases] of leasesOf) {
    // EPERM is a live process this user cannot signal, and its leases stay; a
    // zombie, or a live process that is not a daemon, holds nothing.
    const kind = classifyPid(pid);
    const alive = holdsLease(kind);

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

    // HARD: session gone (not moved, not never-written). Never our own PID, and
    // never a harness: its --session is only the one it was started for.
    if (pid !== process.pid && kind === "daemon" && sessionFound && sessionIsGone(sessionFound)) {
      // A process that refuses the signal is still alive, so its leases stay.
      const gone = processTable().signal(pid, "SIGTERM") !== "denied";
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
          const records = tagRecords(content);
          const heartbeats = records.filter(r => r.kind === "heartbeat");
          const hbRatio = lines.length > 0 ? heartbeats.length / lines.length : 0;

          if (stat.size > TAG_SIZE_WARN) {
            const mb = (stat.size / (1024 * 1024)).toFixed(1);
            findings.push(`tag file large (${mb} MB) — ${tagFound}`);
          }

          if (lines.length > 10 && hbRatio >= HB_RATIO_WARN) {
            const pct = Math.round(hbRatio * 100);
            findings.push(`${pct}% heartbeats (${heartbeats.length}/${lines.length} lines) — possible malfunction — ${tagFound}`);
          }

          if (!records.some(r => r.kind === "turn")) {
            const startTime = heartbeats[0]?.first;
            if (startTime && (Date.now() - startTime) > ZERO_INTERACTIONS_AGE) {
              const ageH = Math.round((Date.now() - startTime) / 3600000);
              findings.push(`${ageH}h old with zero real interactions — zombie daemon? — ${sessionFound}`);
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
  const tagPath = slot.state.tagPath;
  // Mid-line tag tail → rebuild, do not resume (cut alone can double-bill id-less turns).
  if (truncatePartialTail(tagPath)) {
    process.stderr.write(`[wtft-daemon] ${tagPath} ended mid-line — a previous daemon was killed inside an append; rebuilding this tag from the transcript (#130)\n`);
    slot.rebuildTagOnStartup = true;
  }

  if (slot.rebuildTagOnStartup) {
    try {
      fs.truncateSync(tagPath, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        fatalTagMutation(tagPath, "rebuild truncate", err);
      }
    }
    slot.state.lastSize = 0;
  } else {
    // A tag that cannot be read or cleared is never appended onto: a re-parse from byte 0
    // would add every turn after the old ones, and id-less turns would bill twice.
    let tagContent: string | null = null;
    try {
      tagContent = fs.readFileSync(tagPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") fatalTagMutation(tagPath, "resume read", err);
    }
    const records = tagContent === null ? [] : tagRecords(tagContent);
    const hasData = records.some(r => isDataRecord(r) || r.kind === "unknown");
    const metaOffset = hasData ? lastOffset(records) : null;
    if (tagContent !== null && metaOffset !== null) {
      slot.state.lastSize = metaOffset;
      // Written by an earlier life; what changed since is not read yet.
      let resumed: ReturnType<typeof resumeTagger>;
      try { resumed = resumeTagger(slot.state, tagContent, world); } catch (err) { fatalTagMutation(tagPath, "resume", err); }
      printLog(resumed.log);
      if (resumed.records) appendTagFile(tagPath, resumed.records);
    } else {
      if (tagContent !== null) {
        try { fs.truncateSync(tagPath, 0); } catch (err) { fatalTagMutation(tagPath, "resume truncate", err); }
      }
      slot.state.lastSize = 0;
    }
  }

  const startNow = Date.now();
  appendTagFile(tagPath, JSON.stringify({ _hb: { first: startNow, last: startNow } }) + "\n");
  slot.idleStartMs = startNow;
}

// ---

/** Why serviceSession last dropped a harness session, for its stop line. */
let dropReason = "";
function dropFor(reason: string): "drop" {
  dropReason = reason;
  return "drop";
}

function serviceSession(): "continue" | "stop" | "drop" {
  rotateLogOnCadence(Date.now());
  const state = slot.state;
  if (leaseHolder(slot.pidPath) !== String(process.pid)) {
    if (harnessMode) return "drop";
    logLeaseLost(state.sessionPath, slot.pidPath);
    running = false;
    process.exit(0);
  }

  if (!fs.existsSync(state.sessionPath)) {
    if (slot.sessionExisted) {
      if (!followMovedSession()) {
        if (harnessMode) return dropFor("session removed");
        shutdown("session removed");
        return "stop";
      }
    }
    const now = Date.now();
    if (!slot.sessionExisted && now - slot.startupTime >= SESSION_WAIT_MAX_MS) {
      if (harnessMode) return dropFor("session never written");
      shutdown("session never written");
      return "stop";
    }
    if (slot.idleStartMs === 0) slot.idleStartMs = now;
    if (!harnessMode || slot.displayed) upsertHeartbeat(now);
    slot.lastWriteMs = now;
    slot.lastActivityMs = now;
    return "continue";
  }
  slot.sessionExisted = true;

  try {
    const read = readSession(state, world);
    printLog(read.log);
    if (read.records) appendTagFile(state.tagPath, read.records);
    if (read.activity) slot.lastActivityMs = Date.now();
    if (read.wrote) {
      slot.lastWriteMs = Date.now();
      slot.lastActivityMs = slot.lastWriteMs;
      slot.idleStartMs = 0;
    }

    const now = Date.now();
    if (state.pendingItems.length > 0 && (now - slot.lastWriteMs) >= POLL_MS) {
      flushPending();
    }

    scanForSubAgents();

    if (state.pendingItems.length === 0 && (!harnessMode || slot.displayed)) {
      if (slot.idleStartMs === 0) slot.idleStartMs = now;
      upsertHeartbeat(now);
      slot.lastWriteMs = now;
    }

    if (now - slot.lastActivityMs >= IDLE_EXIT_MS && now - slot.startupTime >= STARTUP_GRACE_MS) {
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-daemon] no new data for ${Math.round((now - slot.lastActivityMs) / 60000)}m, ${harnessMode ? "dropping the session" : "exiting"}\n`);
      }
      if (harnessMode) {
        droppedForIdle = true;
        return dropFor("idle timeout");
      }
      shutdown("idle timeout");
      return "stop";
    }

    if (!fs.existsSync(state.sessionPath) && !followMovedSession()) {
      if (harnessMode) return dropFor("session removed");
      shutdown("session removed");
      return "stop";
    }
  } catch (err) {
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-daemon] poll error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return "continue";
}

const HARNESS_SKIP_DIRS = new Set(["subagents", "tool-results", "memory", "wtft-tags"]);

type Slot = SessionRecord;

/** What the harness knows about each session: docs/spec-harness-registry.md. */
const registry = newRegistry();
const harnessWatchers = new Map<string, fs.FSWatcher>();
let harnessPidFile = "";
let harnessIdleTimer: ReturnType<typeof setInterval> | null = null;

/** The session being served right now: the one slot in per-session mode, or
 *  whichever `withSlot` made current. */
let slot: Slot = newSessionRecord("", true, Date.now());

function withSlot<T>(next: Slot, fn: () => T): T {
  const prev = slot;
  slot = next;
  try {
    return fn();
  } finally {
    slot = prev;
  }
}

/** A live daemon, per-session or harness, verified by its cmdline: never true off Linux. */
function procIsDaemon(pid: number): boolean {
  const kind = classifyPid(pid);
  return kind === "daemon" || kind === "harness";
}

function procIsHarness(pid: number): boolean {
  return classifyPid(pid) === "harness";
}

/** A holder that is a live daemon process keeps its lease; `rebuild`, a
 *  dead pid, or a live process that is not a daemon does not. */
function holderIsLiveDaemon(holder: string): boolean {
  const pid = leasePid(holder);
  return pid !== process.pid && procIsDaemon(pid);
}

/** The holder the last `claimPidFile` judged stale and displaced, "" when none.
 *  Read it after the claim, never before: the rebuild decision comes from the
 *  value actually unlinked, not from an earlier read. */
let displacedHolder = "";
function claimPidFile(file: string): "claimed" | "busy" {
  displacedHolder = "";
  return claimLease(file, String(process.pid), (holder) => {
    const live = holderIsLiveDaemon(holder);
    if (!live) displacedHolder = holder;
    return live;
  });
}

function harnessRoot(which: string, env: NodeJS.ProcessEnv = process.env): string {
  if (which === "claude") {
    return projectsDir(env);
  }
  if (which === "pi") {
    return env.WTFT_PI_SESSIONS_DIR || path.join(os.homedir(), ".pi", "agent", "sessions");
  }
  process.stderr.write("wtft-daemon: --harness must be claude, claude-code or pi\n");
  process.exit(2);
}

function adoptSession(): boolean {
  if (slot.state.sessionPath.includes(".wtft-tag.v")) return false;
  slot.state.tagPath = getCurrentVersionTagPath(slot.state.sessionPath);
  try { fs.mkdirSync(path.dirname(slot.state.tagPath), { recursive: true }); } catch { /* exists */ }
  slot.pidPath = getDaemonPidPath(slot.state.sessionPath);
  if (!takeOverLease(slot.pidPath)) return false;
  if (displacedHolder === "rebuild") slot.rebuildTagOnStartup = true;
  initClassified();
  return true;
}

function takeOverLease(pidPath: string): boolean {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (claimPidFile(pidPath) === "claimed") return true;
    const holder = leasePid(leaseHolder(pidPath));
    if (holder === process.pid) return true;
    if (procIsDaemon(holder)) {
      // A harness serves other sessions too; one that is stopping lets go itself.
      if (procIsHarness(holder)) return false;
      processTable().signal(holder, "SIGTERM");
    }
    sleepMs(50);
  }
  return claimPidFile(pidPath) === "claimed";
}

function scheduleFlush(key: string) {
  const slot = get(registry, key);
  if (!slot || slot.flushTimer || slot.state.pendingItems.length === 0) return;
  const wait = Math.max(0, POLL_MS - (Date.now() - slot.lastWriteMs));
  const timer = setTimeout(() => {
    const current = get(registry, key);
    if (!current || current.flushTimer !== timer) return;
    current.flushTimer = null;
    if (!leaseStillOurs(current)) {
      leaseLost(key, current);
      return;
    }
    withSlot(current, () => {
      flushPending();
      scanForSubAgents();
    });
  }, wait);
  timer.unref();
  slot.flushTimer = timer;
}

function wake(file: string, displayed: boolean) {
  const key = path.resolve(file);
  let slot = get(registry, key);
  // A `rebuild` lease (wtft -F) is adopted afresh, which honours it. Any other
  // lease that is not ours drops the session in serviceSession, as --stop means.
  if (slot && slot.pidPath && leaseHolder(slot.pidPath) === "rebuild") {
    displayed = displayed || slot.displayed;
    dropHarnessSlot(key);
    slot = undefined;
  }
  if (!slot) {
    slot = newSessionRecord(key, displayed, Date.now());
    slot.sessionExisted = fs.existsSync(key);
    if (!withSlot(slot, () => adoptSession())) {
      retryAdoptionLater(key, displayed);
      return;
    }
    serve(registry, key, slot);
    watchSession(key);
  } else if (displayed) {
    slot.displayed = true;
  }
  droppedForIdle = false;
  dropReason = "";
  const status = withSlot(slot, () => serviceSession());
  if (status === "drop") {
    if (droppedForIdle) dropForIdle(key, slot.displayed);
    dropHarnessSlot(key, dropReason);
    return;
  }
  const movedTo = slot.state.sessionPath;
  if (movedTo !== key) {
    const other = get(registry, movedTo);
    if (other && other !== slot) dropHarnessSlot(movedTo);
    const moved = move(registry, key, movedTo);
    if (moved?.flushTimer) clearTimeout(moved.flushTimer);
    unwatchSession(key);
    watchSession(movedTo);
  }
  if (slot.state.pendingItems.length > 0) scheduleFlush(movedTo);
}

/** Watches `dir`, and with `recurse` every directory below it that is not a
 *  skip directory. Only these are watched: the project directory holding a
 *  served or idle-dropped transcript, a served session's own directory tree
 *  (`<id>/`, `<id>/subagents/`, nested ones). */
function watchDir(dir: string, recurse: boolean) {
  const key = path.resolve(dir);
  if (harnessWatchers.has(key)) return;
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(key, (event, filename) => onWatch(key, filename ? String(filename) : null));
  } catch {
    // The sweep reads what this would have woken, and tries again.
    unwatchedDirs.set(key, { recurse, triedAt: Date.now() });
    return;
  }
  unwatchedDirs.delete(key);
  watcher.on("error", () => {
    harnessWatchers.delete(key);
    try { watcher.close(); } catch { /* already closed */ }
    try {
      if (fs.statSync(key).isDirectory()) watchDir(key, recurse);
    } catch { /* directory is gone */ }
    for (const [file, slot] of registry.served) {
      if (path.dirname(file) === key || sessionDirOf(file) === key || key.startsWith(sessionDirOf(file) + path.sep)) {
        wake(file, slot.displayed);
      }
    }
  });
  harnessWatchers.set(key, watcher);
  if (!recurse) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(key, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (HARNESS_SKIP_DIRS.has(ent.name) && ent.name !== "subagents") continue;
    watchDir(path.resolve(key, ent.name), true);
  }
}

/** Directories whose watch failed. */
const unwatchedDirs = new Map<string, { recurse: boolean; triedAt: number }>();
const WATCH_RETRY_MS = 10_000;

function watchSession(file: string) {
  watchDir(path.dirname(file), false);
  if (fs.existsSync(sessionDirOf(file))) watchDir(sessionDirOf(file), true);
}

/** Size, inode and mtime: a same-length rewrite or a replacement is a write too. */
function idleSignature(key: string): string {
  try {
    const st = fs.statSync(key);
    return `${st.size}:${st.ino}:${st.mtimeMs}`;
  } catch { return ""; }
}

function dropForIdle(key: string, displayed: boolean, since = Date.now()) {
  markIdle(registry, key, displayed, idleSignature(key), since);
}

/** Set by serviceSession when it drops a harness session for idling. */
let droppedForIdle = false;
let idleDroppedPrunedAt = 0;

/** Closes what only `file` needed: its session directory tree, and its
 *  project directory once no served session is left in it. */
function unwatchSession(file: string) {
  const own = sessionDirOf(file);
  const project = path.dirname(file);
  const inUse = projectInUse(registry, project, file);
  for (const [dir, watcher] of harnessWatchers) {
    const mine = dir === own || dir.startsWith(own + path.sep);
    if (!mine && !(dir === project && !inUse)) continue;
    try { watcher.close(); } catch { /* already closed */ }
    harnessWatchers.delete(dir);
  }
}

/** A session that could not be adopted is tried again every POLL_MS. */
function retryAdoptionLater(key: string, displayed: boolean) {
  if (!running) return;
  const begun = beginRetry(registry, key, displayed);
  if (begun.kind === "pending") return;
  if (begun.kind === "gave-up") {
    const lease = getDaemonPidPath(key);
    const holder = leaseHolder(lease);
    const why = key.includes(".wtft-tag.v") ? "it is a tag file"
      : holder && holder !== String(process.pid) ? `its lease names ${holder}`
      : "its lease could not be claimed";
    process.stderr.write(`[wtft-daemon] could not adopt ${key}: ${why}\n`);
    // Not tried again until it is written again.
    const idle = registry.idle.get(key);
    if (idle) dropForIdle(key, idle.displayed);
    // A reader must not be told the session is served.
    unlinkIfHolds(lease, String(process.pid));
    if (!fs.existsSync(lease)) {
      try { fs.unlinkSync(`${lease}.display`); } catch { /* already gone */ }
    }
    return;
  }
  const timer = setTimeout(() => {
    // Null when an adoption or a drop cancelled it since.
    const fired = retryFired(registry, key);
    if (!fired) return;
    if (running && !get(registry, key)) wake(key, fired.displayed);
    if (get(registry, key)) cancelRetry(registry, key);
  }, POLL_MS);
  timer.unref();
}

const RESPAWN_SETTLE_MS = 1000;

function sleepMs(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function unlinkIfHolds(file: string, value: string): boolean {
  return unlinkLeaseIf(file, value);
}

function onWatch(dir: string, filename: string | null) {
  if (!filename) {
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write("[wtft-daemon] watch overflow, rescanning offsets once\n");
    }
    for (const [file, slot] of registry.served) wake(file, slot.displayed);
    return;
  }
  if (HARNESS_SKIP_DIRS.has(filename) && filename !== "subagents") return;
  const full = path.resolve(dir, filename);
  let st: fs.Stats | null = null;
  try {
    // Not followed: a symlinked directory would pull its whole target in.
    st = fs.lstatSync(full);
  } catch {
    st = null;
  }
  const over = servedOver(registry, full);
  if (st?.isDirectory()) {
    // A session directory or a subagents directory appearing under a served
    // session; any other directory is not being served.
    if (over || registry.served.has(`${full}.jsonl`)) watchDir(full, true);
    const parent = over ?? (registry.served.has(`${full}.jsonl`) ? `${full}.jsonl` : null);
    if (parent) wake(parent, get(registry, parent)?.displayed ?? true);
    return;
  }
  if (over) {
    wake(over, get(registry, over)?.displayed ?? true);
    return;
  }
  if (st && filename.endsWith(".jsonl") && !filename.includes(".wtft-tag.")) {
    const slot = get(registry, full);
    if (slot) {
      wake(full, slot.displayed);
      return;
    }
    const idle = registry.idle.get(full);
    if (idle) {
      wake(full, idle.displayed);
      return;
    }
    // A Pi child session is a sibling file naming its parent inside it, so a
    // new or growing sibling may belong to a served session in this directory.
    if (harnessWhich === "pi") {
      for (const [file, other] of registry.served) if (path.dirname(file) === dir) wake(file, other.displayed);
    }
    return;
  }
  // A replace-via-rename often reports only the path that disappeared.
  const watched = path.resolve(dir);
  for (const [file, slot] of registry.served) {
    if (path.dirname(file) !== watched) continue;
    let now: fs.Stats;
    try {
      now = fs.statSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") wake(file, slot.displayed);
      continue;
    }
    if (now.ino !== slot.state.sessionIno || now.size !== slot.state.lastSize) wake(file, slot.displayed);
  }
}

/** Hands `file` to the live harness. When the request cannot be posted, it
 *  returns true only if that harness still holds the root and already held
 *  this session's lease (it is serving it); otherwise a lease and `.display`
 *  naming it are removed and it returns false, so the caller can claim the
 *  root once that harness has gone. */
function pointSessionAt(livePid: number, file: string): boolean {
  const lease = getDaemonPidPath(file);
  let held = false;
  let leaseText = "";
  try { leaseText = fs.readFileSync(lease, "utf8").trim(); } catch { /* no lease yet */ }
  const holder = leasePid(leaseText);
  held = holder === livePid;
  // The spawner claimed this lease for this process; it is handed on, not held.
  const mine = holder === process.pid;
  // A rebuild token stays for the harness to read when it adopts, and a lease
  // another live daemon holds is left for the harness's adoption to take by
  // its own rules (never from a harness; a per-session daemon is stopped first).
  if (leaseText !== "rebuild" && (held || mine || !procIsDaemon(holder))) {
    publishLease(lease, String(livePid), String(process.pid));
  }
  try { fs.writeFileSync(`${lease}.display`, ""); } catch { /* the live process still has the old focus */ }
  // The live process may hold no slot for this session yet: ask it by name.
  // One file per requester, so two requests never overwrite each other.
  try {
    // A posted request counts only if the harness still holds the root after
    // it was written; one it gave up meanwhile would never read it.
    const dir = `${harnessPidFile}.focus.d`;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const request = path.join(dir, `${process.pid}.tmp`);
    fs.writeFileSync(request, JSON.stringify({ pid: livePid, path: path.resolve(file) }));
    fs.renameSync(request, path.join(dir, `${process.pid}.request`));
    if (fs.readFileSync(harnessPidFile, "utf8").trim() !== String(livePid)) {
      try { fs.unlinkSync(path.join(dir, `${process.pid}.request`)); } catch { /* taken */ }
      throw new Error("the harness gave up the root");
    }
  } catch (err) {
    // With no request the harness may never adopt this session, so a lease
    // this call pointed at it must not claim it is served. One the harness
    // already held is its own and stays.
    let stillHarness = false;
    try { stillHarness = fs.readFileSync(harnessPidFile, "utf8").trim() === String(livePid); } catch { /* removed */ }
    if (!held || !stillHarness) {
      unlinkIfHolds(lease, String(livePid));
      try { fs.unlinkSync(`${lease}.display`); } catch { /* already gone */ }
    }
    process.stderr.write(`wtft-daemon: could not ask the running harness (pid ${livePid}) to serve ${file}: ${err instanceof Error ? err.message : String(err)}\n`);
    return held && stillHarness;
  }
  return true;
}

let harnessRootKey = "";
let harnessWhich = "";

/** Serves the sessions other processes asked for (`pointSessionAt`). */
function takeFocusRequests() {
  if (!harnessPidFile || !holdsHarnessRoot()) return;
  for (const file of claimFocusRequests()) wake(file, true);
}

/** Claims every posted request by renaming it before it is read, and returns
 *  the sessions asked for under this root. The harness pid a request names is
 *  not checked: one addressed to a harness that has since been displaced is
 *  this one's to serve. */
function claimFocusRequests(): string[] {
  const dir = `${harnessPidFile}.focus.d`;
  let names: string[];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith(".request")); } catch { return []; }
  const files: string[] = [];
  for (const name of names) {
    const claimed = path.join(dir, `${name}.${process.pid}.claimed`);
    let text = "";
    try {
      fs.renameSync(path.join(dir, name), claimed);
      text = fs.readFileSync(claimed, "utf8");
    } catch { /* taken by another reader, or unreadable */ }
    try { fs.unlinkSync(claimed); } catch { /* never claimed */ }
    let requested = "";
    try {
      const request = JSON.parse(text) as { path?: unknown };
      requested = typeof request.path === "string" ? request.path : "";
    } catch {
      // An older build's request: "<pid>\n<path>".
      requested = (text.split("\n")[1] ?? "").trim();
    }
    if (!requested) continue;
    const file = path.resolve(requested);
    if (file.startsWith(harnessRootKey + path.sep)) files.push(file);
  }
  return files;
}

/** A request is served as soon as it is posted, not at the next sweep. The
 *  sweep still reads the directory, so a lost event only delays one. */
let focusWatcher: fs.FSWatcher | null = null;
/** The sweep re-arms it after an error. */
function watchFocusRequests() {
  const dir = `${harnessPidFile}.focus.d`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const watcher = fs.watch(dir, () => { if (running) takeFocusRequests(); });
    watcher.on("error", () => {
      try { watcher.close(); } catch { /* closed */ }
      if (focusWatcher === watcher) focusWatcher = null;
    });
    focusWatcher = watcher;
  } catch { /* the sweep still serves requests */ }
}

function harnessPidFileFor(which: string, root: string): string {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `wtft-harness-${which}-${hash}.pid`);
}

function harnessVersionFile(pid: number): string {
  return `${harnessPidFile}.${pid}.version`;
}

function runHarness(which: string, focus: string) {
  // A start that serves nothing gives back a lease its spawner claimed for it.
  const quit = (code: number): never => {
    if (focus) unlinkLeaseIf(getDaemonPidPath(focus), String(process.pid));
    process.exit(code);
  };
  const root = path.resolve(harnessRoot(which));
  if (!fs.existsSync(root)) {
    process.stderr.write(`wtft-daemon: harness root does not exist: ${root}\n`);
    quit(1);
  }
  if (focus) {
    const focusKey = path.resolve(focus);
    if (focusKey !== root && !focusKey.startsWith(root + path.sep)) {
      process.stderr.write(`wtft-daemon: --session is outside the harness root: ${focusKey}\n`);
      quit(2);
    }
  }
  harnessPidFile = harnessPidFileFor(which, root);
  // Written before the claim, so a harness that holds the pid file always has
  // one; keyed by pid, so one left by a killed harness names nobody live.
  fs.writeFileSync(harnessVersionFile(process.pid), TAGGER_VERSION);
  const leave = (code: number): never => {
    try { fs.unlinkSync(harnessVersionFile(process.pid)); } catch { /* already gone */ }
    return quit(code);
  };
  for (let attempt = 1; claimPidFile(harnessPidFile) === "busy"; attempt++) {
    if (attempt > 5) {
      process.stderr.write(`wtft-daemon: could not claim ${harnessPidFile}${focus ? ` or hand ${focus} to the harness holding it` : ""}\n`);
      leave(1);
    }
    const live = leasePid(leaseHolder(harnessPidFile));
    if (!procIsDaemon(live)) continue;
    let liveVersion = "";
    try { liveVersion = fs.readFileSync(harnessVersionFile(live), "utf8").trim(); } catch { /* a build from before version files */ }
    if (!taggerIsOlder(liveVersion, TAGGER_VERSION)) {
      if (!focus || pointSessionAt(live, focus)) leave(0);
      // Not posted: that harness is usually stopping, so try to claim the root
      // once it has gone.
      const until = Date.now() + 2000;
      while (Date.now() < until && procIsDaemon(live)) sleepMs(50);
      continue;
    }
    stopHolderSync(live);
  }
  harnessMode = true;
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-daemon] harness pid ${harnessPidFile}\n`);
    process.stderr.write(`[wtft-daemon] harness root ${root}\n`);
  }
  harnessRootKey = root;
  harnessWhich = which;
  // Serves only the sessions readers ask for: this one, and later ones named
  // by focus requests. Nothing else under the root is read or watched.
  if (focus) wake(path.resolve(focus), true);
  takeServedHandOff();
  watchFocusRequests();
  harnessIdleTimer = setInterval(sweepIdleSlots, 250);
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-daemon] harness settled ${which}\n`);
  }
}

/** `reason`, when given, is written as the session's stop line. */
function dropHarnessSlot(key: string, reason = "") {
  const slot = get(registry, key);
  const ours = slot ? leaseStillOurs(slot) : false;
  // A lease another daemon holds means the tag is its to write; it resumes from
  // the tag's offset, so these turns are not lost.
  if (slot && ours && (slot.state.pendingItems.length > 0 || reason)) {
    withSlot(slot, () => {
      flushPending();
      if (reason && fs.existsSync(slot.state.tagPath)) appendTagFile(slot.state.tagPath, stopLine(reason));
    });
  }
  if (slot && !ours) logLeaseLost(key, slot.pidPath);
  const { flushTimer } = drop(registry, key);
  if (flushTimer) clearTimeout(flushTimer);
  unwatchSession(key);
  if (slot) releaseLease(slot);
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-daemon] session drop ${path.basename(key)}\n`);
  }
}

/** A lease that still names this process, and that no other slot shares, is
 *  removed; one another process has taken since it was read is left alone. */
function releaseLease(slot: Slot) {
  if (!slot.pidPath) return;
  for (const other of registry.served.values()) if (other !== slot && other.pidPath === slot.pidPath) return;
  if (!unlinkLeaseIf(slot.pidPath, String(process.pid))) return;
  try { fs.rmSync(`${slot.pidPath}.display`, { force: true }); } catch { /* already gone */ }
}

function slotNeedsChildScan(slot: Slot, now: number): boolean {
  if (slot.state.pendingClaudeCommands.length > 0) return true;
  // No watch event will come for a subagent written there, so it is polled.
  const tree = slot.state.sessionPath.replace(/\.jsonl$/, "");
  if (now - slot.unwatchedTreeScanAt >= POLL_MS
    && [...unwatchedDirs.keys()].some(dir => dir === tree || dir.startsWith(tree + path.sep) || tree.startsWith(dir + path.sep))) {
    slot.unwatchedTreeScanAt = now;
    return true;
  }
  if (slot.state.reseedPending) return true;
  for (const state of slot.state.discoveredSubagentFiles.values()) {
    if (state.pendingTurn) return true;
    if (now <= state.spawnWindowClosesAt + MTIME_SETTLE_MS) return true;
  }
  return false;
}

function leaseStillOurs(slot: Slot): boolean {
  if (!slot.pidPath) return true;
  return leaseHolder(slot.pidPath) === String(process.pid);
}

/** A served session whose lease is not ours any more: one reading `rebuild`
 *  (wtft -F) is adopted afresh, anything else dropped. */
function leaseLost(key: string, slot: Slot) {
  if (slot.pidPath && leaseHolder(slot.pidPath) === "rebuild") wake(key, slot.displayed);
  else dropHarnessSlot(key);
}

function logLeaseLost(session: string, lease: string) {
  process.stderr.write(`[wtft-daemon] gave up ${session}: its lease now reads ${JSON.stringify(leaseHolder(lease))}\n`);
}

function sweepIdleSlots() {
  if (!running) return;
  // Removed (--restart) or taken by another harness: this one is no longer the
  // root's harness, and two would contend for every session's lease.
  if (harnessPidFile) {
    let holder = "";
    try {
      holder = fs.readFileSync(harnessPidFile, "utf8").trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        const why = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[wtft-daemon] FATAL: the harness cannot read its pid file ${harnessPidFile}: ${why}\n`);
        stopHarness(`cannot read its pid file: ${why}`, 1);
        return;
      }
    }
    if (holder !== String(process.pid)) {
      stopHarness(holder ? `harness pid file names ${holder}` : "harness pid file removed or empty");
      return;
    }
  }
  try {
    fs.statSync(harnessRootKey);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      stopHarness("harness root removed");
      return;
    }
    if (!rootStatWarned) {
      rootStatWarned = true;
      process.stderr.write(`[wtft-daemon] WARNING: the harness root ${harnessRootKey} could not be stat'd: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  takeFocusRequests();
  const now = Date.now();
  const pruneGone = now - idleDroppedPrunedAt >= 60_000;
  if (pruneGone) idleDroppedPrunedAt = now;
  const aged = new Set(expiredIdle(registry, now, IDLE_EXIT_MS));
  for (const key of [...registry.idle.keys()]) {
    if (!aged.has(key) && !(pruneGone && !fs.existsSync(key))) continue;
    forgetIdle(registry, key);
    unwatchSession(key);
  }
  for (const key of [...registry.served.keys()]) {
    const slot = get(registry, key);
    if (!slot) continue;
    if (!leaseStillOurs(slot)) {
      leaseLost(key, slot);
      continue;
    }
    // A lost or missing watch event only delays a wake: a transcript that is
    // gone, has grown or was replaced is woken here.
    if (now - slot.checkedAtMs >= POLL_MS) {
      slot.checkedAtMs = now;
      let st: fs.Stats | null = null;
      try { st = fs.statSync(slot.state.sessionPath); } catch { /* gone, or not written yet */ }
      if (!st || st.ino !== slot.state.sessionIno || st.size !== slot.state.lastSize || slot.state.pendingFragment.length > 0 || slot.state.sessionReadFailed) {
        wake(key, slot.displayed);
        if (get(registry, key) !== slot) continue;
      }
    }
    if (slot.pidPath && fs.existsSync(`${slot.pidPath}.display`)) {
      slot.displayed = true;
      try { fs.unlinkSync(`${slot.pidPath}.display`); } catch { /* already gone */ }
      withSlot(slot, () => upsertHeartbeat(Date.now()));
    }
    if (slotNeedsChildScan(slot, now)) {
      slot.state.pollHadFailure = slot.state.sessionReadFailed;
      withSlot(slot, () => scanForSubAgents());
    }
    const current = get(registry, key);
    if (!current) continue;
    if (current.state.pendingItems.length > 0) continue;
    if (now - current.startupTime < STARTUP_GRACE_MS) continue;
    if (now - current.lastActivityMs < IDLE_EXIT_MS) continue;
    dropForIdle(key, current.displayed);
    dropHarnessSlot(key, "idle timeout");
  }
  for (const [key, idle] of [...registry.idle]) {
    if (!unwatchedDirs.has(path.dirname(key)) || retryPending(registry, key)) continue;
    const signature = idleSignature(key);
    if (signature !== "" && signature !== idle.sig) wake(key, idle.displayed);
  }
  for (const [dir, failed] of unwatchedDirs) {
    if (now - failed.triedAt < WATCH_RETRY_MS) continue;
    if (!needsDir(registry, dir)) unwatchedDirs.delete(dir);
    else watchDir(dir, failed.recurse);
  }
  if (!focusWatcher) watchFocusRequests();
  if (!isEmpty(registry)) emptySinceMs = 0;
  else if (emptySinceMs === 0) emptySinceMs = now;
  else if (now - emptySinceMs >= IDLE_EXIT_MS) {
    // A request posted since this sweep read them would otherwise be left
    // with a lease pointing at a harness that is gone.
    takeFocusRequests();
    if (isEmpty(registry)) {
      stopHarness("no session served");
      return;
    }
    emptySinceMs = 0;
  }
  persistHandOff();
}

let rootStatWarned = false;

/** When the harness last had no session to serve, or 0. */
let emptySinceMs = 0;

/** What this harness served, for the next harness on this root: one JSON
 *  object per line, `{"kind":"served"|"idle","displayed":boolean,"path":string}`. */
function servedHandOffFile(): string {
  return `${harnessPidFile}.served`;
}

/** A record whose lease went elsewhere (--stop, another daemon) is not handed
 *  on, except for a rebuild lease, which wants the session adopted again. */
function handedOn(record: Slot): boolean {
  return leaseStillOurs(record) || (record.pidPath !== "" && leaseHolder(record.pidPath) === "rebuild");
}

/** `adopting` is a session whose adoption is under way: the current slot's. */
function writeServedHandOff(adopting?: string) {
  const lines = handOff(registry, handedOn, adopting ? { key: adopting, displayed: slot.displayed } : undefined);
  try {
    if (lines.length === 0) {
      fs.rmSync(servedHandOffFile(), { force: true });
      return;
    }
    const tmp = `${servedHandOffFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.join("\n") + "\n");
    fs.renameSync(tmp, servedHandOffFile());
  } catch (err) {
    process.stderr.write(`[wtft-daemon] WARNING: could not hand ${lines.length} session(s) to the next harness: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

let handOffWarned = "";
/** The hand-off as it stands, so a harness killed before its SIGTERM handler
 *  runs still passes on what it served. Rewritten when it differs from the file. */
function persistHandOff() {
  if (!holdsHarnessRoot()) return;
  const text = handOff(registry, handedOn).join("\n");
  // Compared with the file, not with the last write: a displaced harness may
  // have written over it since.
  let onDisk = "";
  try { onDisk = fs.readFileSync(servedHandOffFile(), "utf8").replace(/\n$/, ""); } catch { /* none yet */ }
  if (text === onDisk) return;
  try {
    if (text) {
      const tmp = `${servedHandOffFile()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text + "\n");
      fs.renameSync(tmp, servedHandOffFile());
    } else {
      fs.rmSync(servedHandOffFile(), { force: true });
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (why !== handOffWarned) {
      handOffWarned = why;
      process.stderr.write(`[wtft-daemon] WARNING: could not update the hand-off for the next harness: ${why}\n`);
    }
  }
}

function holdsHarnessRoot(): boolean {
  if (!harnessPidFile) return false;
  try { return fs.readFileSync(harnessPidFile, "utf8").trim() === String(process.pid); } catch { return false; }
}

/** Takes over what the previous harness on this root served. */
function takeServedHandOff() {
  const file = servedHandOffFile();
  const claimed = `${file}.${process.pid}.claimed`;
  try {
    fs.renameSync(file, claimed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(`[wtft-daemon] WARNING: could not take the previous harness's hand-off: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return;
  }
  let text = "";
  try {
    text = fs.readFileSync(claimed, "utf8");
  } catch (err) {
    // Moved aside, not back: the running harness rewrites the hand-off path.
    let left = claimed;
    const aside = `${file}.unreadable-${new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z")}`;
    try { fs.renameSync(claimed, aside); left = aside; } catch { /* stays claimed */ }
    process.stderr.write(`[wtft-daemon] WARNING: could not read the previous harness's hand-off, left at ${left}: ${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }
  try { fs.unlinkSync(claimed); } catch { /* already gone */ }
  const { records, unreadable } = parseHandOff(text, harnessRootKey);
  for (const record of records) {
    const key = record.path;
    // A served session may not be written yet; the harness waits for it as it
    // does for any session it is asked for.
    if (record.kind === "served") wake(key, record.displayed);
    else if (fs.existsSync(key) && !registry.served.has(key)) {
      // Written while no harness ran: no watch event will come for it.
      if (record.sig !== undefined && record.sig !== idleSignature(key)) {
        wake(key, record.displayed);
        continue;
      }
      dropForIdle(key, record.displayed, record.since ?? Date.now());
      watchDir(path.dirname(key), false);
    }
  }
  if (unreadable > 0) {
    process.stderr.write(`[wtft-daemon] WARNING: skipped ${unreadable} hand-off line(s) that were not JSON objects\n`);
  }
}

function stopHarness(reason: string, exitCode = 0) {
  if (!running) return;
  running = false;
  // First, before any flush: --restart kills a harness that is slow to exit.
  // Requests not read yet stay in the request directory for the next harness.
  if (holdsHarnessRoot()) writeServedHandOff();
  if (harnessIdleTimer) clearInterval(harnessIdleTimer);
  harnessIdleTimer = null;
  for (const record of registry.served.values()) if (record.flushTimer) clearTimeout(record.flushTimer);
  for (const [key, slot] of registry.served) {
    if (!leaseStillOurs(slot)) {
      logLeaseLost(key, slot.pidPath);
      continue;
    }
    withSlot(slot, () => {
      flushPending();
      if (fs.existsSync(slot.state.tagPath)) appendTagFile(slot.state.tagPath, stopLine(reason));
    });
    if (slot.pidPath) unlinkIfHolds(slot.pidPath, String(process.pid));
  }
  for (const watcher of harnessWatchers.values()) {
    try { watcher.close(); } catch { /* already closed */ }
  }
  if (harnessPidFile) {
    try {
      if (fs.readFileSync(harnessPidFile, "utf8").trim() === String(process.pid)) {
        // The request directory stays: a request posted while this harness
        // stopped is served by the next one, which serves any request.
        fs.unlinkSync(harnessPidFile);
      }
    } catch { /* already gone */ }
    fs.rmSync(harnessVersionFile(process.pid), { force: true });
  }
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-daemon] harness shutdown: ${reason}\n`);
  }
  process.exit(exitCode);
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
    if (!isDaemonCmdline(args)) continue;
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

async function main() {
  loadUserPricing();

  await loadExternalHarnesses();

  // ---

  let showList = false;
  let showCleanup = false;
  let showRestart = false;
  let stopSession: string | null = null;
  let harnessName = "";
  let sessionArg = "";

  const showHelp = () => console.log(`wtft-daemon — Log parser daemon for WTFT
${USAGE}

Management (any combination runs as one pass over the leases; per holder, --restart
takes precedence over --cleanup, then --stop, then --list, and a holder an earlier one
handled is not listed. A --stop of a session a harness serves ends the command at once):
  --list, -l            List the leases, then every other daemon process found in /proc (none off
                        Linux, so a harness holding no lease is not shown there): RUNNING or DEAD,
                        tagger version, idle age (0s until idle 2m2s; ? when unknown), session.
                        The version is the first tag file found beside the holder's --session, not the
                        running build's. A lease reading rebuild is not listed; a holder with no readable
                        --session shows (hash: <lease hash>). Off Linux (no /proc) every live pid reads RUNNING
  --cleanup             Remove every lease whose holder is dead or not a daemon, uncounted. SIGTERM (no wait)
                        per-session daemons whose session is gone (no file, not moved, and a tag that
                        holds a turn or a _meta record), and fixture ones, whose --session or root environment
                        (WTFT_CLAUDE_PROJECTS_DIR, WTFT_PI_SESSIONS_DIR) is under the tmp dir or /tmp/,
                        that hold no lease here; never a harness daemon, which stops once it has nothing
                        to serve or watch
  --restart             Stop every daemon holding a lease or a root pid file here (SIGTERM, SIGKILL after 2 s),
                        and respawn one per stopped lease holder with its own --session or --harness,
                        claiming its lease when free; a harness holding no lease is stopped (unless a respawn
                        handed its session to it) and starts again on the next wtft. A holder that refuses the stop or
                        outlives SIGKILL, or a respawn that neither runs nor hands off within
                        1 s (one wait for all), makes it exit 1. Linux only (/proc)
  --stop <session>      Drop that session; ~ and relative paths are resolved. A harness serving it (found
                        through the session's lease) keeps running. A per-session process holding a
                        lease here, found by its own --session resolved against its cwd, gets SIGTERM
                        and no wait: one that followed a moved session is found by its old path.
                        Linux only (/proc): off Linux it finds no daemon and exits 0

Daemon mode:
  -s, --session <path>  Path to session.jsonl to watch. Waits up to 1 h for a file not yet written. Exits 0
                        at once when a live daemon holds its lease, unless an older-version tag is
                        beside the session: then it takes the lease over
  --harness <claude|pi> One process for that harness root (WTFT_CLAUDE_PROJECTS_DIR or WTFT_PI_SESSIONS_DIR);
                        claude-code is accepted for claude. It serves the sessions it is asked for
                        (--session, a focus request, a hand-off from the harness before it) and their
                        subagents, and stops when its root or its root pid file is removed or names
                        another pid
  --debug               Enable debug logging to stderr (or set WTFT_DAEMON_DEBUG=1)
  -h, --help            Show this help

Exit codes:
  0  Served until done, a management pass that ran, --session already served, or a --harness start that finds a live
     harness of the same or a newer version and hands it its --session (or has none)
  1  --session missing, or a tag file (without --harness); a harness root missing, its pid file unreadable,
     or neither claimable nor handed a session;
     --stop refused (EPERM) or its harness lease changed or could not be removed;
     --restart left a holder running or a respawn neither ran nor handed off; a tag
     write that failed, or a tag it cannot read or truncate at start; an unhandled error
  2  An unknown argument, a flag with no value, a second --stop, a bad --harness name, or a --session
     outside the harness root

Environment:
  WTFT_DAEMON_IDLE_MS          Milliseconds with no activity (a new turn, a subagent record written,
                               or a poll of a session not yet written) before a session is dropped, after which a
                               harness forgets a dropped session, and with nothing to serve or watch
                               before a harness stops (default 86400000)
  WTFT_DAEMON_STARTUP_GRACE_MS Milliseconds after the daemon starts serving a session (its adoption, in a harness) before that drop can fire (default 60000)
  WTFT_HARNESS_SCAN_SLICE_MS   Milliseconds one slice of a harness's subagent scan runs before it yields (default 25)
  WTFT_HARNESS_SCAN_YIELD_MS   Milliseconds a harness pauses between those slices (default 0)
  A *_MS value that is not all digits is ignored, and the default used.
  WTFT_CLAUDE_PROJECTS_DIR, WTFT_PI_SESSIONS_DIR: the harness roots (see --harness).`);
  const usage = (why: string): never => {
    process.stderr.write(`wtft-daemon: ${why}\n${USAGE}\nRun wtft-daemon --help for more.\n`);
    process.exit(2);
  };
  const valueOf = (flag: string, at: number): string => {
    const value = process.argv[at];
    if (value === undefined || value === "") usage(`${flag} needs a value`);
    return value;
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--session" || arg === "-s") {
      sessionArg = valueOf(arg, ++i);
    } else if (arg === "--harness") {
      harnessName = valueOf(arg, ++i);
      if (harnessName === "claude-code") harnessName = "claude";
    } else if (arg === "--list" || arg === "-l") {
      showList = true;
    } else if (arg === "--cleanup") {
      showCleanup = true;
    } else if (arg === "--restart") {
      showRestart = true;
    } else if (arg === "--stop") {
      if (stopSession !== null) usage("--stop takes one session");
      stopSession = valueOf(arg, ++i);
    } else if (arg === "--help" || arg === "-h") {
      showHelp();
      process.exit(0);
    } else if (arg === "--debug") {
      process.env.WTFT_DAEMON_DEBUG = "1";
    } else {
      usage(`unknown argument: ${arg}`);
    }
  }

// --- Management commands (no session required) ---

function procEnvValue(pid: number, key: string): string | null {
  try {
    const row = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find(item => item.startsWith(`${key}=`));
    return row ? row.slice(key.length + 1) : null;
  } catch {
    return null;
  }
}

if (stopSession) {
  if (stopSession === "~") stopSession = os.homedir();
  else if (stopSession.startsWith("~/")) stopSession = path.join(os.homedir(), stopSession.slice(2));
  stopSession = path.resolve(stopSession);
  const lease = getDaemonPidPath(stopSession);
  const holder = leasePid(leaseHolder(lease));
  if (procIsHarness(holder)) {
    if (!unlinkIfHolds(lease, String(holder))) {
      console.error(`Not stopped: the lease for ${stopSession} changed or could not be removed`);
      process.exit(1);
    }
    console.log(`Stopped: PID ${holder} — session dropped from harness: ${stopSession}`);
    process.exit(0);
  }
}

/** A daemon's --session, resolved against that daemon's working directory. */
function resolvedSessionArg(pid: number, session: string): string {
  let cwd = "/";
  try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* resolve against / */ }
  return path.resolve(cwd, session);
}

if (showList || showCleanup || showRestart || stopSession) {
  const pidDir = os.tmpdir();
  let pidFiles: string[] = [];
  try {
    pidFiles = fs.readdirSync(pidDir).filter(f => f.startsWith("wtft-daemon-") && f.endsWith(".pid"));
  } catch (_) {}
  // Read before anything is stopped: a process that claims a lease or the root
  // after this point started after the command, and is not one it stops.
  const readPid = (file: string): number => {
    try { return leasePid(fs.readFileSync(path.join(pidDir, file), "utf8").trim()); } catch { return NaN; }
  };
  const leaseHolders = new Map(pidFiles.map(f => [f, readPid(f)] as const));
  let harnessPidFiles: string[] = [];
  if (showRestart) {
    try {
      harnessPidFiles = fs.readdirSync(pidDir).filter(f => f.startsWith("wtft-harness-") && f.endsWith(".pid"));
    } catch { /* tmp dir unreadable */ }
  }
  const harnessHolders = new Map(harnessPidFiles.map(f => [f, readPid(f)] as const));

  let restartedN = 0, cleanedN = 0, stoppedN = 0, listedN = 0;
  let stopRefused = false;
  let restartFailed = false;
  const spawnDetached = (args: string[], env: NodeJS.ProcessEnv, cwd: string | undefined): number => {
    const log = daemonStdio();
    try {
      const child = spawn(process.execPath, args, { detached: true, stdio: log.stdio, env, cwd });
      child.unref();
      return child.pid ?? 0;
    } catch {
      return 0;
    } finally {
      log.close();
    }
  };
  const pendingRespawns: { childPid: number; served: () => number; settle: (ok: boolean) => void }[] = [];
  const liveHolderIn = (file: string): number => {
    try {
      const holder = leasePid(fs.readFileSync(file, "utf8").trim());
      return holdsLease(classifyPid(holder)) ? holder : 0;
    } catch { return 0; }
  };
  const handedTo = new Set<number>();
  const liveHarnessFor = (which: string, env: NodeJS.ProcessEnv, cwd: string | undefined): number => {
    const key = which === "claude-code" ? "claude" : which;
    if (key !== "claude" && key !== "pi") return 0;
    return liveHolderIn(harnessPidFileFor(key, path.resolve(cwd ?? process.cwd(), harnessRoot(key, env))));
  };
  const seenPids = new Set<number>();
  const restarted = new Set<number>();
  const keptRunning = new Set<number>();
  const unlinkIfNames = (file: string, pid: number) => { unlinkLeaseIf(file, String(pid)); };
  for (const pidFile of pidFiles) {
    const fullPath = path.join(pidDir, pidFile);
    const pid = leaseHolders.get(pidFile) ?? NaN;
    if (!(pid > 0)) continue;
    seenPids.add(pid);

    const kind = classifyPid(pid);
    const alive = holdsLease(kind);

    let sessionFound = null;
    let harnessFound: string | null = null;
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const args = cmdline.split("\0");
      const sessIdx = args.indexOf("--session");
      if (sessIdx >= 0 && sessIdx + 1 < args.length) {
        sessionFound = args[sessIdx + 1];
      }
      const harnessIdx = args.indexOf("--harness");
      if (harnessIdx >= 0 && harnessIdx + 1 < args.length) harnessFound = args[harnessIdx + 1];
    } catch (_) {}

    let taggerVersion = "?";
    if (sessionFound) {
      try {
        const tagsDir = path.join(path.dirname(resolvedSessionArg(pid, sessionFound)), "wtft-tags");
        const sessBase = path.basename(sessionFound);
        const prefix = sessBase + ".wtft-tag.v";
        for (const f of fs.readdirSync(tagsDir)) {
          if (f.startsWith(prefix)) {
            taggerVersion = f.slice(prefix.length, f.length - 6);
            break;
          }
        }
      } catch (_) {}
    }

    if (showRestart) {
      if (restarted.has(pid)) {
        // A holder that refused the stop or outlived it still serves this lease too.
        if (!keptRunning.has(pid)) unlinkIfNames(fullPath, pid);
        continue;
      }
      restarted.add(pid);
      const restartEnv = { ...process.env };
      let holderCwd: string | undefined;
      try {
        holderCwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (!fs.statSync(holderCwd).isDirectory()) holderCwd = undefined;
      } catch { holderCwd = undefined; }
      const wasDaemon = kind === "daemon" || kind === "harness";
      let stopped: ReturnType<typeof stopHolderSync> | null = null;
      if (wasDaemon) {
        let environReadable = false;
        try { fs.readFileSync(`/proc/${pid}/environ`); environReadable = true; } catch { /* unreadable */ }
        for (const key of ["WTFT_CLAUDE_PROJECTS_DIR", "WTFT_PI_SESSIONS_DIR"]) {
          const value = procEnvValue(pid, key);
          if (value) restartEnv[key] = value;
          else if (environReadable) delete restartEnv[key];
        }
        stopped = stopHolderSync(pid);
      }
      // Only a daemon this process stopped is respawned: a live pid that is not
      // one (or one that cannot be signalled) was not stopped.
      // One that outlived SIGKILL keeps its lease: a respawn would only meet it and exit.
      const survived = stopped === "survived" || stopped === "denied";
      if (stopSession && sessionFound && resolvedSessionArg(pid, sessionFound) === stopSession) {
        stoppedN++;
        if (survived) stopRefused = true;
      }
      if (survived) { keptRunning.add(pid); restartFailed = true; }
      const respawnLease = wasDaemon && sessionFound && !survived ? getDaemonPidPath(sessionFound) : "";
      // The respawn's own lease is left for its claim, which takes a dead holder's.
      if (fullPath !== respawnLease && !survived) unlinkIfNames(fullPath, pid);
      let respawned: "claimed" | "busy" | "failed" = "failed";
      const harnessOnly = wasDaemon && !sessionFound && !survived && harnessFound !== null;
      let harnessBack = false;
      const report = () => console.log(stopped === "denied" ? `Not stopped: PID ${pid} refused the signal (EPERM); its lease is left`
        : survived ? `Not stopped: PID ${pid} is still running after SIGKILL; its lease is left`
        : respawned === "claimed" ? `Restarted: PID ${pid} → fresh daemon for ${sessionFound}`
        : respawned === "busy" ? `Respawned: PID ${pid} → a daemon for ${sessionFound}, left to claim the lease itself`
        : respawnLease ? `Stopped: PID ${pid} — the respawn for ${sessionFound} failed`
        : harnessBack ? `Restarted: PID ${pid} → fresh harness daemon (${harnessFound})`
        : harnessOnly ? `Stopped: PID ${pid} — the respawn of harness daemon (${harnessFound}) failed`
        : wasDaemon ? `Stopped: PID ${pid} — no --session or --harness to respawn`
        : kind === "unverified" ? `Removed lease: PID ${pid} — cannot be verified as a daemon here, so it is left running`
        : `Removed lease: PID ${pid} — no live daemon found`);
      const respawnFailed = (childPid: number) => {
        respawned = "failed";
        unlinkIfNames(fullPath, pid);
        if (childPid) unlinkIfNames(respawnLease, childPid);
        restartFailed = true;
      };
      restartedN++;
      if (respawnLease) {
        const childPid = spawnDetached([process.argv[1], ...daemonLaunchArgs(sessionFound!, restartEnv)], restartEnv, holderCwd);
        if (childPid) {
          try { respawned = claimLeaseForChild(respawnLease, childPid); } catch { respawned = "busy"; }
          pendingRespawns.push({ childPid, served: () => liveHolderIn(respawnLease), settle: ok => { if (!ok) respawnFailed(childPid); report(); } });
          continue;
        }
        respawnFailed(0);
      } else if (harnessOnly) {
        const childPid = spawnDetached([process.argv[1], "--harness", harnessFound!], restartEnv, holderCwd);
        if (childPid) {
          pendingRespawns.push({ childPid, served: () => liveHarnessFor(harnessFound!, restartEnv, holderCwd), settle: ok => { harnessBack = ok; if (!ok) restartFailed = true; report(); } });
          continue;
        }
        restartFailed = true;
      }
      report();
      continue;
    }

    if (showCleanup) {
      if (!alive) {
        unlinkIfNames(fullPath, pid);
        continue;
      }
      if (sessionFound && sessionIsGone(sessionFound)) {
        // A harness's --session is only the one it was started for; it drops
        // a gone session itself.
        if (kind === "harness") continue;
        if (kind === "daemon" && processTable().signal(pid, "SIGTERM") === "denied") {
          console.log(`Not stopped: PID ${pid} refused the signal (EPERM); its lease is left`);
          if (stopSession && resolvedSessionArg(pid, sessionFound) === stopSession) { stopRefused = true; stoppedN++; }
          continue;
        }
        unlinkIfNames(fullPath, pid);
        console.log(`Cleaned up: PID ${pid} — session gone: ${sessionFound}`);
        if (stopSession && resolvedSessionArg(pid, sessionFound) === stopSession) stoppedN++;
        cleanedN++;
        continue;
      }
    }

    if (stopSession && sessionFound && resolvedSessionArg(pid, sessionFound) === stopSession) {
      // A harness's --session is only the one it was started for; a session it
      // serves was handled above, through that session's own lease.
      if (kind === "harness") continue;
      if (kind === "daemon" && processTable().signal(pid, "SIGTERM") === "denied") {
        console.log(`Not stopped: PID ${pid} refused the signal (EPERM); its lease is left`);
        stopRefused = true;
      } else {
        unlinkIfNames(fullPath, pid);
        console.log(kind === "daemon" ? `Stopped: PID ${pid} — ${sessionFound}` : `Removed lease: PID ${pid} — no live daemon found, ${sessionFound}`);
      }
      stoppedN++;
      continue;
    }

    if (showList) {
      listedN++;
      const status = alive ? "RUNNING" : "DEAD (stale pid)";
      let idleStr = "?";
      const now = Date.now();
      const session = sessionFound ? resolvedSessionArg(pid, sessionFound) : null;
      const ownLease = session !== null && sessionFound !== null
        && (getDaemonPidPath(sessionFound) === fullPath || getDaemonPidPath(session) === fullPath);
      // No model read: --list prints no cache TTL, and a transcript can be large.
      const listed = ownLease
        ? decideHealth({ ...readHealthFacts(session, fullPath, getTagPath(session)), sessionModel: () => undefined }, now)
        : null;
      const since = !listed || listed.alive !== alive || listed.reason === "waiting-session" ? undefined
        : listed.idle ? listed.idleSinceMs : listed.alive ? now : listed.lastHbMs;
      if (since !== undefined) {
        const idleSec = Math.floor((now - since) / 1000);
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
      // A harness stops itself once it serves nothing.
      if (showCleanup && fixture && !proc.harness) {
        const where = proc.session || proc.roots.join(",");
        if (processTable().signal(proc.pid, "SIGTERM") === "denied") {
          console.log(`Not stopped: PID ${proc.pid} refused the signal (EPERM) — fixture daemon: ${where}`);
          continue;
        }
        console.log(`Cleaned up: PID ${proc.pid} — fixture daemon: ${where}`);
        cleanedN++;
        continue;
      }
      // --restart takes precedence: a harness it is about to stop is not listed.
      if (showList && !(showRestart && proc.harness && [...harnessHolders.values()].includes(proc.pid))) {
        listedN++;
        const where = proc.session || (proc.harness ? `harness ${proc.roots.join(",") || "(unknown root)"}` : "(no session arg)");
        console.log(`PID ${String(proc.pid).padEnd(7)} ${"RUNNING".padEnd(20)} v${"?".padEnd(7)} idle: ${"?".padEnd(5)} ${where}`);
      }
    }
  }

  if (showRestart) {
    if (pendingRespawns.length > 0) sleepMs(RESPAWN_SETTLE_MS);
    for (const r of pendingRespawns) {
      const servedBy = r.served();
      if (servedBy > 0 && servedBy !== r.childPid) handedTo.add(servedBy);
      r.settle(pidAlive(r.childPid) || servedBy > 0);
    }
    for (const pidFile of harnessPidFiles) {
      const fullPath = path.join(pidDir, pidFile);
      const pid = harnessHolders.get(pidFile) ?? NaN;
      if (Number.isNaN(pid)) continue;
      if (pid <= 0 || seenPids.has(pid) || pid === process.pid) {
        // A harness left running above still serves its root.
        if (!keptRunning.has(pid)) unlinkIfNames(fullPath, pid);
        continue;
      }
      seenPids.add(pid);
      if (handedTo.has(pid)) {
        console.log(`Left running: PID ${pid} — harness ${pidFile}; a respawn handed its session to it`);
        restartedN++;
        continue;
      }
      const live = procIsDaemon(pid);
      // It writes its hand-off only while its pid file still names it.
      const outcome = live ? stopHolderSync(pid) : null;
      if (outcome === "denied" || outcome === "survived") {
        restartFailed = true;
        console.log(outcome === "denied" ? `Not stopped: PID ${pid} refused the signal (EPERM); harness ${pidFile} keeps its root pid file`
          : `Not stopped: PID ${pid} is still running after SIGKILL; harness ${pidFile} keeps its root pid file`);
        restartedN++;
        continue;
      }
      unlinkIfNames(fullPath, pid);
      console.log(live ? `Stopped: PID ${pid} — harness ${pidFile}; the next wtft starts it again`
        : classifyPid(pid) === "unverified" ? `Removed root pid file: PID ${pid} — cannot be verified as a daemon here, so it is left running, harness ${pidFile}`
        : `Removed root pid file: PID ${pid} — no live daemon found, harness ${pidFile}`);
      restartedN++;
    }
    console.log(`${restartedN} holder(s) handled: restarted, stopped, left in place, or a lease or root pid file removed, as each line says.`);
  }
  if (showCleanup) {
    console.log(`Cleaned up ${cleanedN} daemon(s).`);
  }
  if (showList && listedN === 0) {
    console.log("No daemon processes found.");
  }
  if (stopSession && stoppedN === 0) {
    console.log(`No daemon found for: ${stopSession}`);
  }
  process.exit(stopRefused || restartFailed ? 1 : 0);
}

// --- Daemon mode (session required) ---

  if (harnessName) {
    runHarness(harnessName, sessionArg);
    return;
  }

  if (!sessionArg) {
    process.stderr.write("wtft-daemon: --session <path> is required\n");
    process.exit(1);
  }
  // Session file may not exist yet; wait in the poll loop with heartbeats.
  if (sessionArg.includes(".wtft-tag.v")) {
    process.stderr.write(`wtft-daemon: refusing to watch a tag file as a session: ${sessionArg}\n`);
    process.exit(1);
  }

  slot = newSessionRecord(sessionArg, true, Date.now());
  slot.sessionExisted = fs.existsSync(sessionArg);
  const sessionPath = sessionArg;
  const sessionBase = path.basename(sessionPath);
  // Prefer an existing current-version tag wherever it lives (session may have moved).
  const tagPath = getCurrentVersionTagPath(sessionPath);
  slot.state.tagPath = tagPath;
  const tagsDir = path.dirname(tagPath);
  try { fs.mkdirSync(tagsDir, { recursive: true }); } catch (_) {}

  // PID lease keyed on transcript basename so a worktree move does not spawn a second daemon.
  const sessionHash = createHash("sha256").update(
    isSessionIdBasename(sessionPath) ? sessionBase : sessionPath
  ).digest("hex").slice(0, 12);
  const pidPath = path.join(os.tmpdir(), `wtft-daemon-${sessionHash}.pid`);
  slot.pidPath = pidPath;

  // Old-version tag: claim the lease; old daemon exits on lost lease (no SIGTERM race).
  const prefix = sessionBase + ".wtft-tag.v";
  const otherTagVersions = (): { older: string[]; newer: string[] } => {
    const older: string[] = [];
    const newer: string[] = [];
    for (const f of fs.readdirSync(tagsDir)) {
      if (!f.startsWith(prefix) || !f.endsWith(".jsonl") || f === sessionBase + TAG_SUFFIX) continue;
      const version = f.slice(prefix.length, -".jsonl".length);
      if (taggerIsOlder(version, TAGGER_VERSION)) older.push(f);
      else if (taggerIsOlder(TAGGER_VERSION, version)) newer.push(f);
    }
    return { older, newer };
  };
  // A lease that exists but cannot be read is a fault, never a holder: fail loudly.
  try { fs.readFileSync(pidPath, "utf8"); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  let claimedByTakeover = false;
  try {
    const { older, newer } = otherTagVersions();
    // A newer build serving this session keeps it.
    const holderPid = leasePid(leaseHolder(pidPath));
    if (newer.length > 0 && holderPid !== process.pid && holdsLease(classifyPid(holderPid))) process.exit(0);
    if (older.length > 0) {
      // Honor an existing rebuild lease before version-takeover claim: replace
      // only the value read, and on a miss read once more so a token written
      // meanwhile is honoured, not consumed.
      let holder = leaseHolder(pidPath);
      if (!publishLease(pidPath, String(process.pid), String(process.pid), holder)) {
        holder = leaseHolder(pidPath);
        replaceLease(String(process.pid));
      }
      if (holder === "rebuild") slot.rebuildTagOnStartup = true;
      claimedByTakeover = true;
    }
  } catch (e) {
    process.stderr.write(`[wtft-daemon] version takeover failed (reading the tags dir, or taking the lease from an older build): ${e instanceof Error ? e.message : String(e)}\n`);
  }


  if (!claimedByTakeover) {
    let displaced = "";
    const holderIsLive = (holder: string): boolean => {
      const live = holdsLease(classifyPid(leasePid(holder)));
      if (!live) displaced = holder;
      return live;
    };
    if (claimLease(pidPath, String(process.pid), holderIsLive) === "busy") process.exit(0);
    // Only the explicit rebuild token requests replay; a stale numeric PID does not.
    if (displaced === "rebuild") slot.rebuildTagOnStartup = true;
  }

  // Drop older-version tag files after claiming the lease; re-sweep once after 5s for a late heartbeat.
  const sweepOldTagFiles = () => {
    try {
      for (const f of otherTagVersions().older) {
        try { fs.unlinkSync(path.join(tagsDir, f)); } catch (_) {}
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-daemon] removed stale tag file: ${f}\n`);
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
    process.stderr.write(`[wtft-daemon] started, watching: ${sessionPath}\n`);
    process.stderr.write(`[wtft-daemon] classified: ${tagPath}\n`);
    process.stderr.write(`[wtft-daemon] pid: ${process.pid}\n`);
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

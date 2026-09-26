#!/usr/bin/env -S node --experimental-strip-types


import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { projectsDir } from "../extensions/lib/harness/claude-code/discovery.js";
import { tagRecords, parseTagLine, lastOffset, isDataRecord } from "../extensions/lib/tag-log.js";
import { claimLease, unlinkLeaseIf, replaceLease as publishLease, leaseHolder } from "../extensions/lib/lease.js";
import { newTaggerState, readSession, flushTurns, scanChildren, resumeTagger, fsWorld, MTIME_SETTLE_MS, type TaggerState, type LogLine } from "../extensions/lib/session-tagger.js";
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
} from "../extensions/lib/wtft-shared.js";


// ---

const TAG_SUFFIX = `.wtft-tag.v${TAGGER_VERSION}.jsonl`;
const USAGE = `Usage: wtft-daemon --session <path> [--debug]
       wtft-daemon --harness <claude|pi> [--session <path>] [--debug]
       wtft-daemon --list | --cleanup | --restart | --stop <session>`;
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
    process.stderr.write(`[wtft-log-parser] shutdown: ${reason}\n`);
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

/** Stop after an append whose on-disk extent is unknowable; publish a rebuild lease for the next owner. */
function fatalTagMutation(filePath: string, operation: "append" | "rebuild truncate" | "partial-tail truncate", err: unknown): never {
  if (running && harnessMode && holdsHarnessRoot()) writeServedHandOff(path.resolve(slot.state.sessionPath));
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
    process.stderr.write(`[wtft-log-parser] session flush ${Date.now()} ${path.basename(slot.state.sessionPath)}\n`);
  }
  slot.idleStartMs = 0;
  slot.lastWriteMs = Date.now();
}

/** Harness sessions whose subagent scan ran out of its slice and continues on
 *  the next turn of the event loop. */
const subagentScansContinuing = new Set<string>();

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
  const key = path.resolve(slot.state.sessionPath);
  if (subagentScansContinuing.has(key)) return;
  subagentScansContinuing.add(key);
  const owner = harnessSlots.get(key);
  const next = () => {
    // The slot may have moved to a new path since the cut; a move re-keys the marker.
    const current = owner ? path.resolve(owner.state.sessionPath) : key;
    const held = harnessSlots.get(current) === owner ? owner : undefined;
    if (!held || !running) return;
    subagentScansContinuing.delete(current);
    if (!leaseStillOurs(held)) {
      leaseLost(current, held);
      return;
    }
    withSlot(held, () => scanForSubAgents());
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
    return lastOffset(tagRecords(buf.toString("utf8")));
  } catch { /* tag file unreadable */ }
  return null;
}

// ---

/** Session move: re-point sessionPath only; keep tagPath fixed so --watch survives. */
function followMovedSession(): boolean {
  const moved = resolveMovedSession(slot.state.sessionPath);
  if (!moved) return false;
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] session moved: ${slot.state.sessionPath} -> ${moved}\n`);
  }
  if (subagentScansContinuing.delete(path.resolve(slot.state.sessionPath))) subagentScansContinuing.add(path.resolve(moved));
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

function cmdlineHasHarness(pid: number): boolean {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes("--harness"); } catch { return false; }
}

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
      pid = parseInt(fs.readFileSync(fullPath, "utf8").trim(), 10);
    } catch (_) { continue; }
    if (!(pid > 0)) continue;
    const leases = leasesOf.get(pid);
    if (leases) leases.push(lease);
    else leasesOf.set(pid, [lease]);
  }
  const sessionOf = new Map<number, string | null>();
  const unlinkIfStill = (lease: Lease, pid: number) => { unlinkLeaseIf(lease.path, String(pid), lease); };

  for (const [pid, leases] of leasesOf) {
    // Only ESRCH means gone: EPERM is a live process this user cannot signal,
    // and its leases stay.
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

    // HARD: session gone (not moved, not never-written). Never our own PID, and
    // never a harness: its --session is only the one it was started for.
    const harness = cmdlineHasHarness(pid);
    if (pid !== process.pid && !harness && sessionFound && procIsDaemon(pid) && sessionIsGone(sessionFound)) {
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
    process.stderr.write(`[wtft-log-parser] ${tagPath} ended mid-line — a previous daemon was killed inside an append; rebuilding this tag from the transcript (#130)\n`);
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
    try {
      fs.accessSync(tagPath);
      const tagContent = fs.readFileSync(tagPath, "utf8");
      const hasData = tagRecords(tagContent).some(r => isDataRecord(r) || r.kind === "unknown");
      if (hasData) {
        const metaOffset = readLastMetaOffset(tagPath);
        if (metaOffset !== null) {
          slot.state.lastSize = metaOffset;
          // Written by an earlier life; what changed since is not read yet.
          const resumed = resumeTagger(slot.state, tagContent, world);
          printLog(resumed.log);
          if (resumed.records) appendTagFile(tagPath, resumed.records);
        } else {
          try { fs.truncateSync(tagPath, 0); } catch { /* best effort */ }
          slot.state.lastSize = 0;
        }
      } else {
        try { fs.truncateSync(tagPath, 0); } catch { /* best effort */ }
        slot.state.lastSize = 0;
      }
    } catch (_) {
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
        process.stderr.write(`[wtft-log-parser] no new data for ${Math.round((now - slot.lastActivityMs) / 60000)}m, exiting\n`);
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
      process.stderr.write(`[wtft-log-parser] poll error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  return "continue";
}

const HARNESS_SKIP_DIRS = new Set(["subagents", "tool-results", "memory", "wtft-tags"]);

interface Slot {
  /** Everything the tagger decides from: docs/spec-270-session-tagger.md. */
  state: TaggerState;
  pidPath: string;
  rebuildTagOnStartup: boolean;
  lastWriteMs: number;
  lastActivityMs: number;
  startupTime: number;
  idleStartMs: number;
  sessionExisted: boolean;
  displayed: boolean;
  /** When the sweep last checked this transcript on disk. */
  checkedAtMs: number;
}

const harnessSlots = new Map<string, Slot>();
const harnessWatchers = new Map<string, fs.FSWatcher>();
const harnessFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
let harnessPidFile = "";
let harnessIdleTimer: ReturnType<typeof setInterval> | null = null;

function freshSlot(file: string, displayed: boolean): Slot {
  const now = Date.now();
  return {
    state: newTaggerState(file, ""),
    pidPath: "",
    rebuildTagOnStartup: false,
    lastWriteMs: 0,
    lastActivityMs: now,
    startupTime: now,
    idleStartMs: 0,
    sessionExisted: false,
    displayed,
    checkedAtMs: now,
  };
}

/** The session being served right now: the one slot in per-session mode, or
 *  whichever `withSlot` made current. */
let slot: Slot = freshSlot("", true);

function withSlot<T>(next: Slot, fn: () => T): T {
  const prev = slot;
  slot = next;
  try {
    return fn();
  } finally {
    slot = prev;
  }
}

/** Off Linux a cmdline cannot be read, so any live pid counts. */
function liveDaemonOrUnknown(pid: number): boolean {
  if (fs.existsSync("/proc/self/cmdline")) return procIsDaemon(pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
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

/** A holder that is a live daemon process keeps its lease; `rebuild`, a
 *  dead pid, or a live process that is not a daemon does not. */
function holderIsLiveDaemon(holder: string): boolean {
  const pid = Number(holder);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  return procIsDaemon(pid);
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
    let holder = 0;
    try { holder = Number(fs.readFileSync(pidPath, "utf8").trim()); } catch { holder = 0; }
    if (holder === process.pid) return true;
    if (holder > 0 && procIsDaemon(holder)) {
      // A harness serves other sessions too; one that is stopping lets go itself.
      if (cmdlineHasHarness(holder)) return false;
      try { process.kill(holder, "SIGTERM"); } catch { /* already gone */ }
    }
    sleepMs(50);
  }
  return claimPidFile(pidPath) === "claimed";
}

function scheduleFlush(key: string) {
  if (harnessFlushTimers.has(key)) return;
  const slot = harnessSlots.get(key);
  if (!slot || slot.state.pendingItems.length === 0) return;
  const wait = Math.max(0, POLL_MS - (Date.now() - slot.lastWriteMs));
  const timer = setTimeout(() => {
    harnessFlushTimers.delete(key);
    const current = harnessSlots.get(key);
    if (!current) return;
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
  harnessFlushTimers.set(key, timer);
}

function wake(file: string, displayed: boolean) {
  const key = path.resolve(file);
  let slot = harnessSlots.get(key);
  // A `rebuild` lease (wtft -F) is adopted afresh, which honours it. Any other
  // lease that is not ours drops the session in serviceSession, as --stop means.
  if (slot && slot.pidPath && leaseHolder(slot.pidPath) === "rebuild") {
    displayed = displayed || slot.displayed;
    dropHarnessSlot(key);
    slot = undefined;
  }
  if (!slot) {
    slot = freshSlot(key, displayed);
    if (!withSlot(slot, () => adoptSession())) {
      retryAdoptionLater(key, displayed);
      return;
    }
    harnessSlots.set(key, slot);
    adoptionRetries.delete(key);
    idleDropped.delete(key);
    idleDroppedSize.delete(key);
    idleDroppedAt.delete(key);
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
    const other = harnessSlots.get(movedTo);
    if (other && other !== slot) dropHarnessSlot(movedTo);
    harnessSlots.delete(key);
    harnessSlots.set(movedTo, slot);
    // A scan cut before the move carries on under the new path.
    if (subagentScansContinuing.delete(key)) subagentScansContinuing.add(movedTo);
    unwatchSession(key);
    watchSession(movedTo);
    const timer = harnessFlushTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      harnessFlushTimers.delete(key);
    }
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
    for (const [file, slot] of harnessSlots) {
      if (path.dirname(file) === key || file.slice(0, -".jsonl".length) === key || key.startsWith(file.slice(0, -".jsonl".length) + path.sep)) {
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

/** Whether a served or idle-dropped session still needs `dir` watched. */
function dirStillNeeded(dir: string): boolean {
  for (const file of harnessSlots.keys()) {
    const own = sessionDirOf(file);
    if (path.dirname(file) === dir || dir === own || dir.startsWith(own + path.sep)) return true;
  }
  for (const file of idleDropped.keys()) if (path.dirname(file) === dir) return true;
  return false;
}

function sessionDirOf(file: string): string {
  return file.slice(0, -".jsonl".length);
}

function watchSession(file: string) {
  watchDir(path.dirname(file), false);
  if (fs.existsSync(sessionDirOf(file))) watchDir(sessionDirOf(file), true);
}

/** Sessions dropped for idling: their project directory stays watched, and
 *  their next write adopts them again. */
const idleDropped = new Map<string, boolean>();
/** Each idle-dropped transcript's size, inode and mtime when dropped, for the sweep to notice
 *  a write where the directory cannot be watched. */
const idleDroppedSize = new Map<string, string>();
/** When each was dropped. One not written for WTFT_DAEMON_IDLE_MS after that
 *  is forgotten, so a harness serving nothing can stop with nothing to hand on. */
const idleDroppedAt = new Map<string, number>();
/** Size, inode and mtime: a same-length rewrite or a replacement is a write too. */
function idleSignature(key: string): string {
  try {
    const st = fs.statSync(key);
    return `${st.size}:${st.ino}:${st.mtimeMs}`;
  } catch { return ""; }
}

function dropForIdle(key: string, displayed: boolean, since = idleDroppedAt.get(key) ?? Date.now()) {
  idleDropped.set(key, displayed);
  idleDroppedAt.set(key, since);
  idleDroppedSize.set(key, idleSignature(key));
}

/** Set by serviceSession when it drops a harness session for idling. */
let droppedForIdle = false;
let idleDroppedPrunedAt = 0;

/** Closes what only `file` needed: its session directory tree, and its
 *  project directory once no served session is left in it. */
function unwatchSession(file: string) {
  const own = sessionDirOf(file);
  const project = path.dirname(file);
  const projectInUse = [...harnessSlots.keys()].some(k => k !== file && path.dirname(k) === project)
    || [...idleDropped.keys()].some(k => path.dirname(k) === project);
  for (const [dir, watcher] of harnessWatchers) {
    const mine = dir === own || dir.startsWith(own + path.sep);
    if (!mine && !(dir === project && !projectInUse)) continue;
    try { watcher.close(); } catch { /* already closed */ }
    harnessWatchers.delete(dir);
  }
}

/** A served session whose directory tree holds `dir`, if any. */
function servedSessionOver(dir: string): string | null {
  for (const file of harnessSlots.keys()) {
    const own = sessionDirOf(file);
    if (dir === own || dir.startsWith(own + path.sep)) return file;
  }
  return null;
}

/** A session that could not be adopted is tried again every POLL_MS, up to
 *  five times. One retry is pending per session at a time. */
const adoptionRetries = new Map<string, { tries: number; displayed: boolean }>();
const adoptionRetryPending = new Set<string>();
function retryAdoptionLater(key: string, displayed: boolean) {
  if (!running) return;
  if (adoptionRetryPending.has(key)) return;
  const tries = (adoptionRetries.get(key)?.tries ?? 0) + 1;
  if (tries > 5) {
    adoptionRetries.delete(key);
    const lease = getDaemonPidPath(key);
    const holder = leaseHolder(lease);
    const why = key.includes(".wtft-tag.v") ? "it is a tag file"
      : holder && holder !== String(process.pid) ? `its lease names ${holder}`
      : "its lease could not be claimed";
    process.stderr.write(`[wtft-log-parser] could not adopt ${key}: ${why}\n`);
    // Not tried again until it is written again.
    if (idleDropped.has(key)) dropForIdle(key, idleDropped.get(key)!);
    // A reader must not be told the session is served.
    unlinkIfHolds(lease, String(process.pid));
    if (!fs.existsSync(lease)) {
      try { fs.unlinkSync(`${lease}.display`); } catch { /* already gone */ }
    }
    return;
  }
  adoptionRetries.set(key, { tries, displayed });
  adoptionRetryPending.add(key);
  const timer = setTimeout(() => {
    adoptionRetryPending.delete(key);
    // Cancelled by an adoption or a drop since.
    if (!adoptionRetries.has(key)) return;
    if (running && !harnessSlots.has(key)) wake(key, displayed);
    if (harnessSlots.has(key)) adoptionRetries.delete(key);
  }, POLL_MS);
  timer.unref();
}

function sleepMs(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function unlinkIfHolds(file: string, value: string): boolean {
  return unlinkLeaseIf(file, value);
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
  let st: fs.Stats | null = null;
  try {
    // Not followed: a symlinked directory would pull its whole target in.
    st = fs.lstatSync(full);
  } catch {
    st = null;
  }
  const over = servedSessionOver(full);
  if (st?.isDirectory()) {
    // A session directory or a subagents directory appearing under a served
    // session; any other directory is not being served.
    if (over || harnessSlots.has(`${full}.jsonl`)) watchDir(full, true);
    const parent = over ?? (harnessSlots.has(`${full}.jsonl`) ? `${full}.jsonl` : null);
    if (parent) wake(parent, harnessSlots.get(parent)?.displayed ?? true);
    return;
  }
  if (over) {
    wake(over, harnessSlots.get(over)?.displayed ?? true);
    return;
  }
  if (st && filename.endsWith(".jsonl") && !filename.includes(".wtft-tag.")) {
    const slot = harnessSlots.get(full);
    if (slot) {
      wake(full, slot.displayed);
      return;
    }
    const displayed = idleDropped.get(full);
    if (displayed !== undefined) {
      wake(full, displayed);
      return;
    }
    // A Pi child session is a sibling file naming its parent inside it, so a
    // new or growing sibling may belong to a served session in this directory.
    if (harnessWhich === "pi") {
      for (const [file, other] of harnessSlots) if (path.dirname(file) === dir) wake(file, other.displayed);
    }
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
  const holder = Number(leaseText);
  held = holder === livePid;
  // A rebuild token stays for the harness to read when it adopts, and a lease
  // another live daemon holds is left for the harness's adoption to take by
  // its own rules (never from a harness; a per-session daemon is stopped first).
  if (leaseText !== "rebuild" && (held || !procIsDaemon(holder))) {
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

function harnessVersionFile(pid: number): string {
  return `${harnessPidFile}.${pid}.version`;
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
  // Written before the claim, so a harness that holds the pid file always has
  // one; keyed by pid, so one left by a killed harness names nobody live.
  fs.writeFileSync(harnessVersionFile(process.pid), TAGGER_VERSION);
  const leave = (code: number): never => {
    try { fs.unlinkSync(harnessVersionFile(process.pid)); } catch { /* already gone */ }
    process.exit(code);
  };
  for (let attempt = 1; claimPidFile(harnessPidFile) === "busy"; attempt++) {
    if (attempt > 5) {
      process.stderr.write(`wtft-daemon: could not claim ${harnessPidFile} or hand ${focus || "a session"} to the harness holding it\n`);
      leave(1);
    }
    let live = 0;
    try { live = Number(fs.readFileSync(harnessPidFile, "utf8").trim()); } catch { continue; }
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
    try { process.kill(live, "SIGTERM"); } catch { /* already gone */ }
    waitUntilExited(live);
  }
  harnessMode = true;
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] harness pid ${harnessPidFile}\n`);
    process.stderr.write(`[wtft-log-parser] harness root ${root}\n`);
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
    process.stderr.write(`[wtft-log-parser] harness settled ${which}\n`);
  }
}

/** `reason`, when given, is written as the session's stop line. */
function dropHarnessSlot(key: string, reason = "") {
  const slot = harnessSlots.get(key);
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
  const timer = harnessFlushTimers.get(key);
  if (timer) clearTimeout(timer);
  harnessFlushTimers.delete(key);
  harnessSlots.delete(key);
  subagentScansContinuing.delete(key);
  adoptionRetries.delete(key);
  unwatchedTreeScanAt.delete(key);
  unwatchSession(key);
  if (slot) releaseLease(slot);
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] session drop ${path.basename(key)}\n`);
  }
}

/** A lease that still names this process, and that no other slot shares, is
 *  removed; one another process has taken since it was read is left alone. */
function releaseLease(slot: Slot) {
  if (!slot.pidPath) return;
  for (const other of harnessSlots.values()) if (other !== slot && other.pidPath === slot.pidPath) return;
  if (!unlinkLeaseIf(slot.pidPath, String(process.pid))) return;
  try { fs.rmSync(`${slot.pidPath}.display`, { force: true }); } catch { /* already gone */ }
}

/** When each served session last had its subagents read because a directory
 *  of its tree cannot be watched. */
const unwatchedTreeScanAt = new Map<string, number>();

function slotNeedsChildScan(slot: Slot, now: number): boolean {
  if (slot.state.pendingClaudeCommands.length > 0) return true;
  // No watch event will come for a subagent written there, so it is polled.
  const tree = slot.state.sessionPath.replace(/\.jsonl$/, "");
  const key = path.resolve(slot.state.sessionPath);
  if (now - (unwatchedTreeScanAt.get(key) ?? 0) >= POLL_MS
    && [...unwatchedDirs.keys()].some(dir => dir === tree || dir.startsWith(tree + path.sep) || tree.startsWith(dir + path.sep))) {
    unwatchedTreeScanAt.set(key, now);
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
  process.stderr.write(`[wtft-log-parser] gave up ${session}: its lease now reads ${JSON.stringify(leaseHolder(lease))}\n`);
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
        process.stderr.write(`[wtft-log-parser] FATAL: the harness cannot read its pid file ${harnessPidFile}: ${why}\n`);
        stopHarness(`cannot read its pid file: ${why}`, 1);
        return;
      }
    }
    if (holder !== String(process.pid)) {
      stopHarness(holder ? `harness pid file names ${holder}` : "harness pid file removed");
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
      process.stderr.write(`[wtft-log-parser] WARNING: the harness root ${harnessRootKey} could not be stat'd: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  takeFocusRequests();
  const now = Date.now();
  const pruneGone = now - idleDroppedPrunedAt >= 60_000;
  if (pruneGone) idleDroppedPrunedAt = now;
  for (const key of [...idleDropped.keys()]) {
    const aged = now - (idleDroppedAt.get(key) ?? now) >= IDLE_EXIT_MS;
    if (!aged && !(pruneGone && !fs.existsSync(key))) continue;
    idleDropped.delete(key);
    idleDroppedSize.delete(key);
    idleDroppedAt.delete(key);
    unwatchSession(key);
  }
  for (const key of [...harnessSlots.keys()]) {
    const slot = harnessSlots.get(key);
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
        if (harnessSlots.get(key) !== slot) continue;
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
    const current = harnessSlots.get(key);
    if (!current) continue;
    if (current.state.pendingItems.length > 0) continue;
    if (now - current.startupTime < STARTUP_GRACE_MS) continue;
    if (now - current.lastActivityMs < IDLE_EXIT_MS) continue;
    dropForIdle(key, current.displayed);
    dropHarnessSlot(key, "idle timeout");
  }
  for (const [key, displayed] of [...idleDropped]) {
    if (!unwatchedDirs.has(path.dirname(key)) || adoptionRetryPending.has(key)) continue;
    const signature = idleSignature(key);
    if (signature !== "" && signature !== idleDroppedSize.get(key)) wake(key, displayed);
  }
  for (const [dir, failed] of unwatchedDirs) {
    if (now - failed.triedAt < WATCH_RETRY_MS) continue;
    if (!dirStillNeeded(dir)) unwatchedDirs.delete(dir);
    else watchDir(dir, failed.recurse);
  }
  if (!focusWatcher) watchFocusRequests();
  if (harnessSlots.size > 0 || adoptionRetryPending.size > 0 || idleDropped.size > 0) emptySinceMs = 0;
  else if (emptySinceMs === 0) emptySinceMs = now;
  else if (now - emptySinceMs >= IDLE_EXIT_MS) {
    // A request posted since this sweep read them would otherwise be left
    // with a lease pointing at a harness that is gone.
    takeFocusRequests();
    if (harnessSlots.size === 0 && adoptionRetryPending.size === 0 && idleDropped.size === 0) {
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

function handOffLines(adopting?: string): string[] {
  const lines: string[] = [];
  const entry = (kind: string, displayed: boolean, key: string, idle?: { since?: number; sig?: string }) => JSON.stringify({ kind, displayed, path: key, ...(idle ?? {}) });
  // A slot whose lease went elsewhere (--stop, another daemon) is not handed
  // on, except for a rebuild lease, which wants the session adopted again.
  for (const [key, slot] of harnessSlots) {
    if (leaseStillOurs(slot) || (slot.pidPath && leaseHolder(slot.pidPath) === "rebuild")) lines.push(entry("served", slot.displayed, key));
  }
  // A session whose adoption failed is not in harnessSlots yet.
  if (adopting && !harnessSlots.has(adopting)) lines.push(entry("served", slot.displayed, adopting));
  // Asked for, but waiting on an adoption retry.
  for (const [key, retry] of adoptionRetries) {
    if (!harnessSlots.has(key) && key !== adopting) lines.push(entry("served", retry.displayed, key));
  }
  for (const [key, displayed] of idleDropped) lines.push(entry("idle", displayed, key, { since: idleDroppedAt.get(key), sig: idleDroppedSize.get(key) }));
  return lines;
}

function writeServedHandOff(adopting?: string) {
  const lines = handOffLines(adopting);
  try {
    if (lines.length === 0) {
      fs.rmSync(servedHandOffFile(), { force: true });
      return;
    }
    const tmp = `${servedHandOffFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.join("\n") + "\n");
    fs.renameSync(tmp, servedHandOffFile());
  } catch (err) {
    process.stderr.write(`[wtft-log-parser] WARNING: could not hand ${lines.length} session(s) to the next harness: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

let handOffWarned = "";
/** The hand-off as it stands, so a harness killed before its SIGTERM handler
 *  runs still passes on what it served. Rewritten when it differs from the file. */
function persistHandOff() {
  if (!holdsHarnessRoot()) return;
  const text = handOffLines().join("\n");
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
      process.stderr.write(`[wtft-log-parser] WARNING: could not update the hand-off for the next harness: ${why}\n`);
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
      process.stderr.write(`[wtft-log-parser] WARNING: could not take the previous harness's hand-off: ${err instanceof Error ? err.message : String(err)}\n`);
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
    process.stderr.write(`[wtft-log-parser] WARNING: could not read the previous harness's hand-off, left at ${left}: ${err instanceof Error ? err.message : String(err)}\n`);
    return;
  }
  try { fs.unlinkSync(claimed); } catch { /* already gone */ }
  let unreadable = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: { kind?: unknown; displayed?: unknown; path?: unknown; since?: unknown; sig?: unknown } = {};
    try { record = JSON.parse(line); } catch { unreadable++; continue; }
    const kind = record.kind;
    const displayed = record.displayed === true ? "1" : "0";
    const key = typeof record.path === "string" ? record.path : "";
    if (!key || !path.isAbsolute(key)) continue;
    if (!key.startsWith(harnessRootKey + path.sep)) continue;
    // A served session may not be written yet; the harness waits for it as it
    // does for any session it is asked for.
    if (kind === "served") wake(key, displayed === "1");
    else if (kind === "idle" && fs.existsSync(key) && !harnessSlots.has(key)) {
      // Written while no harness ran: no watch event will come for it.
      if (typeof record.sig === "string" && record.sig !== idleSignature(key)) {
        wake(key, displayed === "1");
        continue;
      }
      dropForIdle(key, displayed === "1", typeof record.since === "number" ? record.since : Date.now());
      watchDir(path.dirname(key), false);
    }
  }
  if (unreadable > 0) {
    process.stderr.write(`[wtft-log-parser] WARNING: skipped ${unreadable} hand-off line(s) that did not parse\n`);
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
  for (const timer of harnessFlushTimers.values()) clearTimeout(timer);
  for (const [key, slot] of harnessSlots) {
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
    process.stderr.write(`[wtft-log-parser] harness shutdown: ${reason}\n`);
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

function waitUntilExited(pid: number) {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    try { process.kill(pid, 0); } catch { return; }
    sleepMs(20);
  }
  try { process.kill(pid, "SIGKILL"); } catch { return; }
  const killed = Date.now() + 2000;
  while (Date.now() < killed && procIsDaemon(pid)) sleepMs(20);
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

Management:
  --list, -l            List every running wtft-daemon, including fixture processes
  --cleanup             Kill per-session daemons whose session is gone, and fixture ones under the tmp dir
                        that hold no lease here; never a harness process, which stops once it has nothing to serve or watch
  --restart             Kill all running daemons (fresh spawn on next wtft)
  --stop <session>      Drop that session. A per-session process exits. A harness process stays up.

Daemon mode:
  -s, --session <path>  Path to session.jsonl to watch
  --harness <claude|pi> One process for that harness root (WTFT_CLAUDE_PROJECTS_DIR or WTFT_PI_SESSIONS_DIR);
                        claude-code is accepted for claude
  --debug               Enable debug logging to stderr
  -h, --help            Show this help

Environment:
  WTFT_DAEMON_IDLE_MS          Milliseconds with no new lines before a session is dropped, after which a
                               harness forgets a dropped session, and with nothing to serve or watch
                               before a harness stops (default 86400000)
  WTFT_DAEMON_STARTUP_GRACE_MS Milliseconds after start before that drop can fire (default 60000)
  WTFT_HARNESS_SCAN_SLICE_MS   Milliseconds one slice of a harness's subagent scan runs before it yields (default 25)
  WTFT_HARNESS_SCAN_YIELD_MS   Milliseconds a harness pauses between those slices (default 0)`);
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
  if (stopSession === "~") stopSession = os.homedir();
  else if (stopSession.startsWith("~/")) stopSession = path.join(os.homedir(), stopSession.slice(2));
  stopSession = path.resolve(stopSession);
  const lease = getDaemonPidPath(stopSession);
  let holder = 0;
  try { holder = Number(fs.readFileSync(lease, "utf8").trim()); } catch { holder = 0; }
  if (holder > 0 && procIsDaemon(holder) && procIsHarness(holder)) {
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
    try { return parseInt(fs.readFileSync(path.join(pidDir, file), "utf8").trim(), 10); } catch { return NaN; }
  };
  const leaseHolders = new Map(pidFiles.map(f => [f, readPid(f)] as const));
  let harnessPidFiles: string[] = [];
  if (showRestart) {
    try {
      harnessPidFiles = fs.readdirSync(pidDir).filter(f => f.startsWith("wtft-harness-") && f.endsWith(".pid"));
    } catch { /* tmp dir unreadable */ }
  }
  const harnessHolders = new Map(harnessPidFiles.map(f => [f, readPid(f)] as const));

  let found = 0;
  const seenPids = new Set<number>();
  const restarted = new Set<number>();
  const unlinkIfNames = (file: string, pid: number) => { unlinkLeaseIf(file, String(pid)); };
  for (const pidFile of pidFiles) {
    const fullPath = path.join(pidDir, pidFile);
    const pid = leaseHolders.get(pidFile) ?? NaN;
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
        unlinkIfNames(fullPath, pid);
        continue;
      }
      restarted.add(pid);
      const restartEnv = { ...process.env };
      if (alive && procIsDaemon(pid)) {
        for (const key of ["WTFT_CLAUDE_PROJECTS_DIR", "WTFT_PI_SESSIONS_DIR"]) {
          const value = procEnvValue(pid, key);
          if (value) restartEnv[key] = value;
        }
        try { process.kill(pid, "SIGTERM"); } catch (_) { /* already gone */ }
        waitUntilExited(pid);
      }
      unlinkIfNames(fullPath, pid);
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
        unlinkIfNames(fullPath, pid);
        continue;
      }
      if (sessionFound && sessionIsGone(sessionFound)) {
        // A harness's --session is only the one it was started for; it drops
        // a gone session itself.
        if (procIsHarness(pid)) continue;
        {
          if (procIsDaemon(pid)) { try { process.kill(pid, "SIGTERM"); } catch (_) { /* already gone */ } }
          unlinkIfNames(fullPath, pid);
          console.log(`Cleaned up: PID ${pid} — session gone: ${sessionFound}`);
        }
        found++;
        continue;
      }
    }

    if (stopSession && sessionFound && resolvedSessionArg(pid, sessionFound) === stopSession) {
      // A harness's --session is only the one it was started for; a session it
      // serves was handled above, through that session's own lease.
      if (alive && procIsHarness(pid)) continue;
      {
        if (alive && procIsDaemon(pid)) { try { process.kill(pid, "SIGTERM"); } catch (_) { /* already gone */ } }
        unlinkIfNames(fullPath, pid);
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
      // A harness stops itself once it serves nothing.
      if (showCleanup && fixture && !proc.harness) {
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
    for (const pidFile of harnessPidFiles) {
      const fullPath = path.join(pidDir, pidFile);
      const pid = harnessHolders.get(pidFile) ?? NaN;
      if (Number.isNaN(pid)) continue;
      if (pid <= 0 || seenPids.has(pid) || pid === process.pid) {
        unlinkIfNames(fullPath, pid);
        continue;
      }
      seenPids.add(pid);
      if (procIsDaemon(pid)) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
      // It writes its hand-off only while its pid file still names it.
      waitUntilExited(pid);
      unlinkIfNames(fullPath, pid);
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

  slot = freshSlot(sessionArg, true);
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
    if (newer.length > 0 && liveDaemonOrUnknown(Number(leaseHolder(pidPath)))) process.exit(0);
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
    process.stderr.write(`[wtft-log-parser] takeover scan error: ${e instanceof Error ? e.message : String(e)}\n`);
  }


  if (!claimedByTakeover) {
    // Any live process named by the lease keeps it, daemon or not: only ESRCH is gone.
    let displaced = "";
    const holderIsLive = (holder: string): boolean => {
      const pid = /^[1-9]\d*$/.test(holder) ? Number(holder) : 0;
      let live = Number.isSafeInteger(pid) && pid > 0;
      if (live) { try { process.kill(pid, 0); } catch (err) { live = (err as NodeJS.ErrnoException).code !== "ESRCH"; } }
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
          process.stderr.write(`[wtft-log-parser] removed stale tag file: ${f}\n`);
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

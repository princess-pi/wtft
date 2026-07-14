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
	deduplicateInteractions,
	serializeClassified,
	serializeClassifiedWithOverheadSplit,
	isInterruptMarker,
	WTFT_TAGGER_VERSION as TAGGER_VERSION
} from "../extensions/lib/wtft-shared.js";




// ---
// DAEMON CONFIGURATION
// ---

// Bump when classification heuristics or cost model change (#54, #55, etc).
const TAG_SUFFIX = `.wtft-tag.v${TAGGER_VERSION}.jsonl`;
const POLL_MS = 667;              // 90bpm throttle
const IDLE_EXIT_MS = 24 * 60 * 60 * 1000; // exit if session.jsonl unchanged for 24h (polite to ps aux)

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
let currentThinkingLevel: string | undefined; // Track thinking level from session events (#77)
let lastCompactionTokensBefore: number | undefined; // Track compaction tokensBefore (#90)
let pendingAfterCompaction = false; // Claude isCompactSummary → flag next interaction (#52 Phase 3)
let stampInterruptOnPending = false; // interrupt marker seen; assistant turn is in pendingItems (#52 Phase 3)
let prevCtxTokens = 0; // input+cacheRead+cacheWrite of prev non-sidechain interaction (recache signature)
let running = true;

// ---
// SIGNAL HANDLING
// ---

function shutdown(reason: string) {
  if (!running) return;
  running = false;
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
  // Log parser goes silent but exits cleanly
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

// ---
// FILE I/O HELPERS
// ---

/**
 * Overwrite the last line of the tag file if it's a heartbeat.
 * Updates the _hb range's `last` timestamp in place.
 * Always uses {"_hb":{"first":<ts>,"last":<ts>}} format for fixed width
 * so overwrites never change byte length. If the last line isn't a heartbeat
 * (new data arrived), appends a new heartbeat line.
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
    let lastLineStart = -1;

    while (searchOffset > 0 && lastLineStart === -1) {
      const readSize = Math.min(CHUNK, searchOffset);
      searchOffset -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, searchOffset);
      tail = buf.toString("utf8") + tail;
      lastLineStart = tail.lastIndexOf("\n");
    }
    if (lastLineStart === -1) lastLineStart = 0;
    else lastLineStart += 1;

    const lastLine = tail.slice(lastLineStart).trim();

    let isHb = false;
    try {
      const obj = JSON.parse(lastLine);
      isHb = obj._hb !== undefined;
    } catch (_) {}

    if (isHb) {
      // Overwrite in place — same format guarantees same length
      const newBytes = Buffer.from(hbLine);
      const oldByteLen = Buffer.from(lastLine + "\n").length;
      const writeBuf = Buffer.alloc(Math.max(newBytes.length, oldByteLen), 0x20);
      newBytes.copy(writeBuf, 0, 0, Math.min(newBytes.length, oldByteLen));
      // offset = file start + (position of lastLineStart within the tail buffer)
      // tail covers bytes [searchOffset, EOF), so lastLineStart is relative to searchOffset
      const offset = searchOffset + lastLineStart;
      fs.writeSync(fd, writeBuf, 0, oldByteLen, offset);
    } else {
      // Last line is data — append new heartbeat
      fs.appendFileSync(tagPath, hbLine);
    }
    fs.closeSync(fd);
  } catch (_) {
    // Fallback: append if we can't seek/overwrite
    try {
      fs.appendFileSync(tagPath, JSON.stringify({ _hb: { first: idleStartMs, last: now } }) + "\n");
    } catch (_2) {}
  }
}

function flushPending() {
  if (pendingItems.length === 0) return;
  // Serialize at flush: compaction/recache meter-splits emit dual lines,
  // and interrupt markers that arrived after enqueue are already stamped.
  const batch = pendingItems.map(it => serializeClassifiedWithOverheadSplit(it.interaction, it.prevCtx)).join("");
  pendingItems = [];
  try {
    fs.appendFileSync(tagPath, batch);
    idleStartMs = 0; // Data arrived — idle period ended
  } catch (err) {
    // If we can't write, log and continue — don't crash the log parser
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-log-parser] write error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  lastWriteMs = Date.now();
}

function parseNewLines(filePath: string) {
  // Pushes are null-guarded below, so the array holds only real Interactions.
  const interactions: NonNullable<ReturnType<typeof parseEntryToInteraction>>[] = [];
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
    if (currentSize <= lastSize) return interactions;
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(currentSize - lastSize);
    fs.readSync(fd, buf, 0, buf.length, lastSize);
    fs.closeSync(fd);
    lastSize = currentSize;
    const newContent = buf.toString("utf8");
    const lines = newContent.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        // Track thinking level changes (#77)
        if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
          currentThinkingLevel = entry.thinkingLevel;
          continue;
        }
        // Track compaction entries — stamp tokensBefore onto the next
        // assistant interaction (#90).
        if (entry.type === "compaction" && typeof entry.tokensBefore === "number") {
          lastCompactionTokensBefore = entry.tokensBefore;
          continue;
        }
        // Claude Code compact summary → flag next interaction for the
        // compaction meter-split (#52 Phase 3).
        if (entry.isCompactSummary === true) {
          pendingAfterCompaction = true;
          continue;
        }
        // User interrupt marker → the preceding assistant turn was killed.
        // It is either the last interaction of this batch, or still sitting
        // unflushed in pendingItems (stamped in the main loop). If it was
        // already flushed to the tag file, the stamp is dropped — bounded by
        // one 667ms beat.
        if (isInterruptMarker(entry)) {
          if (interactions.length > 0) {
            interactions[interactions.length - 1].interrupted = true;
          } else {
            stampInterruptOnPending = true;
          }
          continue;
        }
        const interaction = parseEntryToInteraction(entry, currentThinkingLevel, lastCompactionTokensBefore, pendingAfterCompaction);
        if (interaction) {
          interactions.push(interaction);
          lastCompactionTokensBefore = undefined; // consumed
          pendingAfterCompaction = false; // consumed
        }
      } catch (_) {
        // Skip unparseable lines (partial writes, non-JSON)
      }
    }
  } catch (_) {
    // File may not exist yet
  }
  return interactions;
}

// ---
// INITIALIZATION
// ---

function initClassified() {
  // Version is embedded in filename (TAG_SUFFIX), so no _cv header needed.
  // On startup: if the tag file already exists (same version) AND contains
  // actual classified entries (not just heartbeats), resume incrementally.
  // If tag file is missing or only has heartbeats, do a full re-parse.
  let hasData = false;
  try {
    fs.accessSync(tagPath);
    // Check if tag file has actual classified entries (not just _hb lines).
    const tagContent = fs.readFileSync(tagPath, "utf8");
    hasData = tagContent.split("\n").some(l => l.trim() && !l.includes('"_hb"'));
    if (hasData) {
      // Tag file has real data — resume from current session end
      try {
        const stat = fs.statSync(sessionPath);
        lastSize = stat.size;
      } catch (_) {}
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

function main() {
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
      console.log(`wtft-daemon — Session log parser for WTFT
Usage: wtft-daemon --session <path> [--debug]

Management:
  --list, -l            List all running log parsers (session, PID, idle time)
  --cleanup             Kill log parsers whose source session no longer exists
  --restart             Kill all running log parsers (fresh spawn on next wtft)
  --stop <session>      Stop log parser for a specific session path

Log parser mode:
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
      // Re-launch fresh log parser for same session
      if (sessionFound) {
        try {
          const child = spawn(process.execPath, [process.argv[1], "--session", sessionFound], {
            detached: true,
            stdio: "ignore"
          });
          child.unref();
        } catch (_2) {}
      }
      console.log(`Restarted: PID ${pid} → fresh log parser for ${sessionFound || "(unknown)"}`);
      found++;
      continue;
    }

    if (showCleanup) {
      if (!alive) {
        try { fs.unlinkSync(fullPath); } catch (_) {}
        continue;
      }
      if (sessionFound && !fs.existsSync(sessionFound)) {
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
    console.log(`Restarted ${found} log parser(s). Run wtft to spawn fresh instances.`);
  }
  if (showCleanup) {
    console.log(`Cleaned up ${found} log parser(s).`);
  }
  if (showList && found === 0) {
    console.log("No log parser processes found.");
  }
  if (stopSession && found === 0) {
    console.log(`No log parser found for: ${stopSession}`);
  }
  process.exit(0);
}

// --- Daemon mode (session required) ---

  if (!sessionPath) {
    process.stderr.write("wtft-daemon: --session <path> is required\n");
    process.exit(1);
  }
  if (!fs.existsSync(sessionPath)) {
    process.stderr.write(`wtft-daemon: session file not found: ${sessionPath}\n`);
    process.exit(1);
  }
  // Guard: refuse to watch a wtft-tag file (prevents recursive log parser loops).
  if (sessionPath.includes(".wtft-tag.v")) {
    process.stderr.write(`wtft-daemon: refusing to watch a tag cache file: ${sessionPath}\n`);
    process.exit(1);
  }

  // Determine wtft-tag path (wtft-tags/ subdirectory, version in filename).
  // Subdirectory keeps tag files out of session discovery — no filename filter needed.
  const sessionDir = path.dirname(sessionPath);
  const sessionBase = path.basename(sessionPath);
  const tagsDir = path.join(sessionDir, "wtft-tags");
  try { fs.mkdirSync(tagsDir, { recursive: true }); } catch (_) {}
  tagPath = path.join(tagsDir, sessionBase + TAG_SUFFIX);

  // PID file for singleton detection
  const sessionHash = createHash("sha256").update(sessionPath).digest("hex").slice(0, 12);
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
            // Process exists — another log parser is running, exit quietly
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

    try {
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
        }
      }

      // Throttled flush: write at most every 667ms
      const now = Date.now();
      if (pendingItems.length > 0 && (now - lastWriteMs) >= POLL_MS) {
        flushPending();
      }

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

      // If the session file disappears, exit cleanly.
      if (!fs.existsSync(sessionPath)) {
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

main();

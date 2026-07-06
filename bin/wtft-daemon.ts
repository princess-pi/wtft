#!/usr/bin/env -S node --experimental-strip-types

// bin/wtft-daemon.ts — Tagger daemon: session.jsonl → session.jsonl.wtft-tag.v{N}.jsonl
// Pure Unix pipe: one input file, one output file. No network.
// Throttled writes at 90bpm (667ms). Heartbeat protocol.
// Auto-spawned by wtft CLI; runs detached.
//
// Source file — esbuild bundles into bin/wtft-daemon.mjs.
// Shared classifier/cost functions imported from wtft-shared.ts — no inlining.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	parseEntryToInteraction,
	classifyInteraction,
	deduplicateInteractions,
} from "../extensions/lib/wtft-shared.ts";

// ---
// DAEMON CONFIGURATION
// ---

// Bump when classification heuristics or cost model change (#54, #55, etc).
const TAGGER_VERSION = "2.1.0";
const TAG_SUFFIX = `.wtft-tag.v${TAGGER_VERSION}.jsonl`;
const POLL_MS = 667;              // 90bpm throttle
const IDLE_EXIT_MS = 30 * 60 * 1000; // exit if session.jsonl unchanged for 30 min

function serializeClassified(interaction) {
  const line = {
    t: interaction.timestamp,
    c: interaction.cost,
    cat: classifyInteraction(interaction),
    f: interaction.files.map(f => ({ p: f.path, a: f.action })),
    cmd: interaction.commands,
  };
  return JSON.stringify(line) + "\n";
}

// ---
// DAEMON STATE
// ---

let sessionPath = null;
let tagPath = null;
let pidPath = null;
let lastSize = 0;            // bytes read from session.jsonl
let lastWriteMs = 0;         // last time we flushed to classified.jsonl
let lastActivityMs = Date.now(); // last time we classified a new interaction
let pendingLines = [];       // classified lines waiting for next flush
let idleStartMs = 0;         // start of current idle period (for _hb range)
let running = true;

// ---
// SIGNAL HANDLING
// ---

function shutdown(reason) {
  if (!running) return;
  running = false;
  // Flush any pending lines
  flushPending();
  // Write stop heartbeat
  try {
    fs.appendFileSync(tagPath, JSON.stringify({ _hb: "stop" }) + "\n");
  } catch (_) {}
  // Remove PID file
  try { fs.unlinkSync(pidPath); } catch (_) {}
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
 * Overwrite the last line of classified.jsonl if it's a heartbeat.
 * Updates the _hb range's `last` timestamp in place.
 * Always uses {"_hb":{"first":<ts>,"last":<ts>}} format for fixed width
 * so overwrites never change byte length. If the last line isn't a heartbeat
 * (new data arrived), appends a new heartbeat line.
 *
 * Scans backwards from EOF for the last newline to handle arbitrarily long
 * preceding lines (classified data lines can be large with `cmd` arrays).
 */
function upsertHeartbeat(now) {
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
  if (pendingLines.length === 0) return;
  const batch = pendingLines.join("");
  pendingLines = [];
  try {
    fs.appendFileSync(tagPath, batch);
    idleStartMs = 0; // Data arrived — idle period ended
  } catch (err) {
    // If we can't write, log and continue — don't crash the daemon
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-daemon] write error: ${err.message}\n`);
    }
  }
  lastWriteMs = Date.now();
}

function parseNewLines(filePath) {
  const interactions = [];
  try {
    const stat = fs.statSync(filePath);
    const currentSize = stat.size;
    if (currentSize < lastSize) {
      // File truncated or rotated — reset
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-daemon] session truncated, resetting offset\n`);
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
        const interaction = parseEntryToInteraction(entry);
        if (interaction) {
          interactions.push(interaction);
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
  // On startup: if the tag file already exists (same version), resume incrementally.
  // If not, create fresh (stale files already cleaned up by caller).
  try {
    fs.accessSync(tagPath);
    // Tag file exists with matching version — resume from current session end
    try {
      const stat = fs.statSync(sessionPath);
      lastSize = stat.size;
    } catch (_) {}
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
      console.log(`wtft-daemon — Tagger daemon for WTFT
Usage: wtft-daemon --session <path> [--debug]

Management:
  --list, -l            List all running daemons (session, PID, idle time)
  --cleanup             Kill daemons whose source session no longer exists
  --restart             Kill all running daemons (fresh spawn on next wtft)
  --stop <session>      Stop daemon for a specific session path

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
  let pidFiles = [];
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

    // Get tag file mtime for idle time (look in wtft-tags/ subdirectory)
    if (sessionFound) {
      try {
        const tagsDir = path.join(path.dirname(sessionFound), "wtft-tags");
        const sessBase = path.basename(sessionFound);
        const prefix = sessBase + ".wtft-tag.v";
        for (const f of fs.readdirSync(tagsDir)) {
          if (f.startsWith(prefix)) {
            tagMtime = fs.statSync(path.join(tagsDir, f)).mtimeMs;
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
      console.log(`PID ${String(pid).padEnd(7)} ${status.padEnd(20)} idle: ${idleStr.padEnd(5)} ${sessionDisplay}`);
    }
  }

  if (showRestart) {
    console.log(`Restarted ${found} daemon(s). Run wtft to spawn fresh instances.`);
  }
  if (showCleanup) {
    console.log(`Cleaned up ${found} daemon(s).`);
  }
  if (showList && found === 0) {
    console.log("No wtft-daemon processes found.");
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
  if (!fs.existsSync(sessionPath)) {
    process.stderr.write(`wtft-daemon: session file not found: ${sessionPath}\n`);
    process.exit(1);
  }
  // Guard: refuse to watch a wtft-tag file (prevents recursive daemon loops).
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

  // Clean up old-version tag files (different version suffix) on startup.
  // Version-in-filename means no _cv header check — just delete stale files.
  try {
    const prefix = sessionBase + ".wtft-tag.v";
    for (const f of fs.readdirSync(tagsDir)) {
      if (f.startsWith(prefix) && f !== sessionBase + TAG_SUFFIX) {
        const stale = path.join(tagsDir, f);
        try { fs.unlinkSync(stale); } catch (_) {}
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-daemon] removed stale tag file: ${f}\n`);
        }
      }
    }
  } catch (_) {}

  // PID file for singleton detection
  const sessionHash = createHash("sha256").update(sessionPath).digest("hex").slice(0, 12);
  pidPath = path.join(os.tmpdir(), `wtft-daemon-${sessionHash}.pid`);

  // Singleton check — atomic exclusive-create prevents TOCTOU race.
  // If PID file exists, verify the process is alive; clean up stale ones.
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

  // Initialize classified.jsonl (version check, header, start heartbeat)
  initClassified();

  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-daemon] started, watching: ${sessionPath}\n`);
    process.stderr.write(`[wtft-daemon] classified: ${tagPath}\n`);
    process.stderr.write(`[wtft-daemon] pid: ${process.pid}\n`);
  }

  // --- Main poll loop ---
  const loop = () => {
    if (!running) return;

    // Read new lines from session, dedup by message.id (#54), then classify.
    const rawInteractions = parseNewLines(sessionPath);
    const newInteractions = deduplicateInteractions(rawInteractions);
    if (newInteractions.length > 0) {
      lastActivityMs = Date.now();
      for (const interaction of newInteractions) {
        pendingLines.push(serializeClassified(interaction));
      }
    }

    // Throttled flush: write at most every 667ms
    const now = Date.now();
    if (pendingLines.length > 0 && (now - lastWriteMs) >= POLL_MS) {
      flushPending();
    }

    // Heartbeat: on every poll cycle when idle, update the _hb range line.
    // First idle poll appends {"_hb":{"first":<ts>}}. Subsequent idle polls
    // overwrite the last line in-place with {"_hb":{"first":<ts>,"last":<ts>}}.
    // When data arrives, the idle period ends — next idle starts a new line.
    if (pendingLines.length === 0) {
      if (idleStartMs === 0) idleStartMs = now;
      upsertHeartbeat(now);
      lastWriteMs = now;
      lastActivityMs = now;
    }

    // Idle exit: if session.jsonl hasn't been modified in >30 min,
    // assume the session is finished and shut down cleanly.
    try {
      const sessionStat = fs.statSync(sessionPath);
      if (now - sessionStat.mtimeMs >= IDLE_EXIT_MS) {
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-daemon] session idle for ${Math.round((now - sessionStat.mtimeMs)/60000)}m, exiting\n`);
        }
        shutdown("idle timeout");
        return;
      }
    } catch (_) {
      // Session file gone — clean exit
      shutdown("session removed");
      return;
    }

    setTimeout(loop, POLL_MS);
  };

  // Initial full classification if no existing cache
  // parseNewLines handles incremental via lastSize. If this is a fresh start,
  // lastSize is 0 and we'll parse all existing lines.
  loop();
}

main();

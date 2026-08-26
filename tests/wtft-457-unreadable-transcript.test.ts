#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-457-unreadable-transcript
 * @description #457 — parseSessionFile's bare catch returned [] on any read
 *   failure (EACCES, EISDIR, ENOMEM, a mid-read I/O error), byte-identical to
 *   a legitimately empty transcript, and syncSubagentTranscript then advanced
 *   its change detector (fileState.size/mtimeMs) as if the file had been read.
 *   If readability was restored without the file also changing size or mtime —
 *   a permissions fix, a remount, a transient FS error clearing — the
 *   transcript was never re-read and everything in it was dropped for the life
 *   of that daemon (#270's own bug class via the error path).
 *
 *   Closer: (a) parseSessionFile throws on read failure while still swallowing
 *   per-line JSON errors, and (b) the daemon does not mark an unreadable
 *   subagent transcript processed — the warning fires, nothing lands in the
 *   tag file, and the transcript is picked up in full once readability returns
 *   with size and mtime unchanged.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
	getDaemonPidPath,
	readClassifiedTagFile,
	parseSessionFile,
	WTFT_TAGGER_VERSION,
} from "../bin/wtft.mjs";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { skip } from "./lib/skips";

// Private pid namespace for this suite (#486). Must precede the first
// getDaemonPidPath() and the first daemon spawn — the daemon keys its lease on
// os.tmpdir() and sweeps every wtft-daemon-*.pid there at startup.
isolateTmpdir("subagent-unreadable");

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const BEAT_MS = 667;

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}`); failed++; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const cleanupPids: number[] = [];
const cleanupPidFiles: string[] = [];
const fixtureDirs: string[] = [];

// EACCES-based checks need an unprivileged reader: root bypasses file mode
// bits entirely, so chmod 000 still reads fine. Run the checks that depend on
// permission denial only when we actually are unprivileged.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function currentTagFileName(sessionPath: string): string {
	return path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`;
}

function spawnDaemon(sessionPath: string): { pid: number; stderr: string[] } {
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", sessionPath], {
		detached: true, stdio: ["ignore", "ignore", "pipe"],
	});
	const stderr: string[] = [];
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
	// A failed spawn fires 'error' (unhandled, it would crash the suite before
	// the assertions could report it) — record it where the wait loops can see
	// it, and never let a 0 pid reach cleanupPids: process.kill(0, "SIGTERM")
	// would signal THIS suite's process group, not a daemon.
	child.on("error", (err: Error) => stderr.push(`daemon spawn error: ${err.message}\n`));
	child.unref();
	if (child.pid) cleanupPids.push(child.pid);
	return { pid: child.pid || 0, stderr };
}

/**
 * Raw sweep-marker check. readClassifiedTagFile filters `_meta` rows out, so
 * the swept marker is invisible to it — read the tag file raw instead. A
 * missing tag file trivially has no marker.
 */
function rawTagHasSwept(tagPath: string): boolean {
	let content = "";
	try {
		content = fs.readFileSync(tagPath, "utf8");
	} catch {
		return false;
	}
	return content.includes('"_meta"') && content.includes('"swept"');
}

/** One assistant turn, Claude Code schema, distinct message.id per turn. */
function turnLine(id: string, tsMs: number, inputTokens: number, outputTokens: number): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			id,
			model: "claude-sonnet-4-6",
			timestamp: new Date(tsMs).toISOString(),
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			content: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

console.log("wtft unreadable-transcript handling (#457)");

// ---
// PART A — parseSessionFile read failures are loud, per-line JSON errors stay
// swallowed, and a genuinely empty file still reads as empty.
// ---
const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-457-")));
fixtureDirs.push(dir);

const readablePath = path.join(dir, "readable.jsonl");
fs.writeFileSync(readablePath, turnLine("msg_a1", Date.now() - 60_000, 1000, 100));

{
	// 1. Missing file: the old bare catch returned []; the fix throws, so the
	//    caller can tell "nothing in it" from "could not read it".
	let threw = false;
	try { parseSessionFile(path.join(dir, "never-exists.jsonl")); } catch { threw = true; }
	assert("missing transcript throws rather than returning []", threw);

	// 2. Directory path: EISDIR is a read failure, not an empty session.
	let threwDir = false;
	try { parseSessionFile(dir); } catch { threwDir = true; }
	assert("directory path throws rather than returning []", threwDir);

	// 3. Permission-denied read (unprivileged hosts only).
	if (isRoot) {
		skip("root bypasses file mode bits — chmod-000 read checks cannot run");
	} else {
		fs.chmodSync(readablePath, 0o000);
		let threwEacces = false;
		try { parseSessionFile(readablePath); } catch { threwEacces = true; }
		assert("chmod-000 transcript throws rather than returning []", threwEacces);
		fs.chmodSync(readablePath, 0o644);
	}

	// 4. Per-line JSON errors are STILL swallowed — a mid-write garbage line
	//    must not poison the whole file, that contract is unchanged.
	const mixedPath = path.join(dir, "mixed.jsonl");
	fs.writeFileSync(mixedPath, "this is not json\n" + turnLine("msg_a2", Date.now() - 50_000, 500, 50));
	const mixed = parseSessionFile(mixedPath);
	assert("garbage line is skipped, valid line still parsed", mixed.length === 1 && mixed[0].messageId === "msg_a2");

	// 5. A genuinely empty transcript still reads as empty — no throw, zero
	//    interactions. This is the byte-identity the old catch was faking.
	const emptyPath = path.join(dir, "empty.jsonl");
	fs.writeFileSync(emptyPath, "");
	const empty = parseSessionFile(emptyPath);
	assert("genuinely empty transcript reads as [] without throwing", empty.length === 0);
}

// ---
// PART B — the daemon does not mark an unreadable subagent transcript
// processed, and recovers when readability returns with size/mtime unchanged.
// ---
if (isRoot) {
	skip("root bypasses file mode bits — the daemon unreadable-transcript scenario cannot run");
} else {
	const daemonDir = path.join(dir, "daemon");
	fs.mkdirSync(daemonDir, { recursive: true });
	const sessionPath = path.join(daemonDir, "session.jsonl");
	fs.writeFileSync(sessionPath, JSON.stringify({
		type: "session", version: 3, id: "parent-457", timestamp: new Date().toISOString(), cwd: daemonDir,
	}) + "\n");
	const tagsDir = path.join(daemonDir, "wtft-tags");
	fs.mkdirSync(tagsDir, { recursive: true });
	cleanupPidFiles.push(getDaemonPidPath(sessionPath));

	// Claude Code convention: <sessionDir>/<sessionBase>/subagents/agent-*.jsonl
	const subagentDir = path.join(daemonDir, "session", "subagents");
	fs.mkdirSync(subagentDir, { recursive: true });
	const subagentPath = path.join(subagentDir, "agent-unreadable.jsonl");

	const T0 = Date.now() - 60_000;
	const TURN_ID = "msg_457_turn1";

	// The transcript exists with content, but is UNREADABLE from the start —
	// "discovered while still running", EACCES on the read.
	fs.writeFileSync(subagentPath, turnLine(TURN_ID, T0, 5000, 200));
	const statBefore = fs.statSync(subagentPath);
	fs.chmodSync(subagentPath, 0o000);

	const tagPath = path.join(tagsDir, currentTagFileName(sessionPath));

	try {
		const daemon = spawnDaemon(sessionPath);

		// Wait for the daemon to discover the subagent AND fail its read: the
		// #457 warning is the proof the read was attempted (and refused).
		let warned = false;
		for (let i = 0; i < 30 && !warned; i++) {
			await sleep(250);
			warned = daemon.stderr.join("").includes("could not be read or parsed");
		}
		assert("daemon warns that the unreadable transcript could not be read", warned);

		// The failure must not have been recorded as a completed read: nothing
		// from the transcript lands in the tag file while it is unreadable.
		let sawTurnWhileUnreadable = false;
		for (let i = 0; i < 8; i++) {
			await sleep(250);
			sawTurnWhileUnreadable = readClassifiedTagFile(tagPath).some(int => int.messageId === TURN_ID);
		}
		assert("no content from the unreadable transcript reaches the tag file", !sawTurnWhileUnreadable);

		// #443: the sweep marker must be WITHHELD too — pollHadFailure is set on
		// every poll while the read fails, so the tag must not claim swept.
		assert("swept marker is withheld while the transcript is unreadable", !rawTagHasSwept(tagPath));

		// Still polling, not crashed.
		let stillAlive = true;
		try { process.kill(daemon.pid, 0); } catch { stillAlive = false; }
		assert("daemon keeps polling after the read failure", stillAlive);

		// Readability returns WITHOUT the file changing size or mtime — chmod
		// touches only ctime — the exact scenario the old code dropped forever.
		fs.chmodSync(subagentPath, 0o644);
		const statAfter = fs.statSync(subagentPath);
		assert(
			"permission restore leaves size and mtime unchanged (the #457 scenario)",
			statAfter.size === statBefore.size && statAfter.mtimeMs === statBefore.mtimeMs
		);

		// The change detector was never advanced, so the next poll re-reads the
		// file and the turn lands in the tag file in full.
		let sawTurnAfterRestore = false;
		for (let i = 0; i < 20 && !sawTurnAfterRestore; i++) {
			await sleep(250);
			sawTurnAfterRestore = readClassifiedTagFile(tagPath).some(int => int.messageId === TURN_ID);
		}
		assert("transcript is re-read after readability returns and its turn is counted", sawTurnAfterRestore);

		// Once the recovered content has landed and the failure is gone, the
		// next clean sweep re-stamps the marker (tagGrewSinceMarker && no
		// pollHadFailure) — the tag graduates from provisional to swept.
		let sawSwept = false;
		for (let i = 0; i < 20 && !sawSwept; i++) {
			await sleep(250);
			sawSwept = rawTagHasSwept(tagPath);
		}
		assert("tag is swept only after the recovered transcript is counted", sawSwept);

		// Convergence with a direct parse of the now-readable file.
		const tagInteractions = readClassifiedTagFile(tagPath).filter(int => int.messageId === TURN_ID);
		const reference = parseSessionFile(subagentPath);
		const referenceCost = reference.reduce((s, i) => s + i.cost, 0);
		const tagCost = tagInteractions.reduce((s, i) => s + i.cost, 0);
		assert(
			`tag-file cost for the recovered turn matches a direct parse ($${tagCost.toFixed(6)} === $${referenceCost.toFixed(6)})`,
			tagInteractions.length === reference.length && Math.abs(tagCost - referenceCost) < 0.000001
		);
	} finally {
		// pid > 0 guard: kill(0, ...) would signal this suite's own process
		// group, so a spawn failure must never put a 0 in the list.
		for (const pid of cleanupPids) { if (pid > 0) { try { process.kill(pid, "SIGTERM"); } catch {} } }
		for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch {} }
		await sleep(200);
		for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
	}
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

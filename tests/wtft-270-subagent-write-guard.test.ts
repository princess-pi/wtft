#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-270-subagent-write-guard
 * @description #270 review (High/contract, bin/wtft-daemon.ts) — the subagent
 *   incremental path advanced its byte offset BEFORE appending to the tag file,
 *   and the append ran outside any try/catch. A transient filesystem error
 *   (ENOSPC, EACCES, tag dir removed) therefore threw past the whole per-file
 *   loop with the offset already moved past the bytes that were never written:
 *   those interactions could never be re-read, which is #270's own
 *   "later writes invisible forever" failure re-triggered by an I/O blip.
 *   The code this replaced (writeSessionToTagFile) wrapped
 *   parse+dedupe+serialize+append in one try/catch and degraded silently.
 *
 *   Closer: make the tag file un-appendable, let a subagent turn arrive and
 *   fail to write, make the tag file writable again, and append NOTHING new —
 *   the turn that failed to write must still land in the tag file, exactly
 *   once, and the turn that DID get written must not be re-appended.
 *
 *   The duplication assertions count RAW tag-file lines. They counted through
 *   readClassifiedTagFile until #270's round-3 review: that reader collapses
 *   lines sharing a `message.id`, so it answers 1 whether the daemon wrote the
 *   turn once or five times, and the assertion could not fail. Measured against
 *   a deliberately broken daemon (recovery rewinding to offset 0): the raw
 *   count reports 2, the reader-based count still reports 1.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
	getDaemonPidPath,
	readClassifiedTagFile,
	WTFT_TAGGER_VERSION,
} from "../bin/wtft.mjs";
import { skip } from "./lib/skips";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";


// Private pid namespace for this suite (#486). Must precede the first
// getDaemonPidPath() and the first daemon spawn — the daemon keys its lease on
// os.tmpdir() and sweeps every wtft-daemon-*.pid there at startup.
isolateTmpdir("write-guard");

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");

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

/** Raw tag-file lines carrying this message id — what the DAEMON wrote, before
 *  any read-side collapse. readClassifiedTagFile collapses lines sharing a
 *  `message.id` (#270 review), so counting duplicates THROUGH it is vacuous:
 *  it reports 1 whether the daemon wrote the turn once or five times. Same
 *  helper as the sibling crosspoll test, for the same reason. */
function rawTagLinesFor(tagPath: string, messageId: string): number {
	try {
		return fs.readFileSync(tagPath, "utf8").split("\n")
			.filter(l => l.trim() && (() => { try { return JSON.parse(l).id === messageId; } catch { return false; } })())
			.length;
	} catch { return 0; }
}

console.log("wtft daemon subagent write guard (#270 review)");

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-guard-")));
fixtureDirs.push(dir);

const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-270-guard", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");
const tagsDir = path.join(dir, "wtft-tags");
fs.mkdirSync(tagsDir, { recursive: true });
cleanupPidFiles.push(getDaemonPidPath(sessionPath));

const subagentDir = path.join(dir, "session", "subagents");
fs.mkdirSync(subagentDir, { recursive: true });
const subagentPath = path.join(subagentDir, "agent-guard1.jsonl");

const T0 = Date.now() - 60_000;
const TURN1_ID = "msg_270_guard_turn1";
const TURN2_ID = "msg_270_guard_turn2";

fs.writeFileSync(subagentPath, turnLine(TURN1_ID, T0, 5000, 200));

const tagPath = path.join(tagsDir, currentTagFileName());
function currentTagFileName(): string {
	return path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`;
}

function spawnDaemon(): number {
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", sessionPath], {
		detached: true, stdio: "ignore",
	});
	child.unref();
	if (child.pid) cleanupPids.push(child.pid);
	return child.pid || 0;
}

try {
	const daemonPid = spawnDaemon();

	let sawTurn1 = false;
	for (let i = 0; i < 24 && !sawTurn1; i++) {
		await sleep(250);
		sawTurn1 = readClassifiedTagFile(tagPath).some((int: any) => int.messageId === TURN1_ID);
	}
	assert("daemon parses the subagent's first turn", sawTurn1);

	// Make the tag file un-appendable, then let a new subagent turn arrive.
	// Every write the daemon attempts in this window fails with EACCES.
	//
	// ...unless we are root, for whom mode bits do not deny writes at all (PR
	// review). Every assertion below would then hold trivially — daemon alive,
	// turn lands, count 1 — while the catch/retry path this test is named for
	// never runs, which is worse than not running the test: it is a green tick
	// for coverage that does not exist. Verified rather than assumed: the chmod
	// is applied and then a real append is attempted.
	fs.chmodSync(tagPath, 0o444);
	let chmodDenies = false;
	try {
		fs.appendFileSync(tagPath, "");
	} catch {
		chmodDenies = true;
	}
	if (!chmodDenies) {
		// NOT process.exit: the `finally` below is what kills the spawned daemon
		// and removes the fixture dirs, and exit() would skip it, leaving a
		// daemon running against a deleted tree.
		skip("write-guard: chmod 0444 does not deny writes for this user (running as root?) — the EACCES path cannot be exercised here");
	} else {
	fs.appendFileSync(subagentPath, turnLine(TURN2_ID, T0 + 5_000, 8000, 300));

	// Several polls' worth of failed writes.
	await sleep(2500);

	// The daemon must still be alive — a transient FS error is not fatal.
	let alive = false;
	try { process.kill(daemonPid, 0); alive = true; } catch { alive = false; }
	assert("daemon survives an un-writable tag file", alive);

	// Restore writability and append NOTHING new to the subagent transcript.
	// Recovery must come from re-reading bytes whose write failed.
	fs.chmodSync(tagPath, 0o644);

	let sawTurn2 = false;
	for (let i = 0; i < 24 && !sawTurn2; i++) {
		await sleep(250);
		sawTurn2 = readClassifiedTagFile(tagPath).some((int: any) => int.messageId === TURN2_ID);
	}
	assert("the turn whose write failed is re-read and written once the tag file is writable again", sawTurn2);

	// And exactly once — recovery must not replay lines that DID get written.
	// RAW lines, not readClassifiedTagFile: the reader collapses by message.id,
	// so asking it "how many copies?" can only ever answer 1.
	const turn1Count = rawTagLinesFor(tagPath, TURN1_ID);
	assert(`the already-written turn is not re-appended during recovery (${turn1Count} === 1)`, turn1Count === 1);
	const turn2Count = rawTagLinesFor(tagPath, TURN2_ID);
	assert(`the recovered turn lands exactly once, not once per failed poll (${turn2Count} === 1)`, turn2Count === 1);
	}
} finally {
	try { fs.chmodSync(tagPath, 0o644); } catch {}
	for (const pid of cleanupPids) { try { process.kill(pid, "SIGTERM"); } catch {} }
	for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch {} }
	await sleep(200);
	for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

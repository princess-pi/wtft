#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-270-subagent-truncate-diagnostic
 * @description #270 review (Low/contract, bin/wtft-daemon.ts) — a rotated or
 *   truncated subagent transcript used to reset the daemon's position on that
 *   file SILENTLY, even with the debug switch on, while the parent session's
 *   equivalent branch has named itself on stderr since #155. That made the
 *   subagent case strictly harder to diagnose than its parent counterpart.
 *
 *   The mechanism moved in #270's round-3 rewrite — the daemon now re-parses a
 *   changed subagent transcript WHOLE and appends only lines it has not already
 *   written, so a shrink discards that file's written-line record rather than
 *   rewinding a byte offset. The requirement did not move: a shrink is a
 *   diagnosable event either way, and it must still say so.
 *
 *   Closer: with WTFT_DAEMON_DEBUG=1, truncating a subagent transcript the
 *   daemon has already read puts a named diagnostic on the daemon's stderr, the
 *   same as truncating the parent session does — and the replacement content is
 *   still picked up.
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
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";


// Private pid namespace for this suite (#486). Must precede the first
// getDaemonPidPath() and the first daemon spawn — the daemon keys its lease on
// os.tmpdir() and sweeps every wtft-daemon-*.pid there at startup.
isolateTmpdir("truncate-diagnostic");

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

function turnLine(id: string, tsMs: number, outputTokens: number, padding = ""): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			id,
			model: "claude-sonnet-4-6",
			timestamp: new Date(tsMs).toISOString(),
			usage: {
				input_tokens: 5000,
				output_tokens: outputTokens,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			content: [{ type: "text", text: `turn ${id}${padding}` }],
		},
	}) + "\n";
}

console.log("wtft daemon subagent truncation diagnostic (#270 review)");

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-trunc-")));
fixtureDirs.push(dir);

const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-270-trunc", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");
const tagsDir = path.join(dir, "wtft-tags");
fs.mkdirSync(tagsDir, { recursive: true });
cleanupPidFiles.push(getDaemonPidPath(sessionPath));

const subagentDir = path.join(dir, "session", "subagents");
fs.mkdirSync(subagentDir, { recursive: true });
const subagentPath = path.join(subagentDir, "agent-trunc1.jsonl");

const T0 = Date.now() - 60_000;
const BIG_ID = "msg_270_trunc_big";
const SMALL_ID = "msg_270_trunc_small";

// A deliberately long first turn, so rewriting the file with a short one is a
// genuine size decrease — the rotation/truncation signal.
fs.writeFileSync(subagentPath, turnLine(BIG_ID, T0, 200, "x".repeat(4096)));

const tagPath = path.join(tagsDir, path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
const stderrPath = path.join(dir, "daemon-stderr.log");
const stderrFd = fs.openSync(stderrPath, "a");

try {
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", sessionPath], {
		detached: true,
		stdio: ["ignore", "ignore", stderrFd],
		env: { ...process.env, WTFT_DAEMON_DEBUG: "1" },
	});
	child.unref();
	if (child.pid) cleanupPids.push(child.pid);

	let sawBig = false;
	for (let i = 0; i < 24 && !sawBig; i++) {
		await sleep(250);
		sawBig = readClassifiedTagFile(tagPath).some((int: any) => int.messageId === BIG_ID);
	}
	assert("daemon reads the subagent transcript before it is truncated", sawBig);

	// Rotate: replace the transcript with a shorter one.
	fs.writeFileSync(subagentPath, turnLine(SMALL_ID, T0 + 5_000, 300));

	let sawDiagnostic = false;
	for (let i = 0; i < 24 && !sawDiagnostic; i++) {
		await sleep(250);
		const log = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, "utf8") : "";
		sawDiagnostic = /subagent transcript truncated/.test(log);
	}
	assert("a truncated subagent transcript names itself on stderr under WTFT_DAEMON_DEBUG", sawDiagnostic);

	// And the reset still does its job: the post-rotation content is picked up.
	let sawSmall = false;
	for (let i = 0; i < 24 && !sawSmall; i++) {
		await sleep(250);
		sawSmall = readClassifiedTagFile(tagPath).some((int: any) => int.messageId === SMALL_ID);
	}
	assert("the reset still re-reads the rotated transcript from zero", sawSmall);
} finally {
	try { fs.closeSync(stderrFd); } catch {}
	for (const pid of cleanupPids) { try { process.kill(pid, "SIGTERM"); } catch {} }
	for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch {} }
	await sleep(200);
	for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

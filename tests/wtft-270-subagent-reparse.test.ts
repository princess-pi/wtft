#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-270-subagent-reparse
 * @description #270 — the daemon parsed each subagent transcript once, at the
 *   moment it was first discovered, and never re-read it. Discovery re-runs
 *   every poll (that part was fine); it was the PARSE that was one-shot, so
 *   anything a subagent wrote after its first discovery was invisible to the
 *   daemon forever, and the undercount was persisted into the tag file.
 *
 *   Closer: a subagent transcript that grows AFTER first discovery has its
 *   later content counted — daemon-cached tag file content converges on a
 *   direct parseSessionFile()+dedup of the same (fully-written) file, without
 *   needing `wtft -F`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
	getDaemonPidPath,
	readClassifiedTagFile,
	parseSessionFile,
	deduplicateInteractions,
	WTFT_TAGGER_VERSION,
} from "../bin/wtft.mjs";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";


// Private pid namespace for this suite (#486). Must precede the first
// getDaemonPidPath() and the first daemon spawn — the daemon keys its lease on
// os.tmpdir() and sweeps every wtft-daemon-*.pid there at startup.
isolateTmpdir("subagent-reparse");

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

function currentTagFileName(sessionPath: string): string {
	return path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`;
}

function spawnDaemon(sessionPath: string): number {
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", sessionPath], {
		detached: true, stdio: "ignore",
	});
	child.unref();
	if (child.pid) cleanupPids.push(child.pid);
	return child.pid || 0;
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

console.log("wtft daemon subagent re-parse (#270)");

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-")));
fixtureDirs.push(dir);

const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-270", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");
const tagsDir = path.join(dir, "wtft-tags");
fs.mkdirSync(tagsDir, { recursive: true });
cleanupPidFiles.push(getDaemonPidPath(sessionPath));

// Claude Code convention: <sessionDir>/<sessionBase>/subagents/agent-*.jsonl
const subagentDir = path.join(dir, "session", "subagents");
fs.mkdirSync(subagentDir, { recursive: true });
const subagentPath = path.join(subagentDir, "agent-sub1.jsonl");

const T0 = Date.now() - 60_000;
const TURN1_ID = "msg_270_turn1";
const TURN2_ID = "msg_270_turn2";

// Subagent transcript exists BEFORE the daemon starts, with only its first turn —
// this is "discovered while still running."
fs.writeFileSync(subagentPath, turnLine(TURN1_ID, T0, 5000, 200));

const tagPath = path.join(tagsDir, currentTagFileName(sessionPath));

try {
	spawnDaemon(sessionPath);

	// Wait for the daemon to discover and parse the subagent's FIRST turn.
	let sawTurn1 = false;
	for (let i = 0; i < 20 && !sawTurn1; i++) {
		await sleep(250);
		sawTurn1 = readClassifiedTagFile(tagPath).some(int => int.messageId === TURN1_ID);
	}
	assert("daemon discovers and parses the subagent's first turn", sawTurn1);

	// The subagent keeps running: it appends a SECOND turn to its own transcript
	// AFTER the daemon already discovered (and parsed) the file once.
	fs.appendFileSync(subagentPath, turnLine(TURN2_ID, T0 + 5_000, 8000, 300));

	// Wait across several more poll cycles for the daemon to pick up the growth.
	let sawTurn2 = false;
	for (let i = 0; i < 20 && !sawTurn2; i++) {
		await sleep(250);
		sawTurn2 = readClassifiedTagFile(tagPath).some(int => int.messageId === TURN2_ID);
	}
	assert("daemon re-parses the subagent transcript and counts the SECOND turn", sawTurn2);

	// Convergence: the daemon's live (cached) numbers for this subagent equal a
	// direct parseSessionFile()+dedup of the fully-written file — no -F needed.
	const daemonInteractions = readClassifiedTagFile(tagPath).filter(
		int => int.messageId === TURN1_ID || int.messageId === TURN2_ID
	);
	const daemonCost = daemonInteractions.reduce((s, i) => s + i.cost, 0);
	const daemonInputTokens = daemonInteractions.reduce((s, i) => s + i.inputTokens, 0);

	const reference = deduplicateInteractions(parseSessionFile(subagentPath));
	const referenceCost = reference.reduce((s, i) => s + i.cost, 0);
	const referenceInputTokens = reference.reduce((s, i) => s + i.inputTokens, 0);

	assert(
		`daemon-cached interaction count matches full re-parse (${daemonInteractions.length} === ${reference.length})`,
		daemonInteractions.length === reference.length
	);
	assert(
		`daemon-cached input tokens match full re-parse (${daemonInputTokens} === ${referenceInputTokens})`,
		daemonInputTokens === referenceInputTokens
	);
	assert(
		`daemon-cached cost matches full re-parse within $0.000001 (daemon=$${daemonCost.toFixed(6)} ref=$${referenceCost.toFixed(6)})`,
		Math.abs(daemonCost - referenceCost) < 0.000001
	);
} finally {
	for (const pid of cleanupPids) { try { process.kill(pid, "SIGTERM"); } catch {} }
	for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch {} }
	await sleep(200);
	for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

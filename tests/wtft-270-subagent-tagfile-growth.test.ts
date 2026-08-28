#!/usr/bin/env bun
/**
 * @package princess-pi-tools
 * @test wtft-270-subagent-tagfile-growth
 * @description #270 — the cost bound on re-parsing subagent transcripts, made
 *   into a test instead of a claim in a comment.
 *
 *   The daemon re-reads every known subagent transcript on every 667ms poll.
 *   Whatever mechanism decides what to APPEND, the tag file must grow only when
 *   the transcript grew: one new turn in the transcript means one new classified
 *   line in the tag file, and a quiet transcript means none. Re-appending what
 *   is already on disk is O(n^2) in a session's own output — the tag file is
 *   read whole by every consumer, so unbounded growth is not merely wasteful,
 *   it re-prices the same tokens on every read for any consumer that does not
 *   collapse duplicates.
 *
 *   The reader DOES collapse lines sharing a message.id (dedupeClassifiedById),
 *   which makes an unbounded tag file *correct* and *unaffordable* at the same
 *   time. That is exactly why this has to be measured on RAW lines rather than
 *   inferred from a cost total: the cost total stays right while the file runs
 *   away.
 *
 *   Closer: across ~5 polls with an unchanged transcript the raw classified
 *   line count does not move; appending ONE turn moves it by exactly one.
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
isolateTmpdir("tagfile-growth");

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

/** RAW classified lines on disk — every line the daemon appended that carries a
 *  category, heartbeats and _meta offsets excluded. Deliberately NOT
 *  readClassifiedTagFile: that collapses by message.id, which is precisely the
 *  growth this test has to see. */
function rawClassifiedLineCount(tagPath: string): number {
	try {
		return fs.readFileSync(tagPath, "utf8").split("\n").filter(l => {
			if (!l.trim()) return false;
			try { return JSON.parse(l).cat !== undefined; } catch { return false; }
		}).length;
	} catch { return 0; }
}

console.log("wtft daemon subagent tag-file growth is bounded (#270)");

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-growth-")));
fixtureDirs.push(dir);

const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-270-growth", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");
const tagsDir = path.join(dir, "wtft-tags");
fs.mkdirSync(tagsDir, { recursive: true });
cleanupPidFiles.push(getDaemonPidPath(sessionPath));

const subagentDir = path.join(dir, "session", "subagents");
fs.mkdirSync(subagentDir, { recursive: true });
const subagentPath = path.join(subagentDir, "agent-growth1.jsonl");

const T0 = Date.now() - 60_000;
const SEED_TURNS = 4;

// Several turns already on disk before the daemon starts, so a whole-file
// re-append is worth 4 lines a poll, not 1 — visible within a couple of beats.
let seed = "";
for (let i = 0; i < SEED_TURNS; i++) {
	seed += turnLine(`msg_270_growth_${i}`, T0 + i * 1_000, 1000 + i * 100, 50);
}
fs.writeFileSync(subagentPath, seed);

const tagPath = path.join(tagsDir, path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
const LAST_SEED_ID = `msg_270_growth_${SEED_TURNS - 1}`;
const NEW_TURN_ID = "msg_270_growth_new";

try {
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", sessionPath], {
		detached: true, stdio: "ignore",
	});
	child.unref();
	if (child.pid) cleanupPids.push(child.pid);

	let sawSeed = false;
	for (let i = 0; i < 24 && !sawSeed; i++) {
		await sleep(250);
		sawSeed = readClassifiedTagFile(tagPath).some((int: any) => int.messageId === LAST_SEED_ID);
	}
	assert("daemon writes the seeded subagent turns", sawSeed);

	const afterSeed = rawClassifiedLineCount(tagPath);
	assert(`the seeded turns land once each (${afterSeed} === ${SEED_TURNS})`, afterSeed === SEED_TURNS);

	// ~5 poll cycles with the transcript untouched.
	await sleep(BEAT_MS * 5 + 500);
	const afterIdle = rawClassifiedLineCount(tagPath);
	assert(
		`5 polls over an UNCHANGED transcript append nothing (${afterIdle} === ${afterSeed})`,
		afterIdle === afterSeed
	);

	// One new turn — the tag file may grow by exactly one line.
	fs.appendFileSync(subagentPath, turnLine(NEW_TURN_ID, T0 + 30_000, 2000, 60));

	let sawNew = false;
	for (let i = 0; i < 24 && !sawNew; i++) {
		await sleep(250);
		sawNew = readClassifiedTagFile(tagPath).some((int: any) => int.messageId === NEW_TURN_ID);
	}
	assert("daemon picks up the appended turn", sawNew);

	// Another ~5 quiet polls, so a re-append design cannot hide inside the beat
	// that carried the new turn.
	await sleep(BEAT_MS * 5 + 500);
	const afterGrowth = rawClassifiedLineCount(tagPath);
	assert(
		`one appended turn costs exactly one tag line, quiet polls after it cost none (${afterGrowth} === ${afterSeed + 1})`,
		afterGrowth === afterSeed + 1
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

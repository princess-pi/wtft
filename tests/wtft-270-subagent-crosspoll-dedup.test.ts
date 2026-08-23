#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-270-subagent-crosspoll-dedup
 * @description #270 review (Medium/correctness, bin/wtft-daemon.ts) — an
 *   OVERCOUNT introduced by the incremental subagent reader, in the same file
 *   #270 fixed an undercount in.
 *
 *   Before #270 a subagent transcript was parsed whole (parseSessionFile) and
 *   deduplicateInteractions ran over ALL of it, so a message re-emitted with
 *   growing usage across several JSONL lines sharing one `message.id` collapsed
 *   to one interaction at max cost. #270's first cut read incrementally, which
 *   deduped only WITHIN a poll batch, so the same id landing in two poll windows
 *   was appended twice and counted twice. Round 3 restored the whole-file parse
 *   and kept the read-side collapse this test drove out; the property below is
 *   what both halves have to hold, whichever way the daemon reads the file.
 *
 *   That is not a corner case. Measured over the twelve most recent live
 *   Claude Code transcripts on this host, 39-76% of message ids carrying `usage`
 *   are re-emitted (e.g. 117 of 293 = 39.9%, 72 of 95 = 75.8%), and a subagent
 *   transcript shows the growing-usage form directly: one id at output_tokens
 *   8, 8, then 457, with `tool_result` lines and 1.3-4.2s of wall clock in
 *   between — straddling the daemon's 667ms beat by construction.
 *
 *   Closer: a subagent transcript re-emitting one message.id with higher usage
 *   in a LATER poll than the first emission reads back as exactly ONE
 *   interaction, at the higher usage, matching a full parseSessionFile()+dedup
 *   of the same file.
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
import { trackSandbox } from "./lib/sandbox";

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

/** One assistant line. Two lines sharing `id` with different usage is the
 *  streaming-partial shape deduplicateInteractions exists to collapse. */
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

/** Raw tag-file lines carrying this message id — what the DAEMON wrote,
 *  before any read-side collapse. */
function rawTagLinesFor(tagPath: string, messageId: string): number {
	try {
		return fs.readFileSync(tagPath, "utf8").split("\n")
			.filter(l => l.trim() && (() => { try { return JSON.parse(l).id === messageId; } catch { return false; } })())
			.length;
	} catch { return 0; }
}

console.log("wtft daemon subagent cross-poll dedup (#270 review)");

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-dedup-")));
fixtureDirs.push(dir);

const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-270-dedup", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");
const tagsDir = path.join(dir, "wtft-tags");
fs.mkdirSync(tagsDir, { recursive: true });
cleanupPidFiles.push(getDaemonPidPath(sessionPath));

const subagentDir = path.join(dir, "session", "subagents");
fs.mkdirSync(subagentDir, { recursive: true });
const subagentPath = path.join(subagentDir, "agent-dedup1.jsonl");

const T0 = Date.now() - 60_000;
const STREAMED_ID = "msg_270_streamed";

// Poll window N: the partial. 8 output tokens, as first flushed.
fs.writeFileSync(subagentPath, turnLine(STREAMED_ID, T0, 5000, 8));

const tagPath = path.join(tagsDir, path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);

try {
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", sessionPath], {
		detached: true, stdio: "ignore",
	});
	child.unref();
	if (child.pid) cleanupPids.push(child.pid);

	let sawPartial = false;
	for (let i = 0; i < 24 && !sawPartial; i++) {
		await sleep(250);
		sawPartial = rawTagLinesFor(tagPath, STREAMED_ID) >= 1;
	}
	assert("daemon writes the streaming partial in the first poll window", sawPartial);

	// Poll window N+1: the SAME message id, re-emitted with the final usage.
	fs.appendFileSync(subagentPath, turnLine(STREAMED_ID, T0 + 2_000, 5000, 457));

	// Wait for the daemon to have processed the second line at all. Read the RAW
	// tag file, not the reader — the fix is allowed to leave two lines on disk.
	let sawSecondWrite = false;
	for (let i = 0; i < 24 && !sawSecondWrite; i++) {
		await sleep(250);
		sawSecondWrite = rawTagLinesFor(tagPath, STREAMED_ID) >= 2;
	}
	assert("daemon reads the re-emitted line in a later poll window", sawSecondWrite);

	// The money assertions: what a consumer sees.
	const seen = readClassifiedTagFile(tagPath).filter((int: any) => int.messageId === STREAMED_ID);
	const reference = deduplicateInteractions(parseSessionFile(subagentPath))
		.filter((int: any) => int.messageId === STREAMED_ID);

	assert(
		`one message id reads back as one interaction, not one per poll window (${seen.length} === ${reference.length})`,
		seen.length === reference.length && seen.length === 1
	);

	const seenOut = seen.reduce((s: number, i: any) => s + i.outputTokens, 0);
	const refOut = reference.reduce((s: number, i: any) => s + i.outputTokens, 0);
	assert(
		`the surviving copy carries the FINAL usage, not the partial and not the sum (${seenOut} === ${refOut})`,
		seenOut === refOut && seenOut === 457
	);

	const seenCost = seen.reduce((s: number, i: any) => s + i.cost, 0);
	const refCost = reference.reduce((s: number, i: any) => s + i.cost, 0);
	assert(
		`cost matches full re-parse within $0.000001 (daemon=$${seenCost.toFixed(6)} ref=$${refCost.toFixed(6)})`,
		Math.abs(seenCost - refCost) < 0.000001
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

#!/usr/bin/env bun
/**
 * #270 review (Medium/correctness, bin/wtft-daemon.ts) — an
 *   OVERCOUNT introduced by the incremental subagent reader, in the same file
 *   #270 fixed an undercount in.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readClassifiedTagFile } from "../extensions/lib/wtft-daemon-lib.ts";
import { parseSessionFile, deduplicateInteractions } from "../extensions/lib/wtft-parser.ts";
import { trackSandbox } from "./lib/sandbox";
import { tagSession } from "./lib/tagger-harness.ts";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}`); failed++; }
}

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

console.log("subagent cross-poll dedup, tagged in process (#270 review)");

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-dedup-")));

const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-270-dedup", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");

const subagentDir = path.join(dir, "session", "subagents");
fs.mkdirSync(subagentDir, { recursive: true });
const subagentPath = path.join(subagentDir, "agent-dedup1.jsonl");

const T0 = Date.now() - 60_000;
const STREAMED_ID = "msg_270_streamed";

// Poll window N: the partial. 8 output tokens, as first flushed.
fs.writeFileSync(subagentPath, turnLine(STREAMED_ID, T0, 5000, 8));


{
	const tagger = tagSession(sessionPath);
	const tagPath = tagger.tagPath;

	const sawPartial = tagger.until(() => rawTagLinesFor(tagPath, STREAMED_ID) >= 1);
	assert("the tagger writes the streaming partial in the first poll window", sawPartial);

	// Poll window N+1: the SAME message id, re-emitted with the final usage.
	fs.appendFileSync(subagentPath, turnLine(STREAMED_ID, T0 + 2_000, 5000, 457));

	// Wait for the daemon to have processed the second line at all. Read the RAW
	// tag file, not the reader — the fix is allowed to leave two lines on disk.
	const sawSecondWrite = tagger.until(() => rawTagLinesFor(tagPath, STREAMED_ID) >= 2);
	assert("the tagger reads the re-emitted line in a later poll window", sawSecondWrite);

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
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env bun
/**
 * #270 — the daemon parsed each subagent transcript once, at the
 *   moment it was first discovered, and never re-read it.
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

console.log("subagent re-parse, tagged in process (#270)");

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-")));

const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-270", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");

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

{
	const tagger = tagSession(sessionPath);
	const tagPath = tagger.tagPath;

	// Wait for the daemon to discover and parse the subagent's FIRST turn.
	const sawTurn1 = tagger.until(() => readClassifiedTagFile(tagPath).some(int => int.messageId === TURN1_ID));
	assert("the tagger discovers and parses the subagent's first turn", sawTurn1);

	// The subagent keeps running: it appends a SECOND turn to its own transcript
	// AFTER the daemon already discovered (and parsed) the file once.
	fs.appendFileSync(subagentPath, turnLine(TURN2_ID, T0 + 5_000, 8000, 300));

	// Wait across several more poll cycles for the daemon to pick up the growth.
	const sawTurn2 = tagger.until(() => readClassifiedTagFile(tagPath).some(int => int.messageId === TURN2_ID));
	assert("the tagger re-parses the subagent transcript and counts the SECOND turn", sawTurn2);

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
		`tagged interaction count matches full re-parse (${daemonInteractions.length} === ${reference.length})`,
		daemonInteractions.length === reference.length
	);
	assert(
		`tagged input tokens match full re-parse (${daemonInputTokens} === ${referenceInputTokens})`,
		daemonInputTokens === referenceInputTokens
	);
	assert(
		`tagged cost matches full re-parse within $0.000001 (daemon=$${daemonCost.toFixed(6)} ref=$${referenceCost.toFixed(6)})`,
		Math.abs(daemonCost - referenceCost) < 0.000001
	);
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

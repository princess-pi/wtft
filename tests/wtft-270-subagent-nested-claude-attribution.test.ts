#!/usr/bin/env bun
/**
 * Silent overcount of nested `claude -p` sub-agents when
 *   attributeClaudeSubAgentCosts is called once per POLL BATCH.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readClassifiedTagFile } from "../extensions/lib/wtft-daemon-lib.ts";
import { deduplicateInteractions, parseSessionFile } from "../extensions/lib/wtft-parser.ts";
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

/** A plain assistant turn (no tools) — the nested session's own billed work. */
function turnLine(id: string, tsMs: number, inputTokens: number, outputTokens: number): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso, // entry-level ts: what discoverClaudeSubAgentSessionFiles matches on
		message: {
			role: "assistant",
			id,
			model: "claude-sonnet-4-6",
			timestamp: iso,
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

/** An assistant turn whose bash tool call spawns `claude -p` in `cwd` — the
 *  shape attributeClaudeSubAgentCosts looks for (#138). */
function claudeBashTurnLine(id: string, tsMs: number, inputTokens: number, outputTokens: number, cwd: string): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso,
		message: {
			role: "assistant",
			id,
			model: "claude-sonnet-4-6",
			timestamp: iso,
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			content: [{
				type: "toolCall",
				name: "bash",
				arguments: { command: `cd ${cwd} && claude -p "do the thing"` },
			}],
		},
	}) + "\n";
}

console.log("nested claude-bash attribution across poll windows, tagged in process (#270 review r3)");

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-nested-")));

// A scratch projects root, so discovery never reads the host's ~/.claude/projects.
const tempHome = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-home-")));

// The cwd the subagent's bash turns cd into. Its Claude Code project slug is
// derived from this path, so a unique fixture dir gives us a project directory
// no other session can be writing to.
const nestedCwd = path.join(dir, "nested-project");
fs.mkdirSync(nestedCwd, { recursive: true });
const slug = nestedCwd.replace(/\//g, "-");
process.env.WTFT_CLAUDE_PROJECTS_DIR = path.join(tempHome, ".claude", "projects");
const projectDir = path.join(process.env.WTFT_CLAUDE_PROJECTS_DIR, slug);
fs.mkdirSync(projectDir, { recursive: true });

const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-270-nested", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");

const subagentDir = path.join(dir, "session", "subagents");
fs.mkdirSync(subagentDir, { recursive: true });
const subagentPath = path.join(subagentDir, "agent-nested1.jsonl");

const T0 = Date.now() - 60_000;
const TURN_A_ID = "msg_270_nested_a";
const TURN_B_ID = "msg_270_nested_b";

// The ONE nested session both bash turns resolve to. 1000 in / 100 out on
// sonnet = $0.003000 + $0.001500 = $0.004500 — the amount at stake.
const NESTED_COST = 0.0045;
fs.writeFileSync(
	path.join(projectDir, "nested-session-270.jsonl"),
	turnLine("msg_270_nested_inner", T0 + 2_000, 1000, 100),
);

// Turn A: 2000 in / 100 out = $0.007500.  Turn B: 3000 in / 100 out = $0.010500.
const TURN_A_OWN = 0.0075;
const TURN_B_OWN = 0.0105;
const EXPECTED_TOTAL = TURN_A_OWN + TURN_B_OWN + NESTED_COST; // $0.022500
const DOUBLE_COUNTED_TOTAL = EXPECTED_TOTAL + NESTED_COST;    // $0.027000

fs.writeFileSync(subagentPath, claudeBashTurnLine(TURN_A_ID, T0, 2000, 100, nestedCwd));

{
	const tagger = tagSession(sessionPath);
	const tagPath = tagger.tagPath;

	// Poll window N: only turn A exists. It attributes the nested session.
	const sawA = tagger.until(() => readClassifiedTagFile(tagPath).some((int: any) => int.messageId === TURN_A_ID));
	assert("the tagger writes the first claude-invoking bash turn", sawA);

	const seenAOnly = readClassifiedTagFile(tagPath).filter((int: any) => int.messageId === TURN_A_ID);
	const aCost = seenAOnly.reduce((s: number, i: any) => s + i.cost, 0);
	assert(
		`turn A carries the nested session's cost (daemon=$${aCost.toFixed(6)} expected=$${(TURN_A_OWN + NESTED_COST).toFixed(6)})`,
		Math.abs(aCost - (TURN_A_OWN + NESTED_COST)) < 0.000001
	);

	// Poll window N+1: turn B arrives, resolving to the SAME nested session.
	fs.appendFileSync(subagentPath, claudeBashTurnLine(TURN_B_ID, T0 + 5_000, 3000, 100, nestedCwd));

	const sawB = tagger.until(() => readClassifiedTagFile(tagPath).some((int: any) => int.messageId === TURN_B_ID));
	assert("the tagger writes the second claude-invoking bash turn", sawB);

	// Let a few more polls run — a re-parse design must not keep re-adding.
	for (let i = 0; i < 3; i++) tagger.poll();

	const seen = readClassifiedTagFile(tagPath).filter(
		(int: any) => int.messageId === TURN_A_ID || int.messageId === TURN_B_ID
	);
	const seenCost = seen.reduce((s: number, i: any) => s + i.cost, 0);

	const referenceCost = deduplicateInteractions(parseSessionFile(subagentPath)).reduce((sum: number, i: any) => sum + i.cost, 0);

	assert(
		`whole-file reference attributes the nested session ONCE (ref=$${referenceCost.toFixed(6)} expected=$${EXPECTED_TOTAL.toFixed(6)})`,
		Math.abs(referenceCost - EXPECTED_TOTAL) < 0.000001
	);
	assert(
		`the tagger attributes the nested session ONCE, not once per poll window (daemon=$${seenCost.toFixed(6)} expected=$${EXPECTED_TOTAL.toFixed(6)}, double-counted would be $${DOUBLE_COUNTED_TOTAL.toFixed(6)})`,
		Math.abs(seenCost - EXPECTED_TOTAL) < 0.000001
	);
	assert(
		`the tagged total matches the whole-file reference within $0.000001 (daemon=$${seenCost.toFixed(6)} ref=$${referenceCost.toFixed(6)})`,
		Math.abs(seenCost - referenceCost) < 0.000001
	);
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

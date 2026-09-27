#!/usr/bin/env bun
/**
 * #270 — the cost bound on re-parsing subagent transcripts, made
 *   into a test instead of a claim in a comment.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readClassifiedTagFile } from "../extensions/lib/wtft-daemon-lib.ts";
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

console.log("subagent tag-file growth is bounded, tagged in process (#270)");

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-growth-")));

const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-270-growth", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");

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

const LAST_SEED_ID = `msg_270_growth_${SEED_TURNS - 1}`;
const NEW_TURN_ID = "msg_270_growth_new";

{
	const tagger = tagSession(sessionPath);
	const tagPath = tagger.tagPath;

	const sawSeed = tagger.until(() => readClassifiedTagFile(tagPath).some((int: any) => int.messageId === LAST_SEED_ID));
	assert("the tagger writes the seeded subagent turns", sawSeed);

	const afterSeed = rawClassifiedLineCount(tagPath);
	assert(`the seeded turns land once each (${afterSeed} === ${SEED_TURNS})`, afterSeed === SEED_TURNS);

	// ~5 poll cycles with the transcript untouched.
	for (let i = 0; i < 5; i++) tagger.poll();
	const afterIdle = rawClassifiedLineCount(tagPath);
	assert(
		`5 polls over an UNCHANGED transcript append nothing (${afterIdle} === ${afterSeed})`,
		afterIdle === afterSeed
	);

	// One new turn — the tag file may grow by exactly one line.
	fs.appendFileSync(subagentPath, turnLine(NEW_TURN_ID, T0 + 30_000, 2000, 60));

	const sawNew = tagger.until(() => readClassifiedTagFile(tagPath).some((int: any) => int.messageId === NEW_TURN_ID));
	assert("the tagger picks up the appended turn", sawNew);

	// Another ~5 quiet polls, so a re-append design cannot hide inside the beat
	// that carried the new turn.
	for (let i = 0; i < 5; i++) tagger.poll();
	const afterGrowth = rawClassifiedLineCount(tagPath);
	assert(
		`one appended turn costs exactly one tag line, quiet polls after it cost none (${afterGrowth} === ${afterSeed + 1})`,
		afterGrowth === afterSeed + 1
	);
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

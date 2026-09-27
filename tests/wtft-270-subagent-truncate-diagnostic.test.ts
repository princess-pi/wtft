#!/usr/bin/env bun
/**
 * #270 review (Low/contract, bin/wtft-daemon.ts) — a rotated or
 *   truncated subagent transcript used to reset the daemon's position on that
 *   file SILENTLY, even with the debug switch on, while the parent session's
 *   equivalent branch has named itself on stderr since #155. That made the
 *   subagent case strictly harder to diagnose than its parent counterpart.
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

console.log("subagent truncation diagnostic, tagged in process (#270 review)");

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-trunc-")));

const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-270-trunc", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");

const subagentDir = path.join(dir, "session", "subagents");
fs.mkdirSync(subagentDir, { recursive: true });
const subagentPath = path.join(subagentDir, "agent-trunc1.jsonl");

const T0 = Date.now() - 60_000;
const BIG_ID = "msg_270_trunc_big";
const SMALL_ID = "msg_270_trunc_small";

// A deliberately long first turn, so rewriting the file with a short one is a
// genuine size decrease — the rotation/truncation signal.
fs.writeFileSync(subagentPath, turnLine(BIG_ID, T0, 200, "x".repeat(4096)));


{
	const tagger = tagSession(sessionPath);
	const tagPath = tagger.tagPath;

	const sawBig = tagger.until(() => readClassifiedTagFile(tagPath).some((int: any) => int.messageId === BIG_ID));
	assert("the tagger reads the subagent transcript before it is truncated", sawBig);

	// Rotate: replace the transcript with a shorter one.
	fs.writeFileSync(subagentPath, turnLine(SMALL_ID, T0 + 5_000, 300));

	const rotated = () => tagger.log.some(l => l.level === "debug" && /subagent transcript rotated/.test(l.text));
	const sawDiagnostic = tagger.until(rotated);
	assert("a rotated subagent transcript names itself in a debug log line (stderr under WTFT_DAEMON_DEBUG)", sawDiagnostic);

	// And the reset still does its job: the post-rotation content is picked up.
	const sawSmall = tagger.until(() => readClassifiedTagFile(tagPath).some((int: any) => int.messageId === SMALL_ID));
	assert("the reset still re-reads the rotated transcript from zero", sawSmall);
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

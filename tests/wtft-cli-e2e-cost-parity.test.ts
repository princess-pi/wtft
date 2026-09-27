/**
 * Runs the built `wtft` CLI on a fixture session tagged in process, and
 *   asserts that the tag, the CLI and a straight parse agree on the total.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { cliWithoutDaemon, tagForCli } from "./lib/cli-harness.ts";

import {
	readClassifiedTagFile,
	deduplicateInteractions,
	parseSessionFile,
	WTFT_TAGGER_VERSION,
} from "../bin/wtft.mjs";

isolateTmpdir("cli-e2e-cost-parity");

// ---
// FIXTURE: Claude Code multi-block response plus a second distinct message.
// Tests dedup across messages — two message.ids, 4 raw lines, 2 deduped.
// ---

const FIXTURE_ID = "fixture-e2e-cost-parity";
const MSG_1 = "msg_e2e_001";
const MSG_2 = "msg_e2e_002";
const TS = Date.now();

function makeFixture(): { dir: string; sessionPath: string } {
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-e2e-")));
	const sessionPath = path.join(dir, `${FIXTURE_ID}.jsonl`);

	const lines = [
		// Message 1, block A (text)
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant", id: MSG_1, model: "claude-sonnet-4-6",
				timestamp: new Date(TS).toISOString(),
				usage: {
					input_tokens: 5000, output_tokens: 200,
					cache_creation_input_tokens: 1000,
					cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 800 },
				},
				content: [{ type: "text", text: "Here's the code:" }],
			},
		}),
		// Message 1, block B (tool_use write) — same id, same usage
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant", id: MSG_1, model: "claude-sonnet-4-6",
				timestamp: new Date(TS).toISOString(),
				usage: {
					input_tokens: 5000, output_tokens: 200,
					cache_creation_input_tokens: 1000,
					cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 800 },
				},
				content: [{ type: "tool_use", name: "write", input: { file_path: "src/main.ts" } }],
			},
		}),
		// Message 1, block C (tool_use bash) — same id, same usage
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant", id: MSG_1, model: "claude-sonnet-4-6",
				timestamp: new Date(TS).toISOString(),
				usage: {
					input_tokens: 5000, output_tokens: 200,
					cache_creation_input_tokens: 1000,
					cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 800 },
				},
				content: [{ type: "tool_use", name: "bash", input: { command: "npm test" } }],
			},
		}),
		// Message 2 (separate message) — different id
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant", id: MSG_2, model: "claude-sonnet-4-6",
				timestamp: new Date(TS + 60000).toISOString(),
				usage: {
					input_tokens: 3000, output_tokens: 100,
					cache_read_input_tokens: 500,
				},
				content: [{ type: "text", text: "Done." }],
			},
		}),
	];

	fs.writeFileSync(sessionPath, lines.join("\n") + "\n");
	return { dir, sessionPath };
}

// ---
// HELPERS
// ---

// ---
// TEST: Non-watch CLI vs daemon tag file (simulated watch)
// ---

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string) {
	if (cond) { console.log(`✅ ${label}`); passed++; }
	else { console.error(`❌ ${label}`); failed++; }
}

console.log("=== WTFT CLI End-to-End Cost Parity ===\n");

const { dir, sessionPath } = makeFixture();

// ---
// Path 1: the session tagged as the daemon tags it, then the built CLI
// rendering from that tag.
// ---

const tagPath = tagForCli(sessionPath).tagPath;
const tagEntries = readClassifiedTagFile(tagPath);
const tagCost = tagEntries.reduce((sum, i) => sum + i.cost, 0);
console.log(`Tag file: $${tagCost.toFixed(6)} (${tagEntries.length} entries)`);

let cliOut = "";
try {
	cliOut = execFileSync(process.execPath, [cliWithoutDaemon(), "--session", sessionPath, "-l", "10"],
		{ encoding: "utf8", env: process.env, timeout: 15000, stdio: "pipe" });
} catch (err: any) {
	console.error(`Non-watch CLI: ${err.stderr || err.message}`);
}

// ---
// Assertions
// ---

assert(cliOut.includes(`$${tagCost.toFixed(2)}`), `the CLI renders the tag's total, $${tagCost.toFixed(2)}`);
assert(tagCost > 0, `Tag cost > 0 (got $${tagCost.toFixed(6)})`);

// Path 3: Reference cost via parseSessionFile + deduplicateInteractions
// (same functions the daemon inlines — should produce identical results).
const rawInteractions = parseSessionFile(sessionPath);
const dedupedInteractions = deduplicateInteractions(rawInteractions);
const referenceCost = dedupedInteractions.reduce((sum, i) => sum + i.cost, 0);
console.log(`Reference (parseSessionFile + dedup): $${referenceCost.toFixed(6)} (${dedupedInteractions.length} interactions)`);

const tagDelta = Math.abs(tagCost - referenceCost);
assert(
	tagDelta < 0.001,
	`Tag vs reference within 0.1¢: tag=$${tagCost.toFixed(6)} ref=$${referenceCost.toFixed(6)} (delta=$${tagDelta.toFixed(6)})`
);

// Verify dedup: raw 4 lines → 2 deduped messages
assert(rawInteractions.length === 4, `Raw parse: 4 lines (got ${rawInteractions.length})`);
assert(dedupedInteractions.length === 2, `Deduped: 2 messages (got ${dedupedInteractions.length})`);

// Tag version check
assert(tagPath.includes(`v${WTFT_TAGGER_VERSION}`), `Tag file uses v${WTFT_TAGGER_VERSION}`);

// Cleanup
try { fs.rmSync(dir, { recursive: true }); } catch {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

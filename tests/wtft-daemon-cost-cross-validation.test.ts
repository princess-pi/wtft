/**
 * Validates that the daemon's classified output produces the same
 *   total cost as the direct parseSessionFile + deduplicateInteractions path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readClassifiedTagFile } from "../extensions/lib/wtft-daemon-lib.ts";
import { parseSessionFile, deduplicateInteractions } from "../extensions/lib/wtft-parser.ts";
import { WTFT_TAGGER_VERSION } from "../extensions/lib/wtft-tagger-version.ts";
import type { Interaction } from "../extensions/lib/wtft-shared.ts";
import { trackSandbox } from "./lib/sandbox";
import { tagSession } from "./lib/tagger-harness.ts";

// ---
// FIXTURE: Claude Code multi-block response with shared message.id
// Each content block is a separate JSONL line, each echoing the same
// message-level usage. Without dedup (#54), summing per-line inflates
// cost ~2×. With TTL-split (#55), cache-write uses 1-hour 2× rate.
// ---

const SESSION_ID = "fixture-session-daemon-cost-test";
const MESSAGE_ID = "msg_dedup_test_001";
const TIMESTAMP = Date.now();

function makeFixture(): string {
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-daemon-test-")));
	const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);

	const lines = [
		// Pi schema: assistant message with 3 content blocks, all same message.id
		// Block 1: text
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				id: MESSAGE_ID,
				model: "claude-sonnet-4-6",
				timestamp: new Date(TIMESTAMP).toISOString(),
				usage: {
					input_tokens: 10000,
					output_tokens: 500,
					cache_read_input_tokens: 2000,
					cache_creation_input_tokens: 3000,
					cache_creation: {
						ephemeral_5m_input_tokens: 500,
						ephemeral_1h_input_tokens: 2500,
					},
				},
				content: [{ type: "text", text: "Here's the fix:" }],
			},
		}),
		// Block 2: tool_use (write) — same message.id, same usage
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				id: MESSAGE_ID,
				model: "claude-sonnet-4-6",
				timestamp: new Date(TIMESTAMP).toISOString(),
				usage: {
					input_tokens: 10000,
					output_tokens: 500,
					cache_read_input_tokens: 2000,
					cache_creation_input_tokens: 3000,
					cache_creation: {
						ephemeral_5m_input_tokens: 500,
						ephemeral_1h_input_tokens: 2500,
					},
				},
				content: [
					{
						type: "tool_use",
						name: "write",
						input: { file_path: "src/main.ts" },
					},
				],
			},
		}),
		// Block 3: tool_use (bash) — same message.id, same usage
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				id: MESSAGE_ID,
				model: "claude-sonnet-4-6",
				timestamp: new Date(TIMESTAMP).toISOString(),
				usage: {
					input_tokens: 10000,
					output_tokens: 500,
					cache_read_input_tokens: 2000,
					cache_creation_input_tokens: 3000,
					cache_creation: {
						ephemeral_5m_input_tokens: 500,
						ephemeral_1h_input_tokens: 2500,
					},
				},
				content: [
					{
						type: "tool_use",
						name: "bash",
						input: { command: "npm test" },
					},
				],
			},
		}),
	];

	fs.writeFileSync(sessionPath, lines.join("\n") + "\n");
	return { dir, sessionPath };
}

// ---
// REFERENCE: direct parseSessionFile + dedup (the "correct" path)
// ---

function computeReferenceCost(sessionPath: string): {
	totalCost: number;
	interactionCount: number;
} {
	const raw = parseSessionFile(sessionPath);
	const deduped = deduplicateInteractions(raw);
	const totalCost = deduped.reduce((sum, i) => sum + i.cost, 0);
	return { totalCost, interactionCount: deduped.length };
}

// ---
// TAGGER: tag the fixture as the daemon does, read the classified output
// ---

function runTagger(sessionPath: string): string {
	const tagger = tagSession(sessionPath);
	tagger.until(() => readClassifiedTagFile(tagger.tagPath).length > 0);
	return tagger.tagPath;
}

function computeDaemonCost(tagPath: string): {
	totalCost: number;
	interactionCount: number;
} {
	const interactions = readClassifiedTagFile(tagPath);
	const totalCost = interactions.reduce((sum, i) => sum + i.cost, 0);
	return { totalCost, interactionCount: interactions.length };
}

// ---
// RUN
// ---

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
	if (condition) {
		console.log(`✅ ${label}`);
		passed++;
	} else {
		console.error(`❌ ${label}`);
		failed++;
	}
}

console.log("=== WTFT Daemon Cost Cross-Validation ===\n");

const { dir, sessionPath } = makeFixture();

// 1. Reference cost
const ref = computeReferenceCost(sessionPath);
console.log(
	`Reference: ${ref.interactionCount} interactions, $${ref.totalCost.toFixed(6)}`
);

// 2. Daemon cost
const tagPath = runTagger(sessionPath);
const daemon = computeDaemonCost(tagPath);
console.log(
	`Daemon:    ${daemon.interactionCount} interactions, $${daemon.totalCost.toFixed(6)}\n`
);

// 3. Assertions
assert(
	ref.interactionCount === 1,
	`Reference: 1 deduped interaction (got ${ref.interactionCount})`
);
assert(
	daemon.interactionCount === ref.interactionCount,
	`Interaction counts match: ${daemon.interactionCount} === ${ref.interactionCount}`
);

// Cost tolerance: 0.1 cents (floating point may differ at 6th decimal)
const costDelta = Math.abs(daemon.totalCost - ref.totalCost);
assert(
	costDelta < 0.001,
	`Costs match within 0.1¢: ref=$${ref.totalCost.toFixed(6)} daemon=$${daemon.totalCost.toFixed(6)} (delta=$${costDelta.toFixed(6)})`
);

// 4. Verify the raw (undeduped) count would be 3
const raw = parseSessionFile(sessionPath);
assert(
	raw.length === 3,
	`Raw parse yields 3 interactions (got ${raw.length}) — confirms multi-line fixture`
);

// 5. Tag version check
const tagContent = fs.readFileSync(tagPath, "utf8");
const hasExpectedVersion = tagPath.includes(`v${WTFT_TAGGER_VERSION}`);
assert(hasExpectedVersion, `Tag file uses v${WTFT_TAGGER_VERSION} version`);

// Cleanup
try { fs.rmSync(dir, { recursive: true }); } catch {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

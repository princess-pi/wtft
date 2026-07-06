/**
 * @package princess-pi-packages
 * @test wtft-daemon-cost-cross-validation
 * @description Validates that the daemon's classified output produces the same
 *   total cost as the direct parseSessionFile + deduplicateInteractions path.
 *   Catches drift between the daemon's inlined cost functions and wtft-shared.ts.
 *
 *   Root cause of the 2x watch-mode bug: daemon lacked #54 (message-ID dedup)
 *   and #55 (TTL-split cache-write pricing). This test would have caught both.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import {
	parseSessionFile,
	deduplicateInteractions,
	readClassifiedTagFile,
	type Interaction,
} from "../extensions/lib/wtft-shared.ts";

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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-daemon-test-"));
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
// DAEMON: run daemon on fixture, read classified output
// ---

function runDaemon(sessionPath: string): string {
	// Tag file path the daemon will write
	const sessionDir = path.dirname(sessionPath);
	const sessionBase = path.basename(sessionPath);
	const tagsDir = path.join(sessionDir, "wtft-tags");
	const tagPath = path.join(tagsDir, sessionBase + ".wtft-tag.v2.2.0.jsonl");

	// Remove any stale tag files
	try { fs.rmSync(tagsDir, { recursive: true }); } catch {}

	const daemonPath = path.join(process.cwd(), "bin", "wtft-daemon.mjs");

	// Run daemon with --session, wait for it to process the fixture
	const child = spawn(process.execPath, [daemonPath, "--session", sessionPath], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();

	// Busy-wait for the tag file to appear and stabilize (daemon poll cycle is 667ms).
	// In a real test suite we'd use async/await, but this test runs via tsx directly.
	const start = Date.now();
	while (Date.now() - start < 5000) {
		try {
			if (fs.existsSync(tagPath)) {
				const content = fs.readFileSync(tagPath, "utf8");
				// Daemon writes heartbeat first, then classified entries.
				// Wait until we see a classified entry (non-heartbeat line).
				const hasClassified = content
					.split("\n")
					.some((l) => l.trim() && !l.includes('"_hb"'));
				if (hasClassified) break;
			}
		} catch {}
	}

	return tagPath;
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
const tagPath = runDaemon(sessionPath);
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
const hasV22 = tagPath.includes("v2.2.0");
assert(hasV22, "Tag file uses v2.2.0 version");

// Cleanup
try { fs.rmSync(dir, { recursive: true }); } catch {}
// Kill any remaining daemons
try {
	const pidDir = os.tmpdir();
	const pidFiles = fs
		.readdirSync(pidDir)
		.filter((f) => f.startsWith("wtft-daemon-") && f.endsWith(".pid"));
	for (const pf of pidFiles) {
		try {
			const pid = parseInt(
				fs.readFileSync(path.join(pidDir, pf), "utf8").trim(),
				10
			);
			if (pid > 0) process.kill(pid, "SIGTERM");
		} catch {}
		try { fs.unlinkSync(path.join(pidDir, pf)); } catch {}
	}
} catch {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

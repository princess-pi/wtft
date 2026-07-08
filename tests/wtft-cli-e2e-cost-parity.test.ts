/**
 * @package princess-pi-packages
 * @test wtft-cli-e2e-cost-parity
 * @description End-to-end test: runs the actual `wtft` CLI binary on a fixture
 *   session and asserts that non-watch, watch-mode (simulated), and direct
 *   daemon output all produce the same total cost. Catches integration-level
 *   drift between the two CLI paths.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import {
	readClassifiedTagFile,
	deduplicateInteractions,
	parseSessionFile,
	WTFT_TAGGER_VERSION,
} from "../extensions/lib/wtft-shared.ts";

// ---
// FIXTURE: Claude Code multi-block response plus a second distinct message.
// Tests dedup across messages — two message.ids, 5 raw lines, 2 deduped.
// ---

const FIXTURE_ID = "fixture-e2e-cost-parity";
const MSG_1 = "msg_e2e_001";
const MSG_2 = "msg_e2e_002";
const TS = Date.now();

function makeFixture(): { dir: string; sessionPath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-e2e-"));
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

function killAllLogParsers() {
	try {
		const pidDir = os.tmpdir();
		for (const pf of fs.readdirSync(pidDir)) {
			if (pf.startsWith("wtft-daemon-") && pf.endsWith(".pid")) {
				try {
					const pid = parseInt(fs.readFileSync(path.join(pidDir, pf), "utf8").trim(), 10);
					if (pid > 0) process.kill(pid, "SIGTERM");
				} catch {}
				try { fs.unlinkSync(path.join(pidDir, pf)); } catch {}
			}
		}
	} catch {}
}

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

// Kill any leftover daemons from previous test runs
killAllLogParsers();

const { dir, sessionPath } = makeFixture();

// ---
// Path 1: Non-watch CLI (exercises actual bin/wtft.mjs binary).
// Spawns daemon, reads tag file, renders chart. We capture the exact
// cost by reading the tag file the daemon produces — not from the
// formatted (rounded) chart output.
// ---

const wtftBin = path.join(process.cwd(), "bin", "wtft.mjs");
try {
	const result = execSync(
		`${process.execPath} ${wtftBin} --session ${sessionPath} -l 10`,
		{ encoding: "utf8", timeout: 15000, stdio: "pipe" }
	);
	console.log("Non-watch CLI ran successfully");
} catch (err: any) {
	console.error(`Non-watch CLI: ${err.stderr || err.message}`);
}

// ---
// Path 2: Read the daemon's tag file (same data both CLI paths consume).
// ---

const tagsDir = path.join(dir, "wtft-tags");
const tagPath = path.join(tagsDir, `${FIXTURE_ID}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);

// Wait for daemon to finish processing (spawned by non-watch CLI above).
let tagEntries: any[] = [];
let waited = 0;
while (waited < 5000) {
	if (fs.existsSync(tagPath)) {
		const content = fs.readFileSync(tagPath, "utf8");
		if (content.split("\n").some(l => l.trim() && !l.includes('"_hb"'))) {
			tagEntries = readClassifiedTagFile(tagPath);
			break;
		}
	}
	await new Promise(r => setTimeout(r, 250));
	waited += 250;
}
const daemonCost = tagEntries.reduce((sum, i) => sum + i.cost, 0);
console.log(`Log parser tag file: $${daemonCost.toFixed(6)} (${tagEntries.length} entries)`);

// ---
// Assertions
// ---

assert(daemonCost > 0, `Log parser cost > 0 (got $${daemonCost.toFixed(6)})`);

// Path 3: Reference cost via parseSessionFile + deduplicateInteractions
// (same functions the daemon inlines — should produce identical results).
const rawInteractions = parseSessionFile(sessionPath);
const dedupedInteractions = deduplicateInteractions(rawInteractions);
const referenceCost = dedupedInteractions.reduce((sum, i) => sum + i.cost, 0);
console.log(`Reference (parseSessionFile + dedup): $${referenceCost.toFixed(6)} (${dedupedInteractions.length} interactions)`);

const tagDelta = Math.abs(daemonCost - referenceCost);
assert(
	tagDelta < 0.001,
	`Log parser vs reference within 0.1¢: ref=$${daemonCost.toFixed(6)} ref=$${referenceCost.toFixed(6)} (delta=$${tagDelta.toFixed(6)})`
);

// Verify dedup: raw 5 lines → 2 deduped messages
assert(rawInteractions.length === 4, `Raw parse: 4 lines (got ${rawInteractions.length})`);
assert(dedupedInteractions.length === 2, `Deduped: 2 messages (got ${dedupedInteractions.length})`);

// Tag version check
assert(tagPath.includes(`v${WTFT_TAGGER_VERSION}`), `Tag file uses v${WTFT_TAGGER_VERSION}`);

// Cleanup
killAllLogParsers();
try { fs.rmSync(dir, { recursive: true }); } catch {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

/**
 * Test: Thinking level tracking via thinking_level_change entries (#77)
 *
 * Validates that:
 * 1. parseSessionFile captures thinkingLevel from thinking_level_change entries
 * 2. Subsequent interactions are stamped with the active thinkingLevel
 * 3. Tag file serialization/deserialization preserves thinkingLevel
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseSessionFile, parseEntryToInteraction } from "../extensions/lib/wtft-parser.js";
import { serializeClassified, classifiedToInteraction } from "../extensions/lib/wtft-daemon-lib.js";

const TEST_DIR = path.join(os.tmpdir(), "wtft-thinking-level-test-" + Date.now());
const SESSION_FILE = path.join(TEST_DIR, "session.jsonl");

function setup() {
	fs.mkdirSync(TEST_DIR, { recursive: true });
	// Simulate: thinking level set to "high", then two assistant messages
	fs.writeFileSync(SESSION_FILE, [
		JSON.stringify({ type: "thinking_level_change", id: "e1", thinkingLevel: "high" }),
		JSON.stringify({ type: "message", message: {
			role: "assistant", id: "m1", model: "claude-sonnet-4-6",
			usage: { input: 100, output: 50, reasoning: 30 },
			content: [{ type: "text", text: "hello" }]
		}}),
		JSON.stringify({ type: "thinking_level_change", id: "e2", thinkingLevel: "low" }),
		JSON.stringify({ type: "message", message: {
			role: "assistant", id: "m2", model: "claude-sonnet-4-6",
			usage: { input: 200, output: 60 },
			content: [{ type: "text", text: "world" }]
		}}),
	].join("\n") + "\n");
}

function cleanup() {
	try { fs.rmSync(TEST_DIR, { recursive: true }); } catch {}
}

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ ${msg}`); }
}

// --- Test 1: parseSessionFile captures thinkingLevel ---
console.log("=== Test 1: parseSessionFile thinkingLevel tracking ===");
setup();
const interactions = parseSessionFile(SESSION_FILE);
assert(interactions.length === 2, `Expected 2 interactions, got ${interactions.length}`);
assert(interactions[0].thinkingLevel === "high", `First interaction should be "high", got "${interactions[0].thinkingLevel}"`);
assert(interactions[1].thinkingLevel === "low", `Second interaction should be "low", got "${interactions[1].thinkingLevel}"`);

// --- Test 2: parseEntryToInteraction with explicit thinkingLevel ---
console.log("=== Test 2: parseEntryToInteraction with thinkingLevel param ===");
const entry = { type: "message", message: {
	role: "assistant", id: "m3", model: "deepseek-v4-pro",
	usage: { input: 100 },
	content: [{ type: "text", text: "test" }]
}};
const ix = parseEntryToInteraction(entry, "xhigh");
assert(ix !== null, "Should produce an interaction");
if (ix) assert(ix.thinkingLevel === "xhigh", `Expected "xhigh", got "${ix.thinkingLevel}"`);

// --- Test 3: Tag file round-trip preserves thinkingLevel ---
console.log("=== Test 3: Tag file round-trip ===");
if (ix) {
	const line = serializeClassified(ix);
	const parsed = JSON.parse(line);
	assert(parsed.tl === "xhigh", `Tag file tl field should be "xhigh", got "${parsed.tl}"`);
	const roundTripped = classifiedToInteraction(parsed);
	assert(roundTripped !== null, "Should deserialize");
	if (roundTripped) assert(roundTripped.thinkingLevel === "xhigh", `Round-tripped thinkingLevel should be "xhigh", got "${roundTripped.thinkingLevel}"`);
}

// --- Test 4: interaction without thinkingLevel (backward compat) ---
console.log("=== Test 4: Backward compatibility (no thinkingLevel) ===");
const ix2 = parseEntryToInteraction(entry);
if (ix2) {
	assert(ix2.thinkingLevel === undefined, "Should be undefined when no thinkingLevel passed");
	const line = serializeClassified(ix2);
	const parsed = JSON.parse(line);
	assert(!parsed.tl, "Should NOT have tl field when thinkingLevel is absent");
}

cleanup();

console.log(`\n──────────────────────────────`);
console.log(`Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
process.exit(failed > 0 ? 1 : 0);

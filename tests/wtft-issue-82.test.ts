#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/wtft-issue-82.test.ts — Recursive subagent rollup depth test (#82)
 *
 * Verifies that discoverSubagentSessionFiles() recursively walks nested
 * subagent directories up to the Claude Code depth-5 limit.
 *
 * Run: node --experimental-strip-types tests/wtft-issue-82.test.ts
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	discoverSubagentSessionFiles,
	loadSubagentInteractions,
} from "../bin/wtft.mjs";

const tmpDir = path.join(os.tmpdir(), `wtft-82-test-${Math.random().toString(36).substring(2, 11)}`);
fs.mkdirSync(tmpDir, { recursive: true });

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

try {
	// ---
	// TEST 1: Depth-3 recursive subagent tree
	// Parent → subagent (depth 1) → subagent (depth 2) → subagent (depth 3)
	// Expected: discoverSubagentSessionFiles finds all 3 subagent files
	// ---
	console.log("--- TEST 1: Depth-3 recursive subagent discovery ---");

	const sessionId = "deep-parent";
	const parentFile = path.join(tmpDir, `${sessionId}.jsonl`);
	fs.writeFileSync(parentFile, [
		JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-07-01T10:00:00Z", cwd: "/tmp" }),
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: Date.now(), usage: { cost: { total: 1.00 } } } }),
		"",
	].join("\n"));

	// Depth 1: parent/subagents/agent-d1.jsonl
	const d1Dir = path.join(tmpDir, sessionId, "subagents");
	fs.mkdirSync(d1Dir, { recursive: true });
	fs.writeFileSync(path.join(d1Dir, "agent-d1.jsonl"), [
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: Date.now(), usage: { cost: { total: 0.50 } } } }),
		"",
	].join("\n"));

	// Depth 2: parent/subagents/agent-d1/subagents/agent-d2.jsonl
	// (Claude Code nests subagent directories under the agent's own base name)
	const d2Dir = path.join(d1Dir, "agent-d1", "subagents");
	fs.mkdirSync(d2Dir, { recursive: true });
	fs.writeFileSync(path.join(d2Dir, "agent-d2.jsonl"), [
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: Date.now(), usage: { cost: { total: 0.25 } } } }),
		"",
	].join("\n"));

	// Depth 3: parent/subagents/agent-d1/subagents/agent-d2/subagents/agent-d3.jsonl
	const d3Dir = path.join(d2Dir, "agent-d2", "subagents");
	fs.mkdirSync(d3Dir, { recursive: true });
	fs.writeFileSync(path.join(d3Dir, "agent-d3.jsonl"), [
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: Date.now(), usage: { cost: { total: 0.10 } } } }),
		"",
	].join("\n"));

	// Round 6: discovery returns { files, unreadable }; the readable files are
	// what the walk contract is about, and no fixture here is unreadable.
	const { files: discovered } = discoverSubagentSessionFiles(parentFile);
	console.log(`  Discovered: ${discovered.length} subagent files`);
	console.log(`  Files: ${discovered.map(f => path.basename(f)).join(", ")}`);

	check(discovered.length === 3, "finds all 3 nested subagent files (depth 1, 2, 3)");
	check(discovered.some(f => f.includes("agent-d1")), "includes depth-1 subagent");
	check(discovered.some(f => f.includes("agent-d2")), "includes depth-2 subagent");
	check(discovered.some(f => f.includes("agent-d3")), "includes depth-3 subagent");

	// Load and verify total cost
	const interactions = loadSubagentInteractions(discovered);
	const total = interactions.reduce((s: number, i: any) => s + i.cost, 0);
	check(Math.abs(total - 0.85) < 0.001, `total subagent cost = $${total.toFixed(2)} (expected $0.85)`);

	// ---
	// TEST 2: Depth limit enforcement (depth > 5)
	// Create a depth-6 chain and verify it stops at depth 5
	// ---
	console.log("--- TEST 2: Depth-5 limit enforcement ---");

	const deepId = "deep-limit";
	const deepParent = path.join(tmpDir, `${deepId}.jsonl`);
	fs.writeFileSync(deepParent, [
		JSON.stringify({ type: "session", version: 3, id: deepId, timestamp: "2026-07-01T11:00:00Z", cwd: "/tmp" }),
		"",
	].join("\n"));

	// Build a depth-6 chain manually
	let currentDir = path.join(tmpDir, deepId, "subagents");
	let currentName = "agent-chain";
	for (let d = 1; d <= 6; d++) {
		fs.mkdirSync(currentDir, { recursive: true });
		fs.writeFileSync(path.join(currentDir, `${currentName}-d${d}.jsonl`), [
			JSON.stringify({ type: "message", message: { role: "assistant", timestamp: Date.now() + d * 1000, usage: { cost: { total: 0.01 } } } }),
			"",
		].join("\n"));
		currentDir = path.join(currentDir, `${currentName}-d${d}`, "subagents");
	}

	const { files: deepDiscovered } = discoverSubagentSessionFiles(deepParent);
	console.log(`  Discovered: ${deepDiscovered.length} files (depth 6 chain, max depth 5)`);
	// Depth 5 → should find only 5 files (d1-d5), not d6
	check(deepDiscovered.length === 5, "depth-5 limit: finds exactly 5 (not 6) subagent files");

	// ---
	// TEST 3: Mixed flat + nested structure ---
	console.log("--- TEST 3: Mixed flat siblings + nested children ---");

	const mixId = "mix-parent";
	const mixParent = path.join(tmpDir, `${mixId}.jsonl`);
	fs.writeFileSync(mixParent, [
		JSON.stringify({ type: "session", version: 3, id: mixId, timestamp: "2026-07-01T12:00:00Z", cwd: "/tmp" }),
		"",
	].join("\n"));

	const mixSubDir = path.join(tmpDir, mixId, "subagents");
	fs.mkdirSync(mixSubDir, { recursive: true });

	// Sibling A (flat, depth 1)
	fs.writeFileSync(path.join(mixSubDir, "agent-sib-a.jsonl"), [
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: Date.now(), usage: { cost: { total: 0.10 } } } }),
		"",
	].join("\n"));

	// Sibling B (flat, depth 1)
	fs.writeFileSync(path.join(mixSubDir, "agent-sib-b.jsonl"), [
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: Date.now() + 1000, usage: { cost: { total: 0.20 } } } }),
		"",
	].join("\n"));

	// Sibling C has its own sub-subagent (depth 2)
	const sibCDir = path.join(mixSubDir, "agent-sib-c", "subagents");
	fs.mkdirSync(sibCDir, { recursive: true });
	fs.writeFileSync(path.join(mixSubDir, "agent-sib-c.jsonl"), [
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: Date.now() + 2000, usage: { cost: { total: 0.30 } } } }),
		"",
	].join("\n"));
	fs.writeFileSync(path.join(sibCDir, "agent-sib-c-child.jsonl"), [
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: Date.now() + 3000, usage: { cost: { total: 0.05 } } } }),
		"",
	].join("\n"));

	const { files: mixDiscovered } = discoverSubagentSessionFiles(mixParent);
	console.log(`  Discovered: ${mixDiscovered.length} files (expected 4: A, B, C, C-child)`);
	check(mixDiscovered.length === 4, "mixed structure: finds all 4 subagent files (3 siblings + 1 grandchild)");

	const mixInteractions = loadSubagentInteractions(mixDiscovered);
	const mixTotal = mixInteractions.reduce((s: number, i: any) => s + i.cost, 0);
	check(Math.abs(mixTotal - 0.65) < 0.001, `mixed total = $${mixTotal.toFixed(2)} (expected $0.65)`);

} finally {
	try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

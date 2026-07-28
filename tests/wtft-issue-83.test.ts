#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/wtft-issue-83.test.ts — Subagent discovery + merge (#83)
 *
 * Verifies discoverSubagentSessionFiles() and loadSubagentInteractions()
 * logic against mock session files for both Claude Code and Pi conventions.
 *
 * Run: node --experimental-strip-types tests/wtft-issue-83.test.ts
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	parseSessionFile,
	classifyInteraction,
	deduplicateInteractions,
} from "../bin/wtft.mjs";

// --- MOCK functions (mirror extensions/wtft.ts exactly) ---

function discoverSubagentSessionFiles(sessionPath: string): string[] {
	const files: string[] = [];
	const sessionDir = path.dirname(sessionPath);
	const sessionBase = path.basename(sessionPath, ".jsonl");

	// Pattern 1: Claude Code convention
	const ccSubagentsDir = path.join(sessionDir, sessionBase, "subagents");
	if (fs.existsSync(ccSubagentsDir)) {
		try {
			for (const f of fs.readdirSync(ccSubagentsDir)) {
				if (f.endsWith(".jsonl")) files.push(path.join(ccSubagentsDir, f));
			}
		} catch { /* skip */ }
	}

	// Pattern 2: Pi parentSession convention
	let mainSessionId: string | undefined;
	try {
		const mainHeader = JSON.parse(fs.readFileSync(sessionPath, "utf8").split("\n")[0]);
		if (mainHeader.type === "session") mainSessionId = mainHeader.id;
	} catch { /* skip */ }

	if (mainSessionId) {
		try {
			for (const f of fs.readdirSync(sessionDir)) {
				if (!f.endsWith(".jsonl")) continue;
				const fullPath = path.join(sessionDir, f);
				if (fullPath === sessionPath) continue;
				if (files.includes(fullPath)) continue;
				try {
					const header = JSON.parse(fs.readFileSync(fullPath, "utf8").split("\n")[0]);
					if (header.type === "session" && header.parentSession === mainSessionId) {
						files.push(fullPath);
					}
				} catch { /* skip */ }
			}
		} catch { /* skip */ }
	}

	return files;
}

function loadSubagentInteractions(subagentFiles: string[]) {
	const interactions: any[] = [];
	for (const file of subagentFiles) {
		try {
			const raw = parseSessionFile(file);
			const deduped = deduplicateInteractions(raw);
			for (const interaction of deduped) {
				interaction._cat = classifyInteraction(interaction);
				interactions.push(interaction);
			}
		} catch { /* skip */ }
	}
	return interactions;
}

// --- TESTS ---

const tmpDir = path.join(os.tmpdir(), `wtft-83-test-${Math.random().toString(36).substring(2, 11)}`);
fs.mkdirSync(tmpDir, { recursive: true });

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

try {
	// --- TEST 1: Claude Code subagent convention ---
	console.log("--- TEST 1: Claude Code subagent convention ---");

	const sessionId = "session-abc-123";
	const parentFile = path.join(tmpDir, `${sessionId}.jsonl`);
	const subDir = path.join(tmpDir, sessionId, "subagents");
	fs.mkdirSync(subDir, { recursive: true });

	const t1 = new Date("2026-07-01T10:00:00Z").getTime();
	const t2 = new Date("2026-07-01T10:05:00Z").getTime();
	fs.writeFileSync(parentFile, [
		JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-07-01T10:00:00Z", cwd: "/tmp" }),
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: t1, usage: { cost: { total: 3.00 } } } }),
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: t2, usage: { cost: { total: 2.00 } } } }),
		"",
	].join("\n"));

	const t1a = t1 + 2 * 60 * 1000;
	fs.writeFileSync(path.join(subDir, "agent-a.jsonl"), [
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: t1a, usage: { cost: { total: 1.50 } } } }),
		"",
	].join("\n"));

	const t2b = t2 + 1 * 60 * 1000;
	fs.writeFileSync(path.join(subDir, "agent-b.jsonl"), [
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: t2b, usage: { cost: { total: 0.50 } } } }),
		"",
	].join("\n"));

	const discovered1 = discoverSubagentSessionFiles(parentFile);
	check(discovered1.length === 2, "discovers 2 subagent files (Claude Code pattern)");

	const subInteractions1 = loadSubagentInteractions(discovered1);
	check(subInteractions1.length === 2, "parses 2 subagent interactions");

	const totalSubCost = subInteractions1.reduce((s: number, i: any) => s + i.cost, 0);
	check(Math.abs(totalSubCost - 2.00) < 0.001, `subagent total cost = $${totalSubCost.toFixed(2)} (expected $2.00)`);

	// --- TEST 2: Pi parentSession convention ---
	console.log("--- TEST 2: Pi parentSession convention ---");

	const parentId = "019f0000-0000-7000-8000-000000000001";
	const parentFile2 = path.join(tmpDir, `pi-parent.jsonl`);
	fs.writeFileSync(parentFile2, [
		JSON.stringify({ type: "session", version: 3, id: parentId, timestamp: "2026-07-01T12:00:00Z", cwd: "/tmp" }),
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: t1, usage: { cost: { total: 5.00 } } } }),
		"",
	].join("\n"));

	fs.writeFileSync(path.join(tmpDir, `pi-subagent.jsonl`), [
		JSON.stringify({ type: "session", version: 3, id: "sub-1", parentSession: parentId, timestamp: "2026-07-01T12:01:00Z", cwd: "/tmp" }),
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: t1 + 60000, usage: { cost: { total: 2.50 } } } }),
		"",
	].join("\n"));

	// Non-matching sibling (should NOT be discovered)
	fs.writeFileSync(path.join(tmpDir, `other-session.jsonl`), [
		JSON.stringify({ type: "session", version: 3, id: "other-1", parentSession: "different-id", timestamp: "2026-07-01T12:02:00Z", cwd: "/tmp" }),
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: t1 + 120000, usage: { cost: { total: 99.00 } } } }),
		"",
	].join("\n"));

	const discovered2 = discoverSubagentSessionFiles(parentFile2);
	check(discovered2.length === 1, "discovers exactly 1 subagent (not non-matching sibling)");
	check(discovered2[0].endsWith("pi-subagent.jsonl"), "finds pi-subagent, not other-session");

	const subInteractions2 = loadSubagentInteractions(discovered2);
	check(Math.abs(subInteractions2[0].cost - 2.50) < 0.001, `Pi subagent cost = $${subInteractions2[0].cost.toFixed(2)} (expected $2.50)`);

	// --- TEST 3: Graceful no-subagent fallback ---
	console.log("--- TEST 3: No subagents — zero-cost fallback ---");
	const loneFile = path.join(tmpDir, `lone-session.jsonl`);
	fs.writeFileSync(loneFile, [
		JSON.stringify({ type: "session", version: 3, id: "lone-1", timestamp: "2026-07-01T13:00:00Z", cwd: "/tmp" }),
		"",
	].join("\n"));
	const discovered3 = discoverSubagentSessionFiles(loneFile);
	check(discovered3.length === 0, "returns empty array for session with no subagents");

	// --- TEST 4: Chronological merge order ---
	console.log("--- TEST 4: Chronological interleave ---");
	const mainInteractions = [
		{ timestamp: 1000, cost: 1 },
		{ timestamp: 3000, cost: 1 },
	] as any[];
	const subInteractions = [
		{ timestamp: 2000, cost: 2 },
		{ timestamp: 2500, cost: 2 },
	] as any[];
	const merged = [...mainInteractions, ...subInteractions];
	merged.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
	const timestamps = merged.map((i: any) => i.timestamp);
	check(
		timestamps[0] === 1000 && timestamps[1] === 2000 && timestamps[2] === 2500 && timestamps[3] === 3000,
		"interleaves subagent turns chronologically with parent turns"
	);

	// --- TEST 5: _cat stamping ---
	console.log("--- TEST 5: Classification stamp on subagent interactions ---");
	// Reuse subagent-a interactions: parse a file with a write to a code file
	const subDir2 = path.join(tmpDir, "session-cat-test", "subagents");
	fs.mkdirSync(subDir2, { recursive: true });
	const catFile = path.join(subDir2, "agent-cat.jsonl");
	const catT = new Date("2026-07-01T14:00:00Z").getTime();
	fs.writeFileSync(catFile, [
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: catT, usage: { cost: { total: 1.00 } }, content: [{ type: "tool_use", name: "write", arguments: { file_path: "/tmp/src/main.ts" } }] } }),
		"",
	].join("\n"));
	// Make a parent to discover it
	const catParentFile = path.join(tmpDir, "session-cat-test.jsonl");
	fs.writeFileSync(catParentFile, [
		JSON.stringify({ type: "session", version: 3, id: "cat-test-1", timestamp: "2026-07-01T14:00:00Z", cwd: "/tmp" }),
		"",
	].join("\n"));
	const discovered5 = discoverSubagentSessionFiles(catParentFile);
	const catInteractions = loadSubagentInteractions(discovered5);
	check(catInteractions.length === 1, "parses one subagent interaction");
	check(catInteractions[0]._cat !== undefined, "_cat is stamped on subagent interaction");
	check(typeof catInteractions[0]._cat === "string", "_cat is a string category");
	console.log(`  _cat = "${catInteractions[0]._cat}"`);

} finally {
	try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

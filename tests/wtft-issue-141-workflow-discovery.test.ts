#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/wtft-issue-141-workflow-discovery.test.ts — Dynamic Workflow
 * subagent transcript discovery (#141).
 *
 * Workflow transcripts live at <session>/subagents/workflows/wf_<runId>/
 * agent-*.jsonl. The old walkSubagentDir recursion allowlist (subagents/ns/
 * agent-*) never reached them; the walker now recurses into all
 * subdirectories (except our own wtft-tags output) while the agent-*.jsonl
 * file filter still gates collection.
 *
 * Run: node --experimental-strip-types tests/wtft-issue-141-workflow-discovery.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverSubagentSessionFiles } from "../bin/wtft.mjs";

const tmpDir = path.join(os.tmpdir(), `wtft-141-test-${Math.random().toString(36).substring(2, 11)}`);
fs.mkdirSync(tmpDir, { recursive: true });

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

function writeAgentFile(filePath: string, cost: number) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, [
		JSON.stringify({ type: "message", message: { role: "assistant", timestamp: Date.now(), usage: { cost: { total: cost } } } }),
		"",
	].join("\n"));
}

try {
	// ---
	// TEST 1: Workflow transcripts under subagents/workflows/wf_*/ are found
	// ---
	console.log("--- TEST 1: Dynamic Workflow transcript discovery ---");

	const sessionId = "wf-parent";
	const parentFile = path.join(tmpDir, `${sessionId}.jsonl`);
	fs.writeFileSync(parentFile, [
		JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-08-08T10:00:00Z", cwd: "/tmp" }),
		"",
	].join("\n"));

	const subagentsDir = path.join(tmpDir, sessionId, "subagents");
	// Plain Agent-tool transcript (pre-#141 behavior must keep working)
	writeAgentFile(path.join(subagentsDir, "agent-plain.jsonl"), 0.10);
	// Two workflow runs, as in the 2026-08-08 …a578 repro
	writeAgentFile(path.join(subagentsDir, "workflows", "wf_35102db9-a86", "agent-wf1.jsonl"), 0.50);
	writeAgentFile(path.join(subagentsDir, "workflows", "wf_35102db9-a86", "agent-wf2.jsonl"), 0.25);
	writeAgentFile(path.join(subagentsDir, "workflows", "wf_6296aeb7-4c5", "agent-wf3.jsonl"), 0.75);

	// Round 6: discovery returns { files, unreadable }.
	const { files: found } = discoverSubagentSessionFiles(parentFile);
	const names = found.map(f => path.basename(f)).sort();

	check(names.includes("agent-plain.jsonl"), "plain subagents/agent-*.jsonl still discovered");
	check(names.includes("agent-wf1.jsonl"), "workflows/wf_*/agent-wf1.jsonl discovered");
	check(names.includes("agent-wf2.jsonl"), "second transcript in same wf_ run discovered");
	check(names.includes("agent-wf3.jsonl"), "transcript in second wf_ run discovered");
	check(found.length === 4, `exactly 4 transcripts found (got ${found.length})`);

	// ---
	// TEST 2: wtft-tags output dirs are excluded (no double counting)
	// ---
	console.log("--- TEST 2: wtft-tags exclusion ---");

	const tagsDir = path.join(subagentsDir, "wtft-tags");
	fs.mkdirSync(tagsDir, { recursive: true });
	// A tag of an agent transcript matches the agent-*.jsonl file filter by name
	fs.writeFileSync(path.join(tagsDir, "agent-plain.jsonl.wtft-tag.v2.6.0.jsonl"), "{}\n");

	const { files: found2 } = discoverSubagentSessionFiles(parentFile);
	check(found2.length === 4, `tag files not collected as transcripts (got ${found2.length})`);
	check(!found2.some(f => f.includes("wtft-tags")), "no path under wtft-tags/ returned");
} finally {
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

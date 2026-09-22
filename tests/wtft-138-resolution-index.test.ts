#!/usr/bin/env -S bun
/**
 * #138 — one session index per spawn-tree walk.
 * Spec: docs/spec-138-resolution-index.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("138-resolution-index");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-138-")));
const claudeRoot = path.join(dir, "claude-projects");
const piRoot = path.join(dir, "pi-sessions");
fs.mkdirSync(claudeRoot, { recursive: true });
fs.mkdirSync(piRoot, { recursive: true });
// Before the harness modules load, so neither ever sees the real trees.
process.env.WTFT_CLAUDE_PROJECTS_DIR = claudeRoot;
process.env.WTFT_PI_SESSIONS_DIR = piRoot;

const { computeSpawnTree } = await import("../extensions/lib/wtft-spawn-tree.ts");
const { appendSpawnRecord, SPAWN_RECORD_SCHEMA } = await import("../extensions/lib/wtft-spawn-ledger.ts");
const { getDirWalkCount } = await import("../extensions/lib/harness/session-cwd.ts");
const claude = (await import("../extensions/lib/harness/claude-code/discovery.ts")).default;
const pi = (await import("../extensions/lib/harness/pi/discovery.ts")).default;

const PARENT = "b1380000-0000-4000-8000-000000000000";
const uuid = (n: number, prefix = "c138") => `${prefix}${String(n).padStart(4, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

function transcript(file: string, id: string, outputTokens: number): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({
		type: "assistant", timestamp: "2026-09-22T05:00:00.000Z", cwd: "/tmp/x",
		message: { role: "assistant", id: `${id}-m`, model: "claude-opus-5", content: [{ type: "text", text: "x" }],
			usage: { input_tokens: 10, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
	}) + "\n");
}

// A populated tree, so an index has something to walk.
for (let d = 0; d < 20; d++) for (let f = 0; f < 5; f++) {
	const id = uuid(d * 5 + f, "d138");
	transcript(path.join(claudeRoot, `-tmp-proj-${d}`, `${id}.jsonl`), id, 1);
}

function ledgerWith(children: string[]): string {
	const file = path.join(dir, `ledger-${children.length}-${Math.random().toString(36).slice(2)}.jsonl`);
	const lines = children.map(child => JSON.stringify({ schema: SPAWN_RECORD_SCHEMA, ts: "2026-09-22T05:00:00Z", parent: PARENT, child, mechanism: "test" }));
	fs.writeFileSync(file, lines.join("\n") + "\n");
	return file;
}

// ---
// PART C — the Closer: 10,000 distinct edges, under a second
// ---
console.log("\nPART C — 10,000 distinct child edges");
{
	const many = Array.from({ length: 10_000 }, (_, i) => uuid(i));
	const ledgerPath = ledgerWith(many);
	const t0 = performance.now();
	const tree = computeSpawnTree(PARENT, { ledgerPath });
	const ms = performance.now() - t0;
	check(tree.edges.length === 10_000 && tree.unattributed.length === 10_000 && tree.edges.every(e => e.skip === "not-found"),
		`C1 every edge is reported not-found (got ${tree.edges.length} edges, ${tree.unattributed.length} gaps)`);
	check(ms < 1000, `C2 the walk completes in under a second (took ${Math.round(ms)} ms)`);
}

// ---
// PART W — one tree walk per spawn-tree walk, not one per child
// ---
console.log("\nPART W — directory reads do not scale with children");
{
	const one = ledgerWith([uuid(1)]);
	const many = ledgerWith(Array.from({ length: 200 }, (_, i) => uuid(i)));
	let before = getDirWalkCount();
	computeSpawnTree(PARENT, { ledgerPath: one });
	const forOne = getDirWalkCount() - before;
	before = getDirWalkCount();
	computeSpawnTree(PARENT, { ledgerPath: many });
	const forMany = getDirWalkCount() - before;
	check(forOne > 0, `W1 fixture precondition: a walk reads the tree at all (got ${forOne})`);
	check(forMany === forOne, `W2 200 children cost the same directory reads as 1 (got ${forMany} vs ${forOne})`);
}

// ---
// PART R — the same answers as before
// ---
console.log("\nPART R — resolution still finds, prices, and prefers the newest copy");
{
	const child = uuid(7001);
	const stale = path.join(claudeRoot, "-tmp-old", `${child}.jsonl`);
	const fresh = path.join(claudeRoot, "-tmp-new", `${child}.jsonl`);
	transcript(stale, child, 100);
	transcript(fresh, child, 700);
	fs.utimesSync(stale, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
	const tree = computeSpawnTree(PARENT, { ledgerPath: ledgerWith([child]) });
	const edge = tree.edges[0];
	check(edge?.resolved === true && edge.path === fresh && edge.total?.outputTokens === 700,
		`R1 a child in two project dirs resolves to the newer copy and is priced from it (got ${edge?.path === fresh ? "newer" : edge?.path}, ${edge?.total?.outputTokens})`);
}

// ---
// PART S — the index and the single lookup agree, for both built-ins
// ---
console.log("\nPART S — seam agreement");
{
	const piId = "2026-09-22T05-00-00-000Z_01a0c8f6-e348-73da-a2b6-70d7df348f96";
	transcript(path.join(piRoot, "--tmp-pi-a--", `${piId}.jsonl`), piId, 1);
	for (const [name, discovery] of [["claude-code", claude], ["pi", pi]] as const) {
		const index = discovery.indexSessionsById!();
		const ids = [...index.keys()];
		const disagree = ids.filter(id => discovery.resolveSessionById(id) !== index.get(id));
		check(ids.length > 0 && disagree.length === 0,
			`S1 ${name}: resolveSessionById agrees with indexSessionsById on all ${ids.length} ids (disagree: ${disagree.slice(0, 3).join(", ")})`);
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

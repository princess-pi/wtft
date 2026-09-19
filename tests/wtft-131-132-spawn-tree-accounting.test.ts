#!/usr/bin/env -S bun
/**
 * tests/wtft-131-132-spawn-tree-accounting.test.ts — money lands in one bucket, once (#131, #132)
 *
 * `total` is the caller's SELF total, `spawned.total` is the walk's. A session
 * folded into a transcript by the parser is money inside whichever bucket that
 * transcript feeds, and a ledger edge to the same session must add nothing.
 *
 * Part A (#132) — the parser folds `claude -p` children RECURSIVELY, so a
 *   grandchild is inside the root's self total although only the child is named
 *   by the root's own turn. A ledger edge to the grandchild must not bill it a
 *   second time, whichever order the edges sit in.
 * Part B (#131) — a resolved descendant whose parse folds in an id the walk has
 *   not reached: that id's money is in `spawned.total`, so its edge reports
 *   `already-counted`, never `in-self-total` (which means "inside `total`").
 *
 * Every assertion pairs the skip value with the bucket totals, so the two
 * cannot drift apart.
 *
 * Run:  bun tests/wtft-131-132-spawn-tree-accounting.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionFile, collectSelfAttributedSessionIds } from "../extensions/lib/wtft-parser.ts";
import { computeSessionSummary } from "../extensions/lib/wtft-renderer.ts";
import { computeSpawnTree, treeTotals } from "../extensions/lib/wtft-spawn-tree.ts";
import { SPAWN_RECORD_SCHEMA, serializeSpawnRecord, type SpawnRecord } from "../extensions/lib/wtft-spawn-ledger.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("131-132-spawn-tree");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-131-132-")));
const projects = path.join(dir, "projects");
process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;

const T0 = Date.UTC(2026, 8, 18, 5, 0, 0);
const uuid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

function turnLine(id: string, tsMs: number, outputTokens: number, spawnCwd?: string): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso,
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6", timestamp: iso,
			usage: { input_tokens: 1000, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: spawnCwd
				? [{ type: "toolCall", name: "bash", arguments: { command: `cd ${spawnCwd} && claude -p "go"` } }]
				: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

/** A session file under its own cwd's project dir, so the cwd-plus-time
 *  discovery of one session never matches another's file. */
function putSession(id: string, tsMs: number, outputTokens: number, spawnCwd?: string): string {
	const cwd = path.join(dir, `cwd-${id}`);
	const projectDir = path.join(projects, cwd.replace(/\//g, "-"));
	fs.mkdirSync(projectDir, { recursive: true });
	const at = path.join(projectDir, `${id}.jsonl`);
	fs.writeFileSync(at, turnLine(`turn-${id}`, tsMs, outputTokens, spawnCwd));
	return at;
}
const cwdOf = (id: string) => path.join(dir, `cwd-${id}`);

let ledgerSeq = 0;
function ledgerOf(edges: Array<[parent: string, child: string]>): string {
	const at = path.join(dir, `ledger-${ledgerSeq++}.jsonl`);
	const records = edges.map(([parent, child]) => serializeSpawnRecord({
		schema: SPAWN_RECORD_SCHEMA, ts: "2026-09-18T05:00:00Z", parent, child, mechanism: "pr-review-lens",
	} as SpawnRecord));
	fs.writeFileSync(at, records.join("\n") + "\n");
	return at;
}

// ---
// PART A (#132) — a grandchild folded in two levels down is billed once
// ---
console.log("\nPART A — root → claude -p child → grandchild, the grandchild also a ledger edge");

{
	const ROOT = uuid(1), CHILD = uuid(2), GRAND = uuid(3);
	putSession(CHILD, T0 + 2_000, 300, cwdOf(GRAND));
	putSession(GRAND, T0 + 4_000, 700);
	const rootPath = path.join(dir, "root.jsonl");
	fs.writeFileSync(rootPath,
		JSON.stringify({ type: "session", version: 3, id: ROOT, timestamp: new Date(T0).toISOString(), cwd: dir }) + "\n"
		+ turnLine("turn-root", T0, 100, cwdOf(CHILD)));

	const interactions = parseSessionFile(rootPath);
	const self = computeSessionSummary(interactions).total;
	const alreadyAttributed = collectSelfAttributedSessionIds(rootPath, interactions);
	check(self.outputTokens === 1100,
		`A0 fixture precondition: the root's parse folds child AND grandchild in — 100 + 300 + 700 (got ${self.outputTokens})`);
	check(alreadyAttributed.has(CHILD),
		"A0b fixture precondition: the root's own turn names the child");

	const orders: Record<string, Array<[string, string]>> = {
		"root→child, child→grand": [[ROOT, CHILD], [CHILD, GRAND]],
		"child→grand, root→child": [[CHILD, GRAND], [ROOT, CHILD]],
		"root→grand, root→child": [[ROOT, GRAND], [ROOT, CHILD]],
		"root→child, root→grand": [[ROOT, CHILD], [ROOT, GRAND]],
	};
	for (const [name, edges] of Object.entries(orders)) {
		const tree = computeSpawnTree(ROOT, { ledgerPath: ledgerOf(edges), alreadyAttributed });
		const grandEdge = tree.edges.find(e => e.child === GRAND);
		check(tree.total.outputTokens === 0 && grandEdge?.skip === "in-self-total",
			`A1 [${name}] the grandchild adds nothing to the walk and says why: it is inside total (spawned ${tree.total.outputTokens}, skip ${grandEdge?.skip})`);
		check(treeTotals(self, tree).outputTokens === 1100,
			`A2 [${name}] self + spawned is 1100, the grandchild's 700 exactly once (got ${treeTotals(self, tree).outputTokens})`);
	}
}

// ---
// PART B (#131) — an id folded into a resolved descendant is already-counted
// ---
console.log("\nPART B — a descendant's parse folds in an unreached id, which is also a ledger edge");

{
	const ROOT = uuid(11), DESC = uuid(12), FOLDED = uuid(13);
	putSession(DESC, T0 + 2_000, 300, cwdOf(FOLDED));
	putSession(FOLDED, T0 + 4_000, 700);

	for (const [name, edges] of Object.entries({
		"descendant first": [[ROOT, DESC], [ROOT, FOLDED]] as Array<[string, string]>,
		"folded id first": [[ROOT, FOLDED], [ROOT, DESC]] as Array<[string, string]>,
	})) {
		const tree = computeSpawnTree(ROOT, { ledgerPath: ledgerOf(edges) });
		check(tree.total.outputTokens === 1000,
			`B1 [${name}] spawned.total holds the descendant and the folded id once: 300 + 700 (got ${tree.total.outputTokens})`);
		check(!tree.edges.some(e => e.skip === "in-self-total"),
			`B2 [${name}] no edge claims in-self-total — nothing here is inside the caller's total (got ${JSON.stringify(tree.edges.map(e => e.skip ?? "counted"))})`);
	}
	const forward = computeSpawnTree(ROOT, { ledgerPath: ledgerOf([[ROOT, DESC], [ROOT, FOLDED]]) });
	check(forward.edges.find(e => e.child === FOLDED)?.skip === "already-counted",
		`B3 the folded id's edge reports already-counted, which is true: its money is in spawned.total (got ${forward.edges.find(e => e.child === FOLDED)?.skip})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

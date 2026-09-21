#!/usr/bin/env -S bun
/**
 * each folded session is billed once, in the right total (#131, #132)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionFile, collectSelfAttributedSessionIds, discoverSubagentSessionFiles } from "../extensions/lib/wtft-parser.ts";
import { computeSessionSummary } from "../extensions/lib/wtft-renderer.ts";
import { computeSpawnTree, treeTotals } from "../extensions/lib/wtft-spawn-tree.ts";
import { SPAWN_RECORD_SCHEMA, serializeSpawnRecord } from "../extensions/lib/wtft-spawn-ledger.ts";
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
process.env.WTFT_PI_SESSIONS_DIR = path.join(dir, "pi-sessions");
process.env.XDG_CONFIG_HOME = path.join(dir, "config");

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
	}));
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
	const alreadyAttributed = collectSelfAttributedSessionIds([], interactions);
	check(self.outputTokens === 1100,
		`A0 fixture precondition: the root's parse folds child AND grandchild in — 100 + 300 + 700 (got ${self.outputTokens})`);
	check(alreadyAttributed.has(CHILD),
		"A0b fixture precondition: the root's self-attributed set includes the child");

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
	const descPath = putSession(DESC, T0 + 2_000, 300, cwdOf(FOLDED));
	putSession(FOLDED, T0 + 4_000, 700);
	const descAlone = computeSessionSummary(parseSessionFile(descPath)).total.outputTokens;
	check(descAlone === 1000,
		`B0 fixture precondition: the descendant's own parse folds the session in — 300 + 700 (got ${descAlone})`);

	for (const [name, edges] of Object.entries({
		"descendant first": [[ROOT, DESC], [ROOT, FOLDED]] as Array<[string, string]>,
		"folded id first": [[ROOT, FOLDED], [ROOT, DESC]] as Array<[string, string]>,
	})) {
		const tree = computeSpawnTree(ROOT, { ledgerPath: ledgerOf(edges) });
		check(tree.total.outputTokens === 1000,
			`B1 [${name}] spawned.total holds the descendant and the folded id once: 300 + 700 (got ${tree.total.outputTokens})`);
		check(!tree.edges.some(e => e.skip === "in-self-total"),
			`B2 [${name}] no edge claims in-self-total — this walk has no self total to hold the money (got ${JSON.stringify(tree.edges.map(e => e.skip ?? "counted"))})`);
		const descTotal = tree.edges.find(e => e.child === DESC)?.total?.outputTokens;
		const expectedDesc = name === "folded id first" ? 300 : 1000;
		check(descTotal === expectedDesc,
			`B4 [${name}] the descendant's edge carries ${expectedDesc}: ${name === "folded id first" ? "the folded session's 700 was subtracted, having been counted under its own edge" : "its own 300 plus the folded 700"} (got ${descTotal})`);
	}
	const forward = computeSpawnTree(ROOT, { ledgerPath: ledgerOf([[ROOT, DESC], [ROOT, FOLDED]]) });
	check(forward.edges.find(e => e.child === FOLDED)?.skip === "already-counted",
		`B3 the folded id's edge reports already-counted, which is true: its money is in spawned.total (got ${forward.edges.find(e => e.child === FOLDED)?.skip})`);
}

// ---
// PART C — a session the parse did NOT fold in is priced under its own edge
// ---
console.log("\nPART C — a Pi sibling of a descendant is discovered by directory, not folded into the descendant's total");

{
	const ROOT = uuid(21), DESC = uuid(22), SIBLING = uuid(23);
	const cwd = cwdOf(DESC);
	const projectDir = path.join(projects, cwd.replace(/\//g, "-"));
	fs.mkdirSync(projectDir, { recursive: true });
	const header = (id: string, parentSession?: string) =>
		JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(T0).toISOString(), cwd, ...(parentSession ? { parentSession } : {}) }) + "\n";
	const descPath = path.join(projectDir, `${DESC}.jsonl`);
	fs.writeFileSync(descPath, header(DESC) + turnLine("turn-desc", T0 + 2_000, 300));
	fs.writeFileSync(path.join(projectDir, `${SIBLING}.jsonl`), header(SIBLING, DESC) + turnLine("turn-sibling", T0 + 4_000, 700));

	const parsed = parseSessionFile(descPath);
	check(computeSessionSummary(parsed).total.outputTokens === 300 && discoverSubagentSessionFiles(descPath).files.some(f => path.basename(f, ".jsonl") === SIBLING),
		"C0 fixture precondition: discovery names the sibling, but the descendant's total does not contain it");

	for (const [name, edges] of Object.entries({
		"descendant first": [[ROOT, DESC], [ROOT, SIBLING]] as Array<[string, string]>,
		"sibling first": [[ROOT, SIBLING], [ROOT, DESC]] as Array<[string, string]>,
	})) {
		const tree = computeSpawnTree(ROOT, { ledgerPath: ledgerOf(edges) });
		const siblingEdge = tree.edges.find(e => e.child === SIBLING);
		check(tree.total.outputTokens === 1000 && siblingEdge?.resolved === true && tree.unattributed.length === 0,
			`C1 [${name}] the sibling is priced under its own edge and nothing is subtracted from the descendant: 300 + 700 (got ${tree.total.outputTokens}, skip ${siblingEdge?.skip})`);
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

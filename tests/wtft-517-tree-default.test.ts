#!/usr/bin/env -S bun
/**
 * The spawn tree is the default report: computeSpawnTree collects every counted
 * descendant's turns (#517).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionFile, collectSelfAttributedSessionIds, classifyInteraction, type Interaction } from "../extensions/lib/wtft-parser.ts";
import { computeSessionSummary } from "../extensions/lib/wtft-renderer.ts";
import { computeSpawnTree } from "../extensions/lib/wtft-spawn-tree.ts";
import { SPAWN_RECORD_SCHEMA, serializeSpawnRecord } from "../extensions/lib/wtft-spawn-ledger.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("517-tree-default");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-517-")));
const projects = path.join(dir, "projects");
process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
process.env.WTFT_PI_SESSIONS_DIR = path.join(dir, "pi-sessions");
process.env.XDG_CONFIG_HOME = path.join(dir, "config");

const T0 = Date.UTC(2026, 9, 14, 5, 0, 0);
const uuid = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;

function turnLine(id: string, tsMs: number, outputTokens: number, opts: { spawnCwd?: string; write?: string } = {}): string {
	const iso = new Date(tsMs).toISOString();
	const content = opts.spawnCwd
		? [{ type: "toolCall", name: "bash", arguments: { command: `cd ${opts.spawnCwd} && claude -p "go"` } }]
		: opts.write
			? [{ type: "toolCall", name: "write", arguments: { path: opts.write, content: "x" } }]
			: [{ type: "text", text: `turn ${id}` }];
	return JSON.stringify({
		type: "message",
		timestamp: iso,
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6", timestamp: iso,
			usage: { input_tokens: 1000, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content,
		},
	}) + "\n";
}

const cwdOf = (id: string) => path.join(dir, `cwd-${id}`);
function putSession(id: string, lines: string[]): string {
	const projectDir = path.join(projects, cwdOf(id).replace(/\//g, "-"));
	fs.mkdirSync(projectDir, { recursive: true });
	const at = path.join(projectDir, `${id}.jsonl`);
	fs.writeFileSync(at, lines.join(""));
	return at;
}

let ledgerSeq = 0;
function ledgerOf(edges: Array<[parent: string, child: string]>): string {
	const at = path.join(dir, `ledger-${ledgerSeq++}.jsonl`);
	fs.writeFileSync(at, edges.map(([parent, child]) => serializeSpawnRecord({
		schema: SPAWN_RECORD_SCHEMA, ts: "2026-10-14T05:00:00Z", parent, child, mechanism: "pr-review-lens",
	})).join("\n") + "\n");
	return at;
}

const costOf = (turns: Interaction[]) => computeSessionSummary(turns).total.costUsd;

console.log("\nPART A — a counted descendant's turns are collected, each at its own time and category");
{
	const ROOT = uuid(1), CHILD = uuid(2);
	const childPath = putSession(CHILD, [
		turnLine("c1", T0 + 60_000, 200, { write: "docs/spec-x.md" }),
		turnLine("c2", T0 + 3_600_000, 400, { write: "src/x.ts" }),
	]);
	const collect = { turns: [] as Interaction[], files: [] as string[] };
	const tree = computeSpawnTree(ROOT, { ledgerPath: ledgerOf([[ROOT, CHILD]]), collect });
	check(tree.descendants === 1, `A0 fixture precondition: the child is counted (descendants ${tree.descendants})`);
	check(collect.turns.length === 2, `A1 both child turns are collected (got ${collect.turns.length})`);
	check(close(costOf(collect.turns), tree.total.costUsd) && tree.total.costUsd > 0,
		`A2 the collected turns sum to tree.total (${costOf(collect.turns)} vs ${tree.total.costUsd})`);
	check(collect.turns.map(t => t.timestamp).sort().join() === [T0 + 60_000, T0 + 3_600_000].join(),
		"A3 each turn keeps its own timestamp");
	check(collect.turns.map(t => classifyInteraction(t)).sort().join() === "code,spec",
		`A4 each turn is classified by the self classifier (got ${collect.turns.map(t => classifyInteraction(t)).join()})`);
	check(collect.files.includes(childPath), "A5 the child's transcript is in collect.files");
}

console.log("\nPART B — a child already inside self contributes no turns");
{
	const ROOT = uuid(11), CHILD = uuid(12);
	putSession(CHILD, [turnLine("c", T0, 300)]);
	const collect = { turns: [] as Interaction[], files: [] as string[] };
	const tree = computeSpawnTree(ROOT, { ledgerPath: ledgerOf([[ROOT, CHILD]]), alreadyAttributed: new Set([CHILD]), collect });
	check(tree.edges[0]?.skip === "in-self-total", `B0 fixture precondition: the edge is in-self-total (got ${tree.edges[0]?.skip})`);
	check(collect.turns.length === 0 && collect.files.length === 0, `B1 nothing is collected (turns ${collect.turns.length}, files ${collect.files.length})`);
}

console.log("\nPART C — a fold share already counted comes out of the turn that carries it");
{
	const ROOT = uuid(21), DESC = uuid(22), FOLDED = uuid(23);
	const descPath = putSession(DESC, [turnLine("d", T0 + 2_000, 300, { spawnCwd: cwdOf(FOLDED) })]);
	putSession(FOLDED, [turnLine("f", T0 + 4_000, 700)]);
	check(computeSessionSummary(parseSessionFile(descPath)).total.outputTokens === 1000,
		"C0 fixture precondition: the descendant's parse folds the session in — 300 + 700");
	const collect = { turns: [] as Interaction[], files: [] as string[] };
	const tree = computeSpawnTree(ROOT, { ledgerPath: ledgerOf([[ROOT, FOLDED], [ROOT, DESC]]), collect });
	check(tree.total.outputTokens === 1000, `C1 fixture precondition: the tree holds 300 + 700 once (got ${tree.total.outputTokens})`);
	const out = computeSessionSummary(collect.turns).total;
	check(out.outputTokens === 1000, `C2 the collected turns hold 300 + 700 once (got ${out.outputTokens})`);
	check(close(out.costUsd, tree.total.costUsd), `C3 their cost equals tree.total (${out.costUsd} vs ${tree.total.costUsd})`);
}

console.log("\nPART D — the root's own folds stay self's");
{
	const ROOT = uuid(31), CHILD = uuid(32);
	putSession(CHILD, [turnLine("c", T0 + 2_000, 300)]);
	const rootPath = path.join(dir, "root-d.jsonl");
	fs.writeFileSync(rootPath, JSON.stringify({ type: "session", version: 3, id: ROOT, timestamp: new Date(T0).toISOString(), cwd: dir }) + "\n"
		+ turnLine("r", T0, 100, { spawnCwd: cwdOf(CHILD) }));
	const self = parseSessionFile(rootPath);
	const collect = { turns: [] as Interaction[], files: [] as string[] };
	computeSpawnTree(ROOT, { ledgerPath: ledgerOf([[ROOT, CHILD]]), alreadyAttributed: collectSelfAttributedSessionIds([], self), collect });
	check(computeSessionSummary([...self, ...collect.turns]).total.outputTokens === 400,
		`D1 self plus collected turns count the folded child once (got ${computeSessionSummary([...self, ...collect.turns]).total.outputTokens})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

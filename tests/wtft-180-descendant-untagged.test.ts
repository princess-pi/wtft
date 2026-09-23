#!/usr/bin/env -S bun
/**
 * A counted descendant's untagged turns are named, never a silent $0.00
 * (#180 item 7, `descendantUntagged`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeSpawnTree, SPAWN_TREE_SCHEMA } from "../extensions/lib/wtft-spawn-tree.ts";
import { SPAWN_RECORD_SCHEMA, serializeSpawnRecord } from "../extensions/lib/wtft-spawn-ledger.ts";
import { emptyTotals, renderSpawnTree } from "../extensions/lib/wtft-renderer.ts";
import { buildSessionJson, WTFT_JSON_SCHEMA } from "../extensions/lib/wtft-json.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("180-descendant-untagged");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-180-")));
const projects = path.join(dir, "projects");
process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
process.env.WTFT_PI_SESSIONS_DIR = path.join(dir, "pi-sessions");
process.env.XDG_CONFIG_HOME = path.join(dir, "config");

const T0 = Date.UTC(2026, 8, 23, 5, 0, 0);
const uuid = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** `model: null` writes a turn with no model id — an untagged turn. `cost` is
 *  the harness-native cost, which is how an untagged turn carries money. */
function turn(id: string, tsMs: number, model: string | null, outputTokens: number, cost?: number, inputTokens = 1000): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso,
		message: {
			role: "assistant", id, timestamp: iso,
			...(model !== null ? { model } : {}),
			usage: {
				input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
				...(cost !== undefined ? { cost: { total: cost } } : {}),
			},
			content: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

function putSession(id: string, lines: string): void {
	const projectDir = path.join(projects, `-cwd-${id}`);
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), lines);
}

const ROOT = uuid(1), ALL_UNTAGGED = uuid(2), MIXED = uuid(3), TAGGED = uuid(4);
putSession(ALL_UNTAGGED, turn("u-1", T0 + 1_000, "<synthetic>", 0, undefined, 0));
putSession(MIXED, turn("m-1", T0 + 2_000, "claude-sonnet-4-6", 300) + turn("m-2", T0 + 3_000, null, 50, 0.25));
putSession(TAGGED, turn("t-1", T0 + 4_000, "claude-sonnet-4-6", 400));

const ledgerPath = path.join(dir, "ledger.jsonl");
fs.writeFileSync(ledgerPath, [ALL_UNTAGGED, MIXED, TAGGED].map(child => serializeSpawnRecord({
	schema: SPAWN_RECORD_SCHEMA, ts: "2026-09-23T05:00:00Z", parent: ROOT, child, mechanism: "pr-review-lens",
})).join("\n") + "\n");

const tree = computeSpawnTree(ROOT, { ledgerPath, alreadyAttributed: new Set() });
const edgeOf = (child: string) => tree.edges.find(e => e.child === child);

// ---
// Fixture preconditions — the three children are counted, and the untagged
// money really is outside their edge totals.
// ---
console.log("\nPRECONDITIONS");
check(tree.descendants === 3, `P1 all three children are counted descendants (got ${tree.descendants})`);
check(edgeOf(ALL_UNTAGGED)?.total?.costUsd === 0 && edgeOf(ALL_UNTAGGED)?.total?.outputTokens === 0,
	`P2 the all-untagged child's edge total is $0 — the silent zero this change names (got ${JSON.stringify(edgeOf(ALL_UNTAGGED)?.total)})`);
check((edgeOf(MIXED)?.total?.costUsd ?? 0) > 0 && edgeOf(MIXED)?.total?.outputTokens === 300,
	`P3 the mixed child's edge total holds its tagged turn only (got ${JSON.stringify(edgeOf(MIXED)?.total)})`);

// ---
// D — the floor condition
// ---
console.log("\nD — descendantUntagged");
check(tree.schema === SPAWN_TREE_SCHEMA && SPAWN_TREE_SCHEMA === "wtft/spawn-tree@4",
	`D1 the tree schema is wtft/spawn-tree@4 (got ${tree.schema})`);
const listed = (tree as any).descendantUntagged as Array<{ child: string; untaggedInteractions: number; untaggedCostUsd: number }> | undefined;
check(Array.isArray(listed), `D2 descendantUntagged is always an array (got ${JSON.stringify(listed)})`);
const byChild = new Map((listed ?? []).map(e => [e.child, e]));
check(byChild.get(ALL_UNTAGGED)?.untaggedInteractions === 1 && byChild.get(ALL_UNTAGGED)?.untaggedCostUsd === 0,
	`D3 the all-untagged child is listed with one turn and $0 (got ${JSON.stringify(byChild.get(ALL_UNTAGGED))})`);
check(byChild.get(MIXED)?.untaggedInteractions === 1 && Math.abs((byChild.get(MIXED)?.untaggedCostUsd ?? 0) - 0.25) < 1e-9,
	`D4 the mixed child is listed with its one untagged turn and its $0.25 (got ${JSON.stringify(byChild.get(MIXED))})`);
check(!byChild.has(TAGGED), "D5 a tagged-only child is not listed");
check(Object.keys(byChild.get(MIXED) ?? {}).sort().join(",") === "child,untaggedCostUsd,untaggedInteractions",
	`D6 each entry carries exactly child, untaggedInteractions, untaggedCostUsd (got ${Object.keys(byChild.get(MIXED) ?? {}).join(",")})`);

const edgeSum = tree.edges.reduce((sum, e) => sum + (e.total?.costUsd ?? 0), 0);
check((edgeOf(MIXED)?.total?.costUsd ?? 1) < 0.25,
	`D7 the mixed child's edge total leaves out its untagged $0.25 (got ${edgeOf(MIXED)?.total?.costUsd})`);
check(Math.abs(tree.total.costUsd - edgeSum) < 1e-9 && tree.total.costUsd < 0.25,
	`D7b spawned.total is the sum of the edge totals, and holds none of the $0.25 (total ${tree.total.costUsd}, edges ${edgeSum})`);

const empty = computeSpawnTree(uuid(9), { ledgerPath, alreadyAttributed: new Set() });
check(Array.isArray((empty as any).descendantUntagged) && (empty as any).descendantUntagged.length === 0,
	"D8 a session with no edges carries an empty list, not an absent key");

// ---
// R — the render line
// ---
console.log("\nR — --tokens");
const self = emptyTotals();
const rendered = renderSpawnTree(self, tree);
check(/2 descendant\(s\) with untagged turns — \$0\.25 left out of their edge totals \(#180\)/.test(rendered),
	`R1 SPAWNED names the untagged descendants and their cost:\n${rendered}`);
const taggedOnly = computeSpawnTree(ROOT, {
	ledgerPath: (() => {
		const p = path.join(dir, "ledger-tagged.jsonl");
		fs.writeFileSync(p, serializeSpawnRecord({ schema: SPAWN_RECORD_SCHEMA, ts: "2026-09-23T05:00:00Z", parent: ROOT, child: TAGGED, mechanism: "m" }) + "\n");
		return p;
	})(),
	alreadyAttributed: new Set(),
});
check(!/untagged turns/.test(renderSpawnTree(self, taggedOnly)), "R2 no line when no descendant has untagged turns");

// ---
// J — the session document
// ---
console.log("\nJ — --json");
const doc = buildSessionJson({
	interactions: [],
	session: { path: "/x.jsonl", harness: null, taggerVersion: "0", tagPath: "/x.tag" },
	provisional: { provisional: false } as any,
	uncounted: { webFetchRequests: 0 } as any,
	spawned: tree,
});
check(doc.schema === WTFT_JSON_SCHEMA && WTFT_JSON_SCHEMA === "wtft/session@8",
	`J1 the session schema is wtft/session@8 (got ${doc.schema})`);
check(Array.isArray((doc.spawned as any).descendantUntagged) && (doc.spawned as any).descendantUntagged.length === 2,
	"J2 spawned.descendantUntagged reaches the document");
check(Math.abs(doc.tree.costUsd - edgeSum) < 1e-9 && doc.tree.costUsd < 0.25,
	`J3 tree is the counted edges alone, none of the untagged $0.25 (tree ${doc.tree.costUsd}, edges ${edgeSum})`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

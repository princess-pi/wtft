#!/usr/bin/env -S bun
/**
 * Spend the spawn tree walked past, or priced as $0.
 * Spec: docs/spec-230-231-232-spawn-tree-gaps.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionFile, parseSessionFileStrict, discoverSubagentSessionFiles } from "../extensions/lib/wtft-parser.ts";
import { computeSessionSummary } from "../extensions/lib/wtft-renderer.ts";
import { computeSpawnTree } from "../extensions/lib/wtft-spawn-tree.ts";
import { IDLE_THRESHOLD_MS } from "../extensions/lib/wtft-daemon-lib.ts";
import { SPAWN_RECORD_SCHEMA, serializeSpawnRecord } from "../extensions/lib/wtft-spawn-ledger.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("230-231-232-spawn-tree-gaps");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-230-")));
const projects = path.join(dir, "projects");
process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
process.env.WTFT_PI_SESSIONS_DIR = path.join(dir, "pi-sessions");
process.env.XDG_CONFIG_HOME = path.join(dir, "config");

const T0 = Date.UTC(2026, 8, 23, 6, 0, 0);
const uuid = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;

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

const cwdOf = (id: string) => path.join(dir, `cwd-${id}`);
const projectDirOf = (id: string) => path.join(projects, cwdOf(id).replace(/\//g, "-"));

/** A session file under its own cwd's project dir, so the cwd-plus-time
 *  discovery of one session never matches another's file. */
function putSession(id: string, content: string): string {
	fs.mkdirSync(projectDirOf(id), { recursive: true });
	const at = path.join(projectDirOf(id), `${id}.jsonl`);
	fs.writeFileSync(at, content);
	return at;
}

/** A Claude Code Task subagent transcript under `<session>/subagents/`. */
function putSubagent(sessionId: string, agentId: string, content: string): string {
	const subDir = path.join(projectDirOf(sessionId), sessionId, "subagents");
	fs.mkdirSync(subDir, { recursive: true });
	const at = path.join(subDir, `agent-${agentId}.jsonl`);
	fs.writeFileSync(at, content);
	return at;
}

let ledgerSeq = 0;
function ledgerOf(edges: Array<[parent: string, child: string]>): string {
	const at = path.join(dir, `ledger-${ledgerSeq++}.jsonl`);
	fs.writeFileSync(at, edges.map(([parent, child]) => serializeSpawnRecord({
		schema: SPAWN_RECORD_SCHEMA, ts: "2026-09-23T06:00:00Z", parent, child, mechanism: "pr-review-lens",
	})).join("\n") + "\n");
	return at;
}

const GARBAGE = "{not json\n{\"truncated\": \n]]]\n";

// ---
// A descendant is priced with its Task subagents
// ---
console.log("\n#230 — a launcher descendant's Task subagents are in its edge total");

{
	const S = uuid(1), C = uuid(2);
	const cFile = putSession(C, turnLine("c-1", T0 + 1_000, 100));
	putSubagent(C, "a1", turnLine("c-sub-1", T0 + 2_000, 500));
	check(discoverSubagentSessionFiles(cFile).files.length === 1,
		"H0 fixture precondition: discovery lists C's one Task subagent transcript");
	check(computeSessionSummary(parseSessionFile(cFile)).total.outputTokens === 100,
		"H0b fixture precondition: C's own parse holds only its own 100 output tokens");

	const tree = computeSpawnTree(S, { ledgerPath: ledgerOf([[S, C]]), alreadyAttributed: new Set() });
	const edge = tree.edges.find(e => e.child === C);
	check(edge?.resolved === true && edge.total?.outputTokens === 600,
		`H1 the edge's total is C's 100 plus its subagent's 500 (got ${JSON.stringify(edge?.total?.outputTokens)})`);
	check(tree.total.outputTokens === 600 && tree.descendants === 1,
		`H2 spawned.total carries the 600, and C is one descendant (got ${tree.total.outputTokens}, ${tree.descendants})`);
	check(tree.unattributed.length === 0, "H3 nothing is unattributed");
}

{
	const S = uuid(11), C = uuid(12), C2 = uuid(13);
	putSession(C, turnLine("c-11", T0 + 1_000, 100));
	putSubagent(C, "ok", turnLine("c-sub-ok", T0 + 2_000, 500));
	putSubagent(C, "bad", GARBAGE);
	const tree = computeSpawnTree(S, { ledgerPath: ledgerOf([[S, C]]), alreadyAttributed: new Set() });
	const edge = tree.edges.find(e => e.child === C);
	check(edge?.resolved === false && edge.skip === "unreadable" && edge.total === null,
		`H4 a subagent transcript with no parseable line makes the whole edge unreadable, total null (got ${JSON.stringify({ skip: edge?.skip, total: edge?.total })})`);
	check(tree.unattributed.some(g => g.child === C && g.reason === "unreadable") && tree.total.outputTokens === 0,
		`H5 unattributed names C as unreadable, and none of its readable part is in total (got ${JSON.stringify(tree.unattributed)}, ${tree.total.outputTokens})`);

	putSession(C2, turnLine("c-13", T0 + 1_000, 100));
	const locked = putSubagent(C2, "locked", turnLine("c-sub-locked", T0 + 2_000, 500));
	fs.chmodSync(locked, 0o000);
	let readable = true;
	try { fs.readFileSync(locked); } catch { readable = false; }
	if (readable) {
		console.log("  ⏭  H6 skipped: this user can read a mode-000 file");
	} else {
		const lockedTree = computeSpawnTree(S, { ledgerPath: ledgerOf([[S, C2]]), alreadyAttributed: new Set() });
		const lockedEdge = lockedTree.edges.find(e => e.child === C2);
		check(lockedEdge?.skip === "unreadable" && lockedEdge.total === null,
			`H6 a subagent transcript that cannot be opened makes the edge unreadable (got ${JSON.stringify({ skip: lockedEdge?.skip, total: lockedEdge?.total })})`);
	}
	fs.chmodSync(locked, 0o644);
}

{
	const S = uuid(21), QUIET = uuid(22), BUSY = uuid(23);
	const now = Date.now();
	const quietFile = putSession(QUIET, turnLine("q-1", T0, 100));
	const busyFile = putSession(BUSY, turnLine("b-1", T0, 100));
	const old = (now - 10 * IDLE_THRESHOLD_MS) / 1000;
	fs.utimesSync(quietFile, old, old);
	fs.utimesSync(busyFile, old, old);
	putSubagent(BUSY, "live", turnLine("b-sub", T0 + 1_000, 50));
	const tree = computeSpawnTree(S, { ledgerPath: ledgerOf([[S, QUIET], [S, BUSY]]), alreadyAttributed: new Set(), now });
	check(tree.edges.find(e => e.child === QUIET)?.live === false,
		"H7 fixture precondition: a child whose files are all old is not live");
	check(tree.edges.find(e => e.child === BUSY)?.live === true,
		"H8 a child whose own transcript is old but whose subagent was just written is live");
}

{
	const S = uuid(81), C = uuid(82), F = uuid(83);
	const cFile = putSession(C, turnLine("c-81", T0 + 1_000, 300, cwdOf(F)));
	const subFile = putSubagent(C, "twin", turnLine("c-sub-81", T0 + 1_500, 50, cwdOf(F)));
	putSession(F, turnLine("f-81", T0 + 2_000, 200));
	check(computeSessionSummary(parseSessionFile(cFile)).total.outputTokens === 500
		&& computeSessionSummary(parseSessionFile(subFile)).total.outputTokens === 250,
		"H9 fixture precondition: C's transcript and its subagent each fold F on their own");
	const tree = computeSpawnTree(S, { ledgerPath: ledgerOf([[S, C]]), alreadyAttributed: new Set() });
	check(tree.edges.find(e => e.child === C)?.total?.outputTokens === 550,
		`H10 two parts of one descendant that fold the same session bill it once: 300 + 50 + 200 (got ${tree.edges.find(e => e.child === C)?.total?.outputTokens})`);
}

{
	const S = uuid(91), D = uuid(92), X = uuid(93), Y = uuid(94);
	const header = (id: string, parentSession?: string) =>
		JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(T0).toISOString(), cwd: cwdOf(D), ...(parentSession ? { parentSession } : {}) }) + "\n";
	putSession(D, header(D) + turnLine("d-91", T0 + 1_000, 300));
	fs.writeFileSync(path.join(projectDirOf(D), `${X}.jsonl`), header(X, D) + turnLine("x-91", T0 + 2_000, 700));
	fs.writeFileSync(path.join(projectDirOf(D), `${Y}.jsonl`), header(Y, X) + turnLine("y-91", T0 + 3_000, 40));
	const listed = discoverSubagentSessionFiles(path.join(projectDirOf(D), `${D}.jsonl`)).files.map(f => path.basename(f, ".jsonl"));
	check(listed.includes(X) && !listed.includes(Y),
		`H11a fixture precondition: D's own discovery lists X but not X's sibling Y (got ${JSON.stringify(listed)})`);
	for (const [name, edges] of Object.entries({
		"descendant first": [[S, D], [S, X]] as Array<[string, string]>,
		"sibling first": [[S, X], [S, D]] as Array<[string, string]>,
	})) {
		const tree = computeSpawnTree(S, { ledgerPath: ledgerOf(edges), alreadyAttributed: new Set() });
		check(tree.total.outputTokens === 1040 && tree.unattributed.length === 0,
			`H11 [${name}] a Pi sibling's own sibling is priced once, whichever edge is reached first: 300 + 700 + 40 (got ${tree.total.outputTokens})`);
	}
}

// ---
// Ledger children of a session already inside a total are walked
// ---
console.log("\n#231 — ledger children of in-self and folded sessions are walked");

{
	const S = uuid(31), P = uuid(32), G = uuid(33);
	putSession(G, turnLine("g-1", T0 + 3_000, 700));
	const tree = computeSpawnTree(S, { ledgerPath: ledgerOf([[P, G]]), alreadyAttributed: new Set([P]) });
	const edge = tree.edges.find(e => e.child === G);
	check(edge?.resolved === true && edge.total?.outputTokens === 700 && edge.parent === P,
		`I1 S has no edge; P is in-self; P → G is walked and G counted (got ${JSON.stringify(edge ?? null)})`);
	check(edge?.depth === 2, `I2 G sits at depth 2, one below the in-self P (got ${edge?.depth})`);
	check(tree.total.outputTokens === 700 && tree.descendants === 1,
		`I3 G's 700 is in spawned.total (got ${tree.total.outputTokens}, ${tree.descendants})`);

	let calls = 0;
	const thunk = () => { calls++; return new Set([P]); };
	const viaThunk = computeSpawnTree(S, { ledgerPath: ledgerOf([[P, G]]), alreadyAttributed: thunk });
	check(calls === 1 && viaThunk.total.outputTokens === 700,
		`I4 a thunk is called once when only an in-self id has edges, and its ids are walked (got calls=${calls}, ${viaThunk.total.outputTokens})`);

	const capped = computeSpawnTree(S, { ledgerPath: ledgerOf([[P, G]]), alreadyAttributed: new Set([P]), maxDepth: 1 });
	check(capped.depthCapped === 1 && capped.total.outputTokens === 0,
		`I5 with maxDepth 1, G is depth-capped, not dropped silently (got capped=${capped.depthCapped})`);
}

{
	const S = uuid(41), D = uuid(42), F = uuid(43), G = uuid(44);
	const dFile = putSession(D, turnLine("d-1", T0 + 1_000, 300, cwdOf(F)));
	putSession(F, turnLine("f-1", T0 + 2_000, 200));
	putSession(G, turnLine("g-41", T0 + 3_000, 700));
	check(computeSessionSummary(parseSessionFile(dFile)).total.outputTokens === 500,
		"I6 fixture precondition: D's parse folds F in — 300 + 200");
	const tree = computeSpawnTree(S, { ledgerPath: ledgerOf([[S, D], [F, G]]), alreadyAttributed: new Set() });
	const edge = tree.edges.find(e => e.child === G);
	check(edge?.resolved === true && edge.total?.outputTokens === 700 && edge.parent === F,
		`I7 F folded by D; F → G is walked and G counted (got ${JSON.stringify(edge ?? null)})`);
	check(edge?.depth === 3, `I8 G sits at depth 3, one below F, which sits where D's own children would (got ${edge?.depth})`);
	check(tree.total.outputTokens === 1200 && tree.descendants === 2,
		`I9 spawned.total is D's 500 (F folded in) plus G's 700 (got ${tree.total.outputTokens}, ${tree.descendants})`);
}

{
	const S = uuid(71), D = uuid(72), F = uuid(73), G = uuid(74);
	putSession(D, turnLine("d-71", T0 + 1_000, 300, cwdOf(F)));
	putSession(F, turnLine("f-71", T0 + 2_000, 200));
	putSession(G, turnLine("g-71", T0 + 3_000, 700));
	// D folds F while level 1 is walked, which queues F two levels down; the
	// later edge S → F puts F at depth 1, so F's own edge F → G sits at depth 2.
	const tree = computeSpawnTree(S, { ledgerPath: ledgerOf([[S, D], [S, F], [F, G]]), alreadyAttributed: new Set(), maxDepth: 2 });
	check(tree.edges.find(e => e.child === F)?.skip === "already-counted",
		"I11 fixture precondition: S → F reads already-counted, F having been folded by D first");
	const edge = tree.edges.find(e => e.child === G);
	check(edge?.resolved === true && edge.depth === 2 && tree.depthCapped === 0,
		`I12 a folded session reached later by a shallower edge has its children at the shallower depth (got ${JSON.stringify({ depth: edge?.depth, skip: edge?.skip, capped: tree.depthCapped })})`);
}

{
	const S = uuid(51);
	let calls = 0;
	const empty = path.join(dir, "empty-ledger.jsonl");
	fs.writeFileSync(empty, "");
	computeSpawnTree(S, { ledgerPath: empty, alreadyAttributed: () => { calls++; return new Set(); } });
	check(calls === 0, `I10 a ledger with no edges at all never calls the thunk (got calls=${calls})`);
}

// ---
// A transcript with no parseable line is unreadable, not $0
// ---
console.log("\n#232 — a descendant transcript with no parseable line");

{
	const S = uuid(61), C = uuid(62), EMPTY = uuid(63);
	const cFile = putSession(C, GARBAGE);
	putSession(EMPTY, "");
	check(parseSessionFile(cFile).length === 0, "J0 fixture precondition: the lenient parse reads the garbage file as []");
	let threw = false;
	try { parseSessionFileStrict(cFile); } catch { threw = true; }
	check(threw, "J1 parseSessionFileStrict throws on a file with lines and none that parse");
	const blank = path.join(dir, "blank.jsonl");
	fs.writeFileSync(blank, "\n\n  \n");
	let blankOut: unknown = null;
	try { blankOut = parseSessionFileStrict(blank); } catch (err) { blankOut = err; }
	check(Array.isArray(blankOut) && blankOut.length === 0, `J2 blank lines only is an empty session, not an error (got ${String(blankOut)})`);

	const tree = computeSpawnTree(S, { ledgerPath: ledgerOf([[S, C], [S, EMPTY]]), alreadyAttributed: new Set() });
	const edge = tree.edges.find(e => e.child === C);
	check(edge?.resolved === false && edge.skip === "unreadable" && edge.total === null && edge.path === cFile,
		`J3 the edge is unreadable, total null, with the path that failed (got ${JSON.stringify(edge ?? null)})`);
	check(tree.unattributed.some(g => g.child === C && g.reason === "unreadable"),
		`J4 unattributed names C as unreadable (got ${JSON.stringify(tree.unattributed)})`);
	const FLUSHING = uuid(64);
	putSession(FLUSHING, turnLine("fl-1", T0, 100).slice(0, 40));
	const flushing = computeSpawnTree(S, { ledgerPath: ledgerOf([[S, FLUSHING]]), alreadyAttributed: new Set() }).edges[0];
	check(flushing?.resolved === true && flushing.total?.costUsd === 0 && flushing.live === true,
		`J6 a first line still being written (no newline yet) is a live $0 edge, not unreadable (got ${JSON.stringify(flushing ?? null)})`);
	const emptyEdge = tree.edges.find(e => e.child === EMPTY);
	check(emptyEdge?.resolved === true && emptyEdge.total?.costUsd === 0 && tree.descendants === 1,
		`J5 an empty transcript is still a counted $0 edge (got ${JSON.stringify(emptyEdge ?? null)}, descendants ${tree.descendants})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

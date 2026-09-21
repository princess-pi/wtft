#!/usr/bin/env -S bun
/**
 * the daemon records what it folded, and the spawn walk reads that record (#178, #135 A, #180)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parseSessionFile } from "../extensions/lib/wtft-parser.ts";
import { readTagFileWithVerdict, WTFT_TAGGER_VERSION } from "../extensions/lib/wtft-daemon-lib.ts";
import { computeSpawnTree } from "../extensions/lib/wtft-spawn-tree.ts";
import { SPAWN_RECORD_SCHEMA, serializeSpawnRecord } from "../extensions/lib/wtft-spawn-ledger.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("178-fold-records");

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-178-")));
const projects = path.join(dir, "projects");
process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
process.env.WTFT_PI_SESSIONS_DIR = path.join(dir, "pi-sessions");
process.env.XDG_CONFIG_HOME = path.join(dir, "config");

const T0 = Date.UTC(2026, 8, 18, 5, 0, 0);
const uuid = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;

function turnLine(id: string, tsMs: number, outputTokens: number, spawnCwd?: string, model = "claude-sonnet-4-6"): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso,
		message: {
			role: "assistant", id, model, timestamp: iso,
			usage: { input_tokens: 1000, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: spawnCwd
				? [{ type: "toolCall", name: "bash", arguments: { command: `cd ${spawnCwd} && claude -p "go"` } }]
				: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

const cwdOf = (id: string) => path.join(dir, `cwd-${id}`);
/** A session file under its own cwd's project dir, so one session's cwd-plus-time discovery never matches another's file. */
function putSession(id: string, tsMs: number, outputTokens: number, spawnCwd?: string, model?: string): string {
	const projectDir = path.join(projects, cwdOf(id).replace(/\//g, "-"));
	fs.mkdirSync(projectDir, { recursive: true });
	const at = path.join(projectDir, `${id}.jsonl`);
	fs.writeFileSync(at, turnLine(`turn-${id}`, tsMs, outputTokens, spawnCwd, model));
	return at;
}

type Fold = { id: string; share: { outputTokens: number; inputTokens: number; costUsd: number } };
const foldsOf = (interactions: unknown[]): Fold[] =>
	interactions.flatMap(i => ((i as { claudeSubAgentFolds?: Fold[] }).claudeSubAgentFolds ?? []));

// ---
// PART P — the parser carries every folded session and its own share
// ---
console.log("\nPART P — root → claude -p child → grandchild: one fold list, own shares");

{
	const ROOT = uuid(1), CHILD = uuid(2), GRAND = uuid(3);
	putSession(CHILD, T0 + 2_000, 300, cwdOf(GRAND));
	putSession(GRAND, T0 + 4_000, 700);
	const rootPath = path.join(dir, `${ROOT}.jsonl`);
	fs.writeFileSync(rootPath, turnLine("turn-root", T0, 100, cwdOf(CHILD)));

	const parsed = parseSessionFile(rootPath);
	const folds = foldsOf(parsed);
	const byId = new Map(folds.map(f => [f.id, f.share]));
	check(folds.length === 2 && byId.has(CHILD) && byId.has(GRAND),
		`P1 the spawning turn lists the child AND the grandchild (got ${JSON.stringify(folds.map(f => f.id))})`);
	check(byId.get(GRAND)?.outputTokens === 700 && byId.get(CHILD)?.outputTokens === 300,
		`P2 each share is that session's own turns: child 300, grandchild 700 (got ${byId.get(CHILD)?.outputTokens}, ${byId.get(GRAND)?.outputTokens})`);
	const spawner = parsed.find(i => foldsOf([i]).length > 0)!;
	const shareSum = folds.reduce((n, f) => n + f.share.outputTokens, 0);
	check(spawner.outputTokens - 100 === shareSum,
		`P3 the shares sum to exactly what the fold added to the turn (added ${spawner.outputTokens - 100}, shares ${shareSum})`);
}

// ---
// PART R — the reader returns the fold records from the same read
// ---
console.log("\nPART R — readTagFileWithVerdict returns `folded`");

{
	const tagsDir = path.join(dir, "r", "wtft-tags");
	fs.mkdirSync(tagsDir, { recursive: true });
	const tagPath = path.join(tagsDir, `r-session.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const line = (o: unknown) => JSON.stringify(o) + "\n";
	fs.writeFileSync(tagPath,
		line({ t: T0, c: 0.5, cat: "code", f: [], cmd: [], id: "m1", m: "claude-sonnet-4-6", out: 10 })
		+ line({ _fold: { parent: "r-session", child: "kid-a" } })
		+ line({ _fold: { parent: "r-session", child: "kid-b" } })
		+ line({ _fold: { parent: "r-session", child: "kid-a" } }));
	const read = readTagFileWithVerdict(tagPath);
	check(read.folded instanceof Set && read.folded.size === 2 && read.folded.has("kid-a") && read.folded.has("kid-b"),
		`R1 folded is the set of recorded children, a repeat counted once (got ${JSON.stringify([...(read.folded ?? [])])})`);
	check(read.interactions.length === 1,
		`R2 a fold record is not an interaction (got ${read.interactions.length})`);
	check(read.provisional.provisional === true && read.provisional.reason === "unswept",
		`R3 a fold record is data: a tag ending in one reads unswept (got ${JSON.stringify(read.provisional)})`);
	fs.appendFileSync(tagPath, line({ _meta: { swept: T0 } }));
	check(readTagFileWithVerdict(tagPath).provisional.provisional === false,
		"R4 the sweep after it settles the tag");
	const stale = path.join(tagsDir, "r-session.jsonl.wtft-tag.v0.0.1.jsonl");
	fs.writeFileSync(stale, line({ t: T0, c: 0.5, cat: "code", f: [], cmd: [], id: "m1" }));
	check(readTagFileWithVerdict(stale).folded.size === 0,
		"R5 a tag from before fold records yields an empty set");
}

// ---
// PART D — the daemon writes a fold record for every session it folds
// ---
console.log("\nPART D — the daemon records a claude -p child, its grandchild, and a Task child");

{
	const ROOT = uuid(31), CHILD = uuid(32), GRAND = uuid(33);
	const now = Date.now() - 60_000;
	putSession(CHILD, now + 2_000, 300, cwdOf(GRAND));
	putSession(GRAND, now + 4_000, 700);
	const rootDir = path.join(dir, "d");
	fs.mkdirSync(path.join(rootDir, ROOT, "subagents"), { recursive: true });
	const rootPath = path.join(rootDir, `${ROOT}.jsonl`);
	fs.writeFileSync(rootPath, turnLine("turn-root-d", now, 100, cwdOf(CHILD)));
	fs.writeFileSync(path.join(rootDir, ROOT, "subagents", "agent-task1.jsonl"), turnLine("turn-task-d", now + 1_000, 50));
	const tagPath = path.join(rootDir, "wtft-tags", `${ROOT}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);

	const daemon = spawn(process.execPath, [DAEMON_BIN, "--session", rootPath], { detached: true, stdio: "ignore", env: { ...process.env } });
	daemon.unref();
	let read = readTagFileWithVerdict(tagPath);
	for (let i = 0; i < 40 && !(read.folded.size >= 3 && !read.provisional.provisional); i++) {
		await sleep(250);
		read = readTagFileWithVerdict(tagPath);
	}
	try { if (daemon.pid) process.kill(daemon.pid, "SIGTERM"); } catch { /* already gone */ }
	check(read.folded.has(CHILD) && read.folded.has(GRAND) && read.folded.has("agent-task1"),
		`D1 the tag records the claude -p child, its grandchild, and the Task child (got ${JSON.stringify([...read.folded])})`);
	check(read.folded.size === 3,
		`D2 and nothing else (got ${read.folded.size})`);
	check(read.provisional.provisional === false,
		`D3 the tag settles swept (got ${JSON.stringify(read.provisional)})`);
	const lines = fs.readFileSync(tagPath, "utf8").split("\n").filter(l => l.includes('"_fold"'));
	check(lines.length >= 3 && lines.every(l => JSON.parse(l)._fold.parent === ROOT),
		`D4 every record names the tag's own session as parent (${lines.length} records)`);
}

// ---
// PART W — the walk skips what the tag recorded, and only that
// ---
console.log("\nPART W — spawn walk against recorded folds");

let ledgerSeq = 0;
function ledgerOf(edges: Array<[parent: string, child: string]>): string {
	const at = path.join(dir, `ledger-${ledgerSeq++}.jsonl`);
	const records = edges.map(([parent, child]) => serializeSpawnRecord({
		schema: SPAWN_RECORD_SCHEMA, ts: "2026-09-18T05:00:00Z", parent, child, mechanism: "pr-review-lens",
	}));
	fs.writeFileSync(at, records.join("\n") + "\n");
	return at;
}

{
	// #178 and #180 item 2: the tag recorded CHILD and GRAND; CHILD has since moved, then GRAND too.
	const ROOT = uuid(41), CHILD = uuid(42), GRAND = uuid(43);
	const childPath = putSession(CHILD, T0 + 2_000, 300, cwdOf(GRAND));
	const grandPath = putSession(GRAND, T0 + 4_000, 700);
	const recorded = new Set([CHILD, GRAND]);
	fs.chmodSync(childPath, 0o000);
	const unreadableChild = computeSpawnTree(ROOT, { ledgerPath: ledgerOf([[ROOT, CHILD], [ROOT, GRAND]]), alreadyAttributed: recorded });
	fs.chmodSync(childPath, 0o644);
	check(unreadableChild.edges.every(e => e.skip === "in-self-total") && unreadableChild.total.outputTokens === 0 && unreadableChild.unattributed.length === 0,
		`W1 #178 a recorded child that is unreadable now is in-self-total and adds nothing; so is its folded grandchild (#180 item 2) (skips ${JSON.stringify(unreadableChild.edges.map(e => e.skip))}, spawned ${unreadableChild.total.outputTokens})`);
	fs.renameSync(childPath, childPath + ".moved");
	fs.renameSync(grandPath, grandPath + ".moved");
	const moved = computeSpawnTree(ROOT, { ledgerPath: ledgerOf([[ROOT, CHILD]]), alreadyAttributed: recorded });
	check(moved.edges[0]?.skip === "in-self-total" && moved.total.outputTokens === 0,
		`W2 #178 a recorded child that has moved away is in-self-total, never counted (skip ${moved.edges[0]?.skip})`);
	fs.renameSync(childPath + ".moved", childPath);
	fs.renameSync(grandPath + ".moved", grandPath);

	// #135 A: no record — the daemon never folded CHILD — so the walk counts it.
	const late = computeSpawnTree(ROOT, { ledgerPath: ledgerOf([[ROOT, CHILD]]), alreadyAttributed: new Set() });
	check(late.edges[0]?.resolved === true && late.total.outputTokens === 1000,
		`W3 #135 A a child with no fold record is counted, with the grandchild its parse folds: 300 + 700 (got ${late.total.outputTokens})`);
}

{
	// #180 item 1: X in SELF, and a ledger descendant whose parse folds X too.
	const ROOT = uuid(51), D1 = uuid(52), D2 = uuid(53), X = uuid(54);
	putSession(X, T0 + 4_000, 700);
	putSession(D1, T0 + 2_000, 300, cwdOf(X));
	putSession(D2, T0 + 3_000, 200, cwdOf(X));
	const inSelf = computeSpawnTree(ROOT, { ledgerPath: ledgerOf([[ROOT, D1]]), alreadyAttributed: new Set([X]) });
	check(inSelf.edges[0]?.resolved === true && inSelf.total.outputTokens === 300,
		`W4 #180 item 1 a descendant folding an in-self session carries only its own 300 (got ${inSelf.total.outputTokens})`);
	const twice = computeSpawnTree(ROOT, { ledgerPath: ledgerOf([[ROOT, D1], [ROOT, D2]]), alreadyAttributed: new Set() });
	check(twice.total.outputTokens === 1200,
		`W5 #180 item 1 two descendants folding one session hold it once: 300 + 200 + 700 (got ${twice.total.outputTokens})`);
	const precondition = parseSessionFile(path.join(projects, cwdOf(D2).replace(/\//g, "-"), `${D2}.jsonl`));
	check(foldsOf(precondition).some(f => f.id === X),
		"W5b fixture precondition: D2's own parse folds X");
}

{
	// #180 item 3: X's newest copy is unreadable, so its edge is a gap; a later descendant folds the readable copy.
	const ROOT = uuid(61), D = uuid(62), X = uuid(63);
	putSession(X, T0 + 4_000, 700);
	putSession(D, T0 + 2_000, 300, cwdOf(X));
	const elsewhere = path.join(projects, "-elsewhere-63");
	fs.mkdirSync(elsewhere, { recursive: true });
	const newer = path.join(elsewhere, `${X}.jsonl`);
	fs.writeFileSync(newer, turnLine(`turn-${X}-copy`, T0 + 4_000, 700));
	fs.utimesSync(newer, new Date(), new Date(Date.now() + 60_000));
	fs.chmodSync(newer, 0o000);
	const tree = computeSpawnTree(ROOT, { ledgerPath: ledgerOf([[ROOT, X], [ROOT, D]]), alreadyAttributed: new Set() });
	fs.chmodSync(newer, 0o644);
	check(tree.edges[0]?.skip === "unreadable",
		`W6 fixture precondition: X's own edge could not be read (skip ${tree.edges[0]?.skip})`);
	check(tree.unattributed.length === 0 && tree.total.outputTokens === 1000,
		`W7 #180 item 3 once D's parse folds X, X is no longer a gap: 300 + 700 in spawned, unattributed empty (got ${tree.total.outputTokens}, ${JSON.stringify(tree.unattributed.map(g => g.child))})`);
}

{
	// #180 item 4: D's spawning turn is untagged, so its fold is not in D's total; X counted under its own edge first.
	const ROOT = uuid(71), D = uuid(72), X = uuid(73);
	putSession(X, T0 + 4_000, 700);
	const dPath = putSession(D, T0 + 2_000, 50, cwdOf(X), "<synthetic>");
	fs.appendFileSync(dPath, turnLine(`turn-${D}-tagged`, T0 + 6_000, 300));
	check(foldsOf(parseSessionFile(dPath)).some(f => f.id === X),
		"W8a fixture precondition: D's parse folds X, onto its untagged turn");
	const tree = computeSpawnTree(ROOT, { ledgerPath: ledgerOf([[ROOT, X], [ROOT, D]]), alreadyAttributed: new Set() });
	const dEdge = tree.edges.find(e => e.child === D);
	check(dEdge?.total?.outputTokens === 300 && tree.total.outputTokens === 1000,
		`W8 #180 item 4 D keeps its own tagged 300; nothing it did not hold is subtracted (D ${dEdge?.total?.outputTokens}, spawned ${tree.total.outputTokens})`);
}

// ---
// PART E — end to end: a recorded child that moved project dirs is not billed twice (#178)
// ---
console.log("\nPART E — wtft --json with a fold-recorded child moved to another project dir");

{
	const PARENT = uuid(81), CHILD = uuid(82);
	const REPO_ROOT = path.resolve(import.meta.dirname, "..");
	const state = path.join(dir, "e-state");
	fs.mkdirSync(path.join(state, "wtft"), { recursive: true });
	fs.copyFileSync(ledgerOf([[PARENT, CHILD]]), path.join(state, "wtft", "spawns.jsonl"));
	// The child now lives where the parent's cwd-plus-time discovery would not look, but id resolution does.
	const movedDir = path.join(projects, "-moved-worktree-82");
	fs.mkdirSync(movedDir, { recursive: true });
	fs.writeFileSync(path.join(movedDir, `${CHILD}.jsonl`), turnLine(`turn-${CHILD}`, T0 + 2_000, 300));

	const run = (withRecord: boolean) => {
		const parentDir = path.join(dir, `e-parent-${withRecord}`);
		fs.mkdirSync(path.join(parentDir, "wtft-tags"), { recursive: true });
		const session = path.join(parentDir, `${PARENT}.jsonl`);
		fs.writeFileSync(session, turnLine("turn-parent-e", T0, 100, cwdOf(CHILD)));
		const line = (o: unknown) => JSON.stringify(o) + "\n";
		fs.writeFileSync(path.join(parentDir, "wtft-tags", `${PARENT}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`),
			line({ t: T0, c: 0.02, cat: "agents", f: [], cmd: [`cd ${cwdOf(CHILD)} && claude -p "go"`], id: "msg-parent-e", m: "claude-sonnet-4-6", in: 1000, out: 100 })
			+ line({ t: T0 + 2_000, c: 0.0075, cat: "code", f: [], cmd: [], id: `turn-${CHILD}`, m: "claude-sonnet-4-6", in: 1000, out: 300 })
			+ (withRecord ? line({ _fold: { parent: PARENT, child: CHILD } }) : "")
			+ line({ _meta: { swept: T0 + 3_000 } }));
		const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "bin", "wtft.mjs"), "-s", session, "--json"], {
			cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, XDG_STATE_HOME: state, WTFT_DAEMON_DEBUG: "" },
		});
		try { return JSON.parse(r.stdout); } catch { return { stderr: r.stderr }; }
	};
	const recorded = run(true);
	const edge = recorded?.spawned?.edges?.[0];
	check(edge?.skip === "in-self-total" && recorded?.tree?.outputTokens === recorded?.total?.outputTokens,
		`E1 #178 the recorded child is in-self-total, and tree equals total (skip ${edge?.skip}, tree ${recorded?.tree?.outputTokens}, total ${recorded?.total?.outputTokens})`);
	const unrecorded = run(false);
	check(unrecorded?.spawned?.edges?.[0]?.resolved === true,
		`E2 control: the same tag without the record counts the child under its edge — the record is what E1 reads (skip ${unrecorded?.spawned?.edges?.[0]?.skip})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

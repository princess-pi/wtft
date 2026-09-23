#!/usr/bin/env -S bun
/**
 * one session index per spawn-tree walk.
 * Spec: docs/spec-138-resolution-index.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { skip } from "./lib/skips";

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
// PART C — 10,000 distinct edges through the walk itself
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
	// A loose bound: the algorithm is pinned by PART W's walk count, not by the clock.
	check(ms < 5000, `C2 the walk completes well inside 5 s (took ${Math.round(ms)} ms)`);
}

// ---
// PART W — one tree walk per spawn-tree walk, not one per child
// ---
console.log("\nPART W — directory reads do not scale with children");
{
	const one = ledgerWith([uuid(1)]);
	const many = ledgerWith(Array.from({ length: 10_000 }, (_, i) => uuid(i)));
	let before = getDirWalkCount();
	computeSpawnTree(PARENT, { ledgerPath: one });
	const forOne = getDirWalkCount() - before;
	before = getDirWalkCount();
	computeSpawnTree(PARENT, { ledgerPath: many });
	const forMany = getDirWalkCount() - before;
	check(forOne > 0, `W1 fixture precondition: a walk reads the tree at all (got ${forOne})`);
	check(forMany === forOne, `W2 10,000 children cost the same directory reads as 1 (got ${forMany} vs ${forOne})`);
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
	const suffixed = computeSpawnTree(PARENT, { ledgerPath: ledgerWith([`${child}.jsonl`]) }).edges[0];
	check(suffixed?.resolved === true && suffixed.path === fresh,
		`R2 a child recorded with a .jsonl suffix resolves as resolveSessionById would (got ${suffixed?.skip ?? suffixed?.path})`);
	const both = computeSpawnTree(PARENT, { ledgerPath: ledgerWith([child, `${child}.jsonl`]) });
	check(both.descendants === 1 && both.total.outputTokens === 700,
		`R3 one session recorded under both spellings is counted once (got ${both.descendants} descendants, ${both.total.outputTokens} tokens)`);
	const suffixedRoot = computeSpawnTree(`${PARENT}.jsonl`, { ledgerPath: ledgerWith([child]) });
	check(suffixedRoot.descendants === 1,
		`R4 a root named by its file name finds the edges recorded under its id (got ${suffixedRoot.descendants} descendants)`);
}

// ---
// PART E — the Closer as the issue states it: `wtft --tokens` over 10,000 edges
// ---
console.log("\nPART E — the rendered report");
{
	const stateHome = path.join(dir, "state");
	fs.mkdirSync(path.join(stateHome, "wtft"), { recursive: true });
	fs.copyFileSync(ledgerWith(Array.from({ length: 10_000 }, (_, i) => uuid(i, "e138"))), path.join(stateHome, "wtft", "spawns.jsonl"));
	const session = path.join(dir, "e-session", `${PARENT}.jsonl`);
	transcript(session, PARENT, 50);
	const ledgerFile = path.join(stateHome, "wtft", "spawns.jsonl");
	const runCli = () => {
		const t0 = performance.now();
		const r = spawnSync("node", [path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs"), "-s", session, "--tokens"], {
			encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: stateHome },
		});
		return { r, ms: performance.now() - t0 };
	};
	const { r, ms } = runCli();
	const out = (r.stdout || "").replace(/\x1b\[[0-9;]*m/g, "");
	check((r.status === 0 || r.status === 9) && /10000 unattributed/.test(out),
		`E1 --tokens renders the tree and names all 10,000 gaps (exit ${r.status}): ${out.split("\n").filter(l => /SPAWNED|unattributed|TREE|PROVISIONAL/.test(l)).join(" | ")} ${(r.stderr || "").slice(0, 200)}`);
	check(ms < 5000, `E2 the whole report, CLI start to exit, stays well inside 5 s (took ${Math.round(ms)} ms)`);

}

// ---
// PART D — a dead first copy never hides a live second one
// ---
console.log("\nPART D — a dangling copy of an id does not win the index");
{
	const id = uuid(8101, "a138");
	const live = path.join(claudeRoot, "-tmp-d-live", `${id}.jsonl`);
	transcript(live, id, 5);
	for (const slug of ["-tmp-d-0", "-tmp-d-z"]) {
		fs.mkdirSync(path.join(claudeRoot, slug), { recursive: true });
		fs.symlinkSync(path.join(dir, "gone", `${id}.jsonl`), path.join(claudeRoot, slug, `${id}.jsonl`));
	}
	check(claude.indexSessionsById!().get(id) === live && claude.resolveSessionById(id) === live,
		`D1 the index and the single lookup both answer the live copy, whatever order the walk meets them in (got ${claude.indexSessionsById!().get(id)})`);
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

// ---
// PART I — indexSessionsById is correct when no id repeats
// ---
// This bun runtime's `import * as fs from "node:fs"` does not bind live to a
// patched `require("node:fs")`, so a spy on `statSync` call counts is not
// observable here (confirmed by hand, not asserted below) — the fallback is
// correctness over a tree with no duplicate ids, where the fix's whole point
// (skip the stat until a SECOND file for an id appears) can never fire.
console.log("\nPART I — the index is correct over a tree with no duplicate ids");
{
	const uniqueRoot = path.join(dir, "i-claude-unique");
	fs.mkdirSync(uniqueRoot, { recursive: true });
	const saved = process.env.WTFT_CLAUDE_PROJECTS_DIR;
	process.env.WTFT_CLAUDE_PROJECTS_DIR = uniqueRoot;
	try {
		const want = new Map<string, string>();
		for (let n = 0; n < 50; n++) {
			const id = uuid(n, "a138");
			const file = path.join(uniqueRoot, `-tmp-i-${n}`, `${id}.jsonl`);
			transcript(file, id, 1);
			want.set(id, file);
		}
		const index = claude.indexSessionsById!();
		const mismatches = [...want].filter(([id, file]) => index.get(id) !== file);
		check(index.size === want.size && mismatches.length === 0,
			`I1 every one of ${want.size} unique-id files is indexed to its own path (got ${index.size} entries, ${mismatches.length} mismatches)`);
	} finally {
		process.env.WTFT_CLAUDE_PROJECTS_DIR = saved;
	}
}

// ---
// PART Q — an unreadable harness root is loud, not a silent empty index
// ---
console.log("\nPART Q — an unreadable harness root fails the walk loudly");
{
	const canBypass = (() => {
		try {
			const probe = path.join(dir, "q-probe");
			fs.writeFileSync(probe, "x");
			fs.chmodSync(probe, 0);
			fs.readFileSync(probe);
			return true;
		} catch { return false; }
	})();
	if (canBypass) {
		skip("PART Q needs a process that chmod 000 can stop (running as root?)");
	} else {
		const lockedClaudeRoot = path.join(dir, "q-locked-claude");
		fs.mkdirSync(lockedClaudeRoot, { recursive: true });
		fs.chmodSync(lockedClaudeRoot, 0);
		const emptyPiRoot = path.join(dir, "q-empty-pi");
		fs.mkdirSync(emptyPiRoot, { recursive: true });

		const savedClaudeRoot = process.env.WTFT_CLAUDE_PROJECTS_DIR;
		const savedPiRoot = process.env.WTFT_PI_SESSIONS_DIR;
		process.env.WTFT_CLAUDE_PROJECTS_DIR = lockedClaudeRoot;
		process.env.WTFT_PI_SESSIONS_DIR = emptyPiRoot;
		try {
			let directErr: unknown = null;
			try { claude.indexSessionsById!(); } catch (e) { directErr = e; }
			check(directErr instanceof Error && (directErr as NodeJS.ErrnoException).code === "EACCES" && String((directErr as Error).message).includes(lockedClaudeRoot),
				`Q1 an unreadable Claude Code root throws EACCES, naming it (got ${String(directErr)})`);

			let walkErr: unknown = null;
			try { computeSpawnTree(PARENT, { ledgerPath: ledgerWith([uuid(9001, "f138")]) }); } catch (e) { walkErr = e; }
			check(walkErr instanceof Error && (walkErr as NodeJS.ErrnoException).code === "EACCES",
				`Q2 the walk fails with the index's error rather than reporting the child not-found (got ${String(walkErr)})`);
		} finally {
			fs.chmodSync(lockedClaudeRoot, 0o755);
			process.env.WTFT_CLAUDE_PROJECTS_DIR = savedClaudeRoot;
			process.env.WTFT_PI_SESSIONS_DIR = savedPiRoot;
		}
	}
}

// ---
// PART N — ids are normalised everywhere the walk compares them, not just in
// the ledger reader
// ---
console.log("\nPART N — alreadyAttributed and fold ids are normalised like the ledger");
{
	const child = uuid(9201, "1138");
	const tree = computeSpawnTree(PARENT, {
		ledgerPath: ledgerWith([child]),
		alreadyAttributed: new Set([`${child}.jsonl`]),
	});
	check(tree.edges.length === 1 && tree.edges[0]?.skip === "in-self-total",
		`N1 an alreadyAttributed id given as <uuid>.jsonl still marks the edge to <uuid> as in-self-total (got ${JSON.stringify(tree.edges[0])})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

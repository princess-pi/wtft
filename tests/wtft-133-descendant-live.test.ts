#!/usr/bin/env -S bun
/** #133: a counted descendant whose transcript is still growing makes the tree provisional. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { computeSpawnTree } from "../extensions/lib/wtft-spawn-tree.ts";
import { SPAWN_RECORD_SCHEMA, serializeSpawnRecord } from "../extensions/lib/wtft-spawn-ledger.ts";

isolateTmpdir("133-descendant-live");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detail?: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.log(`  ❌ FAIL: ${msg}${detail ? `\n     ${detail}` : ""}`); }
}

const dir = fs.realpathSync(trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-133-"))));
const projects = path.join(dir, "projects");
process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
process.env.WTFT_PI_SESSIONS_DIR = path.join(dir, "pi-sessions");
process.env.XDG_CONFIG_HOME = path.join(dir, "config");

const PARENT = "aaaaaaaa-0000-4000-8000-000000000133";
const CHILD = "bbbbbbbb-0000-4000-8000-000000000133";
const MISSING = "cccccccc-0000-4000-8000-000000000133";

function turnLine(id: string, tsMs: number): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "assistant", timestamp: iso,
		message: {
			role: "assistant", id, model: "claude-sonnet-4-5",
			content: [{ type: "text", text: `turn ${id}` }],
			usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	}) + "\n";
}

/** A Claude Code session file in its own project dir; returns its path. */
function putSession(id: string, tsMs: number): string {
	const projectDir = path.join(projects, path.join(dir, `cwd-${id}`).replace(/\//g, "-"));
	fs.mkdirSync(projectDir, { recursive: true });
	const at = path.join(projectDir, `${id}.jsonl`);
	fs.writeFileSync(at, turnLine(`turn-${id}`, tsMs));
	return at;
}

function ledgerOf(name: string, edges: [string, string][]): string {
	const at = path.join(dir, `${name}.spawns.jsonl`);
	fs.writeFileSync(at, edges.map(([parent, child]) => serializeSpawnRecord({
		schema: SPAWN_RECORD_SCHEMA, ts: new Date().toISOString(), parent, child, mechanism: "test",
	}) + "\n").join(""));
	return at;
}

const now = Date.now();
const childFile = putSession(CHILD, now - 60_000);
const childMtime = fs.statSync(childFile).mtimeMs;
const ledger = ledgerOf("tree", [[PARENT, CHILD], [PARENT, MISSING]]);

// ---
console.log("\n=== computeSpawnTree marks a counted edge live from its transcript's mtime ===\n");
{
	const fresh = computeSpawnTree(PARENT, { ledgerPath: ledger, now: childMtime + 10_000 });
	const counted = fresh.edges.find(e => e.child === CHILD);
	const missing = fresh.edges.find(e => e.child === MISSING);
	check(counted?.resolved === true && fresh.descendants === 1, "precondition: the child resolves and is counted", JSON.stringify(fresh.edges));
	check(counted?.live === true, "mtime 10 s before now -> live: true", JSON.stringify(counted));

	const quiet = computeSpawnTree(PARENT, { ledgerPath: ledger, now: childMtime + 10 * 60_000 });
	check(quiet.edges.find(e => e.child === CHILD)?.live === false, "mtime 10 min before now -> live: false");

	check(missing?.resolved === false && !("live" in (missing ?? {})), "an unresolved edge carries no live key", JSON.stringify(missing));

	const skewed = computeSpawnTree(PARENT, { ledgerPath: ledger, now: childMtime - 10_000 });
	check(skewed.edges.find(e => e.child === CHILD)?.live === true, "mtime 10 s AFTER now (skew, or written mid-walk) -> live: true");
	const future = computeSpawnTree(PARENT, { ledgerPath: ledger, now: childMtime - 10 * 60_000 });
	check(future.edges.find(e => e.child === CHILD)?.live === false, "mtime 10 min in the future -> live: false, not provisional until the clock catches up");
}

// ---
// CLI: a parent with a swept tag of its own, and a ledger edge to CHILD.
// ---
const { WTFT_TAGGER_VERSION, EXIT_PROVISIONAL } = await import("../bin/wtft.mjs");
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI_BIN = path.join(REPO_ROOT, "bin", "wtft.mjs");
const state = path.join(dir, "state");
fs.mkdirSync(path.join(state, "wtft"), { recursive: true });
fs.copyFileSync(ledgerOf("cli", [[PARENT, CHILD]]), path.join(state, "wtft", "spawns.jsonl"));

/** The parent session, with a tag ending on `marker`. A fresh copy per run:
 *  the CLI starts a daemon that rewrites the tag it watches. */
let parentSeq = 0;
function parentWithTag(marker: Record<string, number>): string {
	const parentDir = path.join(dir, `parent-${parentSeq++}`);
	fs.mkdirSync(path.join(parentDir, "wtft-tags"), { recursive: true });
	const session = path.join(parentDir, `${PARENT}.jsonl`);
	fs.writeFileSync(session, turnLine("turn-parent", now - 120_000));
	fs.writeFileSync(path.join(parentDir, "wtft-tags", `${PARENT}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`),
		JSON.stringify({ t: now - 120_000, c: 0.25, cat: "code", f: [], cmd: [], id: "msg-p", m: "claude-sonnet-4-5",
			in: 100, out: 50, cr: 0, cw: 0, rs: 0 }) + "\n" + JSON.stringify({ _meta: marker }) + "\n");
	return session;
}

function runCli(args: string[]): { code: number; stdout: string; stderr: string; doc: any } {
	const r = spawnSync(process.execPath, [CLI_BIN, ...args], {
		cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, XDG_STATE_HOME: state, WTFT_DAEMON_DEBUG: "" },
	});
	let doc: any = null;
	try { doc = JSON.parse(r.stdout); } catch { /* not JSON mode, or reported by the caller */ }
	return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", doc };
}

console.log("\n=== wtft --json: a live descendant makes the tree provisional ===\n");
{
	fs.utimesSync(childFile, new Date(), new Date());
	const live = runCli(["-s", parentWithTag({ swept: now }), "--json"]);
	const edge = live.doc?.spawned?.edges?.find((e: any) => e.child === CHILD);
	check(edge?.resolved === true, "precondition: the ledger child is counted in spawned", JSON.stringify(live.doc?.spawned?.edges));
	check(edge?.live === true, "the counted edge reports live: true", JSON.stringify(edge));
	check(live.doc?.provisional?.provisional === true && live.doc?.provisional?.reason === "descendant-live",
		"provisional is { true, descendant-live }", JSON.stringify(live.doc?.provisional));
	check(live.doc?.schema === "wtft/session@6", `schema is wtft/session@6 (got ${live.doc?.schema})`);
	check((live.doc?.notices ?? []).some((n: any) => n.code === "provisional" && /descendant/.test(n.text)),
		"notices[] carries the provisional notice, as for every other reason", JSON.stringify(live.doc?.notices));
	check(EXIT_PROVISIONAL === 9, `the published exit code is 9 (constant is ${EXIT_PROVISIONAL})`);
	check(live.code === EXIT_PROVISIONAL, `exits ${EXIT_PROVISIONAL} (got ${live.code})`, live.stderr);

	const old = new Date(Date.now() - 10 * 60_000);
	fs.utimesSync(childFile, old, old);
	const settled = runCli(["-s", parentWithTag({ swept: now }), "--json"]);
	check(settled.doc?.spawned?.edges?.find((e: any) => e.child === CHILD)?.live === false,
		"precondition: after 10 quiet minutes the edge reports live: false");
	check(settled.doc?.provisional?.provisional === false, "the settled tree is not provisional", JSON.stringify(settled.doc?.provisional));
	check(settled.code === 0, `and exits 0 (got ${settled.code})`, settled.stderr);
}

console.log("\n=== wtft --json on a not-yet-written parent: the empty arm carries the notice too ===\n");
{
	fs.utimesSync(childFile, new Date(), new Date());
	// Its own id: getTagPath would otherwise find PARENT's tag in a sibling fixture dir.
	const PENDING = "dddddddd-0000-4000-8000-000000000133";
	fs.copyFileSync(ledgerOf("cli-pending", [[PARENT, CHILD], [PENDING, CHILD]]), path.join(state, "wtft", "spawns.jsonl"));
	fs.mkdirSync(path.join(dir, "pending-parent"), { recursive: true });
	const absent = path.join(dir, "pending-parent", `${PENDING}.jsonl`);
	const pending = runCli(["-s", absent, "--json"]);
	check((pending.doc?.notices ?? []).some((n: any) => n.code === "pending-session"),
		"precondition: the run took the pending arm", JSON.stringify(pending.doc?.notices));
	check(pending.doc?.provisional?.reason === "descendant-live",
		"precondition: the live child makes the pending report provisional", JSON.stringify(pending.doc?.provisional));
	check((pending.doc?.notices ?? []).some((n: any) => n.code === "provisional"),
		"notices[] carries the provisional notice on the empty arm", JSON.stringify(pending.doc?.notices));
}

console.log("\n=== wtft --tokens: the rendered report says so, and a tag's own reason is kept ===\n");
{
	fs.utimesSync(childFile, new Date(), new Date());
	const tokens = runCli(["-s", parentWithTag({ swept: now }), "--tokens"]);
	check(tokens.stdout.includes("SPAWNED"), "precondition: --tokens rendered the spawn block", tokens.stdout.slice(-600));
	check(/descendant session wrote to its transcript in the last 122 s/.test(tokens.stderr),
		"stderr carries the descendant-live sentence", tokens.stderr);
	check(tokens.code === EXIT_PROVISIONAL, `exits ${EXIT_PROVISIONAL} (got ${tokens.code})`, tokens.stderr);

	fs.utimesSync(childFile, new Date(), new Date());
	const both = runCli(["-s", parentWithTag({ unswept: now }), "--json"]);
	check(both.doc?.spawned?.edges?.find((e: any) => e.child === CHILD)?.live === true,
		"precondition: the descendant is live in this run too");
	check(both.doc?.provisional?.reason === "unswept", "an unswept tag keeps its own reason", JSON.stringify(both.doc?.provisional));
	check(both.code === EXIT_PROVISIONAL, `and still exits ${EXIT_PROVISIONAL} (got ${both.code})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

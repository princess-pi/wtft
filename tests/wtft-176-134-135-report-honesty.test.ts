#!/usr/bin/env -S bun
/** #176 / #134 / #135 B: the widget and the pending arm report only what they know. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { computeSpawnTree } from "../extensions/lib/wtft-spawn-tree.ts";
import { SPAWN_RECORD_SCHEMA, serializeSpawnRecord } from "../extensions/lib/wtft-spawn-ledger.ts";

isolateTmpdir("176-report-honesty");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detail?: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.log(`  ❌ FAIL: ${msg}${detail ? `\n     ${detail}` : ""}`); }
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_BIN = path.join(REPO_ROOT, "bin", "wtft.mjs");

const sandbox = fs.realpathSync(trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-176-"))));

const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";

function ledgerWith(name: string, edges: [string, string][]): string {
	const file = path.join(sandbox, `${name}.spawns.jsonl`);
	fs.writeFileSync(file, edges.map(([parent, child]) => serializeSpawnRecord({
		schema: SPAWN_RECORD_SCHEMA, ts: "2026-09-21T12:00:00Z", parent, child, mechanism: "test",
	})).join(""));
	return file;
}

// ---
console.log("\n=== #134 B: self-attribution runs only when the ledger has an edge ===\n");
{
	let calls = 0;
	const thunk = () => { calls++; return new Set<string>(); };
	computeSpawnTree(ROOT, { ledgerPath: ledgerWith("empty", []), alreadyAttributed: thunk });
	check(calls === 0, "no edge for the root -> the alreadyAttributed thunk is never called", `calls=${calls}`);

	calls = 0;
	const tree = computeSpawnTree(ROOT, { ledgerPath: ledgerWith("one", [[ROOT, CHILD]]), alreadyAttributed: thunk });
	check(tree.edges.length === 1, "precondition: the one-edge ledger yields one edge", `edges=${tree.edges.length}`);
	check(calls === 1, "an edge for the root -> the thunk is called exactly once", `calls=${calls}`);

	calls = 0;
	const inSelf = () => { calls++; return new Set<string>([CHILD]); };
	const excluded = computeSpawnTree(ROOT, { ledgerPath: ledgerWith("inself", [[ROOT, CHILD]]), alreadyAttributed: inSelf });
	check(excluded.descendants === 0, "a thunk's ids are honoured exactly as a Set's are", `descendants=${excluded.descendants}`);
}

// ---
console.log("\n=== #135 B: the pending arm derives nothing from the file it declared absent ===\n");
{
	const dir = path.join(sandbox, "pending");
	const state = path.join(dir, "state");
	fs.mkdirSync(path.join(state, "wtft"), { recursive: true });
	const sid = "308c0de0-0000-4000-8000-000000000135";
	fs.copyFileSync(ledgerWith("pending", [[sid, CHILD]]), path.join(state, "wtft", "spawns.jsonl"));
	const r = spawnSync(process.execPath, [CLI_BIN, "-s", path.join(dir, `${sid}.jsonl`), "--json"], {
		cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, XDG_STATE_HOME: state, WTFT_DAEMON_DEBUG: "" },
	});
	let doc: any = null;
	try { doc = JSON.parse(r.stdout); } catch { /* reported below */ }
	check((doc?.notices ?? []).some((n: any) => n.code === "pending-session"),
		"precondition: the run took the pending arm", JSON.stringify(doc?.notices));
	check(doc?.spawned?.edges?.length === 1,
		"precondition: the ledger edge for the pending session reaches the report", JSON.stringify(doc?.spawned));
	check(!/could not be read at discovery/.test(r.stderr),
		"no subagent-discovery warning for a session log the report says is not written yet", r.stderr);
	check(r.status === 0, `exits 0 (got ${r.status})`, r.stderr);
}

// ---
// Widget harness: the built extension, a fake pi/ctx, one sink per surface.
// ---
process.env.HOME = sandbox;
process.env.XDG_CONFIG_HOME = path.join(sandbox, "xdg-config");
fs.mkdirSync(path.join(sandbox, "xdg-config", "wtft"), { recursive: true });
fs.writeFileSync(path.join(sandbox, "xdg-config", "wtft", "config.json"), "{}\n");

const { WTFT_TAGGER_VERSION } = await import("../bin/wtft.mjs");
const mod = await import("../pi/wtft.js");
const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void> | void> = {};
let command: ((args: string, ctx: unknown) => Promise<void>) | null = null;
mod.default({
	on: (name: string, fn: any) => { handlers[name] = fn; },
	registerCommand: (_name: string, def: any) => { command = def.handler; },
});

type Sinks = { widget: string[]; notify: string[]; pager: string[] };
function fakeCtx(sinks: Sinks, session: string) {
	return {
		sessionManager: { getSessionFile: () => session },
		ui: {
			setWidget: (_id: string, lines: string[] | undefined) => { sinks.widget.push(...(lines ?? [])); },
			notify: (text: string) => { sinks.notify.push(text); },
			custom: async (factory: any) => { sinks.pager.push(...(factory({}, {}, {}, () => {}) as any).lines); },
		},
		model: undefined,
	};
}
async function render(session: string): Promise<string[]> {
	const sinks: Sinks = { widget: [], notify: [], pager: [] };
	await handlers["agent_settled"](undefined, fakeCtx(sinks, session));
	return sinks.widget;
}
async function runCommand(args: string, session: string): Promise<Sinks> {
	const sinks: Sinks = { widget: [], notify: [], pager: [] };
	await command!(args, fakeCtx(sinks, session));
	return sinks;
}

const PROVISIONAL = "total is provisional";

/** A written session whose tag holds one classified turn and ends on `marker`. */
function sessionWithTag(name: string, marker: Record<string, number>): string {
	const dir = path.join(sandbox, name);
	fs.mkdirSync(path.join(dir, "wtft-tags"), { recursive: true });
	const session = path.join(dir, `${ROOT}.jsonl`);
	fs.writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: ROOT, timestamp: "2026-09-21T12:00:00Z", cwd: dir }) + "\n");
	fs.writeFileSync(path.join(dir, "wtft-tags", `${ROOT}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`),
		JSON.stringify({ t: Date.parse("2026-09-21T12:00:00Z"), c: 0.25, cat: "code", f: [], cmd: [],
			id: "msg-1", m: "claude-sonnet-4-5", in: 100, out: 50, cr: 0, cw: 0, rs: 0 }) + "\n" +
		JSON.stringify({ _meta: marker }) + "\n");
	return session;
}

console.log("\n=== #176: the widget reads the tag's own provisional verdict ===\n");
{
	process.env.XDG_STATE_HOME = path.join(sandbox, "state-none");
	const unswept = sessionWithTag("unswept", { unswept: Date.now() });
	const swept = sessionWithTag("swept", { swept: Date.now() });

	// Its own copy: the CLI starts a daemon, which rewrites the tag it watches.
	const unsweptCli = sessionWithTag("unswept-cli", { unswept: Date.now() });
	const cli = spawnSync(process.execPath, [CLI_BIN, "-s", unsweptCli, "--json"], {
		cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, WTFT_DAEMON_DEBUG: "" },
	});
	let doc: any = null;
	try { doc = JSON.parse(cli.stdout); } catch { /* reported below */ }
	check(doc?.provisional?.provisional === true && doc?.total?.costUsd > 0,
		"precondition: the CLI reads the unswept tag as provisional, with cost in it", JSON.stringify({ p: doc?.provisional, t: doc?.total?.costUsd }));

	const w = await render(unswept);
	check(w.some(l => l.includes("+$0.25")), "precondition: the widget renders the tag's turn", JSON.stringify(w));
	check(w.some(l => l.includes(PROVISIONAL)), "unswept tag -> the widget carries the provisional line", JSON.stringify(w));
	const tokens = await runCommand("--tokens", unswept);
	check(tokens.notify.some(l => l.includes(PROVISIONAL)), "unswept tag -> /wtft --tokens carries it", JSON.stringify(tokens.notify));
	const pager = await runCommand("--pager", unswept);
	check(pager.pager.some(l => l.includes(PROVISIONAL)), "unswept tag -> /wtft --pager carries it", JSON.stringify(pager.pager.slice(-3)));

	check(!(await render(swept)).some(l => l.includes(PROVISIONAL)), "control: a swept tag renders no provisional line");
}

console.log("\n=== #134 A: an unreadable ledger is not \"spawned nothing\" on the widget ===\n");
{
	const session = sessionWithTag("ledger", { swept: Date.now() });

	process.env.XDG_STATE_HOME = path.join(sandbox, "state-broken");
	fs.mkdirSync(path.join(sandbox, "state-broken", "wtft", "spawns.jsonl"), { recursive: true });
	const broken = await runCommand("--tokens", session);
	check(broken.notify.some(l => l.includes("descendants unknown, not zero")),
		"ledger unreadable -> /wtft --tokens says descendants unknown", JSON.stringify(broken.notify));

	process.env.XDG_STATE_HOME = path.join(sandbox, "state-empty");
	fs.mkdirSync(path.join(sandbox, "state-empty", "wtft"), { recursive: true });
	fs.writeFileSync(path.join(sandbox, "state-empty", "wtft", "spawns.jsonl"), "");
	const empty = await runCommand("--tokens", session);
	check(empty.notify.length > 0 && !empty.notify.some(l => l.includes("SPAWNED")),
		"empty ledger -> /wtft --tokens has no SPAWNED block", JSON.stringify(empty.notify));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

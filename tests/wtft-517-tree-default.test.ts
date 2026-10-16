#!/usr/bin/env -S bun

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionFile, collectSelfAttributedSessionIds, classifyInteraction, type Interaction } from "../extensions/lib/wtft-parser.ts";
import { computeSessionSummary } from "../extensions/lib/wtft-renderer.ts";
import { computeSpawnTree, treeView } from "../extensions/lib/wtft-spawn-tree.ts";
import { renderLiveDescendants } from "../extensions/lib/wtft-daemon-lib.ts";
import { SPAWN_RECORD_SCHEMA, serializeSpawnRecord } from "../extensions/lib/wtft-spawn-ledger.ts";
import { buildSessionJson } from "../extensions/lib/wtft-json.ts";
import { parseWtftCliArgs } from "../extensions/lib/wtft-cli-shared.ts";
import { newUncountedBillables } from "../extensions/lib/wtft-parser.ts";
import { spawn, spawnSync } from "node:child_process";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { cliWithoutDaemon } from "./lib/cli-harness.ts";

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

function turnLine(id: string, tsMs: number, outputTokens: number, opts: { spawnCwd?: string; write?: string; cacheWrite?: number } = {}): string {
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
			usage: { input_tokens: 1000, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: opts.cacheWrite ?? 0 },
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
		turnLine("c1", T0 + 60_000, 200, { write: "docs/spec-x.md", cacheWrite: 50_000 }),
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
	check(parseSessionFile(childPath).some(t => t.cacheMiss), "A6 fixture precondition: the child's own parse marks a cache miss");
	check(collect.turns.every(t => !t.cacheMiss), "A7 no collected turn draws a Cache Miss divider: the divider is parent-only");
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

console.log("\nPART E — --json treeCategories sum to tree");
{
	const ROOT = uuid(41), CHILD = uuid(42);
	putSession(CHILD, [turnLine("c1", T0 + 60_000, 200, { write: "docs/spec-y.md" }), turnLine("c2", T0 + 90_000, 500, { write: "src/y.ts" })]);
	const rootPath = path.join(dir, "root-e.jsonl");
	fs.writeFileSync(rootPath, JSON.stringify({ type: "session", version: 3, id: ROOT, timestamp: new Date(T0).toISOString(), cwd: dir }) + "\n"
		+ turnLine("r", T0, 100, { write: "src/z.ts" }));
	const self = parseSessionFile(rootPath);
	const collect = { turns: [] as Interaction[], files: [] as string[] };
	const spawned = computeSpawnTree(ROOT, { ledgerPath: ledgerOf([[ROOT, CHILD]]), collect });
	const doc = buildSessionJson({
		interactions: self, descendantTurns: collect.turns, spawned, uncounted: newUncountedBillables(),
		session: { path: rootPath, harness: null, taggerVersion: "0", tagPath: "" },
		provisional: { provisional: false, reason: null },
	});
	const sum = doc.treeCategories.reduce((a, c) => a + c.costUsd, 0);
	check(doc.schema === "wtft/session@9", `E1 the schema is wtft/session@9 (got ${doc.schema})`);
	check(close(sum, doc.tree.costUsd) && sum > doc.total.costUsd, `E2 treeCategories sum to tree.costUsd (${sum} vs ${doc.tree.costUsd})`);
	check(doc.treeCategories.map(c => c.category).join() === doc.categories.map(c => c.category).join(), "E3 treeCategories has categories' order");
	const spec = doc.treeCategories.find(c => c.category === "spec")!.costUsd;
	check(spec > 0 && doc.categories.find(c => c.category === "spec")!.costUsd === 0, `E4 the child's spec turn lands in tree spec, not self spec (${spec})`);
}

console.log("\nPART F — --self parses");
{
	check(parseWtftCliArgs(["--self"]).self === true && parseWtftCliArgs([]).self === false, "F1 --self sets self; absent, it is false");
}

console.log("\nPART G — --watch names a live child, and drops it once quiet (#198)");
{
	const ROOT = uuid(51), CHILD = uuid(52);
	const childPath = putSession(CHILD, [turnLine("c", T0, 300)]);
	const ledgerPath = ledgerOf([[ROOT, CHILD]]);
	const now = Date.now();
	fs.utimesSync(childPath, new Date(now - 1_000), new Date(now - 1_000));
	const fresh = treeView(ROOT, new Set(), { ledgerPath, now });
	const lines = renderLiveDescendants(fresh.live).join("\n");
	check(fresh.turns.length === 1, `G0 fixture precondition: the child's turn is in the view (got ${fresh.turns.length})`);
	check(lines.includes(CHILD.slice(0, 8)) && lines.includes("pr-review-lens") && lines.includes(`$${fresh.live[0]?.costUsd.toFixed(2)}`),
		`G1 a fresh child renders a line with its id, mechanism and cost (got ${JSON.stringify(lines)})`);
	fs.utimesSync(childPath, new Date(now - 600_000), new Date(now - 600_000));
	const quiet = treeView(ROOT, new Set(), { ledgerPath, now });
	check(quiet.live.length === 0 && quiet.turns.length === 1, `G2 ten minutes quiet, the line is gone and the turn stays (live ${quiet.live.length})`);
}

console.log("\nPART H — a spawner's label and mechanism cannot write to the terminal");
{
	const [line] = renderLiveDescendants([{ child: uuid(61), label: "ok\n$0.00 forged\x1b]0;x\x07", mechanism: "m\x1b[2J", costUsd: 1 }]);
	check(!line.includes("\n") && !line.includes("\x1b]") && !line.includes("\x1b[2J") && line.includes("\uFFFD"),
		`H1 control characters become U+FFFD (got ${JSON.stringify(line)})`);
}

console.log("\nPART I — a spawn walk that throws fails every surface");
{
	const { WTFT_TAGGER_VERSION } = await import("../bin/wtft.mjs");
	const ROOT = uuid(71);
	const state = path.join(dir, "state-i");
	fs.mkdirSync(path.join(state, "wtft"), { recursive: true });
	fs.copyFileSync(ledgerOf([[ROOT, uuid(72)]]), path.join(state, "wtft", "spawns.jsonl"));
	const notADir = path.join(dir, "projects-is-a-file");
	fs.writeFileSync(notADir, "");
	const parentDir = path.join(dir, "parent-i");
	fs.mkdirSync(path.join(parentDir, "wtft-tags"), { recursive: true });
	const session = path.join(parentDir, `${ROOT}.jsonl`);
	fs.writeFileSync(session, turnLine("r", T0, 100));
	fs.writeFileSync(path.join(parentDir, "wtft-tags", `${ROOT}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`),
		JSON.stringify({ t: T0, c: 0.25, cat: "code", f: [], cmd: [], id: "msg-r", m: "claude-sonnet-4-6", in: 100, out: 50, cr: 0, cw: 0, rs: 0 })
		+ "\n" + JSON.stringify({ _meta: { swept: Date.now() } }) + "\n");
	const run = (...args: string[]) => spawnSync(process.execPath, [cliWithoutDaemon(), "-s", session, ...args], {
		cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."), encoding: "utf8", timeout: 60_000,
		stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XDG_STATE_HOME: state, WTFT_DAEMON_DEBUG: "", WTFT_CLAUDE_PROJECTS_DIR: notADir },
	});
	const self = run("--self");
	check(self.status === 0 && self.stdout.includes(session), `I0 fixture precondition: --self, which walks nothing, charts and exits 0 (exit ${self.status})`);
	for (const args of [[], ["--tokens"], ["--self", "--tokens"]]) {
		const r = run(...args);
		check(r.status !== 0 && r.status !== null && r.stdout === "" && /ENOTDIR/.test(r.stderr),
			`I1 ${args.join(" ") || "a plain run"} exits non-zero, nothing on stdout, stderr naming the walk's ENOTDIR (exit ${r.status}, stdout ${JSON.stringify(r.stdout.slice(0, 120))})`);
	}

	const CHART = /\$0\.25/;
	const watch = (...args: string[]) => new Promise<{ status: number | null; out: string }>((resolve) => {
		const child = spawn("script", ["-q", "-e", "-c", `${process.execPath} ${cliWithoutDaemon()} --watch -s '${session}' -l 1 ${args.join(" ")}`, "/dev/null"], {
			stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, XDG_STATE_HOME: state, WTFT_CLAUDE_PROJECTS_DIR: notADir },
		});
		let out = "";
		let quit = false;
		const read = (d: Buffer) => {
			out += d.toString();
			if (!quit && CHART.test(out)) { quit = true; child.stdin.end("q"); }
		};
		child.stdout.on("data", read);
		child.stderr.on("data", read);
		child.stdin.on("error", () => {});
		const kill = setTimeout(() => child.kill(), 20_000);
		child.on("close", (status) => { clearTimeout(kill); resolve({ status, out }); });
	});
	const control = await watch("--self");
	check(control.status === 0 && CHART.test(control.out),
		`I2 fixture precondition: --watch --self, which walks nothing, draws the chart's $0.25 (exit ${control.status})`);
	const watched = await watch();
	const watchOut = watched.out;
	check(watched.status !== 0 && watched.status !== null && /ENOTDIR/.test(watchOut) && !CHART.test(watchOut) && !/watch stopped/.test(watchOut),
		`I2 --watch exits non-zero naming the walk's ENOTDIR and draws no chart (exit ${watched.status}): ${JSON.stringify(watchOut.slice(-300))}`);
	check(watchOut.lastIndexOf("\x1b[?25h") > watchOut.lastIndexOf("\x1b[?25l"), "I3 --watch shows the cursor again before it exits");

	const saved = { projects: process.env.WTFT_CLAUDE_PROJECTS_DIR, state: process.env.XDG_STATE_HOME };
	process.env.WTFT_CLAUDE_PROJECTS_DIR = notADir;
	process.env.XDG_STATE_HOME = state;
	const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
	const pi: any = {
		on: () => {},
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands[name] = def; },
		registerFlag: () => {},
		getFlag: () => undefined,
	};
	const widget: (string[] | undefined)[] = [];
	const ctx: any = {
		ui: { setWidget: (_id: string, lines: string[] | undefined) => { widget.push(lines); }, notify: () => {}, custom: async () => {} },
		sessionManager: { getSessionFile: () => session, buildSessionContext: () => ({}) },
	};
	(await import("../extensions/wtft.ts")).default(pi);
	await commands.wtft!.handler("", ctx);
	const panel = widget[widget.length - 1] ?? [];
	check(panel.length === 1 && /spawn tree not walked/.test(panel[0]!) && /ENOTDIR/.test(panel[0]!),
		`I4 the widget's panel shows the walk's error and no chart: ${JSON.stringify(panel)}`);
	let tokensThrew = false;
	try { await commands.wtft!.handler("--tokens", ctx); } catch (err) { tokensThrew = /ENOTDIR/.test(String(err)); }
	check(tokensThrew, "I5 /wtft --tokens throws the walk's error to Pi");
	for (const [k, v] of [["WTFT_CLAUDE_PROJECTS_DIR", saved.projects], ["XDG_STATE_HOME", saved.state]] as const) {
		if (v === undefined) delete process.env[k]; else process.env[k] = v;
	}
}

console.log("\nPART J — a descendant's subagent lines stay whole, as a tag keeps them");
{
	const ROOT = uuid(81), CHILD = uuid(82);
	const recache = (id: string, at: number) => JSON.parse(turnLine(id, at, 50, { cacheWrite: 50_000 }));
	const whole = (ls: any[]) => ls.map(l => { l.message.usage.input_tokens = 10; return JSON.stringify(l) + "\n"; });
	const childPath = putSession(CHILD, whole([recache("c1", T0), recache("c2", T0 + 500)]));
	const subDir = path.join(childPath.replace(/\.jsonl$/, ""), "subagents");
	fs.mkdirSync(subDir, { recursive: true });
	fs.writeFileSync(path.join(subDir, "agent-a.jsonl"), whole([recache("s1", T0 + 1_000), recache("s2", T0 + 2_000)]).join(""));
	const collect = { turns: [] as Interaction[], files: [] as string[] };
	computeSpawnTree(ROOT, { ledgerPath: ledgerOf([[ROOT, CHILD]]), collect });
	const sub = collect.turns.filter(t => t.timestamp >= T0 + 1_000);
	check(collect.files.some(f => f.endsWith("agent-a.jsonl")), "J0 fixture precondition: the subagent transcript is read");
	check(sub.length === 2 && sub.every(t => t.cacheWriteTokens === 50_000), `J1 both subagent turns stay whole (got ${sub.length} lines)`);
	const own = collect.turns.filter(t => t.timestamp < T0 + 1_000);
	check(own.length === 3, `J2 the recache in the descendant's own transcript splits into an Ovrhd line (got ${own.length} lines)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

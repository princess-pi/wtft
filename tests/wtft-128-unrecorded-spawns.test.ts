#!/usr/bin/env -S bun
/**
 * #128 — sessions no spawn record names, listed with a tier and never summed.
 * Spec: docs/spec-128-unrecorded-spawns.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnWindows, UNRECORDED_WINDOW_MS } from "../extensions/lib/wtft-unrecorded.ts";
import type { Interaction } from "../extensions/lib/wtft-parser.ts";
import claudeDiscovery from "../extensions/lib/harness/claude-code/discovery.ts";
import { computeSpawnTree } from "../extensions/lib/wtft-spawn-tree.ts";
import { appendSpawnRecord, SPAWN_RECORD_SCHEMA } from "../extensions/lib/wtft-spawn-ledger.ts";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { discoverClaudeSubAgentFilesForTurn } from "../extensions/lib/wtft-parser.ts";
import { listUnrecordedSpawns } from "../extensions/lib/wtft-unrecorded.ts";
import { readClassifiedTagFile, WTFT_TAGGER_VERSION } from "../bin/wtft.mjs";
import { renderSpawnTree, emptyTotals } from "../extensions/lib/wtft-renderer.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("128-unrecorded-spawns");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-128-")));

function turn(timestamp: number, commands: string[] = [], id = `m-${timestamp}`): Interaction {
	return {
		timestamp, cost: 0.01, messageId: id, model: "claude-opus-5",
		inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
		webSearchRequests: 0, webFetchRequests: 0, serverToolCost: 0,
		files: [], commands, texts: [],
	};
}

// ---
// PART W — the spawn window
// ---
console.log("\nPART W — spawnWindows");

const MIN = 60_000;
check(UNRECORDED_WINDOW_MS === 30 * MIN, `W0 a command turn opens 30 minutes (got ${UNRECORDED_WINDOW_MS / MIN})`);
{
	const w = spawnWindows([turn(0, ["ls"]), turn(5 * MIN), turn(10 * MIN, ["pr-open"])]);
	check(JSON.stringify(w) === JSON.stringify([[0, 10 * MIN + UNRECORDED_WINDOW_MS]]),
		`W1 overlapping windows from two command turns merge into one (got ${JSON.stringify(w)})`);
}
{
	const w = spawnWindows([turn(0, ["ls"]), turn(UNRECORDED_WINDOW_MS + 5 * MIN, ["ls"])]);
	check(w.length === 2 && w[0][1] === UNRECORDED_WINDOW_MS && w[1][0] === UNRECORDED_WINDOW_MS + 5 * MIN,
		`W2 command turns further apart than the window stay two windows (got ${JSON.stringify(w)})`);
}
{
	const w = spawnWindows([turn(0), turn(MIN)]);
	check(w.length === 0, `W3 a session that ran no command has no window (got ${JSON.stringify(w)})`);
}
{
	const w = spawnWindows([turn(10 * MIN, ["b"]), turn(0, ["a"])]);
	check(w.length === 1 && w[0][0] === 0, `W4 order of the turns does not matter (got ${JSON.stringify(w)})`);
}

// ---
// Fixtures — Claude Code transcripts under a sandboxed projects root
// ---

const projects = path.join(dir, "projects");
process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
const T0 = Date.UTC(2026, 8, 22, 5, 0);

/** A child transcript: its own uuid, a recorded cwd, and an entrypoint. */
function writeChild(opts: { id: string; slug: string; cwd: string; startedAt: number; entrypoint?: string; turns?: number; commands?: string[]; root?: string }): string {
	const root = opts.root ?? projects;
	fs.mkdirSync(path.join(root, opts.slug), { recursive: true });
	const lines: string[] = [JSON.stringify({ type: "ai-title", title: "no timestamp on this line" })];
	for (let i = 0; i < (opts.turns ?? 2); i++) {
		const content: unknown[] = [{ type: "text", text: "x" }];
		if (i === 0 && opts.commands) for (const command of opts.commands) content.push({ type: "tool_use", id: `t${i}`, name: "Bash", input: { command } });
		lines.push(JSON.stringify({
			type: "assistant",
			timestamp: new Date(opts.startedAt + i * 1000).toISOString(),
			cwd: opts.cwd,
			...(opts.entrypoint !== undefined ? { entrypoint: opts.entrypoint } : {}),
			sessionId: opts.id,
			message: {
				role: "assistant", id: `${opts.id}-${i}`, model: "claude-opus-5",
				content,
				usage: { input_tokens: 500, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		}));
	}
	const file = path.join(root, opts.slug, `${opts.id}.jsonl`);
	fs.writeFileSync(file, lines.join("\n") + "\n");
	return file;
}

// ---
// PART C — the Claude Code harness lists what began since a moment
// ---
console.log("\nPART C — listSpawnCandidates (Claude Code)");
{
	const since = T0;
	const sdk = writeChild({ id: "c0000001-0000-4000-8000-000000000001", slug: "-tmp-pr-review-c1", cwd: "/tmp/pr-review-c1", startedAt: T0 + 60_000, entrypoint: "sdk-cli" });
	const human = writeChild({ id: "c0000002-0000-4000-8000-000000000002", slug: "-home-peer", cwd: "/home/peer", startedAt: T0 + 60_000, entrypoint: "cli" });
	const silent = writeChild({ id: "c0000003-0000-4000-8000-000000000003", slug: "-home-silent", cwd: "/home/silent", startedAt: T0 + 60_000 });
	// An old directory holding an old transcript: mtime before `since` on both.
	const old = writeChild({ id: "c0000004-0000-4000-8000-000000000004", slug: "-home-old", cwd: "/home/old", startedAt: T0 - 3_600_000, entrypoint: "sdk-cli" });
	const oldAt = new Date(T0 - 3_600_000);
	fs.utimesSync(old, oldAt, oldAt);
	fs.utimesSync(path.dirname(old), oldAt, oldAt);
	for (const f of [sdk, human, silent]) fs.utimesSync(f, new Date(T0 + 120_000), new Date(T0 + 120_000));
	for (const f of [sdk, human, silent]) fs.utimesSync(path.dirname(f), new Date(T0 + 120_000), new Date(T0 + 120_000));

	const scan = claudeDiscovery.listSpawnCandidates!(since);
	const byId = new Map(scan.candidates.map(c => [c.sessionId, c]));
	const a = byId.get("c0000001-0000-4000-8000-000000000001");
	check(a?.launchedBy === "program" && a.cwd === "/tmp/pr-review-c1" && a.startedAt === T0 + 60_000 && a.path === sdk,
		`C1 entrypoint sdk-cli reads as program, with its recorded cwd, first timestamp and path (got ${JSON.stringify(a)})`);
	check(byId.get("c0000002-0000-4000-8000-000000000002")?.launchedBy === "human",
		"C2 entrypoint cli reads as human");
	check(byId.get("c0000003-0000-4000-8000-000000000003")?.launchedBy === null,
		"C3 no entrypoint reads as null — the harness does not say");
	check(!byId.has("c0000004-0000-4000-8000-000000000004"),
		"C4 a transcript whose file and directory were both last written before the moment is not listed");
	for (const f of [sdk, human, silent, old]) fs.rmSync(path.dirname(f), { recursive: true });
}

// ---
// PART T — computeSpawnTree lists what no record names, and sums none of it
// ---
console.log("\nPART T — the listing, through computeSpawnTree");

const ROOT = "a0000000-0000-4000-8000-00000000000a";
const OTHER_PARENT = "b0000000-0000-4000-8000-00000000000b";
// A real repo with a real worktree: the fan-out arm asks git.
const repo = path.join(dir, "repo");
const worktree = path.join(dir, "repo-wt");
fs.mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
git("init", "-q");
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
git("worktree", "add", "-q", worktree);

const ids = {
	launched: "d0000001-0000-4000-8000-000000000001",
	human: "d0000002-0000-4000-8000-000000000002",
	late: "d0000003-0000-4000-8000-000000000003",
	otherParents: "d0000004-0000-4000-8000-000000000004",
	named: "d0000005-0000-4000-8000-000000000005",
	inWorktree: "d0000006-0000-4000-8000-000000000006",
	elsewhere: "d0000007-0000-4000-8000-000000000007",
	folded: "d0000008-0000-4000-8000-000000000008",
	grandchild: "d0000009-0000-4000-8000-000000000009",
	recorded: "d000000a-0000-4000-8000-00000000000a",
};
const at = (min: number) => T0 + min * MIN;
writeChild({ id: ids.launched, slug: "-tmp-pr-review-l", cwd: "/tmp/pr-review-l", startedAt: at(2), entrypoint: "sdk-cli",
	commands: ["cd /tmp/pr-review-g && claude -p 'nested'"] });
writeChild({ id: ids.grandchild, slug: "-tmp-pr-review-g", cwd: "/tmp/pr-review-g", startedAt: at(2) + 3000, entrypoint: "sdk-cli" });
writeChild({ id: ids.human, slug: "-tmp-peer", cwd: "/tmp/peer", startedAt: at(2), entrypoint: "cli" });
writeChild({ id: ids.late, slug: "-tmp-late", cwd: "/tmp/late", startedAt: at(40), entrypoint: "sdk-cli" });
writeChild({ id: ids.otherParents, slug: "-tmp-other", cwd: "/tmp/other", startedAt: at(3), entrypoint: "sdk-cli" });
writeChild({ id: ids.named, slug: `-tmp-pr-review-${ROOT}-bugs`, cwd: `/tmp/pr-review.${ROOT}.bugs`, startedAt: at(50), entrypoint: "cli" });
writeChild({ id: ids.inWorktree, slug: "-repo-wt", cwd: worktree, startedAt: at(4), entrypoint: "sdk-cli" });
writeChild({ id: ids.elsewhere, slug: "-home-elsewhere", cwd: "/home/elsewhere", startedAt: at(2), entrypoint: "sdk-cli" });
writeChild({ id: ids.folded, slug: "-repo", cwd: repo, startedAt: at(5), entrypoint: "sdk-cli" });
writeChild({ id: ids.recorded, slug: "-tmp-recorded", cwd: "/tmp/recorded", startedAt: at(6), entrypoint: "sdk-cli" });

const ledgerPath = path.join(dir, "spawns.jsonl");
const record = (parent: string, child: string) => appendSpawnRecord({
	schema: SPAWN_RECORD_SCHEMA, ts: new Date(at(1)).toISOString(), parent, child, mechanism: "test",
}, ledgerPath);
record(OTHER_PARENT, ids.otherParents);
record(ROOT, ids.recorded);

const rootTurns = [turn(at(0)), turn(at(1), ["herdr agent start x --kind claude --pane wE:pCW"]), turn(at(8))];
const tree = computeSpawnTree(ROOT, {
	ledgerPath,
	alreadyAttributed: new Set([ids.folded]),
	unrecorded: { turns: rootTurns, rootCwd: repo },
});
const rows = tree.unrecorded ?? [];
const row = (id: string) => rows.find(r => r.child === id);

check(row(ids.launched)?.tier === "inferred" && row(ids.launched)?.basis === "tmp",
	`T1 a programmatic child in a /tmp sandbox, inside the window, is listed inferred/tmp (got ${JSON.stringify(row(ids.launched))})`);
check((row(ids.launched)?.total?.costUsd ?? 0) > 0 && (row(ids.launched)?.total?.outputTokens ?? 0) === 4000,
	`T2 with its own cost, which includes the grandchild it folded (got ${row(ids.launched)?.total?.outputTokens} output tokens)`);
check(!row(ids.grandchild), "T3 the grandchild a listed row folded is not listed again");
check(!row(ids.human), "T4 a human-started peer in the same window and directory is absent");
check(!row(ids.late), "T5 a programmatic session outside every window is absent");
check(!row(ids.otherParents), "T6 a session the ledger records under a different parent is absent");
check(row(ids.named)?.tier === "named" && row(ids.named)?.basis === "cwd-names-parent",
	`T7 a cwd carrying the parent's id is named — outside the window, human-started, still listed (got ${JSON.stringify(row(ids.named))})`);
check(row(ids.inWorktree)?.tier === "inferred" && row(ids.inWorktree)?.basis === "worktree",
	`T8 a programmatic child in a worktree of the parent's repo is inferred/worktree (got ${JSON.stringify(row(ids.inWorktree))})`);
check(!row(ids.elsewhere), "T9 a programmatic session outside the fan-out and every temp root is absent");
check(!row(ids.folded), "T10 a session already in the parent's total is absent");
check(!row(ids.recorded) && tree.edges.some(e => e.child === ids.recorded && e.resolved),
	"T11 a recorded child is an edge, not a row");
check(JSON.stringify(rows.map(r => r.ts)) === JSON.stringify([...rows.map(r => r.ts)].sort()),
	"T13 rows are in start order");
check(rows.length === 3, `T14 exactly the three expected rows (got ${rows.map(r => r.child).join(", ")})`);

{
	const text = renderSpawnTree(emptyTotals(), tree);
	check(/named\s+\/tmp\/pr-review\./.test(text),
		"R1 a named row prints on its own, under its cwd (fitted to its column)");
	check(/inferred\s+1 in this repo's checkouts\s+\$/.test(text) && /inferred\s+1 in temp sandboxes\s+\$/.test(text),
		`R2 inferred rows collapse to one line per basis:\n${text}`);
	check(/UNRECORDED 3 session\(s\)/.test(text), "R3 the header counts every row");
	const unreadableOnly = renderSpawnTree(emptyTotals(), { ...tree, unrecorded: [{ ...rows.find(r => r.basis === "tmp")!, total: null, skip: "unreadable" as const }] });
	check(/inferred\s+1 in temp sandboxes\s+\(unreadable\)\n\s+1 of them unreadable, not in that sum/.test(unreadableOnly) && !/\$0\.00/.test(unreadableOnly.split("UNRECORDED")[1] ?? "$0.00"),
		`R4 a group with no readable row prints (unreadable), never $0.00:\n${unreadableOnly}`);
}
{
	const noCommands = computeSpawnTree(ROOT, { ledgerPath, unrecorded: { turns: [turn(at(0))], rootCwd: repo } });
	check(Array.isArray(noCommands.unrecorded) && noCommands.unrecorded.length === 0,
		"T15 a session that ran no command lists nothing, and says so with []");
	const notAsked = computeSpawnTree(ROOT, { ledgerPath });
	check(notAsked.unrecorded === undefined, "T16 a caller that did not ask gets no key — the widget pays nothing");
	const noEdges = computeSpawnTree("e0000000-0000-4000-8000-00000000000e", {
		ledgerPath, unrecorded: { turns: [turn(at(1), ["pr-open"])], rootCwd: repo },
	});
	check((noEdges.unrecorded ?? []).some(r => r.child === ids.launched),
		"T17 a session with no recorded edge still gets its listing");
}

// ---
// PART F — a candidate's parse never folds this session's own transcript
// ---
console.log("\nPART F — the root transcript is not a candidate's child");
{
	const ROOT_F = "a2000000-0000-4000-8000-0000000000f1";
	const shared = "/tmp/shared-f";
	const slug = shared.replace(/[^a-zA-Z0-9]/g, "-");
	// The root began 2s after the candidate's bare claude -p, in the directory
	// that spawn searches: discovery alone cannot tell it from a child.
	const rootFile = writeChild({ id: ROOT_F, slug, cwd: shared, startedAt: at(3) + 2000, entrypoint: "cli", commands: ["pr-open"] });
	const cand = "a2000001-0000-4000-8000-0000000000f2";
	writeChild({ id: cand, slug: "-tmp-cand-f", cwd: "/tmp/cand-f", startedAt: at(3), entrypoint: "sdk-cli", commands: [`cd ${shared} && claude -p 'x'`] });
	check(discoverClaudeSubAgentFilesForTurn([`cd ${shared} && claude -p 'x'`], at(3), null).files.some(f => f === rootFile),
		"F1 fixture precondition: the candidate's spawn does discover the root transcript");
	const turns = [turn(at(2), ["pr-open"])];
	const listed = computeSpawnTree(ROOT_F, { ledgerPath, unrecorded: { turns, rootCwd: shared, rootFile } }).unrecorded ?? [];
	const row = listed.find(r => r.child === cand);
	check(row?.total?.outputTokens === 2000,
		`F2 the candidate is priced at its own 2000 output tokens, not with the root's folded in (got ${row?.total?.outputTokens})`);
}

// ---
// PART M — two candidates that fold each other are listed once, not dropped
// ---
console.log("\nPART M — a mutual fold keeps exactly one row");
{
	const ROOT_M = "a3000000-0000-4000-8000-0000000000e1";
	const shared = "/tmp/shared-m";
	const slug = shared.replace(/[^a-zA-Z0-9]/g, "-");
	const one = "a3000001-0000-4000-8000-0000000000e2";
	const two = "a3000002-0000-4000-8000-0000000000e3";
	// Each runs a bare claude -p in the shared dir 1s after it starts; each is
	// inside the other's discovery window.
	writeChild({ id: one, slug, cwd: shared, startedAt: at(4), entrypoint: "sdk-cli", commands: ["claude -p 'a'"] });
	writeChild({ id: two, slug, cwd: shared, startedAt: at(4) + 1000, entrypoint: "sdk-cli", commands: ["claude -p 'b'"] });
	const listed = computeSpawnTree(ROOT_M, { ledgerPath, unrecorded: { turns: [turn(at(3), ["pr-open"])], rootCwd: null } }).unrecorded ?? [];
	const pair = listed.filter(r => r.child === one || r.child === two);
	check(pair.length === 1 && pair[0].total?.outputTokens === 4000,
		`M1 one row carries both sessions' 4000 output tokens (got ${JSON.stringify(pair.map(r => [r.child, r.total?.outputTokens]))})`);
}

// ---
// PART E — #116's Closer, second clause, through the CLI
// ---
console.log("\nPART E — delete the record and the child is still reported, never summed");

const CLI_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs");
const HERDR_LINE = "herdr agent start ppt-824 --kind claude --pane wE:pCW -- --model sonnet";
const PARENT = "f0000000-0000-4000-8000-00000000000f";
const CLOSER_CHILD = "f0000001-0000-4000-8000-000000000001";
const cliProjects = path.join(dir, "cli-projects");
const stateHome = path.join(dir, "state");
const cliLedger = path.join(stateHome, "wtft", "spawns.jsonl");

writeChild({ id: CLOSER_CHILD, slug: "-tmp-pr-review-closer", cwd: "/tmp/pr-review-closer", startedAt: at(2), entrypoint: "sdk-cli", root: cliProjects });

let runSeq = 0;
function cli(args: string[]): { out: string; status: number | null } {
	const copyDir = path.join(dir, `run-${runSeq++}`);
	fs.mkdirSync(copyDir, { recursive: true });
	const file = path.join(copyDir, `${PARENT}.jsonl`);
	const line = (i: number, block: unknown) => JSON.stringify({
		type: "assistant", timestamp: new Date(at(i)).toISOString(), cwd: "/nonexistent/parent", entrypoint: "cli",
		message: {
			role: "assistant", id: `parent-${i}`, model: "claude-opus-5", content: [block],
			usage: { input_tokens: 100, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	});
	fs.writeFileSync(file, [
		line(0, { type: "text", text: "dispatching" }),
		line(1, { type: "tool_use", id: "t1", name: "Bash", input: { command: HERDR_LINE } }),
		line(3, { type: "text", text: "done" }),
	].join("\n") + "\n");
	const r = spawnSync("node", [CLI_BIN, "-s", file, ...args], {
		encoding: "utf8",
		env: { ...process.env, XDG_STATE_HOME: stateHome, WTFT_CLAUDE_PROJECTS_DIR: cliProjects },
	});
	if (r.status !== 0 && r.status !== 9) throw new Error(`wtft ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
	return { out: (r.stdout || "").replace(/\x1b\[[0-9;]*m/g, ""), status: r.status };
}

{
	fs.mkdirSync(path.dirname(cliLedger), { recursive: true });
	appendSpawnRecord({ schema: SPAWN_RECORD_SCHEMA, ts: new Date(at(1)).toISOString(), parent: PARENT, child: CLOSER_CHILD, mechanism: "herdr-agent-start" }, cliLedger);
	const withRecord = JSON.parse(cli(["--json"]).out);
	check(withRecord.spawned.descendants === 1 && withRecord.spawned.unrecorded.length === 0,
		`E1 with the record the child is an edge, and the list is empty (got ${withRecord.spawned.descendants} descendants, ${withRecord.spawned.unrecorded?.length} rows)`);
	check(withRecord.schema === "wtft/session@6" && withRecord.spawned.schema === "wtft/spawn-tree@3",
		"E2 both schemas carry the new key's bump");

	fs.writeFileSync(cliLedger, "");
	const run = cli(["--json"]);
	const doc = JSON.parse(run.out);
	const listed = doc.spawned.unrecorded.find((r: any) => r.child === CLOSER_CHILD);
	check(doc.spawned.descendants === 0 && listed?.tier === "inferred" && listed?.basis === "tmp",
		`E3 delete the record and the child is listed, inferred/tmp (got ${JSON.stringify(listed)})`);
	check(Math.abs((listed?.total?.costUsd ?? 0) - withRecord.spawned.edges[0].total.costUsd) < 1e-9 && listed.total.costUsd > 0,
		"E4 with the same cost the edge carried — still visible, never dropped");
	check(Math.abs(doc.tree.costUsd - doc.total.costUsd) < 1e-9,
		"E5 and tree is total: the row is not summed");
	check(run.status === 0, `E6 a listed row does not make the report provisional (exit ${run.status})`);

	const tokens = cli(["--tokens"]).out;
	check(/UNRECORDED 1 session\(s\)/.test(tokens) && !tokens.includes("SPAWNED"),
		`E7 --tokens prints the UNRECORDED block for a session with no recorded edge:\n${tokens.split("\n").filter(l => /UNRECORDED|inferred/.test(l)).join("\n")}`);
	check(/inferred\s+1 in temp sandboxes\s+\$0\.\d/.test(tokens), "E8 inferred rows collapse to one line per basis, with the list's own cost");

	appendSpawnRecord({ schema: SPAWN_RECORD_SCHEMA, ts: new Date(at(1)).toISOString(), parent: PARENT, child: CLOSER_CHILD, mechanism: "herdr-agent-start" }, cliLedger);
	check(!cli(["--tokens"]).out.includes("UNRECORDED"), "E9 no block when the list is empty");
}

// ---
// PART D — the daemon stops re-searching a turn whose window has closed
// ---
console.log("\nPART D — a spawning turn that found nothing leaves the queue once its window closes");
{
	const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
	const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
	const rootCwd = path.join(dir, "d-own");
	fs.mkdirSync(rootCwd, { recursive: true });
	const rootDir = path.join(dir, "d-root");
	fs.mkdirSync(rootDir, { recursive: true });
	const sessionId = "a1000000-0000-4000-8000-0000000000d1";
	const rootPath = path.join(rootDir, `${sessionId}.jsonl`);
	const spawnedAt = Date.now() - 30_000;
	const commands = ["claude -p 'go'"];
	fs.writeFileSync(rootPath, JSON.stringify({
		type: "assistant", timestamp: new Date(spawnedAt).toISOString(), cwd: rootCwd, entrypoint: "cli",
		message: {
			role: "assistant", id: "d-root-turn", model: "claude-opus-5",
			content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: commands[0] } }],
			usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	}) + "\n");

	const daemon = spawn(process.execPath, [DAEMON_BIN, "--session", rootPath], { detached: true, stdio: "ignore", env: { ...process.env } });
	daemon.unref();
	const tagPath = path.join(rootDir, "wtft-tags", `${sessionId}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const outputInTag = () => readClassifiedTagFile(tagPath).reduce((sum: number, i: any) => sum + (i.outputTokens || 0), 0);
	for (let i = 0; i < 40 && outputInTag() < 100; i++) await sleep(250);
	check(outputInTag() === 100, `D1 fixture precondition: the tag holds the root turn alone (got ${outputInTag()})`);

	// Begins inside the discovery window, but is written after it closed.
	const late = "a1000001-0000-4000-8000-0000000000d2";
	writeChild({ id: late, slug: rootCwd.replace(/[^a-zA-Z0-9]/g, "-"), cwd: rootCwd, startedAt: spawnedAt + 5_000, entrypoint: "sdk-cli" });
	check(discoverClaudeSubAgentFilesForTurn(commands, spawnedAt, rootCwd).files.some(f => f.endsWith(`${late}.jsonl`)),
		"D2 fixture precondition: discovery for the turn does find the late child — only the queue can drop it");
	await sleep(3_000);
	const total = outputInTag();
	try { if (daemon.pid) process.kill(daemon.pid, "SIGTERM"); } catch { /* already gone */ }
	check(total === 100, `D3 the turn left the queue once its discovery window closed, so the late child is not folded (got ${total})`);

	const rows = listUnrecordedSpawns({ rootSessionId: sessionId, rootCwd, turns: readClassifiedTagFile(tagPath), exclude: new Set() });
	// The session's cwd is no repo, so its own directory is no worktree; the
	// sandbox sits under the temp root.
	check(rows.some(r => r.child === late && r.tier === "inferred" && r.basis === "tmp" && (r.total?.outputTokens ?? 0) === 2000),
		`D4 the listing reports it with its cost, and outside a repo it is not called a worktree (got ${JSON.stringify(rows.map(r => [r.child, r.tier, r.basis]))})`);
}

// ---
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

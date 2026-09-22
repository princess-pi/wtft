#!/usr/bin/env -S bun
/**
 * #107 A/B — discovery per spawning command, and the no-`cd` fallback.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeSpawnCwds, parseSessionFile } from "../extensions/lib/wtft-parser.ts";
import { spawn } from "node:child_process";
import { readClassifiedTagFile, WTFT_TAGGER_VERSION } from "../bin/wtft.mjs";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

isolateTmpdir("107-spawn-discovery");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-107-")));
const projects = path.join(dir, "projects");
process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;

// ---
// PART U — every spawning command contributes a directory to search
// ---
console.log("\nPART U — claudeSpawnCwds, one entry per spawning command");

const u = (commands: string[], ownCwd: string | null) => JSON.stringify(claudeSpawnCwds(commands, ownCwd));

check(u(["claude -p 'go'"], "/own") === '["/own"]',
	`U1 a spawn with no cd searches the session's own cwd (got ${u(["claude -p 'go'"], "/own")})`);
check(u(["cd /a && claude -p 'x'", "cd /b && claude -p 'y'"], "/own") === '["/a","/b"]',
	`U2 two spawns in two directories yield both, in command order (got ${u(["cd /a && claude -p 'x'", "cd /b && claude -p 'y'"], "/own")})`);
check(u(["cd /a && claude -p 'x'", "claude -p 'y'"], "/own") === '["/a","/own"]',
	`U3 a cd spawn and a bare spawn in one turn yield the cd target and the own cwd (got ${u(["cd /a && claude -p 'x'", "claude -p 'y'"], "/own")})`);
check(u(["claude -p 'go'"], null) === "[]",
	`U4 a bare spawn with no known own cwd has nothing to search (got ${u(["claude -p 'go'"], null)})`);
check(u(["cd /decoy", "cd /real && claude -p 'go'"], "/own") === '["/real"]',
	`U5 a cd in a non-spawning command supplies nothing — #106 finding B stays closed (got ${u(["cd /decoy", "cd /real && claude -p 'go'"], "/own")})`);
check(u(["cd /a && claude -p 'x'", "cd /a && claude -p 'y'"], "/own") === '["/a"]',
	`U6 two spawns in one directory search it once (got ${u(["cd /a && claude -p 'x'", "cd /a && claude -p 'y'"], "/own")})`);
check(u(["ls -la", "echo hi"], "/own") === "[]",
	`U7 a turn that spawns nothing searches nothing (got ${u(["ls -la", "echo hi"], "/own")})`);
check(u(["cd $(mktemp -d) && claude -p 'go'"], "/own") === "[]",
	`U8 a spawn whose cd target is unknowable does NOT fall back to the own cwd — it ran somewhere else (got ${u(["cd $(mktemp -d) && claude -p 'go'"], "/own")})`);
check(u(["cd /repo; cd $MISSING; claude -p 'go'"], "/own") === '["/repo"]',
	`U9 a resolvable cd followed by an unknowable one keeps the resolvable one (got ${u(["cd /repo; cd $MISSING; claude -p 'go'"], "/own")})`);
check(u(["herdr agent start x --kind claude --pane wE:pCW -- --model sonnet"], "/own") === "[]",
	`U10 a launcher that only names claude in a flag does not inherit the shell's cwd — its child starts elsewhere (got ${u(["herdr agent start x --kind claude --pane wE:pCW -- --model sonnet"], "/own")})`);
check(u(["timeout 180 claude -p 'go'"], "/own") === '["/own"]',
	`U11 a prefixed direct run still inherits the shell's cwd (got ${u(["timeout 180 claude -p 'go'"], "/own")})`);

check(u(["cd /repo; cd; claude -p 'go'"], "/own") === "[]",
	`U14 a bare cd after a resolved one clears it — the shell left /repo (got ${u(["cd /repo; cd; claude -p 'go'"], "/own")})`);
check(u(["which claude && cd /repo && claude -p 'x'"], "/own") === '["/repo"]',
	`U13 a segment that only NAMES claude does not end the cd scan (got ${u(["which claude && cd /repo && claude -p 'x'"], "/own")})`);
check(u(["cd; claude -p 'go'"], "/own") === "[]",
	`U12 a bare cd moves the shell somewhere we cannot name, so no fallback (got ${u(["cd; claude -p 'go'"], "/own")})`);

// ---
// PART A — the #107 A closer: a bare `claude -p` is attributed
// ---
console.log("\nPART A — a spawn with no cd is found in the session's own cwd");

const T0 = Date.UTC(2026, 8, 22, 5, 0, 0);

function turnLine(id: string, tsMs: number, outputTokens: number, commands: string[] = []): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso,
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6", timestamp: iso,
			usage: { input_tokens: 1000, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: commands.length > 0
				? commands.map(command => ({ type: "toolCall", name: "bash", arguments: { command } }))
				: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

function sessionLine(id: string, tsMs: number, cwd: string): string {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(tsMs).toISOString(), cwd }) + "\n";
}

/** A child transcript filed the way the harness files it: under the slug of the cwd it ran in. */
function writeChild(cwd: string, sessionId: string, tsMs: number, outputTokens: number): void {
	const projectDir = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`),
		sessionLine(sessionId, tsMs, cwd) + turnLine(`${sessionId}-turn`, tsMs, outputTokens));
}

const outputOf = (file: string) => parseSessionFile(file).reduce((sum, i) => sum + i.outputTokens, 0);

const ownCwd = path.join(dir, "own-project");
writeChild(ownCwd, "aaaa1111-1111-4111-8111-111111111111", T0 + 2_000, 700);

const bareParent = path.join(dir, "bare-parent.jsonl");
fs.writeFileSync(bareParent,
	sessionLine("parent-107-a", T0, ownCwd)
	+ turnLine("bare-parent-turn", T0, 100, ["claude -p 'go'"]));

check(outputOf(bareParent) === 800,
	`A1 a session whose only spawn is a bare claude -p carries its own 100 plus the child's 700 (got ${outputOf(bareParent)})`);

const bareFolds = parseSessionFile(bareParent).flatMap(i => i.claudeSubAgentFolds ?? []).map(f => f.id);
check(bareFolds.join() === "aaaa1111-1111-4111-8111-111111111111",
	`A2 and it records the fold, so the CLI can name the child (got ${JSON.stringify(bareFolds)})`);

// ---
// PART B — the #107 B closer: two spawns in one turn, two directories
// ---
console.log("\nPART B — one turn with two spawns attributes both children");

const cwdA = path.join(dir, "proj-a");
const cwdB = path.join(dir, "proj-b");
writeChild(cwdA, "bbbb2222-2222-4222-8222-222222222222", T0 + 2_000, 300);
writeChild(cwdB, "cccc3333-3333-4333-8333-333333333333", T0 + 3_000, 500);

const twoParent = path.join(dir, "two-parent.jsonl");
fs.writeFileSync(twoParent,
	sessionLine("parent-107-b", T0, dir)
	+ turnLine("two-parent-turn", T0, 100, [`cd ${cwdA} && claude -p 'x'`, `cd ${cwdB} && claude -p 'y'`]));

check(outputOf(twoParent) === 900,
	`B1 one turn spawning in two directories carries its own 100 plus 300 plus 500 (got ${outputOf(twoParent)})`);

const twoFolds = parseSessionFile(twoParent).flatMap(i => i.claudeSubAgentFolds ?? []).map(f => f.id).sort();
check(twoFolds.length === 2,
	`B2 and both children are recorded as folds (got ${JSON.stringify(twoFolds)})`);

// ---
// PART G — a grandchild in the same directory is billed once
// ---
console.log("\nPART G — a grandchild the child already folded is not billed again");

{
	// child and grandchild both ran in the same cwd, so both are in-window
	// matches for the PARENT's turn as well as for each other's.
	const gCwd = path.join(dir, "g-project");
	writeChild(gCwd, "1111aaaa-1111-4111-8111-aaaaaaaaaaaa", T0 + 2_000, 300);
	const gDir = path.join(projects, gCwd.replace(/[^a-zA-Z0-9]/g, "-"));
	// The child spawns the grandchild, bare, in the same directory.
	fs.writeFileSync(path.join(gDir, "2222bbbb-2222-4222-8222-bbbbbbbbbbbb.jsonl"),
		sessionLine("2222bbbb-2222-4222-8222-bbbbbbbbbbbb", T0 + 1_000, gCwd)
		+ turnLine("g-child-turn", T0 + 1_000, 50, ["claude -p 'deeper'"]));

	const gParent = path.join(dir, "g-parent.jsonl");
	fs.writeFileSync(gParent,
		sessionLine("parent-107-g", T0, gCwd)
		+ turnLine("g-parent-turn", T0, 100, ["claude -p 'go'"]));

	const gFolds = parseSessionFile(gParent).flatMap(i => i.claudeSubAgentFolds ?? []).map(f => f.id);
	check(gFolds.length === new Set(gFolds).size && gFolds.length === 2,
		`G1 each folded session is recorded once (got ${JSON.stringify(gFolds)})`);
	check(outputOf(gParent) === 450,
		`G2 the grandchild's 300 is billed once, not once inside the child and once on its own: 100 + 50 + 300 (got ${outputOf(gParent)})`);
}

// ---
// PART S — a session does not fold itself, or whatever folded it
// ---
console.log("\nPART S — the searched directory holds the session's own transcript");

{
	// A real session's own transcript lives in the very directory a bare spawn
	// now searches, and discovery matches on a timestamp window, so the session
	// is a candidate for folding itself.
	const selfCwd = path.join(dir, "self-project");
	const selfDir = path.join(projects, selfCwd.replace(/[^a-zA-Z0-9]/g, "-"));
	fs.mkdirSync(selfDir, { recursive: true });
	const selfPath = path.join(selfDir, "ffff6666-6666-4666-8666-666666666666.jsonl");
	fs.writeFileSync(selfPath,
		sessionLine("ffff6666-6666-4666-8666-666666666666", T0, selfCwd)
		+ turnLine("self-turn", T0 + 1_000, 100, ["claude -p 'go'"]));

	const found = claudeSpawnCwds(["claude -p 'go'"], selfCwd);
	check(found.join() === selfCwd,
		`S1 fixture precondition: the bare spawn searches the directory the session's own transcript is in (got ${JSON.stringify(found)})`);

	check(outputOf(selfPath) === 100,
		`S2 a session does not fold itself, however well it matches its own window (got ${outputOf(selfPath)})`);

	// Two sessions in one directory, each inside the other's window, each
	// spawning: without the ancestor guard this is a cycle — the peer folds the
	// first, which folds the peer, which folds the first.
	const peerPath = path.join(selfDir, "aaaa7777-7777-4777-8777-777777777777.jsonl");
	fs.writeFileSync(peerPath,
		sessionLine("aaaa7777-7777-4777-8777-777777777777", T0 + 2_000, selfCwd)
		+ turnLine("peer-turn", T0 + 3_000, 50, ["claude -p 'go'"]));
	check(outputOf(peerPath) === 150,
		`S3 a peer in the same window is folded once and terminates — its own fold of this session does not come back (got ${outputOf(peerPath)})`);
}

// ---
// PART D — the daemon puts a bare spawn's child in the tag file
// ---
console.log("\nPART D — the daemon retries a bare spawn instead of dropping it");

{
	const rootDir = path.join(dir, "d-daemon");
	fs.mkdirSync(rootDir, { recursive: true });
	const sessionId = "dddd4444-4444-4444-8444-444444444444";
	const rootPath = path.join(rootDir, `${sessionId}.jsonl`);
	const now = Date.now();
	fs.writeFileSync(rootPath,
		sessionLine(sessionId, now - 6_000, rootDir)
		+ turnLine("d-root-turn", now - 5_000, 100, ["claude -p 'go'"]));

	const daemon = spawn(process.execPath, [DAEMON_BIN, "--session", rootPath], { detached: true, stdio: "ignore", env: { ...process.env } });
	daemon.unref();
	const tagPath = path.join(rootDir, "wtft-tags", `${sessionId}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const outputInTag = () => readClassifiedTagFile(tagPath).reduce((sum: number, i: any) => sum + (i.outputTokens || 0), 0);

	// The child appears AFTER the daemon has already seen the spawning turn — the
	// case a drop makes unrecoverable, since nothing re-queues the turn.
	for (let i = 0; i < 40 && outputInTag() < 100; i++) await sleep(250);
	check(outputInTag() === 100,
		`D1 fixture precondition: the tag holds the root turn's 100 before the child exists (got ${outputInTag()})`);

	writeChild(rootDir, "eeee5555-5555-4555-8555-555555555555", now - 4_000, 600);
	for (let i = 0; i < 60 && outputInTag() < 700; i++) await sleep(250);
	const total = outputInTag();
	try { if (daemon.pid) process.kill(daemon.pid, "SIGTERM"); } catch { /* already gone */ }

	check(total === 700,
		`D2 #107 A a bare claude -p child reaches the tag file: 100 plus 600 (got ${total})`);
}

{
	// The session's own transcript sits in the directory its bare spawn
	// searches, inside its own window: registering it as its own child bills
	// the whole session twice.
	const selfCwd = path.join(dir, "d-self-project");
	const selfProjectDir = path.join(projects, selfCwd.replace(/[^a-zA-Z0-9]/g, "-"));
	fs.mkdirSync(selfProjectDir, { recursive: true });
	const sessionId = "bbbb8888-8888-4888-8888-888888888888";
	const rootPath = path.join(selfProjectDir, `${sessionId}.jsonl`);
	const now = Date.now();
	fs.writeFileSync(rootPath,
		sessionLine(sessionId, now - 3_000, selfCwd)
		+ turnLine("d-self-turn", now - 2_000, 100, ["claude -p 'go'"]));

	const daemon = spawn(process.execPath, [DAEMON_BIN, "--session", rootPath], { detached: true, stdio: "ignore", env: { ...process.env } });
	daemon.unref();
	const tagPath = path.join(selfProjectDir, "wtft-tags", `${sessionId}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const outputInTag = () => readClassifiedTagFile(tagPath).reduce((sum: number, i: any) => sum + (i.outputTokens || 0), 0);

	for (let i = 0; i < 40 && outputInTag() < 100; i++) await sleep(250);
	// Past the discovery window plus the settle margin, so every poll that could
	// have registered the session as its own child has run.
	await sleep(3_000);
	const raw = fs.existsSync(tagPath) ? fs.readFileSync(tagPath, "utf8") : "";
	try { if (daemon.pid) process.kill(daemon.pid, "SIGTERM"); } catch { /* already gone */ }

	// Asserted on the SOURCED lines, not on the total: this session's turns carry
	// a message id, so the reader's id dedup would hide the second copy. A
	// harness whose turns have no id — Pi — has nothing to collapse them with.
	const sourced = raw.split("\n").filter(Boolean)
		.map(l => { try { return JSON.parse(l); } catch { return null; } })
		.filter(o => o && (typeof o.s === "string" || o._fold || o._gen));
	check(sourced.length === 0,
		`D3 the daemon does not register the session's own transcript as its own child — no sourced line in its tag (got ${JSON.stringify(sourced).slice(0, 160)})`);
}

{
	// The child runs in the session's own cwd, so its transcript lands in the
	// same project dir — and its own bare spawn searches that dir and finds the
	// session that spawned it.
	const cwd = path.join(dir, "d-cycle-project");
	const projectDir = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
	fs.mkdirSync(projectDir, { recursive: true });
	const sessionId = "cccc9999-9999-4999-8999-999999999999";
	const childId = "dddd0000-0000-4000-8000-000000000000";
	const rootPath = path.join(projectDir, `${sessionId}.jsonl`);
	const now = Date.now();
	fs.writeFileSync(rootPath,
		sessionLine(sessionId, now - 6_000, cwd)
		+ turnLine("d-cycle-root", now - 5_000, 100, ["claude -p 'go'"]));
	fs.writeFileSync(path.join(projectDir, `${childId}.jsonl`),
		sessionLine(childId, now - 4_000, cwd)
		+ turnLine("d-cycle-child", now - 4_000, 60, ["claude -p 'deeper'"]));

	const daemon = spawn(process.execPath, [DAEMON_BIN, "--session", rootPath], { detached: true, stdio: "ignore", env: { ...process.env } });
	daemon.unref();
	const tagPath = path.join(projectDir, "wtft-tags", `${sessionId}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const outputInTag = () => readClassifiedTagFile(tagPath).reduce((sum: number, i: any) => sum + (i.outputTokens || 0), 0);

	for (let i = 0; i < 60 && outputInTag() < 160; i++) await sleep(250);
	await sleep(3_000);
	const total = outputInTag();
	try { if (daemon.pid) process.kill(daemon.pid, "SIGTERM"); } catch { /* already gone */ }

	check(total === 160,
		`D4 a discovered child does not fold the session that spawned it back in: 100 plus 60 (got ${total})`);
}

{
	// Root spawns bare in D; child C (in D) spawns bare too and folds grandchild
	// G (also in D). The root's own discovery returns BOTH C and G, so the daemon
	// would sync G on its own AND through C's fold of it.
	const cwd = path.join(dir, "d-grandchild-project");
	const projectDir = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
	fs.mkdirSync(projectDir, { recursive: true });
	const rootId = "3333cccc-3333-4333-8333-cccccccccccc";
	const rootPath = path.join(projectDir, `${rootId}.jsonl`);
	const now = Date.now();
	fs.writeFileSync(rootPath,
		sessionLine(rootId, now - 6_000, cwd)
		+ turnLine("d-gc-root", now - 5_000, 100, ["claude -p 'go'"]));
	fs.writeFileSync(path.join(projectDir, "4444dddd-4444-4444-8444-dddddddddddd.jsonl"),
		sessionLine("4444dddd-4444-4444-8444-dddddddddddd", now - 4_000, cwd)
		+ turnLine("d-gc-child", now - 4_000, 50, ["claude -p 'deeper'"]));
	fs.writeFileSync(path.join(projectDir, "5555eeee-5555-4555-8555-eeeeeeeeeeee.jsonl"),
		sessionLine("5555eeee-5555-4555-8555-eeeeeeeeeeee", now - 3_000, cwd)
		+ turnLine("d-gc-grand", now - 3_000, 20));

	const daemon = spawn(process.execPath, [DAEMON_BIN, "--session", rootPath], { detached: true, stdio: "ignore", env: { ...process.env } });
	daemon.unref();
	const tagPath = path.join(projectDir, "wtft-tags", `${rootId}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const outputInTag = () => readClassifiedTagFile(tagPath).reduce((sum: number, i: any) => sum + (i.outputTokens || 0), 0);

	for (let i = 0; i < 60 && outputInTag() < 170; i++) await sleep(250);
	await sleep(4_000);
	const total = outputInTag();
	check(total === 170,
		`D5 a grandchild another transcript already folded is not also synced on its own: 100 + 50 + 20 (got ${total})`);

	// The child rotates and no longer spawns, so nothing folds the grandchild
	// any more: it must come back under its own source, not stay suppressed.
	fs.writeFileSync(path.join(projectDir, "4444dddd-4444-4444-8444-dddddddddddd.jsonl"),
		sessionLine("4444dddd-4444-4444-8444-dddddddddddd", now - 4_000, cwd)
		+ turnLine("d-gc-child-2", now - 4_000, 55));
	for (let i = 0; i < 80 && outputInTag() !== 175; i++) await sleep(250);
	const afterRotate = outputInTag();
	try { if (daemon.pid) process.kill(daemon.pid, "SIGTERM"); } catch { /* already gone */ }

	check(afterRotate === 175,
		`D6 when the folder stops folding it, the grandchild is billed under its own source again: 100 + 55 + 20 (got ${afterRotate})`);
}

{
	// Two children of one turn, both in the shared project dir, both spawning:
	// each folds the other. Retiring both would empty the tag and re-adding both
	// would double it, so the total must be stable across polls.
	const cwd = path.join(dir, "d-mutual-project");
	const projectDir = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
	fs.mkdirSync(projectDir, { recursive: true });
	const rootId = "6666ffff-6666-4666-8666-ffffffffffff";
	const rootPath = path.join(projectDir, `${rootId}.jsonl`);
	const now = Date.now();
	fs.writeFileSync(rootPath,
		sessionLine(rootId, now - 6_000, cwd)
		+ turnLine("d-mut-root", now - 5_000, 100, ["claude -p 'go'"]));
	fs.writeFileSync(path.join(projectDir, "7777aaaa-7777-4777-8777-aaaaaaaaaaaa.jsonl"),
		sessionLine("7777aaaa-7777-4777-8777-aaaaaaaaaaaa", now - 4_000, cwd)
		+ turnLine("d-mut-one", now - 4_000, 40, ["claude -p 'x'"]));
	fs.writeFileSync(path.join(projectDir, "8888bbbb-8888-4888-8888-bbbbbbbbbbbb.jsonl"),
		sessionLine("8888bbbb-8888-4888-8888-bbbbbbbbbbbb", now - 3_500, cwd)
		+ turnLine("d-mut-two", now - 3_500, 30, ["claude -p 'y'"]));

	const daemon = spawn(process.execPath, [DAEMON_BIN, "--session", rootPath], { detached: true, stdio: "ignore", env: { ...process.env } });
	daemon.unref();
	const tagPath = path.join(projectDir, "wtft-tags", `${rootId}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const outputInTag = () => readClassifiedTagFile(tagPath).reduce((sum: number, i: any) => sum + (i.outputTokens || 0), 0);

	// Both children are synced before either parse reveals the mutual fold, so
	// the tag passes through 240 on the way; what matters is where it lands and
	// that it stays there.
	for (let i = 0; i < 80 && outputInTag() !== 170; i++) await sleep(250);
	const first = outputInTag();
	await sleep(4_000);
	const second = outputInTag();
	try { if (daemon.pid) process.kill(daemon.pid, "SIGTERM"); } catch { /* already gone */ }

	check(first === 170 && second === 170,
		`D7 two transcripts that fold each other settle at one of them, and the total does not oscillate: 100 + 40 + 30 (got ${first} then ${second})`);
}

{
	// Two Task children of one session, each running a bare `claude -p` in the
	// session's cwd: both discover the same nested child B in the shared project
	// dir, and each parse bakes what it folds into its own turns.
	const cwd = path.join(dir, "d-sibling-project");
	const projectDir = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
	const rootId = "9999cccc-9999-4999-8999-cccccccccccc";
	const subagentDir = path.join(projectDir, rootId, "subagents");
	fs.mkdirSync(subagentDir, { recursive: true });
	const rootPath = path.join(projectDir, `${rootId}.jsonl`);
	const now = Date.now();
	fs.writeFileSync(rootPath,
		sessionLine(rootId, now - 6_000, cwd)
		+ turnLine("d-sib-root", now - 5_000, 100));
	for (const [name, out] of [["agent-one", 40], ["agent-two", 30]] as const) {
		fs.writeFileSync(path.join(subagentDir, `${name}.jsonl`),
			sessionLine(name, now - 4_000, cwd)
			+ turnLine(`d-sib-${name}`, now - 4_000, out, ["claude -p 'go'"]));
	}
	fs.writeFileSync(path.join(projectDir, "aaaa0001-0001-4001-8001-000000000001.jsonl"),
		sessionLine("aaaa0001-0001-4001-8001-000000000001", now - 3_500, cwd)
		+ turnLine("d-sib-nested", now - 3_500, 20));

	const daemon = spawn(process.execPath, [DAEMON_BIN, "--session", rootPath], { detached: true, stdio: "ignore", env: { ...process.env } });
	daemon.unref();
	const tagPath = path.join(projectDir, "wtft-tags", `${rootId}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const outputInTag = () => readClassifiedTagFile(tagPath).reduce((sum: number, i: any) => sum + (i.outputTokens || 0), 0);

	for (let i = 0; i < 80 && outputInTag() !== 190; i++) await sleep(250);
	const first = outputInTag();
	await sleep(4_000);
	const second = outputInTag();
	try { if (daemon.pid) process.kill(daemon.pid, "SIGTERM"); } catch { /* already gone */ }

	check(first === 190 && second === 190,
		`D8 a nested child two sibling transcripts both discover is billed once: 100 + 40 + 30 + 20 (got ${first} then ${second})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

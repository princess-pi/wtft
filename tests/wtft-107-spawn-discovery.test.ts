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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

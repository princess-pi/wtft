#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-270-subagent-nested-claude-attribution
 * @description #270 review round 3 (High/correctness, bin/wtft-daemon.ts) — a
 *   SILENT OVERCOUNT of nested `claude -p` sub-agents, caused by calling
 *   attributeClaudeSubAgentCosts once per POLL BATCH.
 *
 *   attributeClaudeSubAgentCosts (extensions/lib/wtft-parser.ts) opens with
 *   `const seenSessionIds = new Set<string>()` and its docstring promises
 *   "Sub-agent session IDs are tracked globally to prevent double-counting
 *   across multiple interactions that reference the same session." That promise
 *   holds only while the function sees the WHOLE file: the set is per-call, so
 *   its scope is exactly the scope of the array handed to it. Feed it one poll
 *   batch at a time and two claude-invoking interactions in different poll
 *   windows each attribute the same nested session — its tokens and dollars are
 *   counted twice, with nothing in the output saying so.
 *
 *   This is not hypothetical for a subagent: `cd <dir> && claude -p ...` run
 *   twice in a row against the same project resolves to the same session file
 *   whenever both invocations fall inside discoverClaudeSubAgentSessionFiles'
 *   +/-15s matching window, and two bash turns seconds apart straddle the
 *   daemon's 667ms beat by construction.
 *
 *   Closer: a subagent transcript whose two claude-invoking bash turns land in
 *   DIFFERENT poll windows and resolve to the SAME nested session reads back
 *   with that nested session's cost added exactly ONCE — matching a whole-file
 *   parseSessionFile()+dedup of the same transcript.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import {
	getDaemonPidPath,
	readClassifiedTagFile,
	WTFT_TAGGER_VERSION,
} from "../bin/wtft.mjs";
import { trackSandbox } from "./lib/sandbox";

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const WTFT_LIB = path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}`); failed++; }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const cleanupPids: number[] = [];
const cleanupPidFiles: string[] = [];
const cleanupDirs: string[] = [];

/** A plain assistant turn (no tools) — the nested session's own billed work. */
function turnLine(id: string, tsMs: number, inputTokens: number, outputTokens: number): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso, // entry-level ts: what discoverClaudeSubAgentSessionFiles matches on
		message: {
			role: "assistant",
			id,
			model: "claude-sonnet-4-6",
			timestamp: iso,
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			content: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

/** An assistant turn whose bash tool call spawns `claude -p` in `cwd` — the
 *  shape attributeClaudeSubAgentCosts looks for (#138). */
function claudeBashTurnLine(id: string, tsMs: number, inputTokens: number, outputTokens: number, cwd: string): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso,
		message: {
			role: "assistant",
			id,
			model: "claude-sonnet-4-6",
			timestamp: iso,
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			content: [{
				type: "toolCall",
				name: "bash",
				arguments: { command: `cd ${cwd} && claude -p "do the thing"` },
			}],
		},
	}) + "\n";
}

console.log("wtft daemon nested claude-bash attribution across poll windows (#270 review r3)");

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-nested-")));
cleanupDirs.push(dir);

// A scratch home directory, isolated from the real ~/.claude/projects. The
// Node/Bun home-directory resolver honours the process's HOME environment
// variable on POSIX systems, so pointing every process that resolves
// ~/.claude/projects (the daemon spawned below, and the reference-parse child
// process further down) at this directory keeps every session-discovery
// lookup inside the fixture instead of the host's live transcript store.
const tempHome = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-home-")));
cleanupDirs.push(tempHome);

// The cwd the subagent's bash turns cd into. Its Claude Code project slug is
// derived from this path, so a unique fixture dir gives us a project directory
// no other session can be writing to.
const nestedCwd = path.join(dir, "nested-project");
fs.mkdirSync(nestedCwd, { recursive: true });
const slug = nestedCwd.replace(/\//g, "-");
const projectDir = path.join(tempHome, ".claude", "projects", slug);
fs.mkdirSync(projectDir, { recursive: true });

const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-270-nested", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");
const tagsDir = path.join(dir, "wtft-tags");
fs.mkdirSync(tagsDir, { recursive: true });
cleanupPidFiles.push(getDaemonPidPath(sessionPath));

const subagentDir = path.join(dir, "session", "subagents");
fs.mkdirSync(subagentDir, { recursive: true });
const subagentPath = path.join(subagentDir, "agent-nested1.jsonl");

const T0 = Date.now() - 60_000;
const TURN_A_ID = "msg_270_nested_a";
const TURN_B_ID = "msg_270_nested_b";

// The ONE nested session both bash turns resolve to. 1000 in / 100 out on
// sonnet = $0.003000 + $0.001500 = $0.004500 — the amount at stake.
const NESTED_COST = 0.0045;
fs.writeFileSync(
	path.join(projectDir, "nested-session-270.jsonl"),
	turnLine("msg_270_nested_inner", T0 + 2_000, 1000, 100),
);

// Turn A: 2000 in / 100 out = $0.007500.  Turn B: 3000 in / 100 out = $0.010500.
const TURN_A_OWN = 0.0075;
const TURN_B_OWN = 0.0105;
const EXPECTED_TOTAL = TURN_A_OWN + TURN_B_OWN + NESTED_COST; // $0.022500
const DOUBLE_COUNTED_TOTAL = EXPECTED_TOTAL + NESTED_COST;    // $0.027000

fs.writeFileSync(subagentPath, claudeBashTurnLine(TURN_A_ID, T0, 2000, 100, nestedCwd));

const tagPath = path.join(tagsDir, path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);

try {
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", sessionPath], {
		detached: true, stdio: "ignore",
		// The daemon runs discoverClaudeSubAgentSessionFiles in its own process,
		// which resolves ~/.claude/projects off the process's home directory.
		// Point it at the fixture home so it finds the fixture's project dir,
		// not the host's real one.
		env: { ...process.env, HOME: tempHome },
	});
	child.unref();
	if (child.pid) cleanupPids.push(child.pid);

	// Poll window N: only turn A exists. It attributes the nested session.
	let sawA = false;
	for (let i = 0; i < 24 && !sawA; i++) {
		await sleep(250);
		sawA = readClassifiedTagFile(tagPath).some((int: any) => int.messageId === TURN_A_ID);
	}
	assert("daemon writes the first claude-invoking bash turn", sawA);

	const seenAOnly = readClassifiedTagFile(tagPath).filter((int: any) => int.messageId === TURN_A_ID);
	const aCost = seenAOnly.reduce((s: number, i: any) => s + i.cost, 0);
	assert(
		`turn A carries the nested session's cost (daemon=$${aCost.toFixed(6)} expected=$${(TURN_A_OWN + NESTED_COST).toFixed(6)})`,
		Math.abs(aCost - (TURN_A_OWN + NESTED_COST)) < 0.000001
	);

	// Poll window N+1: turn B arrives, resolving to the SAME nested session.
	fs.appendFileSync(subagentPath, claudeBashTurnLine(TURN_B_ID, T0 + 5_000, 3000, 100, nestedCwd));

	let sawB = false;
	for (let i = 0; i < 24 && !sawB; i++) {
		await sleep(250);
		sawB = readClassifiedTagFile(tagPath).some((int: any) => int.messageId === TURN_B_ID);
	}
	assert("daemon writes the second claude-invoking bash turn", sawB);

	// Let a few more polls run — a re-parse design must not keep re-adding.
	await sleep(2000);

	const seen = readClassifiedTagFile(tagPath).filter(
		(int: any) => int.messageId === TURN_A_ID || int.messageId === TURN_B_ID
	);
	const seenCost = seen.reduce((s: number, i: any) => s + i.cost, 0);

	// parseSessionFile runs attributeClaudeSubAgentCosts internally, which calls
	// discoverClaudeSubAgentSessionFiles, and that resolves the process's home
	// directory IN THIS PROCESS. Bun captures that value once at process start
	// and never re-reads the environment afterward — probing a fresh Bun
	// process shows reassigning its home-directory environment variable
	// mid-run does not change what the resolver reports — so mutating this
	// process's environment here would be a no-op and silently fall back to
	// the host's real ~/.claude/projects. Instead, compute the reference in a
	// short-lived CHILD process spawned with its own scratch home directory,
	// the same way the daemon itself is spawned above.
	const referenceScript = path.join(dir, "reference-parse.mjs");
	fs.writeFileSync(referenceScript, `
		import { parseSessionFile, deduplicateInteractions } from ${JSON.stringify(WTFT_LIB)};
		const interactions = deduplicateInteractions(parseSessionFile(process.argv[2]));
		const cost = interactions.reduce((s, i) => s + i.cost, 0);
		process.stdout.write(JSON.stringify({ cost }));
	`);
	const referenceOut = execFileSync(process.execPath, [referenceScript, subagentPath], {
		env: { ...process.env, HOME: tempHome },
		encoding: "utf8",
	});
	const referenceCost = JSON.parse(referenceOut).cost as number;

	assert(
		`whole-file reference attributes the nested session ONCE (ref=$${referenceCost.toFixed(6)} expected=$${EXPECTED_TOTAL.toFixed(6)})`,
		Math.abs(referenceCost - EXPECTED_TOTAL) < 0.000001
	);
	assert(
		`daemon attributes the nested session ONCE, not once per poll window (daemon=$${seenCost.toFixed(6)} expected=$${EXPECTED_TOTAL.toFixed(6)}, double-counted would be $${DOUBLE_COUNTED_TOTAL.toFixed(6)})`,
		Math.abs(seenCost - EXPECTED_TOTAL) < 0.000001
	);
	assert(
		`daemon total matches the whole-file reference within $0.000001 (daemon=$${seenCost.toFixed(6)} ref=$${referenceCost.toFixed(6)})`,
		Math.abs(seenCost - referenceCost) < 0.000001
	);
} finally {
	for (const pid of cleanupPids) { try { process.kill(pid, "SIGTERM"); } catch {} }
	for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch {} }
	await sleep(200);
	for (const d of cleanupDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

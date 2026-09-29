#!/usr/bin/env bun
/**
 * wtft-daemon --list names, on each lease a harness holds, the session that lease is for.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { sessionsByLease } from "../extensions/lib/harness-registry.ts";

isolateTmpdir("276");

const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const byLease = sessionsByLease([
	'{"kind":"served","displayed":true,"path":"/r/a.jsonl"}\n{"kind":"idle","displayed":false,"path":"/r/b.jsonl"}\n',
	'not json\n{"kind":"served","displayed":false,"path":"/r/c.jsonl"}\n',
], s => `lease-${path.basename(s)}`);
check(byLease.get("lease-a.jsonl") === "/r/a.jsonl" && byLease.get("lease-b.jsonl") === "/r/b.jsonl" && byLease.get("lease-c.jsonl") === "/r/c.jsonl" && byLease.size === 3,
	`sessionsByLease maps each hand-off record's lease to its session (got ${JSON.stringify([...byLease])})`);

const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-276-")));
const claudeRoot = path.join(root, "claude");
fs.mkdirSync(path.join(claudeRoot, "proj"), { recursive: true });
const turn = (id: string) => JSON.stringify({
	type: "message", timestamp: new Date().toISOString(),
	message: { role: "assistant", id, model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "ok" }] },
}) + "\n";
const s1 = path.join(claudeRoot, "proj", "one.jsonl");
const s2 = path.join(claudeRoot, "proj", "two.jsonl");
fs.writeFileSync(s1, turn("a"));
fs.writeFileSync(s2, turn("b"));
const env = { ...process.env, WTFT_CLAUDE_PROJECTS_DIR: claudeRoot };

const pids: number[] = [];
function start(args: string[]): number {
	const child = spawn("node", [DAEMON, ...args], { detached: true, stdio: "ignore", env });
	child.unref();
	if (child.pid) pids.push(child.pid);
	return child.pid ?? 0;
}

try {
	const harness = start(["--harness", "claude", "--session", s1]);
	await sleep(1500);
	const asker = spawn("node", [DAEMON, "--harness", "claude", "--session", s2], { stdio: "ignore", env });
	await new Promise(r => asker.on("exit", r));

	let lines: string[] = [];
	for (const until = Date.now() + 30_000; Date.now() < until;) {
		const out = execFileSync("node", [DAEMON, "--list"], { encoding: "utf8", env });
		lines = out.split("\n").filter(l => l.startsWith(`PID ${harness} `) && l.includes("RUNNING"));
		if (lines.length >= 2 && lines.some(l => l.endsWith(s2))) break;
		await sleep(250);
	}
	check(lines.length === 2, `fixture: the harness holds two leases (got ${lines.length}: ${lines.join(" | ")})`);
	check(lines.filter(l => l.endsWith(s1)).length === 1 && lines.filter(l => l.endsWith(s2)).length === 1,
		`one lease line names each session (got ${lines.join(" | ")})`);
} finally {
	for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

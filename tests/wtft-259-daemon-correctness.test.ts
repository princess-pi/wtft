#!/usr/bin/env bun
/**
 * Daemon correctness items split out of #256: arguments, swept, resume,
 * leases, adoption, focus requests, the hand-off, sweep liveness, harness
 * exit and the stop reason. Spec: docs/spec-259-daemon-correctness.md.
 * --cleanup is not run here: it stops every fixture daemon under /tmp,
 * including other suites'.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { getCurrentVersionTagPath, getDaemonPidPath, readClassifiedTagFile } from "../extensions/lib/wtft-daemon-lib.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

const TMP = isolateTmpdir("259-correctness");

const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

function turnLine(id: string, ts: number, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "assistant", timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6",
			usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: [{ type: "text", text: "t" }],
		},
		...extra,
	}) + "\n";
}

function makeRoot(label: string): string {
	return trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), `wtft-259-${label}-`)));
}

/** A session file under `root`, holding one turn. */
function session(root: string, name: string, id = name): string {
	const dir = path.join(root, "proj");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.jsonl`);
	fs.writeFileSync(file, turnLine(id, Date.now()));
	return file;
}

const envFor = (root: string) => ({
	...process.env,
	WTFT_DAEMON_DEBUG: "1",
	WTFT_CLAUDE_PROJECTS_DIR: root,
	WTFT_PI_SESSIONS_DIR: path.join(root, "no-pi"),
});

const pids: number[] = [];
function start(root: string, args: string[], errName: string, extraEnv: Record<string, string> = {}): { pid: number; err: string } {
	const err = path.join(root, errName);
	const fd = fs.openSync(err, "a");
	const child = spawn("node", [DAEMON, ...args], { detached: true, stdio: ["ignore", "ignore", fd], env: { ...envFor(root), ...extraEnv } });
	child.unref();
	fs.closeSync(fd);
	if (child.pid) pids.push(child.pid);
	return { pid: child.pid ?? 0, err };
}

function run(root: string, args: string[], extraEnv: Record<string, string> = {}, cwd?: string) {
	return spawnSync("node", [DAEMON, ...args], { encoding: "utf8", env: { ...envFor(root), ...extraEnv }, cwd, timeout: 30_000 });
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const harnessPidFile = (root: string) =>
	path.join(TMP, `wtft-harness-claude-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12)}.pid`);
const classified = (file: string, id: string) => {
	try { return readClassifiedTagFile(getCurrentVersionTagPath(file)).some((r: { messageId?: string }) => r.messageId === id); }
	catch { return false; }
};

async function until(pred: () => boolean, limitMs: number): Promise<number> {
	const t = Date.now();
	while (Date.now() - t < limitMs) {
		if (pred()) return Date.now() - t;
		await sleep(50);
	}
	return Infinity;
}

try {
	console.log("\nArguments");
	{
		const root = makeRoot("args");
		const unknown = run(root, ["--bogus"]);
		check(unknown.status === 2 && unknown.stderr.includes("Usage:"), `an unknown argument exits 2 with the usage line (exit ${unknown.status})`);
		const reparse = run(root, ["--reparse", path.join(root, "x.jsonl")]);
		check(reparse.status === 2, `--reparse is an unknown argument (exit ${reparse.status})`);
		const range = run(root, ["--reparse-range", "2026-09-01", "2026-09-02"]);
		check(range.status === 2, `--reparse-range is an unknown argument (exit ${range.status})`);
		const noValue = run(root, ["--stop"]);
		check(noValue.status === 2 && noValue.stderr.includes("Usage:"), `a flag missing its value exits 2 (exit ${noValue.status})`);

		const file = session(root, "alias");
		const h = start(root, ["--harness", "claude-code", "--session", file], "alias.err");
		const served = await until(() => classified(file, "alias"), 15_000);
		check(served < Infinity && read(harnessPidFile(root)).trim() === String(h.pid),
			"--harness claude-code serves the claude root under its pid file");
	}

	console.log("\nSwept means every subagent turn is written");
	{
		const root = makeRoot("swept");
		const file = session(root, "swept-main");
		const sub = path.join(file.slice(0, -".jsonl".length), "subagents");
		fs.mkdirSync(sub, { recursive: true });
		fs.writeFileSync(path.join(sub, "agent-a.jsonl"), turnLine("sw-sub-1", Date.now()) + turnLine("sw-sub-2", Date.now()));
		const tag = getCurrentVersionTagPath(file);
		const d = start(root, ["--session", file], "swept.err");
		check(await until(() => classified(file, "sw-sub-2") && read(tag).includes('"swept"'), 15_000) !== Infinity,
			"fixture: the daemon wrote the subagent's last turn and stamped the tag swept");
		const lines = read(tag).split("\n");
		const firstSwept = lines.findIndex(l => l.includes('"swept"'));
		const lastTurn = lines.findIndex(l => l.includes('"sw-sub-2"'));
		check(lastTurn >= 0 && lastTurn < firstSwept,
			`the tag is stamped swept only after the held-back turn is written (turn line ${lastTurn}, swept line ${firstSwept})`);
		process.kill(d.pid, "SIGTERM");
	}
} finally {
	for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

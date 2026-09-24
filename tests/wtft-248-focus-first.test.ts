#!/usr/bin/env bun
/**
 * A harness daemon with many sessions to rebuild serves the session a reader
 * asked for first, whether it was asked for at startup or while the rebuild
 * was running.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { WTFT_TAGGER_VERSION } from "../extensions/lib/wtft-tagger-version.ts";
import { waitingForDataLine, restartDaemon, getDaemonPidPath, getCurrentVersionTagPath } from "../extensions/lib/wtft-daemon-lib.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("248-focus-first");

const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const SESSIONS = 1500;
const TURNS = 120;
const T0 = Date.now() - 3_600_000;

function turnLine(id: string, ts: number): string {
	return JSON.stringify({
		type: "assistant", timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6",
			usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: [{ type: "text", text: "t" }],
		},
	}) + "\n";
}

/** A fresh root of `SESSIONS` sessions with no tags, so the harness rebuilds all of them. */
function makeRoot(label: string): { root: string; files: string[] } {
	const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), `wtft-248-${label}-`)));
	const files: string[] = [];
	for (let i = 0; i < SESSIONS; i++) {
		const dir = path.join(root, `proj-${i % 30}`);
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `s-${label}-${i}.jsonl`);
		let body = "";
		for (let k = 0; k < TURNS; k++) body += turnLine(`${label}-${i}-${k}`, T0 + k);
		fs.writeFileSync(file, body);
		files.push(file);
	}
	return { root, files };
}

const tagOf = (file: string) => path.join(path.dirname(file), "wtft-tags", `${path.basename(file)}.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
const tagged = (file: string) => {
	try { return fs.readFileSync(tagOf(file), "utf8").includes(`"id":"`); } catch { return false; }
};

const pids: number[] = [];
function start(root: string, args: string[]): number {
	const child = spawn(process.execPath, [DAEMON, "--harness", "claude", ...args], {
		detached: true, stdio: "ignore",
		env: { ...process.env, WTFT_CLAUDE_PROJECTS_DIR: root, WTFT_PI_SESSIONS_DIR: path.join(root, "no-pi") },
	});
	child.unref();
	if (child.pid) pids.push(child.pid);
	return child.pid ?? 0;
}

/** Milliseconds until `pred` holds, or Infinity after `limitMs`. */
async function until(pred: () => boolean, limitMs: number): Promise<number> {
	const t = Date.now();
	while (Date.now() - t < limitMs) {
		if (pred()) return Date.now() - t;
		await sleep(50);
	}
	return Infinity;
}

const countTagged = (files: string[]) => files.filter(tagged).length;

try {
	console.log("\nA session named at startup is rebuilt first");
	{
		const { root, files } = makeRoot("a");
		const target = files[Math.floor(files.length * 0.7)];
		start(root, ["--session", target]);
		await until(() => tagged(target), 30_000);
		const others = countTagged(files.filter(f => f !== target));
		check(others < 50, `the focused session is rebuilt before the others: ${others} of ${SESSIONS - 1} others had a tag when it did`);
		for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
		await sleep(300);
	}

	console.log("\nA session asked for while the rebuild runs is served next");
	{
		const { root, files } = makeRoot("b");
		start(root, []);
		await until(() => countTagged(files) > 100, 20_000);
		const untaggedNow = files.filter(f => !fs.existsSync(tagOf(f)));
		const target = untaggedNow[Math.floor(untaggedNow.length * 0.8)];
		const before = countTagged(files);
		check(before < SESSIONS - 200, `fixture: the rebuild was still running when the request was made (${before} of ${SESSIONS})`);
		start(root, ["--session", target]);
		await until(() => tagged(target), 30_000);
		const after = countTagged(files);
		// The request is made by a second process, which takes a node start-up
		// to reach the live one; in walk order the target would come after
		// roughly 1,000 more sessions.
		check(after - before < 400, `the requested session is served next: ${after - before} other sessions were rebuilt between the request and it`);
	}

	console.log("\n--watch says a stale tag is being rebuilt");
	{
		const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-248-line-")));
		const session = path.join(dir, "s.jsonl");
		fs.writeFileSync(session, turnLine("x", T0));
		const current = getCurrentVersionTagPath(session);
		check(waitingForDataLine(session, current) === "Waiting for session data...", "no tag at all: the plain waiting line");
		fs.mkdirSync(path.join(dir, "wtft-tags"));
		fs.writeFileSync(path.join(dir, "wtft-tags", "s.jsonl.wtft-tag.v0.9.0.jsonl"), "{}\n");
		const line = waitingForDataLine(session, current);
		check(line.includes("Rebuilding") && line.includes("v0.9.0") && line.includes(`v${WTFT_TAGGER_VERSION}`),
			`a stale-version tag: the line names the rebuild and both versions (got ${line})`);
	}

	console.log("\n'r' in --watch never stops a harness daemon");
	{
		const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-248-r-")));
		const session = path.join(dir, "s.jsonl");
		fs.writeFileSync(session, turnLine("y", T0));
		const harness = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)", "--harness", "claude"], { stdio: "ignore" });
		await sleep(300);
		fs.writeFileSync(getDaemonPidPath(session), String(harness.pid));
		const noop = path.join(dir, "noop.mjs");
		fs.writeFileSync(noop, "");
		restartDaemon(session, noop);
		await sleep(300);
		let alive = true;
		try { process.kill(harness.pid!, 0); } catch { alive = false; }
		check(alive, "the harness process named by the lease is still running");
		check(fs.readFileSync(getDaemonPidPath(session), "utf8").trim() === String(harness.pid), "and the lease still names it");
		harness.kill("SIGKILL");
	}
} finally {
	for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
	await sleep(300);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

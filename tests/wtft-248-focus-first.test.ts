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
import { waitingForDataLine, restartDaemon, getDaemonPidPath } from "../extensions/lib/wtft-daemon-lib.ts";
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

/** A fresh root of `SESSIONS` sessions whose only tags are an older version,
 *  so the harness rebuilds all of them. `files` is in the harness's walk order:
 *  directory by directory, each in `readdir` order. */
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
		fs.mkdirSync(path.join(dir, "wtft-tags"), { recursive: true });
		fs.writeFileSync(path.join(dir, "wtft-tags", `${path.basename(file)}.wtft-tag.v0.9.0.jsonl`), "{}\n");
	}
	for (const d of fs.readdirSync(root, { withFileTypes: true })) {
		if (!d.isDirectory()) continue;
		for (const f of fs.readdirSync(path.join(root, d.name))) {
			if (f.endsWith(".jsonl")) files.push(path.join(root, d.name, f));
		}
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
		const target = files[files.length - 1];
		start(root, ["--session", target]);
		const took = await until(() => tagged(target), 30_000);
		const others = countTagged(files.filter(f => f !== target));
		check(took !== Infinity, `the focused session was tagged (${took} ms after start)`);
		check(others < 50, `it came first, not last in walk order: ${others} of ${SESSIONS - 1} others had a tag then`);
		for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
		await sleep(300);
	}

	console.log("\nA session asked for while the rebuild runs is served next");
	{
		const { root, files } = makeRoot("b");
		start(root, []);
		const warm = await until(() => countTagged(files) > 100, 20_000);
		check(warm !== Infinity, "fixture: the harness started its rebuild");
		const target = [...files].reverse().find(f => !tagged(f))!;
		const before = countTagged(files);
		const remaining = files.length - files.indexOf(target) - 1;
		check(before < SESSIONS - 200, `fixture: the rebuild was still running at the request (${before} of ${SESSIONS})`);
		start(root, ["--session", target]);
		const took = await until(() => tagged(target), 30_000);
		const between = countTagged(files) - before;
		check(took !== Infinity, `the requested session was tagged (${took} ms after the request was spawned)`);
		// A second process makes the request, so a node start-up passes first.
		check(between < (files.indexOf(target) - before) / 2,
			`it was served ahead of its walk position: ${between} others were rebuilt meanwhile, of ${files.indexOf(target) - before} ahead of it (${remaining} after it)`);
	}

	console.log("\nA newer build replaces a harness from an older tagger");
	{
		for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
		await sleep(500);
		const { root, files } = makeRoot("c");
		const first = start(root, []);
		const pidFile = () => fs.readdirSync(os.tmpdir()).filter(n => /^wtft-harness-claude-[0-9a-f]+\.pid$/.test(n)).map(n => path.join(os.tmpdir(), n));
		await until(() => pidFile().some(f => { try { return fs.readFileSync(f, "utf8").trim() === String(first); } catch { return false; } }), 10_000);
		const owned = pidFile().find(f => fs.readFileSync(f, "utf8").trim() === String(first))!;
		check(!!owned && fs.readFileSync(`${owned}.version`, "utf8").trim() === WTFT_TAGGER_VERSION, "fixture: the running harness recorded its tagger version");
		fs.writeFileSync(`${owned}.version`, "0.0.1");
		const target = files[files.length - 1];
		const second = start(root, ["--session", target]);
		const replaced = await until(() => { try { process.kill(first, 0); return false; } catch { return true; } }, 10_000);
		check(replaced !== Infinity, "the older harness is stopped");
		check(await until(() => fs.readFileSync(owned, "utf8").trim() === String(second), 10_000) !== Infinity, "the newer one holds the harness lease");
		check(await until(() => tagged(target), 30_000) !== Infinity, "and it serves the session it was started for");
	}

	console.log("\n--watch says a stale tag is being rebuilt");
	{
		const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-248-line-")));
		const session = path.join(dir, "s.jsonl");
		fs.writeFileSync(session, turnLine("x", T0));
		check(waitingForDataLine(session) === "Waiting for session data...", "no tag at all: the plain waiting line");
		fs.mkdirSync(path.join(dir, "wtft-tags"));
		fs.writeFileSync(path.join(dir, "wtft-tags", "s.jsonl.wtft-tag.v0.9.0.jsonl"), "{}\n");
		const line = waitingForDataLine(session);
		check(line.includes("v0.9.0") && line.includes(`v${WTFT_TAGGER_VERSION}`) && line.includes("log parser daemon"),
			`a stale-version tag: the line names both versions and the daemon it waits on (got ${line})`);
		fs.writeFileSync(path.join(dir, "wtft-tags", `s.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`), "{}\n");
		check(waitingForDataLine(session) === "Waiting for session data...", "once this version's tag exists, the older one beside it is not mentioned");
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

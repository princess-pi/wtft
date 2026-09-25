#!/usr/bin/env bun
/**
 * #205 — one daemon per harness, fs.watch.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { deduplicateInteractions, parseSessionFile } from "../extensions/lib/wtft-parser.ts";
import { daemonLaunchArgs, getCurrentVersionTagPath, readClassifiedTagFile, WTFT_TAGGER_VERSION } from "../extensions/lib/wtft-daemon-lib.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("205-harness");

const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
// The runtime the daemon ships on (docs/spec-239-harness-lifecycle.md).
const DAEMON_RUNTIME = "node";
const POLL_MS = 667;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean) {
	if (ok) { console.log(`  PASS ${label}`); passed++; }
	else { console.log(`  FAIL ${label}`); failed++; }
}

function turnLine(id: string, tsMs: number, outputTokens: number): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso,
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6", timestamp: iso,
			usage: { input_tokens: 1000, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

function rssKb(pid: number): number {
	const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
	const match = status.match(/VmRSS:\s+(\d+)/);
	return match ? Number(match[1]) : -1;
}

const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-205-")));
const claudeRoot = path.join(root, "claude");
const piRoot = path.join(root, "pi");
fs.mkdirSync(path.join(claudeRoot, "proj"), { recursive: true });
fs.mkdirSync(path.join(piRoot, "slug"), { recursive: true });

const N = 100;
const T0 = Date.now() - 60_000;
const claudeFiles: string[] = [];
const piFiles: string[] = [];
for (let i = 0; i < N; i++) {
	const claude = path.join(claudeRoot, "proj", `s-${i}.jsonl`);
	const pi = path.join(piRoot, "slug", `p-${i}.jsonl`);
	fs.writeFileSync(claude, turnLine(`c-${i}`, T0 + i, 10));
	fs.writeFileSync(pi, turnLine(`p-${i}`, T0 + i, 10));
	claudeFiles.push(claude);
	piFiles.push(pi);
}
fs.mkdirSync(path.join(claudeRoot, "proj", "s-0", "subagents"), { recursive: true });

const env = {
	...process.env,
	WTFT_DAEMON_DEBUG: "1",
	WTFT_CLAUDE_PROJECTS_DIR: claudeRoot,
	WTFT_PI_SESSIONS_DIR: piRoot,
};
const pids: number[] = [];
const stderrPaths: string[] = [];

function start(args: string[], stderrName: string, extraEnv?: Record<string, string>): number {
	const stderrPath = path.join(root, stderrName);
	stderrPaths.push(stderrPath);
	const fd = fs.openSync(stderrPath, "a");
	const child = spawn(DAEMON_RUNTIME, [DAEMON, ...args], {
		detached: true,
		stdio: ["ignore", "ignore", fd],
		env: extraEnv ? { ...env, ...extraEnv } : env,
	});
	child.unref();
	fs.closeSync(fd);
	if (child.pid) pids.push(child.pid);
	return child.pid ?? 0;
}

/** Waits for the event itself, up to `tries` × 100 ms of wall time, so a
 *  loaded host is slower but not failed. */
async function waitFor(label: string, pred: () => boolean, tries = 300): Promise<boolean> {
	const deadline = Date.now() + tries * 100;
	while (Date.now() < deadline) {
		if (pred()) return true;
		await sleep(100);
	}
	assert(label, false);
	return false;
}

console.log("wtft one daemon per harness (#205)");

{
	const custom = "/tmp/wtft-custom-projects-root";
	const under = daemonLaunchArgs(`${custom}/proj/session.jsonl`, { WTFT_CLAUDE_PROJECTS_DIR: custom } as NodeJS.ProcessEnv);
	const plain = daemonLaunchArgs(`${custom}/proj/session.jsonl`, {} as NodeJS.ProcessEnv);
	assert("restart env keeps a custom projects root on --harness", under[0] === "--harness" && under[1] === "claude");
	assert("without that root the same path stays a per-session daemon", plain.length === 2 && plain[0] === "--session");
}

try {
	const claudePid = start(["--harness", "claude"], "claude.err");
	const claudeErr = path.join(root, "claude.err");
	const sawPid = await waitFor("claude harness publishes its pid", () => fs.readFileSync(claudeErr, "utf8").includes("harness pid "));
	if (!sawPid) throw new Error("claude daemon did not start");

	const second = start(["--harness", "claude"], "claude-2.err");
	const secondGone = await waitFor("a second claude harness exits", () => !alive(second));
	assert("a second claude harness does not stay up", secondGone && !alive(second));

	const piPid = start(["--harness", "pi"], "pi.err");
	const piErr = path.join(root, "pi.err");
	await waitFor("pi harness settles", () => fs.readFileSync(piErr, "utf8").includes("harness settled pi"));
	// A harness serves only the sessions it is asked for.
	for (const f of [...claudeFiles.slice(0, 5), claudeFiles[N - 1]]) start(["--harness", "claude", "--session", f], `ask-${path.basename(f)}.err`);
	start(["--harness", "pi", "--session", piFiles[N - 1]], "ask-pi.err");

	const lastClaudeTag = getCurrentVersionTagPath(claudeFiles[N - 1]);
	const lastPiTag = getCurrentVersionTagPath(piFiles[N - 1]);
	const settled = await waitFor(
		"both harnesses classify their last fixture",
		() => {
			try {
				const asked = [0, 1, 2, 3, 4].every(i => readClassifiedTagFile(getCurrentVersionTagPath(claudeFiles[i])).some((row: { messageId?: string }) => row.messageId === `c-${i}`));
				const claudeHit = asked && readClassifiedTagFile(lastClaudeTag).some((row: { messageId?: string }) => row.messageId === `c-${N - 1}`);
				const piHit = readClassifiedTagFile(lastPiTag).some((row: { messageId?: string }) => row.messageId === `p-${N - 1}`);
				return claudeHit && piHit;
			} catch {
				return false;
			}
		},
		300,
	);
	assert("the requested claude and pi sessions are classified", settled);
	assert(
		"a claude session nobody asked for is not",
		!fs.existsSync(getCurrentVersionTagPath(claudeFiles[50])),
	);

	// Every live daemon whose harness roots are this fixture's, not only the
	// two this suite started, so a third process would be counted.
	const daemonsHere = fs.readdirSync("/proc").filter(p => /^\d+$/.test(p)).filter(p => {
		let cmd = "", env = "";
		try { cmd = fs.readFileSync(`/proc/${p}/cmdline`, "utf8"); env = fs.readFileSync(`/proc/${p}/environ`, "utf8"); } catch { return false; }
		return cmd.split("\0").some(a => path.basename(a) === "wtft-daemon.mjs")
			&& env.split("\0").includes(`WTFT_CLAUDE_PROJECTS_DIR=${claudeRoot}`);
	}).map(Number).filter(alive);
	assert(`process count for 200 files is 2 (saw ${daemonsHere.length}: ${daemonsHere.join(", ")})`,
		daemonsHere.length === 2 && daemonsHere.includes(claudePid) && daemonsHere.includes(piPid));

	const rss = rssKb(claudePid);
	assert(`claude daemon RSS is under 200 MB (saw ${rss} kB)`, rss > 0 && rss < 200 * 1024);

	await waitFor("claude harness settled", () => fs.readFileSync(claudeErr, "utf8").includes("harness settled claude"));
	const quietAt = fs.statSync(claudeErr).size;
	await sleep(2500);
	const quietLog = fs.readFileSync(claudeErr, "utf8").slice(quietAt);
	assert("a quiet few seconds does not stat a fixture", !quietLog.includes("session stat "));

	const target = claudeFiles[0];
	fs.appendFileSync(target, turnLine("c-extra", T0 + 500_000, 20));
	const sawExtra = await waitFor("the appended turn is classified", () =>
		readClassifiedTagFile(getCurrentVersionTagPath(target)).some((row: { messageId?: string }) => row.messageId === "c-extra"),
	);
	assert("a write to one fixture is classified", sawExtra);
	const after = fs.readFileSync(claudeErr, "utf8").slice(quietAt);
	const deltas = [...after.matchAll(/session delta \d+ bytes (\S+)/g)].map(m => m[1]);
	assert(
		`that write does not read the other fixtures (${deltas.join(",")})`,
		deltas.length > 0 && deltas.every(name => name === "s-0.jsonl"),
	);
	const seen = readClassifiedTagFile(getCurrentVersionTagPath(target));
	const reference = deduplicateInteractions(parseSessionFile(target));
	const cost = (rows: { cost: number }[]) => rows.reduce((sum, row) => sum + row.cost, 0);
	assert(
		"classified cost matches a straight parse",
		Math.abs(cost(seen) - cost(reference)) < 0.000001,
	);

	fs.writeFileSync(
		path.join(claudeRoot, "proj", "s-0", "subagents", "agent-late.jsonl"),
		turnLine("child-late", T0 + 900_000, 9),
	);
	const sawChild = await waitFor("a late subagent transcript is folded", () =>
		readClassifiedTagFile(getCurrentVersionTagPath(target)).some((row: { messageId?: string }) => row.messageId === "child-late"),
	);
	assert("a subagent file written after the parent is quiet is still classified", sawChild);

	const burst = claudeFiles[1];
	const burstErrAt = fs.statSync(claudeErr).size;
	fs.appendFileSync(burst, turnLine("burst-a", T0 + 600_000, 3));
	const firstFlush = await waitFor("the first burst wave flushes", () =>
		fs.readFileSync(claudeErr, "utf8").slice(burstErrAt).includes("session flush "),
	);
	fs.appendFileSync(burst, turnLine("burst-b", T0 + 601_000, 4));
	await waitFor("the second burst wave flushes", () =>
		[...fs.readFileSync(claudeErr, "utf8").slice(burstErrAt).matchAll(/session flush \d+ s-1\.jsonl/g)].length >= 2
		&& readClassifiedTagFile(getCurrentVersionTagPath(burst)).some((row: { messageId?: string }) => row.messageId === "burst-b"),
	);
	const flushTimes = [...fs.readFileSync(claudeErr, "utf8").slice(burstErrAt).matchAll(/session flush (\d+) s-1\.jsonl/g)].map(m => Number(m[1]));
	const gaps = flushTimes.slice(1).map((t, i) => t - flushTimes[i]);
	assert(
		`flushes for one file stay at least POLL_MS apart (${flushTimes.join(",")})`,
		firstFlush && flushTimes.length >= 2 && gaps.every(gap => gap >= POLL_MS - 50),
	);
	const burstIds = readClassifiedTagFile(getCurrentVersionTagPath(burst)).map((row: { messageId?: string }) => row.messageId);
	assert("both burst turns are classified", burstIds.includes("burst-a") && burstIds.includes("burst-b"));

	const replaced = claudeFiles[2];
	const next = replaced + ".next";
	fs.writeFileSync(next, turnLine("replaced", T0 + 700_000, 7));
	fs.renameSync(next, replaced);
	const sawReplaced = await waitFor("a replaced inode keeps being classified", () =>
		readClassifiedTagFile(getCurrentVersionTagPath(replaced)).some((row: { messageId?: string }) => row.messageId === "replaced"),
	);
	assert("renaming a new file onto the path still classifies it", sawReplaced);

	fs.unlinkSync(claudeFiles[3]);
	const deleted = await waitFor("a deleted fixture is dropped", () =>
		fs.readFileSync(claudeErr, "utf8").includes("session drop s-3.jsonl"),
	);
	assert("a deleted fixture drops that session and the process stays", deleted && alive(claudePid));

	const stop = spawnSync(process.execPath, [DAEMON, "--stop", claudeFiles[4]], { encoding: "utf8", env });
	const stopDropped = await waitFor("stop drops one harness session", () =>
		fs.readFileSync(claudeErr, "utf8").includes("session drop s-4.jsonl"),
	);
	assert(
		"stopping one session leaves the harness process up",
		stop.status === 0 && stopDropped && alive(claudePid) && stop.stdout.includes("dropped from harness"),
	);


	for (const pid of [claudePid, piPid]) {
		try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
	}
	await waitFor("harness daemons exit", () => !alive(claudePid) && !alive(piPid));

	const idleDir = path.join(claudeRoot, "idleproj");
	fs.mkdirSync(idleDir, { recursive: true });
	const idleFile = path.join(idleDir, "idle.jsonl");
	fs.writeFileSync(idleFile, turnLine("idle-0", T0, 10));
	const idlePid = start(["--harness", "claude", "--session", idleFile], "idle.err", {
		WTFT_DAEMON_IDLE_MS: "400",
		WTFT_DAEMON_STARTUP_GRACE_MS: "0",
	});
	const idleErr = path.join(root, "idle.err");
	const idleDropped = await waitFor(
		"an idle session is dropped",
		() => fs.existsSync(idleErr) && fs.readFileSync(idleErr, "utf8").includes("session drop idle.jsonl"),
		300,
	);
	assert("idle drop leaves the harness process up", idleDropped && alive(idlePid));

	const emptyClaude = path.join(root, "empty-claude");
	const emptyPi = path.join(root, "empty-pi");
	fs.mkdirSync(emptyClaude, { recursive: true });
	fs.mkdirSync(emptyPi, { recursive: true });
	const emptyPid = start(["--harness", "claude"], "empty.err", {
		WTFT_CLAUDE_PROJECTS_DIR: emptyClaude,
		WTFT_PI_SESSIONS_DIR: emptyPi,
	});
	const emptyErr = path.join(root, "empty.err");
	const emptyUp = await waitFor(
		"an empty harness publishes its pid",
		() => fs.existsSync(emptyErr) && fs.readFileSync(emptyErr, "utf8").includes("harness pid "),
	);
	const restart = spawnSync(process.execPath, [DAEMON, "--restart"], { encoding: "utf8", env });
	const emptyGone = await waitFor("the empty harness exits after restart", () => !alive(emptyPid));
	assert(
		"restart stops a harness that holds no session lease",
		emptyUp && restart.status === 0 && emptyGone && restart.stdout.includes("harness wtft-harness-"),
	);
} finally {
	for (const pid of pids) {
		try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
	}
	await sleep(200);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

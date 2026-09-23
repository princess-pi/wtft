#!/usr/bin/env bun
/**
 * #205 — one daemon per harness, fs.watch, historical reparse.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { deduplicateInteractions, parseSessionFile } from "../extensions/lib/wtft-parser.ts";
import { getCurrentVersionTagPath, readClassifiedTagFile, WTFT_TAGGER_VERSION } from "../extensions/lib/wtft-daemon-lib.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("205-harness");

const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
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
	const child = spawn(process.execPath, [DAEMON, ...args], {
		detached: true,
		stdio: ["ignore", "ignore", fd],
		env: extraEnv ? { ...env, ...extraEnv } : env,
	});
	child.unref();
	fs.closeSync(fd);
	if (child.pid) pids.push(child.pid);
	return child.pid ?? 0;
}

async function waitFor(label: string, pred: () => boolean, tries = 80): Promise<boolean> {
	for (let i = 0; i < tries; i++) {
		if (pred()) return true;
		await sleep(100);
	}
	assert(label, false);
	return false;
}

console.log("wtft one daemon per harness (#205)");

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

	const lastClaudeTag = getCurrentVersionTagPath(claudeFiles[N - 1]);
	const lastPiTag = getCurrentVersionTagPath(piFiles[N - 1]);
	const settled = await waitFor(
		"both harnesses classify their last fixture",
		() => {
			try {
				const claudeHit = readClassifiedTagFile(lastClaudeTag).some((row: { messageId?: string }) => row.messageId === `c-${N - 1}`);
				const piHit = readClassifiedTagFile(lastPiTag).some((row: { messageId?: string }) => row.messageId === `p-${N - 1}`);
				return claudeHit && piHit;
			} catch {
				return false;
			}
		},
		120,
	);
	assert("100 claude files and 100 pi files are classified", settled);

	const living = [claudePid, piPid].filter(alive);
	assert(`process count for 200 files is 2 (saw ${living.length})`, living.length === 2 && alive(claudePid) && alive(piPid));

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
	await sleep(POLL_MS + 800);
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

	const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.ts"), "utf8");
	assert("no per-line writtenLines map", !src.includes("writtenLines"));

	for (const pid of [claudePid, piPid]) {
		try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
	}
	await waitFor("harness daemons exit before the reparse", () => !alive(claudePid) && !alive(piPid));

	const fast = path.join(claudeRoot, "proj", "fast.jsonl");
	let body = "";
	for (let i = 0; i < 40; i++) body += turnLine(`fast-${i}`, T0 + 800_000 + i, 1);
	fs.writeFileSync(fast, body);
	const reparseErr = path.join(root, "reparse.err");
	const reparseFd = fs.openSync(reparseErr, "w");
	const started = Date.now();
	const reparse = spawn(process.execPath, [DAEMON, "--reparse", fast], { stdio: ["ignore", "ignore", reparseFd], env });
	const reparseCode = await new Promise<number>(resolve => reparse.on("exit", code => resolve(code ?? 1)));
	fs.closeSync(reparseFd);
	const elapsed = Date.now() - started;
	assert(
		`one-session reparse has no POLL_MS delay per line (${elapsed} ms, exit ${reparseCode})`,
		reparseCode === 0 && elapsed < 5000,
	);
	const fastIds = readClassifiedTagFile(getCurrentVersionTagPath(fast)).map((row: { messageId?: string }) => row.messageId);
	assert("reparse classifies the fixture", fastIds.includes("fast-0") && fastIds.includes("fast-39"));
	const fastCost = readClassifiedTagFile(getCurrentVersionTagPath(fast)).reduce((sum: number, row: { cost: number }) => sum + row.cost, 0);
	const again = spawnSync(process.execPath, [DAEMON, "--reparse", fast], { encoding: "utf8", env });
	const fastCostAgain = readClassifiedTagFile(getCurrentVersionTagPath(fast)).reduce((sum: number, row: { cost: number }) => sum + row.cost, 0);
	assert(
		"a second reparse replaces the tag instead of appending",
		again.status === 0 && Math.abs(fastCostAgain - fastCost) < 0.000001,
	);

	const rangeDir = path.join(claudeRoot, "range");
	fs.mkdirSync(rangeDir, { recursive: true });
	const missing = path.join(rangeDir, "missing.jsonl");
	const kept = path.join(rangeDir, "kept.jsonl");
	const stale = path.join(rangeDir, "stale.jsonl");
	const outside = path.join(rangeDir, "outside.jsonl");
	let missingBody = "";
	for (let i = 0; i < 2000; i++) missingBody += turnLine("range-missing", T0 + i, 5);
	fs.writeFileSync(missing, missingBody);
	fs.writeFileSync(kept, turnLine("range-kept", T0, 5));
	fs.writeFileSync(stale, turnLine("range-stale", T0, 5));
	fs.writeFileSync(outside, turnLine("range-outside", T0, 5));
	const stamp = (file: string, iso: string) => {
		const when = new Date(iso);
		fs.utimesSync(file, when, when);
	};
	stamp(missing, "2026-09-01T12:00:00Z");
	stamp(kept, "2026-09-01T13:00:00Z");
	stamp(stale, "2026-09-02T12:00:00Z");
	stamp(outside, "2026-08-01T12:00:00Z");
	const keptTag = getCurrentVersionTagPath(kept);
	fs.mkdirSync(path.dirname(keptTag), { recursive: true });
	fs.writeFileSync(keptTag, "{\"note\":\"KEEPME\"}\n");
	const staleTag = path.join(path.dirname(getCurrentVersionTagPath(stale)), `stale.jsonl.wtft-tag.v0.0.0.jsonl`);
	fs.mkdirSync(path.dirname(staleTag), { recursive: true });
	fs.writeFileSync(staleTag, "{\"note\":\"OLD\"}\n");

	const rangeErr = path.join(root, "range.err");
	const rangeFd = fs.openSync(rangeErr, "w");
	const rangeChild = spawn(process.execPath, [DAEMON, "--reparse-range", "2026-09-01", "2026-09-03"], {
		stdio: ["ignore", "ignore", rangeFd],
		env,
	});
	let peak = 0;
	const sampler = setInterval(() => {
		if (rangeChild.pid && alive(rangeChild.pid)) peak = Math.max(peak, rssKb(rangeChild.pid));
	}, 5);
	const rangeCode = await new Promise<number>(resolve => rangeChild.on("exit", code => resolve(code ?? 1)));
	clearInterval(sampler);
	fs.closeSync(rangeFd);
	const rangeLog = fs.readFileSync(rangeErr, "utf8");
	const opens: string[] = [];
	let overlap = false;
	let depth = 0;
	for (const line of rangeLog.split("\n")) {
		if (line.includes("reparse begin ")) { depth++; if (depth > 1) overlap = true; opens.push("begin"); }
		if (line.includes("reparse end ")) { depth--; opens.push("end"); }
	}
	assert("a date-range reparse runs one session at a time", rangeCode === 0 && !overlap && depth === 0);
	assert(
		`date-range peak RSS stays near one session (saw ${peak} kB)`,
		peak > 0 && peak < 200 * 1024,
	);
	assert(
		"a missing current tag is rebuilt",
		readClassifiedTagFile(getCurrentVersionTagPath(missing)).some((row: { messageId?: string }) => row.messageId === "range-missing"),
	);
	assert("a current tag is left alone", fs.readFileSync(keptTag, "utf8").includes("KEEPME"));
	assert(
		"a stale tag version is rebuilt",
		readClassifiedTagFile(getCurrentVersionTagPath(stale)).some((row: { messageId?: string }) => row.messageId === "range-stale"),
	);
	assert("a session outside the range is not parsed", !fs.existsSync(getCurrentVersionTagPath(outside)));

	const idleDir = path.join(claudeRoot, "idleproj");
	fs.mkdirSync(idleDir, { recursive: true });
	const idleFile = path.join(idleDir, "idle.jsonl");
	fs.writeFileSync(idleFile, turnLine("idle-0", T0, 10));
	const idlePid = start(["--harness", "claude"], "idle.err", {
		WTFT_DAEMON_IDLE_MS: "400",
		WTFT_DAEMON_STARTUP_GRACE_MS: "0",
	});
	const idleErr = path.join(root, "idle.err");
	const idleDropped = await waitFor(
		"an idle session is dropped",
		() => fs.existsSync(idleErr) && fs.readFileSync(idleErr, "utf8").includes("session drop idle.jsonl"),
		50,
	);
	assert("idle drop leaves the harness process up", idleDropped && alive(idlePid));
} finally {
	for (const pid of pids) {
		try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
	}
	await sleep(200);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

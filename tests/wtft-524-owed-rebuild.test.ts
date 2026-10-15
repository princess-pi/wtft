#!/usr/bin/env bun
/**
 * A rebuild token a lease claim takes off the lease is owed to whoever ends up
 * holding the lease, in any process (#524). Spec: docs/spec-259-daemon-correctness.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { getCurrentVersionTagPath, getDaemonPidPath, readClassifiedTagFile } from "../extensions/lib/wtft-daemon-lib.ts";
import { claimLease, takeRebuildOwed } from "../extensions/lib/lease.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { skip } from "./lib/skips.ts";

const TMP = isolateTmpdir("524-owed-rebuild");
const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

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

const makeRoot = (label: string) => trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), `wtft-524-${label}-`)));
const envFor = (root: string) => ({
	...process.env,
	WTFT_DAEMON_DEBUG: "1",
	WTFT_CLAUDE_PROJECTS_DIR: root,
	WTFT_PI_SESSIONS_DIR: path.join(root, "no-pi"),
});
const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const alive = (pid: number) => {
	try { process.kill(pid, 0); } catch { return false; }
	const stat = read(`/proc/${pid}/stat`);
	return stat !== "" && stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
};
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

const pids: number[] = [];
function startDaemon(root: string, args: string[], errName: string, extra: { preload?: string; env?: Record<string, string> } = {}): number {
	const fd = fs.openSync(path.join(root, errName), "a");
	const argv = extra.preload ? ["--preload", extra.preload, DAEMON, ...args] : [DAEMON, ...args];
	const child = spawn(extra.preload ? process.execPath : "node", argv, { detached: true, stdio: ["ignore", "ignore", fd], env: { ...envFor(root), ...extra.env } });
	child.unref();
	fs.closeSync(fd);
	if (child.pid) pids.push(child.pid);
	return child.pid ?? 0;
}

/**
 * A bun preload that, right after this process unlinks a `rebuild` lease, writes
 * `WTFT_524_HOLDER` there, and with `WTFT_524_DIE` set, kills the process.
 */
function lostClaimPreload(root: string): string {
	const preload = path.join(root, "claim-after-unlink.mjs");
	fs.writeFileSync(preload, `
import * as realFs from "node:fs";
import { mock } from "bun:test";
const lease = process.env.WTFT_524_LEASE;
const originalUnlink = realFs.unlinkSync.bind(realFs);
let done = false;
function unlinkSync(file, ...rest) {
  const wasRebuild = !done && String(file) === lease && realFs.readFileSync(lease, "utf8").trim() === "rebuild";
  const out = originalUnlink(file, ...rest);
  if (wasRebuild) {
    done = true;
    realFs.writeFileSync(lease, process.env.WTFT_524_HOLDER);
    realFs.writeFileSync(process.env.WTFT_524_FIRED, "");
    if (process.env.WTFT_524_DIE) process.kill(process.pid, "SIGKILL");
  }
  return out;
}
mock.module("node:fs", () => ({ ...realFs, unlinkSync, default: { ...realFs, unlinkSync } }));
`);
	return preload;
}

/** Serve `target` once, then give its tag a row its transcript does not hold. */
async function servedWithBogusRow(root: string, target: string, id: string, args: string[]): Promise<void> {
	const pid = startDaemon(root, args, `${id}-first.err`);
	check(await until(() => classified(target, id), 15_000) !== Infinity, `${id}: fixture: a daemon serves the target`);
	process.kill(pid, "SIGTERM");
	await until(() => !alive(pid), 5_000);
	const tag = getCurrentVersionTagPath(target);
	const row = read(tag).split("\n").find(l => l.includes(`"${id}"`)) ?? "";
	fs.appendFileSync(tag, row.replace(`"${id}"`, `"${id}-bogus"`) + "\n" + JSON.stringify({ _meta: { offset: fs.statSync(target).size } }) + "\n");
	check(classified(target, `${id}-bogus`), `${id}: fixture: the tag carries a row its transcript does not`);
}

try {
	console.log("\nThe lease module keeps a rebuild token a claim took off the lease");
	{
		const root = makeRoot("unit");
		const lease = path.join(root, "unit.pid");
		fs.writeFileSync(lease, "rebuild");
		check(claimLease(lease, "4242", () => false) === "claimed", "fixture: a claim displaces a stale rebuild token");
		check(takeRebuildOwed(lease), "the claimant is owed the rebuild");
		check(!takeRebuildOwed(lease), "once taken, it is owed no more");
		fs.writeFileSync(lease, "999999");
		claimLease(lease, "4243", () => false);
		check(!takeRebuildOwed(lease), "displacing a stale pid owes no rebuild");
		check(claimLease(lease, "4244", () => true) === "busy" && !takeRebuildOwed(lease), "a busy claim over a pid owes none");
	}

	if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
		skip("the lost claim is staged from a bun --preload hook; run the suite under bun");
	} else {
		console.log("\nA per-session start that unlinks rebuild and loses the link: the next holder rebuilds");
		{
			const root = makeRoot("per-session");
			const outside = path.join(root, "elsewhere");
			fs.mkdirSync(outside, { recursive: true });
			const target = path.join(outside, "per-target.jsonl");
			fs.writeFileSync(target, turnLine("per-target", Date.now()));
			await servedWithBogusRow(root, target, "per-target", ["--session", target]);
			const lease = getDaemonPidPath(target);
			fs.writeFileSync(lease, "rebuild");
			const fired = path.join(root, "fired");
			const loser = startDaemon(root, ["--session", target], "loser.err", {
				preload: lostClaimPreload(root),
				env: { WTFT_524_LEASE: lease, WTFT_524_HOLDER: "0", WTFT_524_FIRED: fired },
			});
			check(await until(() => !alive(loser), 10_000) !== Infinity && fs.existsSync(fired),
				`fixture precondition: the start lost the lease right after unlinking rebuild, and exited (lease ${JSON.stringify(read(lease).trim())})`);
			startDaemon(root, ["--session", target], "winner.err");
			const rebuilt = await until(() => classified(target, "per-target") && !classified(target, "per-target-bogus"), 10_000);
			check(rebuilt !== Infinity, `the next daemon to hold the lease rebuilds the tag (lease ${JSON.stringify(read(lease).trim())})`);
		}

		console.log("\nA harness that unlinks rebuild, loses the link and stops: the next harness rebuilds");
		{
			const root = makeRoot("harness-restart");
			const target = path.join(root, "proj", "h-target.jsonl");
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, turnLine("h-target", Date.now()));
			await servedWithBogusRow(root, target, "h-target", ["--harness", "claude", "--session", target]);
			const harnessPid = path.join(TMP, `wtft-harness-claude-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12)}.pid`);
			await until(() => read(harnessPid).trim() === "", 5_000);
			const lease = getDaemonPidPath(target);
			fs.writeFileSync(lease, "rebuild");
			const fired = path.join(root, "fired");
			const first = startDaemon(root, ["--harness", "claude", "--session", target], "first-harness.err", {
				preload: lostClaimPreload(root),
				env: { WTFT_524_LEASE: lease, WTFT_524_HOLDER: "0", WTFT_524_FIRED: fired, WTFT_524_DIE: "1" },
			});
			check(await until(() => !alive(first), 15_000) !== Infinity && fs.existsSync(fired),
				"fixture precondition: the harness died right after unlinking rebuild, leaving the lease to a dead holder");
			fs.rmSync(harnessPid, { force: true });
			startDaemon(root, ["--harness", "claude", "--session", target], "second-harness.err");
			const rebuilt = await until(() => classified(target, "h-target") && !classified(target, "h-target-bogus"), 10_000);
			check(rebuilt !== Infinity, `a harness started after the first one stopped rebuilds the tag (lease ${JSON.stringify(read(lease).trim())})`);
		}

		console.log("\nA harness that unlinks rebuild and dies: a per-session daemon that takes the lease rebuilds");
		{
			const root = makeRoot("cross");
			const target = path.join(root, "proj", "x-target.jsonl");
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, turnLine("x-target", Date.now()));
			await servedWithBogusRow(root, target, "x-target", ["--session", target]);
			const lease = getDaemonPidPath(target);
			fs.writeFileSync(lease, "rebuild");
			const fired = path.join(root, "fired");
			const harness = startDaemon(root, ["--harness", "claude", "--session", target], "harness.err", {
				preload: lostClaimPreload(root),
				env: { WTFT_524_LEASE: lease, WTFT_524_HOLDER: "0", WTFT_524_FIRED: fired, WTFT_524_DIE: "1" },
			});
			check(await until(() => !alive(harness), 15_000) !== Infinity && fs.existsSync(fired),
				"fixture precondition: the harness died right after unlinking rebuild");
			startDaemon(root, ["--session", target], "per-session.err");
			const rebuilt = await until(() => classified(target, "x-target") && !classified(target, "x-target-bogus"), 10_000);
			check(rebuilt !== Infinity, `the per-session daemon rebuilds the tag (lease ${JSON.stringify(read(lease).trim())})`);
		}
	}
} finally {
	for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

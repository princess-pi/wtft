#!/usr/bin/env bun
/**
 * The harness daemon's lifecycle: long-idle sessions hold no slot or lease, one
 * harness per root after --restart, and the startup reaper never acts on a
 * harness for its start-up --session. --cleanup is not run here: it stops
 * every fixture daemon under /tmp, including other suites'.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { getCurrentVersionTagPath, getDaemonPidPath, readClassifiedTagFile } from "../extensions/lib/wtft-daemon-lib.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

const TMP = isolateTmpdir("239-lifecycle");

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

const TWO_DAYS_AGO = new Date(Date.now() - 2 * 86_400_000);

/** A root of `count` sessions last written two days ago, past the 24 h idle drop. */
function makeRoot(label: string, count: number): { root: string; files: string[] } {
	const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), `wtft-239-${label}-`)));
	const files: string[] = [];
	for (let i = 0; i < count; i++) {
		const dir = path.join(root, `proj-${i % 20}`);
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `s-${label}-${i}.jsonl`);
		fs.writeFileSync(file, turnLine(`${label}-${i}`, TWO_DAYS_AGO.getTime()));
		fs.utimesSync(file, TWO_DAYS_AGO, TWO_DAYS_AGO);
		files.push(file);
	}
	return { root, files };
}

const envFor = (root: string) => ({
	...process.env,
	WTFT_DAEMON_DEBUG: "1",
	WTFT_CLAUDE_PROJECTS_DIR: root,
	WTFT_PI_SESSIONS_DIR: path.join(root, "no-pi"),
});

const pids: number[] = [];
/** `snapDir`: the daemon writes a heap snapshot there on SIGUSR2. */
function start(root: string, args: string[], errName: string, snapDir?: string): { pid: number; err: string } {
	const err = path.join(root, errName);
	const fd = fs.openSync(err, "a");
	const flags = snapDir ? ["--heapsnapshot-signal=SIGUSR2"] : [];
	const child = spawn("node", [...flags, DAEMON, ...args], { detached: true, stdio: ["ignore", "ignore", fd], env: envFor(root), cwd: snapDir });
	child.unref();
	fs.closeSync(fd);
	if (child.pid) pids.push(child.pid);
	return { pid: child.pid ?? 0, err };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const harnessPidFile = (root: string) =>
	path.join(TMP, `wtft-harness-claude-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12)}.pid`);
const leasesNaming = (pid: number) =>
	fs.readdirSync(TMP).filter(n => /^wtft-daemon-.*\.pid$/.test(n) && read(path.join(TMP, n)).trim() === String(pid)).length;
/** Live heap in MiB: a heap snapshot collects garbage first, so this is what
 *  the daemon retains, which RSS is not. */
async function liveHeapMiB(pid: number, dir: string): Promise<number> {
	for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
	process.kill(pid, "SIGUSR2");
	let size = -1;
	for (let i = 0; i < 300; i++) {
		await sleep(200);
		const snap = fs.readdirSync(dir).find(f => f.endsWith(".heapsnapshot"));
		if (!snap) continue;
		const now = fs.statSync(path.join(dir, snap)).size;
		if (now > 0 && now === size) {
			const d = JSON.parse(fs.readFileSync(path.join(dir, snap), "utf8"));
			const fields = d.snapshot.meta.node_fields, n = fields.length, at = fields.indexOf("self_size");
			let t = 0;
			for (let k = at; k < d.nodes.length; k += n) t += d.nodes[k];
			return t / 1048576;
		}
		size = now;
	}
	return NaN;
}
const classified = (file: string, id: string) => {
	try { return readClassifiedTagFile(getCurrentVersionTagPath(file)).some((r: { messageId?: string }) => r.messageId === id); }
	catch { return false; }
};

/** Harness processes serving `root`, found by command line and environment. */
function harnessesFor(root: string): number[] {
	const out: number[] = [];
	for (const name of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		const cmd = read(`/proc/${name}/cmdline`).split("\0");
		if (!cmd.includes(DAEMON) || !cmd.includes("--harness")) continue;
		if (read(`/proc/${name}/environ`).split("\0").includes(`WTFT_CLAUDE_PROJECTS_DIR=${root}`)) out.push(Number(name));
	}
	return out;
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

try {
	console.log("\nLong-idle sessions hold no slot and no lease once caught up");
	{
		const { root, files } = makeRoot("q", 2000);
		const live = path.join(root, "proj-0", "live.jsonl");
		fs.writeFileSync(live, turnLine("live-0", Date.now()));
		// Old transcript and directories, but a subagent transcript appended to
		// just now: the directory mtimes do not show the append.
		const parent = files[3];
		const subDir = path.join(parent.slice(0, -".jsonl".length), "subagents");
		fs.mkdirSync(subDir, { recursive: true });
		fs.writeFileSync(path.join(subDir, "agent-a.jsonl"), turnLine("sub-a", Date.now()));
		for (const d of [subDir, path.dirname(subDir)]) fs.utimesSync(d, TWO_DAYS_AGO, TWO_DAYS_AGO);
		const small = makeRoot("small", 10);
		const bigSnaps = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-snap-")));
		const smallSnaps = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-snap-")));
		const h = start(root, ["--harness", "claude"], "q.err", bigSnaps);
		const s = start(small.root, ["--harness", "claude"], "small.err", smallSnaps);
		let n = 0;
		const appender = setInterval(() => fs.appendFileSync(live, turnLine(`live-${++n}`, Date.now())), 400);
		const settled = await until(() => read(h.err).includes("harness settled claude") && read(s.err).includes("harness settled claude"), 60_000);
		check(settled !== Infinity, "fixture: both harnesses finished their startup catch-up");
		check(classified(files[files.length - 1], `q-${files.length - 1}`), "fixture: the last quiet session was classified");
		await sleep(1500);
		const held = leasesNaming(h.pid);
		check(read(getDaemonPidPath(parent)).trim() === String(h.pid), "a session whose subagent transcript was just appended to keeps its lease");
		check(held <= 5, `after catch-up the harness holds a handful of leases, not one per session: ${held} for ${files.length + 1} sessions`);
		const reparse = spawnSync("node", [DAEMON, "--reparse", files[5]], { encoding: "utf8", env: envFor(root) });
		check(reparse.status === 1 && reparse.stderr.includes("refused"), `--reparse of a released session is refused while its harness runs (exit ${reparse.status})`);
		const target = `live-${n}`;
		check(await until(() => classified(live, target), 10_000) !== Infinity, "the session being appended to is still classified");
		clearInterval(appender);
		const big = await liveHeapMiB(h.pid, bigSnaps), base = await liveHeapMiB(s.pid, smallSnaps);
		check(big > 0 && base > 0 && big - base < 1, `live heap with 2,001 sessions is within 1 MiB of the heap with 10 (${big.toFixed(2)} vs ${base.toFixed(2)} MiB)`);

		const woken = files[7];
		fs.appendFileSync(woken, turnLine("woken", Date.now()));
		check(await until(() => classified(woken, "woken"), 10_000) !== Infinity, "a quiet session written again is adopted and classified");
		check(read(getDaemonPidPath(woken)).trim() === String(h.pid), "and it holds its own lease while it is live");
		for (const pid of [h.pid, s.pid]) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
		await until(() => !alive(h.pid) && !alive(s.pid), 5_000);
	}

	console.log("\nA harness whose pid file no longer names it stops");
	{
		const { root, files } = makeRoot("p", 5);
		const h = start(root, ["--harness", "claude", "--session", files[0]], "p.err");
		check(await until(() => read(harnessPidFile(root)).trim() === String(h.pid), 10_000) !== Infinity, "fixture: the harness holds its pid file");
		fs.unlinkSync(harnessPidFile(root));
		check(await until(() => !alive(h.pid), 5_000) !== Infinity, "with its pid file removed, the harness exits");
	}

	console.log("\n--restart followed at once by a CLI spawn leaves one harness");
	{
		// Live sessions, so the first harness holds a lease for each and
		// --restart spends seconds walking them before it reaches the pid file.
		const { root, files } = makeRoot("r", 2000);
		for (const f of files) fs.utimesSync(f, new Date(), new Date());
		const h = start(root, ["--harness", "claude", "--session", files[0]], "r.err");
		check(await until(() => read(h.err).includes("harness settled claude"), 30_000) !== Infinity, "fixture: the first harness settled");
		// Leases as many as a busy host's, so --restart is still walking them
		// after the harness it started has claimed the root.
		for (let i = 0; i < 40_000; i++) fs.writeFileSync(path.join(TMP, `wtft-daemon-fake${i}.pid`), String(h.pid));
		const restart = spawnSync("node", [DAEMON, "--restart"], { encoding: "utf8", env: envFor(root) });
		check(restart.status === 0, `fixture: --restart exited 0 (${restart.status})`);
		check((restart.stdout.match(/^Restarted: PID/gm) ?? []).length >= 1, "fixture: --restart stopped the harness");
		start(root, ["--harness", "claude", "--session", files[1]], "r-cli.err");
		await sleep(5_000);
		const living = harnessesFor(root);
		for (const pid of living) if (!pids.includes(pid)) pids.push(pid);
		check(living.length === 1, `exactly one harness serves the root 5 s later (saw ${living.length}: ${living.join(",")})`);
		check(living.length === 1 && read(harnessPidFile(root)).trim() === String(living[0]), "and it holds the harness pid file");
		const focus = living.length === 1 ? read(`/proc/${living[0]}/cmdline`).split("\0") : [];
		check(focus[focus.indexOf("--session") + 1] === files[0], "it is the one --restart started, which the CLI spawn handed its session");
		for (const pid of living) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
		await until(() => living.every(p => !alive(p)), 5_000);
	}

	console.log("\nThe startup reaper leaves a harness whose --session is gone");
	{
		const { root, files } = makeRoot("g", 3);
		for (const f of files) fs.utimesSync(f, new Date(), new Date());
		const gone = files[0];
		const h = start(root, ["--harness", "claude", "--session", gone], "g.err");
		check(await until(() => classified(gone, "g-0") && classified(files[1], "g-1"), 15_000) !== Infinity, "fixture: the harness classified its sessions");
		fs.unlinkSync(gone);
		const other = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-outside-")));
		const outside = path.join(other, "outside.jsonl");
		fs.writeFileSync(outside, turnLine("outside", Date.now()));
		const leasesBefore = leasesNaming(h.pid);
		check(leasesBefore >= 1, `fixture: the harness holds a lease for a live session (${leasesBefore})`);
		const per = start(root, ["--session", outside], "per.err");
		check(await until(() => classified(outside, "outside"), 15_000) !== Infinity, "fixture: the per-session daemon started and classified its session");
		await sleep(500);
		check(alive(h.pid), "the harness is still running");
		check(read(getDaemonPidPath(files[1])).trim() === String(h.pid), "and still holds its live session's lease");
		for (const pid of [h.pid, per.pid]) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
	}
} finally {
	for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
	await sleep(300);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

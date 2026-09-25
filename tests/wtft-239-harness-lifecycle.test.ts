#!/usr/bin/env bun
/**
 * The harness daemon's lifecycle: it serves only the sessions it is asked for,
 * a report shows a partial sum before subagents are read, one harness per root
 * after --restart, and the startup reaper never acts on a harness for its
 * start-up --session. --cleanup is not run here: it stops
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

/** A root of `count` sessions last written two days ago. */
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
function start(root: string, args: string[], errName: string, snapDir?: string, extraEnv: Record<string, string> = {}): { pid: number; err: string } {
	const err = path.join(root, errName);
	const fd = fs.openSync(err, "a");
	const flags = snapDir ? ["--heapsnapshot-signal=SIGUSR2"] : [];
	const child = spawn("node", [...flags, DAEMON, ...args], { detached: true, stdio: ["ignore", "ignore", fd], env: { ...envFor(root), ...extraEnv }, cwd: snapDir });
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
	console.log("\nThe harness serves only the sessions it is asked for");
	{
		const { root, files } = makeRoot("q", 2000);
		const live = path.join(root, "proj-0", "live.jsonl");
		fs.writeFileSync(live, turnLine("live-0", Date.now()));
		const parent = files[3];
		const subDir = path.join(parent.slice(0, -".jsonl".length), "subagents");
		fs.mkdirSync(subDir, { recursive: true });
		fs.writeFileSync(path.join(subDir, "agent-a.jsonl"), turnLine("sub-a", Date.now()));
		const small = makeRoot("small", 10);
		const bigSnaps = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-snap-")));
		const smallSnaps = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-snap-")));
		const h = start(root, ["--harness", "claude", "--session", live], "q.err", bigSnaps);
		const s = start(small.root, ["--harness", "claude", "--session", small.files[0]], "small.err", smallSnaps);
		let n = 0;
		const appender = setInterval(() => fs.appendFileSync(live, turnLine(`live-${++n}`, Date.now())), 400);
		const settled = await until(() => read(h.err).includes("harness settled claude") && read(s.err).includes("harness settled claude"), 30_000);
		check(settled !== Infinity, "fixture: both harnesses started");
		check(await until(() => classified(live, "live-0"), 10_000) !== Infinity, "the session it was started for is classified");
		await sleep(1500);
		const unasked = files.filter(f => fs.existsSync(getCurrentVersionTagPath(f))).length;
		check(unasked === 0, `no session it was not asked for has a tag: ${unasked} of ${files.length}`);
		check(leasesNaming(h.pid) === 1 && read(getDaemonPidPath(live)).trim() === String(h.pid), `it holds one lease, for that session (${leasesNaming(h.pid)})`);
		const target = `live-${n}`;
		check(await until(() => classified(live, target), 10_000) !== Infinity, "the session being appended to stays classified");
		clearInterval(appender);
		const big = await liveHeapMiB(h.pid, bigSnaps), base = await liveHeapMiB(s.pid, smallSnaps);
		check(big > 0 && base > 0 && big - base < 1, `live heap with 2,001 sessions on disk is within 1 MiB of the heap with 10 (${big.toFixed(2)} vs ${base.toFixed(2)} MiB)`);

		const beside = files[20];
		check(path.dirname(beside) === path.dirname(live), "fixture: the unasked session shares the served session's directory");
		fs.appendFileSync(beside, turnLine("unasked-write", Date.now()));
		await sleep(1500);
		check(!fs.existsSync(getCurrentVersionTagPath(beside)), "a write to a session nobody asked for, beside one it serves, is not read");

		start(root, ["--harness", "claude", "--session", parent], "ask.err");
		check(await until(() => classified(parent, "q-3") && classified(parent, "sub-a"), 10_000) !== Infinity, "a session asked for later is served, subagent included");
		check(read(getDaemonPidPath(parent)).trim() === String(h.pid), "and the running harness holds its lease");
		fs.appendFileSync(path.join(subDir, "agent-a.jsonl"), turnLine("sub-b", Date.now()));
		check(await until(() => classified(parent, "sub-b"), 10_000) !== Infinity, "a later write to its subagent transcript is read");

		const reparse = spawnSync("node", [DAEMON, "--reparse", files[5]], { encoding: "utf8", env: envFor(root) });
		check(reparse.status === 0, `--reparse of a session nobody is serving runs beside the harness (exit ${reparse.status})`);
		const refused = spawnSync("node", [DAEMON, "--reparse", parent], { encoding: "utf8", env: envFor(root) });
		check(refused.status === 1, `--reparse of a session the harness serves is refused (exit ${refused.status})`);
		for (const pid of [h.pid, s.pid]) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
		await until(() => !alive(h.pid) && !alive(s.pid), 5_000);
	}

	console.log("\nA report shows the session's own sum before its subagents are read");
	{
		const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-partial-")));
		const dir = path.join(root, "proj");
		fs.mkdirSync(dir, { recursive: true });
		const session = path.join(dir, "11111111-2222-4333-8444-555555555555.jsonl");
		fs.writeFileSync(session, turnLine("main-0", Date.now() - 60_000));
		const sub = path.join(session.slice(0, -".jsonl".length), "subagents");
		fs.mkdirSync(sub, { recursive: true });
		const pad = JSON.stringify({ type: "user", message: { content: "x".repeat(4000) } }) + "\n";
		for (let a = 0; a < 20; a++) {
			let body = "";
			for (let i = 0; i < 300; i++) body += i % 50 === 0 ? turnLine(`a${a}-${i}`, Date.now() - 50_000) : pad;
			fs.writeFileSync(path.join(sub, `agent-${a}.jsonl`), body);
		}
		const cli = path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs");
		// 300 ms between slices makes reading the 20
		// subagent transcripts outlast the first report by several 667 ms beats.
		const slow = { ...envFor(root), WTFT_HARNESS_SCAN_SLICE_MS: "0", WTFT_HARNESS_SCAN_YIELD_MS: "300" };
		const t0 = Date.now();
		const first = spawnSync("node", [cli, "--json", "-s", session], { encoding: "utf8", env: slow, timeout: 30_000 });
		const took = Date.now() - t0;
		let doc: any = null;
		try { doc = JSON.parse(first.stdout); } catch { /* checked below */ }
		const mainOnly = readClassifiedTagFile(getCurrentVersionTagPath(session)).length;
		check(doc !== null, `fixture: the first report printed JSON (exit ${first.status})`);
		check(took < 3_000, `the first report returned in ${took} ms, without waiting for the subagents`);
		check(first.status === 9 && doc?.provisional?.provisional === true, `it is marked provisional while subagents are still being read (exit ${first.status})`);
		check((doc?.total?.costUsd ?? 0) > 0, `it already carries the session's own sum ($${doc?.total?.costUsd})`);
		const settledAll = await until(() => {
			const r = spawnSync("node", [cli, "--json", "-s", session], { encoding: "utf8", env: envFor(root), timeout: 30_000 });
			return r.status === 0;
		}, 60_000);
		check(settledAll !== Infinity, "a later report is complete, not provisional");
		const full = readClassifiedTagFile(getCurrentVersionTagPath(session)).length;
		check(full > mainOnly, `and it counts the subagent turns the first did not (${full} rows against ${mainOnly})`);
		// A second session under the same root, handed to the harness already
		// running: the first report on it must find its turns, not an empty tag.
		const other = path.join(dir, "66666666-7777-4888-8999-000000000000.jsonl");
		fs.writeFileSync(other, turnLine("other-0", Date.now() - 30_000));
		const handed = spawnSync("node", [cli, "--json", "-s", other], { encoding: "utf8", env: envFor(root), timeout: 30_000 });
		let otherDoc: any = null;
		try { otherDoc = JSON.parse(handed.stdout); } catch { /* checked below */ }
		check((otherDoc?.total?.costUsd ?? 0) > 0, `the first report on a session handed to the running harness has its sum ($${otherDoc?.total?.costUsd}, exit ${handed.status})`);
		for (const pid of harnessesFor(root)) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
	}

	console.log("\n--reparse whose subagent scan fails does not stamp the tag swept");
	{
		const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-rpfail-")));
		const dir = path.join(root, "proj");
		fs.mkdirSync(dir, { recursive: true });
		const session = path.join(dir, "33333333-4444-4555-8666-777777777777.jsonl");
		fs.writeFileSync(session, turnLine("rf-0", Date.now() - 60_000));
		const sub = path.join(session.slice(0, -".jsonl".length), "subagents");
		fs.mkdirSync(sub, { recursive: true });
		const locked = path.join(sub, "agent-locked.jsonl");
		fs.writeFileSync(locked, turnLine("rf-sub", Date.now() - 50_000));
		fs.chmodSync(locked, 0o000);
		check(read(locked) === "", "fixture: the subagent transcript cannot be read");
		const r = spawnSync("node", [DAEMON, "--reparse", session], { encoding: "utf8", env: envFor(root) });
		fs.chmodSync(locked, 0o644);
		check(r.status === 1, `--reparse exits 1 when a subagent transcript could not be read (exit ${r.status})`);
		check(!read(getCurrentVersionTagPath(session)).includes('"swept"'), "and the tag is not stamped swept");
	}

	console.log("\nA session adopted again does not keep its previous life's swept verdict");
	{
		const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-readopt-")));
		const dir = path.join(root, "proj");
		fs.mkdirSync(dir, { recursive: true });
		const session = path.join(dir, "44444444-5555-4666-8777-888888888888.jsonl");
		fs.writeFileSync(session, turnLine("ra-0", Date.now() - 60_000));
		const sub = path.join(session.slice(0, -".jsonl".length), "subagents");
		fs.mkdirSync(sub, { recursive: true });
		fs.writeFileSync(path.join(sub, "agent-a.jsonl"), turnLine("ra-sub", Date.now() - 50_000));
		const tag = getCurrentVersionTagPath(session);
		const h1 = start(root, ["--harness", "claude", "--session", session], "ra1.err");
		check(await until(() => classified(session, "ra-sub") && read(tag).includes('"swept"'), 15_000) !== Infinity, "fixture: the first harness read the subagent and stamped the tag swept");
		process.kill(h1.pid, "SIGTERM");
		await until(() => !alive(h1.pid), 5_000);
		fs.writeFileSync(path.join(sub, "agent-b.jsonl"), turnLine("ra-late", Date.now()));
		const unsweptBefore = (read(tag).match(/"unswept"/g) ?? []).length;
		const h2 = start(root, ["--harness", "claude", "--session", session], "ra2.err");
		check(await until(() => (read(tag).match(/"unswept"/g) ?? []).length > unsweptBefore, 10_000) !== Infinity, "the new harness retracts the old swept verdict when it adopts the session");
		check(await until(() => classified(session, "ra-late"), 15_000) !== Infinity, "and then reads the subagent written while nothing served it");
		try { process.kill(h2.pid, "SIGTERM"); } catch { /* gone */ }
		await until(() => !alive(h2.pid), 5_000);
	}

	console.log("\nA session handed to a live harness keeps its rebuild lease");
	{
		const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-rebuild-")));
		const dir = path.join(root, "proj");
		fs.mkdirSync(dir, { recursive: true });
		const target = path.join(dir, "55555555-6666-4777-8888-999999999999.jsonl");
		const other = path.join(dir, "66666666-7777-4888-8999-aaaaaaaaaaaa.jsonl");
		fs.writeFileSync(target, turnLine("rb-0", Date.now() - 60_000));
		fs.writeFileSync(other, turnLine("rbo-0", Date.now() - 60_000));
		const tag = getCurrentVersionTagPath(target);
		const first = spawnSync("node", [DAEMON, "--reparse", target], { encoding: "utf8", env: envFor(root) });
		check(first.status === 0 && classified(target, "rb-0"), `fixture: the target has a tag (exit ${first.status})`);
		// A row no transcript holds, then an offset at the end, so a resume keeps it.
		const row = read(tag).split("\n").find(l => l.includes('"rb-0"')) ?? "";
		fs.appendFileSync(tag, row.replace('"rb-0"', '"rb-bogus"') + "\n" + JSON.stringify({ _meta: { offset: fs.statSync(target).size } }) + "\n");
		check(classified(target, "rb-bogus"), "fixture: the tag carries a row the transcript does not");
		fs.writeFileSync(getDaemonPidPath(target), "rebuild");
		const h = start(root, ["--harness", "claude", "--session", other], "rb.err");
		check(await until(() => classified(other, "rbo-0"), 15_000) !== Infinity, "fixture: a harness is serving another session");
		start(root, ["--harness", "claude", "--session", target], "rb-ask.err");
		await until(() => read(getDaemonPidPath(target)).trim() === String(h.pid) && classified(target, "rb-0") && !classified(target, "rb-bogus"), 10_000);
		check(classified(target, "rb-0") && !classified(target, "rb-bogus"), "the harness rebuilds the tag instead of resuming it");
		try { process.kill(h.pid, "SIGTERM"); } catch { /* gone */ }
		await until(() => !alive(h.pid), 5_000);
	}

	console.log("\nA per-session daemon waits for a --reparse holding its lease");
	{
		const other = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-perwait-")));
		const outside = path.join(other, "outside-wait.jsonl");
		fs.writeFileSync(outside, turnLine("pw-0", Date.now()));
		// A stand-in whose command line reads as a --reparse of this session.
		const fake = spawn("node", ["-e", "setTimeout(() => {}, 60000)", path.join(other, "wtft-daemon.mjs"), "--reparse", outside], { stdio: "ignore" });
		const lease = getDaemonPidPath(outside);
		fs.writeFileSync(lease, String(fake.pid));
		await sleep(300);
		const per = start(other, ["--session", outside], "pw.err");
		await sleep(1_500);
		check(alive(per.pid), "the per-session daemon does not exit while the reparse holds the lease");
		check(read(lease).trim() === String(fake.pid), "and does not take the lease from it");
		fake.kill("SIGTERM");
		try { fs.unlinkSync(lease); } catch { /* gone */ }
		check(await until(() => classified(outside, "pw-0"), 10_000) !== Infinity, "once the reparse lets go, it claims the lease and classifies the session");
		try { process.kill(per.pid, "SIGTERM"); } catch { /* gone */ }
	}

	console.log("\nA harness does not adopt a session while a --reparse of it is running");
	{
		const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-rpmark-")));
		const dir = path.join(root, "proj");
		fs.mkdirSync(dir, { recursive: true });
		const target = path.join(dir, "77777777-8888-4999-8aaa-bbbbbbbbbbbb.jsonl");
		const other = path.join(dir, "88888888-9999-4aaa-8bbb-cccccccccccc.jsonl");
		fs.writeFileSync(target, turnLine("rm-0", Date.now() - 60_000));
		fs.writeFileSync(other, turnLine("rmo-0", Date.now() - 60_000));
		const h = start(root, ["--harness", "claude", "--session", other], "rm.err");
		check(await until(() => classified(other, "rmo-0"), 15_000) !== Infinity, "fixture: a harness is serving another session");
		// A stand-in reparse that has marked the session but whose lease a focus
		// request has already pointed at the harness.
		const fake = spawn("node", ["-e", "setTimeout(() => {}, 60000)", path.join(root, "wtft-daemon.mjs"), "--reparse", target], { stdio: "ignore" });
		const lease = getDaemonPidPath(target);
		fs.writeFileSync(`${lease}.reparse`, String(fake.pid));
		await sleep(300);
		start(root, ["--harness", "claude", "--session", target], "rm-ask.err");
		await sleep(2_000);
		check(!fs.existsSync(getCurrentVersionTagPath(target)), "the harness leaves the session alone while the reparse runs");
		fake.kill("SIGTERM");
		try { fs.unlinkSync(`${lease}.reparse`); } catch { /* gone */ }
		check(await until(() => classified(target, "rm-0"), 10_000) !== Infinity, "and adopts it once the reparse has finished");
		try { process.kill(h.pid, "SIGTERM"); } catch { /* gone */ }
		await until(() => !alive(h.pid), 5_000);
	}

	console.log("\nA session dropped for idling is adopted again on its next write");
	{
		const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-idle-")));
		const dir = path.join(root, "proj");
		fs.mkdirSync(dir, { recursive: true });
		const session = path.join(dir, "99999999-aaaa-4bbb-8ccc-dddddddddddd.jsonl");
		fs.writeFileSync(session, turnLine("id-0", Date.now() - 60_000));
		const h = start(root, ["--harness", "claude", "--session", session], "idle.err", undefined, { WTFT_DAEMON_IDLE_MS: "1500", WTFT_DAEMON_STARTUP_GRACE_MS: "0" });
		check(await until(() => classified(session, "id-0"), 15_000) !== Infinity, "fixture: the session is classified");
		check(await until(() => read(h.err).includes("session drop"), 15_000) !== Infinity, "fixture: the harness dropped it for idling");
		fs.appendFileSync(session, turnLine("id-1", Date.now()));
		check(await until(() => classified(session, "id-1"), 10_000) !== Infinity, "a later write to it is read with no new request");
		try { process.kill(h.pid, "SIGTERM"); } catch { /* gone */ }
		await until(() => !alive(h.pid), 5_000);
	}

	console.log("\nA refused --reparse leaves a running reparse's marker alone");
	{
		const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-rp2-")));
		const dir = path.join(root, "proj");
		fs.mkdirSync(dir, { recursive: true });
		const target = path.join(dir, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl");
		fs.writeFileSync(target, turnLine("r2-0", Date.now() - 60_000));
		const fake = spawn("node", ["-e", "setTimeout(() => {}, 60000)", path.join(root, "wtft-daemon.mjs"), "--reparse", target], { stdio: "ignore" });
		const lease = getDaemonPidPath(target);
		fs.writeFileSync(lease, String(fake.pid));
		fs.writeFileSync(`${lease}.reparse`, String(fake.pid));
		await sleep(300);
		const second = spawnSync("node", [DAEMON, "--reparse", target], { encoding: "utf8", env: envFor(root) });
		check(second.status === 1, `the second --reparse is refused (exit ${second.status})`);
		check(read(`${lease}.reparse`).trim() === String(fake.pid), "and the running reparse's marker still names it");
		fake.kill("SIGTERM");
		for (const f of [lease, `${lease}.reparse`]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
	}

	console.log("\nAfter --restart, the new harness serves a session the old one was asked for");
	{
		const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-rsserved-")));
		const dir = path.join(root, "proj");
		fs.mkdirSync(dir, { recursive: true });
		const first = path.join(dir, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.jsonl");
		const asked = path.join(dir, "cccccccc-dddd-4eee-8fff-000000000000.jsonl");
		fs.writeFileSync(first, turnLine("rs-0", Date.now() - 60_000));
		fs.writeFileSync(asked, turnLine("rsa-0", Date.now() - 60_000));
		const h = start(root, ["--harness", "claude", "--session", first], "rs.err");
		check(await until(() => classified(first, "rs-0"), 15_000) !== Infinity, "fixture: the harness serves its start-up session");
		start(root, ["--harness", "claude", "--session", asked], "rs-ask.err");
		check(await until(() => classified(asked, "rsa-0"), 15_000) !== Infinity, "fixture: and a session asked for later");
		const restart = spawnSync("node", [DAEMON, "--restart"], { encoding: "utf8", env: envFor(root) });
		check(restart.status === 0 && await until(() => !alive(h.pid), 5_000) !== Infinity, `fixture: --restart stopped it (exit ${restart.status})`);
		check(await until(() => harnessesFor(root).length === 1, 10_000) !== Infinity, "fixture: --restart started one harness");
		await sleep(1_000);
		fs.appendFileSync(asked, turnLine("rsa-1", Date.now()));
		check(await until(() => classified(asked, "rsa-1"), 10_000) !== Infinity, "a later write to the session asked for before the restart is read with no new request");
		for (const pid of harnessesFor(root)) { pids.push(pid); try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
	}

	console.log("\n--restart of a harness holding no lease keeps the sessions it dropped for idling");
	{
		const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-rsidle-")));
		const dir = path.join(root, "proj");
		fs.mkdirSync(dir, { recursive: true });
		const session = path.join(dir, "dddddddd-eeee-4fff-8000-111111111111.jsonl");
		fs.writeFileSync(session, turnLine("ri-0", Date.now() - 60_000));
		const h = start(root, ["--harness", "claude", "--session", session], "ri.err", undefined, { WTFT_DAEMON_IDLE_MS: "1500", WTFT_DAEMON_STARTUP_GRACE_MS: "0" });
		check(await until(() => classified(session, "ri-0"), 15_000) !== Infinity, "fixture: the session is classified");
		check(await until(() => read(h.err).includes("session drop") && leasesNaming(h.pid) === 0, 15_000) !== Infinity, "fixture: the harness dropped it for idling and holds no lease");
		const restart = spawnSync("node", [DAEMON, "--restart"], { encoding: "utf8", env: envFor(root) });
		check(restart.status === 0 && await until(() => !alive(h.pid), 5_000) !== Infinity, `fixture: --restart stopped it (exit ${restart.status})`);
		const next = start(root, ["--harness", "claude"], "ri-next.err");
		check(await until(() => read(harnessPidFile(root)).trim() === String(next.pid), 10_000) !== Infinity, "fixture: the next harness holds the root");
		await sleep(500);
		fs.appendFileSync(session, turnLine("ri-1", Date.now()));
		check(await until(() => classified(session, "ri-1"), 10_000) !== Infinity, "the next harness reads that session's next write with no new request");
		try { process.kill(next.pid, "SIGTERM"); } catch { /* gone */ }
		await until(() => !alive(next.pid), 5_000);
	}

	console.log("\nAfter --restart, a session asked for before its transcript was written is still served");
	{
		const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-rsnew-")));
		const dir = path.join(root, "proj");
		fs.mkdirSync(dir, { recursive: true });
		const first = path.join(dir, "eeeeeeee-ffff-4000-8111-222222222222.jsonl");
		const later = path.join(dir, "ffffffff-0000-4111-8222-333333333333.jsonl");
		fs.writeFileSync(first, turnLine("rn-0", Date.now() - 60_000));
		const h = start(root, ["--harness", "claude", "--session", first], "rn.err");
		check(await until(() => classified(first, "rn-0"), 15_000) !== Infinity, "fixture: the harness serves its start-up session");
		start(root, ["--harness", "claude", "--session", later], "rn-ask.err");
		check(await until(() => read(getDaemonPidPath(later)).trim() === String(h.pid), 10_000) !== Infinity, "fixture: a session with no transcript yet was handed to it");
		const restart = spawnSync("node", [DAEMON, "--restart"], { encoding: "utf8", env: envFor(root) });
		check(restart.status === 0 && await until(() => !alive(h.pid), 5_000) !== Infinity, `fixture: --restart stopped it (exit ${restart.status})`);
		check(await until(() => harnessesFor(root).length === 1, 10_000) !== Infinity, "fixture: --restart started one harness");
		await sleep(1_000);
		fs.writeFileSync(later, turnLine("rn-later", Date.now()));
		check(await until(() => classified(later, "rn-later"), 10_000) !== Infinity, "its first write is read with no new request");
		for (const pid of harnessesFor(root)) { pids.push(pid); try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
	}

	console.log("\nA session asked for before its project directory exists is read once it is written");
	{
		const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-nodir-")));
		const dir = path.join(root, "proj");
		fs.mkdirSync(dir, { recursive: true });
		const first = path.join(dir, "01010101-0202-4303-8404-050505050505.jsonl");
		fs.writeFileSync(first, turnLine("nd-0", Date.now() - 60_000));
		const h = start(root, ["--harness", "claude", "--session", first], "nd.err");
		check(await until(() => classified(first, "nd-0"), 15_000) !== Infinity, "fixture: a harness is serving a session");
		const laterDir = path.join(root, "proj-new");
		const later = path.join(laterDir, "06060606-0707-4808-8909-101010101010.jsonl");
		start(root, ["--harness", "claude", "--session", later], "nd-ask.err");
		check(await until(() => read(getDaemonPidPath(later)).trim() === String(h.pid), 10_000) !== Infinity, "fixture: the session was handed to the harness before its directory existed");
		await sleep(1_000);
		fs.mkdirSync(laterDir, { recursive: true });
		fs.writeFileSync(later, turnLine("nd-later", Date.now()));
		check(await until(() => classified(later, "nd-later"), 10_000) !== Infinity, "its first write is read with no new request");
		try { process.kill(h.pid, "SIGTERM"); } catch { /* gone */ }
		await until(() => !alive(h.pid), 5_000);
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
		const { root, files } = makeRoot("r", 2000);
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

	console.log("\nA harness a spawn starts while --restart is walking is left running");
	{
		const { root, files } = makeRoot("w", 20);
		// Started with no session, so --restart starts no replacement and the root
		// is free for the spawn while the walk goes on.
		const h = start(root, ["--harness", "claude"], "w.err");
		check(await until(() => read(harnessPidFile(root)).trim() === String(h.pid), 30_000) !== Infinity, "fixture: the first harness holds the root");
		for (let i = 0; i < 40_000; i++) fs.writeFileSync(path.join(TMP, `wtft-daemon-fakew${i}.pid`), String(h.pid));
		const restart = spawn("node", [DAEMON, "--restart"], { stdio: "ignore", env: envFor(root) });
		const restartDone = new Promise<void>(resolve => restart.on("exit", () => resolve()));
		await until(() => !alive(h.pid), 10_000);
		const w = start(root, ["--harness", "claude", "--session", files[1]], "w-cli.err");
		const claimed = await until(() => read(harnessPidFile(root)).trim() === String(w.pid), 10_000);
		check(claimed !== Infinity && alive(restart.pid!), "fixture: the spawn claimed the root while --restart was still walking");
		await restartDone;
		await sleep(2_000);
		const living = harnessesFor(root);
		for (const pid of living) if (!pids.includes(pid)) pids.push(pid);
		check(living.length === 1, `exactly one harness serves the root after --restart (saw ${living.length}: ${living.join(",")})`);
		check(alive(w.pid) && read(harnessPidFile(root)).trim() === String(w.pid), "it is the harness the spawn started");
		for (const pid of living) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
		await until(() => living.every(p => !alive(p)), 5_000);
	}

	console.log("\nThe startup reaper leaves a harness whose --session is gone");
	{
		const { root, files } = makeRoot("g", 3);
		for (const f of files) fs.utimesSync(f, new Date(), new Date());
		const gone = files[0];
		const h = start(root, ["--harness", "claude", "--session", gone], "g.err");
		await until(() => read(h.err).includes("harness settled claude"), 10_000);
		start(root, ["--harness", "claude", "--session", files[1]], "g-ask.err");
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

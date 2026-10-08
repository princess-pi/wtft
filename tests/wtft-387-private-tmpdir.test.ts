#!/usr/bin/env bun

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { classifyPid, decideUnleased } from "../extensions/lib/holder.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

const HERE = isolateTmpdir("387-private");
const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean) {
	if (ok) { console.log(`  PASS ${label}`); passed++; }
	else { console.log(`  FAIL ${label}`); failed++; }
}

const started: number[] = [];
/** A sandbox inside here with its own tmp dir; `prepare` writes its files before the daemon starts. */
function startInBox(label: string, prepare: (box: string) => { args: string[]; env?: Record<string, string> }): { pid: number; box: string; tmp: string } {
	const box = trackSandbox(fs.mkdtempSync(path.join(HERE, `wtft-387-${label}-`)));
	const tmp = path.join(box, "tmp");
	fs.mkdirSync(tmp);
	const { args, env = {} } = prepare(box);
	const child = spawn(process.execPath, [DAEMON, ...args], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, XDG_STATE_HOME: path.join(box, "state"), TMPDIR: tmp, ...env },
	});
	child.unref();
	if (child.pid) started.push(child.pid);
	return { pid: child.pid ?? 0, box, tmp };
}

function perSessionInBox(label: string) {
	return startInBox(label, box => {
		fs.writeFileSync(path.join(box, "s.jsonl"), "{\"type\":\"session\"}\n");
		return { args: ["--session", path.join(box, "s.jsonl")] };
	});
}

function harnessInBox(label: string, withSession = true) {
	return startInBox(label, box => {
		fs.mkdirSync(path.join(box, "root", "proj"), { recursive: true });
		fs.writeFileSync(path.join(box, "root", "proj", "t.jsonl"), "{\"type\":\"session\"}\n");
		return {
			args: ["--harness", "claude", ...(withSession ? ["--session", path.join(box, "root", "proj", "t.jsonl")] : [])],
			env: { WTFT_CLAUDE_PROJECTS_DIR: path.join(box, "root"), WTFT_PI_SESSIONS_DIR: path.join(box, "no-pi") },
		};
	});
}

function daemonCmd(...args: string[]) {
	return spawnSync(process.execPath, [DAEMON, ...args], { encoding: "utf8", env: { ...process.env, TMPDIR: HERE } });
}

/** Milliseconds until `pred` holds, or Infinity after `limitMs`. */
async function until(pred: () => boolean, limitMs: number): Promise<number> {
	const t = Date.now();
	while (Date.now() - t < limitMs) {
		if (pred()) return Date.now() - t;
		await sleep(50);
	}
	return pred() ? Date.now() - t : Infinity;
}

const read = (file: string) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
const filesNaming = (dir: string, pattern: RegExp, pid: number) =>
	fs.readdirSync(dir).filter(n => pattern.test(n) && read(path.join(dir, n)).trim() === String(pid));
const LEASE = /^wtft-daemon-.*\.pid$/;
const ROOT_PID_FILE = /^wtft-harness-claude-.*\.pid$/;
/** Whether `--list` names the pid; null when `--list` itself failed. */
const listsPid = (pid: number): boolean | null => {
	const run = daemonCmd("--list");
	return run.status === 0 ? new RegExp(`^PID ${pid} `, "m").test(run.stdout) : null;
};
const gone = (pid: number) => classifyPid(pid) === "gone";
const linesFor = (out: string, pid: number) => out.split("\n").filter(l => new RegExp(`PID ${pid}\\b`).test(l));

try {
	console.log("--stop <session> stops a per-session daemon whose tmp dir is not here");
	{
		const d = perSessionInBox("stop");
		const session = path.join(d.box, "s.jsonl");
		const up = await until(() => filesNaming(d.tmp, LEASE, d.pid).length > 0, 5000) < Infinity;
		assert("fixture precondition: the daemon holds its lease in its own tmp dir", up);
		assert("fixture precondition: and none here", filesNaming(HERE, LEASE, d.pid).length === 0);
		assert("fixture precondition: --list shows it", listsPid(d.pid) === true);
		const run = daemonCmd("--stop", session);
		assert(`it reports the daemon stopped, exit 0 (${run.stdout.trim()})`, run.stdout.includes(`Stopped: PID ${d.pid} — ${session}\n`) && run.status === 0);
		assert("the pid is gone within 5 s", await until(() => gone(d.pid), 5000) < Infinity);
		assert("then --list shows no line for it", listsPid(d.pid) === false);
	}

	console.log("--cleanup stops a sandboxed harness");
	{
		const d = harnessInBox("harness");
		const up = await until(() => classifyPid(d.pid) === "harness" && filesNaming(d.tmp, ROOT_PID_FILE, d.pid).length > 0, 5000) < Infinity;
		assert("fixture precondition: the harness holds its root pid file in its own tmp dir", up);
		assert("fixture precondition: and no lease here", filesNaming(HERE, LEASE, d.pid).length === 0);
		assert("fixture precondition: --list shows it", listsPid(d.pid) === true);
		const run = daemonCmd("--cleanup");
		assert(`it reports the harness cleaned up as a fixture daemon (${run.stdout.trim()})`, new RegExp(`^Cleaned up: PID ${d.pid} — fixture daemon: `, "m").test(run.stdout) && run.status === 0);
		assert("the pid is gone within 5 s", await until(() => gone(d.pid), 5000) < Infinity);
		assert("then --list shows no line for it", listsPid(d.pid) === false);
	}

	console.log("--restart --pid restarts a per-session daemon whose tmp dir is not here, into that tmp dir");
	{
		const d = perSessionInBox("restart");
		const up = await until(() => filesNaming(d.tmp, LEASE, d.pid).length > 0, 5000) < Infinity;
		assert("fixture precondition: the daemon holds its lease in its own tmp dir", up);
		const run = daemonCmd("--restart", "--pid", String(d.pid), "--list");
		const lease = fs.readdirSync(d.tmp).find(n => LEASE.test(n));
		const holder = lease ? Number(read(path.join(d.tmp, lease)).trim()) : 0;
		if (holder > 0) started.push(holder);
		assert("--list beside it does not list the respawn", holder > 0 && linesFor(run.stdout, holder).length === 0);
		assert(`it reports the daemon restarted, exit 0 (${run.stdout.trim()})`, new RegExp(`^Restarted: PID ${d.pid} `, "m").test(run.stdout) && run.status === 0);
		assert("the old pid is gone", await until(() => gone(d.pid), 5000) < Infinity);
		assert(`a new daemon holds the lease in the old one's tmp dir (${holder})`, holder !== d.pid && classifyPid(holder) === "daemon");
		const tmpOf = read(`/proc/${holder}/environ`).split("\0").find(row => row.startsWith("TMPDIR="));
		assert(`and runs with that tmp dir (${tmpOf})`, tmpOf === `TMPDIR=${d.tmp}`);
		await sleep(500);
		assert("no lease for it was written here", !fs.readdirSync(HERE).some(n => LEASE.test(n)));
	}

	console.log("--restart --pid with --cleanup: a sandboxed harness holding a lease is restarted once, and its respawn left running");
	{
		const d = harnessInBox("both");
		const up = await until(() => classifyPid(d.pid) === "harness" && filesNaming(d.tmp, LEASE, d.pid).length > 0, 5000) < Infinity;
		assert("fixture precondition: the harness holds a lease in its own tmp dir", up);
		assert("fixture precondition: and none here", filesNaming(HERE, LEASE, d.pid).length === 0);
		const run = daemonCmd("--restart", "--pid", String(d.pid), "--cleanup");
		const lease = fs.readdirSync(d.tmp).find(n => LEASE.test(n));
		const respawn = lease ? Number(read(path.join(d.tmp, lease)).trim()) : 0;
		if (respawn > 0) started.push(respawn);
		const lines = linesFor(run.stdout, d.pid);
		assert(`one line names it, a --restart one (${lines.join(" | ")})`, lines.length === 1 && lines[0].startsWith(`Restarted: PID ${d.pid} `));
		assert("exit 0", run.status === 0);
		const tmpOf = read(`/proc/${respawn}/environ`).split("\0").find(row => row.startsWith("TMPDIR="));
		assert(`fixture precondition: the respawn is a sandboxed harness, a --cleanup candidate (${tmpOf})`, tmpOf === `TMPDIR=${d.tmp}`);
		assert(`and it is left running (${respawn})`, respawn !== d.pid && classifyPid(respawn) === "harness");
	}

	console.log("--restart --pid with --cleanup: a sandboxed harness found only through its root pid file is stopped once, by --restart");
	{
		const d = harnessInBox("rootonly", false);
		const up = await until(() => classifyPid(d.pid) === "harness" && filesNaming(d.tmp, ROOT_PID_FILE, d.pid).length > 0, 5000) < Infinity;
		assert("fixture precondition: the harness holds its root pid file in its own tmp dir", up);
		assert("fixture precondition: and no lease anywhere", filesNaming(d.tmp, LEASE, d.pid).length === 0 && filesNaming(HERE, LEASE, d.pid).length === 0);
		const run = daemonCmd("--restart", "--pid", String(d.pid), "--cleanup");
		const lines = linesFor(run.stdout, d.pid);
		assert(`one line names it, a --restart one (${lines.join(" | ")})`, lines.length === 1 && lines[0].startsWith(`Stopped: PID ${d.pid} — harness `));
		assert("exit 0", run.status === 0);
		assert("the pid is gone within 5 s", await until(() => gone(d.pid), 5000) < Infinity);
	}
} finally {
	for (const pid of started) if (pid > 0 && !gone(pid)) try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
}

console.log("decideUnleased: --stop and --cleanup for a daemon holding no lease here");
{
	const here = "/var/folders/xy/T";
	const box = `${here}/probe-a`;
	const sandboxedHarness = { pid: 1, session: `${box}/root/proj/t.jsonl`, harness: true, roots: [`${box}/root`], tmpDir: `${box}/tmp` };
	const perSession = { pid: 2, session: `${box}/s.jsonl`, harness: false, roots: [], tmpDir: `${box}/tmp` };
	const realPerSession = { pid: 3, session: "/home/u/.claude/projects/p/s.jsonl", harness: false, roots: [], tmpDir: "/tmp/elsewhere" };
	const cleanup = { tmpDir: here, cleanup: true, stopSession: null };
	const stop = (stopSession: string) => ({ tmpDir: here, cleanup: false, stopSession });

	assert("--cleanup cleans a sandboxed harness", decideUnleased(sandboxedHarness, cleanup) === "clean");
	assert("but not one whose tmp dir is here", decideUnleased({ ...sandboxedHarness, tmpDir: here }, cleanup) === "keep");
	assert("nor one whose tmp dir is outside here", decideUnleased({ ...sandboxedHarness, tmpDir: "/tmp/x" }, cleanup) === "keep");
	assert("nor one whose tmp dir could not be read", decideUnleased({ ...sandboxedHarness, tmpDir: null }, cleanup) === "keep");
	assert("nor one that sets no root variable", decideUnleased({ ...sandboxedHarness, roots: [] }, cleanup) === "keep");
	assert("nor one with a root outside here", decideUnleased({ ...sandboxedHarness, roots: [`${box}/root`, "/home/u/.pi/sessions"] }, cleanup) === "keep");
	assert("nor one whose --session is outside here", decideUnleased({ ...sandboxedHarness, session: "/home/u/.claude/projects/p/s.jsonl" }, cleanup) === "keep");
	assert("a sandboxed harness with no --session is cleaned", decideUnleased({ ...sandboxedHarness, session: null }, cleanup) === "clean");
	assert("--cleanup still cleans a per-session fixture", decideUnleased(perSession, cleanup) === "clean");
	assert("and keeps a real per-session daemon", decideUnleased(realPerSession, cleanup) === "keep");

	assert("--stop stops a per-session daemon by its session, whatever its tmp dir", decideUnleased(realPerSession, stop(realPerSession.session)) === "stop");
	assert("--stop keeps one with another session", decideUnleased(realPerSession, stop(`${box}/other.jsonl`)) === "keep");
	assert("--stop keeps a harness started for that session", decideUnleased(sandboxedHarness, stop(sandboxedHarness.session)) === "keep");
	assert("--stop keeps a daemon with no --session", decideUnleased({ ...realPerSession, session: null }, stop(realPerSession.session)) === "keep");
	assert("--cleanup and --stop together: a fixture is cleaned", decideUnleased(perSession, { tmpDir: here, cleanup: true, stopSession: perSession.session }) === "clean");
	assert("neither flag keeps everything", decideUnleased(perSession, { tmpDir: here, cleanup: false, stopSession: null }) === "keep");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

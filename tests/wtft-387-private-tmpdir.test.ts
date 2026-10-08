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
/** A sandbox inside here with its own tmp dir; the daemon runs with that tmp dir. */
function startInBox(label: string, args: (box: string) => string[], env: (box: string) => Record<string, string> = () => ({})): { pid: number; box: string; tmp: string } {
	const box = trackSandbox(fs.mkdtempSync(path.join(HERE, `wtft-387-${label}-`)));
	const tmp = path.join(box, "tmp");
	fs.mkdirSync(tmp);
	const child = spawn(process.execPath, [DAEMON, ...args(box)], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, XDG_STATE_HOME: path.join(box, "state"), TMPDIR: tmp, ...env(box) },
	});
	child.unref();
	if (child.pid) started.push(child.pid);
	return { pid: child.pid ?? 0, box, tmp };
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

const leaseNaming = (dir: string, pid: number) => fs.readdirSync(dir).some(n => /^wtft-daemon-.*\.pid$/.test(n)
	&& (() => { try { return fs.readFileSync(path.join(dir, n), "utf8").trim() === String(pid); } catch { return false; } })());
const listsPid = (pid: number) => new RegExp(`^PID ${pid} `, "m").test(daemonCmd("--list").stdout);
const gone = (pid: number) => classifyPid(pid) === "gone";

try {
	console.log("--stop <session> stops a per-session daemon whose tmp dir is not here");
	{
		const d = startInBox("stop", box => ["--session", path.join(box, "s.jsonl")]);
		const session = path.join(d.box, "s.jsonl");
		fs.writeFileSync(session, "{\"type\":\"session\"}\n");
		const up = await until(() => leaseNaming(d.tmp, d.pid), 5000) < Infinity;
		assert("fixture precondition: the daemon holds its lease in its own tmp dir", up);
		assert("fixture precondition: --list shows it", listsPid(d.pid));
		const run = daemonCmd("--stop", session);
		assert(`it reports the daemon stopped, exit 0 (${run.stdout.trim()})`, new RegExp(`^Stopped: PID ${d.pid} `, "m").test(run.stdout) && run.status === 0);
		assert("the pid is gone within 5 s", await until(() => gone(d.pid), 5000) < Infinity);
		assert("--list shows no line for it", !listsPid(d.pid));
	}

	console.log("--cleanup stops a sandboxed harness");
	{
		const d = startInBox("harness", box => ["--harness", "claude", "--session", path.join(box, "root", "proj", "t.jsonl")], box => ({
			WTFT_CLAUDE_PROJECTS_DIR: path.join(box, "root"),
			WTFT_PI_SESSIONS_DIR: path.join(box, "no-pi"),
		}));
		fs.mkdirSync(path.join(d.box, "root", "proj"), { recursive: true });
		fs.writeFileSync(path.join(d.box, "root", "proj", "t.jsonl"), "{\"type\":\"session\"}\n");
		const rootPidFile = () => fs.readdirSync(d.tmp).some(n => /^wtft-harness-claude-.*\.pid$/.test(n)
			&& fs.readFileSync(path.join(d.tmp, n), "utf8").trim() === String(d.pid));
		const up = await until(() => classifyPid(d.pid) === "harness" && rootPidFile(), 5000) < Infinity;
		assert("fixture precondition: the harness holds its root pid file in its own tmp dir", up);
		assert("fixture precondition: --list shows it", listsPid(d.pid));
		const run = daemonCmd("--cleanup");
		assert(`it reports the harness cleaned up (${run.stdout.trim()})`, new RegExp(`^Cleaned up: PID ${d.pid} `, "m").test(run.stdout) && run.status === 0);
		assert("the pid is gone within 5 s", await until(() => gone(d.pid), 5000) < Infinity);
		assert("--list shows no line for it", !listsPid(d.pid));
	}

	console.log("--restart --pid restarts a per-session daemon whose tmp dir is not here, into that tmp dir");
	{
		const d = startInBox("restart", box => ["--session", path.join(box, "s.jsonl")]);
		fs.writeFileSync(path.join(d.box, "s.jsonl"), "{\"type\":\"session\"}\n");
		const up = await until(() => leaseNaming(d.tmp, d.pid), 5000) < Infinity;
		assert("fixture precondition: the daemon holds its lease in its own tmp dir", up);
		const run = daemonCmd("--restart", "--pid", String(d.pid));
		const lease = fs.readdirSync(d.tmp).find(n => /^wtft-daemon-.*\.pid$/.test(n));
		const holder = lease ? Number(fs.readFileSync(path.join(d.tmp, lease), "utf8").trim()) : 0;
		if (holder > 0) started.push(holder);
		assert(`it reports the daemon restarted, exit 0 (${run.stdout.trim()})`, new RegExp(`^Restarted: PID ${d.pid} `, "m").test(run.stdout) && run.status === 0);
		assert("the old pid is gone", await until(() => gone(d.pid), 5000) < Infinity);
		assert(`a new daemon holds the lease in the old one's tmp dir (${holder})`, holder !== d.pid && classifyPid(holder) === "daemon");
		assert("no lease for it was written here", !fs.readdirSync(HERE).some(n => /^wtft-daemon-.*\.pid$/.test(n)));
	}
} finally {
	for (const pid of started) if (!gone(pid)) try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
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

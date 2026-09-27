#!/usr/bin/env bun
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { getDaemonPidPath } from "../extensions/lib/wtft-daemon-lib.ts";
import { classifyPid } from "../extensions/lib/holder.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { standInDaemonArgs, awaitStandIn } from "./lib/stand-in-daemon.ts";

const TMP = isolateTmpdir("274-restart");
const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-274-root-")));
const env = { ...process.env, WTFT_CLAUDE_PROJECTS_DIR: root, WTFT_PI_SESSIONS_DIR: path.join(root, "no-pi") };
const rootPidFile = path.join(TMP, `wtft-harness-claude-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12)}.pid`);
const restart = () => spawnSync("node", [DAEMON, "--restart"], { encoding: "utf8", env, timeout: 30_000 });
const children: ChildProcess[] = [];
const stopAll = () => { for (const c of children) try { process.kill(c.pid!, "SIGKILL"); } catch { /* gone */ } };
const alive = (pid: number) => classifyPid(pid) !== "gone";
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

try {
	console.log("--- B: a root pid file naming a live process that is not a daemon ---");
	{
		const bystander = spawn("sleep", ["600"], { stdio: "ignore" });
		children.push(bystander);
		fs.writeFileSync(rootPidFile, String(bystander.pid));
		check(classifyPid(bystander.pid!) === "other", "fixture precondition: the pid is a live non-daemon");
		const r = restart();
		check(alive(bystander.pid!), "the bystander survives --restart");
		check(!fs.existsSync(rootPidFile), "its root pid file is removed");
		check(/Removed root pid file: PID \d+ — no live daemon found/.test(r.stdout), "the line says it was not a daemon");
		check(r.status === 0, `nothing failed, so exit 0 (got ${r.status})`);
	}

	console.log("--- C: a harness started without --session comes back ---");
	{
		const [script] = standInDaemonArgs("setInterval(() => {}, 1000);");
		const fake = spawn(process.execPath, [script, "--harness", "claude"], { stdio: "ignore", env, detached: true });
		children.push(fake);
		check(awaitStandIn(fake.pid!) || classifyPid(fake.pid!) === "harness", "fixture precondition: the stand-in reads as a harness");
		const session = path.join(root, "proj", "a.jsonl");
		fs.mkdirSync(path.dirname(session), { recursive: true });
		fs.writeFileSync(session, "");
		fs.writeFileSync(getDaemonPidPath(session), String(fake.pid));
		const r = restart();
		check(!alive(fake.pid!), "the old harness was stopped");
		check(/Restarted: PID \d+ → fresh harness daemon \(claude\)/.test(r.stdout), `the line says it was restarted:\n${r.stdout}`);
		let holder = 0;
		for (let i = 0; i < 50 && !(holder > 0 && classifyPid(holder) === "harness"); i++) {
			sleep(100);
			try { holder = Number(fs.readFileSync(rootPidFile, "utf8").trim()); } catch { holder = 0; }
		}
		check(holder > 0 && holder !== fake.pid && classifyPid(holder) === "harness", "a new harness daemon holds the root");
		if (holder > 0) { try { process.kill(holder, "SIGTERM"); } catch { /* gone */ } }
		check(r.status === 0, `nothing failed, so exit 0 (got ${r.status})`);
	}

	console.log("--- C2: a respawn that hands off to a live harness and exits 0 counts, under the claude-code alias too ---");
	{
		const real = spawn("node", [DAEMON, "--harness", "claude"], { stdio: "ignore", env, detached: true });
		children.push(real);
		let holder = 0;
		for (let i = 0; i < 50 && holder !== real.pid; i++) {
			sleep(100);
			try { holder = Number(fs.readFileSync(rootPidFile, "utf8").trim()); } catch { holder = 0; }
		}
		check(holder === real.pid, "fixture precondition: a real harness holds the root");
		const [script] = standInDaemonArgs("setInterval(() => {}, 1000);");
		const fake = spawn(process.execPath, [script, "--harness", "claude-code"], { stdio: "ignore", env, detached: true });
		children.push(fake);
		check(awaitStandIn(fake.pid!) || classifyPid(fake.pid!) === "harness", "fixture precondition: the stand-in reads as a harness");
		const session = path.join(root, "proj", "b.jsonl");
		fs.writeFileSync(session, "");
		fs.writeFileSync(getDaemonPidPath(session), String(fake.pid));
		const r = restart();
		check(/Restarted: PID \d+ → fresh harness daemon \(claude-code\)/.test(r.stdout), `the hand-off under the claude-code alias counts as restarted:\n${r.stdout}`);
		check(r.status === 0, `exit 0 (got ${r.status})`);
		check(classifyPid(real.pid!) === "harness" && Number(fs.readFileSync(rootPidFile, "utf8").trim()) === real.pid, "the harness it handed off to still serves the root");
		check(/Left running: PID \d+ — harness .*a respawn handed its session to it/.test(r.stdout), "the line says why it was left running");
		try { process.kill(real.pid!, "SIGTERM"); } catch { /* gone */ }
	}

	console.log("--- C3: a harness with a relative root comes back in its own cwd ---");
	{
		const home = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-274-cwd-")));
		fs.mkdirSync(path.join(home, "projects", "p"), { recursive: true });
		const relEnv = { ...env, WTFT_CLAUDE_PROJECTS_DIR: "projects" };
		const relRootPid = path.join(TMP, `wtft-harness-claude-${createHash("sha256").update(path.join(home, "projects")).digest("hex").slice(0, 12)}.pid`);
		const [script] = standInDaemonArgs("setInterval(() => {}, 1000);");
		const fake = spawn(process.execPath, [script, "--harness", "claude"], { stdio: "ignore", env: relEnv, cwd: home, detached: true });
		children.push(fake);
		check(awaitStandIn(fake.pid!) || classifyPid(fake.pid!) === "harness", "fixture precondition: the stand-in reads as a harness");
		const session = path.join(home, "projects", "p", "c.jsonl");
		fs.writeFileSync(session, "");
		fs.writeFileSync(getDaemonPidPath(session), String(fake.pid));
		const r = spawnSync("node", [DAEMON, "--restart"], { encoding: "utf8", env, cwd: os.tmpdir(), timeout: 30_000 });
		check(/Restarted: PID \d+ → fresh harness daemon \(claude\)/.test(r.stdout), `restarted:\n${r.stdout}`);
		let holder = 0;
		for (let i = 0; i < 50 && !(holder > 0 && classifyPid(holder) === "harness"); i++) {
			sleep(100);
			try { holder = Number(fs.readFileSync(relRootPid, "utf8").trim()); } catch { holder = 0; }
		}
		check(holder > 0 && classifyPid(holder) === "harness", "the new harness serves the original root, not one under the caller's cwd");
		if (holder > 0) { try { process.kill(holder, "SIGTERM"); } catch { /* gone */ } }
	}

	console.log("--- C4: a holder whose cwd was deleted is still respawned ---");
	{
		const gone = fs.mkdtempSync(path.join(TMP, "gone-"));
		const session = path.join(TMP, "c4", "s.jsonl");
		fs.mkdirSync(path.dirname(session), { recursive: true });
		fs.writeFileSync(session, "");
		const [script] = standInDaemonArgs("setInterval(() => {}, 1000);");
		const fake = spawn(process.execPath, [script, "--session", session], { stdio: "ignore", env, cwd: gone, detached: true });
		children.push(fake);
		check(awaitStandIn(fake.pid!), "fixture precondition: the stand-in reads as a daemon");
		fs.rmdirSync(gone);
		check(fs.readlinkSync(`/proc/${fake.pid}/cwd`).endsWith("(deleted)"), "fixture precondition: its cwd reads as deleted");
		fs.writeFileSync(getDaemonPidPath(session), String(fake.pid));
		const r = restart();
		check(/Restarted: PID \d+ → fresh daemon for /.test(r.stdout), `restarted:\n${r.stdout}`);
		const holder = Number(fs.readFileSync(getDaemonPidPath(session), "utf8").trim());
		if (holder > 0) { try { process.kill(holder, "SIGTERM"); } catch { /* gone */ } }
	}

	console.log("--- D: a respawn that dies at once is reported, and exits 1 ---");
	{
		const tagSession = path.join(TMP, "x", "s.jsonl.wtft-tag.v1.jsonl");
		fs.mkdirSync(path.dirname(tagSession), { recursive: true });
		fs.writeFileSync(tagSession, "");
		const [script] = standInDaemonArgs("setInterval(() => {}, 1000);");
		const fake = spawn(process.execPath, [script, "--session", tagSession], { stdio: "ignore", env, detached: true });
		children.push(fake);
		check(awaitStandIn(fake.pid!), "fixture precondition: the stand-in reads as a daemon");
		fs.writeFileSync(getDaemonPidPath(tagSession), String(fake.pid));
		const r = restart();
		check(/Stopped: PID \d+ — the respawn for .* failed/.test(r.stdout), `the failed respawn is reported:\n${r.stdout}`);
		check(r.status === 1, `exit 1 (got ${r.status})`);
	}

	console.log("--- F: many respawns share one settle wait ---");
	{
		const n = 20;
		for (let i = 0; i < n; i++) {
			const tagSession = path.join(TMP, `f${i}`, "s.jsonl.wtft-tag.v1.jsonl");
			fs.mkdirSync(path.dirname(tagSession), { recursive: true });
			fs.writeFileSync(tagSession, "");
			const [script] = standInDaemonArgs("setInterval(() => {}, 1000);");
			const fake = spawn(process.execPath, [script, "--session", tagSession], { stdio: "ignore", env, detached: true });
			children.push(fake);
			check(awaitStandIn(fake.pid!), `fixture precondition: stand-in ${i} reads as a daemon`);
			fs.writeFileSync(getDaemonPidPath(tagSession), String(fake.pid));
		}
		const t0 = Date.now();
		const r = restart();
		const ms = Date.now() - t0;
		check((r.stdout.match(/the respawn for .* failed/g) ?? []).length === n, `all ${n} respawns were judged`);
		check(ms < n * 1000 / 4, `one wait, not one per holder (${ms} ms for ${n})`);
	}

	console.log("--- E: a holder that refuses the signal ---");
	console.log("  ##SKIP## E needs a process of another uid; stopHolder's denied outcome is covered over a fake table in tests/wtft-297-holder.test.ts");
} finally {
	stopAll();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

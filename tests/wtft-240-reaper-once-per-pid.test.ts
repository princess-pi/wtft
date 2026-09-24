#!/usr/bin/env bun
/**
 * A per-session daemon's startup reaper examines each distinct live pid once,
 * however many leases it holds.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("240-reaper");

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const LEASES = 2000;
const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-240-")));
const home = path.join(dir, "home");
const leaseDir = path.join(dir, "leases");
fs.mkdirSync(home);
fs.mkdirSync(leaseDir);

// A live process whose command line names a session whose tag is over 1 MB:
// every lease below names it, as a harness daemon's leases name one pid.
const heldSession = path.join(dir, "held", "held.jsonl");
fs.mkdirSync(path.join(dir, "held", "wtft-tags"), { recursive: true });
fs.writeFileSync(heldSession, "{}\n");
fs.writeFileSync(path.join(dir, "held", "wtft-tags", "held.jsonl.wtft-tag.v0.jsonl"),
	(JSON.stringify({ t: 1, c: 0.01, cat: "code", f: [], cmd: [] }) + "\n").repeat(30_000));
const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)", "--session", heldSession], { stdio: "ignore" });

const session = path.join(dir, "watched", "session.jsonl");
fs.mkdirSync(path.join(dir, "watched", "wtft-tags"), { recursive: true });
fs.writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: "p240", timestamp: new Date().toISOString(), cwd: dir }) + "\n");

let daemonPid = 0;
try {
	await sleep(300);
	check(!!holder.pid && fs.readFileSync(`/proc/${holder.pid}/cmdline`, "utf8").includes("--session"),
		"fixture: the lease holder is alive and names a session on its command line");
	for (let k = 0; k < LEASES; k++) {
		fs.writeFileSync(path.join(leaseDir, `wtft-daemon-${k.toString(16).padStart(12, "0")}.pid`), String(holder.pid));
	}
	check(fs.statSync(path.join(dir, "held", "wtft-tags", "held.jsonl.wtft-tag.v0.jsonl")).size > 1_000_000,
		"fixture: the holder's tag is over the 1 MB warning size");

	const started = Date.now();
	let log = "";
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", session], {
		stdio: ["ignore", "ignore", "pipe"],
		env: { ...process.env, TMPDIR: leaseDir, HOME: home, WTFT_DAEMON_DEBUG: "1" },
	});
	daemonPid = child.pid ?? 0;
	child.stderr!.on("data", d => { log += String(d); });
	let startedAt = 0;
	for (let i = 0; i < 600 && !startedAt; i++) {
		await sleep(50);
		if (log.includes("started, watching")) startedAt = Date.now();
	}
	const elapsed = startedAt ? startedAt - started : Infinity;
	check(elapsed < 1500, `a per-session daemon starts within 1.5 s beside ${LEASES} leases of one live pid (took ${elapsed} ms)`);

	const reapLog = path.join(home, ".local", "state", "wtft", "reap.log");
	const lines = fs.existsSync(reapLog) ? fs.readFileSync(reapLog, "utf8").split("\n").filter(l => l.includes(`PID ${holder.pid}`)) : [];
	check(lines.length === 1, `reap.log gains one line about that pid, not one per lease (got ${lines.length})`);
} finally {
	if (daemonPid) { try { process.kill(daemonPid, "SIGTERM"); } catch { /* gone */ } }
	try { holder.kill("SIGKILL"); } catch { /* gone */ }
	await sleep(200);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

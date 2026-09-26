#!/usr/bin/env -S bun
/**
 * #281: the spawner claims the session lease for its child. docs/spec-281-spawner-claims-lease.md § 3.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { claimLeaseForChild } from "../extensions/lib/lease.ts";
import { spawnWtftDaemon } from "../extensions/lib/wtft-cli-shared.ts";
import { getDaemonPidPath, restartDaemon } from "../extensions/lib/wtft-daemon-lib.ts";
import { isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("spawner-claims-lease-281");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-281-"));
const deadPid = (() => {
	const child = spawn(process.execPath, ["-e", "0"]);
	const pid = child.pid!;
	child.kill("SIGKILL");
	return pid;
})();
await new Promise(r => setTimeout(r, 200));
const CHILD = process.pid;

/** Start `script` as a grandchild, so it is not this process's child: a child
 *  that exits stays a zombie, alive to kill 0, while this process is blocked. */
function startOrphan(script: string, args: string[]): number {
	const quoted = [process.execPath, script, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
	const out = execFileSync("sh", ["-c", `${quoted} </dev/null >/dev/null 2>&1 & echo $!`], { encoding: "utf8", env: process.env });
	return Number(out.trim());
}

console.log("C1. claimLeaseForChild");
{
	const f = path.join(dir, "absent.pid");
	check(claimLeaseForChild(f, CHILD) === "claimed" && fs.readFileSync(f, "utf8") === String(CHILD), "C1a an absent lease is claimed for the child");
}
{
	const f = path.join(dir, "empty.pid");
	fs.writeFileSync(f, "");
	check(claimLeaseForChild(f, CHILD) === "claimed" && fs.readFileSync(f, "utf8") === String(CHILD), "C1b an empty lease is claimed for the child");
}
{
	const f = path.join(dir, "dead.pid");
	let alive = true;
	try { process.kill(deadPid, 0); } catch { alive = false; }
	check(!alive, "C1c precondition: the dead pid is not alive");
	fs.writeFileSync(f, String(deadPid));
	check(claimLeaseForChild(f, CHILD) === "claimed" && fs.readFileSync(f, "utf8") === String(CHILD), "C1c a lease naming a dead pid is claimed for the child");
}
{
	const f = path.join(dir, "rebuild.pid");
	fs.writeFileSync(f, "rebuild");
	check(claimLeaseForChild(f, CHILD) === "busy" && fs.readFileSync(f, "utf8") === "rebuild", "C1d a rebuild token is left for the child, byte for byte");
}
{
	const f = path.join(dir, "live.pid");
	const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"]);
	fs.writeFileSync(f, String(holder.pid));
	check(claimLeaseForChild(f, CHILD) === "busy" && fs.readFileSync(f, "utf8") === String(holder.pid), "C1e a live holder is left alone, byte for byte");
	holder.kill("SIGKILL");
}
{
	const f = path.join(dir, "gone-child.pid");
	check(claimLeaseForChild(f, deadPid) === "busy" && !fs.existsSync(f), "C1f a child already gone is not claimed for: no lease is left naming it");
}

console.log("\nC2. spawnWtftDaemon claims the lease before the child runs");
{
	const standIn = path.join(dir, "bin");
	fs.mkdirSync(standIn);
	fs.writeFileSync(path.join(standIn, "wtft-daemon.mjs"),
		"import * as fs from 'node:fs';\n" +
		"let seen = ''; try { seen = fs.readFileSync(process.env.WTFT281_LEASE, 'utf8'); } catch {}\n" +
		"fs.writeFileSync(process.env.WTFT281_OUT, JSON.stringify({ seen, pid: process.pid }));\n" +
		"setTimeout(() => {}, 3000);\n");
	const session = path.join(dir, "c2-session.jsonl");
	fs.writeFileSync(session, "");
	const lease = getDaemonPidPath(session);
	const out = path.join(dir, "c2-out.json");
	process.env.WTFT281_LEASE = lease;
	process.env.WTFT281_OUT = out;
	check(!fs.existsSync(lease), "C2 precondition: no lease before the spawn");
	const child = spawnWtftDaemon(session, standIn);
	const atReturn = fs.existsSync(lease) ? fs.readFileSync(lease, "utf8") : "";
	check(child !== null && atReturn === String(child.pid), "C2a the lease names the child's pid when spawnWtftDaemon returns");
	for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise(r => setTimeout(r, 20));
	const seen = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : null;
	check(seen !== null && seen.seen === String(seen.pid), "C2b the child's first line finds its own pid in the lease");
	child?.kill("SIGKILL");
}

console.log("\nC3. a harness start that finds a live harness leaves the lease naming the harness");
{
	const root = path.join(dir, "claude-root");
	const proj = path.join(root, "proj");
	fs.mkdirSync(proj, { recursive: true });
	const turn = (id: string) => JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(),
		message: { role: "assistant", id, model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: "text", text: "t" }] } }) + "\n";
	const a = path.join(proj, "281-a.jsonl");
	const b = path.join(proj, "281-b.jsonl");
	fs.writeFileSync(a, turn("a1"));
	fs.writeFileSync(b, turn("b1"));
	process.env.WTFT_CLAUDE_PROJECTS_DIR = root;
	process.env.WTFT_PI_SESSIONS_DIR = path.join(root, "no-pi");
	const binDir = path.resolve(import.meta.dirname, "..", "bin");
	const read = (f: string) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return ""; } };
	const harness = spawnWtftDaemon(a, binDir);
	const harnessPid = harness?.pid ?? 0;
	let up = false;
	for (let i = 0; i < 100 && !up; i++) { await new Promise(r => setTimeout(r, 50)); up = read(getDaemonPidPath(a)) === String(harnessPid) && fs.readdirSync(os.tmpdir()).some(n => n.startsWith("wtft-harness-claude-") && n.endsWith(".pid") && read(path.join(os.tmpdir(), n)) === String(harnessPid)); }
	check(up, "C3 precondition: the first start became the harness and holds session A's lease and the root");
	// Stopped, the harness cannot adopt B from the focus request, so the lease
	// the second start leaves behind is the one pointSessionAt wrote.
	process.kill(harnessPid, "SIGSTOP");
	const second = spawnWtftDaemon(b, binDir);
	const secondPid = second?.pid ?? 0;
	check(secondPid > 0 && secondPid !== harnessPid, "C3 precondition: a second process was spawned for session B");
	check(read(getDaemonPidPath(b)) === String(secondPid), "C3 precondition: the spawner's claim named the second start in session B's lease");
	let exited = false;
	for (let i = 0; i < 400 && !exited; i++) {
		try { process.kill(secondPid, 0); } catch { exited = true; }
		if (!exited) await new Promise(r => setTimeout(r, 25));
	}
	check(exited, "C3 precondition: the second start handed off and exited");
	const atExit = read(getDaemonPidPath(b));
	check(atExit === String(harnessPid), `C3 with the harness stopped, the second start's exit leaves session B's lease naming the harness (${harnessPid}), not the exited start (${secondPid}); read ${JSON.stringify(atExit)}`);
	try { process.kill(harnessPid, "SIGCONT"); process.kill(harnessPid, "SIGTERM"); } catch {}
	await new Promise(r => setTimeout(r, 300));
}

console.log("\nC4. restartDaemon waits for the old per-session daemon, then spawns and claims");
{
	const log = path.join(dir, "c4-log.jsonl");
	const script = path.join(dir, "c4-daemon.mjs");
	fs.writeFileSync(script,
		"import * as fs from 'node:fs';\n" +
		"const note = (e) => fs.appendFileSync(process.env.WTFT281_LOG, JSON.stringify({ pid: process.pid, e, t: performance.timeOrigin + performance.now() }) + '\\n');\n" +
		"note('start');\n" +
		"process.on('SIGTERM', () => setTimeout(() => { note('exit'); process.exit(0); }, 300));\n" +
		"setTimeout(() => {}, 10000);\n");
	process.env.WTFT281_LOG = log;
	const session = path.join(dir, "c4-session.jsonl");
	fs.writeFileSync(session, "");
	const lease = getDaemonPidPath(session);
	const old = { pid: startOrphan(script, ["--session", session]) };
	fs.writeFileSync(lease, String(old.pid));
	for (let i = 0; i < 100 && !fs.existsSync(log); i++) await new Promise(r => setTimeout(r, 20));
	check(fs.existsSync(log), "C4 precondition: the old stand-in is running");
	check(restartDaemon(session, script), "C4 restartDaemon reports a spawn");
	let leaseNow = ""; try { leaseNow = fs.readFileSync(lease, "utf8").trim(); } catch { /* no lease */ }
	for (let i = 0; i < 100; i++) {
		const n = fs.readFileSync(log, "utf8").trim().split("\n").length;
		if (n >= 3) break;
		await new Promise(r => setTimeout(r, 20));
	}
	const events = fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l));
	const oldExit = events.find(e => e.pid === old.pid && e.e === "exit");
	const newStart = events.find(e => e.pid !== old.pid && e.e === "start");
	check(oldExit !== undefined, "C4 the old daemon exited");
	check(newStart !== undefined && oldExit !== undefined && newStart.t >= oldExit.t, "C4 the new daemon started only after the old one exited");
	check(newStart !== undefined && leaseNow === String(newStart.pid), "C4 the lease names the new daemon when restartDaemon returns");
	if (newStart) try { process.kill(newStart.pid, "SIGKILL"); } catch {}
}

console.log("\nC4b. restartDaemon kills a holder that ignores SIGTERM before it spawns");
{
	const log = path.join(dir, "c4b-log.jsonl");
	const script = path.join(dir, "c4b-daemon.mjs");
	fs.writeFileSync(script,
		"import * as fs from 'node:fs';\n" +
		"fs.appendFileSync(process.env.WTFT281_LOG, JSON.stringify({ pid: process.pid, e: 'start', t: performance.timeOrigin + performance.now() }) + '\\n');\n" +
		"process.on('SIGTERM', () => {});\n" +
		"setTimeout(() => {}, 20000);\n");
	process.env.WTFT281_LOG = log;
	const session = path.join(dir, "c4b-session.jsonl");
	fs.writeFileSync(session, "");
	const lease = getDaemonPidPath(session);
	const old = { pid: startOrphan(script, ["--session", session]) };
	fs.writeFileSync(lease, String(old.pid));
	for (let i = 0; i < 100 && !fs.existsSync(log); i++) await new Promise(r => setTimeout(r, 20));
	await new Promise(r => setTimeout(r, 200));
	restartDaemon(session, script);
	let oldAlive = true;
	try { process.kill(old.pid!, 0); } catch { oldAlive = false; }
	check(!oldAlive, "C4b the old holder is gone when restartDaemon returns, so no two daemons share the tag");
	let leaseNow = ""; try { leaseNow = fs.readFileSync(lease, "utf8").trim(); } catch {}
	if (leaseNow && leaseNow !== String(old.pid)) try { process.kill(Number(leaseNow), "SIGKILL"); } catch {}
	if (oldAlive) try { process.kill(old.pid!, "SIGKILL"); } catch {}
}

console.log("\nC6. a per-session child beside a newer-version tag serves when the lease names itself");
{
	const session = path.join(dir, "c6-session.jsonl");
	fs.writeFileSync(session, "");
	const tags = path.join(dir, "wtft-tags");
	fs.mkdirSync(tags, { recursive: true });
	fs.writeFileSync(path.join(tags, "c6-session.jsonl.wtft-tag.v99.0.0.jsonl"), "");
	const binDir = path.resolve(import.meta.dirname, "..", "bin");
	const child = spawnWtftDaemon(session, binDir);
	await new Promise(r => setTimeout(r, 1500));
	let alive = false;
	try { process.kill(child!.pid!, 0); alive = true; } catch {}
	let leaseNow = ""; try { leaseNow = fs.readFileSync(getDaemonPidPath(session), "utf8").trim(); } catch {}
	check(alive && leaseNow === String(child!.pid), "C6 it is alive and holds the lease 1.5 s later: a newer tag with no live newer holder does not make it exit");
	try { process.kill(child!.pid!, "SIGTERM"); } catch {}
}

console.log("\nC7. a harness start that cannot serve takes back the spawner's claim");
{
	const missingRoot = path.join(dir, "no-such-root");
	const session = path.join(missingRoot, "proj", "c7.jsonl");
	process.env.WTFT_CLAUDE_PROJECTS_DIR = missingRoot;
	const binDir = path.resolve(import.meta.dirname, "..", "bin");
	const child = spawnWtftDaemon(session, binDir);
	let exited = false;
	for (let i = 0; i < 200 && !exited; i++) { await new Promise(r => setTimeout(r, 25)); try { process.kill(child!.pid!, 0); } catch { exited = true; } }
	check(exited, "C7 precondition: the start exited (its root does not exist)");
	check(!fs.existsSync(getDaemonPidPath(session)), "C7 no lease is left naming the exited start");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

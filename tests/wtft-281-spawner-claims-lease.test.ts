#!/usr/bin/env -S bun
/**
 * #281: the spawner claims the session lease for its child. docs/spec-281-spawner-claims-lease.md § 3.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { claimLeaseForChild } from "../extensions/lib/lease.ts";
import { spawnWtftDaemon } from "../extensions/lib/wtft-cli-shared.ts";
import { getDaemonPidPath } from "../extensions/lib/wtft-daemon-lib.ts";
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

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

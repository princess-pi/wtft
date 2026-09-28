#!/usr/bin/env bun

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { reapFixtureDaemons } from "./lib/reap-fixture-daemons.ts";
import { isFixtureDaemon } from "../extensions/lib/holder.ts";
import { standInDaemonArgs, awaitStandIn } from "./lib/stand-in-daemon.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("96-fixture");

const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean) {
	if (ok) { console.log(`  PASS ${label}`); passed++; }
	else { console.log(`  FAIL ${label}`); failed++; }
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-96-")));
const session = path.join(dir, "session.jsonl");
fs.writeFileSync(session, "{\"type\":\"session\"}\n");
const privateTmp = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-96-pid-")));

console.log("wtft fixture daemons (#96)");

const child = spawn(process.execPath, [DAEMON, "--session", session], {
	detached: true,
	stdio: "ignore",
	env: { ...process.env, TMPDIR: privateTmp },
});
child.unref();
const pid = child.pid ?? 0;

try {
	let up = false;
	for (let i = 0; i < 30 && !up; i++) {
		await sleep(100);
		up = alive(pid);
	}
	assert("fixture daemon started", up);

	const killed = reapFixtureDaemons(dir);
	await sleep(300);
	assert(`the reaper kills a daemon whose session is under tmp (signalled ${killed})`, killed >= 1 && !alive(pid));

} finally {
	try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
	reapFixtureDaemons(dir);
}

console.log("--cleanup stops the fixture daemons under its own tmp dir, and no others");
{
	const inside = standInDaemonArgs("setInterval(() => {}, 1000);", "--session", path.join(dir, "inside.jsonl"));
	const outsideDir = trackSandbox(fs.mkdtempSync("/tmp/wtft-96-outside-"));
	const outside = standInDaemonArgs("setInterval(() => {}, 1000);", "--session", path.join(outsideDir, "outside.jsonl"));
	const a = spawn(process.execPath, inside, { detached: true, stdio: "ignore" });
	const b = spawn(process.execPath, outside, { detached: true, stdio: "ignore", env: { ...process.env, TMPDIR: outsideDir } });
	a.unref();
	b.unref();
	try {
		assert("fixture precondition: both stand-ins read as daemons", awaitStandIn(a.pid!) && awaitStandIn(b.pid!));
		assert("fixture precondition: the tmp dir is not /tmp itself", path.resolve(os.tmpdir()) !== "/tmp");
		const run = spawnSync(process.execPath, [DAEMON, "--cleanup"], { encoding: "utf8", env: { ...process.env, TMPDIR: os.tmpdir() } });
		await sleep(300);
		assert(`it stops the one under its tmp dir (${run.stdout.trim()})`, run.stdout.includes(`Cleaned up: PID ${a.pid}`) && !alive(a.pid!));
		assert("and leaves one under /tmp/ outside it running", !run.stdout.includes(String(b.pid)) && alive(b.pid!));
	} finally {
		for (const p of [a.pid, b.pid]) try { process.kill(p!, "SIGTERM"); } catch { /* gone */ }
	}
}

console.log("--cleanup's fixture rule");
{
	const tmp = "/var/folders/xy/T";
	assert("a session under the tmp dir is a fixture", isFixtureDaemon({ session: `${tmp}/wtft-96-a/s.jsonl`, roots: [] }, tmp));
	assert("a session under /tmp/ outside the tmp dir is not", !isFixtureDaemon({ session: "/tmp/wtft-96-b/s.jsonl", roots: [] }, tmp));
	assert("a harness root under the tmp dir is a fixture", isFixtureDaemon({ session: null, roots: [`${tmp}/projects`] }, tmp));
	assert("a real session is not", !isFixtureDaemon({ session: "/home/u/.claude/projects/p/s.jsonl", roots: ["/home/u/.claude/projects"] }, tmp));
	assert("a path that only starts with the tmp dir's name is not", !isFixtureDaemon({ session: `${tmp}-other/s.jsonl`, roots: [] }, tmp));
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

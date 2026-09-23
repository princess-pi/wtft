#!/usr/bin/env bun
/**
 * #96 — a suite must not leave a fixture daemon, and --cleanup must see one
 * whose pid file lives in another tmp dir.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { reapFixtureDaemons } from "./lib/reap-fixture-daemons.ts";
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

	const killed = reapFixtureDaemons();
	await sleep(300);
	assert(`the reaper kills a daemon whose session is under tmp (signalled ${killed})`, killed >= 1 && !alive(pid));

	const again = spawn(process.execPath, [DAEMON, "--session", session], {
		detached: true,
		stdio: "ignore",
		env: { ...process.env, TMPDIR: privateTmp },
	});
	again.unref();
	const pid2 = again.pid ?? 0;
	let up2 = false;
	for (let i = 0; i < 30 && !up2; i++) {
		await sleep(100);
		up2 = alive(pid2);
	}
	const cleanup = spawn(process.execPath, [DAEMON, "--cleanup"], {
		stdio: ["ignore", "pipe", "ignore"],
		env: { ...process.env, TMPDIR: os.tmpdir() },
	});
	const out = await new Promise<string>(resolve => {
		let buf = "";
		cleanup.stdout?.on("data", (d) => { buf += d.toString(); });
		cleanup.on("exit", () => resolve(buf));
	});
	await sleep(300);
	assert(
		`--cleanup from the default tmp sees the fixture daemon (${out.trim()})`,
		out.includes(String(pid2)) && !alive(pid2),
	);
} finally {
	try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
	reapFixtureDaemons();
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

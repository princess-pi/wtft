#!/usr/bin/env bun
/**
 * wtft --restart waits for wtft-daemon --restart: docs/spec-439-443-restart-scope.md.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { getDaemonPidPath } from "../extensions/lib/wtft-daemon-lib.ts";
import { classifyPid } from "../extensions/lib/holder.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { standInDaemonArgs, awaitStandIn } from "./lib/stand-in-daemon.ts";

isolateTmpdir("443-restart-wait");
const WTFT = path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-443-root-")));
const env = { ...process.env, WTFT_CLAUDE_PROJECTS_DIR: root, WTFT_PI_SESSIONS_DIR: path.join(root, "no-pi") };
const children: ChildProcess[] = [];
const SETTLE_MS = 11_000;

try {
	console.log("--- a --restart whose own run passes 10 s still exits 0 ---");
	const session = path.join(root, "proj", "a.jsonl");
	fs.mkdirSync(path.dirname(session), { recursive: true });
	fs.writeFileSync(session, "");
	const [script] = standInDaemonArgs("setInterval(() => {}, 1000);");
	const fake = spawn(process.execPath, [script, "--session", session], { stdio: "ignore", env, detached: true });
	children.push(fake);
	check(awaitStandIn(fake.pid!), "fixture precondition: the stand-in reads as a daemon");
	const lease = getDaemonPidPath(session);
	fs.writeFileSync(lease, String(fake.pid));

	const t0 = Date.now();
	const r = spawnSync(process.execPath, [WTFT, "--restart"], { encoding: "utf8", env: { ...env, WTFT_RESPAWN_SETTLE_MS: String(SETTLE_MS) }, timeout: 60_000 });
	const ms = Date.now() - t0;
	const respawn = Number(fs.existsSync(lease) ? fs.readFileSync(lease, "utf8").trim() : 0);
	if (respawn > 0) try { process.kill(respawn, "SIGTERM"); } catch { /* gone */ }

	check(ms >= SETTLE_MS, `fixture precondition: wtft-daemon --restart ran past 10 s (${ms} ms)`);
	check(r.status === 0, `exit 0 (got ${r.status}): ${r.stderr}`);
	check(new RegExp(`Restarted: PID ${fake.pid} → fresh daemon`).test(r.stdout), `the holder was respawned:\n${r.stdout}`);
	check(respawn > 0 && respawn !== fake.pid && classifyPid(respawn) !== "gone", "a new daemon held its lease");
} finally {
	for (const c of children) try { process.kill(c.pid!, "SIGKILL"); } catch { /* gone */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

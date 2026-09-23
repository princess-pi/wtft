#!/usr/bin/env -S bun
/**
 * The test runner's fixture-daemon reaper, scoped to one suite's directory:
 * with suites running side by side, reaping one suite's leftovers must not
 * kill a daemon another suite is still using.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { reapFixtureDaemons } from "./lib/reap-fixture-daemons.ts";
import { trackSandbox } from "./lib/sandbox";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-215-")));
const suiteA = path.join(root, "suite-a");
const suiteB = path.join(root, "suite-b");
fs.mkdirSync(suiteA);
fs.mkdirSync(suiteB);
// A stand-in daemon: the reaper matches on the script's name and its --session.
const fake = path.join(root, "wtft-daemon.mjs");
fs.writeFileSync(fake, "setInterval(() => {}, 1000);\n");

const start = (dir: string) => spawn(process.execPath, [fake, "--session", path.join(dir, "s.jsonl")], { stdio: "ignore" });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Poll, bounded: a loaded host can take longer than any fixed sleep. */
async function until(cond: () => boolean, ms = 10_000): Promise<boolean> {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (cond()) return true;
	return cond();
}

const a = start(suiteA);
const b = start(suiteB);
check(await until(() => alive(a.pid!) && alive(b.pid!)), "R0 fixture precondition: both stand-in daemons are running");

const killed = reapFixtureDaemons(suiteA);
check(killed === 1 && await until(() => !alive(a.pid!)), `R1 reaping suite A's directory stops suite A's daemon (killed ${killed})`);
check(alive(b.pid!), "R2 and leaves suite B's daemon running");

try { process.kill(b.pid!, "SIGTERM"); } catch {}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

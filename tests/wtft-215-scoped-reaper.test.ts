#!/usr/bin/env -S bun
/**
 * The test runner's fixture-daemon reaper, scoped to one suite's directory:
 * with suites running side by side, reaping one suite's leftovers must not
 * kill a daemon another suite is still using.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
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
const fake = path.join(root, "wtft-daemon.mjs");
fs.writeFileSync(fake, "setInterval(() => {}, 1000);\n");

const start = (dir: string) => spawn(process.execPath, [fake, "--session", path.join(dir, "s.jsonl")], { stdio: "ignore" });
const exited = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null;
/** The reaper reads /proc/<pid>/cmdline and environ, which name the parent's image until the child's exec completes. */
const execed = (pid: number) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes(fake); } catch { return false; } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Poll, bounded: a loaded host can take longer than any fixed sleep. */
async function until(cond: () => boolean, ms = 10_000): Promise<boolean> {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (cond()) return true;
	return cond();
}

const a = start(suiteA);
const b = start(suiteB);
check(await until(() => execed(a.pid!) && execed(b.pid!)), "R0 fixture precondition: both stand-in daemons are running");

const killed = reapFixtureDaemons(suiteA);
check(killed === 1 && await until(() => exited(a)), `R1 reaping suite A's directory stops suite A's daemon (killed ${killed})`);
check(execed(b.pid!), "R2 and leaves suite B's daemon running");

const elsewhere = path.join(root, "elsewhere");
fs.mkdirSync(elsewhere);
const c = spawn(process.execPath, [fake, "--session", path.join(elsewhere, "s.jsonl")], { stdio: "ignore", env: { ...process.env, TMPDIR: suiteA } });
check(await until(() => execed(c.pid!)), "R3 fixture precondition: a daemon whose session is outside suite A but whose TMPDIR is suite A's is running");
const killedByTmp = reapFixtureDaemons(suiteA);
check(killedByTmp === 1 && await until(() => exited(c)), `R3 reaping suite A's directory stops it too (killed ${killedByTmp})`);
check(execed(b.pid!), "R4 and still leaves suite B's daemon running");

for (const p of [a, b, c]) p.kill("SIGTERM");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

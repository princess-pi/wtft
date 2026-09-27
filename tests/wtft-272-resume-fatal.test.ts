#!/usr/bin/env bun
/**
 * A tag the daemon cannot read at start is never appended onto: it is fatal, as a failed
 * rebuild truncate is. docs/spec-272-resume-fatal.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { getCurrentVersionTagPath, getDaemonPidPath } from "../extensions/lib/wtft-daemon-lib.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("272-resume");
const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-272-")));
const turn = (id: string, ts: number) => JSON.stringify({
	type: "assistant", timestamp: new Date(ts).toISOString(),
	message: { role: "assistant", model: "claude-sonnet-4-6", usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "t" }] },
	...(id ? { id } : {}),
}) + "\n";
const session = path.join(root, "proj", "s.jsonl");
fs.mkdirSync(path.dirname(session), { recursive: true });
fs.writeFileSync(session, turn("", Date.now() - 60_000) + turn("", Date.now() - 30_000));

const tag = getCurrentVersionTagPath(session);
fs.mkdirSync(path.dirname(tag), { recursive: true });
// An earlier life's tag: one id-less turn, which a re-parse appended after it would bill twice.
const earlier = JSON.stringify({ t: Date.now() - 60_000, c: 0.01, cat: "code", f: [], cmd: [], m: "claude-sonnet-4-6", in: 1000, out: 10, cr: 0, cw: 0, rs: 0 }) + "\n";
fs.writeFileSync(tag, earlier);
// Writable but not readable: an append would succeed, so only the read tells the daemon anything.
fs.chmodSync(tag, 0o200);
const sizeBefore = fs.statSync(tag).size;
let readable = true;
try { fs.readFileSync(tag); } catch { readable = false; }
check(!readable, "fixture precondition: the tag cannot be read");

const env = { ...process.env, WTFT_CLAUDE_PROJECTS_DIR: path.join(root, "no-claude"), WTFT_PI_SESSIONS_DIR: path.join(root, "no-pi") };
const r = spawnSync("node", [DAEMON, "--session", session], { encoding: "utf8", env, timeout: 10_000 });
check(r.status === 1, `the daemon exits 1 (status ${r.status}${r.signal ? `, killed by ${r.signal} at the timeout` : ""})`);
check(/FATAL: the derived tag resume read failed/.test(r.stderr), "stderr names the failed resume read");
let lease = "";
try { lease = fs.readFileSync(getDaemonPidPath(session), "utf8").trim(); } catch { /* none */ }
check(lease === "rebuild", `the lease reads rebuild (got "${lease}")`);
check(fs.statSync(tag).size === sizeBefore, `the tag gained no line (${sizeBefore} → ${fs.statSync(tag).size} bytes)`);
fs.chmodSync(tag, 0o600);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

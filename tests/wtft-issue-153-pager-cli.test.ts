#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/wtft-issue-153-pager-cli.test.ts — CLI rejects -p/--pager (#153)
 *
 * -p opens a Pi TUI overlay (extensions/wtft.ts). The standalone CLI parsed the
 * flag into opts.pager and then never read it, so `wtft -p …` rendered exactly as
 * if -p were absent — no output, no warning, no error. It now refuses.
 *
 * Run: node --experimental-strip-types tests/wtft-issue-153-pager-cli.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const wtftBin = path.join(process.cwd(), "bin", "wtft.mjs");

// ---
// FIXTURE: a minimal one-message session, so the no-flag control has something
// real to render and cannot pass for the wrong reason (e.g. "no sessions found").
// ---

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-153-"));
const sessionPath = path.join(dir, "fixture-153-pager.jsonl");
const TS = new Date("2026-07-01T12:00:00Z").toISOString();

fs.writeFileSync(sessionPath, JSON.stringify({
	type: "assistant",
	timestamp: TS,
	message: {
		role: "assistant", id: "msg_153_001", model: "claude-opus-5",
		content: [{ type: "text", text: "hello" }],
		usage: {
			input_tokens: 2, output_tokens: 200,
			cache_read_input_tokens: 50000,
			cache_creation_input_tokens: 1000,
			cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
		},
	},
}) + "\n");

/** Run the CLI; never throws. Returns exit status plus both streams. */
function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync(process.execPath, [wtftBin, ...args], {
			encoding: "utf8", timeout: 20000, stdio: "pipe",
		});
		return { status: 0, stdout, stderr: "" };
	} catch (err: any) {
		return {
			status: typeof err.status === "number" ? err.status : -1,
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? err.message ?? "",
		};
	}
}

// ---
// TEST 1: -p exits non-zero
// ---
console.log("--- TEST 1: -p is rejected ---");

const short = runCli(["--session", sessionPath, "-l", "5", "-p"]);
check(short.status !== 0, "-p → non-zero exit");
check(short.stderr.includes("--pager"), "-p → stderr names --pager");
check(short.stderr.includes("less -R"), "-p → stderr suggests `less -R`");

// ---
// TEST 2: the long form is rejected identically
// ---
console.log("--- TEST 2: --pager is rejected ---");

const long = runCli(["--session", sessionPath, "-l", "5", "--pager"]);
check(long.status !== 0, "--pager → non-zero exit");
check(long.stderr.includes("less -R"), "--pager → same guidance as -p");

// ---
// TEST 3: the guard does not swallow normal runs
// ---
console.log("--- TEST 3: without -p the CLI still renders ---");

const control = runCli(["--session", sessionPath, "-l", "5"]);
check(control.status === 0, "no -p → exit 0");
check(!control.stderr.includes("--pager"), "no -p → no pager error");
check(control.stdout.length > 0, "no -p → produces output");

// ---
// TEST 4: --help still documents the flag
// ---
console.log("--- TEST 4: --help unaffected ---");
// The flag remains valid inside the Pi TUI, so help must keep describing it —
// the CLI refuses to *run* it, it does not pretend the flag never existed.

const help = runCli(["--help"]);
check(help.status === 0, "--help → exit 0");
check(help.stdout.includes("--pager"), "--help → still lists --pager");

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

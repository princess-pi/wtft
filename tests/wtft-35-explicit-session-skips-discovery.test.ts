#!/usr/bin/env bun
/**
 * An explicit `-s <existing session>` must not scan the session
 *   corpus (#35).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { cliWithoutDaemon, tagForCli } from "./lib/cli-harness.ts";
import { skip } from "./lib/skips.ts";

isolateTmpdir("explicit-session-skips-discovery");

// Bun does not hand a sync child the runtime env mutation isolateTmpdir just
// made, so every child takes this explicitly — same rule as #486.
const CHILD_ENV = process.env;

const SCRIPT = `${process.execPath} ${cliWithoutDaemon()}`;
const COUNT_PRELOAD = path.resolve(import.meta.dirname, "lib", "count-fs-under.mjs");
const RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function assert(label: string, ok: boolean, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n       ${detail}` : ""}`); failed++; }
}
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

const SESSION_ID = "35c0de00-1a9b-4c3d-9e8f-000000000035";
const TS = Date.now();
const sessionLines = () => [
	JSON.stringify({
		type: "assistant",
		message: {
			role: "assistant", id: "msg_35_001", model: "claude-sonnet-4-20250514",
			timestamp: new Date(TS - 600_000).toISOString(),
			usage: { input_tokens: 2000, output_tokens: 500 },
			content: [{ type: "tool_use", name: "write", input: { file_path: "src/main.ts" } }],
		},
	}),
	JSON.stringify({
		type: "assistant",
		message: {
			role: "assistant", id: "msg_35_002", model: "claude-sonnet-4-20250514",
			timestamp: new Date(TS - 300_000).toISOString(),
			usage: { input_tokens: 500, output_tokens: 200 },
			content: [{ type: "tool_use", name: "bash", input: { command: "git diff --stat" } }],
		},
	}),
].join("\n") + "\n";

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-35-")));
const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);
process.on("exit", () => {
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

/** Both harnesses take a root override, so the corpus under test is exactly what
 *  we put there — without both, the developer's own ~/.pi sessions leak in. */
const corpus = (claudeDir: string, piDir: string) => ({
	...CHILD_ENV, WTFT_CLAUDE_PROJECTS_DIR: claudeDir, WTFT_PI_SESSIONS_DIR: piDir,
});

const run = (args: string, env: NodeJS.ProcessEnv, timeout = 30_000) => {
	try {
		// `env: env`, not the shorthand: the daemon-suite-isolation gate (#486) reads
		// this as source text, and object shorthand reads to it as no env at all.
		return { out: execSync(`${SCRIPT} ${args} 2>&1`, { encoding: "utf8", env: env, timeout }), code: 0 };
	} catch (err: any) {
		return { out: `${err.stdout || ""}${err.stderr || ""}`, code: err.status ?? 1 };
	}
};

/** One CLI run under a preload that counts node:fs calls on paths under `watched`.
 *  `ok` is false when the run failed or rendered nothing, so a fast failure never
 *  reads as zero reads. */
function countedRun(args: string[], env: NodeJS.ProcessEnv, watched: string): { reads: number; ok: boolean; detail: string } {
	const countFile = path.join(dir, "fs-count");
	try { fs.rmSync(countFile, { force: true }); } catch {}
	const r = spawnSync(process.execPath, ["--preload", COUNT_PRELOAD, cliWithoutDaemon(), ...args], {
		encoding: "utf8", env: { ...env, WTFT_COUNT_FS_UNDER: watched, WTFT_COUNT_FS_OUT: countFile }, timeout: 30_000,
	});
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
	const rendered = /[\u2588\u2591\u2592\u2593]/.test(out) || /\$\d/.test(stripAnsi(out));
	let reads = NaN;
	try { reads = Number(fs.readFileSync(countFile, "utf8")); } catch {}
	return { reads, ok: r.status === 0 && rendered, detail: `exit ${r.status}, rendered=${rendered}, reads=${reads}: ${stripAnsi(out).trim().slice(0, 200)}` };
}

const emptyPi = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-35-empty-p-")));

// ---
// 0. Tag the session first, so the runs below only read it.
// ---
console.log("0. Tag the session");
{
	fs.writeFileSync(sessionPath, sessionLines());
	tagForCli(sessionPath);
}

// ---
// 1. The A/B: the same explicit -s, against an empty corpus and a stranded one.
// ---
console.log("\n1. Explicit -s reads nothing in a stranded corpus");
if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
	skip("the corpus reads are counted from a bun --preload hook; run the suite under bun");
} else {
	// Stranded = the state `pr-cleanup` leaves behind: a recorded cwd whose
	// directory is gone, which costs discovery a tail scan per transcript.
	const bigClaude = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-35-big-c-")));
	const proj = path.join(bigClaude, "-home-gone-worktree");
	fs.mkdirSync(proj, { recursive: true });
	for (let i = 0; i < 50; i++) {
		const id = `35c0de00-1a9b-4c3d-9e8f-${String(i).padStart(12, "0")}`;
		fs.writeFileSync(path.join(proj, `${id}.jsonl`),
			sessionLines() + JSON.stringify({ type: "user", cwd: `/home/princess-pi/NO-SUCH-DIR-${i}`, message: { role: "user", content: "hi" } }) + "\n");
	}

	const fuzzy = spawnSync(process.execPath, ["--preload", COUNT_PRELOAD, cliWithoutDaemon(), "-s", "zzz-matches-nothing", "-l", "5", "--no-emoji"], {
		encoding: "utf8", env: { ...corpus(bigClaude, emptyPi), WTFT_COUNT_FS_UNDER: bigClaude, WTFT_COUNT_FS_OUT: path.join(dir, "fuzzy-count") }, timeout: 30_000,
	});
	let fuzzyReads = 0;
	try { fuzzyReads = Number(fs.readFileSync(path.join(dir, "fuzzy-count"), "utf8")); } catch {}
	assert("precondition: the counter sees a fuzzy -s scan the corpus", fuzzyReads > 0, `exit ${fuzzy.status}, reads=${fuzzyReads}`);

	const explicit = countedRun(["-s", sessionPath, "-l", "5", "--no-emoji"], corpus(bigClaude, emptyPi), bigClaude);
	assert("an explicit -s renders the session", explicit.ok, explicit.detail);
	assert("and makes no file-system call under the corpus", explicit.ok && explicit.reads === 0, explicit.detail);

	try { fs.rmSync(bigClaude, { recursive: true, force: true }); } catch {}
}

// ---
// 2. Guard: the fuzzy path still discovers, and still counts what it found.
//    A fix that simply removed discovery would pass part 1 and fail here.
// ---
console.log("\n2. Fuzzy -s still scans the corpus");
{
	const fuzzyClaude = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-35-fuzzy-c-")));
	const proj = path.join(fuzzyClaude, "-home-fuzzy");
	fs.mkdirSync(proj, { recursive: true });
	// Recorded cwd = this process's cwd, so both are live candidates here.
	for (const id of ["35c0de00-1a9b-4c3d-9e8f-0000000000a1", "35c0de00-1a9b-4c3d-9e8f-0000000000a2"]) {
		fs.writeFileSync(path.join(proj, `${id}.jsonl`),
			sessionLines() + JSON.stringify({ type: "user", cwd: process.cwd(), message: { role: "user", content: "hi" } }) + "\n");
	}

	const { out, code } = run(`-s zzz-matches-nothing -l 5 --no-emoji`, corpus(fuzzyClaude, emptyPi));
	const clean = stripAnsi(out).trim();

	// #89, E3: with no interactive terminal (exactly what `execSync` gives this
	// suite) a substring matching nothing is EXIT_SESSION_AMBIGUOUS (10), not
	// the old plain exit 1 — a deliberate contract change, not a regression.
	assert("a substring matching nothing is still an error", code === 10, `exit ${code}: ${clean}`);
	assert("and it reports the discovered count (discovery ran)", /\(2 available\)/.test(clean), clean);

	try { fs.rmSync(fuzzyClaude, { recursive: true, force: true }); } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

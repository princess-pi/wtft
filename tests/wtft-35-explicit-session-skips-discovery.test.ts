#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test wtft-35-explicit-session-skips-discovery
 * @description An explicit `-s <existing session>` must not scan the session
 *   corpus (#35).
 *
 *   `bin/wtft.ts` called `discoverSessions()` unconditionally, before it looked
 *   at `-s`. Its result is read in exactly two branches — the fuzzy-substring
 *   fallback and the auto-select menu — and neither is reachable once `-s`
 *   resolves to an existing file or a pending path. So the scan was paid for and
 *   thrown away.
 *
 *   It is not a cheap scan. Discovery asks each transcript where it lives, and a
 *   transcript whose recorded `cwd` no longer exists falls through to
 *   `resolveCwdHistory`, a documented WHOLE-FILE read. That fallback was budgeted
 *   for "3 transcripts in 40"; the workflow deletes a worktree after every merge
 *   (`pr-cleanup`), which strands every session that lived there permanently, so
 *   the measured hit rate on the development host is 34 in 40 — 2,622 of 3,073
 *   transcripts, 760 MB re-read on every invocation, 3,215-4,528 ms against 86 ms
 *   with an empty corpus. It degrades monotonically with every branch merged.
 *
 *   WHY THIS ONE IS TIMED, WHEN THE HOUSE RULE IS TO WAIT ON STATE. Cost IS the
 *   behaviour under test: "did not read the corpus" has no other user-visible
 *   effect on this path. Three cheaper probes were tried against the real CLI and
 *   all three are invisible from outside — a FIFO is skipped by the `!isFile()`
 *   guard in `resolveCwdHistory`, a `chmod 000` project dir is swallowed, and a
 *   corpus of unparseable transcripts renders identically. So the assertion is a
 *   RATIO against the same command in the same run with an empty corpus, never a
 *   wall-clock threshold: a threshold would encode "fast enough on this box
 *   today", while the ratio cancels box speed, load, and cold cache. Calibrated
 *   here: empty 87-100 ms, stranded 480-508 ms — 5.2x. The gate is 2x.
 *
 *   Part 2 is the guard against fixing this by deleting the feature: on the fuzzy
 *   path discovery MUST still run, and its count must still reach the user.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { getDaemonPidPath } from "../extensions/lib/wtft-daemon-lib.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { pollUntil } from "./lib/poll";

isolateTmpdir("explicit-session-skips-discovery");

// Bun does not hand a sync child the runtime env mutation isolateTmpdir just
// made, so every child takes this explicitly — same rule as #486.
const CHILD_ENV = process.env;

const SCRIPT = path.resolve(import.meta.dirname, "..", "wtft");
const RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function assert(label: string, ok: boolean, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n       ${detail}` : ""}`); failed++; }
}
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
const readPid = (p: string): number => {
	try { return parseInt(fs.readFileSync(p, "utf8").trim(), 10) || 0; } catch { return 0; }
};

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
const pidPath = getDaemonPidPath(sessionPath);
try { fs.unlinkSync(pidPath); } catch {}
process.on("exit", () => {
	const pid = readPid(pidPath);
	if (pid > 0) { try { process.kill(pid, "SIGTERM"); } catch {} }
	try { fs.unlinkSync(pidPath); } catch {}
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

/** Median of three, so one scheduler hiccup cannot decide the verdict. */
function medianRunMs(args: string, env: NodeJS.ProcessEnv): number {
	const times: number[] = [];
	for (let i = 0; i < 3; i++) {
		const t0 = performance.now();
		run(args, env);
		times.push(performance.now() - t0);
	}
	return times.sort((a, b) => a - b)[1];
}

const emptyClaude = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-35-empty-c-")));
const emptyPi = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-35-empty-p-")));

// ---
// 0. Warm the session first, so the A/B below times a pure read: daemon already
//    up, tag file written, interactions classified. Otherwise the first timed run
//    carries a daemon spawn the others do not.
// ---
console.log("0. Warm the session (daemon up, tag classified)");
{
	fs.writeFileSync(sessionPath, sessionLines());
	run(`-s '${sessionPath}' -l 5 --no-emoji`, corpus(emptyClaude, emptyPi));
	const tagsDir = path.join(dir, "wtft-tags");
	const classified = await pollUntil(() => fs.readdirSync(tagsDir).some(f => {
		if (!f.startsWith(SESSION_ID)) return false;
		const c = fs.readFileSync(path.join(tagsDir, f), "utf8");
		return c.split("\n").some(l => l.trim() && !l.includes('"_hb"') && !l.includes('"_meta"'));
	}), 20_000, 250);
	assert("session is classified and ready to render", classified);
}

// ---
// 1. The A/B: the same explicit -s, against an empty corpus and a stranded one.
// ---
console.log("\n1. Explicit -s costs the same with or without a corpus");
{
	// Stranded = the state `pr-cleanup` leaves behind: a recorded cwd whose
	// directory is gone, which is what sends discovery down the whole-file read.
	const bigClaude = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-35-big-c-")));
	const proj = path.join(bigClaude, "-home-gone-worktree");
	fs.mkdirSync(proj, { recursive: true });
	const one = JSON.stringify({
		type: "assistant",
		message: {
			role: "assistant", id: "filler", model: "claude-sonnet-4-20250514",
			usage: { input_tokens: 10, output_tokens: 10 },
			content: [{ type: "text", text: "y".repeat(900) }],
		},
	}) + "\n";
	const body = one.repeat(Math.ceil(8 * 1024 / one.length));
	for (let i = 0; i < 6000; i++) {
		const id = `35c0de00-1a9b-4c3d-9e8f-${String(i).padStart(12, "0")}`;
		fs.writeFileSync(path.join(proj, `${id}.jsonl`),
			body + JSON.stringify({ type: "user", cwd: `/home/princess-pi/NO-SUCH-DIR-${i}`, message: { role: "user", content: "hi" } }) + "\n");
	}

	const args = `-s '${sessionPath}' -l 5 --no-emoji`;
	const emptyMs = medianRunMs(args, corpus(emptyClaude, emptyPi));
	const strandedMs = medianRunMs(args, corpus(bigClaude, emptyPi));
	const ratio = strandedMs / emptyMs;
	const detail = `empty ${emptyMs.toFixed(0)}ms, stranded ${strandedMs.toFixed(0)}ms, ratio ${ratio.toFixed(1)}x`;

	assert("a 6000-transcript stranded corpus costs under 2x an empty one", ratio < 2, detail);
	console.log(`       (${detail})`);

	const { out, code } = run(args, corpus(bigClaude, emptyPi));
	assert("and it still renders the session named by -s", code === 0 && (/[█░▒▓]/.test(out) || /\$\d/.test(stripAnsi(out))), stripAnsi(out).trim());

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

	assert("a substring matching nothing is still an error", code === 1, `exit ${code}: ${clean}`);
	assert("and it reports the discovered count (discovery ran)", /\(2 available\)/.test(clean), clean);

	try { fs.rmSync(fuzzyClaude, { recursive: true, force: true }); } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

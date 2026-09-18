#!/usr/bin/env -S bun
/**
 * tests/wtft-89-no-tty-exit.test.ts — the no-TTY EXIT_SESSION_AMBIGUOUS (10)
 * contract (#89, E2–E5). Spec: docs/spec-89-scoped-picker.md.
 *
 * This is the file docs/spec-89-scoped-picker.md's own Verification section
 * originally named and, until now, never shipped (pr-review round 2, Low) —
 * `tests/wtft-35-explicit-session-skips-discovery.test.ts` covers only the
 * `-s` zero-match case; every other arm of the exit-10 contract (several `-s`
 * matches, no `-s` with zero or several default-scoped candidates, and the
 * `--json` empty-stdout guarantee) had no coverage until this suite.
 *
 * Every `spawnSync` call here is already non-TTY by construction (a spawned
 * child's stdio defaults to pipes), which is exactly the E2–E5 precondition —
 * no pty simulation needed.
 *
 * Run: bun tests/wtft-89-no-tty-exit.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("89-no-tty-exit");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_BIN = path.join(REPO_ROOT, "bin", "wtft.mjs");
const EXIT_SESSION_AMBIGUOUS = 10;

function writeSession(file: string, id: string, cwd: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({
		type: "assistant", cwd,
		message: {
			role: "assistant", id: "msg_" + id, model: "claude-sonnet-4-5",
			usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: [{ type: "text", text: "ok" }],
		},
	}) + "\n");
}

/** Encode the way Claude Code does — matches extensions/lib/harness/session-cwd.ts's
 *  cwdToStrictSlug, re-derived here rather than imported so this suite has no
 *  production-source dependency beyond the CLI binary itself. */
function slugOf(dir: string): string {
	return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

function run(args: string[], opts: { cwd: string; claudeProjects: string; pi?: string }) {
	return spawnSync("node", [CLI_BIN, ...args], {
		cwd: opts.cwd,
		encoding: "utf8",
		env: {
			...process.env,
			WTFT_CLAUDE_PROJECTS_DIR: opts.claudeProjects,
			WTFT_PI_SESSIONS_DIR: opts.pi ?? trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-89-nopi-"))),
		},
	});
}

// ---
// E4 — no `-s`, ZERO default-scoped candidates → exit 10.
// ---
console.log("\n=== E4: no -s, zero candidates in the default scope → exit 10 ===\n");
{
	const target = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-89-e4-zero-")));
	const projects = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-89-e4-zero-proj-")));
	// Nothing written for `target`'s slug at all.
	const r = run(["-l", "5"], { cwd: target, claudeProjects: projects });
	check(r.status === EXIT_SESSION_AMBIGUOUS, `E4: exit is ${EXIT_SESSION_AMBIGUOUS} (got ${r.status})`);
	check(/not specified precisely enough/.test(r.stderr), `E4: stderr names the reason (${r.stderr.slice(0, 200)})`);
	check((r.stdout || "").trim() === "", "E4: stdout carries nothing");
}

// ---
// E4 — no `-s`, SEVERAL default-scoped candidates → exit 10.
// ---
console.log("\n=== E4: no -s, several candidates in the default scope → exit 10 ===\n");
{
	const target = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-89-e4-several-")));
	const projects = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-89-e4-several-proj-")));
	const slug = slugOf(target);
	writeSession(path.join(projects, slug, "e4-a.jsonl"), "e4a", target);
	writeSession(path.join(projects, slug, "e4-b.jsonl"), "e4b", target);

	const r = run(["-l", "5"], { cwd: target, claudeProjects: projects });
	check(r.status === EXIT_SESSION_AMBIGUOUS, `E4: exit is ${EXIT_SESSION_AMBIGUOUS} (got ${r.status})`);
	check(/matched 2 sessions/.test(r.stderr), `E4: stderr names the count (${r.stderr.slice(0, 300)})`);
	check(/e4-a\.jsonl/.test(r.stderr) && /e4-b\.jsonl/.test(r.stderr), "E4: stderr names both candidates");
	check((r.stdout || "").trim() === "", "E4: stdout carries nothing");
}

// ---
// E3 — `-s <substring>` matches SEVERAL sessions, no TTY → exit 10 (the
// zero-match arm is tests/wtft-35-explicit-session-skips-discovery.test.ts's
// own coverage; this is the sibling case that suite does not cover).
// ---
console.log("\n=== E3: -s matches several, no TTY → exit 10 ===\n");
{
	const target = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-89-e3-several-")));
	const projects = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-89-e3-several-proj-")));
	const slug = slugOf(target);
	writeSession(path.join(projects, slug, "e3-shared-one.jsonl"), "e3a", target);
	writeSession(path.join(projects, slug, "e3-shared-two.jsonl"), "e3b", target);

	const r = run(["-s", "shared", "-l", "5"], { cwd: target, claudeProjects: projects });
	check(r.status === EXIT_SESSION_AMBIGUOUS, `E3: exit is ${EXIT_SESSION_AMBIGUOUS} (got ${r.status})`);
	check(/matched 2 sessions/.test(r.stderr), `E3: stderr names the count (${r.stderr.slice(0, 300)})`);
	check((r.stdout || "").trim() === "", "E3: stdout carries nothing");
}

// ---
// E3/E1 — the SAME ambiguous population under --json: stdout is STILL
// completely empty (the "nothing" contract exit 1 already carries, per
// docs/spec-26-json.md), not a partial or malformed JSON fragment.
// ---
console.log("\n=== E3 + --json: exit 10, stdout carries NOTHING ===\n");
{
	const target = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-89-e3json-")));
	const projects = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-89-e3json-proj-")));
	const slug = slugOf(target);
	writeSession(path.join(projects, slug, "e3j-one.jsonl"), "e3j1", target);
	writeSession(path.join(projects, slug, "e3j-two.jsonl"), "e3j2", target);

	const r = run(["-s", "e3j", "--json"], { cwd: target, claudeProjects: projects });
	check(r.status === EXIT_SESSION_AMBIGUOUS, `E3+json: exit is ${EXIT_SESSION_AMBIGUOUS} (got ${r.status})`);
	check((r.stdout || "").trim() === "", `E3+json: stdout carries nothing, not even partial JSON (${JSON.stringify(r.stdout)})`);
	let parsedAnyway = false;
	try { JSON.parse(r.stdout); parsedAnyway = true; } catch { /* expected */ }
	check(!parsedAnyway, "E3+json: stdout is not even accidentally valid JSON (it's empty)");
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

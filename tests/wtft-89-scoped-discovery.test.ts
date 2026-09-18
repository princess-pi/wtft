#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/wtft-89-scoped-discovery.test.ts — the #89 scoped picker's discovery
 * side (S1–S7). Spec: docs/spec-89-scoped-picker.md.
 *
 * Every fixture here uses WTFT_CLAUDE_PROJECTS_DIR / WTFT_PI_SESSIONS_DIR (per
 * CLAUDE.md: never read this host's real ~/.claude or ~/.pi corpus).
 *
 * `discoverSessions(harness, target, scopeOpts)` is exercised directly rather
 * than through `bin/wtft.ts`'s CLI wiring — the CLI layer is what CHOOSES
 * `{ scope: "worktree", windowMs: 20m }` as its own default (see the
 * "library default vs. CLI default" interpretation note in the spec); this
 * suite is what proves each scope option itself behaves as specified.
 *
 * Run: node --experimental-strip-types tests/wtft-89-scoped-discovery.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { trackSandbox } from "./lib/sandbox";

import {
	discoverSessions,
	resetCwdCache,
	getCwdReadCount,
	resetHarnessRegistry,
	cwdToStrictSlug,
	buildDisplayPath,
} from "../bin/wtft.mjs";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

function mktmp(prefix: string): string {
	return fs.realpathSync(trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), prefix))));
}

function writeTranscript(file: string, cwd: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lines = [
		JSON.stringify({ type: "user", cwd, message: { role: "user", content: "hi" } }),
		JSON.stringify({
			type: "assistant", cwd,
			message: {
				role: "assistant", id: "msg_" + path.basename(file, ".jsonl"),
				model: "claude-sonnet-4-5",
				usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				content: [{ type: "text", text: "ok" }],
			},
		}),
	];
	fs.writeFileSync(file, lines.join("\n") + "\n");
}

function makeRepoWithWorktree(sandbox: string): { clone: string; worktree: string; branch: string } | null {
	try {
		const clone = path.join(sandbox, "clone");
		fs.mkdirSync(clone, { recursive: true });
		const run = (dir: string, args: string[]) =>
			execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 });
		run(clone, ["init", "-q", "-b", "main"]);
		run(clone, ["config", "user.email", "t@example.com"]);
		run(clone, ["config", "user.name", "t"]);
		fs.writeFileSync(path.join(clone, "README"), "x\n");
		run(clone, ["add", "-A"]);
		run(clone, ["commit", "-qm", "init"]);
		const branch = "89-branch";
		const worktree = path.join(clone, ".claude", "worktrees", branch);
		run(clone, ["worktree", "add", "-q", "-b", branch, worktree]);
		return { clone, worktree: fs.realpathSync(worktree), branch };
	} catch {
		return null;
	}
}

function setEnvAndRun<T>(projects: string, fn: () => T): T {
	process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
	resetHarnessRegistry();
	resetCwdCache();
	try {
		return fn();
	} finally {
		delete process.env.WTFT_CLAUDE_PROJECTS_DIR;
	}
}

// ---
// S1 — default "worktree" scope: single directory, no fan-out, no union arm,
// zero tail reads.
// ---
console.log("\n=== S1: 'worktree' scope is folder-name-only, zero reads ===\n");
{
	const sandbox = mktmp("wtft-89-s1-");
	const repo = makeRepoWithWorktree(sandbox);
	if (!repo) {
		console.log("  (skip: git worktree unusable)");
	} else {
		const projects = path.join(sandbox, "projects");
		fs.mkdirSync(projects, { recursive: true });

		// Physically filed under the worktree's own slug — found by folder match.
		const inWorktree = path.join(projects, cwdToStrictSlug(repo.worktree), "own.jsonl");
		writeTranscript(inWorktree, repo.worktree);

		// Filed under the CLONE's slug, but its last recorded cwd is the
		// worktree — only the union arm could find this from the worktree side.
		const wandered = path.join(projects, cwdToStrictSlug(repo.clone), "wandered.jsonl");
		writeTranscript(wandered, repo.worktree);

		setEnvAndRun(projects, () => {
			const found = discoverSessions("claude-code", repo.worktree, { scope: "worktree", windowMs: null });
			const names = found.map((c: any) => c.name);
			check(names.includes("own.jsonl"), "S1: a session physically filed under the target is found");
			check(!names.includes("wandered.jsonl"),
				"S1: a session found only via the union arm is NOT found under 'worktree' scope");
			check(getCwdReadCount() === 0, `S1: zero tail reads — folder match only (${getCwdReadCount()})`);
		});
	}
}

// ---
// S2 — "worktrees" scope fans out AND runs the union arm, bounded by window.
// ---
console.log("\n=== S2: 'worktrees' scope fans out and unions, bounded by window ===\n");
{
	const sandbox = mktmp("wtft-89-s2-");
	const repo = makeRepoWithWorktree(sandbox);
	if (!repo) {
		console.log("  (skip: git worktree unusable)");
	} else {
		const projects = path.join(sandbox, "projects");
		fs.mkdirSync(projects, { recursive: true });

		// Filed under a slug OUTSIDE the fan-out set entirely (pr-review, Low:
		// the earlier fixture filed it under the CLONE's own slug, which is
		// itself a fan-out target — a physical-slug match, not the union arm —
		// so the assertion below passed without the arm under test ever
		// running). Only its LAST RECORDED cwd, the worktree, is a fan-out
		// target, so only `matchesRecordedCwd`'s tail read can find this one.
		const elsewhereDir = path.join(sandbox, "not-a-checkout-of-this-repo");
		const wandered = path.join(projects, cwdToStrictSlug(elsewhereDir), "wandered.jsonl");
		writeTranscript(wandered, repo.worktree);

		setEnvAndRun(projects, () => {
			const viaWorktree = discoverSessions("claude-code", repo.worktree, { scope: "worktree", windowMs: null })
				.map((c: any) => c.name);
			check(!viaWorktree.includes("wandered.jsonl"),
				"S2 sanity: 'worktree' scope (no union arm) does NOT find it — proves the fixture needs the union arm");

			const found = discoverSessions("claude-code", repo.worktree, { scope: "worktrees", windowMs: null })
				.map((c: any) => c.name);
			check(found.includes("wandered.jsonl"), "S2: the union arm finds a session filed under an unrelated slug");

			// Now push the fixture's mtime outside a tiny window — the union arm
			// must skip the tail read entirely rather than finding it anyway.
			const old = new Date(Date.now() - 60 * 60 * 1000);
			fs.utimesSync(wandered, old, old);
			resetCwdCache();
			const windowed = discoverSessions("claude-code", repo.worktree, { scope: "worktrees", windowMs: 1000 })
				.map((c: any) => c.name);
			check(!windowed.includes("wandered.jsonl"),
				"S2: a transcript outside the time window is excluded from the union arm's population");
			check(getCwdReadCount() === 0,
				`S2: …and no tail read was spent finding that out (${getCwdReadCount()})`);
		});
	}
}

// ---
// S3 — "all" scope ignores cwd entirely, bounded only by window.
// ---
console.log("\n=== S3: 'all' scope ignores cwd ===\n");
{
	const sandbox = mktmp("wtft-89-s3-");
	const projects = path.join(sandbox, "projects");
	fs.mkdirSync(projects, { recursive: true });

	const unrelatedDir = path.join(sandbox, "totally-unrelated");
	const unrelated = path.join(projects, cwdToStrictSlug(unrelatedDir), "unrelated.jsonl");
	writeTranscript(unrelated, unrelatedDir);

	setEnvAndRun(projects, () => {
		const scopedToHere = discoverSessions("claude-code", sandbox, { scope: "worktree", windowMs: null })
			.map((c: any) => c.name);
		check(!scopedToHere.includes("unrelated.jsonl"), "S3 sanity: 'worktree' scope does not see an unrelated dir");

		const everything = discoverSessions("claude-code", sandbox, { scope: "all", windowMs: null })
			.map((c: any) => c.name);
		check(everything.includes("unrelated.jsonl"), "S3: 'all' scope finds a session anywhere, cwd ignored");

		const old = new Date(Date.now() - 60 * 60 * 1000);
		fs.utimesSync(unrelated, old, old);
		resetCwdCache();
		const windowed = discoverSessions("claude-code", sandbox, { scope: "all", windowMs: 1000 })
			.map((c: any) => c.name);
		check(!windowed.includes("unrelated.jsonl"), "S3: 'all' scope is still bounded by the time window");
	});
}

// ---
// S4 — "branch" scope narrows to the checkout of the cwd's current branch.
// ---
console.log("\n=== S4: 'branch' scope ===\n");
{
	const sandbox = mktmp("wtft-89-s4-");
	const repo = makeRepoWithWorktree(sandbox);
	if (!repo) {
		console.log("  (skip: git worktree unusable)");
	} else {
		const projects = path.join(sandbox, "projects");
		fs.mkdirSync(projects, { recursive: true });

		const inClone = path.join(projects, cwdToStrictSlug(repo.clone), "in-clone.jsonl");
		writeTranscript(inClone, repo.clone);
		const inWorktree = path.join(projects, cwdToStrictSlug(repo.worktree), "in-worktree.jsonl");
		writeTranscript(inWorktree, repo.worktree);

		setEnvAndRun(projects, () => {
			// Standing IN the worktree, on branch "89-branch": branch scope must
			// resolve to the SAME single checkout — the worktree itself — and
			// must NOT pull in the main clone's session.
			const found = discoverSessions("claude-code", repo.worktree, { scope: "branch", windowMs: null })
				.map((c: any) => c.name);
			check(found.includes("in-worktree.jsonl"), "S4: branch scope finds the session in the matching checkout");
			check(!found.includes("in-clone.jsonl"), "S4: …and not the main clone's, which is on a different branch");
		});

		// Fallback: WTFT_NO_GIT makes the branch unresolvable — must fall back
		// to plain 'worktree' behaviour (the target dir alone), not throw and
		// not silently widen to something else.
		process.env.WTFT_NO_GIT = "1";
		setEnvAndRun(projects, () => {
			const found = discoverSessions("claude-code", repo.worktree, { scope: "branch", windowMs: null })
				.map((c: any) => c.name);
			check(found.includes("in-worktree.jsonl"),
				"S4: with git unusable, 'branch' scope falls back to the target directory itself");
		});
		delete process.env.WTFT_NO_GIT;
	}
}

// ---
// S5 — the time window bounds EVERY scope uniformly, including the cheap
// default.
// ---
console.log("\n=== S5: the time window applies to 'worktree' scope too ===\n");
{
	const sandbox = mktmp("wtft-89-s5-");
	const projects = path.join(sandbox, "projects");
	const target = path.join(sandbox, "here");
	const file = path.join(projects, cwdToStrictSlug(target), "old.jsonl");
	writeTranscript(file, target);
	const old = new Date(Date.now() - 60 * 60 * 1000);
	fs.utimesSync(file, old, old);

	setEnvAndRun(projects, () => {
		const unbounded = discoverSessions("claude-code", target, { scope: "worktree", windowMs: null })
			.map((c: any) => c.name);
		check(unbounded.includes("old.jsonl"), "S5: unbounded window finds an old, physically-matching session");

		const bounded = discoverSessions("claude-code", target, { scope: "worktree", windowMs: 1000 })
			.map((c: any) => c.name);
		check(!bounded.includes("old.jsonl"), "S5: a 1s window excludes it even though it physically matches");
	});
}

// ---
// S6 — an empty window returns an empty list; discovery itself never widens.
// ---
console.log("\n=== S6: an out-of-window scope returns empty, never widens itself ===\n");
{
	const sandbox = mktmp("wtft-89-s6-");
	const projects = path.join(sandbox, "projects");
	const target = path.join(sandbox, "here");
	const file = path.join(projects, cwdToStrictSlug(target), "session.jsonl");
	writeTranscript(file, target);
	const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
	fs.utimesSync(file, old, old);

	setEnvAndRun(projects, () => {
		const found = discoverSessions("claude-code", target, { scope: "worktree", windowMs: 1000 });
		check(Array.isArray(found) && found.length === 0,
			"S6: an out-of-window population is an empty array, not a wider (or thrown) result");
	});
}

// ---
// S7 — Pi worktree/branch derivation, via the shared buildDisplayPath
// (@princess-pi/libs/session-path-shortener) — harness-agnostic already, and
// this confirms it covers Pi's own slug shape (#89 needed no new code here;
// see docs/spec-89-scoped-picker.md).
// ---
console.log("\n=== S7: Pi worktree/branch derivation ===\n");
{
	const homeSlug = os.homedir().replace(/^\//, "").replace(/\//g, "-");
	const piInTreeSlug = `--${homeSlug}-git-projects-demo--claude-worktrees-99-branch--`;
	check(
		buildDisplayPath("2026-09-18_x5e9e.jsonl", piInTreeSlug, "pi") === "~/g-p/demo/w/99-branch/2026-09-18...5e9e",
		"S7: a Pi session recorded inside a .claude/worktrees/<branch> dir shows repo/w/branch"
	);

	const piMainCloneSlug = `--${homeSlug}-git-projects-demo--`;
	const rendered = buildDisplayPath("2026-09-18_x5e9e.jsonl", piMainCloneSlug, "pi");
	check(
		!rendered.includes("/w/"),
		`S7: a Pi session recorded from the main clone shows no branch, never a guessed one (${rendered})`
	);
}

// ---
// S1 (Pi) — 'worktree' scope matches EXACTLY, not by containment (pr-review
// round 1, Medium: the first cut reused Pi's fan-out containment test for
// every scope, so a default-scope picker over-matched any sibling project
// sharing a name prefix, and every in-tree worktree's own sessions).
//
// Directory names below are written literally — the SAME real shape
// tests/wtft-89-scoped-discovery.test.ts's own S7 section and
// docs/EXT_WTFT.html use (`--home-<user>-git-projects-<project>--`) — rather
// than built from `cwdToSlug(target)` the way the matcher itself computes a
// variant. Building the fixture and the matcher from the same expression is
// exactly how pr-review round 1's version of this test passed against a
// matcher that built the WRONG wrapped string (three leading dashes instead
// of Pi's real two — round 2, High): the fixture and the bug agreed with
// each other. A literal, independently-written real-shaped name is what
// actually exercises the matcher against the shape it will see on disk.
// ---
console.log("\n=== S1 (Pi): 'worktree' scope is exact, not containment ===\n");
{
	const sandbox = mktmp("wtft-89-s1-pi-");
	const piRoot = path.join(sandbox, "pi-sessions");
	const homeSlug = os.homedir().replace(/^\//, "").replace(/\//g, "-");
	const target = path.join(os.homedir(), "git-projects", "demo89");

	const writeSession = (dirName: string, fileName: string, id: string) => {
		const dir = path.join(piRoot, dirName);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, fileName),
			JSON.stringify({ type: "message", message: { role: "assistant", id, usage: {} } }) + "\n");
	};

	// The exact target dir, real Pi shape — must match.
	writeSession(`--${homeSlug}-git-projects-demo89--`, "2026-09-18_own.jsonl", "m1");
	// A sibling whose slug CONTAINS the target's slug as a prefix — must NOT
	// match under "worktree" scope (containment would have matched this).
	writeSession(`--${homeSlug}-git-projects-demo89-sibling--`, "2026-09-18_sibling.jsonl", "m2");
	// An in-tree worktree of the SAME repo — must not match under "worktree"
	// scope either (that is what Ctrl+W / "worktrees" scope is for).
	writeSession(`--${homeSlug}-git-projects-demo89--claude-worktrees-99-branch--`, "2026-09-18_worktree.jsonl", "m3");

	process.env.WTFT_PI_SESSIONS_DIR = piRoot;
	resetHarnessRegistry();
	resetCwdCache();
	try {
		const found = discoverSessions("pi", target, { scope: "worktree", windowMs: null }).map((c: any) => c.name);
		check(found.includes("2026-09-18_own.jsonl"), `S1 (Pi): the exact target directory is found (${found.join(",")})`);
		check(!found.includes("2026-09-18_sibling.jsonl"),
			"S1 (Pi): a sibling whose slug merely CONTAINS the target's is NOT found under 'worktree' scope");
		check(!found.includes("2026-09-18_worktree.jsonl"),
			"S1 (Pi): an in-tree worktree of the same repo is NOT found under 'worktree' scope either");

		const widened = discoverSessions("pi", target, { scope: "worktrees", windowMs: null }).map((c: any) => c.name);
		check(widened.includes("2026-09-18_worktree.jsonl"),
			"S1 (Pi) sanity: the worktree IS found once 'worktrees' scope's containment match applies");
	} finally {
		delete process.env.WTFT_PI_SESSIONS_DIR;
	}
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

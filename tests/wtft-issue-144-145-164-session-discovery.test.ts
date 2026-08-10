#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/wtft-issue-144-145-164-session-discovery.test.ts
 *   — three ways a Claude session goes missing from wtft (#144, #145, #164)
 *
 * Spec: docs/spec-144-145-164-session-discovery.md (V1–V21).
 *
 *   A  V1–V4    #144  slug encoding is a UNION of encodings, not a pinned class
 *   B  V5–V10   #164  a session stranded in a REMOVED directory is findable
 *   C  V12–V17  #145  live sibling worktrees fan out, non-repos do not
 *   D  V18–V20  #145  worktree rows render as <repo>/w/<branch>
 *   E  V11      #164  cost: the whole-file scan stays gated on real history
 *
 * V21 is the whole-suite invariant and is not asserted here — it is what
 * `bun run test` reports across every suite.
 *
 * Everything runs through interfaces exported from bin/wtft.mjs —
 * `discoverSessions`, `resolveLastCwd`, `resolveCwdHistory`, `buildDisplayPath`,
 * `fanOutCwd`, `findRepoRoot`, the slug helpers and the read counters — against
 * fixture trees pointed at by WTFT_CLAUDE_PROJECTS_DIR. No module internals are
 * touched.
 *
 * On clocks: no assertion depends on the wall-clock *date* — the #96 flaky
 * pricing trap. Part E does read `Date.now()`, but only to measure elapsed
 * time against the 500 ms discovery ceiling, which is the same thing
 * tests/wtft-issue-156-harness-seam.test.ts already does. A duration is the
 * quantity under test there, so it cannot be injected away.
 *
 * Run: node --experimental-strip-types tests/wtft-issue-144-145-164-session-discovery.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
	discoverSessions,
	resolveLastCwd,
	resolveCwdHistory,
	resetCwdCache,
	getCwdReadCount,
	getCwdHistoryReadCount,
	cwdToSlug,
	cwdToStrictSlug,
	cwdSlugVariants,
	slugMatchesCwd,
	buildDisplayPath,
	fanOutCwd,
	findRepoRoot,
	resetHarnessRegistry,
} from "../bin/wtft.mjs";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const tmpRoots: string[] = [];
function mktmp(prefix: string): string {
	// realpathSync: on macOS os.tmpdir() is a symlink, and every rule here
	// compares resolved absolute paths.
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tmpRoots.push(dir);
	return dir;
}
function cleanup() {
	for (const dir of tmpRoots) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	}
	delete process.env.WTFT_CLAUDE_PROJECTS_DIR;
	delete process.env.WTFT_NO_GIT;
}

// ---
// FIXTURES
// ---

/**
 * Write a Claude-shaped transcript.
 * @param cwd the cwd stamped on every ordinary entry (what resolveLastCwd sees)
 * @param relocations relocatedCwd values, in the order Claude Code wrote them
 *   (so the LAST element is the most recent move)
 */
function writeTranscript(file: string, cwd: string, relocations: string[] = []): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lines: string[] = [];
	lines.push(JSON.stringify({ type: "user", cwd, message: { role: "user", content: "hi" } }));
	for (const relocatedCwd of relocations) {
		lines.push(JSON.stringify({
			type: "relocated",
			sessionId: path.basename(file, ".jsonl"),
			relocatedCwd,
		}));
	}
	lines.push(JSON.stringify({
		type: "assistant",
		cwd,
		message: {
			role: "assistant", id: "msg_" + path.basename(file, ".jsonl"),
			model: "claude-sonnet-4-5",
			usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: [{ type: "text", text: "ok" }],
		},
	}));
	fs.writeFileSync(file, lines.join("\n") + "\n");
}

/** Names of the sessions discovery returns for a target directory. */
function namesFrom(target: string): string[] {
	resetCwdCache();
	return discoverSessions("claude-code", target).map((c: any) => c.name);
}

// ---
// PART A — #144: the slug encoding is a union (V1–V4)
// ---

console.log("\n=== PART A: slug encoding union (#144) ===\n");
{
	// V1 — a dot in the cwd munges to a dash.
	check(cwdToStrictSlug("/tmp/x.y/z") === "-tmp-x-y-z", "strict encoding munges the dot: /tmp/x.y/z → -tmp-x-y-z");
	check(cwdToSlug("/tmp/x.y/z") === "-tmp-x.y-z", "legacy encoding keeps the dot (unchanged)");
	check(slugMatchesCwd("-tmp-x-y-z", "/tmp/x.y/z"), "V1: dot-munged dir matches a dotted cwd");

	const projects = mktmp("wtft-144-");
	process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
	resetHarnessRegistry();

	const dotted = "/tmp/x.y/z";
	writeTranscript(path.join(projects, cwdToStrictSlug(dotted), "dotted.jsonl"), dotted);
	check(namesFrom(dotted).includes("dotted.jsonl"), "V1: session filed under the dot-munged slug is discovered");

	// V2 — the real .claude/worktrees shape, the case that motivated the issue.
	const inTree = "/home/t/g/demo/.claude/worktrees/99-branch";
	check(
		cwdToStrictSlug(inTree) === "-home-t-g-demo--claude-worktrees-99-branch",
		"V2: .claude/worktrees encodes to the double-dash form seen on disk"
	);
	writeTranscript(path.join(projects, cwdToStrictSlug(inTree), "intree.jsonl"), inTree);
	check(namesFrom(inTree).includes("intree.jsonl"), "V2: a .claude/worktrees session is discovered from its own cwd");

	// V3 — both hypotheses about `_` hold at once.
	const underscore = "/tmp/wtft144/my_repo";
	check(cwdSlugVariants(underscore).length === 2, "V3: an underscore path has two candidate encodings");
	const strictDir = path.join(projects, cwdToStrictSlug(underscore));
	const legacyDir = path.join(projects, cwdToSlug(underscore));
	writeTranscript(path.join(strictDir, "under-strict.jsonl"), underscore);
	writeTranscript(path.join(legacyDir, "under-legacy.jsonl"), underscore);
	const underNames = namesFrom(underscore);
	check(underNames.includes("under-strict.jsonl"), "V3: found under the strict encoding");
	check(underNames.includes("under-legacy.jsonl"), "V3: …and under the legacy encoding — union, not a pin");

	// V4 — the union widens the encoding, never the path.
	check(!slugMatchesCwd("-tmp-x-y-z-w", "/tmp/x.y/z"), "V4: a longer slug is not a match");
	writeTranscript(path.join(projects, "-tmp-x-y-z-w", "sibling.jsonl"), "/tmp/x.y/z/w");
	check(!namesFrom(dotted).includes("sibling.jsonl"), "V4: a sibling directory's session does not leak in");

	delete process.env.WTFT_CLAUDE_PROJECTS_DIR;
}

// ---
// PART B — #164: a session stranded in a REMOVED directory (V5–V10)
// ---

console.log("\n=== PART B: stranded in a removed worktree (#164) ===\n");
{
	const projects = mktmp("wtft-164-");
	const clone = mktmp("wtft-164-clone-");          // exists
	const removed = path.join(clone, "..", "gone-worktree"); // never created
	const removedAbs = path.resolve(removed);

	process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
	resetHarnessRegistry();

	check(!fs.existsSync(removedAbs), "fixture precondition: the worktree directory does not exist");

	// The #158 shape: filed under the removed worktree's slug, last cwd is the
	// removed worktree, and the history also contains the main clone.
	// Relocations are written oldest → newest, so the LAST one is the worktree:
	// a last-wins rule would still point at the deleted directory (V6).
	const stranded = path.join(projects, cwdToStrictSlug(removedAbs), "stranded.jsonl");
	writeTranscript(stranded, removedAbs, [clone, removedAbs, clone, removedAbs]);

	// A session that never left the clone, for the no-regression arm.
	const homebody = path.join(projects, cwdToStrictSlug(clone), "homebody.jsonl");
	writeTranscript(homebody, clone);

	// A Pi-shaped transcript: no cwd, no relocated.
	const piShaped = path.join(projects, cwdToStrictSlug(clone), "pi-shaped.jsonl");
	fs.mkdirSync(path.dirname(piShaped), { recursive: true });
	fs.writeFileSync(piShaped, JSON.stringify({ type: "message", message: { role: "assistant", id: "m1", usage: {} } }) + "\n");

	const fromClone = namesFrom(clone);
	check(fromClone.includes("stranded.jsonl"), "V5: a session stranded in a removed worktree is found from the main clone");
	check(fromClone.includes("homebody.jsonl"), "V7: a session that never left the main clone is still found");

	// V6 — the set, not the latest entry.
	resetCwdCache();
	check(resolveLastCwd(stranded) === removedAbs, "V6: resolveLastCwd still reports the (removed) worktree — unchanged");
	const history = resolveCwdHistory(stranded);
	check(history.includes(clone) && history.includes(removedAbs), "V6: the history holds BOTH directories");
	check(history[0] === removedAbs, "V6: history is most-recent-first, so last-wins would answer 'removed'");

	// V8 — Pi shape contributes nothing either way.
	resetCwdCache();
	check(resolveLastCwd(piShaped) === null, "V8: a transcript with no cwd resolves to null");
	check(resolveCwdHistory(piShaped).length === 0, "V8: …and has an empty history");
	const elsewhere = mktmp("wtft-164-elsewhere-");
	check(!namesFrom(elsewhere).includes("pi-shaped.jsonl"), "V8: a Pi-shaped transcript is not pulled into an unrelated cwd");

	// V9 — the gate: a live last-cwd must never trigger the whole-file scan.
	resetCwdCache();
	discoverSessions("claude-code", clone);
	const historyReads = getCwdHistoryReadCount();
	check(getCwdReadCount() > 0, "V9: the cheap tail scan did run");
	// homebody's cwd exists, so only the stranded transcript may be scanned.
	check(historyReads <= 1, `V9: whole-file scans stay gated on a dead cwd (${historyReads} scan(s))`);

	// V10 — display prefers a directory that still exists.
	resetCwdCache();
	const strandedCandidate = discoverSessions("claude-code", clone).find((c: any) => c.name === "stranded.jsonl");
	const shownForRemoved = buildDisplayPath("stranded.jsonl", cwdToStrictSlug(removedAbs), "claude-code");
	check(!!strandedCandidate, "V10: the stranded candidate is present");
	check(
		strandedCandidate?.displayPath === buildDisplayPath("stranded.jsonl", cwdToSlug(clone), "claude-code"),
		"V10: it renders under the still-existing clone…"
	);
	check(strandedCandidate?.displayPath !== shownForRemoved, "V10: …not under the removed worktree");

	delete process.env.WTFT_CLAUDE_PROJECTS_DIR;
}

// ---
// PART C — #145: live sibling worktrees (V12–V17)
// ---

console.log("\n=== PART C: live sibling worktrees (#145) ===\n");

/** Create a real git repo with one commit. Returns its path, or null if git is unusable. */
function makeRepo(dir: string): string | null {
	try {
		fs.mkdirSync(dir, { recursive: true });
		const run = (args: string[]) =>
			execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 });
		run(["init", "-q", "-b", "main"]);
		run(["config", "user.email", "t@example.com"]);
		run(["config", "user.name", "t"]);
		fs.writeFileSync(path.join(dir, "README"), "x\n");
		run(["add", "-A"]);
		run(["commit", "-qm", "init"]);
		return dir;
	} catch {
		return null;
	}
}

{
	const sandbox = mktmp("wtft-145-");
	const projects = path.join(sandbox, "projects");
	fs.mkdirSync(projects, { recursive: true });
	process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
	resetHarnessRegistry();

	const clone = makeRepo(path.join(sandbox, "demo"));
	if (!clone) {
		console.log("  (skipped — git is not usable in this environment)");
	} else {
		const wt = path.join(sandbox, "worktrees", "demo", "99-branch");
		let worktreeOk = true;
		try {
			execFileSync("git", ["-C", clone, "worktree", "add", "-q", "-b", "99-branch", wt], {
				stdio: ["ignore", "ignore", "ignore"], timeout: 10_000,
			});
		} catch {
			worktreeOk = false;
		}

		check(findRepoRoot(clone) === clone, "findRepoRoot resolves the main clone");
		if (worktreeOk) {
			check(findRepoRoot(wt) === wt, "findRepoRoot resolves a worktree (its .git is a FILE)");

			const fan = fanOutCwd(clone);
			check(fan.inRepo && !fan.usedFallback, "fan-out used git, not the fallback");
			check(fan.dirs.includes(clone) && fan.dirs.includes(wt), "fan-out lists both checkouts");

			writeTranscript(path.join(projects, cwdToStrictSlug(clone), "in-clone.jsonl"), clone);
			writeTranscript(path.join(projects, cwdToStrictSlug(wt), "in-worktree.jsonl"), wt);

			check(namesFrom(clone).includes("in-worktree.jsonl"), "V12: worktree session is found FROM the main clone");
			check(namesFrom(wt).includes("in-clone.jsonl"), "V13: clone session is found FROM the worktree");
			check(namesFrom(clone).includes("in-clone.jsonl"), "V12/V13: neither direction drops the local session");

			// V17 — --dir <worktree> fans out over that worktree's repo.
			resetCwdCache();
			const viaDir = discoverSessions("claude-code", wt).map((c: any) => c.name);
			check(viaDir.includes("in-clone.jsonl") && viaDir.includes("in-worktree.jsonl"),
				"V17: --dir <worktree> fans out over that worktree's repo");
		} else {
			console.log("  (worktree arm skipped — `git worktree add` failed)");
		}

		// V14 — a repo with no worktrees behaves exactly as today.
		const lone = makeRepo(path.join(sandbox, "lone"));
		if (lone) {
			writeTranscript(path.join(projects, cwdToStrictSlug(lone), "lone.jsonl"), lone);
			const loneNames = namesFrom(lone);
			check(loneNames.includes("lone.jsonl"), "V14: a repo with no worktrees finds its own sessions");
			check(!loneNames.includes("in-clone.jsonl"), "V14: …and nothing from an unrelated repo");
		}

		// V15 — a non-repo cwd does not fan out.
		const plain = path.join(sandbox, "not-a-repo");
		const plainSibling = path.join(sandbox, "not-a-repo-sibling");
		fs.mkdirSync(plain, { recursive: true });
		fs.mkdirSync(plainSibling, { recursive: true });
		writeTranscript(path.join(projects, cwdToStrictSlug(plain), "plain.jsonl"), plain);
		writeTranscript(path.join(projects, cwdToStrictSlug(plainSibling), "plain-sibling.jsonl"), plainSibling);
		const plainFan = fanOutCwd(plain);
		check(!plainFan.inRepo && plainFan.dirs.length === 1, "V15: a non-repo cwd fans out to itself alone");
		const plainNames = namesFrom(plain);
		check(plainNames.includes("plain.jsonl"), "V15: it still finds its own sessions");
		check(!plainNames.includes("plain-sibling.jsonl"), "V15: …and does not pull in a sibling directory");

		// V16 — the no-git fallback.
		process.env.WTFT_NO_GIT = "1";
		const inTreeWt = path.join(clone, ".claude", "worktrees", "77-fallback");
		writeTranscript(path.join(projects, cwdToStrictSlug(inTreeWt), "fallback-wt.jsonl"), inTreeWt);
		const fallbackFan = fanOutCwd(clone);
		check(fallbackFan.inRepo && fallbackFan.usedFallback, "V16: WTFT_NO_GIT forces the prefix fallback");
		check(namesFrom(clone).includes("fallback-wt.jsonl"), "V16: prefix matching still finds an in-tree worktree session");
		const plainFallback = fanOutCwd(plain);
		check(!plainFallback.inRepo && !plainFallback.usedFallback, "V16: …and a non-repo cwd still does not fan out");
		delete process.env.WTFT_NO_GIT;
	}

	delete process.env.WTFT_CLAUDE_PROJECTS_DIR;
}

// ---
// PART D — #145 display: worktree rows read as <repo>/w/<branch> (V18–V20)
// ---

console.log("\n=== PART D: worktree display compaction (#145) ===\n");
{
	const user = path.basename(os.homedir());
	const outOfTree = `-home-${user}-git-projects-worktrees-demo-99-branch`;
	const inTree = `-home-${user}-git-projects-demo--claude-worktrees-99-branch`;
	const plainRepo = `-home-${user}-git-projects-demo`;
	const noDigits = `-home-${user}-git-projects-worktrees-demo-scratch`;

	check(
		buildDisplayPath("x5e9e.jsonl", outOfTree, "claude-code") === "~/g-p/demo/w/99-branch/...5e9e",
		"V18: out-of-tree worktree renders as ~/g-p/demo/w/99-branch"
	);
	check(
		buildDisplayPath("x5e9e.jsonl", inTree, "claude-code") === "~/g-p/demo/w/99-branch/...5e9e",
		"V19: in-tree .claude/worktrees renders identically"
	);
	check(
		buildDisplayPath("x5e9e.jsonl", plainRepo, "claude-code") === "~/g-p/demo/...5e9e",
		"V20: a plain repo slug is unchanged"
	);
	check(
		buildDisplayPath("x5e9e.jsonl", noDigits, "claude-code") === "~/g-p/worktrees-demo-scratch/...5e9e",
		"V20: no digit segment → left exactly as today, no guessing"
	);
}

// ---
// PART E — #164 cost: the gate holds against the real history (V11)
// ---

console.log("\n=== PART E: cost against the real session history (V11) ===\n");
{
	resetCwdCache();
	resetHarnessRegistry();
	const realProjects = path.join(os.homedir(), ".claude", "projects");
	if (!fs.existsSync(realProjects)) {
		console.log("  (skipped — no ~/.claude/projects on this machine)");
	} else {
		const here = process.cwd();
		const t0 = Date.now();
		const found = discoverSessions("claude-code", here);
		const cold = Date.now() - t0;
		check(cold < 500, `V11: cold discovery over the real history stays under the #156 ceiling (${cold}ms < 500ms)`);
		check(found.length >= 0, "V11: discovery returns without throwing on the real tree");

		const t1 = Date.now();
		discoverSessions("claude-code", here);
		const warm = Date.now() - t1;
		check(warm <= cold + 50, `V11: the memoised second pass does not re-read (${warm}ms ≤ ${cold + 50}ms)`);
	}
}

cleanup();
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

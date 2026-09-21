#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/wtft-issue-144-145-164-session-discovery.test.ts
 *   — three ways a Claude session goes missing from wtft (#144, #145, #164)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { skip } from "./lib/skips.ts";
import { trackSandbox } from "./lib/sandbox";

import {
	discoverSessions,
	resolveLastCwd,
	resetCwdCache,
	getCwdReadCount,
	getCwdBytesRead,
	getDirWalkCount,
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
	const dir = fs.realpathSync(trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), prefix))));
	tmpRoots.push(dir);
	return dir;
}
function cleanup() {
	for (const dir of tmpRoots) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	}
	delete process.env.WTFT_CLAUDE_PROJECTS_DIR;
	delete process.env.WTFT_PI_SESSIONS_DIR;
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
// PART B — #164 → #89: a session stranded in a REMOVED directory (V5–V10)
// ---
//
// Claude Code files a transcript under the directory its session STARTED in.
// Without the whole-file relocation arm, sessions filed under a removed
// worktree's own slug are not found; sessions filed under the clone's slug
// still are. Both shapes are asserted below.

console.log("\n=== PART B: stranded in a removed worktree (#164 → #89) ===\n");
{
	const projects = mktmp("wtft-164-");
	const clone = mktmp("wtft-164-clone-");          // exists
	const removed = path.join(clone, "..", "gone-worktree"); // never created
	const removedAbs = path.resolve(removed);

	process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
	resetHarnessRegistry();

	check(!fs.existsSync(removedAbs), "fixture precondition: the worktree directory does not exist");

	// THE SHAPE THAT ACTUALLY OCCURS: filed under the main clone's slug (where
	// the session began), last cwd the removed worktree. The physical arm alone
	// finds it, and always did — this is why the expensive arm measured 0.
	const strandedFromClone = path.join(projects, cwdToStrictSlug(clone), "stranded-from-clone.jsonl");
	writeTranscript(strandedFromClone, removedAbs, [clone, removedAbs]);

	// THE SHAPE THAT IS NOW LOST: filed under the REMOVED worktree's slug, with
	// the clone reachable only through its relocation history. 0 of these exist
	// on the development corpus; asserted as lost so the trade is on the record
	// rather than discovered later by someone missing a session.
	const strandedFromWorktree = path.join(projects, cwdToStrictSlug(removedAbs), "stranded-from-worktree.jsonl");
	writeTranscript(strandedFromWorktree, removedAbs, [clone, removedAbs, clone, removedAbs]);

	// A session that never left the clone, for the no-regression arm. Padded
	// well past the 8 KB first window so a whole-file read of the fixtures
	// would blow the byte budget below.
	const homebody = path.join(projects, cwdToStrictSlug(clone), "homebody.jsonl");
	writeTranscript(homebody, clone);
	fs.appendFileSync(homebody, `${"x".repeat(300 * 1024)}\n`);

	// A Pi-shaped transcript: no cwd, no relocated.
	const piShaped = path.join(projects, cwdToStrictSlug(clone), "pi-shaped.jsonl");
	fs.mkdirSync(path.dirname(piShaped), { recursive: true });
	fs.writeFileSync(piShaped, JSON.stringify({ type: "message", message: { role: "assistant", id: "m1", usage: {} } }) + "\n");

	const fromClone = namesFrom(clone);
	check(fromClone.includes("stranded-from-clone.jsonl"),
		"V5: a session that STARTED in the clone and died in a removed worktree is still found");
	check(fromClone.includes("homebody.jsonl"), "V7: a session that never left the main clone is still found");

	// V6 — the case #89 gave up, stated as a fact about the build rather than
	// left to be inferred from the absence of a check.
	check(!fromClone.includes("stranded-from-worktree.jsonl"),
		"V6: a session filed under the REMOVED worktree's own slug is NOT found — the #89 trade, 0 on the real corpus");
	resetCwdCache();
	check(resolveLastCwd(strandedFromWorktree) === removedAbs,
		"V6: its last cwd still reads as the removed worktree — the transcript did not change, only what we pay to read it");

	// V8 — Pi shape contributes nothing either way.
	resetCwdCache();
	check(resolveLastCwd(piShaped) === null, "V8: a transcript with no cwd resolves to null");
	const elsewhere = mktmp("wtft-164-elsewhere-");
	check(!namesFrom(elsewhere).includes("pi-shaped.jsonl"), "V8: a Pi-shaped transcript is not pulled into an unrelated cwd");

	// V9 — a dead cwd costs no more than a live one. This is the whole point of
	// Bound against an absolute budget, not `tail * 512 KB` — that product
	// holds for every input by construction (`readSlice` never exceeds 512 KB).
	resetCwdCache();
	discoverSessions("claude-code", clone);
	const tail = getCwdReadCount();
	const bytes = getCwdBytesRead();
	const fixtureBytes = [strandedFromClone, strandedFromWorktree, homebody, piShaped]
		.reduce((sum, f) => sum + fs.statSync(f).size, 0);
	// Four transcripts, one of them 300 KB. A whole-file pass costs `fixtureBytes`;
	// tails cost a few KB each. The budget sits between them, so it is a bound a
	// regression can actually cross.
	const tailBudget = 4 * 16 * 1024;
	check(tail > 0, "V9: the tail scan did run");
	check(fixtureBytes > tailBudget * 4,
		`V9: the fixtures are big enough for the budget to mean something (${Math.round(fixtureBytes / 1024)} KB vs a ${tailBudget / 1024} KB budget)`);
	check(bytes <= tailBudget,
		`V9: a dead cwd buys no second pass (${Math.round(bytes / 1024)} KB of ${Math.round(fixtureBytes / 1024)} KB on disk)`);

	// V10 — display renders under the physical slug, which is a directory the
	// session really started in. It is no longer rewritten to the most recent
	// still-existing directory: that lookup was the deleted whole-file read.
	resetCwdCache();
	const strandedCandidate = discoverSessions("claude-code", clone)
		.find((c: any) => c.name === "stranded-from-clone.jsonl");
	check(!!strandedCandidate, "V10: the stranded candidate is present");
	check(
		strandedCandidate?.displayPath === buildDisplayPath("stranded-from-clone.jsonl", cwdToStrictSlug(clone), "claude-code"),
		"V10: it renders under the slug it is filed under — a real directory, at no cost"
	);

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
		skip("git is not usable in this environment — the git-repo discovery arm did not run");
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
			skip("`git worktree add` failed — the worktree discovery arm did not run");
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
// PART E — what one launch READS, counted on a corpus the TEST owns (V11, V22).
// (#164's `pathExists` gate is deleted; these assertions now bound bytes, not
// scans, and V22 guards the read path itself.)
// ---

console.log("\n=== PART E: what one launch reads, counted on a test-built corpus (V11, V22) ===\n");
{
	resetCwdCache();
	resetHarnessRegistry();

	// Own the corpus; assert on bytes and read counts, not the clock.
	// Transcripts are far larger than the 8 KB tail window (60 x 256 KB whole
	// is 15.7 MB; 60 tails is under 500 KB). The `cwd` sits on the LAST line
	// of every fixture, so one window resolves it.
	//
	// live     = recorded cwd EXISTS -> one tail read
	// stranded = recorded cwd gone   -> one tail read, the same one (#89)
	const SESSIONS = 60;
	/** Padding per transcript — many multiples of the largest tail window. */
	const FILLER_BYTES = 256 * 1024;
	const liveHome = mktmp("wtft-39-livecwd-");
	const filler = JSON.stringify({
		type: "assistant",
		message: {
			role: "assistant", id: "filler", model: "claude-sonnet-4-20250514",
			usage: { input_tokens: 10, output_tokens: 10 },
			content: [{ type: "text", text: "y".repeat(400) }],
		},
	}) + "\n";

	/** A transcript big enough that reading it whole is unmistakable in bytes. */
	const bigFiller = filler.repeat(Math.ceil(FILLER_BYTES / filler.length));

	const buildCorpus = (prefix: string, cwdFor: (i: number) => string, count: number = SESSIONS): string => {
		const root = mktmp(prefix);
		const proj = path.join(root, "-home-synthetic-project");
		fs.mkdirSync(proj, { recursive: true });
		for (let i = 0; i < count; i++) {
			const id = `39c0de00-1a9b-4c3d-9e8f-${String(i).padStart(12, "0")}`;
			fs.writeFileSync(path.join(proj, `${id}.jsonl`),
				bigFiller + JSON.stringify({ type: "user", cwd: cwdFor(i), message: { role: "user", content: "hi" } }) + "\n");
		}
		return root;
	};

	/** The ceiling every arm below is held to: one 8 KB tail per transcript,
	 *  with slack for the JSON line that straddles the window boundary. */
	const TAIL_BUDGET = SESSIONS * 16 * 1024;

	const liveCorpus = buildCorpus("wtft-39-live-", () => liveHome);
	const strandedCorpus = buildCorpus("wtft-39-stranded-", (i) => path.join(liveHome, `gone-worktree-${i}`));

	// Pin both harness roots so the suite does not depend on host session dirs.
	// Only the Claude discovery runs below (`discoverSessions("claude-code", …)`).
	process.env.WTFT_PI_SESSIONS_DIR = mktmp("wtft-39-nopi-");

	// V11a — every recorded cwd exists: one bounded tail per transcript, and
	// nothing like the 15.7 MB a whole-file pass would cost.
	process.env.WTFT_CLAUDE_PROJECTS_DIR = liveCorpus;
	resetCwdCache();
	discoverSessions("claude-code", liveHome);
	const liveTail = getCwdReadCount();
	const liveBytes = getCwdBytesRead();
	check(liveTail >= SESSIONS, `V11a: the tail scan ran for every transcript (${liveTail} >= ${SESSIONS})`);
	check(liveBytes <= TAIL_BUDGET,
		`V11a: …reading tails, not files (${Math.round(liveBytes / 1024)} KB over ${SESSIONS} x ${FILLER_BYTES / 1024} KB transcripts, budget ${TAIL_BUDGET / 1024} KB)`);

	// V11b — THE #89 ASSERTION. The same corpus with every cwd dead must cost
	// no more than the live one. A reinstated whole-file fallback shows up as
	// 60 x 256 KB against a 960 KB budget.
	process.env.WTFT_CLAUDE_PROJECTS_DIR = strandedCorpus;
	resetCwdCache();
	discoverSessions("claude-code", liveHome);
	const strandedTail = getCwdReadCount();
	const strandedBytes = getCwdBytesRead();
	check(strandedBytes <= TAIL_BUDGET,
		`V11b: a DEAD cwd costs no more than a live one (${Math.round(strandedBytes / 1024)} KB, budget ${TAIL_BUDGET / 1024} KB — it was ${SESSIONS * FILLER_BYTES / 1024} KB before #89)`);
	check(strandedTail <= liveTail,
		`V11b: …and no extra reads either (${strandedTail} vs ${liveTail} live)`);

	// V11f — #89's closer fixture (200 transcripts, 150 stranded) on the
	// unscoped path. The closer's bound itself is asserted by V11g.
	{
		const MIXED = 200;
		const STRANDED = 150;
		const mixedCorpus = buildCorpus("wtft-89-mixed-",
			i => (i < STRANDED ? path.join(liveHome, `gone-worktree-${i}`) : liveHome), MIXED);
		process.env.WTFT_CLAUDE_PROJECTS_DIR = mixedCorpus;
		resetCwdCache();
		const mixed = discoverSessions("claude-code", liveHome);
		const mixedBytes = getCwdBytesRead();

		check(mixed.length === MIXED - STRANDED,
			`V11f: the contract's mixed corpus resolves its live half (${mixed.length} of ${MIXED}, ${STRANDED} stranded)`);
		check(mixedBytes <= MIXED * 16 * 1024,
			`V11f: …reading tails, not files (${Math.round(mixedBytes / 1024)} KB over ${MIXED} x ${FILLER_BYTES / 1024} KB)`);

		// The clause itself: this unscoped path still asks every transcript
		// where it lives, so its reads scale with the corpus. #89's decision met
		// the closer by scoping instead of indexing; V11g asserts the bound on
		// the picker's default scope.
	}

	// V11c — memoisation, asserted as read counts (a broken memo shows up as
	// a non-zero delta on the second pass).
	const afterFirst = getCwdReadCount();
	const bytesAfterFirst = getCwdBytesRead();
	discoverSessions("claude-code", liveHome);
	check(getCwdReadCount() === afterFirst,
		`V11c: the memoised second pass re-reads nothing (${getCwdReadCount() - afterFirst} new tail read(s))`);
	check(getCwdBytesRead() === bytesAfterFirst,
		`V11c: …and reads no further bytes (${getCwdBytesRead() - bytesAfterFirst} B)`);

	// V11e — THE WALK, which neither counter above can see.
	// `collect()` reads one directory per call, so a flat corpus of N project
	// dirs must cost exactly N directory reads, and a nested one exactly N +
	// its subdirectories. An accidental re-walk is a wrong number.
	{
		const walkRoot = mktmp("wtft-39-walk-");
		const PROJECTS = 7;
		for (let i = 0; i < PROJECTS; i++) {
			const proj = path.join(walkRoot, `-home-walk-project-${i}`);
			fs.mkdirSync(proj, { recursive: true });
			fs.writeFileSync(path.join(proj, `39c0de00-1a9b-4c3d-9e8f-${String(900 + i).padStart(12, "0")}.jsonl`),
				filler + JSON.stringify({ type: "user", cwd: liveHome, message: { role: "user", content: "hi" } }) + "\n");
		}
		// One nested directory, and one the walk must SKIP. Without the pair, the
		// count would be satisfied by a walk that recursed into neither, and
		// SKIP_DIRS could regress to walking derived data unnoticed.
		fs.mkdirSync(path.join(walkRoot, "-home-walk-project-0", "sessions"), { recursive: true });
		fs.mkdirSync(path.join(walkRoot, "-home-walk-project-0", "wtft-tags"), { recursive: true });

		process.env.WTFT_CLAUDE_PROJECTS_DIR = walkRoot;
		process.env.WTFT_PI_SESSIONS_DIR = mktmp("wtft-39-nopi-walk-");
		resetCwdCache();
		discoverSessions("claude-code", liveHome);
		const walk = getDirWalkCount();
		check(walk === PROJECTS + 1,
			`V11e: the tree walk reads each directory exactly once, and skips derived data (${walk} read(s), expected ${PROJECTS + 1})`);

		// …and a second discovery walks it all again, because the walk is NOT
		// memoised. Asserted rather than assumed: it is the reason the walk needs
		// its own counter, and if it ever does become memoised this line is the
		// one that says so instead of a comment quietly going stale.
		discoverSessions("claude-code", liveHome);
		check(getDirWalkCount() === walk * 2,
			`V11e: …and is re-walked in full on every call, memo or not (${getDirWalkCount()} after two, expected ${walk * 2})`);

		delete process.env.WTFT_PI_SESSIONS_DIR;
	}

	delete process.env.WTFT_CLAUDE_PROJECTS_DIR;
	delete process.env.WTFT_PI_SESSIONS_DIR;

	// V11g — #89's closer on the path the picker opens on (scope "worktree",
	// folder-name match only). 50 live transcripts sit under the target's own
	// slug and 150 under slugs for removed worktrees; the default scope must
	// find the 50 without a single tail read.
	{
		const root = mktmp("wtft-89-scoped-");
		const target = mktmp("wtft-89-scoped-cwd-");
		const writeUnder = (cwd: string, i: number) => {
			const dir = path.join(root, cwdToStrictSlug(cwd));
			fs.mkdirSync(dir, { recursive: true });
			const id = `89c0de00-1a9b-4c3d-9e8f-${String(i).padStart(12, "0")}`;
			fs.writeFileSync(path.join(dir, `${id}.jsonl`),
				JSON.stringify({ type: "user", cwd, message: { role: "user", content: "hi" } }) + "\n");
		};
		for (let i = 0; i < 200; i++) writeUnder(i < 150 ? path.join(target, `gone-worktree-${i}`) : target, i);
		process.env.WTFT_CLAUDE_PROJECTS_DIR = root;
		process.env.WTFT_PI_SESSIONS_DIR = mktmp("wtft-89-scoped-nopi-");
		resetCwdCache();
		const scoped = discoverSessions("claude-code", target, { scope: "worktree", windowMs: null });
		const scopedTail = getCwdReadCount();
		check(scoped.length === 50,
			`V11g: the picker's default scope finds the live sessions (${scoped.length} of 50)`);
		check(scopedTail === 0,
			`V11g: …without a single tail read (${scopedTail} for ${scoped.length}; corpus 200)`);
		delete process.env.WTFT_CLAUDE_PROJECTS_DIR;
		delete process.env.WTFT_PI_SESSIONS_DIR;
	}

	// V23 — WIDENING READS EACH BYTE ONCE.
	// A transcript far larger than the last window with no `cwd` anywhere, so
	// every window is tried and none resolves. Re-reading each window from
	// scratch costs 8 + 64 + 512 = 584 KB; reading only the newly exposed
	// prefix costs exactly 512 KB.
	{
		const nocwdRoot = mktmp("wtft-89-nocwd-");
		const proj = path.join(nocwdRoot, "-home-nocwd-project");
		fs.mkdirSync(proj, { recursive: true });
		const line = JSON.stringify({ type: "assistant", message: { role: "assistant", id: "x", usage: {} } }) + "\n";
		const big = path.join(proj, "8900cafe-1a9b-4c3d-9e8f-000000000023.jsonl");
		fs.writeFileSync(big, line.repeat(Math.ceil((1024 * 1024) / line.length)));

		resetCwdCache();
		const resolved = resolveLastCwd(big);
		const widenReads = getCwdReadCount();
		const widenBytes = getCwdBytesRead();
		const LAST_WINDOW = 512 * 1024;

		check(resolved === null, "V23: a transcript with no cwd anywhere resolves to null");
		check(widenReads === 3, `V23: …after trying every window (${widenReads} reads)`);
		check(
			widenBytes === LAST_WINDOW,
			`V23: …reading exactly the last window, each byte once (${widenBytes} B; re-reading each window costs ${8 * 1024 + 64 * 1024 + LAST_WINDOW} B)`
		);
	}

	// V22 — THE GUARD THE COUNTER CANNOT BE.
	// `getCwdBytesRead` only sees reads routed through session-cwd.ts's one
	// private `readSlice`. A whole-file `fs.readFileSync` would move neither
	// counter. Assert against the source: that module has exactly one read
	// call, and it is the bounded one.
	{
		const src = fs.readFileSync(
			path.join(import.meta.dirname, "..", "extensions", "lib", "harness", "session-cwd.ts"),
			"utf8",
		);
		// Comments discuss the deleted `fs.readFileSync` by name, so strip them
		// first — the claim is about CODE, and a doc mention must not fail it.
		const code = src
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^[ \t]*\/\/.*$/gm, "");
		const reads = [...code.matchAll(/fs\.(read[A-Za-z]*Sync|createReadStream)\s*\(/g)].map(m => m[0]);
		check(
			reads.length === 1 && reads[0].startsWith("fs.readSync"),
			`V22: session-cwd.ts has exactly one read call and it is the bounded one (${reads.join(", ") || "none"})`
		);
	}

	// V11d — the real tree still gets a smoke check, minus the cost claim it
	// could never support: discovery must not throw on whatever this host holds.
	resetCwdCache();
	const realProjects = path.join(os.homedir(), ".claude", "projects");
	if (!fs.existsSync(realProjects)) {
		skip("no ~/.claude/projects on this machine — the real-transcript arm did not run");
	} else {
		const found = discoverSessions("claude-code", process.cwd());
		check(Array.isArray(found), "V11d: discovery returns without throwing on the real tree");
	}
}

cleanup();
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

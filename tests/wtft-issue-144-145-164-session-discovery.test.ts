#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/wtft-issue-144-145-164-session-discovery.test.ts
 *   — three ways a Claude session goes missing from wtft (#144, #145, #164)
 *
 * Spec: docs/spec-144-145-164-session-discovery.md (V1–V21).
 *
 *   A  V1–V4    #144  slug encoding is a UNION of encodings, not a pinned class
 *   B  V5–V10   #164→#89  a session stranded in a REMOVED directory, and
 *                     exactly which stranded shapes are reachable now that the
 *                     whole-file relocation arm is gone
 *   C  V12–V17  #145  live sibling worktrees fan out, non-repos do not
 *   D  V18–V20  #145  worktree rows render as <repo>/w/<branch>
 *   E  V11      #89   cost: discovery reads TAILS, never whole files
 *
 * V21 is the whole-suite invariant and is not asserted here — it is what
 * `bun run test` reports across every suite.
 *
 * Everything runs through interfaces exported from bin/wtft.mjs —
 * `discoverSessions`, `resolveLastCwd`, `buildDisplayPath`, `fanOutCwd`,
 * `findRepoRoot`, the slug helpers and the read counters — against fixture trees
 * pointed at by WTFT_CLAUDE_PROJECTS_DIR. No module internals are touched.
 *
 * On clocks: NOTHING IN THIS SUITE READS ONE. Not the wall-clock date (the
 * #96 flaky pricing trap), and as of #39 not elapsed time either — Part E's
 * `Date.now()` calls are gone with the bound they served.
 *
 * That took three attempts, and the history is the argument for the shape
 * that survived. V11 began as `cold < 500`: a fixed ceiling over the live,
 * ever-growing `~/.claude/projects` (this host runs 5+ concurrent sessions,
 * including the one running this suite), so its input grew every session
 * while its budget never moved — not flaky in the random sense, but drifting
 * toward always-failing, and failing BECAUSE it ran. #477 replaced it with a
 * ratio against the memoised second pass, which rots the mirror-image way:
 * the memo makes `warm` cheaper as it IMPROVES, so the divisor shrinks while
 * cold still walks the whole tree. Measured on an unmodified `main`:
 * 6 failures in 6, cold ~2.1s against warm ~37ms — 53-61x against a 40x
 * bound. A CONSTANT MULTIPLE OF A MEMOISED CALL CANNOT BOUND AN UNMEMOISED
 * ONE, and no choice of multiple repairs that.
 *
 * So Part E now owns its corpus and counts, rather than borrowing the host's
 * and timing. Every claim is an exact integer from the counters this suite
 * already exported for V9: tail reads, whole-file relocation scans, and (new
 * for #39) directory reads by the tree walk. The full rationale, the mutation
 * record for each assertion, and the measurement showing why a ratio could
 * never have guarded the walk are in Part E's own comment block.
 *
 * #89 removed the arm those counters were built to watch. `resolveCwdHistory`
 * and `getCwdHistoryReadCount` are gone, and so is the `pathExists` gate that
 * decided when to pay for them — over 7,537 real transcripts the arm returned 0
 * extra candidates for 6,637 whole-file reads per launch. Part B now records
 * which stranded shapes survive that deletion and which one does not, and Part E
 * counts BYTES instead of scans: a scan counter pinned at 0 guards nothing,
 * while bytes is the quantity that goes wrong the moment a whole-file read comes
 * back.
 *
 * tests/wtft-issue-156-harness-seam.test.ts (Part C) carried the same fixed
 * `elapsed < 500` ceiling over the same real tree, on a call already warm by
 * the time it was timed. Tracked as #18 and fixed there the same way, on its
 * own branch.
 *
 * Run: node --experimental-strip-types tests/wtft-issue-144-145-164-session-discovery.test.ts
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
// #164 answered "my worktree is gone, where did this session live before?" by
// re-reading the whole transcript for `relocated` records. #89 deleted that arm,
// so this part changed from "every stranded session is findable" to "these are,
// that one is not" — and the difference is asserted, not narrated, because a
// deletion that silently drops a case is the failure mode worth a test.
//
// What the real corpus says (7,537 transcripts, 2026-09-15): Claude Code files a
// transcript under the directory its session STARTED in, and a session starts in
// the main clone before it enters a worktree. So for all 21 relocated
// transcripts whose last cwd was dead, every LIVE directory in their history
// already fanned out to the transcript's own physical slug. Load-bearing
// `(session, dir)` pairs that only the deleted arm could surface: 0.

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

	// A session that never left the clone, for the no-regression arm.
	const homebody = path.join(projects, cwdToStrictSlug(clone), "homebody.jsonl");
	writeTranscript(homebody, clone);

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
	// #89: before it, a dead cwd opened a whole-file read, and `pr-cleanup`
	// manufactures dead cwds on every merge.
	resetCwdCache();
	discoverSessions("claude-code", clone);
	const tail = getCwdReadCount();
	const bytes = getCwdBytesRead();
	check(tail > 0, "V9: the tail scan did run");
	check(bytes <= tail * 512 * 1024,
		`V9: every byte read came through a bounded tail window (${bytes} B over ${tail} read(s))`);

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
// PART E — #164 cost: the gate holds, counted on a corpus the TEST owns (V11)
// ---

console.log("\n=== PART E: the #164 gate, counted on a test-built corpus (V11) ===\n");
{
	resetCwdCache();
	resetHarnessRegistry();

	// WHY THIS NO LONGER TIMES THE LIVE ~/.claude/projects TREE (#39, 2026-08-30).
	//
	// V11 used to bound cold discovery by a constant multiple (40x) of the
	// memoised pass. It failed 6 runs in 6 on a clean `main`, and the cause is
	// structural rather than a badly chosen constant: cold scales with the live
	// corpus while warm is pure cache hits, so cold/warm grows without bound as
	// the corpus does. `pr-cleanup` strands every session that lived in a deleted
	// worktree, permanently, so the corpus grows with every merge — measured
	// 2,622 of 3,073 transcripts stranded (85%). Cold moved from the 400-650ms
	// #477 wrote this against to ~2,100ms, warm stayed ~37ms: ~57x against a 40x
	// bound. A CONSTANT MULTIPLE OF A MEMOISED CALL CANNOT BOUND AN UNMEMOISED
	// ONE, and no choice of multiple repairs that.
	//
	// #477 had replaced a fixed 500ms ceiling with that ratio precisely to
	// survive corpus growth. The ratio carries the mirror-image defect: the
	// better the memo, the smaller the divisor, the tighter the bound. Both
	// failed for one underlying reason — the input was not the test's to control.
	//
	// So the test now owns the corpus, and asserts on STATE rather than the
	// clock. #89 changed WHICH state: the whole-file arm those assertions
	// watched is gone, and a scan counter that can only read 0 is not a guard.
	// BYTES replaced it, because bytes is what a reinstated whole-file read
	// would move — and unlike a scan count it also catches a half-measure, such
	// as a tail window quietly widened to the file size.
	//
	// The corpus is built from transcripts far larger than the 8 KB tail window,
	// so the two are orders of magnitude apart rather than a judgement call:
	// 60 x 256 KB whole is 15.7 MB, 60 tails is under 500 KB. The `cwd` sits on
	// the LAST line of every fixture, so one window resolves it.
	//
	// live     = recorded cwd EXISTS -> one tail read
	// stranded = recorded cwd gone   -> one tail read, the same one (#89)
	//
	// A wall-clock A/B is kept at research/39-v11-corpus/measure-gate.ts: 250
	// files x 256 KB measured the deleted gate as a 4.9-5.6x time difference. It
	// is retained because it calibrates what that arm COST, which is the
	// measurement that justified removing it.
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

	const buildCorpus = (prefix: string, cwdFor: (i: number) => string): string => {
		const root = mktmp(prefix);
		const proj = path.join(root, "-home-synthetic-project");
		fs.mkdirSync(proj, { recursive: true });
		for (let i = 0; i < SESSIONS; i++) {
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

	// BOTH harness roots are pinned, though only the Claude one is read below.
	//
	// PR review called the missing Pi override a High defect that would break
	// `liveHistory === 0` on a host carrying real stale Pi sessions. It does not:
	// `discoverSessions("claude-code", …)` selects exactly ONE discovery, so Pi's
	// never runs. Measured — a Pi root poisoned with 60 non-matching-slug
	// sessions gives tail=60 history=0, and so does leaving it unset against this
	// host's real ~/.pi; the same poisoned root under `"auto"` adds exactly 60
	// tail reads, so the corpus was capable of leaking and the door is shut.
	// Pi's discovery also imports only `resolveLastCwd`, never
	// `resolveCwdHistory`, so it cannot move the history counter under ANY
	// harness argument.
	//
	// Pinned anyway, for the reason the finding did not give: which harnesses
	// `discoverSessions` routes to is an implementation detail this block does
	// not assert, and #39 exists to stop this test depending on state the HOST
	// owns rather than the test.
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

	// V11b — THE #89 ASSERTION. The same corpus with every cwd dead used to cost
	// one whole-file read each; it must now cost exactly what the live one does.
	// This is where a reinstated fallback shows up: 60 x 256 KB against a 960 KB
	// budget is not a close call.
	process.env.WTFT_CLAUDE_PROJECTS_DIR = strandedCorpus;
	resetCwdCache();
	discoverSessions("claude-code", liveHome);
	const strandedTail = getCwdReadCount();
	const strandedBytes = getCwdBytesRead();
	check(strandedBytes <= TAIL_BUDGET,
		`V11b: a DEAD cwd costs no more than a live one (${Math.round(strandedBytes / 1024)} KB, budget ${TAIL_BUDGET / 1024} KB — it was ${SESSIONS * FILLER_BYTES / 1024} KB before #89)`);
	check(strandedTail <= liveTail,
		`V11b: …and no extra reads either (${strandedTail} vs ${liveTail} live)`);

	// V11c — memoisation, asserted as state instead of `warm <= cold + 50`.
	// The old sibling check could not fail: a broken memo inflates warm, which
	// inflated the very bound it was compared against. This one counts reads, so
	// memoisation collapse — the failure mode the previous comment admitted was
	// never actually tested — now shows up directly as a non-zero delta.
	const afterFirst = getCwdReadCount();
	const bytesAfterFirst = getCwdBytesRead();
	discoverSessions("claude-code", liveHome);
	check(getCwdReadCount() === afterFirst,
		`V11c: the memoised second pass re-reads nothing (${getCwdReadCount() - afterFirst} new tail read(s))`);
	check(getCwdBytesRead() === bytesAfterFirst,
		`V11c: …and reads no further bytes (${getCwdBytesRead() - bytesAfterFirst} B)`);

	// V11e — THE WALK, which neither counter above can see (#39 review round 2).
	//
	// PR review called dropping V11's wall-clock claim a High defect: with no
	// timing left, nothing guards the unmemoised `fs.readdirSync`/`collect()`
	// tree walk, whose cost is a floor under every call regardless of the cache.
	// The gap is real — but restoring a ratio would not have closed it, and
	// measurably makes it worse. The walk happens IDENTICALLY in both arms of a
	// live-vs-stranded A/B, so it inflates numerator and denominator together:
	// on a 200-file corpus the ratio is 3.38x with no extra directories and
	// 1.21x with 3,000 empty ones added to BOTH sides. A `stranded > 2x live`
	// bound therefore fires on a harmless walk regression and goes quiet as the
	// walk gets slower — anti-correlated with what it was meant to protect.
	//
	// So the walk gets the same treatment as the reads: an integer. `collect()`
	// reads one directory per call, so a flat corpus of N project dirs must cost
	// exactly N directory reads, and a nested one exactly N + its subdirectories.
	// An accidental re-walk — the regression that actually threatens this path —
	// is then a wrong number, on any host, at any speed.
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

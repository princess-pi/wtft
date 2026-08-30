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
 *   E  V11      #164  cost: cold discovery stays within a bounded multiple
 *                     of the memoised pass, over the real history (#477)
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
 * pricing trap. Part E does read `Date.now()`, to measure elapsed time — a
 * duration is the quantity under test there, so it cannot be injected away —
 * but as of #477 it no longer measures that duration against a fixed
 * millisecond ceiling. `~/.claude/projects` is live and ever-growing (this
 * host runs 5+ concurrent sessions, including the one running this suite), so
 * a fixed ceiling's input grows every session while its budget never moves:
 * not flaky in the random sense, but drifting toward always-failing, and
 * failing *because* it ran. V11 now bounds cold discovery against its own
 * memoised second pass instead (`cold <= min(40 * warm + 250, 5000)`) — the
 * `40 * warm` term is a relative bound and scales with the input, the same
 * idiom the untouched sibling assertion three lines below (`warm <= cold +
 * 50`) already used. The `min(…, 5000)` cap is a deliberate, honest exception
 * to that scale-invariance, not a second copy of the old ceiling: a pure
 * ratio is blind to cold and warm degrading TOGETHER (e.g. the memo itself
 * breaking), since a large warm would inflate the allowed cold right along
 * with it. The cap closes that gap at the cost of reopening a MUCH slower
 * version of the drift #477 exists to fix — 5000ms leaves ~8-12x headroom
 * over today's measured cold time (400-650ms), so it only becomes the
 * binding constraint once this host's history has grown roughly an order of
 * magnitude further (or the memo has broken outright). It still tests
 * something real today, at two cost tiers: `matchesRecordedCwd`
 * (claude-code/discovery.ts) does a bounded tail read via `resolveLastCwd`
 * for every transcript across the WHOLE ~/.claude/projects tree whose slug
 * doesn't physically match, and, for whichever of those are additionally
 * stranded (last-cwd directory gone), an expensive whole-file scan via
 * `resolveCwdHistory`, gated on `pathExists` (session-cwd.ts). Both tiers are
 * cache misses on cold and cache hits on warm, so either one regressing —
 * the cheap tier running unconditionally, or the expensive tier's gate
 * failing to gate — still shows up as cold ballooning relative to warm. The
 * expensive tier is documented as rare in general (session-cwd.ts: "~3
 * transcripts in 40"), but on THIS measurement host it dominates: the #477
 * mutation probe counted 1496 whole-file scans out of 1803 tail reads
 * (~83%) — this repo's workflow creates and destroys worktrees constantly,
 * so most sessions here really are stranded. Proved by mutation during #477
 * (a forced 1.5ms stall on every cache-miss resolve — hitting both tiers —
 * pushed the observed ratio from ~10-30x to ~130-175x on this machine).
 *
 * tests/wtft-issue-156-harness-seam.test.ts (Part C) asserts the same fixed
 * `elapsed < 500` ceiling over the same real tree, on a call that is already
 * warm by the time it's timed. It was not in scope for #477 and was not
 * changed here — flagged, not fixed, since it can drift the same way.
 * Tracked as #487.
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
	const dir = fs.realpathSync(trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), prefix))));
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
	// clock. The gate's output is countable: `getCwdHistoryReadCount()` is
	// exactly the number of whole-file relocation scans performed. Counting them
	// is strictly better than timing them — no host speed, no load, no jitter,
	// no threshold to re-tune, and the assertion says what it means.
	//
	// live     = recorded cwd EXISTS -> gate closed -> NO whole-file scan
	// stranded = recorded cwd gone   -> gate open   -> one whole-file scan each
	//
	// A wall-clock A/B was built first and is kept at
	// research/39-v11-corpus/measure-gate.ts: 250 files x 256 KB measured the
	// gate as a 4.9-5.6x time difference. It is retained because it calibrates
	// what the gate is WORTH, which a counter cannot say — but it is not what
	// gates this suite, because a ratio needs a threshold and a counter does not.
	const SESSIONS = 60;
	const liveHome = mktmp("wtft-39-livecwd-");
	const filler = JSON.stringify({
		type: "assistant",
		message: {
			role: "assistant", id: "filler", model: "claude-sonnet-4-20250514",
			usage: { input_tokens: 10, output_tokens: 10 },
			content: [{ type: "text", text: "y".repeat(400) }],
		},
	}) + "\n";

	const buildCorpus = (prefix: string, cwdFor: (i: number) => string): string => {
		const root = mktmp(prefix);
		const proj = path.join(root, "-home-synthetic-project");
		fs.mkdirSync(proj, { recursive: true });
		for (let i = 0; i < SESSIONS; i++) {
			const id = `39c0de00-1a9b-4c3d-9e8f-${String(i).padStart(12, "0")}`;
			fs.writeFileSync(path.join(proj, `${id}.jsonl`),
				filler + JSON.stringify({ type: "user", cwd: cwdFor(i), message: { role: "user", content: "hi" } }) + "\n");
		}
		return root;
	};

	const liveCorpus = buildCorpus("wtft-39-live-", () => liveHome);
	const strandedCorpus = buildCorpus("wtft-39-stranded-", (i) => path.join(liveHome, `gone-worktree-${i}`));

	// V11a — every recorded cwd exists, so the gate must keep EVERY whole-file
	// scan off. V9 proves this for a 2-transcript corpus; this proves it holds at
	// a scale where a per-transcript leak would be visible.
	process.env.WTFT_CLAUDE_PROJECTS_DIR = liveCorpus;
	resetCwdCache();
	discoverSessions("claude-code", liveHome);
	const liveTail = getCwdReadCount();
	const liveHistory = getCwdHistoryReadCount();
	check(liveTail >= SESSIONS, `V11a: the cheap tail scan ran for every transcript (${liveTail} >= ${SESSIONS})`);
	check(liveHistory === 0, `V11a: a live cwd triggers NO whole-file scan (${liveHistory} scan(s) over ${SESSIONS} transcripts)`);

	// V11b — the same corpus shape with dead cwds MUST trigger the fallback.
	// Without this, V11a passes just as well on a corpus that could never have
	// triggered a scan in the first place, which would make it vacuous.
	process.env.WTFT_CLAUDE_PROJECTS_DIR = strandedCorpus;
	resetCwdCache();
	discoverSessions("claude-code", liveHome);
	const strandedHistory = getCwdHistoryReadCount();
	check(strandedHistory === SESSIONS,
		`V11b: …and a dead cwd triggers exactly one each, so V11a is not vacuous (${strandedHistory} of ${SESSIONS})`);

	// V11c — memoisation, asserted as state instead of `warm <= cold + 50`.
	// The old sibling check could not fail: a broken memo inflates warm, which
	// inflated the very bound it was compared against. This one counts reads, so
	// memoisation collapse — the failure mode the previous comment admitted was
	// never actually tested — now shows up directly as a non-zero delta.
	const afterFirst = getCwdReadCount();
	discoverSessions("claude-code", liveHome);
	check(getCwdReadCount() === afterFirst,
		`V11c: the memoised second pass re-reads nothing (${getCwdReadCount() - afterFirst} new tail read(s))`);
	check(getCwdHistoryReadCount() === strandedHistory,
		`V11c: …and re-scans nothing (${getCwdHistoryReadCount() - strandedHistory} new whole-file scan(s))`);

	delete process.env.WTFT_CLAUDE_PROJECTS_DIR;

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

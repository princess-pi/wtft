#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @research 18-partc-race
 * @description Why PART C of the harness-seam suite can make NO cost claim
 *   about the live ~/.claude/projects tree — not even a counted one (#18).
 *
 *   PART C's fixed `elapsed < 500` ceiling was replaced, in review, by what
 *   looked like a deterministic check: snapshot `getCwdReadCount()`, discover
 *   again, assert nothing was re-read. Three review lenses independently said
 *   it carried the same live-corpus race as the ceiling. This measures that.
 *
 *   THE MECHANISM. `resolveLastCwd`'s memo keys on `(path, mtimeMs, size)`, so
 *   a transcript APPENDED TO between the two `discoverSessions()` calls loses
 *   its entry and costs a genuine read. The check then fails with no
 *   regression behind it.
 *
 *   WHY IT MATTERS ON THE REAL TREE. The suite runs inside a live session
 *   whose own transcript is filed under ~/.claude/projects and is being
 *   appended to while the suite runs. So the mutation below is not a contrived
 *   worst case — it is the ordinary condition.
 *
 *   Run: bun research/18-partc-race/memo-race.ts
 *
 *   OUTCOME (2026-08-30): quiet tree 0 new reads, one append 1 new read. The
 *   counter was dropped from PART C rather than mutated a third time; the same
 *   properties are asserted exactly by V11a-e in
 *   tests/wtft-issue-144-145-164-session-discovery.test.ts, against corpora
 *   that test builds. A wall clock, a ratio and a counter all assume the tree
 *   holds still — the defect is the choice of CORPUS, not of instrument.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const REPO = path.resolve(import.meta.dir, "..", "..");
const { discoverSessions, resetCwdCache, getCwdReadCount }: any =
	await import(path.join(REPO, "bin", "wtft.mjs"));

const FILES = 20;
const roots: string[] = [];
const mktmp = (p: string): string => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
	roots.push(d);
	return d;
};

try {
	const home = mktmp("race18-home-");
	const corpus = mktmp("race18-corpus-");
	const proj = path.join(corpus, "-home-race-project");
	fs.mkdirSync(proj, { recursive: true });

	const cwdLine = (cwd: string) =>
		JSON.stringify({ type: "user", cwd, message: { role: "user", content: "hi" } }) + "\n";

	const files: string[] = [];
	for (let i = 0; i < FILES; i++) {
		const f = path.join(proj, `18c0de00-1a9b-4c3d-9e8f-${String(i).padStart(12, "0")}.jsonl`);
		// Recorded cwd EXISTS, so the #164 gate stays shut and the only reads
		// counted here are the cheap tail scans the memo is supposed to absorb.
		fs.writeFileSync(f, "x".repeat(500) + "\n" + cwdLine(home));
		files.push(f);
	}

	process.env.WTFT_CLAUDE_PROJECTS_DIR = corpus;
	process.env.WTFT_PI_SESSIONS_DIR = mktmp("race18-nopi-");

	/** Exactly PART C's shape: prime, snapshot, (mutate), discover, compare. */
	const trial = (label: string, mutate: () => void) => {
		resetCwdCache();
		discoverSessions("claude-code", home);
		const before = getCwdReadCount();
		mutate();
		discoverSessions("claude-code", home);
		const delta = getCwdReadCount() - before;
		console.log(`${label.padEnd(50)} new reads = ${delta}   check ${delta === 0 ? "PASSES" : "FAILS"}`);
	};

	console.log(`corpus: ${FILES} transcripts, all with a live recorded cwd\n`);
	trial("quiet tree (nothing changes)", () => {});
	trial("ONE transcript appended to between the calls", () => {
		fs.appendFileSync(files[7], cwdLine(home));
	});
} finally {
	for (const d of roots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

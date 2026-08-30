/**
 * @package princess-pi-tools
 * @module harness/session-cwd
 * @description Resolve where a session log *currently* lives, from the log itself (#156).
 *
 * The project-dir slug is assigned when a session starts and never revised — it
 * is a cache of where a session *began*, not where it *is*. Nothing in
 * ~/.claude/projects/ indexes across dirs, and a pointer file would only ever be
 * written if a parser happened to be running at the moment of a switch.
 *
 * The transcripts already carry the answer: walk backwards from the tail to the
 * first entry with a `cwd`. Measured over every transcript on this machine
 * (research/156-cwd-resolution-probe.mjs): 40 files, 40 resolved, 0.5 MB read of
 * 64 MB, 11 ms total — cheap enough to run on every selector invocation.
 *
 * #164 adds the one case that answer cannot cover: when a session's current
 * directory has been *deleted*, "where does it live now?" is "nowhere". The
 * transcript records every move it ever made, so the fallback question becomes
 * "where has it ever lived?" — see {@link resolveCwdHistory}.
 */

import * as fs from "node:fs";

// ---
// CONSTANTS
// ---

/**
 * Tail windows, widened only on a miss. 8 KB resolves every transcript here;
 * the larger windows exist for attachment-heavy tails, which are the only
 * reason a `cwd` would sit further back.
 */
const TAIL_WINDOWS = [8 * 1024, 64 * 1024, 512 * 1024];

// ---
// MEMOISATION
// ---

/** Keyed on (path, mtimeMs, size) — an unchanged transcript is never re-read. */
const cwdCache = new Map<string, string | null>();

/** Same key, for the whole-file relocation scan (#164). Separate table because
 *  the two answers have different costs and are invalidated for the same reason. */
const historyCache = new Map<string, string[]>();

/** Directory-existence memo. A stat per transcript per invocation, not per arm. */
const existsCache = new Map<string, boolean>();

/** Test seam: counts actual file reads so memoisation is observable. */
let readCount = 0;

/** Test seam: counts whole-file history scans, so the #164 gate is observable. */
let historyReadCount = 0;

/**
 * Test seam: counts directory reads during discovery, so the ONE cost neither
 * other counter can see is observable (#39 review).
 *
 * The tree walk is not memoised — every discovery re-reads every directory —
 * so its cost is a floor under any call, warm or cold. A wall-clock ratio
 * cannot guard it, and not merely because it is blind: the walk is identical
 * in both arms of a live-vs-stranded A/B, so it inflates numerator and
 * denominator together and drives the ratio TOWARD 1. Measured on a
 * 200-file corpus: 3.38x with no extra directories, 1.21x with 3,000 empty
 * ones added to both sides. A `stranded > 2 x live` bound would therefore go
 * RED on a harmless walk regression and GREEN as the walk got slower — it is
 * anti-correlated with the thing it was supposed to protect.
 *
 * A count has none of that. Incremented in the claude-code discovery's
 * `collect()`, once per directory actually read.
 */
let dirWalkCount = 0;

/** Number of tail reads performed since the last {@link resetCwdCache}. */
export function getCwdReadCount(): number {
	return readCount;
}

/**
 * Number of whole-file relocation scans since the last {@link resetCwdCache}.
 *
 * The point of the counter is the *gate*, and the number it counts is scans,
 * not call sites: a stranded transcript is asked for its history twice per
 * discovery (once to match, once to pick a live display path) and the
 * `(path, mtimeMs, size)` memo absorbs the second, so the counter reads 1 per
 * stranded transcript. Zero when every session's last cwd still exists. Spec
 * V9 asserts the batch form of that: one stranded + one live ⇒ at most 1.
 */
export function getCwdHistoryReadCount(): number {
	return historyReadCount;
}

/**
 * Directory reads performed by discovery's tree walk since the last
 * {@link resetCwdCache}. One per directory visited, including nested ones —
 * so a flat corpus of N project dirs reads exactly N.
 */
export function getDirWalkCount(): number {
	return dirWalkCount;
}

/** Called by a harness discovery for each directory it reads. */
export function countDirRead(): void {
	dirWalkCount++;
}

/**
 * Drop the memo tables and every discovery counter (tests; long-lived
 * processes never need this).
 */
export function resetCwdCache(): void {
	cwdCache.clear();
	historyCache.clear();
	existsCache.clear();
	readCount = 0;
	historyReadCount = 0;
	dirWalkCount = 0;
}

// ---
// EXISTENCE
// ---

/**
 * Does this directory still exist? Memoised for the life of the process.
 *
 * This is the #164 gate: it is what separates "this session lives somewhere
 * real, just not here" (cheap, stop) from "this session's home is gone"
 * (expensive, look at its whole history).
 */
export function pathExists(dir: string): boolean {
	const cached = existsCache.get(dir);
	if (cached !== undefined) return cached;
	let ok = false;
	try {
		ok = fs.existsSync(dir);
	} catch {
		ok = false;
	}
	existsCache.set(dir, ok);
	return ok;
}

// ---
// RESOLUTION
// ---

/** Read `len` bytes of `file` starting at `start`. */
function readSlice(file: string, start: number, len: number): string {
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(len);
		fs.readSync(fd, buf, 0, len, start);
		readCount++;
		return buf.toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/** Scan lines backwards for the first parseable entry carrying a string `cwd`. */
function scanBackwardsForCwd(text: string, partialFirstLine: boolean): string | null {
	const lines = text.split("\n");
	// A read that did not start at byte 0 begins mid-line — that fragment is
	// not JSON and must not be parsed as if it were.
	if (partialFirstLine) lines.shift();
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		try {
			const entry = JSON.parse(line);
			if (entry && typeof entry.cwd === "string" && entry.cwd) return entry.cwd;
		} catch {
			// Partial write or non-JSON line — keep walking back.
		}
	}
	return null;
}

/**
 * The working directory a session log was last written from, or null when the
 * log records none (Pi writes `cwd` only on its session_start entry, so Pi
 * transcripts resolve to null and contribute nothing — see the spec).
 *
 * @param filePath absolute path to a .jsonl session log
 * @param knownStat optional pre-read stat, to avoid a second syscall
 */
export function resolveLastCwd(filePath: string, knownStat?: fs.Stats): string | null {
	let stat: fs.Stats;
	try {
		stat = knownStat || fs.statSync(filePath);
	} catch {
		return null;
	}
	if (!stat.isFile() || stat.size === 0) return null;

	const key = `${filePath}:${stat.mtimeMs}:${stat.size}`;
	const cached = cwdCache.get(key);
	if (cached !== undefined) return cached;

	let result: string | null = null;
	for (const window of TAIL_WINDOWS) {
		const start = Math.max(0, stat.size - window);
		const len = stat.size - start;
		if (len <= 0) break;
		let text: string;
		try {
			text = readSlice(filePath, start, len);
		} catch {
			break;
		}
		result = scanBackwardsForCwd(text, start > 0);
		if (result) break;
		// Whole file already scanned — widening cannot help.
		if (start === 0) break;
	}

	cwdCache.set(key, result);
	return result;
}

// ---
// RELOCATION HISTORY (#164)
// ---

/** Marker Claude Code writes on every cwd change. Cheap pre-filter before JSON.parse. */
const RELOCATED_MARKER = '"relocated"';

/**
 * Every directory a session has ever occupied, most recent first.
 *
 * Claude Code writes `{"type":"relocated","relocatedCwd":"…"}` on each move.
 * `resolveLastCwd` cannot see them — it matches `entry.cwd`, and these entries
 * carry `relocatedCwd` instead — and no tail window can either: measured on this
 * machine (research/164-relocation-scan-probe.mjs) the earliest relocation sits
 * at 14–51 % of the file and even the *last* one falls outside the 8 KB tail of
 * a 2 MB transcript. So this is a whole-file read, which is why callers must
 * gate it on {@link pathExists}.
 *
 * THE GATE IS NOT THE BUDGET IT WAS WRITTEN AGAINST (#35, 2026-08-29). This
 * docstring used to cost the unconditional case at "315 ms over the 68 MB of
 * transcripts here", serving the ~3-in-40 that had actually moved. Both halves
 * have since been overtaken: the corpus measured 1.3 GB / 3,073 transcripts, and
 * 2,622 of them (85%) had a recorded cwd that no longer exists — so the gate
 * OPENS for 34 in 40 and lets 760 MB of whole-file reads through per pass.
 *
 * The cause is structural, not accidental: `pr-cleanup` deletes a worktree after
 * every merge and strands every session that lived there, permanently. So the
 * stranded fraction only rises, and any caller that runs this over the whole
 * corpus gets slower with every branch merged. Callers must therefore gate on
 * NEED as well as on {@link pathExists} — see the lazy discovery in bin/wtft.ts,
 * where running this eagerly was 98% of the CLI's wall clock.
 *
 * The *set* is the point, not the latest entry: in the #158 failure the latest
 * relocation pointed at the worktree that had been removed, and it was an
 * earlier one naming the main clone that made the session findable again.
 *
 * `relocated` is an optimisation, never a dependency — a transcript without any
 * yields a one-element history (its last `cwd`), i.e. exactly today's rule.
 */
export function resolveCwdHistory(filePath: string, knownStat?: fs.Stats): string[] {
	let stat: fs.Stats;
	try {
		stat = knownStat || fs.statSync(filePath);
	} catch {
		return [];
	}
	if (!stat.isFile() || stat.size === 0) return [];

	const key = `${filePath}:${stat.mtimeMs}:${stat.size}`;
	const cached = historyCache.get(key);
	if (cached !== undefined) return cached;

	// Most recent first: the last recorded cwd, then relocations newest-backwards.
	const ordered: string[] = [];
	const last = resolveLastCwd(filePath, stat);
	if (last) ordered.push(last);

	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
		historyReadCount++;
	} catch {
		historyCache.set(key, ordered);
		return ordered;
	}

	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		// Substring pre-filter: only ~3 transcripts in 40 carry any relocation,
		// and JSON.parse over every line of 68 MB is the whole cost otherwise.
		if (line.indexOf(RELOCATED_MARKER) === -1) continue;
		try {
			const entry = JSON.parse(line.trim());
			if (entry && entry.type === "relocated" && typeof entry.relocatedCwd === "string" && entry.relocatedCwd) {
				ordered.push(entry.relocatedCwd);
			}
		} catch {
			// Partial write or non-JSON line — keep walking back.
		}
	}

	const history = [...new Set(ordered)];
	historyCache.set(key, history);
	return history;
}

/**
 * The most recent directory in a session's history that still exists, or null.
 * Used for *display*: a stranded session should render somewhere real rather
 * than name a directory the user can no longer visit.
 */
export function pickLiveCwd(history: string[]): string | null {
	for (const dir of history) {
		if (pathExists(dir)) return dir;
	}
	return null;
}

// ---
// SLUG ENCODING (#144)
// ---

/**
 * Encode a directory the way the harnesses do: every separator becomes a dash.
 *
 * This stays the *canonical* single-string encoding — it is lossless for the
 * path shapes the display layer renders. For *matching*, use
 * {@link slugMatchesCwd}: what Claude Code munges beyond separators is only
 * partly evidenced (see {@link cwdToStrictSlug}).
 */
export function cwdToSlug(cwd: string): string {
	return cwd.replace(/[/\\]/g, "-");
}

/**
 * Encode a directory under the "everything non-alphanumeric munges" hypothesis.
 *
 * Evidenced on this machine's ~/.claude/projects/: `/` → `-` and `.` → `-`
 * (`…/princess-pi-packages/.claude/worktrees/x` is filed as
 * `…-princess-pi-packages--claude-worktrees-x`), while a literal `-` inside a
 * path segment survives. What happens to `_`, `~`, spaces and non-ASCII is
 * *unverified* — no project dir here has ever had one.
 */
export function cwdToStrictSlug(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Every slug a harness might have filed this cwd under, most specific first.
 *
 * Deliberately a union rather than a pinned character class: strict is right if
 * everything munges, legacy is right if only separators and dots do, and pinning
 * either one trades a known silent miss for an unknown one. They differ only for
 * paths containing punctuation other than `/` and `.`, so the cost is one extra
 * string compare and the answer is right under both hypotheses.
 */
export function cwdSlugVariants(cwd: string): string[] {
	const strict = cwdToStrictSlug(cwd);
	const legacy = cwdToSlug(cwd);
	return strict === legacy ? [strict] : [strict, legacy];
}

/** Does a project-dir name encode this cwd under *any* known encoding? */
export function slugMatchesCwd(slug: string, cwd: string): boolean {
	return cwdSlugVariants(cwd).includes(slug);
}

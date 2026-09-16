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
 * first entry with a `cwd`. Every read here is a TAIL read, bounded by
 * {@link TAIL_WINDOWS} — that bound is the module's whole performance contract,
 * and {@link getCwdBytesRead} is what holds it to it.
 *
 * #164 once added a second, unbounded arm: when a session's directory had been
 * *deleted*, it re-read the WHOLE transcript hunting for `"relocated"` records
 * to ask "where has it ever lived?". #89 deleted it. Measured on a 7,537-file /
 * 2.8 GB corpus, it opened for 6,637 transcripts per launch and returned **0**
 * extra candidates for all three cwds tested — because Claude Code files a
 * transcript under the directory it STARTED in, and a session starts in the main
 * clone before it enters a worktree, so the physical-slug arm already covers the
 * shape #164 was written for. Machine-wide, the `(session, dir)` pairs only that
 * arm could surface: 0. The history is still IN the transcripts; nothing reads
 * it. Re-derive it there if a case ever appears that the physical arm misses.
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

/** Test seam: counts actual file reads so memoisation is observable. */
let readCount = 0;

/** Test seam: BYTES read, not calls — the quantity #89 was actually about.
 *  A call count cannot tell a bounded tail read from a whole-file scan of a
 *  2 MB transcript; this can, which is why it replaced the #164 scan counter
 *  rather than simply being deleted alongside it. */
let bytesRead = 0;

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
 * Bytes read from transcripts since the last {@link resetCwdCache}.
 *
 * This is the guard on #89. Every read in this module goes through
 * {@link readSlice} and is capped at the largest of {@link TAIL_WINDOWS}, so
 * `bytesRead <= tailReads * 512 KB` is a structural invariant — and a
 * reintroduced whole-file scan of a multi-megabyte transcript breaks it on the
 * first oversized file rather than waiting for someone to notice a slow picker.
 */
export function getCwdBytesRead(): number {
	return bytesRead;
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
	readCount = 0;
	bytesRead = 0;
	dirWalkCount = 0;
}

// ---
// RESOLUTION
// ---

/** Read `len` bytes of `file` starting at `start`. */
function readSlice(file: string, start: number, len: number): string {
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(len);
		const got = fs.readSync(fd, buf, 0, len, start);
		readCount++;
		bytesRead += got;
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

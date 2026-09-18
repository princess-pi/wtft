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
 * SUPERSEDED BY #89's SCOPED PICKER (2026-09-18) — this module's reads are no
 * longer the DEFAULT cost of a launch. Before #89, every launch paid the
 * "14,441 reads, 580 MB, 1.6-2.0 s warm" figure this header used to quote
 * (measured 2026-09-16 over 7,287 transcripts / 2.51 GB, discovery over both
 * harnesses). #89's `"worktree"` scope — the picker's own default — runs the
 * physical-slug match ALONE and never pays this module's tail reads (it still
 * uses the slug encoder and the directory-walk counter from here): measured
 * 2026-09-18 on an 11,005-transcript corpus, folder-name matching found 7 of 7
 * Claude and 4 of 4 Pi sessions for the target cwd in **~7 ms**, zero tail
 * reads. That is what `#89`'s issue body's ≤ 200 ms closer could not meet
 * through this module and did not need to: the module was never the bottleneck
 * once the DEFAULT stopped calling it.
 *
 * This module's tail-read cost still exists, and still matters, for ONE scope
 * that widens past the default — `"worktrees"` (Ctrl+W), which still consults
 * {@link resolveLastCwd} for every transcript that does not already physically
 * match, which is exactly the population the figure above describes.
 * `"all"` (Ctrl+A) does NOT: it skips folder matching entirely (every session
 * for the harness already qualifies), so there is no non-matching population
 * for the union arm to run against, and this module is never called on that
 * path either (spec-89 S3). What bounds `"worktrees"`'s cost now is the time
 * window (#89, T1 = 20 minutes on every launch except an ambiguous `-s`,
 * which opens with no window, spec-89 S5):
 * `harness/claude-code/discovery.ts` and `harness/pi/discovery.ts` both skip
 * the tail read entirely for a transcript outside the active window, via one
 * `fs.statSync` first — and, under `"worktree"`/`"branch"` scope, skip the
 * `readdir`/`stat` pass for every NON-matching directory, since those scopes
 * never pay this module's tail reads. The old
 * unbounded cost is still reachable — deliberately — the moment a human cycles
 * `Ctrl+T` all the way to "all", which is why {@link getCwdBytesRead} and
 * {@link TAIL_WINDOWS} below are unchanged.
 *
 * #164 once added a second, unbounded arm: when a session's directory had been
 * *deleted*, it re-read the WHOLE transcript hunting for `"relocated"` records
 * to ask "where has it ever lived?". #89 deleted it. Measured 2026-09-16 on a
 * 7,287-file / 2.51 GB corpus, it performed 6,952 whole-file reads per launch
 * and returned **0** extra candidates for all three cwds tested — because Claude Code files a
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
 * Tail windows, widened only on a miss.
 *
 * "8 KB resolves every transcript here" is what this said, measured on a 40-file
 * corpus. It is no longer true: the module header's 2026-09-16 figures work out
 * to ~1.9 reads per transcript, ~41 KB per READ (corrected, pr-review round 3:
 * an earlier draft of this sentence attached "~41 KB" to "per transcript"
 * instead — 580 MB / 14,441 reads ≈ 41 KB/read, while 580 MB / 7,287
 * transcripts ≈ 80 KB/transcript; the two do not close if read as the same
 * quantity), so the second window is reached routinely — attachment-heavy
 * tails are common now, and a transcript with no
 * `cwd` anywhere in its final 512 KB widens through all three and then gives
 * up. That describes every Pi transcript OVER ~512 KB: Pi records `cwd` only
 * once, on its first (`session_start`) entry, which a widen-from-the-tail scan
 * cannot reach once the file outgrows the last window. A Pi transcript UNDER
 * that size has its whole file read by the third window, `session_start`
 * included, and DOES resolve — this scan finds no `cwd` only past that size,
 * not "always".
 *
 * 512 KB IS THE LAST WINDOW, NOT A STEP BEFORE A WHOLE-FILE READ (PR review).
 * The loop ends after it: a transcript over 512 KB has its last 512 KB read and
 * then resolves to null, unread beyond that. Only a transcript UNDER 512 KB is
 * ever read whole, because there the third window IS the whole file. That
 * distinction is #112's subject, and `docs/spec-156-155-…md` was amended once to
 * remove the same wrong claim — reintroducing it here would have been the third
 * time this sentence went wrong.
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
 * This is the guard on #89, and its SCOPE is worth stating because the first
 * draft of this docstring overstated it (PR review): it counts what goes through
 * {@link readSlice}, which is this module's only read path. The arm it replaced
 * did NOT use that path — `resolveCwdHistory` called `fs.readFileSync` directly
 * and incremented a counter of its own — so a re-introduction in that same style
 * would move neither counter and leave every byte assertion green while the
 * launch re-read gigabytes.
 *
 * So the invariant is enforced structurally rather than trusted: V22 in
 * tests/wtft-issue-144-145-164-session-discovery.test.ts reads this file's own
 * source and fails if a second read call appears in it. A counter cannot police
 * the code that declines to use it; a source assertion can.
 *
 * What the counter itself buys, given that: `bytesRead` catches the half-measure
 * a call count cannot see — a tail window widened toward the file size keeps the
 * read count identical and moves the bytes.
 */
export function getCwdBytesRead(): number {
	return bytesRead;
}

/**
 * Directory reads since the last {@link resetCwdCache}. One per directory
 * visited, including nested ones — so a flat corpus of N project dirs reads
 * exactly N. CLAUDE-CODE-ONLY today, not cross-harness: only
 * `claude-code/discovery.ts`'s `collect()` calls {@link countDirRead}; Pi's own
 * `collect()` does not (see that function's docstring above for why a count,
 * not a wall-clock ratio, is what this measures).
 */
export function getDirWalkCount(): number {
	return dirWalkCount;
}

/** Call once per directory a harness discovery's own tree walk reads. Opt-in,
 *  not enforced — Claude Code's `collect()` calls this; Pi's does not, so
 *  {@link getDirWalkCount} is silent on Pi's directory-walk cost. */
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

/**
 * Read `len` bytes of `file` starting at `start`, as BYTES.
 *
 * A Buffer rather than a string, because {@link resolveLastCwd} accumulates
 * across widenings and decoding each chunk on its own would split any multi-byte
 * character that straddles a chunk boundary. Concatenating first and decoding
 * once costs CPU, never I/O — and I/O is the quantity {@link getCwdBytesRead}
 * guards.
 *
 * SHORT READS ARE TRUNCATED, not padded (PR review). If the file shrank between
 * `statSync` and `readSync`, or `read(2)` came up short, the tail of the buffer
 * is NULs — `String.trim()` does not strip them, so the final data line becomes
 * `…}\u0000\u0000`, fails `JSON.parse`, and that transcript silently loses its
 * most recent `cwd`. Slicing to `got` also makes the bytes returned agree with
 * the bytes counted.
 */
function readSlice(file: string, start: number, len: number): Buffer {
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(len);
		const got = fs.readSync(fd, buf, 0, len, start);
		readCount++;
		bytesRead += got;
		return got === len ? buf : buf.subarray(0, got);
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
 * log records none within the last tail window (a Pi transcript records `cwd`
 * only on its session_start entry, so it resolves only when under ~512 KB;
 * see TAIL_WINDOWS).
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

	// WIDENING READS ONLY WHAT IT HAS NOT READ (PR review, Macroscope). The first
	// cut re-read `[size-window, size)` from scratch on every widening, so a
	// transcript needing all three windows cost 8 + 64 + 512 = 584 KB to scan
	// 512 KB — overspend in exactly the quantity getCwdBytesRead exists to guard.
	//
	// Each pass now reads only the newly exposed prefix and prepends it. Bytes are
	// read once; the accumulated buffer is decoded again per pass, which is CPU
	// and not I/O.
	let result: string | null = null;
	let acc: Buffer | null = null;
	let readFrom = stat.size;
	for (const window of TAIL_WINDOWS) {
		const start = Math.max(0, stat.size - window);
		const len = readFrom - start;
		if (len <= 0) break;
		try {
			const chunk = readSlice(filePath, start, len);
			acc = acc === null ? chunk : Buffer.concat([chunk, acc]);
		} catch {
			break;
		}
		readFrom = start;
		result = scanBackwardsForCwd(acc.toString("utf8"), start > 0);
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

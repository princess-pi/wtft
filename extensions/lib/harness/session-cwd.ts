/**
 * @package princess-pi-packages
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

/** Number of tail reads performed since the last {@link resetCwdCache}. */
export function getCwdReadCount(): number {
	return readCount;
}

/** Drop the memo table (tests; long-lived processes never need this). */
export function resetCwdCache(): void {
	cwdCache.clear();
	readCount = 0;
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

/** Encode a directory the way the harnesses do: every separator becomes a dash. */
export function cwdToSlug(cwd: string): string {
	return cwd.replace(/[/\\]/g, "-");
}

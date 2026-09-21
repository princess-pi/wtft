/**
 * Resolve where a session log currently lives, from the log itself.
 *
 * The project-dir slug is assigned when a session starts and never revised.
 * Walk backwards from the tail to the first entry with a `cwd`.
 */

import * as fs from "node:fs";

// ---

/**
 * Tail windows, widened only on a miss. 512 KB is the last window, not a
 * step before a whole-file read: a transcript over 512 KB has its last 512 KB
 * read and then resolves to null. Pi records `cwd` only on its first
 * (`session_start`) entry, so a Pi transcript over 512 KB does not resolve.
 */
const TAIL_WINDOWS = [8 * 1024, 64 * 1024, 512 * 1024];

// ---

/** Keyed on (path, mtimeMs, size) — an unchanged transcript is never re-read. */
const cwdCache = new Map<string, string | null>();

/** Test seam: counts actual file reads so memoisation is observable. */
let readCount = 0;

let bytesRead = 0;

let dirWalkCount = 0;

export function getCwdReadCount(): number {
	return readCount;
}

export function getCwdBytesRead(): number {
	return bytesRead;
}

export function getDirWalkCount(): number {
	return dirWalkCount;
}

/** Call once per directory a harness discovery's own tree walk reads. */
export function countDirRead(): void {
	dirWalkCount++;
}

export function resetCwdCache(): void {
	cwdCache.clear();
	readCount = 0;
	bytesRead = 0;
	dirWalkCount = 0;
}

// ---

/**
 * A Buffer rather than a string, because {@link resolveLastCwd} accumulates
 * across widenings and decoding each chunk on its own would split any
 * multi-byte character that straddles a chunk boundary.
 *
 * Short reads are truncated, not padded: if the file shrank between
 * `statSync` and `readSync`, the tail of an un-sliced buffer is NULs that
 * `String.trim()` does not strip, so the final data line fails `JSON.parse`.
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
 * only on its session_start entry, so it resolves only when under ~512 KB).
 *
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

	// Each pass reads only the newly exposed prefix and prepends it.
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
		if (start === 0) break;
	}

	cwdCache.set(key, result);
	return result;
}

// ---

/** Encode a directory the way the harnesses do: every separator becomes a dash. */
export function cwdToSlug(cwd: string): string {
	return cwd.replace(/[/\\]/g, "-");
}

/**
 * Encode a directory under the "everything non-alphanumeric munges" hypothesis.
 *
 * Observed: `/` → `-` and `.` → `-`, while a literal `-` inside a path segment
 * survives. Other punctuation is unverified.
 */
export function cwdToStrictSlug(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Every slug a harness might have filed this cwd under, most specific first.
 *
 * Union rather than a pinned character class: the two encodings differ only
 * for punctuation other than `/` and `.`.
 */
export function cwdSlugVariants(cwd: string): string[] {
	const strict = cwdToStrictSlug(cwd);
	const legacy = cwdToSlug(cwd);
	return strict === legacy ? [strict] : [strict, legacy];
}

export function slugMatchesCwd(slug: string, cwd: string): boolean {
	return cwdSlugVariants(cwd).includes(slug);
}

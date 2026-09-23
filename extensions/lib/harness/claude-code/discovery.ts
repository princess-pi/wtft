/**
 * @description Where Claude Code keeps its transcripts, and how to find one
 *   whose project dir no longer matches its cwd.
 *
 * Layout: ~/.claude/projects/<cwd-slug>/<session-id>.jsonl, with a `sessions/`
 * subdirectory in older installs. The slug is stamped at session start and
 * never revised, so it locates where a session *began*. The union rule below is
 * what makes a moved session reachable from where it now lives.
 *
 * Two further failure modes are folded into that same union, and both only ever
 * *add* matches — no arm may become a replacement:
 *
 *   - the slug encoding munges more than separators, so matching accepts
 *     either encoding rather than pinning one;
 *   - the target is a set of directories — every checkout of the cwd's
 *     repo — rather than a single one.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { DiscoverScopeOptions, HarnessDiscovery, SessionCandidate, SpawnCandidate } from "../types.ts";
import {
	resolveLastCwd,
	countDirRead,
	cwdSlugVariants,
} from "../session-cwd.ts";
import { fanOutCwd, resolveBranchCheckout } from "../worktrees.ts";
import { buildDisplayPath } from "@princess-pi/libs/session-path-shortener";

const ID = "claude-code";

/** Directories that hold derived data, not sessions. */
const SKIP_DIRS = new Set(["subagents", "tool-results", "memory", "wtft-tags"]);

/** The one definition of the projects root. `WTFT_CLAUDE_PROJECTS_DIR` points
 *  it at a fixture tree. */
export function projectsDir(): string {
	return process.env.WTFT_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");
}

function sessionIdOf(file: string): string {
	return path.basename(file).replace(/\.jsonl$/i, "");
}

/**
 * `projectSlug` is the top-level project dir name — the display path is built
 * from it, not from whatever nested directory the file was found in.
 */
function collect(dir: string, projectSlug: string, out: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	countDirRead();
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) collect(full, projectSlug, out);
		} else if (entry.name.endsWith(".jsonl")) {
			out.push(full);
		}
	}
}

function toCandidate(file: string, projectSlug: string): SessionCandidate | null {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		return null;
	}
	const name = path.basename(file);
	return {
		path: file,
		harness: ID,
		timestamp: stat.mtimeMs,
		name,
		// The physical project slug — a stranded session renders under the
		// directory it STARTED in.
		displayPath: buildDisplayPath(name, projectSlug, ID),
	};
}

/**
 * One arm, one bounded tail read. A transcript with no `cwd` at all resolves
 * to null and matches nothing.
 */
function matchesRecordedCwd(file: string, targets: Set<string>): boolean {
	const last = resolveLastCwd(file);
	return last !== null && targets.has(last);
}

function upsertCandidate(into: Map<string, SessionCandidate>, candidate: SessionCandidate | null): void {
	if (!candidate) return;
	const id = sessionIdOf(candidate.path);
	const existing = into.get(id);
	if (!existing || candidate.timestamp > existing.timestamp) into.set(id, candidate);
}

/**
 * Legacy default: fan out across every checkout of `target`'s repo, union the
 * physical-slug arm with the last-cwd tail arm, no time bound. Preserved for
 * every caller that omits `scopeOpts` — see `discover` in `../types.ts`.
 */
function discoverLegacy(root: string, target: string): SessionCandidate[] {
	const fan = fanOutCwd(target);
	const targets = new Set(fan.dirs);
	const targetSlugs = new Set<string>();
	for (const dir of fan.dirs) {
		for (const variant of cwdSlugVariants(dir)) targetSlugs.add(variant);
	}

	let projectDirs: string[];
	try {
		projectDirs = fs.readdirSync(root, { withFileTypes: true })
			.filter(e => e.isDirectory())
			.map(e => e.name);
	} catch {
		return [];
	}

	const bySessionId = new Map<string, SessionCandidate>();

	for (const slug of projectDirs) {
		const physicalMatch =
			targetSlugs.has(slug) ||
			fan.slugPrefixes.some(prefix => slug.startsWith(prefix));
		const files: string[] = [];
		collect(path.join(root, slug), slug, files);

		for (const file of files) {
			if (!physicalMatch && !matchesRecordedCwd(file, targets)) continue;
			upsertCandidate(bySessionId, toCandidate(file, slug));
		}
	}

	return [...bySessionId.values()];
}

/**
 * Scoped path — see `DiscoveryScope` in `../types.ts`. `windowMs` bounds every
 * scope uniformly: a transcript outside the window is skipped after one `stat`,
 * before any tail read the union arm would otherwise pay for.
 */
function discoverScoped(root: string, target: string, opts: DiscoverScopeOptions): SessionCandidate[] {
	const { scope, windowMs } = opts;
	const now = Date.now();
	const withinWindow = (mtimeMs: number) => windowMs === null || now - mtimeMs <= windowMs;

	let projectDirs: string[];
	try {
		projectDirs = fs.readdirSync(root, { withFileTypes: true })
			.filter(e => e.isDirectory())
			.map(e => e.name);
	} catch {
		return [];
	}

	const bySessionId = new Map<string, SessionCandidate>();

	if (scope === "all") {
		for (const slug of projectDirs) {
			const files: string[] = [];
			collect(path.join(root, slug), slug, files);
			for (const file of files) {
				let stat: fs.Stats;
				try { stat = fs.statSync(file); } catch { continue; }
				if (!withinWindow(stat.mtimeMs)) continue;
				upsertCandidate(bySessionId, toCandidate(file, slug));
			}
		}
		return [...bySessionId.values()];
	}

	// "worktree", "worktrees" and "branch" all narrow to a target-dir set
	// first, then apply the SAME physical-match-or-union loop below.
	let targetDirs: string[];
	let useUnionArm: boolean;
	let fallbackSlugPrefixes: string[] = [];
	if (scope === "worktree") {
		targetDirs = [target];
		useUnionArm = false;
	} else if (scope === "branch") {
		// Documented no-op: fall back to the bare target directory rather than
		// silently widening to something else.
		targetDirs = [resolveBranchCheckout(target) ?? target];
		useUnionArm = false;
	} else {
		const fan = fanOutCwd(target);
		targetDirs = fan.dirs;
		useUnionArm = true;
		// When git could not enumerate checkouts, accept a slug PREFIX — the
		// in-tree layout's own slug still starts with the main clone's.
		if (fan.usedFallback) fallbackSlugPrefixes = fan.slugPrefixes;
	}

	const targetSet = new Set(targetDirs);
	const targetSlugs = new Set<string>();
	for (const dir of targetDirs) {
		for (const variant of cwdSlugVariants(dir)) targetSlugs.add(variant);
	}

	for (const slug of projectDirs) {
		const physicalMatch = targetSlugs.has(slug) ||
			fallbackSlugPrefixes.some(prefix => slug.startsWith(prefix));

		if (!physicalMatch && !useUnionArm) continue;

		const files: string[] = [];
		collect(path.join(root, slug), slug, files);

		for (const file of files) {
			let stat: fs.Stats;
			try { stat = fs.statSync(file); } catch { continue; }
			if (!withinWindow(stat.mtimeMs)) continue;

			let matched = physicalMatch;
			// Union (last-cwd tail) arm only for a NON-physical match under
			// "worktrees" — "worktree"/"branch" never pay a tail read.
			if (!matched && useUnionArm) matched = matchesRecordedCwd(file, targetSet);
			if (!matched) continue;

			upsertCandidate(bySessionId, toCandidate(file, slug));
		}
	}

	return [...bySessionId.values()];
}

/** Head lines searched for the first timestamp, cwd and entrypoint. The
 *  first line is often a title or snapshot carrying none of them. */
const CANDIDATE_HEAD_LINES = 20;
const CANDIDATE_HEAD_BYTES = 64 * 1024;

function readCandidateHead(file: string): Omit<SpawnCandidate, "path" | "sessionId"> | null {
	const fd = fs.openSync(file, "r");
	let text: string;
	try {
		const buf = Buffer.alloc(CANDIDATE_HEAD_BYTES);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		text = buf.subarray(0, n).toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
	let startedAt: number | null = null;
	let cwd: string | null = null;
	let entrypoint: unknown;
	for (const line of text.split("\n").slice(0, CANDIDATE_HEAD_LINES)) {
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		if (startedAt === null && typeof entry?.timestamp === "string") {
			const ms = Date.parse(entry.timestamp);
			if (!Number.isNaN(ms)) startedAt = ms;
		}
		if (cwd === null && typeof entry?.cwd === "string" && entry.cwd) cwd = entry.cwd;
		if (entrypoint === undefined && typeof entry?.entrypoint === "string") entrypoint = entry.entrypoint;
		if (startedAt !== null && cwd !== null && entrypoint !== undefined) break;
	}
	if (startedAt === null || cwd === null) return null;
	const launchedBy = entrypoint === "sdk-cli" ? "program" : entrypoint === "cli" ? "human" : null;
	return { cwd, startedAt, launchedBy };
}

/** A path that went away — a transcript or project dir deleted mid-scan, or
 *  no projects root at all. Nothing is there to list. */
function isGone(err: unknown): boolean {
	return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * Top-level transcripts only, pruned by mtime twice: a project dir's mtime
 * moves when a transcript is created in it, so an older directory cannot
 * hold a transcript that began after `sinceMs`. Symlinks count: `statSync`
 * follows them.
 *
 * Any read error other than a path that went away is THROWN, so the report
 * fails loudly: an empty listing must only ever mean "looked, found none".
 */
function listSpawnCandidates(sinceMs: number): SpawnCandidate[] {
	const candidates: SpawnCandidate[] = [];
	const root = projectsDir();
	let slugs: fs.Dirent[];
	try {
		slugs = fs.readdirSync(root, { withFileTypes: true });
	} catch (err) {
		if (isGone(err)) return candidates;
		throw err;
	}
	for (const slug of slugs) {
		if (!slug.isDirectory() && !slug.isSymbolicLink()) continue;
		const dir = path.join(root, slug.name);
		let entries: fs.Dirent[];
		try {
			const stat = fs.statSync(dir);
			if (!stat.isDirectory() || stat.mtimeMs < sinceMs) continue;
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			if (isGone(err)) continue;
			throw err;
		}
		for (const entry of entries) {
			if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".jsonl")) continue;
			const file = path.join(dir, entry.name);
			try {
				const stat = fs.statSync(file);
				if (!stat.isFile() || stat.mtimeMs < sinceMs) continue;
				const head = readCandidateHead(file);
				if (head) candidates.push({ path: file, sessionId: sessionIdOf(file), ...head });
			} catch (err) {
				if (isGone(err)) continue;
				throw err;
			}
		}
	}
	return candidates;
}

function mtimeOrNull(file: string): number | null {
	try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

/**
 * Every session id → its newest readable transcript, from one walk of the
 * tree: the answer `resolveSessionById` gives for each id.
 */
function indexSessionsById(): Map<string, string> {
	const index = new Map<string, string>();
	const root = projectsDir();
	let projectDirs: string[];
	try {
		projectDirs = fs.readdirSync(root, { withFileTypes: true })
			.filter(e => e.isDirectory())
			.map(e => e.name);
	} catch (err) {
		// ENOENT (raced away between the existsSync above and here) is ordinary:
		// nothing to index. Anything else — permission denied, most commonly —
		// must be LOUD: a caller cannot tell "no sessions" from "could not look".
		if (isGone(err)) return index;
		throw err;
	}
	const newest = new Map<string, number>();
	for (const slug of projectDirs) {
		const files: string[] = [];
		collect(path.join(root, slug), slug, files);
		for (const file of files) {
			const id = sessionIdOf(file);
			// Stat every copy, as `resolveSessionById` does: one that cannot be
			// stat-ed (a dangling symlink, a file gone mid-walk) is never indexed,
			// so the walk asks the next harness rather than stopping on a dead path.
			const mtimeMs = mtimeOrNull(file);
			if (mtimeMs === null) continue;
			if (!newest.has(id) || mtimeMs > newest.get(id)!) {
				newest.set(id, mtimeMs);
				index.set(id, file);
			}
		}
	}
	return index;
}

export const discovery: HarnessDiscovery = {
	id: ID,
	label: "Claude",

	discover(targetCwd: string | null, scopeOpts?: DiscoverScopeOptions): SessionCandidate[] {
		const root = projectsDir();
		if (!fs.existsSync(root)) return [];

		// Claude discovery has always been cwd-scoped; a null target means "no
		// explicit --dir", not "every session on the machine".
		const target = path.resolve(targetCwd || process.cwd());

		return scopeOpts ? discoverScoped(root, target, scopeOpts) : discoverLegacy(root, target);
	},

	resolveSessionById(sessionId: string): string | null {
		const root = projectsDir();
		if (!fs.existsSync(root)) return null;
		const wanted = sessionId.replace(/\.jsonl$/i, "");

		let best: { path: string; mtimeMs: number } | null = null;
		let projectDirs: string[];
		try {
			projectDirs = fs.readdirSync(root, { withFileTypes: true })
				.filter(e => e.isDirectory())
				.map(e => e.name);
		} catch {
			return null;
		}

		for (const slug of projectDirs) {
			const files: string[] = [];
			collect(path.join(root, slug), slug, files);
			for (const file of files) {
				if (sessionIdOf(file) !== wanted) continue;
				try {
					const mtimeMs = fs.statSync(file).mtimeMs;
					if (!best || mtimeMs > best.mtimeMs) best = { path: file, mtimeMs };
				} catch { /* raced with a move — skip */ }
			}
		}

		return best ? best.path : null;
	},

	indexSessionsById,

	listSpawnCandidates,
};

export default discovery;

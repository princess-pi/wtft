/**
 * @package princess-pi-tools
 * @module harness/claude-code/discovery
 * @description Where Claude Code keeps its transcripts, and how to find one
 *   whose project dir no longer matches its cwd (#156).
 *
 * Layout: ~/.claude/projects/<cwd-slug>/<session-id>.jsonl, with a `sessions/`
 * subdirectory in older installs. The slug is stamped at session start and
 * never revised, so it locates where a session *began*. The union rule below is
 * what makes a moved session reachable from where it now lives.
 *
 * Three further failure modes are folded into that same union, and every one of
 * them only ever *adds* matches — no arm may become a replacement:
 *
 *   #144  the slug encoding munges more than separators, so matching accepts
 *         either encoding rather than pinning one;
 *   #164  a session whose directory has been *deleted* matches on the set of
 *         directories it has ever occupied, not just its latest one;
 *   #145  the target is a set of directories — every checkout of the cwd's
 *         repo — rather than a single one.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { HarnessDiscovery, SessionCandidate } from "../types.ts";
import {
	resolveLastCwd,
	resolveCwdHistory,
	pickLiveCwd,
	pathExists,
	cwdToSlug,
	cwdSlugVariants,
} from "../session-cwd.ts";
import { fanOutCwd } from "../worktrees.ts";
import { buildDisplayPath } from "@princess-pi/libs/session-path-shortener";

const ID = "claude-code";

/** Directories that hold derived data, not sessions. */
const SKIP_DIRS = new Set(["subagents", "tool-results", "memory", "wtft-tags"]);

/** Test seam: point discovery at a fixture tree instead of the real home dir. */
function projectsDir(): string {
	return process.env.WTFT_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");
}

/** Session id = the transcript basename without its extension (a UUID). */
function sessionIdOf(file: string): string {
	return path.basename(file).replace(/\.jsonl$/i, "");
}

/**
 * Collect every .jsonl under `dir`, recursing past derived-data directories.
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
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) collect(full, projectSlug, out);
		} else if (entry.name.endsWith(".jsonl")) {
			out.push(full);
		}
	}
}

/**
 * Which slug to *render* this session under (#164).
 *
 * The physical project slug is the answer in every ordinary case, and is kept
 * verbatim so no row that renders today changes. It is only wrong for a
 * stranded session, where it names a directory that has been deleted — showing
 * the user a path they cannot visit. There, the most recent still-existing
 * directory from the session's history is the honest label.
 */
function displaySlugFor(file: string, projectSlug: string): string {
	const last = resolveLastCwd(file);
	if (last === null || pathExists(last)) return projectSlug;
	const live = pickLiveCwd(resolveCwdHistory(file));
	return live ? cwdToSlug(live) : projectSlug;
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
		displayPath: buildDisplayPath(name, displaySlugFor(file, projectSlug), ID),
	};
}

/**
 * Does this transcript's own recorded location put it in one of the targets?
 *
 * Two arms, in cost order. The second is gated on the first failing *and* on the
 * session's home being gone — unconditionally it is a whole-file read costing
 * ~315 ms over a real history, to serve 3 transcripts in 40
 * (research/164-relocation-scan-probe.mjs).
 *
 * A transcript with no `cwd` at all resolves to null and matches nothing, which
 * is what keeps Pi transcripts out of this entirely.
 */
function matchesRecordedCwd(file: string, targets: Set<string>): boolean {
	const last = resolveLastCwd(file);
	if (last === null) return false;
	if (targets.has(last)) return true;
	// Lives somewhere real, just not here — nothing further to ask.
	if (pathExists(last)) return false;
	return resolveCwdHistory(file).some(dir => targets.has(dir));
}

export const discovery: HarnessDiscovery = {
	id: ID,
	label: "Claude",

	discover(targetCwd: string | null): SessionCandidate[] {
		const root = projectsDir();
		if (!fs.existsSync(root)) return [];

		// Claude discovery has always been cwd-scoped; a null target means "no
		// explicit --dir", not "every session on the machine". That policy lives
		// here rather than in shared code so each harness keeps its own.
		const target = path.resolve(targetCwd || process.cwd());

		// #145: "here" is every checkout of this repo, not one directory. A cwd
		// outside any repo fans out to itself alone, so `~` still means `~`.
		// --dir picks the anchor; the policy is the same either way.
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

		// Dedup by session id — the same session can be reachable through both
		// halves of the union (its own dir matches AND its last-cwd matches).
		// Newest mtime wins.
		const bySessionId = new Map<string, SessionCandidate>();

		for (const slug of projectDirs) {
			// Physical arm: any encoding (#144) of any checkout (#145). The
			// prefix arm only exists when git could not enumerate the checkouts.
			const physicalMatch =
				targetSlugs.has(slug) ||
				fan.slugPrefixes.some(prefix => slug.startsWith(prefix));
			const files: string[] = [];
			collect(path.join(root, slug), slug, files);

			for (const file of files) {
				// Union rule: physical slug match OR the transcript's own
				// recorded location. Union, not replacement — a last-cwd-only
				// rule would DROP the session filed under a repo-root slug whose
				// cwd is a subdir, which is a session the current selector finds.
				if (!physicalMatch && !matchesRecordedCwd(file, targets)) continue;

				const candidate = toCandidate(file, slug);
				if (!candidate) continue;
				const id = sessionIdOf(file);
				const existing = bySessionId.get(id);
				if (!existing || candidate.timestamp > existing.timestamp) {
					bySessionId.set(id, candidate);
				}
			}
		}

		return [...bySessionId.values()];
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
};

export default discovery;

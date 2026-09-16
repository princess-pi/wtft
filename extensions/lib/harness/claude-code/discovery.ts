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
 * Two further failure modes are folded into that same union, and both only ever
 * *add* matches — no arm may become a replacement:
 *
 *   #144  the slug encoding munges more than separators, so matching accepts
 *         either encoding rather than pinning one;
 *   #145  the target is a set of directories — every checkout of the cwd's
 *         repo — rather than a single one.
 *
 * A third arm (#164) used to whole-file-read any transcript whose recorded cwd
 * had been deleted, looking for an earlier directory it had occupied. #89
 * deleted it. Measured 2026-09-16 over 7,287 transcripts / 2.51 GB: **6,952
 * whole-file reads per launch, 0 candidates** — the per-arm split was 0 for all
 * three cwds tested, and the candidate lists before and after the deletion are
 * identical (10 / 88 / 153). docs/spec-144-145-164-session-discovery.md,
 * Amendment 1, carries the tables.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { HarnessDiscovery, SessionCandidate } from "../types.ts";
import {
	resolveLastCwd,
	countDirRead,
	cwdSlugVariants,
} from "../session-cwd.ts";
import { fanOutCwd } from "../worktrees.ts";
import { buildDisplayPath } from "@princess-pi/libs/session-path-shortener";

const ID = "claude-code";

/** Directories that hold derived data, not sessions. */
const SKIP_DIRS = new Set(["subagents", "tool-results", "memory", "wtft-tags"]);

/** Test seam: point discovery at a fixture tree instead of the real home dir.
 *
 *  Exported since #116, because the spawn-tree walk resolves a child session by
 *  uuid under this same root and a second spelling of it would mean a fixture
 *  tree that discovery honours and the walk ignores. One definition, one env
 *  var, both callers. */
export function projectsDir(): string {
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
		// The physical project slug, always (#89). A stranded session renders
		// under the directory it STARTED in — a real path in every case measured,
		// and unlike the deleted #164 lookup it costs nothing to produce.
		displayPath: buildDisplayPath(name, projectSlug, ID),
	};
}

/**
 * Does this transcript's own recorded location put it in one of the targets?
 *
 * One arm, and one bounded tail read (#89). It used to have a second: when the
 * recorded cwd no longer existed, the transcript was re-read WHOLE for the
 * directories it had previously occupied. That case is real — `pr-cleanup`
 * strands a session on every merge.
 *
 * WHAT WAS MEASURED, and it is a measurement rather than a theorem: over the
 * 7,287-transcript corpus of 2026-09-16 the expensive arm surfaced **0**
 * candidates the physical arm had not, for all three cwds tested. The usual
 * reason is that a transcript is filed under the directory its session STARTED
 * in, and a session typically starts in the main clone before entering a
 * worktree — so the physical arm plus the #145 fan-out already reaches it.
 *
 * THAT IS NOT UNIVERSAL, and this branch's own V6 constructs the exception: a
 * session that started INSIDE a worktree is filed under that worktree's slug,
 * and once the worktree is removed nothing but its relocation history connects
 * it to the clone. Such a session is no longer listed. None existed on the
 * corpus; the corpus does hold 101 `*-claude-worktrees-*` slugs, so the shape is
 * reachable and the exception is conceded rather than argued away. See
 * "The one shape given up" in the spec.
 *
 * Discovery is still called lazily by bin/wtft.ts: running it for an explicit
 * `-s` was 98% of that command's wall clock, and a bounded scan of thousands of
 * files is still a scan of thousands of files.
 *
 * A transcript with no `cwd` at all resolves to null and matches nothing, which
 * is what keeps Pi transcripts out of this entirely.
 */
function matchesRecordedCwd(file: string, targets: Set<string>): boolean {
	const last = resolveLastCwd(file);
	return last !== null && targets.has(last);
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

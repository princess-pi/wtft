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

import type { DiscoverScopeOptions, HarnessDiscovery, SessionCandidate } from "../types.ts";
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

/** Test seam: point discovery at a fixture tree instead of the real home dir.
 *
 *  NOT exported, and the export this branch briefly added is gone again. Both
 *  callers — `discover()` and `resolveSessionById()` — live right here. The
 *  spawn-tree walk (#116) reaches this same root only indirectly, through
 *  `getDiscoveries()` → `resolveSessionById()`, never through a second
 *  `projectsDir()` of its own, so there was nothing for the export to keep in
 *  sync. The round-4 docstring said it was "left exported and untouched"; the
 *  diff had in fact created the export, and the reason it gave — nothing left
 *  to keep in sync — is the reason not to have one. */
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
 * A transcript with no `cwd` at all resolves to null and matches nothing.
 */
function matchesRecordedCwd(file: string, targets: Set<string>): boolean {
	const last = resolveLastCwd(file);
	return last !== null && targets.has(last);
}

/** Insert-or-replace-if-newer into the dedup-by-session-id map every discover
 *  path shares — the same session can be reachable through more than one arm
 *  of a union rule, and the newest mtime copy wins. */
function upsertCandidate(into: Map<string, SessionCandidate>, candidate: SessionCandidate | null): void {
	if (!candidate) return;
	const id = sessionIdOf(candidate.path);
	const existing = into.get(id);
	if (!existing || candidate.timestamp > existing.timestamp) into.set(id, candidate);
}

/**
 * The pre-#89 default: fan out across every checkout of `target`'s repo, union
 * the physical-slug arm with the last-cwd tail arm, no time bound. Preserved
 * byte-for-byte in BEHAVIOUR (not literally in code shape, since it now shares
 * `upsertCandidate`) so every caller that omits `scopeOpts` sees exactly
 * today's candidate set — see the `discover` docstring in `../types.ts`.
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
 * The #89 scoped path — see `DiscoveryScope`'s own docstring in `../types.ts`
 * for what each scope means and costs. `windowMs` bounds every scope
 * uniformly: a transcript outside the window is skipped after one `stat`,
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
	// first, then apply the SAME physical-match-or-union loop below — they
	// differ only in which directories are targets and whether the union arm
	// is consulted at all.
	let targetDirs: string[];
	let useUnionArm: boolean;
	// Only "worktrees" ever calls fanOutCwd (see the branch below), so only it
	// can populate `fallbackSlugPrefixes` — "worktree" and "branch" never
	// reach the `if (fan.usedFallback)` check at all, which is what actually
	// gates this (not a `slugPrefixes.length` check; corrected, pr-review
	// round 2 — an earlier draft of this comment described a length check
	// this code has never performed). See fanOutCwd's own
	// CwdFanOut.usedFallback docstring in ../worktrees.ts for what triggers
	// the fallback (git unusable).
	let fallbackSlugPrefixes: string[] = [];
	if (scope === "worktree") {
		targetDirs = [target];
		useUnionArm = false;
	} else if (scope === "branch") {
		// A documented no-op (S4 / Interpretation notes): fall back to the bare
		// target directory rather than silently widening to something else.
		targetDirs = [resolveBranchCheckout(target) ?? target];
		useUnionArm = false;
	} else {
		const fan = fanOutCwd(target);
		targetDirs = fan.dirs;
		useUnionArm = true;
		// discoverLegacy's physical-match arm also accepts a slug PREFIX when
		// git could not enumerate the repo's checkouts (fan.usedFallback) — the
		// in-tree layout's own slug still starts with the main clone's, even
		// though fanOutCwd itself couldn't confirm it via git. Omitting this
		// here would have silently narrowed "worktrees" scope exactly when git
		// is unusable, the one case that most needs the fallback (found in
		// spec-reconcile for #89, a genuine coverage gap rather than a doc
		// drift — fixed here, not just noted).
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

		// SKIP THE DIRECTORY ENTIRELY when it cannot possibly contribute
		// (pr-review, Medium): a non-matching slug under "worktree"/"branch"
		// (`useUnionArm` false) has no way to match — the union arm that could
		// have found it anyway never runs for those two scopes — so reading its
		// directory and stat-ing every file in it would cost exactly the
		// per-transcript work S1/S5 promise a bare `wtft` launch never pays.
		// This is what makes the ~7 ms measurement in this module's own header
		// (and types.ts's DiscoveryScope docstring) true of the CODE, not just
		// of a corpus where every non-matching directory happened to be cheap.
		if (!physicalMatch && !useUnionArm) continue;

		const files: string[] = [];
		collect(path.join(root, slug), slug, files);

		for (const file of files) {
			let stat: fs.Stats;
			try { stat = fs.statSync(file); } catch { continue; }
			if (!withinWindow(stat.mtimeMs)) continue;

			let matched = physicalMatch;
			// The union (last-cwd tail) arm only ever runs for a NON-physical
			// match, and only under "worktrees" — this is the cost bound S1/S5
			// exist for: "worktree" and "branch" scope never pay a tail read at
			// all, and "worktrees" only pays one for a transcript already inside
			// the active time window.
			if (!matched && useUnionArm) matched = matchesRecordedCwd(file, targetSet);
			if (!matched) continue;

			upsertCandidate(bySessionId, toCandidate(file, slug));
		}
	}

	return [...bySessionId.values()];
}

export const discovery: HarnessDiscovery = {
	id: ID,
	label: "Claude",

	discover(targetCwd: string | null, scopeOpts?: DiscoverScopeOptions): SessionCandidate[] {
		const root = projectsDir();
		if (!fs.existsSync(root)) return [];

		// Claude discovery has always been cwd-scoped; a null target means "no
		// explicit --dir", not "every session on the machine". That policy lives
		// here rather than in shared code so each harness keeps its own.
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
};

export default discovery;

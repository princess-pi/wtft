/**
 * @description Where Pi keeps its session logs.
 *
 * Layout: ~/.pi/agent/sessions/<--slug-->/<timestamp>_<uuid>.jsonl, where the
 * directory name is the cwd slug wrapped in `--`. The single-directory scopes
 * compare exactly after unwrapping; `"worktrees"` and the unscoped default
 * match by containment.
 *
 * The union arm is wired in but mostly inert today: Pi records `cwd` once, on
 * its session_start entry, so a tail scan finds a DIFFERENT cwd than the one
 * the transcript is physically filed under only when the session moved
 * directories after that entry. Pi's directory slug already encodes the start
 * cwd. The day Pi records per-entry cwd, this arm starts catching an
 * in-session move with no code change.
 *
 * Slug matching accepts either encoding under containment matching.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { DiscoverScopeOptions, HarnessDiscovery, SessionCandidate } from "../types.ts";
import { resolveLastCwd, cwdSlugVariants } from "../session-cwd.ts";
import { fanOutCwd, resolveBranchCheckout } from "../worktrees.ts";
import { buildDisplayPath } from "@princess-pi/libs/session-path-shortener";

const ID = "pi";

const SKIP_DIRS = new Set(["subagents", "tool-results", "memory", "wtft-tags"]);

/** Test seam: point discovery at a fixture tree instead of the real home dir. */
function sessionsDir(): string {
	return process.env.WTFT_PI_SESSIONS_DIR || path.join(os.homedir(), ".pi", "agent", "sessions");
}

function sessionIdOf(file: string): string {
	return path.basename(file).replace(/\.jsonl$/i, "");
}

function collect(dir: string, out: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) collect(full, out);
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
		displayPath: buildDisplayPath(name, projectSlug, ID),
	};
}

function upsertCandidate(into: Map<string, SessionCandidate>, candidate: SessionCandidate | null): void {
	if (!candidate) return;
	const id = sessionIdOf(candidate.path);
	const existing = into.get(id);
	if (!existing || candidate.timestamp > existing.timestamp) into.set(id, candidate);
}

/** Legacy default for every caller omitting `scopeOpts` (see `discover` in `../types.ts`). */
function discoverLegacy(root: string, target: string | null): SessionCandidate[] {
	const targetSlugs = target ? cwdSlugVariants(target) : null;

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
			targetSlugs === null || targetSlugs.some(variant => slug.includes(variant));
		const files: string[] = [];
		collect(path.join(root, slug), files);

		for (const file of files) {
			if (!physicalMatch && (target === null || resolveLastCwd(file) !== target)) continue;
			upsertCandidate(bySessionId, toCandidate(file, slug));
		}
	}

	return [...bySessionId.values()];
}

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
			collect(path.join(root, slug), files);
			for (const file of files) {
				let stat: fs.Stats;
				try { stat = fs.statSync(file); } catch { continue; }
				if (!withinWindow(stat.mtimeMs)) continue;
				upsertCandidate(bySessionId, toCandidate(file, slug));
			}
		}
		return [...bySessionId.values()];
	}

	let targetDirs: string[];
	let useUnionArm: boolean;
	if (scope === "worktree") {
		targetDirs = [target];
		useUnionArm = false;
	} else if (scope === "branch") {
		targetDirs = [resolveBranchCheckout(target) ?? target];
		useUnionArm = false;
	} else {
		targetDirs = fanOutCwd(target).dirs;
		useUnionArm = true;
	}

	const targetSet = new Set(targetDirs);
	const targetSlugs = new Set<string>();
	for (const dir of targetDirs) for (const variant of cwdSlugVariants(dir)) targetSlugs.add(variant);

	// "worktree"/"branch": exact match after unwrapping. Containment only for
	// "worktrees", where one target slug must also match a sibling in-tree
	// worktree's slug. Exact means normalize both sides — `cwdSlugVariants`
	// already carries a leading dash from `/`, so reconstructing `"--" +
	// variant + "--"` would build three leading dashes. Strip the wrap the
	// same way `buildDisplayPath` does.
	const stripPiWrap = (s: string): string => s.replace(/^--/, "").replace(/--$/, "");
	const matchesTarget = (slug: string, variant: string): boolean =>
		scope === "worktrees" ? slug.includes(variant) : stripPiWrap(slug) === variant.replace(/^-/, "");

	for (const slug of projectDirs) {
		const physicalMatch = [...targetSlugs].some(variant => matchesTarget(slug, variant));

		// Non-matching slug under "worktree"/"branch" cannot contribute — the
		// union arm never runs for those scopes.
		if (!physicalMatch && !useUnionArm) continue;

		const files: string[] = [];
		collect(path.join(root, slug), files);

		for (const file of files) {
			let stat: fs.Stats;
			try { stat = fs.statSync(file); } catch { continue; }
			if (!withinWindow(stat.mtimeMs)) continue;

			let matched = physicalMatch;
			if (!matched && useUnionArm) {
				const last = resolveLastCwd(file);
				matched = last !== null && targetSet.has(last);
			}
			if (!matched) continue;

			upsertCandidate(bySessionId, toCandidate(file, slug));
		}
	}

	return [...bySessionId.values()];
}

/** Every session id → its newest transcript, from one walk of the tree. */
function indexSessionsById(): Map<string, string> {
	const index = new Map<string, string>();
	const root = sessionsDir();
	if (!fs.existsSync(root)) return index;
	const files: string[] = [];
	collect(root, files);
	const newest = new Map<string, number>();
	for (const file of files) {
		const id = sessionIdOf(file);
		try {
			const mtimeMs = fs.statSync(file).mtimeMs;
			if (!newest.has(id) || mtimeMs > newest.get(id)!) {
				newest.set(id, mtimeMs);
				index.set(id, file);
			}
		} catch { /* raced with a move — skip */ }
	}
	return index;
}

export const discovery: HarnessDiscovery = {
	id: ID,
	label: "Pi",

	discover(targetCwd: string | null, scopeOpts?: DiscoverScopeOptions): SessionCandidate[] {
		const root = sessionsDir();
		if (!fs.existsSync(root)) return [];

		if (!scopeOpts) {
			// Pi's policy: no explicit target means every Pi session, not the cwd's.
			const target = targetCwd ? path.resolve(targetCwd) : null;
			return discoverLegacy(root, target);
		}

		if (scopeOpts.scope === "all") return discoverScoped(root, "", scopeOpts);
		return discoverScoped(root, path.resolve(targetCwd || process.cwd()), scopeOpts);
	},

	resolveSessionById(sessionId: string): string | null {
		const root = sessionsDir();
		if (!fs.existsSync(root)) return null;
		const wanted = sessionId.replace(/\.jsonl$/i, "");

		const files: string[] = [];
		collect(root, files);

		let best: { path: string; mtimeMs: number } | null = null;
		for (const file of files) {
			if (sessionIdOf(file) !== wanted) continue;
			try {
				const mtimeMs = fs.statSync(file).mtimeMs;
				if (!best || mtimeMs > best.mtimeMs) best = { path: file, mtimeMs };
			} catch { /* raced with a move — skip */ }
		}
		return best ? best.path : null;
	},

	indexSessionsById,
};

export default discovery;

/**
 * @package princess-pi-tools
 * @module harness/pi/discovery
 * @description Where Pi keeps its session logs (#156).
 *
 * Layout: ~/.pi/agent/sessions/<--slug-->/<timestamp>_<uuid>.jsonl, where the
 * directory name is the cwd slug wrapped in `--`. Matching is by containment,
 * which is why an unwrapped slug still finds the directory.
 *
 * The union half of the #156 rule is wired in but inert today: Pi records `cwd`
 * once, on its session_start entry, so a tail scan resolves null and contributes
 * nothing. That is correct rather than a gap — Pi's directory slug already
 * encodes the start cwd and Pi has no worktree switch that rewrites it. The day
 * Pi records per-entry cwd, this works with no code change.
 *
 * #144 applies here only as the slug *union*: Pi's session dirs on this machine
 * contain no dot-derived name, so Pi's own munging is unverified in exactly the
 * same way Claude Code's was. Accepting either encoding is additive under
 * containment matching and is right whichever way Pi actually behaves;
 * replacing Pi's encoder outright is the road not taken.
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

/** Session id = the transcript basename without its extension. */
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

/** The pre-#89 default, preserved exactly for every caller omitting `scopeOpts`
 *  (see the `discover` docstring in `../types.ts`). */
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

/** The #89 scoped path — see `DiscoveryScope`'s docstring in `../types.ts`.
 *  Pi's union arm is present here too (S2), even though it is inert today —
 *  Pi records `cwd` once, on session_start, so a tail scan never resolves a
 *  different value (see this module's own header) — kept wired in so the day
 *  Pi records per-entry `cwd` this scope starts working with no further
 *  change, exactly the existing #156 rationale. */
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

	for (const slug of projectDirs) {
		const physicalMatch = [...targetSlugs].some(variant => slug.includes(variant));
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

export const discovery: HarnessDiscovery = {
	id: ID,
	label: "Pi",

	discover(targetCwd: string | null, scopeOpts?: DiscoverScopeOptions): SessionCandidate[] {
		const root = sessionsDir();
		if (!fs.existsSync(root)) return [];

		if (!scopeOpts) {
			// Pi's policy differs from Claude's: no explicit target means every Pi
			// session, not the cwd's. Preserved from the pre-seam selector.
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
};

export default discovery;

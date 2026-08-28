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

import type { HarnessDiscovery, SessionCandidate } from "../types.ts";
import { resolveLastCwd, cwdSlugVariants } from "../session-cwd.ts";
import { buildDisplayPath } from "../../session-path-shortener.ts";

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

export const discovery: HarnessDiscovery = {
	id: ID,
	label: "Pi",

	discover(targetCwd: string | null): SessionCandidate[] {
		const root = sessionsDir();
		if (!fs.existsSync(root)) return [];

		// Pi's policy differs from Claude's: no explicit target means every Pi
		// session, not the cwd's. Preserved from the pre-seam selector.
		const target = targetCwd ? path.resolve(targetCwd) : null;
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
			// Pi dir names are "--" + cwdSlug + "--", so match by containment —
			// under any encoding the slug might have been written with (#144).
			const physicalMatch =
				targetSlugs === null || targetSlugs.some(variant => slug.includes(variant));
			const files: string[] = [];
			collect(path.join(root, slug), files);

			for (const file of files) {
				if (!physicalMatch && (target === null || resolveLastCwd(file) !== target)) continue;
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

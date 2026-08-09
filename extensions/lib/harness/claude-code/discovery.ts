/**
 * @package princess-pi-packages
 * @module harness/claude-code/discovery
 * @description Where Claude Code keeps its transcripts, and how to find one
 *   whose project dir no longer matches its cwd (#156).
 *
 * Layout: ~/.claude/projects/<cwd-slug>/<session-id>.jsonl, with a `sessions/`
 * subdirectory in older installs. The slug is stamped at session start and
 * never revised, so it locates where a session *began*. The union rule below is
 * what makes a moved session reachable from where it now lives.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { HarnessDiscovery, SessionCandidate } from "../types.ts";
import { resolveLastCwd, cwdToSlug } from "../session-cwd.ts";
import { buildDisplayPath } from "../../session-path-shortener.ts";

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
	label: "Claude",

	discover(targetCwd: string | null): SessionCandidate[] {
		const root = projectsDir();
		if (!fs.existsSync(root)) return [];

		// Claude discovery has always been cwd-scoped; a null target means "no
		// explicit --dir", not "every session on the machine". That policy lives
		// here rather than in shared code so each harness keeps its own.
		const target = path.resolve(targetCwd || process.cwd());
		const targetSlug = cwdToSlug(target);

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
			const physicalMatch = slug === targetSlug;
			const files: string[] = [];
			collect(path.join(root, slug), slug, files);

			for (const file of files) {
				// Union rule: physical slug match OR resolved last-cwd match.
				// Union, not replacement — a last-cwd-only rule would DROP the
				// session filed under a repo-root slug whose cwd is a subdir,
				// which is a session the current selector does find.
				if (!physicalMatch && resolveLastCwd(file) !== target) continue;

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

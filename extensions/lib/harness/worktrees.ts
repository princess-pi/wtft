/**
 * @package princess-pi-tools
 * @module harness/worktrees
 * @description Fan a target directory out over every checkout of its git repo (#145).
 *
 * Discovery buckets transcripts by the cwd they were written from. Under the
 * worktree flow that is now standard here, one repo has many cwds — this clone
 * had 7 checkouts the day this was written — so "sessions for this directory"
 * answers a much narrower question than anyone asking it means.
 *
 * The fan-out is a *set of directories*, not a repo identity: identity is what
 * #164's first proposal tried and could not have (you cannot run git inside a
 * directory that no longer exists). This module answers only for checkouts that
 * currently exist; sessions stranded in removed ones are #164's problem, solved
 * from the transcript's own relocation history instead.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { cwdSlugVariants } from "./session-cwd.ts";

// ---
// CONSTANTS
// ---

/** git is a subprocess on the interactive path — bound it. */
const GIT_TIMEOUT_MS = 3000;

// ---
// REPO DETECTION
// ---

/**
 * Nearest ancestor of `dir` (inclusive) holding a `.git` entry, or null.
 *
 * A filesystem walk rather than `git rev-parse`, for two reasons: it is the
 * gate that must also work when git is missing, and it costs no subprocess on
 * the common path. `.git` is checked as an *entry*, not a directory — a
 * worktree's `.git` is a regular file containing a `gitdir:` pointer.
 *
 * Returning null is what stops a non-repo cwd such as `~` from fanning out at
 * all, which is an explicit requirement of #145 rather than an optimisation.
 */
export function findRepoRoot(dir: string): string | null {
	let cur = path.resolve(dir);
	for (;;) {
		try {
			if (fs.existsSync(path.join(cur, ".git"))) return cur;
		} catch {
			// Unreadable ancestor — treat as "not a repo here" and keep walking.
		}
		const parent = path.dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

/**
 * Every checkout of the repo containing `repoRoot`, main clone included, or
 * null when git could not answer (absent, erroring, timed out, or suppressed).
 *
 * Null and `[]` mean different things: null means "ask the fallback", `[]` would
 * mean "this repo genuinely has no checkouts", which cannot happen — so a git
 * that answers with no `worktree` lines is also reported as null.
 *
 * `WTFT_NO_GIT=1` short-circuits to null. It is a *test* seam, not a
 * user-facing switch: a machine without git already lands on the fallback by
 * itself, because `execFileSync` throws. Its job is to make that path
 * exercisable without uninstalling git, and it is read at call time so a test
 * can set and clear it inside one process.
 */
export function listWorktreeDirs(repoRoot: string): string[] | null {
	if (process.env.WTFT_NO_GIT === "1") return null;
	let out: string;
	try {
		out = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
	const dirs: string[] = [];
	for (const line of out.split("\n")) {
		if (!line.startsWith("worktree ")) continue;
		const dir = line.slice("worktree ".length).trim();
		if (dir) dirs.push(path.resolve(dir));
	}
	return dirs.length > 0 ? dirs : null;
}

// ---
// FAN-OUT
// ---

export interface CwdFanOut {
	/** Every directory to treat as "here". Always contains the target itself. */
	dirs: string[];
	/** Target sits inside a git repo — the precondition for any fan-out. */
	inRepo: boolean;
	/**
	 * git could not enumerate the checkouts, so slug-prefix matching stands in.
	 * Only meaningful together with `inRepo`.
	 */
	usedFallback: boolean;
	/**
	 * Slug prefixes to accept when `usedFallback`. Catches the in-tree layout
	 * (`<mainSlug>--claude-worktrees-<branch>`) from the main clone. It cannot
	 * catch the out-of-tree layout (`…-worktrees-<repo>-<branch>` is not
	 * prefixed by the main slug) nor the reverse direction — a known limit of
	 * the fallback, which is why git is the primary path.
	 */
	slugPrefixes: string[];
}

/**
 * The current branch checked out at `dir`, or null when it can't be read —
 * no git, not a repo, or a detached HEAD (`git rev-parse --abbrev-ref HEAD`
 * prints the literal string `HEAD` there, which is not a branch name).
 * `WTFT_NO_GIT=1` short-circuits to null, the same test seam {@link
 * listWorktreeDirs} uses.
 */
export function currentBranch(dir: string): string | null {
	if (process.env.WTFT_NO_GIT === "1") return null;
	try {
		const out = execFileSync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], {
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const branch = out.trim();
		return branch && branch !== "HEAD" ? branch : null;
	} catch {
		return null;
	}
}

/**
 * Every checkout of `repoRoot`'s repo, mapped to the branch it has checked
 * out — the `branch` field `git worktree list --porcelain` prints per entry,
 * stripped of its `refs/heads/` prefix. A checkout in detached HEAD carries no
 * `branch` line at all and is simply absent from the map, same as a bare
 * `worktree` entry `listWorktreeDirs` already treats as "answer unavailable".
 */
export function worktreeBranches(repoRoot: string): Map<string, string> {
	const map = new Map<string, string>();
	if (process.env.WTFT_NO_GIT === "1") return map;
	let out: string;
	try {
		out = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
			encoding: "utf8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return map;
	}
	let currentDir: string | null = null;
	for (const line of out.split("\n")) {
		if (line.startsWith("worktree ")) {
			currentDir = path.resolve(line.slice("worktree ".length).trim());
		} else if (line.startsWith("branch ") && currentDir) {
			map.set(currentDir, line.slice("branch ".length).trim().replace(/^refs\/heads\//, ""));
			currentDir = null;
		} else if (line === "") {
			currentDir = null;
		}
	}
	return map;
}

/**
 * The single checkout of `target`'s repo that has `target`'s OWN current
 * branch checked out — the `"branch"` discovery scope (#89, Ctrl+B).
 *
 * Returns null — a documented no-op the caller falls back on, never a guess —
 * whenever any step can't answer: not a repo, git unusable, a detached HEAD,
 * or (git refusing two worktrees on the same branch, so this is a defensive
 * case rather than one seen in practice) no checkout in the map reports that
 * branch at all.
 */
export function resolveBranchCheckout(target: string): string | null {
	const root = findRepoRoot(target);
	if (!root) return null;
	const branch = currentBranch(target);
	if (!branch) return null;
	for (const [dir, b] of worktreeBranches(root)) {
		if (b === branch) return dir;
	}
	return null;
}

/**
 * Resolve one target directory into the set of directories that share its repo.
 *
 * Symmetry is the property that matters: `git worktree list` answers the same
 * from the main clone and from any worktree, so "from the clone I see the
 * worktrees" and "from a worktree I see the clone" fall out of one rule rather
 * than two.
 */
export function fanOutCwd(target: string): CwdFanOut {
	const resolved = path.resolve(target);
	const root = findRepoRoot(resolved);
	if (!root) {
		return { dirs: [resolved], inRepo: false, usedFallback: false, slugPrefixes: [] };
	}

	const checkouts = listWorktreeDirs(root);
	if (checkouts) {
		const dirs = [...new Set([resolved, ...checkouts])];
		return { dirs, inRepo: true, usedFallback: false, slugPrefixes: [] };
	}

	return {
		dirs: [resolved],
		inRepo: true,
		usedFallback: true,
		slugPrefixes: cwdSlugVariants(resolved).map(s => s + "-"),
	};
}

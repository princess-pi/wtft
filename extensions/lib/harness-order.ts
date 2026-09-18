/**
 * @package @princess-pi/wtft
 * @module harness-order
 * @description Sticky, MRU harness ordering for the scoped picker (#89, H1–H5).
 *
 *   Read side (H1): resolves the main clone via `mainCloneDir` (git
 *   `worktree list`-based) and reads its `.wtft/config.json` directly — the
 *   SAME resolution the write side uses, so both sides agree regardless of
 *   whether the worktree layout is in-tree or out-of-tree (round 2 of this
 *   module's own design; the first cut used a plain `loadConfig` walk-up,
 *   which only reaches an in-tree worktree — see `readHarnessOrder`'s own
 *   docstring for the full story). A plain walk-up is the fallback whenever
 *   `mainCloneDir` returns null: no repo, no git, or git failing.
 *
 *   Write side (H2) needs its own code: opening a session must persist to the
 *   MAIN CLONE's `.wtft/config.json` regardless of which worktree the CLI is
 *   currently running from, and `@princess-pi/libs/config`'s `writeConfig`
 *   only ever targets `process.cwd()`'s own `.<dirName>/` — there is no
 *   "write local, but at this OTHER directory" mode. So this module resolves
 *   the main clone directly (`git worktree list --porcelain`'s first entry —
 *   the main working tree is always listed first) and writes the file itself.
 *
 *   Best-effort throughout (H2): no git, no repo, or an unwritable file simply
 *   skips the write. Sticky ordering is a convenience, never a precondition for
 *   wtft to produce a report — the same posture every other config write in
 *   this codebase already takes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { loadConfig } from "@princess-pi/libs/config";
import { WTFT_CONFIG_DIR, WTFT_CONFIG_TOOL } from "./wtft-config-dir.ts";
import { findRepoRoot, listWorktreeDirs } from "./harness/worktrees.ts";

/**
 * The main clone directory for `cwd`'s repo, or null when it can't be
 * determined — no repo, no git, or `git worktree list` returned nothing
 * (see {@link listWorktreeDirs}'s own null cases).
 */
export function mainCloneDir(cwd: string): string | null {
	const root = findRepoRoot(cwd);
	if (!root) return null;
	const worktrees = listWorktreeDirs(root);
	if (!worktrees || worktrees.length === 0) return null;
	// git's own porcelain output lists the main working tree first, always.
	return worktrees[0];
}

/**
 * The sticky harness order, most-recently-opened first.
 *
 * Resolves {@link mainCloneDir} and reads ITS `.wtft/config.json` directly —
 * the SAME resolution {@link recordHarnessOpened} writes through, `git
 * worktree list`-based rather than textual-path-based. This is round 2 of
 * H1's read side: the first cut used `loadConfig`'s plain walk-up from
 * `process.cwd()`, reasoning that a worktree living at
 * `<clone>/.claude/worktrees/<branch>/` is textually under the clone so
 * walk-up reaches it "with no special-case code". That reasoning is only
 * true of the IN-TREE layout. `worktrees.ts`'s own `CwdFanOut.slugPrefixes`
 * docstring documents a SECOND, out-of-tree layout,
 * `…-worktrees-<repo>-<branch>` — not nested under the clone at all — where
 * walk-up never reaches the clone's file: writes would succeed (H2 resolves
 * the clone via git, not via path) while reads silently returned `[]`
 * forever (pr-review round 2, Medium). Resolving both sides through
 * `mainCloneDir` removes the asymmetry instead of special-casing the second
 * layout.
 *
 * `startDir` defaults to `process.cwd()`, matching {@link recordHarnessOpened}'s
 * own default — pass `--dir`/`cwdOverride` explicitly when discovery used one,
 * for the same reason `recordHarnessOpened` takes a `cwd` parameter instead of
 * assuming the launching shell's directory.
 *
 * Falls back to the OLD walk-up read whenever `mainCloneDir` returns null
 * (no git, not a repo, or git failing), temporarily chdir-ing to `startDir`
 * and restoring it — a local `.wtft/config.json` a human placed by
 * hand still works outside a repo, which is the one case `mainCloneDir` was
 * never going to answer for. Unknown/malformed values are dropped rather than
 * thrown on; an absent or corrupt `harnessOrder` reads as `[]`, which is
 * "every harness is unseen" (H4).
 */
export function readHarnessOrder(startDir: string = process.cwd()): string[] {
	const dir = mainCloneDir(startDir);
	if (dir) {
		const file = path.join(dir, `.${WTFT_CONFIG_DIR}`, "config.json");
		try {
			if (fs.existsSync(file)) {
				const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
				if (parsed && typeof parsed === "object" && Array.isArray(parsed.harnessOrder)) {
					return parsed.harnessOrder.filter((x: unknown): x is string => typeof x === "string");
				}
			}
			return [];
		} catch {
			return []; // malformed file — same posture as recordHarnessOpened: never throw
		}
	}

	// No repo / no git — the walk-up read `mainCloneDir` cannot replace here,
	// for a hand-placed `.wtft/config.json` outside any repository.
	const original = process.cwd();
	try {
		if (path.resolve(startDir) !== original) process.chdir(startDir);
		const cfg = loadConfig(WTFT_CONFIG_TOOL, {}, WTFT_CONFIG_DIR) as { harnessOrder?: unknown };
		if (!Array.isArray(cfg.harnessOrder)) return [];
		return cfg.harnessOrder.filter((x): x is string => typeof x === "string");
	} catch {
		return [];
	} finally {
		try { if (process.cwd() !== original) process.chdir(original); } catch { /* gone — nothing to restore to */ }
	}
}

/**
 * Move `harnessId` to the front of the main clone's sticky order (H2, H3).
 * Best-effort: a failure at any step — no main clone, unreadable/unwritable
 * config — is swallowed, never thrown, matching every other config write
 * here. A readable config that is not a JSON object is left untouched and
 * not written.
 */
export function recordHarnessOpened(harnessId: string, cwd: string = process.cwd()): void {
	const dir = mainCloneDir(cwd);
	if (!dir) return;
	const file = path.join(dir, `.${WTFT_CONFIG_DIR}`, "config.json");
	// `.wtft/` can arrive with a clone, so a symlink at either level could
	// point this write at any file the user can write. Neither is followed.
	if (isSymlink(path.dirname(file)) || isSymlink(file)) return;

	let existing: Record<string, unknown> = {};
	if (fs.existsSync(file)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				existing = parsed;
			} else {
				// Valid JSON, wrong shape (an array, a scalar) — not ours to
				// guess at; refuse rather than replace it (see the malformed-file
				// arm below for why "refuse" beats "start fresh" here).
				return;
			}
		} catch {
			// MALFORMED JSON: refuse the write entirely rather than starting
			// from `{}` (pr-review, Medium). Writing `{ harnessOrder: [...] }`
			// over a file that failed to parse would SILENTLY DISCARD every
			// other setting a human or another tool had written there
			// (interval, limit, timezone, …) — sticky order being a
			// convenience is the reason to skip this write, not a reason to
			// destroy unrelated data while attempting it.
			return;
		}
	}

	const prevOrder: string[] = Array.isArray(existing.harnessOrder)
		? existing.harnessOrder.filter((x: unknown): x is string => typeof x === "string")
		: [];
	const newOrder = [harnessId, ...prevOrder.filter(id => id !== harnessId)];

	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ ...existing, harnessOrder: newOrder }, null, 2) + "\n");
	} catch {
		// Best-effort (H2) — an unwritable main clone must not block the
		// session the human actually asked for.
	}
}

function isSymlink(p: string): boolean {
	try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// ---
// GROUPING (H3–H5)
// ---

/** The minimal shape this module needs from a session candidate — just enough
 *  to group and sort, so this file does not import the harness discovery
 *  types and create a dependency cycle. */
export interface OrderableCandidate {
	harness: string;
	timestamp: number;
}

/**
 * Group `candidates` by harness (newest first within each group), then order
 * the groups by the sticky order — most-recently-opened harness first, then
 * every harness `order` doesn't name, LOWEST tier first: `knownHarnessIds`
 * order among themselves (H4), THEN — for a harness present in `candidates`
 * but absent from both `order` and `knownHarnessIds`, e.g. a caller that
 * forgot to pass one, or a genuinely unregistered id — `Map` insertion order,
 * which is candidate-discovery order and the one tier this function cannot
 * make deterministic across a filesystem re-walk. An empty harness group
 * contributes no rows at all (H5).
 *
 * @param knownHarnessIds every registered harness id, in registry order —
 *   used only to break ties among harnesses absent from `order`.
 */
export function orderByHarness<T extends OrderableCandidate>(
	candidates: readonly T[],
	order: readonly string[],
	knownHarnessIds: readonly string[] = [],
): T[] {
	const byHarness = new Map<string, T[]>();
	for (const c of candidates) {
		let list = byHarness.get(c.harness);
		if (!list) { list = []; byHarness.set(c.harness, list); }
		list.push(c);
	}
	for (const list of byHarness.values()) list.sort((a, b) => b.timestamp - a.timestamp);

	const out: T[] = [];
	const seen = new Set<string>();

	for (const id of order) {
		// `seen.has(id)` guards against a DUPLICATE in `order` itself — a
		// hand-edited or merged config.json can hold the same id twice, and
		// without this a harness's rows would render once per occurrence
		// (pr-review, Low). `readHarnessOrder` only filters by type, not
		// uniqueness, so this is the one place that enforces it.
		if (seen.has(id)) continue;
		const list = byHarness.get(id);
		if (list && list.length > 0) { out.push(...list); seen.add(id); }
	}

	// Unseen harnesses: registry order first (deterministic across runs),
	// then anything left over (an external harness the registry list omitted).
	for (const id of knownHarnessIds) {
		if (seen.has(id)) continue;
		const list = byHarness.get(id);
		if (list && list.length > 0) { out.push(...list); seen.add(id); }
	}
	for (const [id, list] of byHarness) {
		if (seen.has(id) || list.length === 0) continue;
		out.push(...list);
	}

	return out;
}

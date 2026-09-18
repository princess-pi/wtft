/**
 * @package @princess-pi/wtft
 * @module harness-order
 * @description Sticky, MRU harness ordering for the scoped picker (#89, H1–H5).
 *
 *   Read side (H1): plain `loadConfig` walk-up — the SAME mechanism every other
 *   wtft config value already uses, so an in-tree worktree reaches the main
 *   clone's `.wtft/config.json` with no special-case code, purely because a
 *   worktree lives at `<clone>/.claude/worktrees/<branch>/`, textually under
 *   the clone.
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
 * The sticky harness order, most-recently-opened first — read through the
 * standard config walk-up (H1). `loadConfig` has no directory parameter of
 * its own (it always walks up from `process.cwd()`), so a caller that needs a
 * DIFFERENT starting directory — `--dir`/`cwdOverride`, matching what
 * {@link recordHarnessOpened} writes for, or a test — passes `startDir`,
 * which temporarily `chdir`s around the read and restores the original cwd
 * afterward, even on throw. Omitted, this read silently used the launching
 * shell's cwd while `recordHarnessOpened` wrote under `--dir`'s target: two
 * different repos, so a `--dir` session's sticky order was written and never
 * seen again (pr-review, Medium). Unknown/malformed values are dropped rather
 * than thrown on; an absent or corrupt `harnessOrder` reads as `[]`, which is
 * "every harness is unseen" (H4).
 */
export function readHarnessOrder(startDir?: string): string[] {
	if (!startDir || path.resolve(startDir) === process.cwd()) {
		return readHarnessOrderHere();
	}
	const original = process.cwd();
	try {
		process.chdir(startDir);
		return readHarnessOrderHere();
	} catch {
		// Can't chdir there (doesn't exist, no permission) — read from where we
		// already are rather than throwing out of a display-only lookup.
		return readHarnessOrderHere();
	} finally {
		try { process.chdir(original); } catch { /* original dir gone — nothing to restore to */ }
	}
}

function readHarnessOrderHere(): string[] {
	const cfg = loadConfig(WTFT_CONFIG_TOOL, {}, WTFT_CONFIG_DIR) as { harnessOrder?: unknown };
	if (!Array.isArray(cfg.harnessOrder)) return [];
	return cfg.harnessOrder.filter((x): x is string => typeof x === "string");
}

/**
 * Move `harnessId` to the front of the main clone's sticky order (H2, H3).
 * Best-effort: a failure at any step — no main clone, unreadable/unwritable
 * config — is swallowed, never thrown, matching every other config write
 * here.
 */
export function recordHarnessOpened(harnessId: string, cwd: string = process.cwd()): void {
	const dir = mainCloneDir(cwd);
	if (!dir) return;
	const file = path.join(dir, ".wtft", "config.json");

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

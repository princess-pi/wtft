/**
 * Sticky, MRU harness ordering for the scoped picker.
 *   Write side needs its own code: opening a session must persist to the
 *   MAIN CLONE's `.wtft/config.json` regardless of which worktree the CLI is
 *   currently running from, and `@princess-pi/libs/config`'s `writeConfig`
 *   only ever targets `process.cwd()`'s own `.<dirName>/` — there is no
 *   "write local, but at this OTHER directory" mode. So this module resolves
 *   the main clone directly (`git worktree list --porcelain`'s first entry —
 *   the main working tree is always listed first) and writes the file itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { loadConfig } from "@princess-pi/libs/config";
import { WTFT_CONFIG_DIR, WTFT_CONFIG_TOOL } from "./wtft-config-dir.ts";
import { findRepoRoot, listWorktreeDirs } from "./harness/worktrees.ts";

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
 * Unknown/malformed values are dropped rather than
 * thrown on; an absent or corrupt `harnessOrder` reads as `[]`.
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

	// No repo / no git — walk-up for a hand-placed `.wtft/config.json` outside any repository.
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

/** Move `harnessId` to the front of the main clone's sticky order. */
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
				return;
			}
		} catch {
			// Malformed JSON: refuse rather than starting from `{}` — writing
			// `{ harnessOrder: [...] }` over a file that failed to parse would
			// silently discard every other setting written there.
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
		// Best-effort — an unwritable main clone must not block the session.
	}
}

function isSymlink(p: string): boolean {
	try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

// ---

/** The minimal shape this module needs from a session candidate — just enough
 *  to group and sort, so this file does not import the harness discovery
 *  types and create a dependency cycle. */
export interface OrderableCandidate {
	harness: string;
	timestamp: number;
}

/** Group `candidates` by harness (newest first within each group). */
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
		if (seen.has(id)) continue;
		const list = byHarness.get(id);
		if (list && list.length > 0) { out.push(...list); seen.add(id); }
	}

	// Unseen harnesses: registry order first, then anything left over.
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

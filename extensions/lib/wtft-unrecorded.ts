/** Sessions no spawn record names, listed with a tier — never summed (#128). */

import * as os from "node:os";
import * as path from "node:path";
import { deduplicateInteractions, isModelTagged, parseSessionFile, type Interaction } from "./wtft-parser.js";
import { computeSessionSummary, type TokenTotals } from "./wtft-renderer.js";
import { getDiscoveries } from "./harness/registry.js";
import { fanOutCwd } from "./harness/worktrees.js";
import type { SpawnCandidate } from "./harness/types.js";

/** How long after a command turn a launcher child may still begin. Covers a
 *  whole `pr-review` run. */
export const UNRECORDED_WINDOW_MS = 30 * 60_000;

/** Merged `[start, end]` windows, one opened by every turn that ran a command. */
export function spawnWindows(turns: Interaction[]): Array<[number, number]> {
	const starts = deduplicateInteractions(turns)
		.filter(t => t.commands.length > 0)
		.map(t => t.timestamp)
		.sort((a, b) => a - b);
	const windows: Array<[number, number]> = [];
	for (const start of starts) {
		const last = windows[windows.length - 1];
		if (last && start <= last[1]) last[1] = Math.max(last[1], start + UNRECORDED_WINDOW_MS);
		else windows.push([start, start + UNRECORDED_WINDOW_MS]);
	}
	return windows;
}

export type UnrecordedTier = "named" | "inferred";
export type UnrecordedBasis = "cwd-names-parent" | "worktree" | "tmp";

export interface UnrecordedSpawn {
	child: string;
	path: string;
	cwd: string;
	/** ISO-8601 UTC — the child's first timestamp. */
	ts: string;
	tier: UnrecordedTier;
	basis: UnrecordedBasis;
	/** NULL, never zero, when the child could not be parsed. */
	total: TokenTotals | null;
	skip?: "unreadable";
}

export interface ListUnrecordedInput {
	rootSessionId: string;
	rootCwd: string | null;
	/** The session's turns — the windows open at the ones that ran a command. */
	turns: Interaction[];
	/** Sessions whose money is already somewhere, or that someone else recorded. */
	exclude: ReadonlySet<string>;
}

function isInside(dir: string, cwd: string): boolean {
	const rel = path.relative(dir, cwd);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function tempRoots(): string[] {
	return [...new Set(["/tmp", os.tmpdir()].map(d => path.resolve(d)))];
}

// Latched per path per process, like the parser's own unreadable warnings.
const warnedUnreadable = new Set<string>();
function warnUnreadable(file: string, err: unknown): void {
	if (warnedUnreadable.has(file)) return;
	warnedUnreadable.add(file);
	process.stderr.write(
		`[wtft] WARNING: a session transcript could not be read while listing unrecorded spawns, so it may be missing from spawned.unrecorded (${file}): ${err instanceof Error ? err.message : String(err)}\n`,
	);
}

function classify(
	candidate: SpawnCandidate,
	rootSessionId: string,
	fanOut: string[],
	windows: Array<[number, number]>,
): { tier: UnrecordedTier; basis: UnrecordedBasis } | null {
	if (candidate.cwd.includes(rootSessionId)) return { tier: "named", basis: "cwd-names-parent" };
	if (candidate.launchedBy !== "program") return null;
	if (!windows.some(([start, end]) => candidate.startedAt >= start && candidate.startedAt <= end)) return null;
	const cwd = path.resolve(candidate.cwd);
	if (fanOut.some(dir => isInside(dir, cwd))) return { tier: "inferred", basis: "worktree" };
	if (tempRoots().some(dir => isInside(dir, cwd))) return { tier: "inferred", basis: "tmp" };
	return null;
}

/**
 * Sessions that look like this session's launcher children and that no
 * ledger edge accounts for. A LIST, never a claim: nothing here may be added
 * to `tree` or `total`.
 */
export function listUnrecordedSpawns(input: ListUnrecordedInput): UnrecordedSpawn[] {
	const windows = spawnWindows(input.turns);
	if (windows.length === 0) return [];
	const fanOut = input.rootCwd ? fanOutCwd(input.rootCwd).dirs.map(d => path.resolve(d)) : [];

	const listed = new Map<string, { candidate: SpawnCandidate; tier: UnrecordedTier; basis: UnrecordedBasis }>();
	for (const discovery of getDiscoveries()) {
		if (!discovery.listSpawnCandidates) continue;
		const scan = discovery.listSpawnCandidates(windows[0][0]);
		for (const { path: file, error } of scan.unreadable) warnUnreadable(file, error);
		for (const candidate of scan.candidates) {
			if (candidate.sessionId === input.rootSessionId || input.exclude.has(candidate.sessionId)) continue;
			if (listed.has(candidate.sessionId)) continue;
			const verdict = classify(candidate, input.rootSessionId, fanOut, windows);
			if (verdict) listed.set(candidate.sessionId, { candidate, ...verdict });
		}
	}

	const rows: UnrecordedSpawn[] = [];
	const foldedByARow = new Set<string>();
	for (const [id, { candidate, tier, basis }] of listed) {
		const row: UnrecordedSpawn = {
			child: id,
			path: candidate.path,
			cwd: candidate.cwd,
			ts: new Date(candidate.startedAt).toISOString(),
			tier,
			basis,
			total: null,
		};
		try {
			const parsed = parseSessionFile(candidate.path);
			const { untaggedCostUsd: _untaggedCostUsd, ...total } = computeSessionSummary(parsed).total;
			row.total = total;
			for (const interaction of deduplicateInteractions(parsed)) {
				if (!isModelTagged(interaction)) continue;
				for (const fold of interaction.claudeSubAgentFolds ?? []) foldedByARow.add(fold.id);
			}
		} catch (err) {
			warnUnreadable(candidate.path, err);
			row.skip = "unreadable";
		}
		rows.push(row);
	}
	// Its cost is inside the row that folded it; listing it again shows it twice.
	return rows
		.filter(row => !foldedByARow.has(row.child))
		.sort((a, b) => a.ts.localeCompare(b.ts));
}

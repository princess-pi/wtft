/** Sessions no spawn record names, listed with a tier — never summed. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalTranscriptPath, deduplicateInteractions, isModelTagged, parseSessionFile, type Interaction } from "./wtft-parser.js";
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
	/** This session's own transcript: a candidate's parse must never fold it. */
	rootFile?: string;
}

function isInside(dir: string, cwd: string): boolean {
	const rel = path.relative(dir, cwd);
	return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

function mtimeOf(file: string): number {
	try { return fs.statSync(file).mtimeMs; } catch { return -Infinity; }
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
		`[wtft] WARNING: a path could not be read while listing unrecorded spawns, so a session under it may be absent from spawned.unrecorded (${file}): ${err instanceof Error ? err.message : String(err)}\n`,
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
	// Outside a repo there are no worktrees, and the session's own directory is
	// not a fan-out.
	const fan = input.rootCwd ? fanOutCwd(input.rootCwd) : null;
	const fanOut = fan?.inRepo ? fan.dirs.map(d => path.resolve(d)) : [];
	const doNotFold = new Set(input.rootFile ? [canonicalTranscriptPath(input.rootFile)] : []);

	// One id in two project dirs is a moved session: its newest copy is the one
	// every other reader prices, so it alone is classified — an older copy that
	// would pass the tiers is stale.
	const newest = new Map<string, SpawnCandidate>();
	for (const discovery of getDiscoveries()) {
		if (!discovery.listSpawnCandidates) continue;
		for (const candidate of discovery.listSpawnCandidates(windows[0][0])) {
			if (candidate.sessionId === input.rootSessionId || input.exclude.has(candidate.sessionId)) continue;
			const prior = newest.get(candidate.sessionId);
			if (prior && mtimeOf(prior.path) >= mtimeOf(candidate.path)) continue;
			newest.set(candidate.sessionId, candidate);
		}
	}
	const listed = new Map<string, { candidate: SpawnCandidate; tier: UnrecordedTier; basis: UnrecordedBasis }>();
	for (const [id, candidate] of newest) {
		const verdict = classify(candidate, input.rootSessionId, fanOut, windows);
		if (verdict) listed.set(id, { candidate, ...verdict });
	}

	const rows: UnrecordedSpawn[] = [];
	const foldsOf = new Map<string, Set<string>>();
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
			const parsed = parseSessionFile(candidate.path, doNotFold);
			const { untaggedCostUsd: _untaggedCostUsd, ...total } = computeSessionSummary(parsed).total;
			row.total = total;
			for (const interaction of deduplicateInteractions(parsed)) {
				if (!isModelTagged(interaction)) continue;
				for (const fold of interaction.claudeSubAgentFolds ?? []) {
					const folds = foldsOf.get(id) ?? new Set<string>();
					folds.add(fold.id);
					foldsOf.set(id, folds);
				}
			}
		} catch (err) {
			warnUnreadable(candidate.path, err);
			row.skip = "unreadable";
		}
		rows.push(row);
	}
	// A folded row's cost is inside its folder's row. Two rows that fold each
	// other keep the one with the first path, which cannot flip between runs.
	const pathOf = new Map(rows.map(r => [r.child, r.path]));
	const folded = (row: UnrecordedSpawn) => rows.some(other =>
		other.child !== row.child
		&& foldsOf.get(other.child)?.has(row.child)
		&& (!foldsOf.get(row.child)?.has(other.child) || pathOf.get(other.child)! < row.path));
	return rows
		.filter(row => !folded(row))
		.sort((a, b) => a.ts.localeCompare(b.ts));
}

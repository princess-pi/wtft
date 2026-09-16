/**
 * @package @princess-pi/wtft
 * @module wtft-spawn-tree
 * @description Turning recorded spawn edges into money (#116, direction A).
 *   Spec: docs/spec-116-spawn-ledger.md.
 *
 *   wtft-spawn-ledger.ts owns the file; this module owns the walk. The split is
 *   deliberate: a spawner calling `wtft spawn-record` pulls in the ledger and
 *   nothing else — no transcript parsing, no pricing, no renderer — so the
 *   write path stays cheap enough that nobody is tempted to skip it.
 *
 *   THE NUMBERS HERE ARE NOT A SECOND AGGREGATION. A descendant's total comes
 *   from `computeSessionSummary`, which is what `--tokens` and `--json` use for
 *   the session's own turns, so self and descendant are computed by the same
 *   code and can be added without drift (the rule wtft-json.ts states for
 *   itself, applied across the seam).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { readSpawnLedger, type SpawnLedger } from "./wtft-spawn-ledger.js";
import { projectsDir } from "./harness/claude-code/discovery.js";
import { parseSessionFile } from "./wtft-parser.js";
import { computeSessionSummary, type TokenTotals } from "./wtft-renderer.js";

/** Bumped when the reported tree's shape changes. */
export const SPAWN_TREE_SCHEMA = "wtft/spawn-tree@1";

/**
 * Default recursion bound. A `pr-review` lens child spawns its own children, so
 * this genuinely nests; 5 is deep enough for every mechanism that exists today
 * and shallow enough that a runaway ledger cannot turn one `wtft` run into a
 * filesystem walk. The number in force is REPORTED, so a reader never has to
 * know this constant to interpret a truncated tree.
 */
export const DEFAULT_MAX_DEPTH = 5;

/** Why an edge contributed nothing. Each is a different fact, and collapsing
 *  them would hide the only one that is a bug (`unreadable`). */
export type SpawnEdgeSkip =
	/** The child's transcript is not under any project dir. */
	| "no-transcript"
	/** Found, but it could not be read or parsed. */
	| "unreadable"
	/** Already counted elsewhere in this tree (a diamond, or a cycle). */
	| "already-counted"
	/** Past `maxDepth`; the subtree below it was not walked. */
	| "depth-capped";

export interface SpawnTreeEdge {
	parent: string;
	child: string;
	mechanism: string;
	ts: string;
	label?: string;
	model?: string;
	/** 1 for a direct child of the reported session. */
	depth: number;
	resolved: boolean;
	/** The transcript this edge's cost came from, when it resolved. */
	path: string | null;
	/** NULL, never zero, when the edge contributed nothing: a zero says "this
	 *  child cost nothing", which is a claim, and the whole point of the
	 *  unattributed report is that we do not have one. */
	total: TokenTotals | null;
	skip?: SpawnEdgeSkip;
}

export interface SpawnTreeGap {
	child: string;
	mechanism: string;
	ts: string;
	label?: string;
	reason: Extract<SpawnEdgeSkip, "no-transcript" | "unreadable">;
}

export interface SpawnTree {
	schema: typeof SPAWN_TREE_SCHEMA;
	/** Sessions whose cost is in `total` — each counted exactly once. */
	descendants: number;
	edges: SpawnTreeEdge[];
	/** Edges recorded but contributing nothing because the transcript could not
	 *  be read. NOT the same as "cost zero". */
	unattributed: SpawnTreeGap[];
	/** Edges not followed because of `maxDepth`. */
	depthCapped: number;
	maxDepth: number;
	/** Ledger lines the reader could not use (see readSpawnLedger). */
	malformedLedgerLines: number;
	/** Sum over resolved descendants. */
	total: TokenTotals;
}

export interface SpawnTreeOptions {
	ledgerPath?: string;
	/** Root holding `<cwd-slug>/<session>.jsonl`. Defaults to `~/.claude/projects`. */
	projectsRoot?: string;
	maxDepth?: number;
	/** A pre-read ledger, when the caller already has one. */
	ledger?: SpawnLedger;
}

function emptyTotals(): TokenTotals {
	return { costUsd: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function addTotals(into: TokenTotals, from: TokenTotals): void {
	into.costUsd += from.costUsd;
	into.inputTokens += from.inputTokens;
	into.outputTokens += from.outputTokens;
	into.reasoningTokens += from.reasoningTokens;
	into.cacheReadTokens += from.cacheReadTokens;
	into.cacheWriteTokens += from.cacheWriteTokens;
}

/**
 * A session uuid → its transcript, by scanning the project dirs.
 *
 * The LEDGER DOES NOT RECORD THE PATH on purpose. A worktree move relocates a
 * transcript (#6) and a recorded path would rot silently; the uuid is the
 * filename wherever it lands, so a scan is the durable lookup. The scan is one
 * `existsSync` per project dir, and the dir list is read once per walk.
 */
export function resolveSessionTranscript(
	sessionId: string,
	projectDirs: string[],
): string | null {
	const name = `${sessionId}.jsonl`;
	for (const dir of projectDirs) {
		const candidate = path.join(dir, name);
		try {
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch { /* not here */ }
	}
	return null;
}

function listProjectDirs(root: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		// An absent or unreadable projects root means no child resolves, which
		// the walk reports as `no-transcript` per edge — visible, and never
		// mistaken for "the ledger was empty".
		return [];
	}
	const dirs: string[] = [];
	for (const e of entries) if (e.isDirectory()) dirs.push(path.join(root, e.name));
	return dirs;
}

/**
 * Walk the recorded lineage of one session, depth-first, counting each session
 * at most once.
 *
 * `seen` starts holding the ROOT, which is what makes a cycle terminate and
 * what stops a session being billed as its own descendant. A diamond — two
 * spawners recording the same child — hits the same guard: the money was spent
 * once, so it lands once.
 */
export function computeSpawnTree(
	rootSessionId: string,
	options: SpawnTreeOptions = {},
): SpawnTree {
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const projectsRoot = options.projectsRoot ?? projectsDir();
	const ledger = options.ledger ?? readSpawnLedger(options.ledgerPath);

	const tree: SpawnTree = {
		schema: SPAWN_TREE_SCHEMA,
		descendants: 0,
		edges: [],
		unattributed: [],
		depthCapped: 0,
		maxDepth,
		malformedLedgerLines: ledger.malformedLines,
		total: emptyTotals(),
	};

	// Nothing recorded for this session: no dir listing, no stat, no parse.
	if (!ledger.childrenOf.has(rootSessionId)) return tree;

	const projectDirs = listProjectDirs(projectsRoot);
	const seen = new Set<string>([rootSessionId]);

	const walk = (parentId: string, depth: number): void => {
		const edges = ledger.childrenOf.get(parentId);
		if (!edges) return;
		for (const edge of edges) {
			const base = {
				parent: edge.parent,
				child: edge.child,
				mechanism: edge.mechanism,
				ts: edge.ts,
				...(edge.label !== undefined ? { label: edge.label } : {}),
				...(edge.model !== undefined ? { model: edge.model } : {}),
				depth,
			};

			if (depth > maxDepth) {
				tree.depthCapped++;
				tree.edges.push({ ...base, resolved: false, path: null, total: null, skip: "depth-capped" });
				continue;
			}
			if (seen.has(edge.child)) {
				tree.edges.push({ ...base, resolved: false, path: null, total: null, skip: "already-counted" });
				continue;
			}
			seen.add(edge.child);

			const file = resolveSessionTranscript(edge.child, projectDirs);
			if (file === null) {
				tree.edges.push({ ...base, resolved: false, path: null, total: null, skip: "no-transcript" });
				tree.unattributed.push({ child: edge.child, mechanism: edge.mechanism, ts: edge.ts, ...(edge.label !== undefined ? { label: edge.label } : {}), reason: "no-transcript" });
				continue;
			}

			let total: TokenTotals;
			try {
				total = computeSessionSummary(parseSessionFile(file)).total;
			} catch {
				// A recorded child we CAN see and cannot read is the one skip
				// class that is a bug rather than a fact, so it is reported as
				// a gap with its own reason rather than folded into the others.
				tree.edges.push({ ...base, resolved: false, path: file, total: null, skip: "unreadable" });
				tree.unattributed.push({ child: edge.child, mechanism: edge.mechanism, ts: edge.ts, ...(edge.label !== undefined ? { label: edge.label } : {}), reason: "unreadable" });
				continue;
			}

			tree.descendants++;
			addTotals(tree.total, total);
			tree.edges.push({ ...base, resolved: true, path: file, total });

			walk(edge.child, depth + 1);
		}
	};

	walk(rootSessionId, 1);
	return tree;
}

/** `self + descendants`, as a value, so a consumer never adds two numbers and
 *  guesses whether it double-counted. */
export function treeTotals(self: TokenTotals, tree: SpawnTree): TokenTotals {
	const out = emptyTotals();
	addTotals(out, self);
	addTotals(out, tree.total);
	return out;
}

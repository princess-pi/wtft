/** Turning recorded spawn edges into money. */

import { readSpawnLedger, type SpawnLedger } from "./wtft-spawn-ledger.js";
import { getDiscoveries } from "./harness/registry.js";
import { parseSessionFile, deduplicateInteractions, isModelTagged, type Interaction } from "./wtft-parser.js";
import { computeSessionSummary, emptyTotals, type TokenTotals } from "./wtft-renderer.js";
import { IDLE_THRESHOLD_MS } from "./wtft-daemon-lib.js";
import { listUnrecordedSpawns, type UnrecordedSpawn } from "./wtft-unrecorded.js";
import * as fs from "node:fs";

export const SPAWN_TREE_SCHEMA = "wtft/spawn-tree@3";

/**
 * Default recursion bound. A `pr-review` lens child spawns its own children, so
 * this genuinely nests; 5 is deep enough for every mechanism that exists today.
 */
export const DEFAULT_MAX_DEPTH = 5;

/** Why an edge contributed nothing. Each is a different fact, and collapsing
 *  them would hide the only one that is a bug (`unreadable`). */
export type SpawnEdgeSkip =
	| "not-found"
	/** Found, but it could not be read or parsed. THE ONLY SKIP THAT IS A BUG
	 *  rather than a fact — the others describe the ledger or the walk. */
	| "unreadable"
	/** Already counted elsewhere in this tree (a diamond, a cycle among
	 *  descendants, or a `claude -p` session a resolved descendant's parse folded
	 *  in). Its
	 *  money IS in the tree's `total`; this edge is the second way in. */
	| "already-counted"
	/** Reached before, and that visit could not read it. Distinct from
	 *  `already-counted`, which claims the money landed — here nothing did, and
	 *  the gap is already in `unattributed` under the first edge. */
	| "already-seen-unresolved"
	/** Its cost is already inside the caller's SELF total — a
	 *  `claude -p` child the parent's own turn names at any depth, a Task child
	 *  under `<session>/subagents/`, or the reported session itself, reached
	 *  round a cycle. Reported so the edge is visible, never added, because
	 *  `tree` would otherwise bill it twice. */
	| "in-self-total"
	| "depth-capped";

export interface SpawnTreeEdge {
	parent: string;
	child: string;
	mechanism: string;
	ts: string;
	label?: string;
	model?: string;
	cwd?: string;
	depth: number;
	resolved: boolean;
	/** The session file this edge names, when one was found. NOT a proxy for
	 *  `resolved`: an `unreadable` edge carries the path that failed, precisely
	 *  so a reader can go and look at it. Branch on `resolved`. */
	path: string | null;
	/** NULL, never zero, when the edge contributed nothing: a zero says "this
	 *  child cost nothing", which is a claim, and the whole point of the
	 *  unattributed report is that we do not have one. */
	total: TokenTotals | null;
	skip?: SpawnEdgeSkip;
	/** Counted edges only: the transcript grew within `IDLE_THRESHOLD_MS`, so
	 *  its total was priced mid-write and may still grow. */
	live?: boolean;
}

export interface SpawnTreeGap {
	child: string;
	mechanism: string;
	ts: string;
	label?: string;
	reason: Extract<SpawnEdgeSkip, "not-found" | "unreadable">;
}

export interface SpawnTree {
	schema: typeof SPAWN_TREE_SCHEMA;
	/** Sessions priced from their own file, each once. Fewer than `edges.length`
	 *  whenever an edge was skipped, whatever its `skip`. A session known only
	 *  through a resolved descendant's parse fold is inside that descendant's
	 *  total and is not counted here. */
	descendants: number;
	edges: SpawnTreeEdge[];
	/** Edges recorded whose cost could not be read — the lookup found nothing
	 *  (`not-found`) or found a file that would not parse (`unreadable`). Two
	 *  different causes, kept apart in `reason`. ONE ENTRY PER SESSION, not per
	 *  edge: two edges to the same missing child are one gap. NOT the same as
	 *  "cost zero". */
	unattributed: SpawnTreeGap[];
	depthCapped: number;
	maxDepth: number;
	malformedLedgerLines: number;
	/** The ledger read failed — message, or null when it was read (an ABSENT
	 *  ledger reads fine and is not an error: nothing has spawned yet). */
	ledgerError: string | null;
	/** Sum over RESOLVED descendants. A floor under any of FOUR conditions —
	 *  `unattributed` non-empty, `depthCapped` non-zero, `ledgerError` non-null,
	 *  or `malformedLedgerLines` non-zero. */
	total: TokenTotals;
	/** Sessions no ledger edge names that look like this session's children
	 *  (#128). NEVER in `total` or `tree`. Absent when the caller did not ask. */
	unrecorded?: UnrecordedSpawn[];
}

export interface SpawnTreeOptions {
	ledgerPath?: string;
	maxDepth?: number;
	/** Session ids whose cost is ALREADY in the caller's self total, so the walk
	 *  must not add them again. A thunk is called only when the root has an edge. */
	alreadyAttributed?: Set<string> | (() => Set<string>);
	now?: number;
	/** Ask for `unrecorded`. A one-shot report's cost, not a per-poll one. */
	unrecorded?: { turns: Interaction[]; rootCwd: string | null; rootFile?: string };
}

const SUBTRACT_TOLERANCE = 1e-9;

/** Subtract every numeric field of `from` from `into`. Callers subtract only a
 *  share summed from the interactions `into` was summed from, so a field
 *  cannot legitimately go negative; one that does is a bug here, and throws. */
function subtractTotals(into: TokenTotals, from: TokenTotals): void {
	for (const key of Object.keys(into) as (keyof TokenTotals)[]) {
		const next = into[key] - (from[key] ?? 0);
		if (next < -SUBTRACT_TOLERANCE) {
			throw new Error(`spawn-tree subtraction went negative on ${key} (${into[key]} - ${from[key]}): a fold share outside the total it was subtracted from`);
		}
		into[key] = Math.max(0, next);
	}
}

/** Add every numeric field of `from` into `into`.
 *  Over the KEYS, not over a hand-written list, so a field added to
 *  `TokenTotals` cannot be silently dropped as a missing addend. */
function addTotals(into: TokenTotals, from: TokenTotals): void {
	for (const key of Object.keys(into) as (keyof TokenTotals)[]) {
		into[key] += from[key] ?? 0;
	}
}

/** Each session folded into this parse's TOTAL, with the share it added. Only
 *  folds on interactions `computeSessionSummary` counts: a fold on a dropped
 *  duplicate or an untagged turn added nothing to the total. */
function foldsInTotal(parsed: Interaction[]): Map<string, TokenTotals> {
	const shares = new Map<string, TokenTotals>();
	for (const interaction of deduplicateInteractions(parsed)) {
		if (!isModelTagged(interaction)) continue;
		for (const fold of interaction.claudeSubAgentFolds ?? []) {
			const into = shares.get(fold.id) ?? emptyTotals();
			addTotals(into, fold.share);
			shares.set(fold.id, into);
		}
	}
	return shares;
}

/**
 * A session id → its session file, through the HARNESS SEAM.
 * The LEDGER DOES NOT RECORD THE PATH on purpose: a worktree move relocates a
 * session file and a recorded path would rot silently, while the id does not.
 */
export function resolveSessionFile(sessionId: string): string | null {
	for (const discovery of getDiscoveries()) {
		try {
			const found = discovery.resolveSessionById(sessionId);
			if (found) return found;
		} catch { /* a harness that cannot look is not an answer — ask the next */ }
	}
	return null;
}

/**
 * Walk the recorded lineage of one session, BREADTH-FIRST, counting each
 * session at most once.
 *
 * Breadth-first is a correctness property, not a taste: it reaches every
 * session at its MINIMUM depth.
 *
 * `outcomeOf` starts holding the ROOT as `in-self`, which is what makes a cycle
 * terminate and what stops a session being billed as its own descendant: the
 * root's money IS the self total, so an edge back to it is neither a gap nor a
 * second count.
 */
export function computeSpawnTree(
	rootSessionId: string,
	options: SpawnTreeOptions = {},
): SpawnTree {
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const now = options.now ?? Date.now();

	// The read is owned HERE, with NO way for a caller to supply its own ledger:
	// a failure becomes `ledgerError`, never an empty tree that reads as "this
	// session spawned nothing".
	let ledger: SpawnLedger;
	let ledgerError: string | null = null;
	try {
		ledger = readSpawnLedger(options.ledgerPath);
	} catch (err) {
		ledger = { childrenOf: new Map(), malformedLines: 0 };
		ledgerError = err instanceof Error ? err.message : String(err);
	}

	const tree: SpawnTree = {
		schema: SPAWN_TREE_SCHEMA,
		descendants: 0,
		edges: [],
		unattributed: [],
		depthCapped: 0,
		maxDepth,
		malformedLedgerLines: ledger.malformedLines,
		ledgerError,
		total: emptyTotals(),
	};

	const outcomeOf = walkLedger(rootSessionId, ledger, tree, options, maxDepth, now);

	if (options.unrecorded) {
		const exclude = new Set<string>(outcomeOf.keys());
		for (const edges of ledger.childrenOf.values()) for (const edge of edges) exclude.add(edge.child);
		tree.unrecorded = listUnrecordedSpawns({
			rootSessionId,
			rootCwd: options.unrecorded.rootCwd,
			turns: options.unrecorded.turns,
			rootFile: options.unrecorded.rootFile,
			exclude,
		});
	}
	return tree;
}

/** The breadth-first walk. Returns every session it reached or was told is
 *  already attributed, keyed to its outcome. */
function walkLedger(
	rootSessionId: string,
	ledger: SpawnLedger,
	tree: SpawnTree,
	options: SpawnTreeOptions,
	maxDepth: number,
	now: number,
): Map<string, string> {
	// `in-self` = money inside the caller's `total`; `folded` = a `claude -p`
	// session inside a resolved descendant's total. Both add nothing when their
	// own edge is reached, and they report different skips.
	type Outcome = "counted" | "unresolved" | "in-self" | "folded";
	const outcomeOf = new Map<string, Outcome>([[rootSessionId, "in-self"]]);
	if (!ledger.childrenOf.has(rootSessionId) && !options.unrecorded) return outcomeOf;
	// The thunk is the lazy path: called only when the root has an edge, or when
	// `unrecorded` needs the ids to exclude.
	const attributed = typeof options.alreadyAttributed === "function" ? options.alreadyAttributed() : options.alreadyAttributed;
	for (const id of attributed ?? []) outcomeOf.set(id, "in-self");
	if (!ledger.childrenOf.has(rootSessionId)) return outcomeOf;
	const visited = new Set<string>([rootSessionId]);

	type Visit = { parentId: string; depth: number };
	const queue: Visit[] = [{ parentId: rootSessionId, depth: 1 }];

	while (queue.length > 0) {
		const { parentId, depth } = queue.shift()!;
		const edges = ledger.childrenOf.get(parentId);
		if (!edges) continue;

		for (const edge of edges) {
			const base = {
				parent: edge.parent,
				child: edge.child,
				mechanism: edge.mechanism,
				ts: edge.ts,
				...(edge.label !== undefined ? { label: edge.label } : {}),
				...(edge.model !== undefined ? { model: edge.model } : {}),
				...(edge.cwd !== undefined ? { cwd: edge.cwd } : {}),
				depth,
			};

			// Seen BEFORE depth: a second edge to a session already counted is
			// not a truncation.
			const prior = outcomeOf.get(edge.child);
			if (prior !== undefined) {
				// `already-counted` claims the child's money landed. Where the
				// first visit could not read it, nothing landed — repeat THAT
				// outcome; the gap is one session, not two.
				const skip = prior === "counted" || prior === "folded" ? "already-counted" as const
					: prior === "in-self" ? "in-self-total" as const
					: "already-seen-unresolved" as const;
				tree.edges.push({ ...base, resolved: false, path: null, total: null, skip });
				// An `in-self`/`folded` id was marked without being visited —
				// only that child's OWN transcript is inside the self total; its
				// launcher children are not.
				if ((prior === "in-self" || prior === "folded") && !visited.has(edge.child)) {
					visited.add(edge.child);
					queue.push({ parentId: edge.child, depth: depth + 1 });
				}
				continue;
			}
			if (depth > maxDepth) {
				tree.depthCapped++;
				tree.edges.push({ ...base, resolved: false, path: null, total: null, skip: "depth-capped" });
				continue;
			}
			const file = resolveSessionFile(edge.child);
			if (file === null) {
				outcomeOf.set(edge.child, "unresolved");
				tree.edges.push({ ...base, resolved: false, path: null, total: null, skip: "not-found" });
				tree.unattributed.push({ child: edge.child, mechanism: edge.mechanism, ts: edge.ts, ...(edge.label !== undefined ? { label: edge.label } : {}), reason: "not-found" });
				// KEEP WALKING. Grandchildren are edges in the LEDGER, not
				// entries in the file we did not find.
				visited.add(edge.child);
				queue.push({ parentId: edge.child, depth: depth + 1 });
				continue;
			}

			let parsed: Interaction[];
			let live: boolean;
			try {
				parsed = parseSessionFile(file);
				// Stat AFTER the parse, so an append during it counts; inside the try, so a
				// transcript that cannot be stat-ed is `unreadable`, never guessed. Bounded on
				// both sides: a write mid-walk lands after `now`, a far-future mtime is not live.
				const age = now - fs.statSync(file).mtimeMs;
				live = age < IDLE_THRESHOLD_MS && age > -IDLE_THRESHOLD_MS;
			} catch {
				outcomeOf.set(edge.child, "unresolved");
				tree.edges.push({ ...base, resolved: false, path: file, total: null, skip: "unreadable" });
				tree.unattributed.push({ child: edge.child, mechanism: edge.mechanism, ts: edge.ts, ...(edge.label !== undefined ? { label: edge.label } : {}), reason: "unreadable" });
				visited.add(edge.child);
				queue.push({ parentId: edge.child, depth: depth + 1 });
				continue;
			}

			// Drop `untaggedCostUsd`: it would leak into `spawned.edges[].total`.
			const { untaggedCostUsd: _untaggedCostUsd, ...total } = computeSessionSummary(parsed).total;
			// A session this parse folded is either already in some total — take its
			// share back out — or it lands here, and a gap reported for it is closed.
			for (const [id, share] of foldsInTotal(parsed)) {
				const prior = outcomeOf.get(id);
				if (prior === "in-self" || prior === "counted" || prior === "folded") {
					subtractTotals(total, share);
					continue;
				}
				if (prior === "unresolved") tree.unattributed = tree.unattributed.filter(gap => gap.child !== id);
				outcomeOf.set(id, "folded");
			}

			tree.descendants++;
			outcomeOf.set(edge.child, "counted");
			addTotals(tree.total, total);
			tree.edges.push({ ...base, resolved: true, path: file, total, live });
			visited.add(edge.child);
			queue.push({ parentId: edge.child, depth: depth + 1 });
		}
	}

	return outcomeOf;
}

/** `self + descendants`, as a value, so a consumer never adds two numbers and
 *  guesses whether it double-counted. */
export function treeTotals(self: TokenTotals, tree: SpawnTree): TokenTotals {
	const out = emptyTotals();
	addTotals(out, self);
	addTotals(out, tree.total);
	return out;
}

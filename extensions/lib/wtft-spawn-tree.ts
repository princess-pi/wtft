/** Turning recorded spawn edges into money. */

import { readSpawnLedger, type SpawnLedger } from "./wtft-spawn-ledger.js";
import { getDiscoveries } from "./harness/registry.js";
import { parseSessionFileStrict, discoverSubagentSessionFiles, canonicalTranscriptPath, deduplicateInteractions, isModelTagged, type Interaction } from "./wtft-parser.js";
import { computeSessionSummary, emptyTotals, type TokenTotals } from "./wtft-renderer.js";
import { IDLE_THRESHOLD_MS } from "./wtft-daemon-lib.js";
import { listUnrecordedSpawns, type UnrecordedSpawn } from "./wtft-unrecorded.js";
import * as fs from "node:fs";
import * as path from "node:path";

export const SPAWN_TREE_SCHEMA = "wtft/spawn-tree@4";

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
	 *  descendants, or a `claude -p` or subagent session priced inside a resolved
	 *  descendant's total). Its money IS in the tree's `total`; this edge is the
	 *  second way in. */
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

/** A counted descendant whose own parse holds untagged turns (no model id).
 *  Their cost is outside that edge's total, as a session's own untagged cost is
 *  outside `total.costUsd`. A `claude -p` child such a turn folded is not marked
 *  folded, so its share can also be counted under that child's own edge. */
export interface SpawnTreeUntagged {
	child: string;
	untaggedInteractions: number;
	untaggedCostUsd: number;
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
	/** Never added to `total`. Non-empty makes `total` a floor. */
	descendantUntagged: SpawnTreeUntagged[];
	/** Sum over RESOLVED descendants. A floor under any of FIVE conditions —
	 *  `unattributed` non-empty, `depthCapped` non-zero, `ledgerError` non-null,
	 *  `malformedLedgerLines` non-zero, or `descendantUntagged` non-empty. */
	total: TokenTotals;
	/** Sessions no ledger edge names that look like this session's children.
	 *  NEVER in `total` or `tree`. Absent when the caller did not ask. */
	unrecorded?: UnrecordedSpawn[];
}

export interface SpawnTreeOptions {
	ledgerPath?: string;
	maxDepth?: number;
	/** Session ids whose cost is ALREADY in the caller's self total, so the walk
	 *  must not add them again; their own ledger children are walked. A thunk is
	 *  called only when the ledger holds any edge, or when `unrecorded` is asked
	 *  for. */
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
 *  duplicate or an untagged turn added nothing to the total. Keyed by the
 *  same normalised id the ledger and the walk use, so a fold id spelled with
 *  a `.jsonl` suffix still matches. */
function foldsInTotal(parsed: Interaction[]): Map<string, TokenTotals> {
	const shares = new Map<string, TokenTotals>();
	for (const interaction of deduplicateInteractions(parsed)) {
		if (!isModelTagged(interaction)) continue;
		for (const fold of interaction.claudeSubAgentFolds ?? []) {
			const id = fold.id.replace(/\.jsonl$/i, "");
			const into = shares.get(id) ?? emptyTotals();
			addTotals(into, fold.share);
			shares.set(id, into);
		}
	}
	return shares;
}

/**
 * A descendant's cost as its own SELF would hold it: its transcript plus every
 * subagent transcript discovery lists for it, each part kept apart so the walk
 * can leave out one it already counted. Whole or not at all — any part that
 * cannot be read throws, because a partial total would read as the edge's
 * whole cost. `files` is every transcript read, for the live check.
 */
function parseDescendant(file: string): { own: Interaction[]; subagents: { id: string; interactions: Interaction[] }[]; files: string[] } {
	const discovered = discoverSubagentSessionFiles(file);
	if (discovered.unreadable) throw discovered.unreadable;
	// Every part is priced at top level, so a fold of one into another is a second count.
	const doNotFold = new Set([file, ...discovered.files].map(canonicalTranscriptPath));
	return {
		own: parseSessionFileStrict(file, doNotFold),
		subagents: discovered.files.map(sub => ({ id: path.basename(sub).replace(/\.jsonl$/i, ""), interactions: parseSessionFileStrict(sub, doNotFold) })),
		files: [file, ...discovered.files],
	};
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
 * A resolver for one walk: each harness's index is built on first need and
 * kept for the resolver's life, so N children cost one tree walk per harness
 * rather than N. First harness to know an id wins, in registry order.
 *
 * An index that throws, or that is not a `Map`, fails the walk: the report
 * must not read "could not look" as "looked, found nothing". A harness with
 * no index is asked per id, and a throw there costs only that id's answer
 * from that harness.
 */
export function makeSessionResolver(): (sessionId: string) => string | null {
	const discoveries = getDiscoveries();
	const indexes: (Map<string, string> | undefined)[] = discoveries.map(() => undefined);
	const answers = new Map<string, string | null>();
	return (rawId: string) => {
		// The same normalisation every `resolveSessionById` applies.
		const sessionId = rawId.replace(/\.jsonl$/i, "");
		const known = answers.get(sessionId);
		if (known !== undefined) return known;
		let found: string | null = null;
		for (let k = 0; k < discoveries.length && found === null; k++) {
			const discovery = discoveries[k];
			if (discovery.indexSessionsById) {
				if (indexes[k] === undefined) {
					const built = discovery.indexSessionsById();
					if (!(built instanceof Map)) {
						throw new TypeError(`${discovery.id}: indexSessionsById returned ${built === null ? "null" : typeof built}, not a Map`);
					}
					indexes[k] = built;
				}
				found = indexes[k]!.get(sessionId) ?? null;
				continue;
			}
			try {
				const single = discovery.resolveSessionById(sessionId);
				found = typeof single === "string" && single ? single : null;
			} catch { /* a harness that cannot look is not an answer — ask the next */ }
		}
		answers.set(sessionId, found);
		return found;
	};
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
	// The ledger reader strips `.jsonl`; the root must match it.
	rootSessionId = rootSessionId.replace(/\.jsonl$/i, "");
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
		descendantUntagged: [],
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
	if (ledger.childrenOf.size === 0 && !options.unrecorded) return outcomeOf;
	const attributed = typeof options.alreadyAttributed === "function" ? options.alreadyAttributed() : options.alreadyAttributed;
	// Normalised the same way the ledger and the root id are: a caller may hand
	// back an id spelled with its file's `.jsonl` suffix.
	const inSelf = [...attributed ?? []].map(id => id.replace(/\.jsonl$/i, ""));
	for (const id of inSelf) outcomeOf.set(id, "in-self");
	if (![rootSessionId, ...inSelf].some(id => ledger.childrenOf.has(id))) return outcomeOf;
	const resolve = makeSessionResolver();

	// `parentsAt[d]` holds the sessions whose edges sit at depth `d`. Walked
	// level by level, and re-queued shallower when a later edge reaches a
	// session queued deeper (a fold queues two levels down), so each session's
	// edges are walked once, at its minimum depth.
	const parentsAt: string[][] = [];
	const edgeDepthOf = new Map<string, number>();
	const enqueue = (parentId: string, depth: number) => {
		if ((edgeDepthOf.get(parentId) ?? Infinity) <= depth) return;
		edgeDepthOf.set(parentId, depth);
		(parentsAt[depth] ??= []).push(parentId);
	};
	enqueue(rootSessionId, 1);
	// Only an in-self session's own transcript is inside the self total; its
	// ledger children are not. It stands where a depth-1 child would.
	for (const id of inSelf) enqueue(id, 2);

	for (let depth = 1; depth < parentsAt.length; depth++) for (const parentId of parentsAt[depth] ?? []) {
		if (edgeDepthOf.get(parentId) !== depth) continue;
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
				enqueue(edge.child, depth + 1);
				continue;
			}
			if (depth > maxDepth) {
				tree.depthCapped++;
				tree.edges.push({ ...base, resolved: false, path: null, total: null, skip: "depth-capped" });
				continue;
			}
			const file = resolve(edge.child);
			if (file === null) {
				outcomeOf.set(edge.child, "unresolved");
				tree.edges.push({ ...base, resolved: false, path: null, total: null, skip: "not-found" });
				tree.unattributed.push({ child: edge.child, mechanism: edge.mechanism, ts: edge.ts, ...(edge.label !== undefined ? { label: edge.label } : {}), reason: "not-found" });
				// KEEP WALKING. Grandchildren are edges in the LEDGER, not
				// entries in the file we did not find.
				enqueue(edge.child, depth + 1);
				continue;
			}

			let descendant: ReturnType<typeof parseDescendant>;
			let live: boolean;
			try {
				descendant = parseDescendant(file);
				// Stat AFTER the parse, so an append during it counts; inside the try, so a
				// transcript that cannot be stat-ed is `unreadable`, never guessed. Bounded on
				// both sides: a write mid-walk lands after `now`, a far-future mtime is not live.
				live = descendant.files.some(f => {
					const age = now - fs.statSync(f).mtimeMs;
					return age < IDLE_THRESHOLD_MS && age > -IDLE_THRESHOLD_MS;
				});
			} catch {
				outcomeOf.set(edge.child, "unresolved");
				tree.edges.push({ ...base, resolved: false, path: file, total: null, skip: "unreadable" });
				tree.unattributed.push({ child: edge.child, mechanism: edge.mechanism, ts: edge.ts, ...(edge.label !== undefined ? { label: edge.label } : {}), reason: "unreadable" });
				enqueue(edge.child, depth + 1);
				continue;
			}

			// Drop `untaggedCostUsd`: it would leak into `spawned.edges[].total`.
			// A subagent session already in some total is left out whole; one that
			// lands here is folded, as a `claude -p` session this parse folds is.
			const parts = [descendant.own];
			for (const sub of descendant.subagents) {
				const prior = outcomeOf.get(sub.id);
				if (prior === "in-self" || prior === "counted" || prior === "folded") continue;
				parts.push(sub.interactions);
				if (prior === "unresolved") tree.unattributed = tree.unattributed.filter(gap => gap.child !== sub.id);
				outcomeOf.set(sub.id, "folded");
				enqueue(sub.id, depth + 2);
			}
			const parsed = parts.flat();
			const summary = computeSessionSummary(parsed);
			const { untaggedCostUsd, ...total } = summary.total;
			// Each part is its own parse, so two parts can fold the same session:
			// its first share stands, and every later one comes back out.
			const folds = new Map<string, TokenTotals>();
			for (const part of parts) {
				for (const [id, share] of foldsInTotal(part)) {
					if (folds.has(id)) subtractTotals(total, share);
					else folds.set(id, share);
				}
			}
			if (summary.untaggedInteractions > 0) {
				tree.descendantUntagged.push({ child: edge.child, untaggedInteractions: summary.untaggedInteractions, untaggedCostUsd });
			}
			// A session this parse folded is either already in some total — take its
			// share back out — or it lands here, and a gap reported for it is closed.
			for (const [id, share] of folds) {
				const prior = outcomeOf.get(id);
				if (prior === "in-self" || prior === "counted" || prior === "folded") {
					subtractTotals(total, share);
					continue;
				}
				if (prior === "unresolved") tree.unattributed = tree.unattributed.filter(gap => gap.child !== id);
				outcomeOf.set(id, "folded");
				// Folded in where this child's own children stand.
				enqueue(id, depth + 2);
			}

			tree.descendants++;
			outcomeOf.set(edge.child, "counted");
			addTotals(tree.total, total);
			tree.edges.push({ ...base, resolved: true, path: file, total, live });
			enqueue(edge.child, depth + 1);
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

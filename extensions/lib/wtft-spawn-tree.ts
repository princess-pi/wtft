/**
 * @package @princess-pi/wtft
 * @module wtft-spawn-tree
 * @description Turning recorded spawn edges into money.
 *   Spec: docs/spec-116-spawn-ledger.md.
 *
 *   wtft-spawn-ledger.ts owns the file; this module owns the walk. The split is
 *   about what RUNS, not about what the bundler packs — `wtft spawn-record`
 *   ships in the same bundle as everything else, and reaches none of this: no
 *   session parsing, no pricing, no renderer. The write path stays cheap enough
 *   that nobody is tempted to skip it.
 */

import { readSpawnLedger, type SpawnLedger } from "./wtft-spawn-ledger.js";
import { getDiscoveries } from "./harness/registry.js";
import { parseSessionFile, type Interaction } from "./wtft-parser.js";
import { computeSessionSummary, emptyTotals, type TokenTotals } from "./wtft-renderer.js";

/** Bumped when the reported tree's shape changes. */
export const SPAWN_TREE_SCHEMA = "wtft/spawn-tree@1";

/**
 * Default recursion bound. A `pr-review` lens child spawns its own children, so
 * this genuinely nests; 5 is deep enough for every mechanism that exists today.
 * It bounds CHAIN LENGTH — how many generations of edge the walk will follow —
 * not total filesystem work: `resolveSessionFile` calls `resolveSessionById`
 * for every unseen edge, and the Claude Code implementation readdirs the
 * projects root and recursively collects every `.jsonl` on EACH call, and depth
 * does not bound breadth, so a ledger with many edges at one depth costs many
 * such walks regardless of this cap. The number in force is REPORTED, so a
 * reader never has to know this constant to interpret a truncated tree.
 */
export const DEFAULT_MAX_DEPTH = 5;

/** Why an edge contributed nothing. Each is a different fact, and collapsing
 *  them would hide the only one that is a bug (`unreadable`). */
export type SpawnEdgeSkip =
	/** The lookup did not find a session file for that id. Deliberately NOT
	 *  "no such file": a projects root the process cannot read produces exactly
	 *  this outcome, and the walk has no way to tell the two apart. A name that
	 *  claimed absence would be making a factual claim the run cannot make. */
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
	/** Past `maxDepth`; the subtree below it was not walked. */
	| "depth-capped";

export interface SpawnTreeEdge {
	parent: string;
	child: string;
	mechanism: string;
	ts: string;
	label?: string;
	model?: string;
	/** The cwd the spawner recorded, when it recorded one. Carried through
	 *  because it is the only thing in the ledger that tells a human WHERE a
	 *  `/tmp` sandbox child ran; resolution never uses it (see the field doc on
	 *  SpawnRecord). */
	cwd?: string;
	/** 1 for a direct child of the reported session. */
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
	/** Edges NOT FOLLOWED because of `maxDepth`. Each one is also in `edges`
	 *  with `skip: "depth-capped"`. What lies beyond them is not enumerated —
	 *  that is what a bound is — so this counts the cuts, not the sessions
	 *  behind them, and a non-zero value means the tree is known to be partial. */
	depthCapped: number;
	maxDepth: number;
	/** Ledger lines the reader could not use (see readSpawnLedger). */
	malformedLedgerLines: number;
	/** The ledger read failed — message, or null when it was read (an ABSENT
	 *  ledger reads fine and is not an error: nothing has spawned yet).
	 *
	 *  This field exists because without it an unreadable ledger produces an
	 *  empty tree that is INDISTINGUISHABLE from "read it, this session spawned
	 *  nothing" — which is the exact failure `spawned` is required-not-defaulted
	 *  to prevent one layer up. A zero that might mean "could not look" is a
	 *  silent gap. */
	ledgerError: string | null;
	/** Sum over RESOLVED descendants. A floor under any of FOUR conditions —
	 *  `unattributed` non-empty, `depthCapped` non-zero, `ledgerError` non-null,
	 *  or `malformedLedgerLines` non-zero. The last two are the traps: a ledger
	 *  that could not be read sets none of the others, so a consumer checking
	 *  only those reads a zeroed tree as a complete lineage; and a malformed
	 *  line WAS a record, so its edge is lost with the count as its only
	 *  trace. */
	total: TokenTotals;
}

export interface SpawnTreeOptions {
	/** The ledger file. Defaults to `spawnLedgerPath()`. */
	ledgerPath?: string;
	/** Recursion bound. Defaults to DEFAULT_MAX_DEPTH, and is reported back in
	 *  the result so a reader never needs this constant. */
	maxDepth?: number;
	/** Session ids whose cost is ALREADY in the caller's self total, so the walk
	 *  must not add them again. The CLI passes the `claude -p` children the
	 *  parent's own turns name and the Task children under
	 *  `<session>/subagents/` — the two mechanisms that fold a child into the
	 *  parent before this walk ever runs. The walk also treats as
	 *  self-attributed the `claude -p` sessions each member folded in, found by
	 *  resolving and parsing it; a member that cannot be resolved (a Task child)
	 *  adds nothing deeper. */
	alreadyAttributed?: Set<string>;
}

/** Subtract every numeric field of `from` from `into`, clamped at zero.
 *
 *  THE OPERANDS ARE NOT THE SAME AGGREGATION. At the only call site, `into` is
 *  the DESCENDANT's `computeSessionSummary`, and `from` is a child's own
 *  summary as stored in `countedTotals` — a different file, folded in through
 *  `parseSessionFile` / `attributeClaudeSubAgentCosts`, which is a separate
 *  summation path that is not re-run here. So the two are expected to agree,
 *  not guaranteed to, and the clamp would hide it if they did not. */
function subtractTotals(into: TokenTotals, from: TokenTotals): void {
	for (const key of Object.keys(into) as (keyof TokenTotals)[]) {
		into[key] = Math.max(0, into[key] - (from[key] ?? 0));
	}
}

/** Add every numeric field of `from` into `into`.
 *
 *  Over the KEYS, not over a hand-written list, so a field added to
 *  `TokenTotals` cannot be silently dropped as a missing addend. */
function addTotals(into: TokenTotals, from: TokenTotals): void {
	for (const key of Object.keys(into) as (keyof TokenTotals)[]) {
		into[key] += from[key] ?? 0;
	}
}

/** The `claude -p` sessions `parseSessionFile` folded into these interactions. */
function parseFoldedIds(interactions: Interaction[]): Set<string> {
	const ids = new Set<string>();
	for (const interaction of interactions) {
		const folded = (interaction as Interaction & { claudeSubAgentSessionIds?: string[] }).claudeSubAgentSessionIds;
		for (const id of folded ?? []) ids.add(id);
	}
	return ids;
}

/** `direct` plus every session id folded into any of them, at any depth. The
 *  fold is not bounded by `maxDepth`, which bounds the ledger walk only.
 *
 *  `parseSessionFile` folds a `claude -p` child's own children into the child
 *  before folding the child into its parent, but the parent's turn records only
 *  the child, so the direct set alone misses the grandchildren. */
function foldedTransitively(
	direct: Iterable<string>,
	cache: Map<string, Set<string>>,
): Set<string> {
	const out = new Set<string>();
	for (const id of direct) {
		out.add(id);
		for (const deeper of foldsOf(id, cache)) out.add(deeper);
	}
	return out;
}

/** What one session folded in, transitively. A session that cannot be resolved
 *  or read contributes no deeper ids. */
function foldsOf(sessionId: string, cache: Map<string, Set<string>>): Set<string> {
	const cached = cache.get(sessionId);
	if (cached) return cached;
	// Set before the recursion, so a cycle in the folds terminates.
	cache.set(sessionId, new Set());
	let folds = new Set<string>();
	const file = resolveSessionFile(sessionId);
	if (file !== null) {
		try {
			folds = foldedTransitively(parseFoldedIds(parseSessionFile(file)), cache);
		} catch { /* unreadable: nothing deeper is known */ }
	}
	cache.set(sessionId, folds);
	return folds;
}

/**
 * A session id → its session file, through the HARNESS SEAM.
 *
 * `HarnessDiscovery.resolveSessionById` is the repo's lookup and it already
 * knows three things a hand-rolled scan of `<root>/<slug>/<id>.jsonl` does not:
 * it recurses past the `sessions/` subdirectory older Claude Code installs use,
 * it skips the derived-data dirs, and where the same id exists in several
 * project dirs it takes the NEWEST — the moved-session case, which is exactly
 * where a stale copy would otherwise price the child.
 *
 * Every enabled harness is asked in turn, so a Pi child resolves through Pi's
 * discovery and a Claude Code child through its own.
 *
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
 * session at its MINIMUM depth. Depth-first marked a child at whatever depth
 * ledger order happened to reach it first, so a session recorded both at the
 * end of a long chain and directly under the root had its own children cut as
 * `depth-capped` although they sit two levels down — and the reported tree
 * depended on the order lines were appended in.
 *
 * `outcomeOf` starts holding the ROOT as `in-self`, which is what makes a cycle
 * terminate and what stops a session being billed as its own descendant: the
 * root's money IS the self total, so an edge back to it is neither a gap nor a
 * second count. A diamond hits the same map — the money was spent once, so it
 * lands once, and the second edge reports what happened to the first.
 */
export function computeSpawnTree(
	rootSessionId: string,
	options: SpawnTreeOptions = {},
): SpawnTree {
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

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

	// Nothing recorded for this session: no lookup, no parse.
	if (!ledger.childrenOf.has(rootSessionId)) return tree;

	// `in-self` = money inside the caller's `total`; `folded` = a `claude -p`
	// session inside a resolved descendant's total. Both add nothing when their
	// own edge is reached, and they report different skips. See the docstring.
	type Outcome = "counted" | "unresolved" | "in-self" | "folded";
	const outcomeOf = new Map<string, Outcome>([[rootSessionId, "in-self"]]);
	const foldCache = new Map<string, Set<string>>();
	for (const id of foldedTransitively(options.alreadyAttributed ?? [], foldCache)) outcomeOf.set(id, "in-self");
	/** Sessions whose own edges have been queued. */
	const visited = new Set<string>([rootSessionId]);
	/** What each counted session contributed, so a descendant that ALSO folds it
	 *  in can have it subtracted back out. Without this the guard is
	 *  order-dependent: it catches a folded child the walk has not reached yet
	 *  and misses one the walk reached first. */
	const countedTotals = new Map<string, TokenTotals>();

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
			// not a truncation, and counting it as one reported a complete tree
			// as partial.
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

			let total: TokenTotals;
			try {
				// Parse once: for the cost, and for ids the parse itself folded
				// in. If a folded child is ALSO a ledger edge, it would be
				// counted twice — each descendant needs its own guard.
				const parsed = parseSessionFile(file);
				// Drop `untaggedCostUsd`: a direct assignment would leak it into
				// `spawned.edges[].total` / `countedTotals`. See subtractTotals.
				const { untaggedCostUsd: _untaggedCostUsd, ...cleanTotal } = computeSessionSummary(parsed).total;
				total = cleanTotal;
				for (const id of foldedTransitively(parseFoldedIds(parsed), foldCache)) {
					const already = countedTotals.get(id);
					if (already) {
						// Reached as its own edge first; take it back out rather
						// than adding twice. Operands are not the same aggregation
						// — see subtractTotals.
						subtractTotals(total, already);
					} else if (!outcomeOf.has(id)) {
						outcomeOf.set(id, "folded");
					}
				}
			} catch {
				// Seen but unreadable — the one skip class that is a bug.
				outcomeOf.set(edge.child, "unresolved");
				tree.edges.push({ ...base, resolved: false, path: file, total: null, skip: "unreadable" });
				tree.unattributed.push({ child: edge.child, mechanism: edge.mechanism, ts: edge.ts, ...(edge.label !== undefined ? { label: edge.label } : {}), reason: "unreadable" });
				visited.add(edge.child);
				queue.push({ parentId: edge.child, depth: depth + 1 });
				continue;
			}

			tree.descendants++;
			outcomeOf.set(edge.child, "counted");
			countedTotals.set(edge.child, { ...total });
			addTotals(tree.total, total);
			tree.edges.push({ ...base, resolved: true, path: file, total });
			visited.add(edge.child);
			queue.push({ parentId: edge.child, depth: depth + 1 });
		}
	}

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

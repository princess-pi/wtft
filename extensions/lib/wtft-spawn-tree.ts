/**
 * @package @princess-pi/wtft
 * @module wtft-spawn-tree
 * @description Turning recorded spawn edges into money (#116, direction A).
 *   Spec: docs/spec-116-spawn-ledger.md.
 *
 *   wtft-spawn-ledger.ts owns the file; this module owns the walk. The split is
 *   about what RUNS, not about what the bundler packs — `wtft spawn-record`
 *   ships in the same bundle as everything else, and reaches none of this: no
 *   session parsing, no pricing, no renderer. The write path stays cheap enough
 *   that nobody is tempted to skip it.
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
import { computeSessionSummary, emptyTotals, type TokenTotals } from "./wtft-renderer.js";

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
	/** No session file by that uuid under any project dir. */
	| "no-session-file"
	/** Found, but it could not be read or parsed. THE ONLY SKIP THAT IS A BUG
	 *  rather than a fact — the others describe the ledger or the walk. */
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
	/** The cwd the spawner recorded, when it recorded one. Carried through
	 *  because it is the only thing in the ledger that tells a human WHERE a
	 *  `/tmp` sandbox child ran; resolution never uses it (see the field doc on
	 *  SpawnRecord). Dropped silently by the first version of this walk. */
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
	reason: Extract<SpawnEdgeSkip, "no-session-file" | "unreadable">;
}

export interface SpawnTree {
	schema: typeof SPAWN_TREE_SCHEMA;
	/** Sessions whose cost is in `total` — each counted exactly once. Fewer than
	 *  `edges.length` whenever an edge was skipped: unresolved, already counted
	 *  elsewhere in this tree, or past the depth cap. */
	descendants: number;
	edges: SpawnTreeEdge[];
	/** Edges recorded whose cost could not be read — either no session file by
	 *  that uuid exists (`no-session-file`) or one does and could not be parsed
	 *  (`unreadable`). Two different causes, kept apart in `reason`. NOT the
	 *  same as "cost zero". */
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
	 *  to prevent one layer up. A zero that might mean "could not look" is the
	 *  silent gap #116 is about, reintroduced inside #116's own fix. */
	ledgerError: string | null;
	/** Sum over resolved descendants. */
	total: TokenTotals;
}

export interface SpawnTreeOptions {
	/** The ledger file. Defaults to `spawnLedgerPath()`. */
	ledgerPath?: string;
	/** Root holding `<cwd-slug>/<session>.jsonl`, ONE level deep. Defaults to
	 *  `projectsDir()`, which honours `WTFT_CLAUDE_PROJECTS_DIR`. */
	projectsRoot?: string;
	/** Recursion bound. Defaults to DEFAULT_MAX_DEPTH, and is reported back in
	 *  the result so a reader never needs this constant. */
	maxDepth?: number;
}

/** Add every numeric field of `from` into `into`.
 *
 *  Over the KEYS, not over a hand-written list: the list version dropped a
 *  seventh field the day `TokenTotals` grew one, silently and with no test to
 *  catch it, because a missing addend looks exactly like a zero. */
function addTotals(into: TokenTotals, from: TokenTotals): void {
	for (const key of Object.keys(into) as (keyof TokenTotals)[]) {
		into[key] += from[key] ?? 0;
	}
}

/**
 * A session uuid → its session file, by scanning the project dirs.
 *
 * The LEDGER DOES NOT RECORD THE PATH on purpose. A worktree move relocates a
 * session file (#6) and a recorded path would rot silently; the uuid is the
 * filename wherever it lands, so a scan is the durable lookup. The scan is one
 * `statSync` per project dir — not `existsSync`, which a DIRECTORY named
 * `<uuid>.jsonl` would satisfy — and the dir list is read once per walk.
 *
 * ONE LEVEL, deliberately: a launcher-spawned session is a top-level session in
 * its own project dir. A Task-tool child under `<session>/subagents/` is a
 * different mechanism with its own discovery (#82/#83) and is not reachable
 * here — it would be double-counted if it were.
 */
export function resolveSessionFile(
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
		// the walk reports as `no-session-file` per edge — visible, and never
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

	// The read is owned HERE, with NO way for a caller to supply its own ledger.
	// Two earlier shapes both reintroduced the bug this function exists to fix:
	// a caller-side try/catch pushed the decision onto each surface (the CLI
	// warned on stderr, the Pi widget could not, and the document showed an
	// empty tree either way), and an injectable `ledger` option let one caller
	// emit `ledgerError: null` for a ledger nobody had opened — which is the
	// "empty is indistinguishable from unread" failure, wearing this fix's own
	// field as a disguise.
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
				...(edge.cwd !== undefined ? { cwd: edge.cwd } : {}),
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

			const file = resolveSessionFile(edge.child, projectDirs);
			if (file === null) {
				tree.edges.push({ ...base, resolved: false, path: null, total: null, skip: "no-session-file" });
				tree.unattributed.push({ child: edge.child, mechanism: edge.mechanism, ts: edge.ts, ...(edge.label !== undefined ? { label: edge.label } : {}), reason: "no-session-file" });
				// KEEP WALKING. A child we cannot read may still have recorded
				// children of its own, and those may be perfectly readable —
				// dropping the subtree with the parent loses real, resolvable
				// money over a missing file. Its grandchildren are edges in the
				// ledger, not entries in a file we failed to open.
				walk(edge.child, depth + 1);
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
				walk(edge.child, depth + 1);  // same reason as the arm above
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

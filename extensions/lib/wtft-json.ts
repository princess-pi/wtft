/**
 * @package @princess-pi/wtft
 * @module wtft-json
 * @description `wtft --json` — the machine-readable session summary (#26).
 *   Spec: docs/spec-26-json.md.
 *
 *   This module SERIALISES; it does not aggregate. Every number here comes from
 *   `computeSessionSummary` in wtft-renderer.ts, which is also what the rendered
 *   `--tokens` table formats. A second aggregation written for this path is the
 *   exact drift the issue exists to prevent, so there is none. That holds for
 *   `spawned` too (#116): the walk gives each descendant's total to the same
 *   `computeSessionSummary`, so there is no second aggregation.
 *
 *   `tree` is NOT a plain addition of two of those results, and an earlier
 *   version of this paragraph said it was. `computeSpawnTree` also runs
 *   `subtractTotals`, clamped at zero, whenever a descendant folds in a session
 *   already counted — arithmetic performed outside the aggregation. The
 *   guarantee that survives is the one that matters: nothing here counts a turn
 *   a second way. The guarantee that does not is "addition only".
 *
 *   Field names and exit codes are versioned API; the strings inside
 *   `notices[].text` are prose and may be reworded freely. A consumer branches
 *   on `notices[].code`.
 */

import { computeSessionSummary, type ModelTotals, type CategoryTotals, type TokenTotals, type SessionTotal } from "./wtft-renderer.js";
import { treeTotals, type SpawnTree } from "./wtft-spawn-tree.js";
import type { Interaction } from "./wtft-shared.js";
import type { UncountedBillables, SubagentMeta } from "./wtft-parser.ts";
import type { TagProvisional } from "./wtft-daemon-lib.js";

/** Bumped when a top-level key is ADDED or changes shape. Prose never bumps it.
 *
 *  A consumer pins this string to know which keys it may rely on; the per-key
 *  contract is docs/spec-26-json.md. `@4` (#89, #119) adds `total.untaggedCostUsd`
 *  — a NESTED key, and Amendment 1's own "adding keys is the documented bump
 *  condition" applies just as much one level down (Duppy, 2026-09-18, answer Y). */
export const WTFT_JSON_SCHEMA = "wtft/session@4";

/**
 * A human-facing sentence that would otherwise have gone to stdout.
 *
 * `code` is the contract; `text` is disposable prose. Kept as a pair rather
 * than dropping the prose entirely because a consumer relaying to a human
 * should not have to re-invent the sentence, and reading it off stderr means
 * correlating two streams.
 */
export interface WtftNotice {
	// "auto-selected-session" was retired in `@4` (#89, Amendment 3): with no
	// interactive terminal, wtft no longer auto-picks the newest session — see
	// EXIT_SESSION_AMBIGUOUS in bin/wtft.ts.
	code: "pending-session" | "no-data" | "unpriced-model" | "provisional";
	text: string;
}

export interface WtftSessionIdentity {
	/** The session .jsonl this run read. */
	path: string;
	/** Harness id claiming the transcript, or null when nothing claims it. */
	harness: string | null;
	/** WTFT_TAGGER_VERSION of the running binary. */
	taggerVersion: string;
	/** The classified tag file this run read. */
	tagPath: string;
}

export interface WtftSessionJson {
	schema: typeof WTFT_JSON_SCHEMA;
	session: WtftSessionIdentity;
	provisional: TagProvisional;
	/** SELF: this session's own turns. Unchanged by #116. Carries
	 *  `untaggedCostUsd` beside `costUsd` since `@4` (#119) — see
	 *  `SessionTotal`'s own docstring in wtft-renderer.ts for why this is a
	 *  distinct type from the `TokenTotals` every other total field reuses. */
	total: SessionTotal;
	models: ModelTotals[];
	categories: CategoryTotals[];
	uncounted: UncountedBillables;
	/** The recorded lineage (#116): every descendant reached through the spawn
	 *  ledger, each edge's provenance, and every gap the walk could not close. */
	spawned: SpawnTree;
	/** SELF + RESOLVED descendants, as a field — so a consumer never adds two
	 *  numbers and has to work out for itself whether it double-counted.
	 *
	 *  A FLOOR whenever anything went uncounted, and there are FOUR conditions,
	 *  not one: `spawned.unattributed` is non-empty, `spawned.depthCapped` is
	 *  non-zero, `spawned.ledgerError` is non-null, or
	 *  `spawned.malformedLedgerLines` is non-zero.
	 *
	 *  The last two are the traps. An unreadable ledger sets none of the others,
	 *  so a consumer checking only those reads a zeroed tree as a complete
	 *  lineage. And a malformed line WAS a record: its edge is lost, it appears
	 *  in no `unattributed` entry, and the count is the only trace of it. The
	 *  fourth condition was missing from every surface until round 5. */
	tree: TokenTotals;
	/** #137. ABSENT rather than empty whenever discovery could not give a
	 *  complete answer, so `[]` always means "looked, found none". */
	subagents?: WtftSubagentJson[];
	compaction: { events: number; tokensFreed: number };
	untaggedInteractions: number;
	notices: WtftNotice[];
}

/** One subagent transcript this session spawned — a Claude Code Task child OR a
 *  Pi `parentSession` sibling — named from the `.meta.json` where the harness
 *  wrote one. Pi siblings never have one, so they are rows with `meta: null`
 *  (#137).
 *
 *  `meta` is null wherever there is no readable meta. That null is a missing
 *  LABEL, not a missing subagent — the row is still a real subagent. It says
 *  nothing either way about whether the cost is in `total`. */
export interface WtftSubagentJson {
	/** Always present: the transcript, which is what the cost comes from. */
	transcript: string;
	/** The harness's record, or null. Only `agentType` and `spawnDepth` are
	 *  universal; see `SubagentMeta`. */
	meta: SubagentMeta | null;
}

export interface BuildSessionJsonInput {
	interactions: Interaction[];
	session: WtftSessionIdentity;
	provisional: TagProvisional;
	/** The #149 blind spot. REQUIRED, and deliberately not defaulted: a zeroed
	 *  default made "nobody scanned" indistinguishable from "scanned, found
	 *  none", which is exactly the silent blind spot this field exists to end.
	 *  The type is the enforcement — a caller with nothing to report passes
	 *  `newUncountedBillables()` and means it. (PR review, Medium/contract.) */
	uncounted: UncountedBillables;
	/** REQUIRED, and deliberately not defaulted, for the same reason `uncounted`
	 *  is (#149): an empty tree defaulted in would make "nobody read the spawn
	 *  ledger" indistinguishable from "read it, this session spawned nothing" —
	 *  and the first of those is exactly the silent gap #116 exists to end. A
	 *  caller with nothing to report passes an empty `computeSpawnTree` result
	 *  and means it. */
	spawned: SpawnTree;
	/** #137. Omitted (not `[]`) whenever discovery could not give a complete
	 *  answer, for the same reason `uncounted` is not defaulted: `[]` from a
	 *  caller that did not look is indistinguishable from a session with no
	 *  subagents. `buildSessionJson` emits the key only when it is given one. */
	subagents?: WtftSubagentJson[];
	notices?: WtftNotice[];
}

/** Build the `wtft/session@4` document. Pure: no I/O, no clock, no process state. */
export function buildSessionJson(input: BuildSessionJsonInput): WtftSessionJson {
	const summary = computeSessionSummary(input.interactions);
	return {
		// KEY ORDER IS THE WIRE ORDER — `renderSessionJson` is a bare
		// JSON.stringify, so this literal is what a reader sees. It matches the
		// example in docs/spec-26-json.md and the interface above, deliberately:
		// three orders for one document is three chances to describe it wrong.
		schema: WTFT_JSON_SCHEMA,
		session: input.session,
		provisional: input.provisional,
		total: summary.total,
		models: summary.models,
		categories: summary.categories,
		uncounted: input.uncounted,
		spawned: input.spawned,
		tree: treeTotals(summary.total, input.spawned),
		...(input.subagents ? { subagents: input.subagents } : {}),
		compaction: summary.compaction,
		untaggedInteractions: summary.untaggedInteractions,
		notices: input.notices ?? [],
	};
}

/**
 * The bytes that go to stdout: one object, one trailing newline, nothing else.
 *
 * Deliberately NOT pretty-printed. The reader is a program; indentation is
 * tokens an agent pays for and `jq` adds back for free when a human wants it.
 */
export function renderSessionJson(doc: WtftSessionJson): string {
	return JSON.stringify(doc) + "\n";
}

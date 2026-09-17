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

import { computeSessionSummary, type ModelTotals, type CategoryTotals, type TokenTotals } from "./wtft-renderer.js";
import { treeTotals, type SpawnTree } from "./wtft-spawn-tree.js";
import type { Interaction } from "./wtft-shared.js";
import type { UncountedBillables, SubagentMeta } from "./wtft-parser.ts";
import type { TagProvisional } from "./wtft-daemon-lib.js";

/** Bumped when any key below changes shape. Prose changes never bump it.
 *
 *  `@2` (#116) added `spawned` and `tree`, and pinned what `total` has always
 *  meant: THIS SESSION'S OWN TURNS. Not one dollar moved into or out of it —
 *  the launcher-spawned descendants arrive as a new, named quantity beside it,
 *  because a number a reader has never seen before must arrive labelled rather
 *  than folded into one they already trust. */
export const WTFT_JSON_SCHEMA = "wtft/session@3";

/**
 * A human-facing sentence that would otherwise have gone to stdout.
 *
 * `code` is the contract; `text` is disposable prose. Kept as a pair rather
 * than dropping the prose entirely because a consumer relaying to a human
 * should not have to re-invent the sentence, and reading it off stderr means
 * correlating two streams.
 */
export interface WtftNotice {
	code: "pending-session" | "no-data" | "unpriced-model" | "provisional" | "auto-selected-session";
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
	/** #137, and ABSENT rather than empty when discovery did not run. */
	subagents?: WtftSubagentJson[];
	session: WtftSessionIdentity;
	provisional: TagProvisional;
	/** SELF: this session's own turns. Unchanged by #116. */
	total: TokenTotals;
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
	compaction: { events: number; tokensFreed: number };
	untaggedInteractions: number;
	notices: WtftNotice[];
}

/** One subagent transcript this session spawned — a Claude Code Task child OR a
 *  Pi `parentSession` sibling — named from the `.meta.json` where the harness
 *  wrote one. Pi siblings never have one, so they are rows with `meta: null`
 *  (#137).
 *
 *  `meta` is null wherever there is no readable meta — a Pi child, a
 *  shell-spawned child, a harness release that stopped writing the file. That
 *  null is a GAP, not an absence of cost: the transcript is still counted, it
 *  simply has no label. A consumer that treats null as "no subagent" is reading
 *  it wrong, which is why the transcript path is always present and the meta is
 *  the optional half. */
export interface WtftSubagentJson {
	/** Always present: the transcript, which is what the cost comes from. */
	transcript: string;
	/** The harness's record, or null. `model` inside it is itself optional —
	 *  437 of 493 files on this host carry one. Only `agentType` and
	 *  `spawnDepth` are universal (493/493); `description` and `toolUseId` are
	 *  absent on the 48 Dynamic Workflow children. */
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
	/** #137. Omitted (not `[]`) by a caller that did not look, for the same
	 *  reason `uncounted` is not defaulted: an empty array from a caller that
	 *  never ran discovery is indistinguishable from a session with no
	 *  subagents. `buildSessionJson` emits the key only when it is given one. */
	subagents?: WtftSubagentJson[];
	notices?: WtftNotice[];
}

/** Build the `wtft/session@3` document. Pure: no I/O, no clock, no process state. */
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
		compaction: summary.compaction,
		untaggedInteractions: summary.untaggedInteractions,
		...(input.subagents ? { subagents: input.subagents } : {}),
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

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
 *   `computeSessionSummary`, and `tree` is an addition of two of its results,
 *   not a third way of counting.
 *
 *   Field names and exit codes are versioned API; the strings inside
 *   `notices[].text` are prose and may be reworded freely. A consumer branches
 *   on `notices[].code`.
 */

import { computeSessionSummary, type ModelTotals, type CategoryTotals, type TokenTotals } from "./wtft-renderer.js";
import { treeTotals, type SpawnTree } from "./wtft-spawn-tree.js";
import type { Interaction } from "./wtft-shared.js";
import type { UncountedBillables } from "./wtft-parser.ts";
import type { TagProvisional } from "./wtft-daemon-lib.js";

/** Bumped when any key below changes shape. Prose changes never bump it.
 *
 *  `@2` (#116) added `spawned` and `tree`, and pinned what `total` has always
 *  meant: THIS SESSION'S OWN TURNS. Not one dollar moved into or out of it —
 *  the launcher-spawned descendants arrive as a new, named quantity beside it,
 *  because a number a reader has never seen before must arrive labelled rather
 *  than folded into one they already trust. */
export const WTFT_JSON_SCHEMA = "wtft/session@2";

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
	 *  numbers and has to work out for itself whether it double-counted. An
	 *  unattributed child is in neither addend; `spawned.unattributed` is how
	 *  a reader knows this number is a floor. */
	tree: TokenTotals;
	compaction: { events: number; tokensFreed: number };
	untaggedInteractions: number;
	notices: WtftNotice[];
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
	notices?: WtftNotice[];
}

/** Build the `wtft/session@2` document. Pure: no I/O, no clock, no process state. */
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

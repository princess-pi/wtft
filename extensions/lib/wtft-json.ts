/**
 * `wtft --json` — serialises; does not aggregate.
 * Spec: docs/spec-26-json.md.
 *
 * Every number comes from `computeSessionSummary` in wtft-renderer.ts, the same
 * aggregation the `--tokens` table formats. `tree` is not a plain addition:
 * `computeSpawnTree` also runs `subtractTotals` when a descendant folds in a
 * session already counted. Field names and exit codes are versioned API;
 * `notices[].text` is disposable prose. A consumer branches on `notices[].code`.
 */

import { computeSessionSummary, type ModelTotals, type CategoryTotals, type TokenTotals, type SessionTotal } from "./wtft-renderer.js";
import { treeTotals, type SpawnTree } from "./wtft-spawn-tree.js";
import type { Interaction } from "./wtft-shared.js";
import type { UncountedBillables, SubagentMeta } from "./wtft-parser.ts";
import type { TagProvisional } from "./wtft-daemon-lib.js";

/** Bumped when a key is added — top-level or nested — or changes shape.
 *  Prose never bumps it. Contract: docs/spec-26-json.md. */
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
	code: "pending-session" | "no-data" | "unpriced-model" | "provisional" | "subagent-meta-unreadable";
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
	/** SELF: this session's own turns. Distinct from `TokenTotals` because it
	 *  carries `untaggedCostUsd` beside `costUsd`. */
	total: SessionTotal;
	models: ModelTotals[];
	categories: CategoryTotals[];
	uncounted: UncountedBillables;
	/** Every descendant reached through the spawn ledger, each edge's
	 *  provenance, and every gap the walk could not close. */
	spawned: SpawnTree;
	/** SELF + resolved descendants. Over the six token and cost fields only
	 *  (`untaggedCostUsd` is not carried). A floor whenever
	 *  `spawned.unattributed` is non-empty, `spawned.depthCapped` is non-zero,
	 *  `spawned.ledgerError` is non-null, or `spawned.malformedLedgerLines` is
	 *  non-zero — the last two set none of the others, so a consumer checking
	 *  only those reads a zeroed tree as a complete lineage. */
	tree: TokenTotals;
	/** Absent rather than empty whenever discovery could not give a complete
	 *  answer, so `[]` always means "looked, found none". */
	subagents?: WtftSubagentJson[];
	compaction: { events: number; tokensFreed: number };
	untaggedInteractions: number;
	notices: WtftNotice[];
}

/** One subagent transcript this session spawned. `meta` null is a missing
 *  label, not a missing subagent — the row is still real. */
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
	/** Required, not defaulted: a zeroed default made "nobody scanned"
	 *  indistinguishable from "scanned, found none". */
	uncounted: UncountedBillables;
	/** Required, not defaulted: an empty default made "nobody read the spawn
	 *  ledger" indistinguishable from "read it, spawned nothing". */
	spawned: SpawnTree;
	/** Omitted (not `[]`) whenever discovery could not give a complete answer. */
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

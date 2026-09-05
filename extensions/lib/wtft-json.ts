/**
 * @package @princess-pi/wtft
 * @module wtft-json
 * @description `wtft --json` — the machine-readable session summary (#26).
 *   Spec: docs/spec-26-json.md.
 *
 *   This module SERIALISES; it does not aggregate. Every number here comes from
 *   `computeSessionSummary` in wtft-renderer.ts, which is also what the rendered
 *   `--tokens` table formats. A second aggregation written for this path is the
 *   exact drift the issue exists to prevent, so there is none.
 *
 *   Field names and exit codes are versioned API; the strings inside
 *   `notices[].text` are prose and may be reworded freely. A consumer branches
 *   on `notices[].code`.
 */

import { computeSessionSummary, type ModelTotals, type CategoryTotals, type TokenTotals } from "./wtft-renderer.js";
import type { Interaction } from "./wtft-shared.js";
import type { UncountedBillables } from "./wtft-parser.ts";
import type { TagProvisional } from "./wtft-daemon-lib.js";

/** Bumped when any key below changes shape. Prose changes never bump it. */
export const WTFT_JSON_SCHEMA = "wtft/session@1";

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
	total: TokenTotals;
	models: ModelTotals[];
	categories: CategoryTotals[];
	uncounted: UncountedBillables;
	compaction: { events: number; tokensFreed: number };
	untaggedInteractions: number;
	notices: WtftNotice[];
}

export interface BuildSessionJsonInput {
	interactions: Interaction[];
	session: WtftSessionIdentity;
	provisional: TagProvisional;
	/** The #149 blind spot. Omitted reports a zeroed one rather than absent:
	 *  a consumer indexing `.uncounted.compaction` must never get `undefined`
	 *  because a caller skipped the scan. */
	uncounted?: UncountedBillables;
	notices?: WtftNotice[];
}

/** Build the `wtft/session@1` document. Pure: no I/O, no clock, no process state. */
export function buildSessionJson(input: BuildSessionJsonInput): WtftSessionJson {
	const summary = computeSessionSummary(input.interactions);
	return {
		schema: WTFT_JSON_SCHEMA,
		session: input.session,
		provisional: input.provisional,
		total: summary.total,
		models: summary.models,
		categories: summary.categories,
		uncounted: input.uncounted ?? { compaction: 0, recap: 0 },
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

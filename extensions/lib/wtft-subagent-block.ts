/** The built-in subagents behind TOTAL: one row each, priced from the tag
 *  file's own lines for that subagent. The money is already INSIDE TOTAL. */

import * as path from "node:path";
import { isModelTagged, type Interaction, type SubagentMeta } from "./wtft-parser.js";
import { computeSessionSummary, type TokenTotals } from "./wtft-renderer.js";
import { transcriptSourceId } from "./wtft-daemon-lib.js";

/** Rows the rendered block shows; the rest are counted on one line. */
export const SUBAGENT_ROW_LIMIT = 20;

export interface SubagentRow {
	transcript: string;
	/** The meta's `description`, else the transcript's basename. */
	label: string;
	/** The meta's `model`, or null when the harness recorded none. */
	model: string | null;
	/** What TOTAL holds for this subagent; null, never zero, when no
	 *  model-tagged line carries its source yet. */
	total: TokenTotals | null;
}

/**
 * One row per subagent, most expensive first, not-yet-tagged last. A row's
 * total is computed by the same summary TOTAL uses, over the lines whose
 * source is that subagent's — so the rows can never disagree with TOTAL.
 */
export function subagentRows(
	interactions: Interaction[],
	subagents: { transcript: string; meta: SubagentMeta | null }[],
	sessionDir: string,
): SubagentRow[] {
	const bySource = new Map<string, Interaction[]>();
	for (const interaction of interactions) {
		if (!interaction.source || !isModelTagged(interaction)) continue;
		const list = bySource.get(interaction.source);
		if (list) list.push(interaction); else bySource.set(interaction.source, [interaction]);
	}
	const rows = subagents.map(({ transcript, meta }) => {
		const lines = bySource.get(transcriptSourceId(transcript, sessionDir));
		let total: TokenTotals | null = null;
		if (lines) {
			const { untaggedCostUsd: _untagged, ...rest } = computeSessionSummary(lines).total;
			total = rest;
		}
		return {
			transcript,
			label: meta?.description || path.basename(transcript, ".jsonl"),
			model: meta?.model ?? null,
			total,
		};
	});
	return rows.sort((a, b) => {
		if (a.total === null || b.total === null) return a.total === null ? (b.total === null ? 0 : 1) : -1;
		return b.total.costUsd - a.total.costUsd;
	});
}

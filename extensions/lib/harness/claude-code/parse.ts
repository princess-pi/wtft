/**
 * @package princess-pi-tools
 * @module harness/claude-code/parse
 * @description Claude Code transcript schema — and nothing else (#156).
 *
 * Everything this file knows is where a field lives. What the numbers *mean*
 * (pricing, cache observation, classification, the meter-split) is shared and
 * lives on the far side of the seam, so a new harness cannot get billing wrong.
 */

import type {
	AssistantTurn,
	ControlSignal,
	FileRef,
	HarnessParseAdapter,
	NormalizedUsage,
	ParsedBlock,
	UncountedBillableClass,
} from "../types.ts";

const ID = "claude-code";

/** Both marker spellings: "[Request interrupted by user]" and "… for tool use]". */
const INTERRUPT_PREFIX = "[Request interrupted by user";

function normalizeUsage(usage: any): NormalizedUsage {
	const u = usage || {};
	return {
		input_tokens: u.input_tokens || 0,
		output_tokens: u.output_tokens || 0,
		cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
		cache_read_input_tokens: u.cache_read_input_tokens || 0,
		cache_creation: u.cache_creation || null,
		reasoning_tokens: u.reasoning_tokens || 0,
		server_tool_use: u.server_tool_use || null,
		iterations: Array.isArray(u.iterations) ? u.iterations.length : undefined,
		// Claude Code does not record a per-turn cost — the shared body prices it.
		nativeCost: null,
	};
}

export const parse: HarnessParseAdapter = {
	id: ID,

	matchAssistant(entry: any): AssistantTurn | null {
		if (!entry || entry.type !== "assistant") return null;
		const message = entry.message;
		if (!message || message.role !== "assistant") return null;
		return {
			content: Array.isArray(message.content) ? message.content : [],
			messageId: message.id,
			requestId: entry.requestId,
			model: message.model,
			timestamp: message.timestamp || entry.timestamp,
			isSidechain: entry.isSidechain === true,
			usage: normalizeUsage(message.usage),
		};
	},

	readBlock(block: any): ParsedBlock | null {
		if (!block) return null;
		if (block.type === "text") return { kind: "text", text: block.text };
		if (block.type === "thinking") return { kind: "text", text: block.thinking };
		if (block.type !== "tool_use") return null;

		const name = (block.name || "").toLowerCase();
		const args = block.input || {};
		const files: FileRef[] = [];
		const commands: string[] = [];
		let handled = true;

		if (name === "read" || name === "view" || name === "glob" || name === "ls") {
			const p = args.file_path || args.path || args.directory || args.target;
			if (p) files.push({ path: p, action: "read" });
		} else if (name === "edit" || name === "write" || name === "replace") {
			const p = args.file_path || args.path || args.target;
			if (p) files.push({ path: p, action: "write" });
		} else if (name === "notebookedit") {
			// Notebook edits classify by path like any other file write (#52)
			if (args.notebook_path) files.push({ path: args.notebook_path, action: "write" });
		} else if (name === "bash" || name === "run") {
			if (args.command) commands.push(args.command);
		} else {
			handled = false;
		}

		return { kind: "tool", name, handled, files, commands };
	},

	readControlEntry(entry: any): ControlSignal | null {
		if (!entry) return null;
		// Compact summary marker → flag the next assistant interaction for the
		// compaction meter-split (#52 Phase 3).
		if (entry.isCompactSummary === true) return { kind: "after-compaction" };
		// User interrupt marker → the PRECEDING assistant turn was killed; its
		// whole cost is discarded work (#52 Phase 3). Only user-entry content
		// counts — the literal inside a tool result must not reclassify anything.
		if (entry.type === "user") {
			const c = entry.message?.content;
			const hit =
				typeof c === "string"
					? c.includes(INTERRUPT_PREFIX)
					: Array.isArray(c) &&
					  c.some((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.includes(INTERRUPT_PREFIX));
			if (hit) return { kind: "interrupt" };
		}
		return null;
	},

	readUncountedBillable(entry: any): UncountedBillableClass | null {
		if (!entry || entry.type !== "system") return null;
		// The compaction request itself. `compact_boundary` is the ONLY entry
		// Claude Code writes for it; the paired `isCompactSummary` user entry
		// carries the summary text. Neither has a `usage` object — deliberately
		// read from the boundary rather than the summary so one compaction
		// counts once (#149).
		if (entry.subtype === "compact_boundary") return "compaction";
		// The "while you were away" recap. Also billed, also usage-free.
		if (entry.subtype === "away_summary") return "recap";
		return null;
	},
};

export default parse;

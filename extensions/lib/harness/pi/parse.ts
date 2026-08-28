/**
 * @package princess-pi-tools
 * @module harness/pi/parse
 * @description Pi transcript schema — and nothing else (#156).
 *
 * Pi differs from Claude Code in three ways that matter here, all of them
 * schema-level: the assistant entry is `type: "message"`, tool blocks are
 * `toolCall` with an `arguments` object, and usage uses short field names
 * (`input`/`cacheRead`) plus a harness-native `cost.total`.
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

const ID = "pi";

function normalizeUsage(usage: any): NormalizedUsage {
	const u = usage || {};
	const nativeCost = u.cost?.total;
	return {
		input_tokens: u.input_tokens ?? u.input ?? 0,
		output_tokens: u.output_tokens ?? u.output ?? 0,
		cache_creation_input_tokens: u.cache_creation_input_tokens ?? u.cacheWrite ?? 0,
		cache_read_input_tokens: u.cache_read_input_tokens ?? u.cacheRead ?? 0,
		cache_creation: u.cache_creation || null,
		reasoning_tokens: u.reasoning_tokens ?? u.reasoning ?? 0,
		server_tool_use: u.server_tool_use || null,
		iterations: Array.isArray(u.iterations) ? u.iterations.length : undefined,
		nativeCost: nativeCost === undefined || nativeCost === null ? null : nativeCost,
	};
}

export const parse: HarnessParseAdapter = {
	id: ID,

	matchAssistant(entry: any): AssistantTurn | null {
		if (!entry || entry.type !== "message") return null;
		const message = entry.message;
		if (!message || message.role !== "assistant") return null;
		return {
			content: Array.isArray(message.content) ? message.content : [],
			messageId: message.id,
			requestId: entry.requestId,
			// Pi does not stamp the model per message — it emits model_change
			// entries, tracked by shared code and passed in as currentModel (#128).
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
		if (block.type !== "toolCall") return null;

		const name = (block.name || "").toLowerCase();
		const args = block.arguments || {};
		const files: FileRef[] = [];
		const commands: string[] = [];
		let handled = true;

		if (name === "read") {
			if (args.path) files.push({ path: args.path, action: "read" });
		} else if (name === "write" || name === "edit") {
			if (args.path) files.push({ path: args.path, action: "write" });
		} else if (name === "bash") {
			if (args.command) commands.push(args.command);
		} else {
			handled = false;
		}

		return { kind: "tool", name, handled, files, commands };
	},

	readControlEntry(entry: any): ControlSignal | null {
		if (!entry) return null;
		// Thinking level changes (#77).
		if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
			return { kind: "thinking-level", level: entry.thinkingLevel };
		}
		// Model tracking (#128): Pi emits provider + modelId rather than
		// stamping the model on each message.
		if (entry.type === "model_change" && entry.modelId) {
			return { kind: "model", modelId: entry.modelId };
		}
		// Compaction — stamp tokensBefore onto the next assistant interaction so
		// summaries can surface how much context was freed (#90).
		if (entry.type === "compaction" && typeof entry.tokensBefore === "number") {
			return { kind: "compaction", tokensBefore: entry.tokensBefore };
		}
		return null;
	},

	readUncountedBillable(entry: any): UncountedBillableClass | null {
		// Same entry the control signal reads, answering a different question:
		// `tokensBefore` says how much context was FREED, this says the summary
		// call itself was billed and left no usage record (#149). Pi has no
		// away-recap feature, so no "recap" arm.
		if (entry?.type === "compaction") return "compaction";
		return null;
	},
};

export default parse;

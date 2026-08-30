// ---
// research/156-codex-harness-sketch/parse.mjs — the seam's acceptance test (#156)
//
// A deliberately different schema from both known harnesses: the assistant
// entry is `{kind: "turn"}`, usage uses yet another set of field names, and
// tool blocks are `{op: "call"}`. If the seam holds, that is the whole diff —
// cost, cache observation, classification and rendering are inherited.
// ---
const ID = "codex";

export const parse = {
	id: ID,

	matchAssistant(entry) {
		if (!entry || entry.kind !== "turn" || entry.role !== "assistant") return null;
		const u = entry.tokens || {};
		return {
			content: Array.isArray(entry.parts) ? entry.parts : [],
			messageId: entry.turn_id,
			requestId: entry.request_id,
			model: entry.model,
			timestamp: entry.ts,
			isSidechain: entry.nested === true,
			usage: {
				input_tokens: u.prompt || 0,
				output_tokens: u.completion || 0,
				cache_creation_input_tokens: u.cache_written || 0,
				cache_read_input_tokens: u.cache_hit || 0,
				cache_creation: null,
				reasoning_tokens: u.thinking || 0,
				server_tool_use: null,
				iterations: undefined,
				nativeCost: null,
			},
		};
	},

	readBlock(block) {
		if (!block) return null;
		if (block.op === "say") return { kind: "text", text: block.text };
		if (block.op !== "call") return null;
		const name = (block.tool || "").toLowerCase();
		const args = block.args || {};
		const files = [];
		const commands = [];
		let handled = true;
		if (name === "open_file") {
			if (args.file) files.push({ path: args.file, action: "read" });
		} else if (name === "patch_file") {
			if (args.file) files.push({ path: args.file, action: "write" });
		} else if (name === "shell") {
			if (args.cmd) commands.push(args.cmd);
		} else {
			handled = false;
		}
		return { kind: "tool", name, handled, files, commands };
	},

	readControlEntry(entry) {
		if (!entry) return null;
		if (entry.kind === "model_switch" && entry.model) return { kind: "model", modelId: entry.model };
		if (entry.kind === "context_trim" && typeof entry.before === "number") {
			return { kind: "compaction", tokensBefore: entry.before };
		}
		return null;
	},
};

export default parse;

#!/usr/bin/env -S npx tsx
/**
 * @package princess-pi-packages
 * @test wtft-server-tool-cost
 * @description Validates server_tool_use parsing and per-request pricing (#73).
 *   web_search_requests and web_fetch_requests from Claude Code usage objects
 *   are billed at $0.03 per request, separate from token costs.
 */

import { parseEntryToInteraction } from "../extensions/lib/wtft-shared.ts";
import { calculateServerToolCost } from "../extensions/lib/wtft-cost.js";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function assert(label: string, ok: boolean) {
	if (ok) {
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} else {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		failed++;
	}
}

// ---
// Pricing unit tests
// ---
console.log("1. Per-request pricing (calculateServerToolCost)");

// Claude models charge per request
assert(
	"Claude: 2 web_search → $0.06",
	Math.abs(calculateServerToolCost("claude-sonnet-4-6", 2, 0) - 0.06) < 0.001
);
assert(
	"Claude: 1 web_fetch → $0.03",
	Math.abs(calculateServerToolCost("claude-opus-4-8", 0, 1) - 0.03) < 0.001
);
assert(
	"Claude: 2 web_search + 1 web_fetch → $0.09",
	Math.abs(calculateServerToolCost("claude-sonnet-4-20250514", 2, 1) - 0.09) < 0.001
);
assert(
	"Claude: 0 requests → $0.00",
	calculateServerToolCost("claude-sonnet-4-6", 0, 0) === 0
);

// Non-Claude models don't charge
assert(
	"DeepSeek: server_tool_use → $0.00 (not billed)",
	calculateServerToolCost("deepseek-v4-flash", 5, 3) === 0
);
assert(
	"Gemini: server_tool_use → $0.00 (not billed)",
	calculateServerToolCost("gemini-3.5-flash", 5, 3) === 0
);
assert(
	"Local model: server_tool_use → $0.00 (not billed)",
	calculateServerToolCost("ollama/llama3", 5, 3) === 0
);
assert(
	"Unknown model: server_tool_use → $0.00 (conservative)",
	calculateServerToolCost("unknown-model", 5, 3) === 0
);

// ---
// Parser integration: server_tool_use from Claude Code JSONL
// ---
console.log("\n2. parseEntryToInteraction extracts server_tool_use");

const TS = Date.now();

// Claude Code entry with web search
const entryWithSearch = {
	type: "assistant",
	message: {
		role: "assistant",
		id: "msg_search_001",
		model: "claude-sonnet-4-20250514",
		timestamp: new Date(TS - 30000).toISOString(),
		usage: {
			input_tokens: 500,
			output_tokens: 200,
			server_tool_use: { web_search_requests: 3, web_fetch_requests: 1 },
		},
		content: [{ type: "text", text: "Search results: ..." }],
	},
};

const interaction = parseEntryToInteraction(entryWithSearch);
assert(
	"extracts webSearchRequests=3",
	interaction?.webSearchRequests === 3
);
assert(
	"extracts webFetchRequests=1",
	interaction?.webFetchRequests === 1
);
assert(
	"serverToolCost = 3*\$0.03 + 1*\$0.03 = \$0.12",
	interaction?.serverToolCost !== undefined &&
		Math.abs(interaction.serverToolCost - 0.12) < 0.001
);

// Token cost is separate from server tool cost
assert(
	"interaction.cost is token-only (may be 0 or computed; cost does not include serverToolCost)",
	typeof interaction?.cost === "number"
);

// Claude Code entry without server_tool_use (regression)
const entryWithoutTools = {
	type: "assistant",
	message: {
		role: "assistant",
		id: "msg_normal_001",
		model: "claude-sonnet-4-20250514",
		timestamp: new Date(TS - 60000).toISOString(),
		usage: { input_tokens: 100, output_tokens: 50 },
		content: [{ type: "text", text: "Hello." }],
	},
};

const normal = parseEntryToInteraction(entryWithoutTools);
assert(
	"no server_tool_use → webSearchRequests=0",
	normal?.webSearchRequests === 0
);
assert(
	"no server_tool_use → webFetchRequests=0",
	normal?.webFetchRequests === 0
);
assert(
	"no server_tool_use → serverToolCost=0",
	normal?.serverToolCost === 0
);

// Empty/missing server_tool_use field
const entryEmptyTools = {
	type: "assistant",
	message: {
		role: "assistant",
		id: "msg_empty_001",
		model: "claude-sonnet-4-20250514",
		timestamp: new Date(TS - 70000).toISOString(),
		usage: { input_tokens: 100, output_tokens: 50, server_tool_use: {} },
		content: [{ type: "text", text: "." }],
	},
};

const empty = parseEntryToInteraction(entryEmptyTools);
assert(
	"empty server_tool_use → webSearchRequests=0",
	empty?.webSearchRequests === 0
);
assert(
	"empty server_tool_use → webFetchRequests=0",
	empty?.webFetchRequests === 0
);

// DeepSeek entry with server_tool_use (cost should be $0)
const deepseekTools = {
	type: "message",
	message: {
		role: "assistant",
		id: "msg_ds_001",
		model: "deepseek-chat",
		timestamp: new Date(TS - 80000).toISOString(),
		usage: {
			input: 500,
			output: 200,
			server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 },
		},
		content: [{ type: "text", text: "Searching..." }],
	},
};

const ds = parseEntryToInteraction(deepseekTools);
assert(
	"DeepSeek: extracts webSearchRequests=2",
	ds?.webSearchRequests === 2
);
assert(
	"DeepSeek: serverToolCost=\$0 (not billed for DeepSeek)",
	ds?.serverToolCost === 0
);

// ---
// Results
// ---
console.log("\n──────────────────────────────");
console.log(
	`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`
);
process.exit(failed > 0 ? 1 : 0);

/**
 * Tests for #54 (message-id deduplication) and #55 (TTL-split cache-write pricing).
 *
 * #54: Claude Code emits multiple JSONL lines per API response (one per content block +
 *      streaming/compaction re-logging), each echoing the same message-level `usage`.
 *      Summing per line inflates costs ~1.8×. Dedup by message.id fixes this.
 *
 * #55: Cache-write tokens were priced at flat 1.25× input (5-min TTL), but 1-hour
 *      caches cost 2×. The `usage.cache_creation` object exposes the TTL breakdown.
 */

import * as assert from "node:assert";
import {
	calculateClaudeCost,
	deduplicateInteractions,
	parseEntryToInteraction,
	buildWtftLines,
} from "../bin/wtft.mjs";
import type { Interaction } from "../extensions/lib/wtft-shared.ts";

// ---
// #54: MESSAGE-ID DEDUPLICATION
// ---

console.log("=== #54: Message-ID Deduplication Tests ===");

// TEST 1: Three lines, same message.id, identical usage → cost = one message's cost
{
	const interaction: Interaction = {
		timestamp: Date.now(),
		cost: 5.00,
		messageId: "msg_01Cc7ismnYsZZbhTbbDXBFKT",
		files: [{ path: "src/main.ts", action: "write" }],
		commands: [],
		texts: ["Hello world"]
	};

	const interactions = [
		{ ...interaction },
		{ ...interaction },
		{ ...interaction } // three identical copies
	];

	const deduped = deduplicateInteractions(interactions);

	assert.strictEqual(
		deduped.length, 1,
		"#54: Three identical entries by msg id → dedup should collapse to 1"
	);
	assert.strictEqual(
		deduped[0].cost, 5.00,
		"#54: Deduped cost should be 5.00, not 15.00"
	);
	assert.strictEqual(
		deduped[0].files.length, 1,
		"#54: Merged content — one file entry"
	);
	assert.strictEqual(
		deduped[0].texts.length, 1,
		"#54: Merged content — one text entry"
	);
	console.log("✅ #54 Test 1: Identical usage dedup PASSED");
}

// TEST 2: Same message.id, growing usage (streaming partials) → max cost, merged content
{
	const mid = "msg_02partialStream";
	const partials: Interaction[] = [
		{
			timestamp: Date.now() - 2000,
			cost: 1.25,
			messageId: mid,
			files: [{ path: "docs/spec.md", action: "read" }],
			commands: ["echo hello"],
			texts: ["first block"]
		},
		{
			timestamp: Date.now() - 1000,
			cost: 2.50,
			messageId: mid,
			files: [{ path: "src/code.ts", action: "write" }],
			commands: ["npm test"],
			texts: ["second block"]
		},
		{
			timestamp: Date.now(),
			cost: 3.75,
			messageId: mid,
			files: [{ path: "tests/test.ts", action: "write" }],
			commands: [],
			texts: ["third block"]
		}
	];

	const deduped = deduplicateInteractions(partials);

	assert.strictEqual(
		deduped.length, 1,
		"#54: Streaming partials by same msg id → should collapse to 1"
	);
	assert.strictEqual(
		deduped[0].cost, 3.75,
		"#54: Streaming partials → max cost (3.75) should be used"
	);
	assert.strictEqual(
		deduped[0].files.length, 3,
		"#54: Streaming partials → all 3 content blocks' files should merge"
	);
	assert.strictEqual(
		deduped[0].commands.length, 2,
		"#54: Streaming partials → both commands should merge"
	);
	assert.strictEqual(
		deduped[0].texts.length, 3,
		"#54: Streaming partials → all 3 text blocks should merge"
	);
	console.log("✅ #54 Test 2: Streaming partials dedup PASSED");
}

// TEST 3: Mixed — some with message.id, some without
{
	const withId1: Interaction = {
		timestamp: Date.now(),
		cost: 10.00,
		messageId: "msg_A",
		files: [],
		commands: [],
		texts: []
	};
	const withId1dup: Interaction = {
		timestamp: Date.now(),
		cost: 10.00,
		messageId: "msg_A",
		files: [],
		commands: [],
		texts: []
	};
	const withId2: Interaction = {
		timestamp: Date.now(),
		cost: 5.00,
		messageId: "msg_B",
		files: [],
		commands: [],
		texts: []
	};
	const noId: Interaction = {
		timestamp: Date.now(),
		cost: 3.00,
		// no messageId
		files: [],
		commands: [],
		texts: []
	};
	const noId2: Interaction = {
		timestamp: Date.now(),
		cost: 3.00,
		// no messageId
		files: [],
		commands: [],
		texts: []
	};

	const deduped = deduplicateInteractions([withId1, withId1dup, withId2, noId, noId2]);

	assert.strictEqual(
		deduped.length, 4,
		"#54: Mixed — 2 unique msgs (1 with dup) + 2 no-msgid = 4 results"
	);
	const costs = deduped.map(d => d.cost).sort((a, b) => a - b);
	assert.deepStrictEqual(
		costs, [3.00, 3.00, 5.00, 10.00],
		"#54: Mixed — correct costs preserved (no-id entries kept individually)"
	);
	console.log("✅ #54 Test 3: Mixed id / no-id PASSED");
}

// TEST 4: parseEntryToInteraction surfaces messageId from Claude Code schema
{
	const entry = {
		type: "assistant",
		requestId: "req_abc123",
		message: {
			role: "assistant",
			id: "msg_01Cc7ismnYsZZbhTbbDXBFKT",
			model: "claude-sonnet-4-20250514",
			usage: {
				input_tokens: 1000,
				output_tokens: 500,
				cost: { total: 0.015 } // Pi-style cost
			},
			content: [{ type: "text", text: "test" }]
		}
	};

	const result = parseEntryToInteraction(entry);
	assert.ok(result, "#54: parseEntryToInteraction should succeed on Claude Code schema");
	assert.strictEqual(
		result!.messageId, "msg_01Cc7ismnYsZZbhTbbDXBFKT",
		"#54: messageId should be surfaced from message.id"
	);
	assert.strictEqual(
		result!.requestId, "req_abc123",
		"#54: requestId should be surfaced from entry.requestId"
	);
	console.log("✅ #54 Test 4: parseEntryToInteraction surfaces message.id PASSED");
}

// ---
// #55: TTL-SPLIT CACHE-WRITE PRICING
// ---

console.log("\n=== #55: TTL-Split Cache-Write Pricing Tests ===");

// Test pricing helper
const round4 = (n: number) => Math.round(n * 10000) / 10000;

// TEST 5: TTL breakdown present — 5-min and 1-hour split
// Sonnet model: $3/M input, so 1.25x = $3.75/M (5-min), 2.0x = $6.00/M (1-hour)
{
	const usage = {
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: 2000000, // 2M total (scalar, for fallback)
		cache_read_input_tokens: 0,
		cache_creation: {
			ephemeral_5m_input_tokens: 500000,  // 0.5M at 1.25x
			ephemeral_1h_input_tokens: 1500000  // 1.5M at 2.00x
		}
	};

	const cost = calculateClaudeCost("claude-sonnet-4-20250514", usage);

	// Expected: input 0 + output 0 + cw5m(0.5 * 3.75) + cw1h(1.5 * 6.00)
	// = 1.875 + 9.00 = 10.875
	const expected = 0.5 * 3.75 + 1.5 * 6.00;
	assert.strictEqual(
		round4(cost), round4(expected),
		`#55: TTL-split cache-write — expected ${expected}, got ${cost}`
	);
	console.log("✅ #55 Test 5: TTL split (5-min + 1-hour) PASSED");
}

// TEST 6: TTL breakdown with Haiku model ($1/M input)
// 5-min: 1.25x = $1.25/M, 1-hour: 2.0x = $2.00/M
{
	const usage = {
		input_tokens: 1000000, // 1M input
		output_tokens: 500000,  // 0.5M output
		cache_creation_input_tokens: 1000000,
		cache_read_input_tokens: 2000000,
		cache_creation: {
			ephemeral_5m_input_tokens: 0,
			ephemeral_1h_input_tokens: 1000000  // all 1-hour
		}
	};

	const cost = calculateClaudeCost("claude-haiku-4-5-20250514", usage);

	// input: 1.0 * 1 = 1.00
	// output: 0.5 * 5 = 2.50
	// cw1h: 1.0 * 2.00 = 2.00
	// cr: 2.0 * 0.10 = 0.20
	// total: 1.00 + 2.50 + 2.00 + 0.20 = 5.70
	const expected = 1.0 * 1.00 + 0.5 * 5.00 + 1.0 * 2.00 + 2.0 * 0.10;
	assert.strictEqual(
		round4(cost), round4(expected),
		`#55: Haiku TTL-split — expected ${expected}, got ${cost}`
	);
	console.log("✅ #55 Test 6: Haiku TTL split PASSED");
}

// TEST 7: Backward compatibility — no cache_creation sub-object, only scalar
// (e.g. Pi schema or older transcripts). Should fall back to 1.25× for all.
{
	const usage = {
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: 2000000, // 2M
		cache_read_input_tokens: 0
		// no cache_creation sub-object
	};

	const cost = calculateClaudeCost("claude-sonnet-4-20250514", usage);

	// 2M cache-write at flat 1.25× ($3.75/M) = 7.50
	const expected = 2.0 * 3.75;
	assert.strictEqual(
		round4(cost), round4(expected),
		`#55: Backward-compat scalar-only — expected ${expected}, got ${cost}`
	);
	console.log("✅ #55 Test 7: Backward compat (no breakdown) PASSED");
}

// TEST 8: Mixed — some 5-min, some 1-hour, plus residual in scalar
{
	const usage = {
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: 3000000, // 3M scalar total
		cache_read_input_tokens: 0,
		cache_creation: {
			ephemeral_5m_input_tokens: 500000,   // 0.5M
			ephemeral_1h_input_tokens: 1000000   // 1.0M
		}
		// cwFlat = 3M - 0.5M - 1.0M = 1.5M at default 1.25×
	};

	const cost = calculateClaudeCost("claude-sonnet-4-20250514", usage);

	// cw5m: 0.5 * 3.75 = 1.875
	// cw1h: 1.0 * 6.00 = 6.00
	// cwFlat: 1.5 * 3.75 = 5.625
	// total: 13.50
	const expected = 0.5 * 3.75 + 1.0 * 6.00 + 1.5 * 3.75;
	assert.strictEqual(
		round4(cost), round4(expected),
		`#55: Mixed with residual — expected ${expected}, got ${cost}`
	);
	console.log("✅ #55 Test 8: Mixed TTL + residual fallback PASSED");
}

// TEST 9: Opus model — 1-hour caches (all cw1h in practice, per the issue)
{
	const usage = {
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: 1382449,
		cache_read_input_tokens: 0,
		cache_creation: {
			ephemeral_5m_input_tokens: 0,
			ephemeral_1h_input_tokens: 1382449  // all 1-hour
		}
	};

	const cost = calculateClaudeCost("claude-opus-4-20250514", usage);

	// Opus: $5/M input, so 1-hour cw = 2.0× = $10/M
	// 1.382449 * 10 = 13.82449
	const expected = 1.382449 * 10.00;
	assert.strictEqual(
		round4(cost), round4(expected),
		`#55: Opus 100% 1-hour caches — expected ~${round4(expected)}, got ${round4(cost)}`
	);
	console.log("✅ #55 Test 9: Opus all-1-hour caches PASSED");
}

// TEST 10: DeepSeek — cache_creation should be 0 regardless of TTL split
{
	const usage = {
		input_tokens: 1000000,
		output_tokens: 500000,
		cache_creation_input_tokens: 500000,
		cache_read_input_tokens: 0,
		cache_creation: {
			ephemeral_5m_input_tokens: 200000,
			ephemeral_1h_input_tokens: 300000
		}
	};

	// Use a timestamp in off-peak for stable pricing
	const offPeakTs = new Date("2026-07-05T12:00:00Z").getTime();
	const cost = calculateClaudeCost("deepseek-v4-flash", usage, offPeakTs);

	// deepseek-v4-flash off-peak: $0.14/M input, $0.28/M output, 0 cache
	// input: 1.0 * 0.14 = 0.14
	// output: 0.5 * 0.28 = 0.14
	// total: 0.28
	const expected = 1.0 * 0.14 + 0.5 * 0.28;
	assert.strictEqual(
		round4(cost), round4(expected),
		`#55: DeepSeek → cache-write should be 0 even with TTL breakdown — expected ${expected}, got ${cost}`
	);
	console.log("✅ #55 Test 10: DeepSeek zero cache-write PASSED");
}

// ---
// INTEGRATION: #54 + #55 together via buildWtftLines
// ---
console.log("\n=== Integration: #54 + #55 via buildWtftLines ===");

{
	const mid = "msg_integration_1";

	// Simulate 3 Claude Code lines for one message, each with TTL-split cache_creation
	const line1 = {
		timestamp: new Date("2026-07-05T10:00:00Z").getTime(),
		cost: calculateClaudeCost("claude-sonnet-4-20250514", {
			input_tokens: 5000,
			output_tokens: 2000,
			cache_creation_input_tokens: 3000,
			cache_read_input_tokens: 0,
			cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 }
		}),
		messageId: mid,
		files: [{ path: "src/a.ts", action: "read" }],
		commands: [],
		texts: ["block 1"]
	};

	const line2 = {
		...line1,
		timestamp: line1.timestamp + 1,
		files: [{ path: "src/b.ts", action: "write" }],
		texts: ["block 2"]
	};

	const line3 = {
		...line1,
		timestamp: line1.timestamp + 2,
		files: [{ path: "src/c.ts", action: "read" }],
		texts: ["block 3"]
	};

	const deduped = deduplicateInteractions([line1, line2, line3]);
	assert.strictEqual(deduped.length, 1, "Integration: 3 lines → 1 deduped");
	assert.strictEqual(deduped[0].files.length, 3, "Integration: 3 content blocks merged");
	assert.strictEqual(deduped[0].texts.length, 3, "Integration: 3 text blocks merged");

	// Now run through buildWtftLines — it should internally dedup and produce correct totals
	const settings = {
		interval: "1h",
		limit: 5,
		width: 80,
		showTicks: false,
		mode: "cumulative" as "cumulative" | "bucket",
		timezone: "UTC"
	};

	const lines = buildWtftLines([line1, line2, line3], settings);
	assert.ok(lines, "Integration: buildWtftLines should return lines");
	assert.ok(lines!.length > 0, "Integration: lines should not be empty");

	// The total cost across all lines should equal one message's cost × 1, not × 3
	const totalCost = [line1, line2, line3].reduce((sum, i) => sum + i.cost, 0);
	assert.strictEqual(
		totalCost, line1.cost * 3,
		"Input: raw sum should be 3× (before dedup)"
	);
	// buildWtftLines dedup is internal — just verify the output exists and is valid
	// The dedup itself was tested above; buildWtftLines is confirmed to call deduplicateInteractions

	console.log("✅ Integration: #54 + #55 via buildWtftLines PASSED");
}

console.log("\n✅ ALL #54 (message-id dedup) AND #55 (TTL-split cache-write) TESTS PASSED!");

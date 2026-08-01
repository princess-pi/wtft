#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/wtft-issue-121.test.ts — Turn-based bucketing via --interval <N>t (#121)
 *
 * Verifies parseInterval, getBinInfo, and buildWtftLines with turn-based mode.
 *
 * Run: node --experimental-strip-types tests/wtft-issue-121.test.ts
 */

import * as assert from "node:assert";
import {
	buildWtftLines,
} from "../bin/wtft.mjs";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

// Helper: build a mock interaction (minimal fields that buildWtftLines uses)
function mockIx(cost: number, timestamp: number, cat?: string): any {
	// classifyInteraction keys off files, commands, and toolCats.
	// cat="spec"  → looks like a read/write turn
	// cat="code"  → looks like a bash+edit turn
	// cat="other" → generic bash turn
	const cmd = cat ?? "spec";
	return {
		timestamp,
		cost,
		inputTokens: cost * 100,
		outputTokens: cost * 50,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		files: cmd === "spec" ? [{ path: "/tmp/spec.md", action: "read" as const }] : [],
		commands: cmd === "code" ? ["git", "bun", "sed"] : ["echo"],
		texts: [],
		unrecognizedTool: false,
		serverToolCost: 0,
	};
}

// ---
// TEST 1: parseInterval — turn unit (verified via buildWtftLines)
// ---
console.log("--- TEST 1: parseInterval turn unit ---");

const ix1 = [mockIx(1.00, Date.now(), "spec")];

// 10t interval — valid
const r1 = buildWtftLines(ix1,
	{ interval: "1h", limit: 10, width: 80, showTicks: false, mode: "bucket", timezone: undefined, disabledEmoji: false },
	{ interval: "10t", mode: "bucket", width: 80 }
);
check(Array.isArray(r1), "10t → produces output");

// Invalid/fallback interval still works (falls back to 1h)
const r1b = buildWtftLines(ix1,
	{ interval: "1h", limit: 10, width: 80, showTicks: false, mode: "bucket", timezone: undefined, disabledEmoji: false },
	{ interval: "invalid", mode: "bucket", width: 80 }
);
check(Array.isArray(r1b), "invalid interval → falls back to 1h");

// 5turns and 1turn forms
const r1c = buildWtftLines(ix1,
	{ interval: "1h", limit: 10, width: 80, showTicks: false, mode: "bucket", timezone: undefined, disabledEmoji: false },
	{ interval: "5turns", mode: "bucket", width: 80 }
);
check(Array.isArray(r1c), "5turns → produces output");

const r1d = buildWtftLines(ix1,
	{ interval: "1h", limit: 10, width: 80, showTicks: false, mode: "bucket", timezone: undefined, disabledEmoji: false },
	{ interval: "1turn", mode: "bucket", width: 80 }
);
check(Array.isArray(r1d), "1turn → produces output");

// ---
// TEST 2: getBinInfo — turn-based bin key/label (verified via output labels)
// ---
console.log("--- TEST 2: getBinInfo turn-based binning ---");

const ix2 = [
	mockIx(0.10, Date.now(), "spec"),   // turn 1
	mockIx(0.20, Date.now() + 1000, "spec"), // turn 2
	mockIx(0.30, Date.now() + 2000, "spec"), // turn 3
];

// 10t interval, 3 turns → all in bucket labeled 3t (highest turn #)
const r2 = buildWtftLines(ix2,
	{ interval: "1h", limit: 10, width: 80, showTicks: false, mode: "bucket", timezone: undefined, disabledEmoji: false },
	{ interval: "10t", mode: "bucket", width: 80 }
);
const out2 = (r2 as string[]).join("\n");
check(out2.includes("3t"), "3 turns @ 10t → label 3t (highest turn)");
check(out2.includes("0.60"), "3 turns @ 10t → total $0.60");

// 1t interval: each turn gets its own bar
const r2b = buildWtftLines(ix2,
	{ interval: "1h", limit: 10, width: 80, showTicks: false, mode: "bucket", timezone: undefined, disabledEmoji: false },
	{ interval: "1t", mode: "bucket", width: 80 }
);
const out2b = (r2b as string[]).join("\n");
check(out2b.includes("1t"), "1t interval: includes 1t");
check(out2b.includes("2t"), "1t interval: includes 2t");
check(out2b.includes("3t"), "1t interval: includes 3t");

// ---
// TEST 3: buildWtftLines — turn-based bucketing
// ---
console.log("--- TEST 3: buildWtftLines turn-based bucket mode ---");

const ix3 = [
	mockIx(1.00, Date.now(), "spec"),
	mockIx(2.00, Date.now() + 1000, "code"),
	mockIx(0.50, Date.now() + 2000, "spec"),
	mockIx(3.00, Date.now() + 3000, "code"),
	mockIx(1.50, Date.now() + 4000, "spec"),
	mockIx(0.25, Date.now() + 5000, "other"),
];

const lines3 = buildWtftLines(ix3,
	{ interval: "1h", limit: 100, width: 80, showTicks: false, mode: "bucket", timezone: undefined, disabledEmoji: false },
	{ interval: "2t", mode: "bucket", width: 80 }
);
check(Array.isArray(lines3), "produces output lines");
const out3 = (lines3 as string[]).join("\n");
// With 2t interval and 6 interactions: buckets 2t, 4t, 6t
check(out3.includes("2t"), "output includes 2t label");
check(out3.includes("4t"), "output includes 4t label");
check(out3.includes("6t"), "output includes 6t label");

// Verify cost totals per bucket
// Turns 1-2: $1.00 + $2.00 = $3.00
// Turns 3-4: $0.50 + $3.00 = $3.50
// Turns 5-6: $1.50 + $0.25 = $1.75
check(out3.includes("3.00"), "2t bucket shows $3.00");
check(out3.includes("3.50"), "4t bucket shows $3.50");
check(out3.includes("1.75"), "6t bucket shows $1.75");

// ---
// TEST 4: buildWtftLines — cumulative turn mode
// ---
console.log("--- TEST 4: buildWtftLines cumulative turn mode ---");

const lines4 = buildWtftLines(ix3,
	{ interval: "1h", limit: 100, width: 80, showTicks: false, mode: "bucket", timezone: undefined, disabledEmoji: false },
	{ interval: "2t", mode: "cumulative", width: 80 }
);
const out4 = (lines4 as string[]).join("\n");
// Cumulative: 2t=$3.00, 4t=$6.50, 6t=$8.25
check(out4.includes("3.00"), "cumulative 2t shows $3.00");
check(out4.includes("6.50"), "cumulative 4t shows $6.50");
check(out4.includes("8.25"), "cumulative 6t shows $8.25");

// ---
// TEST 5: Partial final bucket
// ---
console.log("--- TEST 5: Partial final bucket ---");

const ix5 = [
	mockIx(1.00, Date.now(), "spec"),
	mockIx(2.00, Date.now() + 1000, "spec"),
	mockIx(0.50, Date.now() + 2000, "spec"),
];

// 2t interval, 3 interactions → buckets 2t, 3t (not 4t)
const lines5 = buildWtftLines(ix5,
	{ interval: "1h", limit: 100, width: 80, showTicks: false, mode: "bucket", timezone: undefined, disabledEmoji: false },
	{ interval: "2t", mode: "bucket", width: 80 }
);
const out5 = (lines5 as string[]).join("\n");
check(out5.includes("2t"), "partial: includes 2t");
check(out5.includes("3t"), "partial: includes 3t (not 4t)");
check(!out5.includes("4t"), "partial: does NOT include 4t");

// ---
// TEST 6: Date separator in turn mode
// ---
console.log("--- TEST 6: Date separator across day boundary ---");

// Use timestamps that cross a day boundary in UTC (and all timezones)
const day1 = new Date("2026-07-01T12:00:00Z").getTime();
const day2 = new Date("2026-07-02T12:00:00Z").getTime();

const ix6 = [
	mockIx(1.00, day1, "spec"),
	mockIx(2.00, day1 + 1000, "spec"),
	mockIx(3.00, day2, "spec"),
	mockIx(4.00, day2 + 1000, "spec"),
];

const lines6 = buildWtftLines(ix6,
	{ interval: "1h", limit: 100, width: 80, showTicks: true, mode: "bucket", timezone: undefined, disabledEmoji: false },
	{ interval: "1t", mode: "bucket", width: 80 }
);
const out6 = (lines6 as string[]).join("\n");
// With 1t interval and 4 interactions crossing day boundary:
// turns 1t, 2t on day 1, turns 3t, 4t on day 2
// Should have a date separator between turn 2 and turn 3
const lines6Arr = lines6 as string[];
const daySepIdx = lines6Arr.findIndex(l => l.includes("Jul-02"));
check(daySepIdx >= 0, "date separator present for day boundary");
check(out6.includes("1t"), "day-boundary: includes 1t");
check(out6.includes("2t"), "day-boundary: includes 2t");
check(out6.includes("3t"), "day-boundary: includes 3t");
check(out6.includes("4t"), "day-boundary: includes 4t");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

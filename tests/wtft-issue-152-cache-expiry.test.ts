#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/wtft-issue-152-cache-expiry.test.ts — Observed cache-miss divider (#152)
 *
 * The divider used to be inferred from elapsed time vs. a 5m/1h TTL. It now comes
 * from the observation the API already records: cacheRead === 0 && cacheWrite > 0.
 *
 * Run: node --experimental-strip-types tests/wtft-issue-152-cache-expiry.test.ts
 */

import { buildWtftLines } from "../bin/wtft.mjs";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const DEFAULTS = {
	interval: "1h", limit: 100, width: 80, showTicks: false,
	mode: "bucket" as const, timezone: undefined, disabledEmoji: false,
};

/**
 * Mock interaction. cr/cw are the fields under test; everything else is the
 * minimum buildWtftLines needs to classify and bin the turn.
 */
function mockIx(opts: {
	ts: number; cost?: number; cr: number; cw: number; model?: string;
}): any {
	return {
		timestamp: opts.ts,
		cost: opts.cost ?? 1.0,
		model: opts.model,
		inputTokens: 2,
		outputTokens: 500,
		cacheReadTokens: opts.cr,
		cacheWriteTokens: opts.cw,
		reasoningTokens: 0,
		files: [{ path: "/tmp/spec.md", action: "read" as const }],
		commands: [],
		texts: [],
		unrecognizedTool: false,
		serverToolCost: 0,
	};
}

function render(ix: any[], interval: string): string {
	const lines = buildWtftLines(ix, DEFAULTS, { interval, mode: "bucket", width: 80 });
	return (lines as string[]).join("\n");
}

function dividerCount(out: string): number {
	return out.split("\n").filter(l => l.includes("Cache Miss")).length;
}

const HOUR = 3600000;
const BASE = new Date("2026-07-01T12:00:00Z").getTime();

// ---
// TEST 1: an observed miss draws a divider
// ---
console.log("--- TEST 1: observed miss draws a divider ---");

const out1 = render([mockIx({ ts: BASE, cr: 0, cw: 48278 })], "1h");
check(out1.includes("Cache Miss"), "cr=0, cw>0 → 'Cache Miss' divider");
check(!out1.includes("Cache Expired"), "old 'Cache Expired' label is gone");

// ---
// TEST 2: an all-hit run draws none
// ---
console.log("--- TEST 2: all cache hits → no divider ---");

const out2 = render([
	mockIx({ ts: BASE, cr: 100000, cw: 2000 }),
	mockIx({ ts: BASE + HOUR, cr: 120000, cw: 2500 }),
	mockIx({ ts: BASE + 2 * HOUR, cr: 140000, cw: 3000 }),
], "1h");
check(dividerCount(out2) === 0, "every turn reads cache → 0 dividers");

// ---
// TEST 3: no cache activity at all draws none
// ---
console.log("--- TEST 3: cr=0 AND cw=0 → no divider ---");
// Guards against a naive `cacheReadTokens === 0` check. This is also the mock
// shape used throughout tests/wtft-issue-121.test.ts, so it doubles as the
// regression guard for that suite.

const out3 = render([
	mockIx({ ts: BASE, cr: 0, cw: 0 }),
	mockIx({ ts: BASE + HOUR, cr: 0, cw: 0 }),
], "1h");
check(dividerCount(out3) === 0, "no caching at all → 0 dividers (not a miss)");

// ---
// TEST 4: turn-based intervals show it — the #121 regression this fix closes
// ---
console.log("--- TEST 4: turn-based interval shows the divider ---");
// The predictive walk was gated behind `intervalConfig.type !== "turns"`, so
// `-i Nt` renders could never show a miss no matter how real it was.

const turnIx = [
	mockIx({ ts: BASE, cr: 200000, cw: 3000 }),
	mockIx({ ts: BASE + 1000, cr: 0, cw: 76435 }),
	mockIx({ ts: BASE + 2000, cr: 76435, cw: 1500 }),
];
const out4 = render(turnIx, "1t");
check(out4.includes("Cache Miss"), "-i 1t → divider present (was suppressed by #121 gate)");
check(dividerCount(out4) === 1, "-i 1t → exactly one divider for one miss");

// ---
// TEST 5: model switch inside the TTL
// ---
console.log("--- TEST 5: model switch 539s apart still draws a divider ---");
// Measured on session d730d9c3: opus-4-8 → opus-5 nine minutes apart, cache
// invalidated by the model key, full 51k re-prime. The clock saw nothing.

const out5 = render([
	mockIx({ ts: BASE, cr: 300000, cw: 43048, model: "claude-opus-4-8" }),
	mockIx({ ts: BASE + 539000, cr: 0, cw: 51072, model: "claude-opus-5" }),
], "1h");
check(out5.includes("Cache Miss"), "invalidation with no time elapsed → divider");

// ---
// TEST 6: one divider per bin containing a miss
// ---
console.log("--- TEST 6: divider count tracks bins containing a miss ---");

const out6 = render([
	mockIx({ ts: BASE, cr: 0, cw: 40000 }),                    // bin 1 — miss
	mockIx({ ts: BASE + 60000, cr: 40000, cw: 1000 }),          // bin 1 — hit
	mockIx({ ts: BASE + HOUR, cr: 80000, cw: 1000 }),           // bin 2 — hit only
	mockIx({ ts: BASE + 2 * HOUR, cr: 0, cw: 90000 }),          // bin 3 — miss
], "1h");
check(dividerCount(out6) === 2, "3 bins, 2 containing a miss → 2 dividers");

// Two misses inside one bin collapse to a single divider (it marks the bin).
const out6b = render([
	mockIx({ ts: BASE, cr: 0, cw: 40000 }),
	mockIx({ ts: BASE + 60000, cr: 0, cw: 50000 }),
], "1h");
check(dividerCount(out6b) === 1, "2 misses in 1 bin → 1 divider");

// ---
// TEST 7: order independence
// ---
console.log("--- TEST 7: unsorted input still detects the miss ---");
// The predictive walk had to re-sort because it compared neighbours. Observation
// judges each interaction alone, so input order cannot change the result.

const sorted = [
	mockIx({ ts: BASE, cr: 100000, cw: 2000 }),
	mockIx({ ts: BASE + HOUR, cr: 0, cw: 60000 }),
];
const shuffled = [sorted[1], sorted[0]];
check(
	dividerCount(render(sorted, "1h")) === dividerCount(render(shuffled, "1h")),
	"shuffled input → same divider count"
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/wtft-issue-152-cache-expiry.test.ts — Observed cache-miss divider (#152)
 *
 * The divider used to be inferred from elapsed time vs. a 5m/1h TTL. It now comes
 * from the observation the API already records: cache_read 0 with cache_creation > 0.
 *
 * That observation is made at parse time and carried on Interaction.cacheMiss,
 * because the compaction/recache meter-split (#52 Phase 3) writes cr and cw onto
 * two separate tag lines — after which a full miss and a partial re-prime are
 * indistinguishable. PART C is the regression for exactly that.
 *
 * Run: node --experimental-strip-types tests/wtft-issue-152-cache-expiry.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { trackSandbox } from "./lib/sandbox";

import {
	buildWtftLines,
	parseSessionFile,
	serializeClassifiedWithOverheadSplit,
} from "../bin/wtft.mjs";

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

const HOUR = 3600000;
const BASE = new Date("2026-07-01T12:00:00Z").getTime();

// ---
// PART A — RENDERER: the divider follows Interaction.cacheMiss
// ---

function mockIx(opts: {
	ts: number; cost?: number; cr: number; cw: number;
	cacheMiss?: boolean; model?: string;
}): any {
	return {
		timestamp: opts.ts,
		cost: opts.cost ?? 1.0,
		model: opts.model,
		inputTokens: 2,
		outputTokens: 500,
		cacheReadTokens: opts.cr,
		cacheWriteTokens: opts.cw,
		cacheMiss: opts.cacheMiss,
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

console.log("=== PART A: renderer ===");

console.log("--- TEST 1: a flagged miss draws a divider ---");
const out1 = render([mockIx({ ts: BASE, cr: 0, cw: 48278, cacheMiss: true })], "1h");
check(out1.includes("Cache Miss"), "cacheMiss → 'Cache Miss' divider");
check(!out1.includes("Cache Expired"), "old 'Cache Expired' label is gone");

console.log("--- TEST 2: all cache hits → no divider ---");
const out2 = render([
	mockIx({ ts: BASE, cr: 100000, cw: 2000 }),
	mockIx({ ts: BASE + HOUR, cr: 120000, cw: 2500 }),
	mockIx({ ts: BASE + 2 * HOUR, cr: 140000, cw: 3000 }),
], "1h");
check(dividerCount(out2) === 0, "every turn reads cache → 0 dividers");

console.log("--- TEST 3: no cache activity at all → no divider ---");
// The mock shape used throughout tests/wtft-issue-121.test.ts, so this doubles
// as the regression guard for that suite.
const out3 = render([
	mockIx({ ts: BASE, cr: 0, cw: 0 }),
	mockIx({ ts: BASE + HOUR, cr: 0, cw: 0 }),
], "1h");
check(dividerCount(out3) === 0, "no caching at all → 0 dividers (not a miss)");

console.log("--- TEST 4: turn-based interval shows the divider ---");
// The predictive walk was gated behind `intervalConfig.type !== "turns"`, so
// `-i Nt` renders could never show a miss no matter how real it was (#121).
const out4 = render([
	mockIx({ ts: BASE, cr: 200000, cw: 3000 }),
	mockIx({ ts: BASE + 1000, cr: 0, cw: 76435, cacheMiss: true }),
	mockIx({ ts: BASE + 2000, cr: 76435, cw: 1500 }),
], "1t");
check(out4.includes("Cache Miss"), "-i 1t → divider present (was suppressed by #121 gate)");
check(dividerCount(out4) === 1, "-i 1t → exactly one divider for one miss");

console.log("--- TEST 5: one divider per bin containing a miss ---");
const out5 = render([
	mockIx({ ts: BASE, cr: 0, cw: 40000, cacheMiss: true }),      // bin 1 — miss
	mockIx({ ts: BASE + 60000, cr: 40000, cw: 1000 }),             // bin 1 — hit
	mockIx({ ts: BASE + HOUR, cr: 80000, cw: 1000 }),              // bin 2 — hit only
	mockIx({ ts: BASE + 2 * HOUR, cr: 0, cw: 90000, cacheMiss: true }), // bin 3 — miss
], "1h");
check(dividerCount(out5) === 2, "3 bins, 2 containing a miss → 2 dividers");

const out5b = render([
	mockIx({ ts: BASE, cr: 0, cw: 40000, cacheMiss: true }),
	mockIx({ ts: BASE + 60000, cr: 0, cw: 50000, cacheMiss: true }),
], "1h");
check(dividerCount(out5b) === 1, "2 misses in 1 bin → 1 divider");

console.log("--- TEST 6: order independence ---");
// The predictive walk had to re-sort because it compared neighbours. Observation
// judges each interaction alone, so input order cannot change the result.
const sorted = [
	mockIx({ ts: BASE, cr: 100000, cw: 2000 }),
	mockIx({ ts: BASE + HOUR, cr: 0, cw: 60000, cacheMiss: true }),
];
check(
	dividerCount(render(sorted, "1h")) === dividerCount(render([sorted[1], sorted[0]], "1h")),
	"shuffled input → same divider count"
);

// ---
// PART B — PARSER: cacheMiss comes from raw usage
// ---

console.log("=== PART B: parser ===");

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-152-")));

function usageLine(id: string, ts: string, cr: number, cw: number, model = "claude-opus-5") {
	return JSON.stringify({
		type: "assistant",
		timestamp: ts,
		message: {
			role: "assistant", id, model,
			content: [{ type: "text", text: "x" }],
			usage: {
				input_tokens: 2, output_tokens: 300,
				cache_read_input_tokens: cr,
				cache_creation_input_tokens: cw,
				cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cw },
			},
		},
	});
}

const sessionPath = path.join(dir, "fixture-152.jsonl");
fs.writeFileSync(sessionPath, [
	usageLine("msg_full_miss", "2026-07-01T12:00:00Z", 0, 48278),
	// Partial re-prime: a small prefix survived. Measured shape from session
	// b1f54c2f — NOT a miss, and the case a cr/cw check on tag lines gets wrong.
	usageLine("msg_partial", "2026-07-01T13:00:00Z", 17266, 333021),
	usageLine("msg_hit", "2026-07-01T14:00:00Z", 350000, 2000),
	usageLine("msg_no_cache", "2026-07-01T15:00:00Z", 0, 0),
].join("\n") + "\n");

const parsed = parseSessionFile(sessionPath);
const byId = new Map<string, any>(parsed.map((i: any) => [i.messageId, i]));

console.log("--- TEST 7: cacheMiss set from raw usage ---");
check(byId.get("msg_full_miss")?.cacheMiss === true, "cr=0, cw>0 → cacheMiss true");
check(!byId.get("msg_partial")?.cacheMiss, "partial re-prime (cr>0) → not a miss");
check(!byId.get("msg_hit")?.cacheMiss, "cache hit → not a miss");
check(!byId.get("msg_no_cache")?.cacheMiss, "no cache activity → not a miss");

// ---
// PART C — METER-SPLIT: the signal survives the two-line split
// ---

console.log("=== PART C: meter-split round-trip ===");
// splitOverheadCost fires on a recache (cw > 30k, input <= 16, cr < 20% of cr+cw)
// and emits TWO lines: a remainder with cw zeroed, and a "#oh" line with cr zeroed.
// Both a full miss and a partial re-prime produce a "#oh" line carrying cr=0, cw>0,
// which is why the divider cannot be derived from tag-line cr/cw.

function tagLines(ix: any, prevCtx: number): any[] {
	return serializeClassifiedWithOverheadSplit(ix, prevCtx)
		.split("\n").filter(Boolean).map((l: string) => JSON.parse(l));
}

const fullMiss = byId.get("msg_full_miss");
const partial = byId.get("msg_partial");

// prevCtx within 15% of this interaction's ctx, so the recache test passes.
const fullLines = tagLines(fullMiss, fullMiss.inputTokens + fullMiss.cacheReadTokens + fullMiss.cacheWriteTokens);
const partialLines = tagLines(partial, partial.inputTokens + partial.cacheReadTokens + partial.cacheWriteTokens);

console.log("--- TEST 8: full miss keeps its flag across the split ---");
check(fullLines.length === 2, "full miss → split into 2 lines");
check(fullLines.some(l => l.miss === 1), "full miss → a line carries miss=1");
check(
	fullLines.filter(l => l.miss === 1).every(l => !String(l.id ?? "").endsWith("#oh")),
	"the flag rides the remainder line, not the #oh line"
);

console.log("--- TEST 9: partial re-prime is NOT flagged, despite its #oh line ---");
check(partialLines.length === 2, "partial re-prime → split into 2 lines");
check(
	partialLines.some(l => (l.cr ?? 0) === 0 && (l.cw ?? 0) > 0),
	"partial re-prime does emit a cr=0/cw>0 line (the trap)"
);
check(
	partialLines.every(l => l.miss !== 1),
	"…but no line is flagged as a miss"
);

console.log("--- TEST 10: a flagged tag line renders a divider end-to-end ---");
// Guards the serialize → classifiedToInteraction → buildWtftLines path that the
// CLI actually uses, not just the in-memory Interaction the tests construct.
const roundTripped = render(
	fullLines.map((l: any) => ({
		timestamp: l.t, cost: l.c, model: l.m,
		inputTokens: l.in ?? 0, outputTokens: l.out ?? 0,
		cacheReadTokens: l.cr ?? 0, cacheWriteTokens: l.cw ?? 0,
		cacheMiss: l.miss ? true : undefined,
		reasoningTokens: 0, files: [], commands: [], texts: [],
		unrecognizedTool: false, serverToolCost: 0,
	})),
	"1h"
);
check(dividerCount(roundTripped) === 1, "split full miss → exactly 1 divider");

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

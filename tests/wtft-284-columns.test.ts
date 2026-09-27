#!/usr/bin/env -S node --experimental-strip-types
/**
 * All four columns by default. --no-cost and --no-tokens hide a pair and leave the bar.
 */

import * as assert from "node:assert";
import { buildWtftLines } from "../extensions/lib/wtft-renderer.ts";
import { parseWtftCliArgs } from "../extensions/lib/wtft-cli-shared.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

function mockIx(cost: number, timestamp: number): any {
	return {
		timestamp,
		cost,
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		files: [{ path: "/tmp/spec.md", action: "read" as const }],
		commands: [],
		texts: [],
		unrecognizedTool: false,
		serverToolCost: 0,
	};
}

const hour = 60 * 60 * 1000;
const t0 = Date.parse("2026-09-26T10:00:00Z");
const ix = [mockIx(1, t0), mockIx(2, t0 + hour)];
const settings = { interval: "1h", limit: 10, width: 80, mode: "cumulative" as const, disabledEmoji: true };

function row(lines: string[] | null): string {
	const found = (lines ?? []).map(l => l.replace(/\x1b\[[0-9;]*m/g, "")).find(l => /^\d\d:\d\d/.test(l.trim()));
	if (!found) throw new Error(`no bin row in:\n${(lines ?? []).join("\n")}`);
	return found;
}

console.log("--- default columns ---");
const all = row(buildWtftLines(ix, settings, { unit: "cost", mode: "cumulative" }));
check(all.includes("+$2.00"), "incremental cost is on a cost bar");
check(all.includes("$3.00"), "total latest cost is on a cost bar");
check(all.includes("+1.5k"), "incremental tokens are on a cost bar");
check(all.includes("3.0k tok"), "total latest tokens are on a cost bar");

console.log("--- --no-cost leaves the cost bar and the token columns ---");
const noCost = row(buildWtftLines(ix, settings, { unit: "cost", mode: "cumulative", showCostColumns: false }));
check(!noCost.includes("+$"), "--no-cost drops the cost columns");
check(noCost.includes("+1.5k"), "--no-cost keeps incremental tokens");
check(noCost.includes("3.0k tok"), "--no-cost keeps total tokens");
check(noCost.includes("█"), "--no-cost keeps the bar");

console.log("--- --no-tokens leaves the token bar and the cost columns ---");
const noTok = row(buildWtftLines(ix, settings, { unit: "tokens", mode: "cumulative", showTokenColumns: false }));
check(!noTok.includes("tok"), "--no-tokens drops the token columns");
check(noTok.includes("+$2.00"), "--no-tokens keeps incremental cost");
check(noTok.includes("$3.00"), "--no-tokens keeps total cost");
check(noTok.includes("▇") || noTok.includes("▃"), "--no-tokens keeps the token bar");

console.log("--- both flags leave the bar and no numbers ---");
const neither = row(buildWtftLines(ix, settings, { unit: "cost", showCostColumns: false, showTokenColumns: false }));
check(!neither.includes("$"), "both flags drop the cost numbers");
check(!neither.includes("tok"), "both flags drop the token numbers");
check(neither.includes("█"), "both flags keep the bar");

console.log("--- the flags do not flip the bar ---");
const parsed = parseWtftCliArgs(["--cost", "--no-cost", "--no-tokens"]);
check(parsed.hasCost && parsed.cost, "--cost still selects a cost bar beside --no-cost");
check(parsed.hideCostColumns, "--no-cost is its own switch");
check(parsed.hideTokenColumns, "--no-tokens is its own switch");
const bothOrders = parseWtftCliArgs(["--no-tokens", "--tokens"]);
check(bothOrders.hasTokens && bothOrders.tokens, "--tokens still selects a token bar beside --no-tokens");
check(bothOrders.hideTokenColumns, "--no-tokens stays set when --tokens is also passed");

assert.strictEqual(failed, 0, `${failed} failed`);
console.log(`\n${passed} passed`);

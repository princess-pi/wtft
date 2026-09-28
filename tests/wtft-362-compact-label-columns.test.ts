#!/usr/bin/env -S bun
/**
 * A chart whose label area (the time label and the number columns) is over 25% of the width
 * gets narrower one step at a time: single spacing, whole units, no `+` on deltas, no `$` on
 * the cost delta. Spec: docs/spec-362-compact-label-columns.md.
 */

import { buildWtftLines } from "../extensions/lib/wtft-renderer.ts";

process.env.COLUMNS = "250";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const HOUR = 3600000;
const day = Date.UTC(2026, 8, 22);
const ix = (ts: number, cost: number, cacheRead: number) => ({
	timestamp: ts, cost, model: "claude-opus-5",
	inputTokens: 2, outputTokens: 500, cacheReadTokens: cacheRead, cacheWriteTokens: 0,
	cacheMiss: false, reasoningTokens: 0, webSearchRequests: 0, webFetchRequests: 0, serverToolCost: 0,
	files: [{ path: "/tmp/spec.md", action: "read" as const }], commands: [], texts: [],
});

function rowAt(interactions: unknown[], width: number, hhmm: string): string {
	const settings = { interval: "1h", limit: 100, width, mode: "cumulative" as const, timezone: "UTC", disabledEmoji: true };
	const lines = (buildWtftLines(interactions as any, settings, { ...settings }) as string[])
		.map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));
	return lines.find(l => l.startsWith(hhmm)) ?? "";
}
const labels = (row: string) => row.slice(0, row.indexOf("█"));

// 04:00 reads +$243.63, $487.25, +389.4M, 778.8M tok: a 47-cell label area at full spacing.
const big = [ix(day + 3 * HOUR, 243.62, 389_400_000), ix(day + 4 * HOUR, 243.63, 389_400_000)];

console.log("\nEach step applies only while the label area is still over 25% of the width");
{
	const wide = labels(rowAt(big, 200, "04:00"));
	check(wide === "04:00  +$243.63  $487.25  +389.4M  778.8M tok  ", `at 200 (limit 50) nothing changes: ${JSON.stringify(wide)}`);
	const one = labels(rowAt(big, 180, "04:00"));
	check(one === "04:00 +$243.63 $487.25 +389.4M 778.8M tok ", `at 180 (limit 45) columns are single-spaced: ${JSON.stringify(one)}`);
	const two = labels(rowAt(big, 160, "04:00"));
	check(two === "04:00 +$244 $487 +389M 779M tok ", `at 160 (limit 40) values of $1 or 1k and over lose their fraction: ${JSON.stringify(two)}`);
	const three = labels(rowAt(big, 124, "04:00"));
	check(three === "04:00 $244 $487 389M 779M tok ", `at 124 (limit 31) the deltas lose their +: ${JSON.stringify(three)}`);
	const four = labels(rowAt(big, 100, "04:00"));
	check(four === "04:00 244 $487 389M 779M tok ", `at 100 (limit 25) the cost delta loses its $: ${JSON.stringify(four)}`);
	const narrow = labels(rowAt(big, 40, "04:00"));
	check(narrow === "04:00 244 $487 ", `at 40 the token columns go, and the cost columns stay compact: ${JSON.stringify(narrow)}`);
}

console.log("\nValues under $1 and under 1k keep their digits");
{
	const small = [ix(day + 3 * HOUR, 0.12, 400), ix(day + 4 * HOUR, 0.13, 450)];
	const row = labels(rowAt(small, 100, "04:00"));
	check(row.startsWith("04:00 ") && !row.startsWith("04:00  "), `fixture precondition: the row is compacted at 100: ${JSON.stringify(row)}`);
	check(row.includes("$0.25") && row.includes("0.13"), `a $0.25 total and a $0.13 delta keep their cents: ${JSON.stringify(row)}`);
}

console.log("\nRounding is to the nearest whole unit");
{
	const half = [ix(day + 3 * HOUR, 1, 588_998), ix(day + 4 * HOUR, 1, 1)];
	const row = labels(rowAt(half, 150, "03:00"));
	check(rowAt(half, 250, "03:00").includes("589.5k"), "fixture precondition: at full width the count reads 589.5k");
	check(row.includes("590k"), `589.5k reads 590k: ${JSON.stringify(row)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

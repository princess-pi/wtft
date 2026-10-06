#!/usr/bin/env -S node --experimental-strip-types
/**
 * `--no-emoji` draws no emoji anywhere in the chart: the surge row's bolt and the Other warning included.
 */

import { buildWtftLines } from "../extensions/lib/wtft-renderer.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

function mockIx(cost: number, timestamp: number, surgePriced: boolean): any {
	return {
		timestamp, cost, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
		reasoningTokens: 0, files: [], commands: [], texts: [], unrecognizedTool: false, serverToolCost: 0, surgePriced,
	};
}

const hour = 60 * 60 * 1000;
const t0 = Date.parse("2026-09-26T10:00:00Z");
const ix = [mockIx(4, t0, false), mockIx(5, t0 + hour, true)];
const settings = { interval: "1h", limit: 10, width: 220, mode: "cumulative" as const, timezone: "UTC" };
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const above2FFF = (line: string) => [...line].filter((ch) => ch.codePointAt(0)! > 0x2fff);

const prev = process.stdout.columns;
process.stdout.columns = 220;
try {
	for (const words of [undefined, { otherWarning: "{pct} of it is Other ({cost})" }]) {
		const label = words ? "custom warning words" : "default warning";
		const on = (buildWtftLines(ix, settings, { disabledEmoji: false, words }) ?? []).map(plain);
		const off = (buildWtftLines(ix, settings, { disabledEmoji: true, words }) ?? []).map(plain);
		const surgeRow = (lines: string[]) => lines.find((l) => /^11:00/.test(l)) ?? "";
		const warning = (lines: string[]) => lines.find((l) => /Other/.test(l) && !l.includes("█")) ?? "";

		check(surgeRow(on).includes("⚡"), `${label}: fixture precondition — with emoji the surge row draws ⚡ in a two-space gap`);
		check(warning(on).startsWith("⚠️"), `${label}: fixture precondition — with emoji the Other warning starts ⚠️`);

		check(/\+\$5\.00!!\$9\.00/.test(surgeRow(off)), `${label}: --no-emoji draws the surge row's bolt as !! (${surgeRow(off)})`);
		check(warning(off).length > 0 && !warning(off).includes("⚠"), `${label}: --no-emoji Other warning has no ⚠ (${warning(off)})`);
		const offenders = off.flatMap(above2FFF);
		check(off.every((l) => !l.includes("⚡") && !l.includes("⚠")) && offenders.length === 0,
			`${label}: --no-emoji: no line holds ⚡, ⚠ or a codepoint above U+2FFF (found ${JSON.stringify(offenders)})`);
	}
} finally {
	process.stdout.columns = prev;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

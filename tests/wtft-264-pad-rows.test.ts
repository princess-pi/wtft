#!/usr/bin/env -S node --experimental-strip-types
/**
 * The CLI chart is padded to its row limit with placeholder rows. docs/spec-264-pad-rows.md.
 */

import { buildWtftLines, CLI_DEFAULT_LIMIT, chartLimit } from "../extensions/lib/wtft-renderer.ts";
import { isPlaceholderRow } from "../extensions/lib/wtft-chart.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

function mockIx(cost: number, timestamp: number): any {
	return {
		timestamp, cost, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
		reasoningTokens: 0, files: [{ path: "/tmp/spec.md", action: "read" as const }], commands: [], texts: [],
		unrecognizedTool: false, serverToolCost: 0,
	};
}

const hour = 60 * 60 * 1000;
const t0 = Date.parse("2026-09-26T10:00:00Z");
const ix = [mockIx(1, t0), mockIx(2, t0 + hour)];
const settings = { interval: "1h", limit: 100, width: 100, mode: "cumulative" as const, disabledEmoji: true };
const plain = (lines: string[] | null) => (lines ?? []).map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));
const dataRows = (lines: string[]) => lines.filter(l => /^\d\d:\d\d/.test(l));
const placeholderRows = (lines: string[]) => lines.filter(l => /^-\s/.test(l));

console.log("--- padRowsTo ---");
for (const unit of ["cost", "tokens"] as const) {
	const lines = plain(buildWtftLines(ix, settings, { limit: 5, padRowsTo: 5, unit }));
	check(dataRows(lines).length === 2, `${unit}: the fixture has two interval rows`);
	const pads = placeholderRows(lines);
	check(pads.length === 3, `${unit}: -l 5 over two intervals adds three placeholder rows (got ${pads.length})`);
	check(pads.every(l => l.trim().split(/\s+/).every(cell => cell === "-")), `${unit}: a placeholder row is a dash per label column and nothing else`);
	check(pads.every(l => l.split(/\s+/).filter(Boolean).length === 5), `${unit}: one dash under the time label and each of the four columns`);
	const last = lines.lastIndexOf(dataRows(lines)[1]!);
	check(lines.indexOf(pads[0]!) > last, `${unit}: placeholders come after the last interval row`);
}
{
	const lines = plain(buildWtftLines(ix, settings, { limit: 5, padRowsTo: 5, showTokenColumns: false }));
	check(placeholderRows(lines).every(l => l.split(/\s+/).filter(Boolean).length === 3), "a hidden column pair gets no dashes");
}
{
	const lines = plain(buildWtftLines(ix, settings, { limit: 5 }));
	check(placeholderRows(lines).length === 0, "without padRowsTo (the Pi widget) nothing is padded");
}
{
	const many = Array.from({ length: 8 }, (_, i) => mockIx(1, t0 + i * hour));
	const lines = plain(buildWtftLines(many, settings, { limit: 5, padRowsTo: 5 }));
	check(dataRows(lines).length === 5 && placeholderRows(lines).length === 0, "more intervals than the limit: no padding");
}

console.log("--- the CLI's effective limit ---");
check(CLI_DEFAULT_LIMIT === 17, "the CLI default limit is 17");
check(chartLimit({ hasLimit: false, limit: 10 }, undefined) === 17, "no -l and no config: 17");
check(chartLimit({ hasLimit: true, limit: 5 }, 30) === 5, "-l wins over config");
check(chartLimit({ hasLimit: false, limit: 10 }, 30) === 30, "config limit wins over the default");

check(chartLimit({ hasLimit: false, limit: 10 }, 3.5) === 3, "a fractional config limit is rounded down, so slice and padding agree");
check(chartLimit({ hasLimit: false, limit: 10 }, -2) === 0, "a negative config limit is 0");
{
	const lines = plain(buildWtftLines(ix, settings, { limit: 5, padRowsTo: 5 }));
	check(placeholderRows(lines).length === 3 && (buildWtftLines(ix, settings, { limit: 5, padRowsTo: 5 }) ?? []).filter(isPlaceholderRow).length === 3,
		"isPlaceholderRow finds exactly the padding rows");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

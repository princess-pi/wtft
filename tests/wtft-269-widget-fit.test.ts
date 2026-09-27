#!/usr/bin/env -S node --experimental-strip-types
/**
 * The Pi widget never hands Pi more lines than Pi shows. docs/spec-269-widget-fit.md.
 */

import { buildWtftLines } from "../extensions/lib/wtft-renderer.ts";
import { PI_WIDGET_MAX_LINES, fitWidget, widgetLines } from "../extensions/lib/widget-fit.ts";

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
// 20 hourly intervals across midnight, so the chart carries a date divider.
const t0 = Date.parse("2026-09-26T09:00:00Z");
const ix = Array.from({ length: 20 }, (_, i) => mockIx(1, t0 + i * hour));
const settings = { interval: "1h", limit: 10, width: 60, mode: "cumulative" as const, disabledEmoji: true, timezone: "UTC" };
const plain = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
// Wider than the widget, so it cannot sit on the title line.
const status = "  ● " + "status ".repeat(20);
const provisional = ["⚠ PROVISIONAL: a subagent is still being read"];

check(PI_WIDGET_MAX_LINES === 10, "Pi's cap on a string-array widget is 10 lines");

const render = (limit: number) => {
	const chart = buildWtftLines(ix, settings, { limit, isWidget: true, timezone: "UTC" });
	return chart && widgetLines(chart, status, 60, provisional);
};
const unfitted = render(10)!;
check(unfitted.length > PI_WIDGET_MAX_LINES, `fixture precondition: the unfitted widget overflows (${unfitted.length} lines)`);
check(unfitted.slice(4).some(l => /^── \w{3}-\d\d/.test(plain(l))), "fixture precondition: a date divider is in the chart");

const fitted = fitWidget(render, 10)!;
check(fitted.length <= PI_WIDGET_MAX_LINES, `the fitted widget has at most 10 lines (got ${fitted.length})`);
check(plain(fitted[0]!).includes("WTF Tokens?"), "line 1 is the title");
check(plain(fitted[1]!).includes("Plan") && plain(fitted[1]!).includes("Code"), "line 2 is the legend");
check(fitted.some(l => l === status.trim()), "the status line that does not fit the title is kept");
check(fitted[fitted.length - 1] === provisional[0], "the provisional line is kept");
const rows = fitted.map(plain).filter(l => /^\d\d:\d\d/.test(l));
const allRows = unfitted.map(plain).filter(l => /^\d\d:\d\d/.test(l));
check(rows.length > 0 && rows.every((r, i) => r === allRows[i]), "rows are dropped oldest-first: the newest rows stay, in order");

console.log("--- status that fits the title ---");
{
	const chart = buildWtftLines(ix.slice(0, 2), settings, { limit: 10, isWidget: true })!;
	const lines = widgetLines(chart, " ●", 60, []);
	check(lines.length === chart.length && plain(lines[0]!).endsWith(" ●"), "a short status joins the title line");
}

console.log("--- nothing fits ---");
{
	const huge = () => Array.from({ length: 30 }, (_, i) => `line ${i}`);
	const lines = fitWidget(huge, 10)!;
	check(lines.length === 10 && lines[0] === "line 0", "when even one row overflows, the first 10 lines are kept");
	check(fitWidget(() => null, 10) === null, "no chart stays no chart");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

#!/usr/bin/env -S bun
/**
 * The Cache Miss divider sits directly below the missed row: rows are
 * newest-first, so "below" is "before in time" — between the missed turn and
 * the older turns whose cache it could not reuse.
 */

import { buildWtftLines } from "../extensions/lib/wtft-renderer.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const HOUR = 3600000;

function ix(ts: number, cacheMiss = false) {
	return {
		timestamp: ts, cost: 1.0, model: "claude-opus-5",
		inputTokens: 2, outputTokens: 500, cacheReadTokens: cacheMiss ? 0 : 40000, cacheWriteTokens: cacheMiss ? 40000 : 0,
		cacheMiss, reasoningTokens: 0, webSearchRequests: 0, webFetchRequests: 0, serverToolCost: 0,
		files: [{ path: "/tmp/spec.md", action: "read" as const }], commands: [], texts: [],
	};
}

function render(interactions: any[], opts: { limit?: number; showTicks?: boolean } = {}) {
	const settings = { interval: "1h", limit: opts.limit ?? 100, width: 100, showTicks: opts.showTicks ?? false,
		mode: "bucket" as const, timezone: "UTC", disabledEmoji: true };
	const lines = (buildWtftLines(interactions as any, settings, { ...settings }) as string[])
		.map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));
	const rowOf = (hhmm: string) => lines.findIndex(l => l.trimStart().startsWith(hhmm));
	const divider = lines.findIndex(l => l.includes("Cache Miss"));
	return { lines, rowOf, divider };
}

// ---
// PART A — the idle-gap shape from the issue
// ---
console.log("\nPART A — the divider sits between the missed row and the older one");
{
	const day = Date.UTC(2026, 8, 22);
	const { lines, rowOf, divider } = render([ix(day + 3 * HOUR), ix(day + 7 * HOUR, true), ix(day + 8 * HOUR)]);
	const missed = rowOf("07:00"), older = rowOf("03:00"), newer = rowOf("08:00");
	check(missed > newer && older > missed, `A0 fixture precondition: rows are newest-first (08:00 ${newer}, 07:00 ${missed}, 03:00 ${older})`);
	check(divider === missed + 1, `A1 the divider is the line directly below the missed row (divider ${divider}, missed row ${missed})\n${lines.join("\n")}`);
	check(divider < older, "A2 and above the older row");
}

// ---
// PART B — the missed row is the last one shown
// ---
console.log("\nPART B — a limit cuts the older rows off");
{
	const day = Date.UTC(2026, 8, 22);
	const { rowOf, divider, lines } = render([ix(day + 3 * HOUR), ix(day + 7 * HOUR, true), ix(day + 8 * HOUR)], { limit: 2 });
	const missed = rowOf("07:00");
	check(missed >= 0 && rowOf("03:00") === -1, `B0 fixture precondition: the missed row is the last shown (07:00 at ${missed}, 03:00 cut)`);
	check(divider === missed + 1, `B1 the divider still follows the missed row (divider ${divider}, missed row ${missed})\n${lines.join("\n")}`);
}

// ---
// PART C — a date change right below the missed row
// ---
console.log("\nPART C — the missed row is the first of its day");
{
	const day2 = Date.UTC(2026, 8, 23);
	const { lines, rowOf, divider } = render([ix(day2 - 1 * HOUR), ix(day2 + 8 * HOUR + 48 * 60000, true)], { showTicks: true });
	const missed = rowOf("08:00"), older = rowOf("23:00");
	const dateLine = lines.findIndex((l, i) => i > missed && /Sep-22/.test(l));
	check(missed >= 0 && older > missed && dateLine > missed, `C0 fixture precondition: the older row is on the previous day, under its date divider (08:00 ${missed}, Sep-22 ${dateLine}, 23:00 ${older})`);
	check(divider === missed + 1, `C1 the Cache Miss divider comes directly below the missed row, before the older day's date divider (divider ${divider}, date ${dateLine})\n${lines.join("\n")}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

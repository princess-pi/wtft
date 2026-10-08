#!/usr/bin/env bun
/**
 * The title line's timeline strip describes the session on screen, not the host clock.
 * Spec: docs/spec-19-timeline-session-day.md.
 */

import { buildWtftLines } from "../extensions/lib/wtft-renderer.ts";
import { DEEPSEEK_WEEKEND_OFFPEAK_FROM } from "../extensions/lib/wtft-cost.ts";
import type { Interaction } from "../extensions/lib/wtft-parser.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const HOUR = 3_600_000;
const SATURDAY = Date.UTC(2026, 9, 3);
const WEDNESDAY = Date.UTC(2026, 8, 30);
const MONDAY_NOON = Date.UTC(2026, 9, 5, 12);
const SATURDAY_NOON = Date.UTC(2026, 9, 10, 12);
const MONDAY_IN_SURGE = Date.UTC(2026, 9, 5, 7, 30);

function turn(at: number, id: string): Interaction {
	return {
		timestamp: at, cost: 0.5, messageId: id, model: "deepseek-v4-pro",
		inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
		webSearchRequests: 0, webFetchRequests: 0, serverToolCost: 0,
		files: [], commands: [], texts: ["t"],
	} as Interaction;
}

function session(day: number): Interaction[] {
	return [turn(day + 5 * HOUR, "a"), turn(day + 12 * HOUR, "b"), turn(day + 15 * HOUR, "c")];
}

const SETTINGS = { interval: "1h", limit: 30, width: 200, mode: "cumulative" as const, timezone: "UTC", disabledEmoji: true };

/** The title line, rendered with the clock at `now`. */
function title(interactions: Interaction[], now: number, extra: Record<string, unknown> = {}): string {
	const realNow = Date.now;
	Date.now = () => now;
	try {
		const lines = buildWtftLines(interactions, SETTINGS, { ...SETTINGS, ...extra } as never);
		return lines?.[0] ?? "";
	} finally {
		Date.now = realNow;
	}
}

/** Local hours drawn in the surge colour; the noon glyph is not an hour. */
function surgeHours(line: string): number[] {
	const glyphs: boolean[] = [];
	for (const m of line.matchAll(/\x1b\[([0-9;]*)m([^\x1b]*)\x1b\[0m/g)) {
		const [, color, text] = m;
		if (!/^(1;)?(32|38;5;208)$/.test(color)) continue;
		for (const _ of Array.from(text)) glyphs.push(color.endsWith("208"));
	}
	glyphs.length = Math.min(glyphs.length, 25);
	glyphs.splice(12, 1);
	return glyphs.flatMap((orange, hour) => orange ? [hour] : []);
}

const badge = (line: string) => /SURGE|APPROACHING|ENDING/.test(line);

console.log("V1 a Saturday session");
{
	check(new Date(SATURDAY).getUTCDay() === 6 && SATURDAY >= DEEPSEEK_WEEKEND_OFFPEAK_FROM, "fixture precondition: the session day is a Saturday under the weekend rule");
	check(new Date(MONDAY_NOON).getUTCDay() === 1 && new Date(SATURDAY_NOON).getUTCDay() === 6, "fixture precondition: read on a Monday and on a Saturday");
	const onMonday = title(session(SATURDAY), MONDAY_NOON);
	const onSaturday = title(session(SATURDAY), SATURDAY_NOON);
	check(surgeHours(onMonday).length === 0, `no surge hours read on a Monday (got ${surgeHours(onMonday)})`);
	check(!badge(onMonday), "no badge read on a Monday");
	check(onMonday === onSaturday, "the same title line read on a Monday and on a Saturday");
}

console.log("\nV2 a Wednesday session read on a Monday");
{
	check(new Date(WEDNESDAY).getUTCDay() === 3, "fixture precondition: the session day is a Wednesday");
	const line = title(session(WEDNESDAY), MONDAY_IN_SURGE);
	check(surgeHours(line).join(",") === "1,2,3,6,7,8,9", `surge hours 01-03 and 06-09 UTC (got ${surgeHours(line)})`);
	check(!badge(line), "no badge, though the clock reads inside a surge window");
}

console.log("\nV3 a live view");
{
	const line = title(session(WEDNESDAY), MONDAY_IN_SURGE, { live: true });
	check(badge(line), "the caller saying live shows the badge during a surge window");
	const current = title([turn(MONDAY_IN_SURGE - 20 * 60_000, "now")], MONDAY_IN_SURGE);
	check(badge(current), "a newest interaction in the current hour is live without the caller saying so");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

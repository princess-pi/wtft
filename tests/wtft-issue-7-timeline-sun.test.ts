#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test wtft-issue-7-timeline-sun
 * @description The timeline's ☀️ marker must mark solar noon as a SEPARATE
 *   glyph, not by consuming hour 12's slot. The bug (#7) made the noon hour
 *   (12:00p–12:59p) unconditionally render ☀️ instead of a `─`/clock face, so
 *   the timeline had 23 hour-positions (12 left / 11 right) and showed no clock
 *   face during the noon hour. Fixed: 24 hour-slots, 12 either side of the sun,
 *   and hour 12 shows 🕛 when it is the current hour.
 */
import * as assert from "node:assert";
import { buildTimelineString } from "../bin/wtft.mjs";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
let passed = 0;
let failed = 0;

function check(label: string, fn: () => void) {
	try {
		fn();
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} catch (err) {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		console.log(`       ${(err as Error).message.split("\n")[0]}`);
		failed++;
	}
}

const ANSI = /\x1b\[[0-9;]*m/g;
// Hour glyphs are `─` (box-drawing) or a clock face 🕐–🕛 (U+1F550–U+1F55B).
const CLOCK_FACES = /[\u{1F550}-\u{1F55B}]/gu;

function hourGlyphCount(s: string): number {
	return (s.match(/─/g) ?? []).length + (s.match(CLOCK_FACES) ?? []).length;
}

function timeline(surgeHours: number[], currentHour: number): string {
	return buildTimelineString(new Set(surgeHours), currentHour).replace(ANSI, "");
}

console.log("=== RUNNING WTFT ISSUE #7 TIMELINE SUN TESTS ===");

// ---
// 1. Structure: 24 hour-slots total, 12 left of the sun, 12 right.
// ---
for (const currentHour of [0, 3, 12, 15, 23]) {
	check(`24 hour-slots with 12 left / 12 right of ☀️ at currentHour=${currentHour}`, () => {
		const t = timeline([], currentHour);
		assert.strictEqual(hourGlyphCount(t), 24, "expected 24 hour glyphs total");

		const sunIdx = t.indexOf("☀️");
		assert.ok(sunIdx !== -1, "expected a ☀️ sun glyph");
		const left = t.slice(0, sunIdx);
		const right = t.slice(sunIdx + "☀️".length);
		assert.strictEqual(hourGlyphCount(left), 12, `expected 12 hour glyphs left of the sun, got ${hourGlyphCount(left)}`);
		assert.strictEqual(hourGlyphCount(right), 12, `expected 12 hour glyphs right of the sun, got ${hourGlyphCount(right)}`);
	});
}

// ---
// 2. The noon hour shows a clock face, not a lost slot.
// ---
check("currentHour=12 renders 🕛 (the noon hour keeps its clock face)", () => {
	const t = timeline([], 12);
	const sunIdx = t.indexOf("☀️");
	const right = t.slice(sunIdx + "☀️".length);
	assert.ok(right.includes("🕛"), `expected 🕛 to the right of the sun, got: ${right}`);
});

// ---
// 3. The current-hour clock face is present for a non-noon hour too.
// ---
check("currentHour=3 renders 🕒 to the left of the sun", () => {
	const t = timeline([], 3);
	const sunIdx = t.indexOf("☀️");
	const left = t.slice(0, sunIdx);
	assert.ok(left.includes("🕒"), `expected 🕒 to the left of the sun, got: ${left}`);
});

// ---
// 4. Surge coloring still reaches the noon boundary (no throw, sun present).
// ---
check("surgeHours=[12] still renders a sun and 24 hour-slots", () => {
	const t = timeline([12], 0);
	assert.strictEqual(hourGlyphCount(t), 24);
	assert.ok(t.includes("☀️"), "expected a ☀️ sun glyph");
});

console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

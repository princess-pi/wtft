#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test wtft-timeline-24h
 * @description Full-spec gate for buildTimelineString's 24-hour SURGE timeline.
 *
 *   The timeline is one line: moon bookend, 12 hour-glyphs (hours 0-11), the
 *   noon sun, 12 hour-glyphs (hours 12-23), moon bookend. One of the 24 hour
 *   glyphs is a clock face — the current hour, replaced with the face whose
 *   o'clock equals `hour % 12`. Every glyph carries a color: green (32) normal,
 *   orange (38;5;208) surge, bold when it is the current hour.
 *
 *   The existing suites each own one fact (#7: the sun is a 25th glyph, not a
 *   stolen hour slot; #62: no-emoji swaps to ASCII; #64: visual width; #495:
 *   which hours surge). None of them pins the WHOLE mapping — which clock face
 *   for which hour, on which side of the sun, in which color. That is the spec
 *   a rendering regression can drift without failing any one-fact suite, and it
 *   is deliberately NOT an emoji-width question (#64 already owns that).
 *
 *   Two sections:
 *     1. Structure (ANSI stripped): for every hour 0-23, the clock face is the
 *        correct emoji, on the correct side of the sun, with 24 hour-slots and
 *        moon bookends.
 *     2. Full sequence: parse the RAW string back into (glyph, color) pairs and
 *        assert the exact 25-glyph sequence (24 hours + sun) against the spec,
 *        for a realistic DeepSeek surge set. This pins placement AND coloring
 *        in one deep-equality check.
 *
 *   Imports the SOURCE renderer (bun resolves the .ts graph directly) so
 *   red→green needs no build step.
 */

import * as assert from "node:assert";
import { buildTimelineString } from "../extensions/lib/wtft-renderer.ts";

const CLOCK_FACES = ["🕛","🕐","🕑","🕒","🕓","🕔","🕕","🕖","🕗","🕘","🕙","🕚"];
const SUN = "☀️";
const DASH = "─";

const ANSI = /\x1b\[[0-9;]*m/g;
// Each colored body segment is `\x1b[<color>m<text>\x1b[0m`.
const SEGMENT_RE = /\x1b\[([0-9;]*)m([^\x1b]*)\x1b\[0m/g;
// Hour glyphs are `─` or a clock face 🕐–🕛 (U+1F550–U+1F55B).
const CLOCK_RE = /[\u{1F550}-\u{1F55B}]/gu;

// Realistic DeepSeek peak windows expressed as local hours (UTC tz):
// 01:00–04:00 → hours 1,2,3; 06:00–10:00 → hours 6,7,8,9.
const SURGE_HOURS = [1, 2, 3, 6, 7, 8, 9];

// Pin the date so the moon-phase bookend is deterministic across runs.
const FIXED_DATE = new Date("2026-09-03T12:00:00Z");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
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
		console.log(`       ${(err as Error).message.split("\n").join("\n       ")}`);
		failed++;
	}
}

function stripAnsi(s: string): string {
	return s.replace(ANSI, "");
}

function isMoon(ch: string): boolean {
	const cp = ch.codePointAt(0)!;
	return cp >= 0x1f311 && cp <= 0x1f318;
}

function hourGlyphCount(s: string): number {
	return (s.match(/─/g) ?? []).length + (s.match(CLOCK_RE) ?? []).length;
}

// ---
// Section 2 helpers: turn the raw string back into the exact glyph sequence.
// The sun ☀️ is U+2600 + U+FE0F (two code points) and must count as ONE glyph;
// every other glyph is a single code point.
// ---
function splitGlyphs(text: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		if (text.startsWith(SUN, i)) {
			out.push(SUN);
			i += SUN.length;
			continue;
		}
		const cp = text.codePointAt(i)!;
		const one = String.fromCodePoint(cp);
		out.push(one);
		i += one.length;
	}
	return out;
}

function coloredGlyphs(raw: string): { glyph: string; color: string }[] {
	const out: { glyph: string; color: string }[] = [];
	for (const m of raw.matchAll(SEGMENT_RE)) {
		for (const g of splitGlyphs(m[2])) {
			out.push({ glyph: g, color: m[1] });
		}
	}
	return out;
}

function expectedColor(isSurge: boolean, isCurrent: boolean): string {
	return isCurrent
		? (isSurge ? "1;38;5;208" : "1;32")
		: (isSurge ? "38;5;208" : "32");
}

function expectedSequence(surge: Set<number>, currentHour: number) {
	const seq: { glyph: string; color: string }[] = [];
	for (let h = 0; h < 24; h++) {
		const isCurrent = h === currentHour;
		const isSurge = surge.has(h);
		seq.push({
			glyph: isCurrent ? CLOCK_FACES[h % 12] : DASH,
			color: expectedColor(isSurge, isCurrent),
		});
	}
	// The sun is a 25th glyph between hour 11 and hour 12, borrowing hour 12's
	// surge color and never itself the current marker.
	seq.splice(12, 0, { glyph: SUN, color: surge.has(12) ? "38;5;208" : "32" });
	return seq;
}

console.log("\n=== WTFT TIMELINE 24H (FULL SPEC) ===");

// ---
// 1. Structure: moon bookends, 24 hour-slots, sun, correct clock face, correct side.
// ---
for (let h = 0; h < 24; h++) {
	check(`hour ${String(h).padStart(2, "0")}: clock face ${CLOCK_FACES[h % 12]} on the ${h < 12 ? "first" : "second"} 12`, () => {
		const t = stripAnsi(buildTimelineString(new Set(), h, undefined, FIXED_DATE));

		const cps = Array.from(t);
		assert.ok(isMoon(cps[0]), `expected a moon bookend at the start, got: ${t.slice(0, 4)}`);
		assert.ok(isMoon(cps[cps.length - 1]), `expected a moon bookend at the end, got: ${t.slice(-4)}`);

		assert.strictEqual(hourGlyphCount(t), 24, "expected 24 hour glyphs total");

		const sunIdx = t.indexOf(SUN);
		assert.ok(sunIdx !== -1, "expected a ☀️ sun glyph");
		const left = t.slice(0, sunIdx);
		const right = t.slice(sunIdx + SUN.length);
		assert.strictEqual(hourGlyphCount(left), 12, "expected 12 hour glyphs left of the sun");
		assert.strictEqual(hourGlyphCount(right), 12, "expected 12 hour glyphs right of the sun");

		assert.strictEqual((t.match(CLOCK_RE) ?? []).length, 1, "expected exactly one clock face");
		const expected = CLOCK_FACES[h % 12];
		const clockIdx = t.indexOf(expected);
		assert.ok(clockIdx !== -1, `expected clock face ${expected}, got: ${t}`);

		const onLeft = clockIdx < sunIdx;
		assert.strictEqual(onLeft, h < 12, `expected the clock face ${h < 12 ? "left" : "right"} of the sun`);
	});
}

// ---
// 2. Full sequence: exact (glyph, color) equality for a realistic surge set.
//    Covers the "moon +12 dashes, sun +12 dashes, clock face at the current
//    hour, surge hours orange" spec in one deep-equality assertion.
// ---
const surge = new Set(SURGE_HOURS);
for (const h of [0, 3, 12, 15, 23]) {
	check(`full sequence for currentHour=${h} with surge ${SURGE_HOURS.join(",")}`, () => {
		const raw = buildTimelineString(surge, h, undefined, FIXED_DATE);
		assert.deepStrictEqual(coloredGlyphs(raw), expectedSequence(surge, h));
	});
}

console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

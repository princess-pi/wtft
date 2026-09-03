#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test wtft-62-no-emoji-timeline
 * @description The SURGE timeline honors `disabledEmoji` (#62).
 *
 *   `docs/manifests/wtft-cmd.json` promises that `--no-emoji` swaps emoji for
 *   "clean single-width ASCII characters", but the timeline never did: it
 *   always emitted moon bookends (🌑–🌘), the noon sun (☀️) and the current-hour
 *   clock face (🕐–🕛). On a terminal whose font lacks the clock-face range the
 *   current-hour marker renders as a blank gap, which reads as a missing slot.
 *
 *   No-emoji mapping (single-width ASCII, colours/surge logic unchanged):
 *     moon → `|`    sun → `*`    current hour → `@`
 *
 *   This suite owns two facts: the no-emoji timeline carries none of the emoji
 *   code points AND keeps the 12-left / 12-right layout from #7; and the emoji
 *   timeline is unchanged (regression guard). It imports the SOURCE renderer
 *   (bun resolves the .ts graph directly) so red→green needs no build step.
 */

import * as assert from "node:assert";
import { buildTimelineString } from "../extensions/lib/wtft-renderer.ts";

const ANSI = /\x1b\[[0-9;]*m/g;

function timeline(currentHour: number, disabledEmoji: boolean): string {
	return buildTimelineString(new Set(), currentHour, undefined, undefined, disabledEmoji).replace(ANSI, "");
}

// Emoji code points the timeline uses: moon (U+1F311–1F318), clock (U+1F550–1F55B),
// sun (U+2600 + U+FE0F).
const TIMELINE_EMOJI = /[\u{1F311}-\u{1F318}\u{1F550}-\u{1F55B}\u2600\uFE0F]/u;

// Hour glyphs on the no-emoji timeline: `─` or the `@` current marker.
function hourGlyphCount(s: string): number {
	return (s.match(/─/g) ?? []).length + (s.match(/@/g) ?? []).length;
}

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

console.log("\n=== WTFT #62 NO-EMOJI TIMELINE ===");

// ---
// 1. disabledEmoji=true: no emoji code points, ASCII markers, 12-12 layout.
// ---
for (const currentHour of [0, 3, 12, 13, 23]) {
	check(`no-emoji currentHour=${currentHour}: ASCII markers, no emoji, 12 left / 12 right of *`, () => {
		const t = timeline(currentHour, true);
		assert.ok(!TIMELINE_EMOJI.test(t), `still contains an emoji: ${t}`);
		assert.ok(t.startsWith("|") && t.endsWith("|"), `expected | bookends, got: ${t}`);

		const sunIdx = t.indexOf("*");
		assert.ok(sunIdx !== -1, `expected a * sun marker, got: ${t}`);
		const left = t.slice(0, sunIdx);
		const right = t.slice(sunIdx + 1);
		assert.strictEqual(hourGlyphCount(left), 12, `expected 12 hour glyphs left of *, got ${hourGlyphCount(left)}: ${left}`);
		assert.strictEqual(hourGlyphCount(right), 12, `expected 12 hour glyphs right of *, got ${hourGlyphCount(right)}: ${right}`);
	});
}

// ---
// 2. The current hour is the @ marker, positioned right of the sun at noon.
// ---
check("no-emoji currentHour=12 puts @ immediately right of the sun", () => {
	const t = timeline(12, true);
	const sunIdx = t.indexOf("*");
	assert.strictEqual(t[sunIdx + 1], "@", `expected @ right after *, got: ${t}`);
});

check("no-emoji currentHour=3 puts @ left of the sun", () => {
	const t = timeline(3, true);
	const sunIdx = t.indexOf("*");
	assert.ok(t.slice(0, sunIdx).includes("@"), `expected @ left of *, got: ${t}`);
});

// ---
// 3. Regression guard: emoji mode is unchanged.
// ---
check("emoji mode still renders ☀️ and the clock face (no regression)", () => {
	const t = timeline(13, false);
	assert.ok(t.includes("☀️"), `expected ☀️ sun, got: ${t}`);
	assert.ok(/[\u{1F550}-\u{1F55B}]/u.test(t), `expected a clock face, got: ${t}`);
});

console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

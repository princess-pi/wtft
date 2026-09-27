/**
 * The timeline takes its two bookends and its noon glyph as arguments.
 * The chart asks for the moon at the two local midnights of the strip's day.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTimelineString, getMoonPhase } from "../extensions/lib/wtft-renderer.ts";
import { stripMidnights, timelineGlyphs } from "../extensions/lib/wtft-chart.ts";

const ANSI = /\x1b\[[0-9;]*m/g;

function plain(raw: string): string {
	return raw.replace(ANSI, "");
}

describe("#314 timeline bookends are arguments", () => {
	it("places the three glyphs and leaves the clock face inside the strip", () => {
		const raw = buildTimelineString(new Set(), 13, "🌑", "🌒", "☀️");
		const text = plain(raw);
		assert.equal(text.startsWith("🌑"), true);
		const sunAt = text.indexOf("☀️");
		const left = text.slice(0, sunAt);
		const right = text.slice(sunAt + "☀️".length);
		const hours = (s: string) => (s.match(/─/g) ?? []).length + (s.match(/[\u{1F550}-\u{1F55B}]/gu) ?? []).length;
		assert.equal(hours(left), 12);
		assert.equal(hours(right.replace(/🌒$/, "")), 12);
		assert.equal(text.endsWith("🌒"), true);
		assert.ok(text.includes("🕐"));
	});

	it("uses the no-emoji glyphs the caller passes", () => {
		const text = plain(buildTimelineString(new Set(), 0, "|", "|", "*", undefined, true));
		assert.equal(text.startsWith("|"), true);
		assert.equal(text.endsWith("|"), true);
		assert.ok(text.includes("*"));
		assert.equal(text.includes("☀️"), false);
	});

	it("shows a different moon at the end when the next midnight is a new phase", () => {
		let found: { now: number; start: string; end: string } | undefined;
		for (let day = 0; day < 40; day++) {
			const now = Date.UTC(2026, 0, 1 + day, 12, 0, 0);
			const { start, end } = stripMidnights(now, "UTC");
			const startGlyph = getMoonPhase(start);
			const endGlyph = getMoonPhase(end);
			if (startGlyph !== endGlyph) {
				found = { now, start: startGlyph, end: endGlyph };
				break;
			}
		}
		assert.ok(found, "a phase boundary falls between two UTC midnights");
		const glyphs = timelineGlyphs(found.now, "UTC", false);
		assert.equal(glyphs.start, found.start);
		assert.equal(glyphs.end, found.end);
		assert.equal(glyphs.noon, "☀️");
		assert.notEqual(glyphs.start, glyphs.end);
		const rendered = plain(buildTimelineString(
			new Set(), 12, glyphs.start, glyphs.end, glyphs.noon,
		));
		assert.equal(rendered.startsWith(glyphs.start), true);
		assert.equal(rendered.endsWith(glyphs.end), true);
		const off = timelineGlyphs(found.now, "UTC", true);
		assert.deepEqual(off, { start: "|", end: "|", noon: "*" });
	});
});

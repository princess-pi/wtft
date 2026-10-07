/**
 * Running-total bars draw earlier bins as █ and this bin as ✨ on a dark shade, cost and tokens alike.
 * artifacts/chart-spec/spec.mdx § Encoding law.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Category, Interaction } from "../extensions/lib/wtft-parser.ts";
import { buildWtftLines, CATEGORY_STYLE } from "../extensions/lib/wtft-renderer.ts";
import { sparkleBackground } from "../extensions/lib/wtft-chart.ts";
import { stripAnsi } from "../artifacts/renderer/ansi.ts";
import { cellsHtml } from "../artifacts/assets/cell-glyphs.mjs";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 26, 10);
const NOW = T0 + 3 * HOUR;

function turn(at: number, cat: Category, cost: number, tokens: number): Interaction {
	return {
		timestamp: at, cost, model: "claude-sonnet-5-5",
		inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
		webSearchRequests: 0, webFetchRequests: 0, serverToolCost: 0,
		files: [], commands: [], texts: [], _cat: cat,
	} as Interaction;
}

function chart(interactions: Interaction[], mode: "cumulative" | "bucket", unit: "cost" | "tokens", disabledEmoji = false): string[] {
	const stdout = process.stdout as { columns?: number };
	const realColumns = stdout.columns;
	const realNow = Date.now;
	stdout.columns = 160;
	Date.now = () => NOW;
	try {
		return buildWtftLines(interactions, { interval: "1h", limit: 10, width: 158, mode, timezone: "UTC", disabledEmoji }, {
			width: 158, interval: "1h", limit: 10, mode, timezone: "UTC", unit, showCostColumns: true, showTokenColumns: true,
		}) ?? [];
	} finally {
		Date.now = realNow;
		stdout.columns = realColumns;
	}
}

interface Run { cat: Category; sparkle: boolean; text: string; cells: number }

const catOfFg = (fg: number) => (Object.keys(CATEGORY_STYLE) as Category[]).find((c) => CATEGORY_STYLE[c].fg === fg)!;
const catOfBg = (rgb: string) => (Object.keys(CATEGORY_STYLE) as Category[]).find((c) => sparkleBackground(CATEGORY_STYLE[c].fg).join(";") === rgb)!;

/** The bar of the row labelled `label`, as coloured runs in drawing order. */
function bar(lines: string[], label: string): Run[] {
	const line = lines.find((l) => stripAnsi(l).startsWith(label));
	assert.ok(line, `no ${label} row in:\n${lines.map(stripAnsi).join("\n")}`);
	const runs: Run[] = [];
	for (const m of line.matchAll(/\x1b\[(?:38;5;(\d+)|48;2;(\d+;\d+;\d+))m([█✨*]+)\x1b\[0m/g)) {
		const sparkle = m[2] !== undefined;
		runs.push({ cat: sparkle ? catOfBg(m[2]) : catOfFg(Number(m[1])), sparkle, text: m[3], cells: [...m[3]].reduce((n, ch) => n + (ch === "✨" ? 2 : 1), 0) });
	}
	return runs;
}

const cellsOf = (runs: Run[], cat: Category, sparkle: boolean) => runs.filter((r) => r.cat === cat && r.sparkle === sparkle).reduce((n, r) => n + r.cells, 0);

describe("a running-total bar, cost or tokens", () => {
	for (const unit of ["cost", "tokens"] as const) {
		it(`${unit}: draws a category's earlier bins as █, then its share new this bin as ✨`, () => {
			const lines = chart([turn(T0, "code", 1, 100_000), turn(T0 + HOUR, "plan", 1, 100_000)], "cumulative", unit);
			const newest = bar(lines, "11:00");
			assert.ok(cellsOf(newest, "code", false) > 0 && cellsOf(newest, "plan", false) + cellsOf(newest, "plan", true) > 0, "both categories drawn");
			assert.equal(cellsOf(newest, "code", true), 0, "code spent nothing at 11:00");
			assert.ok(cellsOf(newest, "plan", true) > 0, "plan spent everything at 11:00");
			const planRuns = newest.filter((r) => r.cat === "plan");
			assert.ok(planRuns.findIndex((r) => r.sparkle) >= planRuns.length - 1, "✨ comes after the category's █");
			const first = bar(lines, "10:00");
			assert.ok(cellsOf(first, "code", false) <= 1 && cellsOf(first, "code", true) > 0, "the first bin is all new: ✨, and one █ when the segment is odd");
		});

		it(`${unit}: a sliver new this bin still gets one ✨`, () => {
			const runs = bar(chart([turn(T0, "code", 99, 990_000), turn(T0 + HOUR, "code", 1, 10_000)], "cumulative", unit), "11:00");
			assert.ok(cellsOf(runs, "code", false) >= 10, "precondition: a long segment");
			assert.equal(runs.filter((r) => r.sparkle).map((r) => r.text).join(""), "✨");
		});

		it(`${unit}: the ✨ run is even and close to the share new this bin`, () => {
			const runs = bar(chart([turn(T0, "code", 1, 100_000), turn(T0 + HOUR, "code", 1, 100_000)], "cumulative", unit), "11:00");
			const fresh = cellsOf(runs, "code", true);
			const all = fresh + cellsOf(runs, "code", false);
			assert.ok(all >= 20, "precondition: a long segment");
			assert.equal(fresh % 2, 0);
			assert.ok(Math.abs(fresh - all / 2) <= 1, `${fresh} of ${all}`);
		});

		it(`${unit}: a bucket bar draws no ✨`, () => {
			const lines = chart([turn(T0, "code", 1, 100_000), turn(T0 + HOUR, "plan", 1, 100_000)], "bucket", unit);
			assert.ok(!lines.some((l) => l.includes("✨")));
		});

		it(`${unit}: --no-emoji draws * on the same background, and ** in the key`, () => {
			const lines = chart([turn(T0, "code", 1, 100_000), turn(T0 + HOUR, "code", 1, 100_000)], "cumulative", unit, true);
			const fresh = bar(lines, "11:00").filter((r) => r.sparkle);
			assert.equal(fresh.length, 1);
			assert.equal(fresh[0].cat, "code");
			assert.match(fresh[0].text, /^(\*\*)+$/);
			assert.ok(lines.map(stripAnsi).some((l) => l.trim() === "█ earlier bins  ** this bin"));
		});
	}

	it("tokens: a one-cell segment draws █ even when it is new this bin", () => {
		const runs = bar(chart([turn(T0, "code", 1, 1_000_000), turn(T0 + HOUR, "plan", 0.01, 6_000)], "cumulative", "tokens"), "11:00");
		assert.equal(cellsOf(runs, "plan", false) + cellsOf(runs, "plan", true), 1, "precondition: plan holds one cell");
		assert.equal(cellsOf(runs, "plan", false), 1);
	});
});

describe("the key", () => {
	for (const disabledEmoji of [false, true]) {
		const glyph = disabledEmoji ? "**" : "✨";
		it(`draws this bin's ${glyph} on the earlier-bins swatch's hue, as the bars draw it`, () => {
			const lines = chart([turn(T0, "code", 1, 100_000), turn(T0 + HOUR, "code", 1, 100_000)], "cumulative", "cost", disabledEmoji);
			const key = lines.find((l) => stripAnsi(l).includes("earlier bins"));
			assert.ok(key, "fixture precondition: a running-total chart draws the key");
			assert.ok(key.includes("\x1b[37m█"), "fixture precondition: the earlier-bins swatch is palette entry 7");
			assert.ok(key.includes(`\x1b[48;2;${sparkleBackground(7).join(";")}m${glyph}\x1b[0m`), JSON.stringify(key));
		});
	}
});

describe("sparkleBackground", () => {
	const linear = (rgb: number[]) => rgb.map((c) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	const luminance = (rgb: number[]) => { const [r, g, b] = linear(rgb); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
	const PALETTE: [number, number[]][] = [[75, [95, 175, 255]], [209, [255, 135, 95]], [149, [175, 215, 95]], [245, [138, 138, 138]]];

	it("keeps each colour's hue, at one luminance for every colour, darker than the colour", () => {
		const shades = PALETTE.map(([n]) => sparkleBackground(n));
		const lums = shades.map(luminance);
		for (const l of lums) assert.ok(Math.abs(l - lums[0]) < 0.003, `${lums}`);
		PALETTE.forEach(([n, rgb], i) => {
			assert.ok(lums[i] < luminance(rgb), `${n} darker`);
			const want = linear(rgb), got = linear(shades[i]);
			const scale = lums[i] / luminance(rgb);
			for (let c = 0; c < 3; c++) assert.ok(Math.abs(got[c] - want[c] * scale) < 0.008, `${n} hue: ${shades[i]}`);
		});
	});
});

describe("sparkleBackground on black", () => {
	const luminance = (rgb: number[]) => {
		const [r, g, b] = rgb.map((c) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};

	it("brightens black to a grey at the luminance every other colour gets", () => {
		const target = luminance(sparkleBackground(245));
		for (const black of [0, 16]) {
			const shade = sparkleBackground(black);
			assert.ok(shade[0] === shade[1] && shade[1] === shade[2], `${black}: ${shade}`);
			assert.ok(Math.abs(luminance(shade) - target) < 0.003, `${black}: ${shade}`);
		}
	});
});

describe("cellsHtml", () => {
	it("paints ✨ as one cell exactly 2ch wide, filled with its run's background", () => {
		const html = cellsHtml("a✨b");
		assert.match(html, /^a<span style="[^"]*width:2ch;[^"]*background:inherit[^"]*">✨<\/span>b$/);
	});
});

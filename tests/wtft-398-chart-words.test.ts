/**
 * The chart takes its own words and category list. docs/spec-398-chart-words.md.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWtftLines } from "../extensions/lib/wtft-renderer.ts";
import type { ChartWords } from "../extensions/lib/wtft-chart.ts";
import { stripAnsi } from "../artifacts/renderer/ansi.ts";
import { wtftSession } from "../artifacts/renderer/fake-session.ts";
import { withTerminal } from "../artifacts/renderer/report.ts";

const NOW = Date.UTC(2026, 8, 26, 15, 30);
const interactions = wtftSession("claude-sonnet-5-5");
const SETTINGS = { interval: "1h", limit: 100, width: 158, mode: "cumulative" as const, timezone: undefined };

function chart(words?: ChartWords, opts: Record<string, unknown> = {}, columns = 200, rows = interactions) {
	return withTerminal(columns, NOW, () => buildWtftLines(rows, SETTINGS, {
		width: columns - 2, timezone: "UTC", limit: 8, padRowsTo: 8, words, ...opts,
	})) ?? [];
}
const plain = (lines: string[]) => lines.map(stripAnsi);

describe("words default to wtft's own", () => {
	it("an empty words object draws what no words draw", () => {
		for (const unit of ["cost", "tokens"] as const) {
			for (const mode of ["cumulative", "bucket"] as const) {
				assert.deepEqual(chart({}, { unit, mode }), chart(undefined, { unit, mode }), `${unit} ${mode}`);
			}
		}
	});
});

describe("each word replaces one thing", () => {
	it("title replaces the first line's name and keeps the session suffix", () => {
		const first = plain(chart({ title: "Booth 42" }, { sessionNameSuffix: "booth-0042.jsonl" }))[0];
		assert.match(first, /^Booth 42 \.\.\.0042/);
		assert.doesNotMatch(first, /WTF Tokens/);
	});

	it("categories name and colour the legend and the bars, in the caller's order, and leave a slot out of the legend when it is unlisted or labelled null", () => {
		const lines = chart({ categories: [
			{ slot: "code", label: "Lattes", fg: 196 },
			{ slot: "plan", label: "Apples", fg: 46 },
		] });
		const legend = lines[1];
		assert.ok(legend.startsWith("\x1b[38;5;196m█\x1b[0mLattes \x1b[38;5;46m█\x1b[0mApples"), legend);
		assert.doesNotMatch(stripAnsi(legend), /Ovrhd|Code|Plan/);
		const hidden = chart({ categories: [{ slot: "code", label: null, fg: 196 }, { slot: "plan", label: "Apples", fg: 46 }] })[1];
		assert.ok(hidden.startsWith("\x1b[38;5;46m█\x1b[0mApples"), hidden);
		assert.doesNotMatch(stripAnsi(hidden), /Waste|Other|Code/);
		assert.doesNotMatch(stripAnsi(legend), /Waste|Other/);
		assert.ok(lines.some((l) => l.includes("\x1b[38;5;196m█")));
	});

	it("tokenUnit names the units column, and its short form at the tightest compaction", () => {
		const wide = plain(chart({ tokenUnit: { name: "pcs", short: "p" } }))[3];
		assert.match(wide, / pcs\s/);
		assert.doesNotMatch(wide, / tok\b/);
		const narrow = plain(chart({ tokenUnit: { name: "pcs", short: "p" } }, { mode: "cumulative" }, 70)).filter((l) => /^\d\d:00 /.test(l)).join("\n");
		assert.match(narrow, /\d[kM]?p /);
		assert.doesNotMatch(narrow, / tok\b|\dt\b|pcs/);
	});

	it("currency replaces the dollar sign in amounts and scale labels", () => {
		const lines = plain(chart({ currency: "€" }, { unit: "cost" }));
		const rows = lines.filter((l) => /^\d\d:00 /.test(l));
		assert.ok(rows.length > 0 && rows.every((r) => r.includes("€") && !r.includes("$")));
		assert.match(lines[2], /€/);
		assert.doesNotMatch(lines[2], /\$/);
	});

	it("a categories list that is present is the whole legend, even empty", () => {
		assert.equal(stripAnsi(chart({ categories: [] })[1]), "");
		assert.equal(stripAnsi(chart({ categories: [{ slot: "bogus" as never, label: "Bogus", fg: 1 }] })[1]), "");
		assert.match(stripAnsi(chart({})[1]), /^█Ovrhd /);
	});

	it("a slot listed twice, or not one of the 14, changes nothing", () => {
		const one = chart({ categories: [{ slot: "code", label: "Lattes", fg: 196 }] });
		const messy = chart({ categories: [{ slot: "code", label: "Lattes", fg: 196 }, { slot: "code", label: "Again", fg: 46 }, { slot: "bogus" as never, label: "Bogus", fg: 1 }] });
		assert.deepEqual(messy, one);
	});

	it("currency with a dot keeps every scale label on its tick", () => {
		for (const currency of ["$", "Rs."]) {
			const lines = plain(chart({ currency }, { unit: "cost", limit: 40, padRowsTo: undefined }));
			const decimalPoints = [...lines[2].matchAll(/\d(\.)\d/g)].map((m) => m.index + 1);
			const divider = lines.find((l) => l.startsWith("── ") && l.includes("┼"))!;
			const ticks = [...divider.matchAll(/┼/g)].map((m) => m.index);
			assert.ok(decimalPoints.length >= 3, lines[2]);
			assert.ok(decimalPoints.every((p) => ticks.includes(p)), `${currency}: ${decimalPoints} not all on ${ticks}`);
		}
	});

	it("cacheMissLabel names the divider", () => {
		const lines = plain(chart({ cacheMissLabel: "Power cut" }));
		assert.ok(lines.some((l) => l.startsWith("── Power cut ")));
		assert.ok(!lines.some((l) => l.includes("Cache Miss")));
	});

	it("key words name the glyphs in a running-total token chart", () => {
		const lines = plain(chart({ key: { earlier: "sold earlier", thisBin: "sold now" } }, { unit: "tokens" }));
		assert.ok(lines.some((l) => l.trim() === "▃ sold earlier  ▇ sold now"), lines.join("\n"));
	});

	it("the footer and cache-line switches drop their lines", () => {
		const base = plain(chart({}, { unit: "tokens" }));
		assert.ok(base.some((l) => /^ {2}↑/.test(l)) && base.some((l) => l.includes("CH: ")));
		const off = plain(chart({ tokenFooter: false, cacheLine: false }, { unit: "tokens" }));
		assert.ok(!off.some((l) => /^ {2}↑/.test(l)) && !off.some((l) => l.includes("CH: ")));
	});

	it("otherWarning fills a template, or switches off", () => {
		const heavy = interactions.map((i) => ({ ...i, _cat: "other" as const, cost: i.cost * 40 }));
		const on = plain(chart({}, { unit: "cost" }, 200, heavy));
		const warning = on.find((l) => l.includes("category:"));
		assert.ok(warning, on.join("\n"));
		const templated = plain(chart({ otherWarning: "Souvenirs: {pct} of revenue ({cost})." }, { unit: "cost" }, 200, heavy));
		assert.ok(templated.some((l) => /^⚠️? +Souvenirs: \d+% of revenue \(\$[\d.]+\)\.$/.test(l)), templated.join("\n"));
		assert.ok(!plain(chart({ otherWarning: false }, { unit: "cost" }, 200, heavy)).some((l) => l.includes("Souvenirs") || l.includes("category:")));
	});
});

describe("a caller's own words leave none of wtft's", () => {
	it("draws a chart with no wtft word in it", () => {
		const words: ChartWords = {
			title: "Booth 42",
			categories: [
				{ slot: "code", label: "Lattes", fg: 196 },
				{ slot: "plan", label: "Apples", fg: 46 },
				{ slot: "other", label: "Souvenirs", fg: 245 },
			],
			tokenUnit: { name: "pcs", short: "p" },
			currency: "€",
			cacheMissLabel: "Power cut",
			key: { earlier: "sold earlier", thisBin: "sold now", costOnly: "no units" },
			tokenFooter: false,
			cacheLine: false,
			otherWarning: false,
		};
		const wtftWords = /WTF Tokens|Ovrhd|Waste|Plan\b|Spec\b|Research|Cmpct|Other|Web\b|Grep|Code\b|Tests|Git\b|Agents|Prompt|Cache Miss|cache hit|cached|carryover|earlier bins|this bin|\btok\b|\dt\b|CH:|web tools|\$/;
		const [first] = interactions;
		const rows = [...interactions, { ...first, timestamp: first.timestamp + 60_000, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 1, serverToolCost: 0.01, _cat: "web" as const }];
		for (const unit of ["cost", "tokens"] as const) {
			for (const mode of ["cumulative", "bucket"] as const) {
				const lines = plain(chart(words, { unit, mode, limit: 40, padRowsTo: undefined }, 200, rows));
				const at = `${unit} ${mode}`;
				assert.deepEqual(lines.filter((l) => wtftWords.test(l)), [], at);
				assert.ok(lines[0].startsWith("Booth 42"), at);
				assert.ok(lines[1].startsWith("█Lattes █Apples █Souvenirs"), at);
				assert.ok(lines.some((l) => l.startsWith("── Power cut ")), `${at} divider`);
				assert.ok(lines.some((l) => /^\d\d:00 .*€/.test(l)), `${at} currency`);
				if (unit === "tokens") {
					assert.ok(lines.some((l) => /^\d\d:00 .* pcs\s/.test(l)), `${at} unit`);
					assert.ok(lines.some((l) => l.trim() === "€ = no units" || l.trim().endsWith("€ = no units")), `${at} cost-only note`);
					if (mode === "cumulative") assert.ok(lines.some((l) => l.includes("▃ sold earlier  ▇ sold now")), `${at} key`);
				}
			}
		}
	});
});

describe("the fair page's word counts", () => {
	it("counts the units word at the tightest compaction too", async () => {
		const { renderFair, FAIR_DEFAULTS } = await import("../artifacts/renderer/fair.ts");
		const units = (columns: number, state: Partial<typeof FAIR_DEFAULTS> = {}) => renderFair({ ...FAIR_DEFAULTS, columns, unit: "tokens", now: Date.UTC(2026, 8, 13, 20, 30), ...state }).substitutions.find((w) => w.id === "units")!.count;
		assert.ok(units(160) > 0);
		assert.ok(units(70) > 0);
		assert.ok(units(160, { interval: "25t" }) > 0);
		assert.equal(units(160, { interval: "25t", showTokenColumns: false }), 0);
		assert.equal(units(70, { interval: "25t", showTokenColumns: false }), 0);
	});
});

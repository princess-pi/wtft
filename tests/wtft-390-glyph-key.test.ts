/**
 * The token chart's glyph key names what the glyphs encode. docs/spec-390-glyph-key.md.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWtftLines } from "../extensions/lib/wtft-renderer.ts";
import { stripAnsi } from "../artifacts/renderer/ansi.ts";
import { wtftSession } from "../artifacts/renderer/fake-session.ts";

const NOW = Date.UTC(2026, 8, 26, 15, 30);

function chart(mode: "cumulative" | "bucket", unit: "tokens" | "cost", interactions = wtftSession("claude-sonnet-5-5")) {
	const stdout = process.stdout as { columns?: number };
	const realColumns = stdout.columns;
	const realNow = Date.now;
	stdout.columns = 160;
	Date.now = () => NOW;
	try {
		return (buildWtftLines(interactions, { interval: "1h", limit: 100, width: 158, mode, timezone: undefined }, {
			width: 158, interval: "1h", limit: 100, mode, timezone: "UTC", unit, showCostColumns: true, showTokenColumns: true,
		}) ?? []).map(stripAnsi);
	} finally {
		Date.now = realNow;
		stdout.columns = realColumns;
	}
}

const keyLine = (lines: string[]) => lines.find((l) => /^ {2}(█|\$ =)/.test(l));

const withoutDollar = () => wtftSession("claude-sonnet-5-5").map((i) => ({ ...i, serverToolCost: 0 }));

const withDollar = () => {
	const [first] = wtftSession("claude-sonnet-5-5");
	return [{ ...first, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 1, serverToolCost: 0.01, _cat: "web" as const }];
};

describe("the glyph key", () => {
	it("in a cumulative chart, cost or tokens, names earlier bins and this bin, with no cache words", () => {
		for (const unit of ["tokens", "cost"] as const) {
			const key = keyLine(chart("cumulative", unit));
			assert.ok(key, unit);
			assert.match(key, /█ earlier bins {2}✨ this bin/, unit);
			assert.doesNotMatch(key, /cached|uncached|carryover/i, unit);
		}
	});

	it("does not print the █/✨ key in a bucket chart", () => {
		for (const unit of ["tokens", "cost"] as const) {
			const lines = chart("bucket", unit);
			assert.ok(!lines.some((l) => /^ {2}█/.test(l)), unit);
		}
	});

	it("prints the $ note when a $ is drawn, in cumulative and bucket token charts, and not otherwise", () => {
		for (const mode of ["cumulative", "bucket"] as const) {
			const drawn = chart(mode, "tokens", withDollar());
			assert.ok(drawn.some((l) => /^\d\d:00 .*\$$/.test(l.trimEnd())), `${mode} draws a $`);
			assert.match(keyLine(drawn) ?? "", /\$ = cost-only \(web tools\)/, mode);
			assert.ok(!/\$ = cost-only/.test(keyLine(chart(mode, "tokens", withoutDollar())) ?? ""), `${mode} without a $`);
		}
	});
});

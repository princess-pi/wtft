/**
 * One function turns parsed options into a chart call. docs/spec-389-chart-call.md.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { askedOf, chartLines, chartUnit } from "../extensions/lib/chart-call.ts";
import { buildWtftLines } from "../extensions/lib/wtft-renderer.ts";
import { parseWtftCliArgs } from "../extensions/lib/wtft-cli-shared.ts";
import { wtftSession } from "../artifacts/renderer/fake-session.ts";
import { withTerminal } from "../artifacts/renderer/report.ts";

const NOW = Date.UTC(2026, 8, 26, 15, 30);
const interactions = wtftSession("claude-sonnet-5-5");
const draw = (run: () => string[] | null) => withTerminal(200, NOW, run);
const base = { interactions, unit: "cost" as const, fallback: { width: 150 } };

describe("chartLines precedence: asked, then fallback, then default", () => {
	it("draws what buildWtftLines draws for the same resolved values", () => {
		const got = draw(() => chartLines({ ...base, asked: { interval: "2h", limit: 6, mode: "bucket", timezone: "UTC" }, fallback: { width: 150, interval: "3h", limit: 9, mode: "cumulative" }, padRows: true }));
		const want = draw(() => buildWtftLines(interactions, { interval: "1h", limit: 100, width: 150, mode: "cumulative", timezone: undefined }, {
			interval: "2h", limit: 6, padRowsTo: 6, width: 150, mode: "bucket", timezone: "UTC", unit: "cost", disabledEmoji: false, showCostColumns: true, showTokenColumns: true,
		}));
		assert.deepEqual(got, want);
	});

	it("takes the fallback for what was not asked, and the default for what neither gave", () => {
		const rows = (lines: string[] | null) => (lines ?? []).filter((l) => /^\S*\d\d:00 |^\S*\d+:\d\d /.test(l.replace(/\x1b\[[0-9;]*m/g, "")));
		assert.equal(rows(draw(() => chartLines({ ...base, asked: {}, fallback: { width: 150, limit: 4, timezone: "UTC" } }))).length, 4);
		assert.equal(rows(draw(() => chartLines({ ...base, asked: { limit: 2 }, fallback: { width: 150, limit: 4, timezone: "UTC" } }))).length, 2);
		assert.equal(draw(() => chartLines({ ...base, asked: { timezone: "UTC" } }))?.length, draw(() => chartLines({ ...base, asked: { timezone: "UTC", limit: 17 } }))?.length);
	});

	it("rounds a fractional or empty limit to a whole count of at least one row", () => {
		const rows = (limit: number) => (draw(() => chartLines({ ...base, asked: { limit, timezone: "UTC" } })) ?? []).length;
		assert.equal(rows(3.5), rows(3));
		assert.equal(rows(-2), rows(1));
	});

	it("caps the width at 1023 and pads to the limit, or to a cap below it", () => {
		const padded = (cap?: number) => (draw(() => chartLines({ ...base, asked: { limit: 30, timezone: "UTC" }, padRows: true, padRowsCap: cap })) ?? []).length;
		const unpadded = (draw(() => chartLines({ ...base, asked: { limit: 30, timezone: "UTC" } })) ?? []).length;
		assert.ok(padded() > unpadded);
		assert.ok(padded(5) < padded());
		assert.ok(padded(unpadded) < padded());
		const wide = withTerminal(5000, NOW, () => chartLines({ ...base, fallback: { width: 5000 }, asked: { timezone: "UTC" } }) ?? []);
		assert.ok(Math.max(...wide.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length)) <= 1023 + 2);
	});

	it("names the session by the last path segment, and not at all with no session file", () => {
		const titled = (sessionFile?: string) => (draw(() => chartLines({ ...base, asked: { timezone: "UTC" }, sessionFile })) ?? [])[0].replace(/\x1b\[[0-9;]*m/g, "");
		assert.match(titled("/a/b/abcd1234.jsonl"), /\.\.\.1234/);
		assert.doesNotMatch(titled(), /\.\.\./);
	});

	it("takes the emoji choice from the asked flag, else the fallback", () => {
		const title = (asked: object, disabledEmoji?: boolean) => (draw(() => chartLines({ ...base, asked, fallback: { width: 150, disabledEmoji, timezone: "UTC" } })) ?? [])[0];
		assert.match(title({}, true), /\[\$\]/);
		assert.match(title({ enableEmoji: true }, true), /💸/);
		assert.match(title({ enableEmoji: false }, false), /\[\$\]/);
		assert.match(title({}), /💸/);
	});
});

describe("askedOf", () => {
	it("keeps only what a parsed command line asked for", () => {
		assert.deepEqual(askedOf(parseWtftCliArgs([])), { showCostColumns: true, showTokenColumns: true });
		const asked = askedOf(parseWtftCliArgs(["-i", "2h", "-l", "5", "-b", "--tz", "UTC", "--no-emoji", "--no-cost"]));
		assert.deepEqual(asked, { interval: "2h", limit: 5, mode: "bucket", timezone: "UTC", enableEmoji: false, showCostColumns: false, showTokenColumns: true });
	});

	it("reads a watch settings object the same way, its disabledEmoji as the negation of enableEmoji", () => {
		const asked = askedOf({ hasInterval: true, interval: "1h", hasLimit: false, limit: 10, hasMode: false, mode: "cumulative", hasTimezone: false, timezone: undefined, disabledEmoji: true, showCostColumns: false, showTokenColumns: true });
		assert.deepEqual(asked, { interval: "1h", enableEmoji: false, showCostColumns: false, showTokenColumns: true });
		assert.equal(askedOf({ disabledEmoji: undefined }).enableEmoji, undefined);
	});
});

describe("chartUnit", () => {
	it("takes --tokens over the config, --cost over both, and cost with nothing set", () => {
		assert.equal(chartUnit({}, undefined), "cost");
		assert.equal(chartUnit({}, true), "tokens");
		assert.equal(chartUnit({ hasCost: true }, true), "cost");
		assert.equal(chartUnit({ hasTokens: true }, false), "tokens");
		assert.equal(chartUnit({ hasTokens: true, hasCost: true }, false), "cost");
	});
});

describe("the one function", () => {
	it("is the only product file that uses buildWtftLines, but for its definition, bin/wtft.ts's re-export and the library page's booth", () => {
		const root = new URL("..", import.meta.url).pathname;
		const found: string[] = [];
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(`${root}${dir}`, { withFileTypes: true })) {
				const path = `${dir}/${entry.name}`;
				if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(path); }
				else if (/\.ts$/.test(entry.name) && /\bbuildWtftLines\b/.test(fs.readFileSync(`${root}${path}`, "utf8"))) found.push(path);
			}
		};
		for (const dir of ["bin", "extensions", "artifacts/renderer"]) walk(dir);
		assert.deepEqual(found.sort(), ["artifacts/renderer/fair.ts", "bin/wtft.ts", "extensions/lib/chart-call.ts", "extensions/lib/wtft-renderer.ts"]);
	});
});

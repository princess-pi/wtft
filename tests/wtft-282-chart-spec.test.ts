/**
 * Chart spec picker pictures. artifacts/chart-spec/spec.mdx.
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { PRESETS, render } from "../artifacts/chart-spec/paint.mjs";

const FOUR = ["inc-cost", "total-cost", "inc-tokens", "total-tokens"];

describe("chart spec picker", () => {
	it("four presets print four columns and the shipped bar", () => {
		assert.deepStrictEqual(Object.keys(PRESETS), [
			"cost-cumulative",
			"cost-bucket",
			"tokens-cumulative",
			"tokens-bucket",
		]);
		for (const preset of Object.values(PRESETS)) {
			assert.deepStrictEqual([...preset.columns], FOUR);
			assert.equal("ticks" in preset, false);
			assert.equal("painter" in preset, false);
			const row = render(preset).plain.find((line) => line.startsWith("15:00"));
			assert.ok(row);
			assert.ok(row.includes("+$1.90"));
			assert.ok(row.includes("$9.90"));
			assert.ok(row.includes("+1.3k"));
			assert.ok(row.includes("8.1k tok"));
		}
		const cost = render(PRESETS["cost-cumulative"]).plain.join("\n");
		assert.match(cost, /█/);
		assert.match(cost, /Sep-25/);
		const tokens = render(PRESETS["tokens-cumulative"]).plain.join("\n");
		assert.match(tokens, /[▃▇]/);
		const turns = render({ ...PRESETS["cost-cumulative"], interval: "turns" }).plain.join("\n");
		assert.match(turns, /Sep-25/);
		assert.match(turns, /100t/);
	});

	it("the spec page shows those pictures", () => {
		const spec = fs.readFileSync(new URL("../artifacts/chart-spec/spec.mdx", import.meta.url), "utf8");
		const page = fs.readFileSync(new URL("../artifacts/chart-spec/picker.html", import.meta.url), "utf8");
		const paint = fs.readFileSync(new URL("../artifacts/chart-spec/paint.mjs", import.meta.url), "utf8");
		for (const preset of Object.values(PRESETS)) {
			for (const line of render(preset).plain) {
				assert.ok(spec.includes(line), line);
			}
		}
		for (const text of [spec, page, paint]) {
			assert.equal(text.includes("dateNeedsTicks"), false);
			assert.equal(text.includes("--no-ticks"), false);
			assert.equal(text.includes("bought"), false);
		}
	});
});

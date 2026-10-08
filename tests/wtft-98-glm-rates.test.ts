import * as assert from "node:assert";
import { describe, it } from "node:test";
import {
	calculateClaudeCost,
	getPeakMultiplier,
	isModelPriced,
	lookupModelPricing,
} from "../bin/wtft.mjs";

const MTOK = 1_000_000;
const ONE_MTOK_EACH = {
	input_tokens: MTOK,
	cache_read_input_tokens: MTOK,
	output_tokens: MTOK,
};

function assertDollars(actual: number, expected: number): void {
	assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !== ${expected}`);
}

describe("z-ai/glm-5.3 flagship card", () => {
	it("costs 1.40 + 0.26 + 4.40 for a million of each token kind", () => {
		assertDollars(calculateClaudeCost("z-ai/glm-5.3", ONE_MTOK_EACH), 6.06);
	});

	it("costs the same with the 1M-window suffix Claude Code appends", () => {
		assertDollars(calculateClaudeCost("z-ai/glm-5.3[1m]", ONE_MTOK_EACH), 6.06);
	});
});

describe("longer ids are not priced as the flagship", () => {
	it("prices flash at 0.15 + 0.03 + 0.50", () => {
		assertDollars(calculateClaudeCost("z-ai/glm-5.3-flash", ONE_MTOK_EACH), 0.68);
		assert.deepStrictEqual(lookupModelPricing("z-ai/glm-5.3-flash"), {
			input: 0.15, output: 0.50, cacheRead: 0.03, cacheWrite: 0,
		});
	});
});

describe("z-ai/glm-5.3-flashx card", () => {
	it("prices flashx at 0.37 + 0.075 + 1.25, not as flash or the flagship", () => {
		assertDollars(calculateClaudeCost("z-ai/glm-5.3-flashx", ONE_MTOK_EACH), 1.695);
		assert.deepStrictEqual(lookupModelPricing("z-ai/glm-5.3-flashx"), {
			input: 0.37, output: 1.25, cacheRead: 0.075, cacheWrite: 0,
		});
	});
});

describe("z-ai/glm-5.3-prime card", () => {
	it("prices prime at 2.80 + 0.56 + 8.80, not as the flagship", () => {
		assertDollars(calculateClaudeCost("z-ai/glm-5.3-prime", ONE_MTOK_EACH), 12.16);
		assert.deepStrictEqual(lookupModelPricing("z-ai/glm-5.3-prime"), {
			input: 2.80, output: 8.80, cacheRead: 0.56, cacheWrite: 0,
		});
	});
});

describe("what the four ids share", () => {
	const IDS = ["z-ai/glm-5.3", "z-ai/glm-5.3-flash", "z-ai/glm-5.3-flashx", "z-ai/glm-5.3-prime"];
	const MON_INSIDE_DEEPSEEK_PEAK = Date.UTC(2026, 7, 24, 2, 0, 0);

	it("reports each as priced, so no ? marker, and the :batch ids inherit that", () => {
		for (const id of [...IDS, "z-ai/glm-5.3:batch", "z-ai/glm-5.3-flash:batch"]) {
			assert.strictEqual(isModelPriced(id), true, id);
		}
	});

	it("has no peak window", () => {
		for (const id of IDS) {
			assert.strictEqual(getPeakMultiplier(id, MON_INSIDE_DEEPSEEK_PEAK), 1, id);
		}
	});

	it("charges nothing for cache-creation tokens, which Z.ai publishes no rate for", () => {
		for (const id of IDS) {
			assert.strictEqual(calculateClaudeCost(id, { cache_creation_input_tokens: MTOK }), 0, id);
		}
	});

	it("prices a :batch id at the non-batch card", () => {
		assert.deepStrictEqual(lookupModelPricing("z-ai/glm-5.3-flash:batch"), lookupModelPricing("z-ai/glm-5.3-flash"));
		assert.deepStrictEqual(lookupModelPricing("z-ai/glm-5.3:batch"), lookupModelPricing("z-ai/glm-5.3"));
	});
});

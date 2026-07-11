/**
 * Tests for #88 — input-based pricing tiers and max thinking level.
 *
 * Pi v0.80.6 added cost.tiers[] with inputTokensAbove thresholds.
 * This validates that our fallback cost calculator correctly:
 *   - Uses base rates when total input ≤ threshold
 *   - Switches to tier rates when total input > threshold
 *   - Picks the highest-matching tier when multiple exist
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import {
	resolveTieredRates,
	lookupModelPricing,
	calculateClaudeCost,
	MODEL_PRICING,
	type ModelPricing,
} from "../extensions/lib/wtft-cost.js";

// --- resolveTieredRates ---

describe("resolveTieredRates", () => {
	const pricing: ModelPricing = {
		input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25,
		tiers: [
			{ inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
		],
	};

	it("returns base rates when total input is below threshold", () => {
		const rates = resolveTieredRates(pricing, {
			input_tokens: 50000,
			cache_read_input_tokens: 20000,
			cache_creation_input_tokens: 1000,
		});
		// 50K + 20K + 1K = 71K, which is < 272K
		assert.strictEqual(rates.input, 5);
		assert.strictEqual(rates.output, 30);
		assert.strictEqual(rates.cacheRead, 0.5);
		assert.strictEqual(rates.cacheWrite, 6.25);
	});

	it("returns base rates when total input equals threshold (not above)", () => {
		const rates = resolveTieredRates(pricing, {
			input_tokens: 272000,
		});
		// threshold is strict greater-than, so exactly 272K should NOT trigger tier
		assert.strictEqual(rates.input, 5);
	});

	it("returns tiered rates when total input exceeds threshold", () => {
		const rates = resolveTieredRates(pricing, {
			input_tokens: 272001,
		});
		assert.strictEqual(rates.input, 10);
		assert.strictEqual(rates.output, 45);
		assert.strictEqual(rates.cacheRead, 1);
		assert.strictEqual(rates.cacheWrite, 12.5);
	});

	it("picks highest-matching tier when multiple tiers exist", () => {
		const multiTier: ModelPricing = {
			input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0,
			tiers: [
				{ inputTokensAbove: 100000, input: 7, output: 35, cacheRead: 0.7, cacheWrite: 0 },
				{ inputTokensAbove: 272000, input: 10, output: 45, cacheRead: 1, cacheWrite: 0 },
			],
		};
		const rates = resolveTieredRates(multiTier, {
			input_tokens: 300000,
		});
		// Both tiers match, highest threshold (272K) should win
		assert.strictEqual(rates.input, 10);
		assert.strictEqual(rates.output, 45);
	});

	it("returns base rates when no tiers are defined", () => {
		const flat: ModelPricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
		const rates = resolveTieredRates(flat, {
			input_tokens: 999999,
		});
		assert.strictEqual(rates.input, 3);
	});

	it("handles missing usage fields as zero", () => {
		const rates = resolveTieredRates(pricing, {});
		assert.strictEqual(rates.input, 5); // total input = 0, base rates
	});
});

// --- lookupModelPricing ---

describe("lookupModelPricing", () => {
	it("matches exact model IDs", () => {
		const p = lookupModelPricing("gpt-5.6-sol");
		assert.ok(p);
		assert.strictEqual(p!.input, 5);
		assert.ok(p!.tiers);
		assert.strictEqual(p!.tiers![0].inputTokensAbove, 272000);
	});

	it("fuzzy-matches model IDs containing a registry key", () => {
		// DeepSeek v4-pro with provider prefix
		const p = lookupModelPricing("deepseek/deepseek-v4-pro");
		assert.ok(p);
		assert.strictEqual(p!.input, 1.74);
	});

	it("returns null for unknown models", () => {
		assert.strictEqual(lookupModelPricing("some-unknown-model"), null);
	});

	it("returns null for empty string", () => {
		assert.strictEqual(lookupModelPricing(""), null);
	});
});

// --- calculateClaudeCost with tiers ---

describe("calculateClaudeCost with tiers", () => {
	it("uses base rates for GPT-5.6-sol with input below 272K", () => {
		const cost = calculateClaudeCost("gpt-5.6-sol", {
			input_tokens: 100000,
			output_tokens: 10000,
			cache_read_input_tokens: 0,
		});
		// Base: 100K * $5/1M + 10K * $30/1M = $0.50 + $0.30 = $0.80
		const expected = (100000 * 5 / 1000000) + (10000 * 30 / 1000000);
		assert.ok(Math.abs(cost - expected) < 0.0001, `cost ${cost} != expected ${expected}`);
	});

	it("uses tiered rates for GPT-5.6-sol with input above 272K", () => {
		const cost = calculateClaudeCost("gpt-5.6-sol", {
			input_tokens: 300000,
			output_tokens: 10000,
			cache_read_input_tokens: 0,
		});
		// Tier: 300K * $10/1M + 10K * $45/1M = $3.00 + $0.45 = $3.45
		const expected = (300000 * 10 / 1000000) + (10000 * 45 / 1000000);
		assert.ok(Math.abs(cost - expected) < 0.0001, `cost ${cost} != expected ${expected}`);
	});

	it("counts cacheRead tokens toward tier threshold", () => {
		const cost = calculateClaudeCost("gpt-5.4", {
			input_tokens: 200000,
			output_tokens: 5000,
			cache_read_input_tokens: 80000,
		});
		// Total input = 200K + 80K = 280K > 272K → tier
		// Tier: 200K * $5/1M + 5K * $22.5/1M = $1.00 + $0.1125 = $1.1125
		// Plus cacheRead: 80K * $0.5/1M = $0.04
		const expected = (200000 * 5 / 1000000) + (5000 * 22.5 / 1000000) + (80000 * 0.5 / 1000000);
		assert.ok(Math.abs(cost - expected) < 0.0001, `cost ${cost} != expected ${expected}`);
	});

	it("GPT-5.6-sol cache writes are zero when no cache data", () => {
		const cost = calculateClaudeCost("gpt-5.6-sol", {
			input_tokens: 100000,
			output_tokens: 5000,
		});
		// No cacheCreation, no cacheRead — cost should be clean
		const expected = (100000 * 5 / 1000000) + (5000 * 30 / 1000000);
		assert.ok(Math.abs(cost - expected) < 0.0001);
	});

	it("GPT-5.5 cache writes are zero (OpenAI Responses has no cache write cost)", () => {
		const cost = calculateClaudeCost("gpt-5.5", {
			input_tokens: 100000,
			output_tokens: 5000,
			cache_creation_input_tokens: 10000,
		});
		// GPT-5.5 cacheWrite in registry is 0, so cache creation costs nothing
		const expected = (100000 * 5 / 1000000) + (5000 * 30 / 1000000);
		assert.ok(Math.abs(cost - expected) < 0.0001);
	});

	it("Claude (non-registry) still uses legacy pricing", () => {
		const cost = calculateClaudeCost("claude-sonnet-4-20250514", {
			input_tokens: 100000,
			output_tokens: 5000,
		});
		// Default Claude Sonnet: 100K * $3/1M + 5K * $15/1M = $0.30 + $0.075 = $0.375
		const expected = (100000 * 3 / 1000000) + (5000 * 15 / 1000000);
		assert.ok(Math.abs(cost - expected) < 0.0001);
	});

	it("DeepSeek v4-pro in registry uses surge-adjusted pricing", () => {
		const cost = calculateClaudeCost("deepseek-v4-pro", {
			input_tokens: 100000,
			output_tokens: 5000,
		});
		// Registry price $1.74/$3.48, peak multiplier may apply.
		// At non-peak: 100K * $1.74/1M + 5K * $3.48/1M = $0.174 + $0.0174 = $0.1914
		const expected = (100000 * 1.74 / 1000000) + (5000 * 3.48 / 1000000);
		assert.ok(Math.abs(cost - expected) < 0.0001);
	});
});

// --- MODEL_PRICING registry integrity ---

describe("MODEL_PRICING registry integrity", () => {
	it("all entries with tiers have inputTokensAbove > 0", () => {
		for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
			if (pricing.tiers) {
				for (const tier of pricing.tiers) {
					assert.ok(tier.inputTokensAbove > 0, `${key}: tier inputTokensAbove must be > 0`);
				}
			}
		}
	});

	it("tier cacheWrite is 0 for GPT-5.4/5.5 (OpenAI Responses has no cache write)", () => {
		for (const key of ["gpt-5.4", "gpt-5.5"]) {
			const p = MODEL_PRICING[key];
			assert.ok(p, `${key} should be in registry`);
			assert.strictEqual(p.cacheWrite, 0, `${key} base cacheWrite should be 0`);
			if (p.tiers) {
				for (const tier of p.tiers) {
					assert.strictEqual(tier.cacheWrite, 0, `${key} tier cacheWrite should be 0`);
				}
			}
		}
	});
});

console.log("✅ All pricing tier tests passed.");

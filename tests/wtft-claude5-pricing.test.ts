/**
 * Tests for #139/#140 — Claude 5 family in MODEL_PRICING, user pricing
 * registry merge, and the isModelPriced miss-path predicate.
 *
 * #139 repro class: claude-fable-5 matched neither the registry nor the
 * haiku/opus substring fallbacks and silently priced at Sonnet-tier
 * initializer defaults ($3/$15), ~3.3x under the real $10/$50.
 *
 * Run: node --experimental-strip-types --test tests/wtft-claude5-pricing.test.ts
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	calculateClaudeCost,
	lookupModelPricing,
	isModelPriced,
	applyUserPricing,
	loadUserPricing,
	MODEL_PRICING,
} from "../bin/wtft.mjs";

const MTOK = 1_000_000;

// --- #139: Claude 5 family rates ---

describe("Claude 5 family pricing (#139)", () => {
	it("prices claude-fable-5 at $10/$50/$1.00/$12.50 per MTok", () => {
		assert.strictEqual(calculateClaudeCost("claude-fable-5", { input_tokens: MTOK }), 10.00);
		assert.strictEqual(calculateClaudeCost("claude-fable-5", { output_tokens: MTOK }), 50.00);
		assert.strictEqual(calculateClaudeCost("claude-fable-5", { cache_read_input_tokens: MTOK }), 1.00);
		// Flat cache_creation (no TTL split) bills at the 5m rate
		assert.strictEqual(calculateClaudeCost("claude-fable-5", { cache_creation_input_tokens: MTOK }), 12.50);
	});

	it("bills claude-fable-5 1h-TTL cache writes at 2x base input ($20/MTok, #146)", () => {
		// API rule: 5m write = 1.25x input, 1h write = 2.0x input. NOT 2x the
		// 5m rate — that's 2.5x input and overbilled Claude Code sessions by
		// 25% on cache writes (this test wrongly pinned $25/MTok pre-#146).
		const cost = calculateClaudeCost("claude-fable-5", {
			cache_creation_input_tokens: MTOK,
			cache_creation: { ephemeral_1h_input_tokens: MTOK },
		});
		assert.strictEqual(cost, 20.00);
	});

	it("bills claude-opus-5 1h-TTL cache writes at 2x base input ($10/MTok, #146)", () => {
		const cost = calculateClaudeCost("claude-opus-5", {
			cache_creation_input_tokens: MTOK,
			cache_creation: { ephemeral_1h_input_tokens: MTOK },
		});
		assert.strictEqual(cost, 10.00);
	});

	it("keeps free-cache-write registry models free on 1h writes (#146)", () => {
		// gpt-5.4 has cacheWrite: 0 (OpenAI Responses doesn't charge writes) —
		// a naive input*2 derivation would have started charging them.
		const cost = calculateClaudeCost("gpt-5.4", {
			cache_creation_input_tokens: MTOK,
			cache_creation: { ephemeral_1h_input_tokens: MTOK },
		});
		assert.strictEqual(cost, 0);
	});

	it("prices claude-mythos-5 identically to claude-fable-5", () => {
		assert.deepStrictEqual(lookupModelPricing("claude-mythos-5"), lookupModelPricing("claude-fable-5"));
	});

	it("prices claude-opus-5 at $5/$25/$0.50/$6.25 per MTok", () => {
		assert.strictEqual(calculateClaudeCost("claude-opus-5", { input_tokens: MTOK }), 5.00);
		assert.strictEqual(calculateClaudeCost("claude-opus-5", { output_tokens: MTOK }), 25.00);
		assert.strictEqual(calculateClaudeCost("claude-opus-5", { cache_read_input_tokens: MTOK }), 0.50);
		assert.strictEqual(calculateClaudeCost("claude-opus-5", { cache_creation_input_tokens: MTOK }), 6.25);
	});

	it("prices claude-sonnet-5 at $3/$15/$0.30/$3.75 per MTok", () => {
		assert.strictEqual(calculateClaudeCost("claude-sonnet-5", { input_tokens: MTOK }), 3.00);
		assert.strictEqual(calculateClaudeCost("claude-sonnet-5", { output_tokens: MTOK }), 15.00);
	});

	it("prices claude-haiku-4-5 (dated ID) at $1/$5 per MTok via fuzzy match", () => {
		assert.strictEqual(calculateClaudeCost("claude-haiku-4-5-20251001", { input_tokens: MTOK }), 1.00);
		assert.strictEqual(calculateClaudeCost("claude-haiku-4-5-20251001", { output_tokens: MTOK }), 5.00);
	});

	it("repro guard: the …a578 all-Fable session prices ≈$50, not ≈$15", () => {
		// Main-transcript deduped tokens from the 2026-08-08 repro:
		// ~25M cache-read, ~1.6M cache-write (5m), ~100k output.
		const cost = calculateClaudeCost("claude-fable-5", {
			output_tokens: 100_000,
			cache_read_input_tokens: 25 * MTOK,
			cache_creation_input_tokens: 1.6 * MTOK,
		});
		// 25*1.00 + 1.6*12.50 + 0.1*50 = 25 + 20 + 5 = $50
		assert.ok(Math.abs(cost - 50) < 2.5, `expected ≈$50, got $${cost.toFixed(2)}`);
		assert.ok(cost > 30, `must not price at Sonnet defaults (~$15): $${cost.toFixed(2)}`);
	});
});

// --- #140: miss-path predicate ---

describe("isModelPriced (#140)", () => {
	it("is true for registry models", () => {
		assert.strictEqual(isModelPriced("claude-fable-5"), true);
		assert.strictEqual(isModelPriced("claude-sonnet-5"), true);
		assert.strictEqual(isModelPriced("gpt-5.5"), true);
	});

	it("is true for legacy substring-branch models not in the registry", () => {
		assert.strictEqual(isModelPriced("claude-opus-4-0"), true);
		assert.strictEqual(isModelPriced("deepseek-chat"), true);
	});

	it("is false for unknown models (the silent-default class)", () => {
		assert.strictEqual(isModelPriced("claude-sonnet-6"), false);
		assert.strictEqual(isModelPriced("totally-new-model"), false);
		assert.strictEqual(isModelPriced(""), false);
	});
});

// --- #140: user pricing registry ---

describe("user pricing registry (#140)", () => {
	it("applyUserPricing adds a new model and corrects its cost", () => {
		assert.strictEqual(lookupModelPricing("model-x-9000"), null);
		applyUserPricing({ "model-x-9000": { input: 7, output: 21, cacheRead: 0.7, cacheWrite: 8.75 } });
		assert.strictEqual(isModelPriced("model-x-9000"), true);
		assert.strictEqual(calculateClaudeCost("model-x-9000", { input_tokens: MTOK }), 7);
	});

	it("applyUserPricing overrides a built-in entry", () => {
		const original = { ...MODEL_PRICING["claude-haiku-4-5"] };
		applyUserPricing({ "claude-haiku-4-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } });
		assert.strictEqual(calculateClaudeCost("claude-haiku-4-5", { input_tokens: MTOK }), 2);
		applyUserPricing({ "claude-haiku-4-5": original }); // restore
	});

	it("applyUserPricing rejects malformed entries (no NaN poisoning)", () => {
		applyUserPricing({ "bad-model": { input: "ten", output: 50 } } as any);
		assert.strictEqual(lookupModelPricing("bad-model"), null);
	});

	it("loadUserPricing merges a JSON file over built-ins (no rebuild)", () => {
		const tmp = path.join(os.tmpdir(), `wtft-pricing-${process.pid}.json`);
		fs.writeFileSync(tmp, JSON.stringify({
			"model-from-json": { input: 4, output: 16, cacheRead: 0.4, cacheWrite: 5 },
		}));
		try {
			const applied = loadUserPricing(tmp);
			assert.ok(applied && applied["model-from-json"]);
			assert.strictEqual(isModelPriced("model-from-json"), true);
			assert.strictEqual(calculateClaudeCost("model-from-json", { output_tokens: MTOK }), 16);
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it("loadUserPricing tolerates a missing or malformed file", () => {
		assert.strictEqual(loadUserPricing(path.join(os.tmpdir(), "wtft-no-such-file.json")), null);
		const tmp = path.join(os.tmpdir(), `wtft-pricing-bad-${process.pid}.json`);
		fs.writeFileSync(tmp, "{not json");
		try {
			assert.strictEqual(loadUserPricing(tmp), null);
		} finally {
			fs.unlinkSync(tmp);
		}
	});
});

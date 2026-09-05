/**
 * Tests for #139/#140 — Claude 5 family in MODEL_PRICING, user pricing
 * registry merge, and the isModelPriced miss-path predicate.
 * Also covers #148 — claude-sonnet-5's intro-rate `dateTiers` window
 * end-to-end through calculateClaudeCost (see "Sonnet 5 intro pricing" below).
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
	describeFallbackPricing,
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

	it("prices claude-sonnet-5 at $3/$15/$0.30/$3.75 per MTok (no timestamp — base/standard fallback)", () => {
		// No timestamp arg deliberately: this is the #148 "missing timestamp
		// never reads Date.now()" fallback (base = standard rate), not an
		// omission. See the dedicated "Sonnet 5 intro pricing (#148)" block
		// below for the dated-window assertions.
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

// --- #148: Sonnet 5 intro pricing (dated rate window) ---

describe("Sonnet 5 intro pricing (#148)", () => {
	// Fixed instants, never Date.now() (#96 test hazard) — see spec-148 §3.
	const PRE_CUTOFF = new Date("2026-08-15T00:00:00Z").getTime();
	const EXACT_CUTOFF = new Date("2026-09-01T00:00:00Z").getTime();
	const POST_CUTOFF = new Date("2026-09-15T00:00:00Z").getTime();

	it("bills intro rate $2/$10/$0.20/$2.50 for an interaction before 2026-09-01", () => {
		assert.strictEqual(calculateClaudeCost("claude-sonnet-5", { input_tokens: MTOK }, PRE_CUTOFF), 2.00);
		assert.strictEqual(calculateClaudeCost("claude-sonnet-5", { output_tokens: MTOK }, PRE_CUTOFF), 10.00);
		assert.strictEqual(calculateClaudeCost("claude-sonnet-5", { cache_read_input_tokens: MTOK }, PRE_CUTOFF), 0.20);
		assert.strictEqual(calculateClaudeCost("claude-sonnet-5", { cache_creation_input_tokens: MTOK }, PRE_CUTOFF), 2.50);
	});

	it("derives intro 1h-TTL cache writes at 2x intro input ($4.00/MTok, consistent with #146)", () => {
		const cost = calculateClaudeCost("claude-sonnet-5", {
			cache_creation_input_tokens: MTOK,
			cache_creation: { ephemeral_1h_input_tokens: MTOK },
		}, PRE_CUTOFF);
		assert.strictEqual(cost, 4.00);
	});

	it("bills standard rate $3/$15/$0.30/$3.75 exactly at the 2026-09-01T00:00:00Z boundary", () => {
		// Boundary is inclusive of standard, exclusive of intro (strict <).
		assert.strictEqual(calculateClaudeCost("claude-sonnet-5", { input_tokens: MTOK }, EXACT_CUTOFF), 3.00);
		assert.strictEqual(calculateClaudeCost("claude-sonnet-5", { output_tokens: MTOK }, EXACT_CUTOFF), 15.00);
		assert.strictEqual(calculateClaudeCost("claude-sonnet-5", { cache_read_input_tokens: MTOK }, EXACT_CUTOFF), 0.30);
		assert.strictEqual(calculateClaudeCost("claude-sonnet-5", { cache_creation_input_tokens: MTOK }, EXACT_CUTOFF), 3.75);
	});

	it("bills standard rate $3/$15/$0.30/$3.75 for an interaction on or after 2026-09-01", () => {
		assert.strictEqual(calculateClaudeCost("claude-sonnet-5", { input_tokens: MTOK }, POST_CUTOFF), 3.00);
		assert.strictEqual(calculateClaudeCost("claude-sonnet-5", { output_tokens: MTOK }, POST_CUTOFF), 15.00);
		assert.strictEqual(calculateClaudeCost("claude-sonnet-5", { cache_read_input_tokens: MTOK }, POST_CUTOFF), 0.30);
		assert.strictEqual(calculateClaudeCost("claude-sonnet-5", { cache_creation_input_tokens: MTOK }, POST_CUTOFF), 3.75);
	});

	it("derives standard 1h-TTL cache writes at 2x standard input ($6.00/MTok, unchanged from #146)", () => {
		const cost = calculateClaudeCost("claude-sonnet-5", {
			cache_creation_input_tokens: MTOK,
			cache_creation: { ephemeral_1h_input_tokens: MTOK },
		}, POST_CUTOFF);
		assert.strictEqual(cost, 6.00);
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
		// `opus` and `haiku` really do have hardcoded rate branches in
		// calculateClaudeCost, so "priced" is honest for them.
		assert.strictEqual(isModelPriced("claude-opus-4-0"), true);
	});

	it("is false for a DeepSeek id no registry key matched (#22 B / #25 B)", () => {
		// There is no hardcoded DeepSeek branch — only a sibling GUESS, which the
		// code's own comment calls one. Reporting that as priced meant the
		// unpriced-model warning never fired for a DeepSeek model newer than the
		// registry, which is the exact case the warning exists for. 527 turns on
		// this host use `deepseek-reasoner`.
		assert.strictEqual(isModelPriced("deepseek-reasoner"), false);
		assert.strictEqual(isModelPriced("deepseek-chat"), false);
		// An id carrying BOTH `deepseek` and a legacy-branch word: calculateClaudeCost
		// tests `deepseek` first, so this takes the sibling guess and costs
		// $0.22/MTok, not the $5.00 the `opus` branch would charge. isModelPriced
		// asks in the same order so the two cannot disagree about which branch a
		// model reached (pr-review, round 1).
		assert.strictEqual(isModelPriced("deepseek-opus"), false);
		assert.strictEqual(
			calculateClaudeCost("deepseek-opus", { input_tokens: 1_000_000 }, Date.UTC(2026, 7, 23, 12)),
			0.22,
		);
		// A registry-matched DeepSeek id is still priced.
		assert.strictEqual(isModelPriced("deepseek-v4-pro"), true);
		assert.strictEqual(isModelPriced("deepseek/deepseek-v4-flash-vision-exp"), true);
	});

	it("is false for unknown models (the silent-default class)", () => {
		assert.strictEqual(isModelPriced("claude-sonnet-6"), false);
		assert.strictEqual(isModelPriced("totally-new-model"), false);
		assert.strictEqual(isModelPriced(""), false);
	});
});

describe("describeFallbackPricing (#22 B)", () => {
	it("names the sibling-guess branch for an unmatched DeepSeek id", () => {
		// The stderr warning used to claim "$3/$15" for every miss. A DeepSeek
		// miss does not take that branch, so the text named a rate the run never
		// used. Both real unmatched ids on this host guess with the flash card.
		assert.match(describeFallbackPricing("deepseek-reasoner"), /deepseek-v4-flash rate card/);
		assert.match(describeFallbackPricing("deepseek-chat"), /deepseek-v4-flash rate card/);
	});

	it("agrees with the card calculateClaudeCost actually charges", () => {
		// The warning and the branch share deepSeekSiblingKey, so this pins that
		// they cannot drift: the dollar figure for the unmatched id must equal
		// the figure for the sibling the text names, on the same instant.
		const OFF_PEAK_WEEKEND = new Date("2026-08-23T12:00:00Z").getTime();
		const usage = { input_tokens: 1_000_000, output_tokens: 0 };
		const guessed = calculateClaudeCost("deepseek-reasoner", usage, OFF_PEAK_WEEKEND);
		const named = calculateClaudeCost("deepseek-v4-flash", usage, OFF_PEAK_WEEKEND);
		assert.ok(/deepseek-v4-flash/.test(describeFallbackPricing("deepseek-reasoner")));
		assert.strictEqual(guessed, named);
		// Not a tautology: 0.22 is deepseek-v4-flash's current-card input rate,
		// read from the committed manifest, not recomputed from the registry.
		assert.strictEqual(guessed, 0.22);
	});

	it("names the Sonnet default for every other miss", () => {
		assert.strictEqual(describeFallbackPricing("claude-sonnet-6"), "using default $3/$15 rates");
		assert.strictEqual(describeFallbackPricing("totally-new-model"), "using default $3/$15 rates");
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

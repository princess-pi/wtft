/**
 * Tests for #495 — DeepSeek rate card and peak schedule, both of which moved
 * after wtft's registry was written.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import {
	getPeakMultiplier,
	calculateClaudeCost,
	lookupModelPricing,
	MODEL_PRICING,
	getSurgeLocalHours,
	checkSurgeProximity,
	isModelPriced,
} from "../bin/wtft.mjs";

// --- Fixed instants, named by what makes them interesting ---

// Named by what makes each instant interesting. The window hours are NOT
// re-typed here — read them from the deepseek-flash card's surge schedule; these
// fixtures say only "inside window 1", "outside both", and so on, so a
// schedule change makes the assertions fail rather than the comments lie.
const MON_INSIDE_WINDOW_1 = Date.UTC(2026, 7, 24, 2, 0, 0);   // Mon 2026-08-24 02:00Z
const MON_INSIDE_WINDOW_2 = Date.UTC(2026, 7, 24, 7, 0, 0);   // Mon 2026-08-24 07:00Z
const MON_OUTSIDE_WINDOWS = Date.UTC(2026, 7, 24, 12, 0, 0);  // Mon 2026-08-24 12:00Z
const SAT_INSIDE_WINDOW_1 = Date.UTC(2026, 7, 29, 2, 0, 0);   // Sat 2026-08-29 02:00Z
const SUN_INSIDE_WINDOW_2 = Date.UTC(2026, 7, 30, 7, 0, 0);   // Sun 2026-08-30 07:00Z

// Before the 2026-08-23 schedule change, a weekend inside a window was peak.
const SAT_BEFORE_SCHEDULE_CHANGE = Date.UTC(2026, 7, 15, 2, 0, 0); // Sat 2026-08-15 02:00Z

describe("#495 getPeakMultiplier — weekends are off-peak from 2026-08-23", () => {
	it("is peak on a weekday inside either window", () => {
		assert.strictEqual(getPeakMultiplier("deepseek-flash", MON_INSIDE_WINDOW_1), 2.0);
		assert.strictEqual(getPeakMultiplier("deepseek-flash", MON_INSIDE_WINDOW_2), 2.0);
	});

	it("is off-peak on a weekday outside both windows", () => {
		assert.strictEqual(getPeakMultiplier("deepseek-flash", MON_OUTSIDE_WINDOWS), 1.0);
	});

	it("is off-peak on a Saturday inside a window", () => {
		assert.strictEqual(getPeakMultiplier("deepseek-flash", SAT_INSIDE_WINDOW_1), 1.0);
	});

	it("is off-peak on a Sunday inside a window", () => {
		assert.strictEqual(getPeakMultiplier("deepseek-flash", SUN_INSIDE_WINDOW_2), 1.0);
	});

	it("still charges peak on a weekend before the 2026-08-23 change", () => {
		// The schedule change is not retroactive: a July or early-August
		// weekend session really was billed at the surge rate.
		assert.strictEqual(getPeakMultiplier("deepseek-flash", SAT_BEFORE_SCHEDULE_CHANGE), 2.0);
	});
});

// --- The rate card ---
//
// Rates below are transcribed from the committed scrape, not derived. The
// registry stores OFF-PEAK as the base and applies 2x at peak, which is the
// same card the docs state the other way round ("off-peak rates are half of
// the peak rates").

type Card = { cacheMiss: number; output: number; cacheHit: number };

const CARD_2026_08_16: Record<string, Card> = {
	"deepseek-v4-pro":              { cacheMiss: 0.66, output: 1.98, cacheHit: 0.022 },
	"deepseek-v4-flash":            { cacheMiss: 0.22, output: 0.66, cacheHit: 0.007 },
	"deepseek-v4-flash-vision-exp": { cacheMiss: 0.22, output: 0.66, cacheHit: 0.007 },
};

const CARD_BEFORE_2026_08_16: Record<string, Card> = {
	"deepseek-v4-pro":   { cacheMiss: 1.74, output: 3.48, cacheHit: 0.0145 },
	"deepseek-v4-flash": { cacheMiss: 0.14, output: 0.28, cacheHit: 0.0028 },
	// #100 gave -vision-exp this window too. No observed turn reaches it — every
	// vision-exp turn in this host's corpus postdates the cutover — but the entry
	// carries it, so the fixture must, or a case claiming to cover every entry
	// with an old card silently covers two of three.
	"deepseek-v4-flash-vision-exp": { cacheMiss: 0.14, output: 0.28, cacheHit: 0.0028 },
};

// The V4.1 Flash card (#100), transcribed from
// research/100-deepseek-v41-flash/pricing-page-2026-09-10.md. Off-peak, like
// every row in this file; peak is 2x.
const CARD_V41_FLASH: Card = { cacheMiss: 0.15, output: 0.60, cacheHit: 0.003 };

// A weekday outside both peak windows, on each side of the 2026-08-16 16:00Z
// card change. Named for THAT cutover specifically since #100 added two more —
// an unqualified "after the cutover" no longer says which of three it means.
const AFTER_2026_08_16 = Date.UTC(2026, 7, 24, 12, 0, 0);   // Mon 2026-08-24 12:00Z
const BEFORE_2026_08_16 = Date.UTC(2026, 6, 15, 12, 0, 0);  // Wed 2026-07-15 12:00Z

// Weekdays outside both peak windows, so the surge multiplier is 1.0 and only
// the card is under test. 12:00Z is outside 01:00–04:00 and 06:00–10:00.
const AFTER_V41_FLASH = Date.UTC(2026, 8, 10, 12, 0, 0);   // Thu 2026-09-10 12:00Z
const BEFORE_V41_FLASH = Date.UTC(2026, 8, 9, 12, 0, 0);   // Wed 2026-09-09 12:00Z
const AFTER_2026_09_14 = Date.UTC(2026, 8, 14, 12, 0, 0);  // Mon 2026-09-14 12:00Z
const ON_2026_09_11 = Date.UTC(2026, 8, 11, 12, 0, 0);     // Fri 2026-09-11 12:00Z

const USAGE = {
	input_tokens: 100000,
	output_tokens: 5000,
	cache_read_input_tokens: 1000000,
};

function priceFromCard(card: Card): number {
	return (USAGE.input_tokens * card.cacheMiss
		+ USAGE.output_tokens * card.output
		+ USAGE.cache_read_input_tokens * card.cacheHit) / 1000000;
}

describe("#495 DeepSeek rate card, as of 2026-08-16 and before it", () => {
	for (const [model, card] of Object.entries(CARD_2026_08_16)) {
		it(`prices ${model} at the card in force on 2026-08-24`, () => {
			const cost = calculateClaudeCost(model, USAGE, AFTER_2026_08_16);
			assert.ok(
				Math.abs(cost - priceFromCard(card)) < 0.000001,
				`${model}: got ${cost}, want ${priceFromCard(card)}`,
			);
		});
	}

	for (const [model, card] of Object.entries(CARD_BEFORE_2026_08_16)) {
		it(`still prices ${model} at the old card before the cutover`, () => {
			const cost = calculateClaudeCost(model, USAGE, BEFORE_2026_08_16);
			assert.ok(
				Math.abs(cost - priceFromCard(card)) < 0.000001,
				`${model}: got ${cost}, want ${priceFromCard(card)}`,
			);
		});
	}

	it("charges nothing for cache writes on deepseek-v4-pro", () => {
		// DeepSeek's Anthropic-format endpoint reports cache_creation_input_tokens: 0
		// on every turn — it bills a cache miss as plain input_tokens, which is why
		// the registry's `input` slot IS the cache-miss rate. A non-zero value here
		// must still cost nothing rather than being priced at an invented rate.
		const cost = calculateClaudeCost("deepseek-v4-pro", {
			cache_creation_input_tokens: 500000,
		}, AFTER_2026_08_16);
		assert.strictEqual(cost, 0);
	});
});

// 1M cache-miss input + 1M output. No cache
// reads: the cache-hit rate moved too, and mixing it in would let a wrong hit
// rate hide inside a right total.
const MTOK_IN_OUT = { input_tokens: 1000000, output_tokens: 1000000 };

function priceMTokFromCard(card: Card): number {
	return card.cacheMiss + card.output;
}

describe("#100 deepseek-flash is priced from its own entry, not guessed", () => {
	it("resolves to the deepseek-flash entry", () => {
		// Before #100 this returned null and calculateClaudeCost took the
		// DeepSeek sibling-GUESS branch, borrowing deepseek-v4-flash's card.
		// That is a real entry with real rates, so a numeric check alone could
		// not tell "priced" from "guessed" once the two cards happen to agree.
		const flash = lookupModelPricing("deepseek-flash");
		assert.ok(flash);
		assert.strictEqual(flash, MODEL_PRICING["deepseek-flash"]);
		assert.notStrictEqual(flash, MODEL_PRICING["deepseek-v4-flash"]);
	});

	it("is reported as priced, so no fallback warning is rendered for it", () => {
		// isModelPriced false is the `?` marker and the "no pricing for …"
		// warning line. A model we now price outright must not carry either.
		assert.strictEqual(isModelPriced("deepseek-flash"), true);
		assert.strictEqual(isModelPriced("deepseek/deepseek-flash"), true);
	});

	it("does not collide with deepseek-v4-flash in either direction", () => {
		// The registry comment claims neither key is a substring of the other,
		// which is why adding a SHORTER key beside a longer one is safe here
		// when #495 proved it generally is not. Assert the claim rather than
		// trusting the sort: longest-first only settles a tie between keys that
		// BOTH match, and the point is that neither id can match both keys.
		//
		// Read the keys OUT OF THE REGISTRY, not as string literals in this file.
		const flash = Object.keys(MODEL_PRICING).find(k => k === "deepseek-flash");
		const v4 = Object.keys(MODEL_PRICING).find(k => k === "deepseek-v4-flash");
		assert.ok(flash && v4, "both keys must exist for this to be testing anything");
		assert.ok(!v4!.includes(flash!), `${v4} contains ${flash} — the shorter key can steal it`);
		assert.ok(!flash!.includes(v4!));
		assert.strictEqual(
			lookupModelPricing("deepseek/deepseek-v4-flash"),
			MODEL_PRICING["deepseek-v4-flash"],
		);
	});

	it("carries no dateTiers — it did not exist before its card did", () => {
		assert.strictEqual(MODEL_PRICING["deepseek-flash"].dateTiers, undefined);
		for (const key of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
			assert.strictEqual(MODEL_PRICING[key].dateTiers?.length, 2, `${key} should carry two dated windows`);
		}
		assert.strictEqual(MODEL_PRICING["deepseek-v4-pro"].dateTiers?.length, 1);
	});

	it("prices 1M cache-miss in + 1M out at $0.75 off-peak", () => {
		// The expected figure comes from the card, not a second hardcoded 0.75.
		const want = priceMTokFromCard(CARD_V41_FLASH);
		assert.strictEqual(want, 0.75, "the card should still sum to the figure #100's Closer names");
		const cost = calculateClaudeCost("deepseek-flash", MTOK_IN_OUT, AFTER_V41_FLASH);
		assert.ok(Math.abs(cost - want) < 0.000001, `got ${cost}, want ${want}`);
	});

	it("prices a 1M cache-HIT turn at $0.003", () => {
		// The cache-hit rate is the third of the card's three numbers and was the
		// one no case here touched: priceMTokFromCard sums miss + output only. It
		// is also the rate that matters most on an agent workload, where cache
		// hits are the bulk of input, and the one whose #100 error was largest
		// (0.022 against 0.003 on the v4-pro line, 7.3x).
		const cost = calculateClaudeCost(
			"deepseek-flash", { cache_read_input_tokens: 1000000 }, AFTER_V41_FLASH);
		assert.ok(
			Math.abs(cost - CARD_V41_FLASH.cacheHit) < 0.000001,
			`got ${cost}, want ${CARD_V41_FLASH.cacheHit}`,
		);
	});

	it("prices the same turn at $1.50 inside a weekday peak window", () => {
		// Fri 2026-09-11 02:00Z — inside window 1, on a weekday, and AFTER the
		// 04:00Z cutover on 2026-09-10. The first draft used 02:00Z on the 10th,
		// which is two hours BEFORE the cutover; it agreed only because
		// deepseek-flash carries no dated window, so the case would have passed
		// for a model whose card had not started yet.
		const peakInstant = Date.UTC(2026, 8, 11, 2, 0, 0);
		assert.strictEqual(getPeakMultiplier("deepseek-flash", peakInstant), 2.0);
		// That the instant is past the cutover is asserted BEHAVIOURALLY rather
		// than against the constant: deepseek-v4-flash does carry a dated window,
		// so it prices at the Flash card here only if the cutover has passed.
		// Comparing against an imported constant would agree with the code by
		// construction; this disagrees with it if the date is wrong.
		assert.ok(
			Math.abs(calculateClaudeCost("deepseek-v4-flash", MTOK_IN_OUT, peakInstant)
				- 2 * priceMTokFromCard(CARD_V41_FLASH)) < 0.000001,
			"the chosen instant is not past the V4.1 Flash cutover",
		);
		// Off-peak is half of peak, which is the card DeepSeek publishes, so this
		// is 2x the case above and NOT an independently transcribed number.
		const cost = calculateClaudeCost("deepseek-flash", MTOK_IN_OUT, peakInstant);
		assert.ok(
			Math.abs(cost - 2 * priceMTokFromCard(CARD_V41_FLASH)) < 0.000001,
			`got ${cost}, want ${2 * priceMTokFromCard(CARD_V41_FLASH)}`,
		);
	});

	it("charges nothing for cache writes, like every DeepSeek entry", () => {
		// The Anthropic-format endpoint reports no cache-creation tokens and
		// bills a miss as plain input. cacheWrite: 0 is correct, not missing —
		// a new entry is exactly where that gets forgotten.
		const cost = calculateClaudeCost("deepseek-flash", {
			cache_creation_input_tokens: 500000,
		}, AFTER_V41_FLASH);
		assert.strictEqual(cost, 0);
	});
});

describe("#100 the retired names bill at the V4.1 Flash card from their cutover", () => {
	const cases: Array<[string, number, number, Card]> = [
		["deepseek-v4-flash", BEFORE_V41_FLASH, AFTER_V41_FLASH, CARD_2026_08_16["deepseek-v4-flash"]],
		["deepseek-v4-flash-vision-exp", BEFORE_V41_FLASH, AFTER_V41_FLASH, CARD_2026_08_16["deepseek-v4-flash-vision-exp"]],
	];

	for (const [model, before, after, oldCard] of cases) {
		it(`prices ${model} at the Flash card after its cutover`, () => {
			const cost = calculateClaudeCost(model, MTOK_IN_OUT, after);
			assert.ok(
				Math.abs(cost - priceMTokFromCard(CARD_V41_FLASH)) < 0.000001,
				`${model}: got ${cost}, want ${priceMTokFromCard(CARD_V41_FLASH)}`,
			);
		});

		it(`still prices ${model} at its own card before its cutover`, () => {
			const cost = calculateClaudeCost(model, MTOK_IN_OUT, before);
			assert.ok(
				Math.abs(cost - priceMTokFromCard(oldCard)) < 0.000001,
				`${model}: got ${cost}, want ${priceMTokFromCard(oldCard)}`,
			);
		});
	}

	it("prices deepseek-v4-pro at 2.64 on 2026-09-11, while flash is already on the V4.1 card", () => {
		const pro = calculateClaudeCost("deepseek-v4-pro", MTOK_IN_OUT, ON_2026_09_11);
		assert.ok(Math.abs(pro - 2.64) < 0.000001, `got ${pro}, want 2.64`);
		const flash = calculateClaudeCost("deepseek-v4-flash", MTOK_IN_OUT, ON_2026_09_11);
		assert.ok(Math.abs(flash - 0.75) < 0.000001, `got ${flash}, want 0.75`);
	});

	it("prices deepseek-v4-pro at 2.64 after 2026-09-14", () => {
		const cost = calculateClaudeCost("deepseek-v4-pro", MTOK_IN_OUT, AFTER_2026_09_14);
		assert.ok(Math.abs(cost - 2.64) < 0.000001, `got ${cost}, want 2.64`);
	});

	it("doubles deepseek-v4-pro's card at a weekday peak after 2026-09-14", () => {
		const cost = calculateClaudeCost("deepseek-v4-pro", MTOK_IN_OUT, Date.UTC(2026, 8, 15, 2, 0, 0));
		assert.ok(Math.abs(cost - 5.28) < 0.000001, `got ${cost}, want 5.28`);
	});

	it("prices an UNDATED turn at the standard row, not at the oldest card", () => {
		const pro = calculateClaudeCost("deepseek-v4-pro", MTOK_IN_OUT, 0);
		assert.ok(Math.abs(pro - 2.64) < 0.000001, `pro undated: got ${pro}, want 2.64`);
		for (const model of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
			const cost = calculateClaudeCost(model, MTOK_IN_OUT, 0);
			assert.ok(
				Math.abs(cost - priceMTokFromCard(CARD_V41_FLASH)) < 0.000001,
				`${model} undated: got ${cost}, want the standard row ${priceMTokFromCard(CARD_V41_FLASH)}`,
			);
		}
	});

	it("still prices every entry with an old card at the pre-2026-08-16 card", () => {
		// The oldest window must survive gaining a newer sibling: dateTiers
		// resolution walks them earliest-cutoff-first and takes the FIRST match,
		// so an unsorted or wrongly-ordered pair would serve the newer card to
		// an old turn.
		for (const [model, card] of Object.entries(CARD_BEFORE_2026_08_16)) {
			const cost = calculateClaudeCost(model, MTOK_IN_OUT, BEFORE_2026_08_16);
			assert.ok(
				Math.abs(cost - priceMTokFromCard(card)) < 0.000001,
				`${model}: got ${cost}, want ${priceMTokFromCard(card)}`,
			);
		}
	});
});

describe("#495 deepseek-v4-flash-vision-exp resolves to its own entry", () => {
	it("does not fall through to the flash entry it is a superstring of", () => {
		// The rates are identical today, so a numeric assertion would pass on the
		// wrong entry. Identity is the only thing that catches a future divergence
		// — which is the whole reason #495 asks for an explicit key.
		const vision = lookupModelPricing("deepseek/deepseek-v4-flash-vision-exp");
		assert.ok(vision);
		assert.strictEqual(vision, MODEL_PRICING["deepseek-v4-flash-vision-exp"]);
		assert.notStrictEqual(vision, MODEL_PRICING["deepseek-v4-flash"]);
	});
});

describe("#495 the renderer's surge display agrees with the pricing module", () => {
	it("marks exactly the hours the cost module charges 2x for, on a weekday", () => {
		const surge = getSurgeLocalHours("UTC", MON_OUTSIDE_WINDOWS, "deepseek-flash");
		for (let hour = 0; hour < 24; hour++) {
			const ts = Date.UTC(2026, 7, 24, hour, 0, 0); // Mon 2026-08-24
			const charged = getPeakMultiplier("deepseek-flash", ts) === 2.0;
			assert.strictEqual(
				surge.has(hour), charged,
				`hour ${hour}: renderer says surge=${surge.has(hour)}, pricing charges ${getPeakMultiplier("deepseek-flash", ts)}x`,
			);
		}
	});

	it("marks no hours at all on a Saturday", () => {
		// Weekends have been off-peak since 2026-08-23, so a surge band drawn
		// across a Saturday timeline is a claim the bill will not back up.
		const surge = getSurgeLocalHours("UTC", SAT_INSIDE_WINDOW_1, "deepseek-flash");
		assert.strictEqual(surge.size, 0);
	});

	it("treats an unparsed timestamp (0) as no surge, not as 'now'", () => {
		// wtft-parser stamps 0 when it cannot parse a turn's timestamp. `0 ||
		// Date.now()` used to hand that turn the wall clock, so the same historical
		// turn priced differently on every run. Unknown instant => no surge, which
		// is how resolveTieredRates already treats the same 0.
		assert.strictEqual(getPeakMultiplier("deepseek-flash", 0), 1.0);
	});

	it("reports surge proximity from the passed instant, never the host clock", () => {
		assert.strictEqual(checkSurgeProximity(MON_INSIDE_WINDOW_1, "deepseek-flash").status, "surge");
		assert.strictEqual(checkSurgeProximity(MON_INSIDE_WINDOW_1, "deepseek-flash").multiplier, 2.0);
		assert.strictEqual(checkSurgeProximity(MON_OUTSIDE_WINDOWS, "deepseek-flash").status, undefined);
		assert.strictEqual(checkSurgeProximity(MON_OUTSIDE_WINDOWS, "deepseek-flash").multiplier, 1.0);
	});

	it("reports no surge inside a window on a weekend", () => {
		assert.strictEqual(checkSurgeProximity(SAT_INSIDE_WINDOW_1, "deepseek-flash").status, undefined);
		assert.strictEqual(checkSurgeProximity(SAT_INSIDE_WINDOW_1, "deepseek-flash").multiplier, 1.0);
		assert.strictEqual(checkSurgeProximity(SUN_INSIDE_WINDOW_2, "deepseek-flash").status, undefined);
	});
});

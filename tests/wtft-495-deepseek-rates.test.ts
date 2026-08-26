/**
 * Tests for #495 — DeepSeek rate card and peak schedule, both of which moved
 * after wtft's registry was written.
 *
 * Two independent changes, a week apart, neither of which wtft carried
 * (the NINE days is a different interval — filing to scrape, 08-16 to 08-25):
 *   - 2026-08-16 16:00 UTC — the rate card changed. v4-pro got much cheaper,
 *     v4-flash got dearer, and the two errors partly cancel in a TOTAL, which
 *     is why the readout never looked obviously broken.
 *   - 2026-08-23 — weekends became off-peak all day. Peak is now Mon–Fri only.
 *
 * Every CURRENT-card number here comes from the rate card scraped on 2026-08-25
 * and committed at `research/495-deepseek-pricing/pricing-page-2026-08-25.md`
 * — never recomputed the way the code computes it. The registry's unconditioned
 * rates are the off-peak card and peak is 2x, which is the same card the docs
 * state as "off-peak rates are half of the peak rates".
 *
 * `CARD_BEFORE_2026_08_16` is NOT from that scrape and cannot be: DeepSeek
 * publishes one card, the current one. Those five numbers are the superseded
 * card, transcribed from issue #495's own table (which measured them against
 * 854 live turns). Said plainly because "every number comes from the scrape"
 * was written here first and was false.
 *
 * Every timestamp is explicit. Resolution must read the passed timestamp and
 * never the host clock (#96: a dated DeepSeek surge test that read Date.now()
 * went flaky near a window edge) — including an explicit `0`, which is what
 * wtft-parser stamps on a turn whose timestamp it could not parse.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import {
	getDeepSeekPeakMultiplier,
	calculateClaudeCost,
	lookupModelPricing,
	MODEL_PRICING,
	getSurgeLocalHours,
	checkSurgeProximity,
} from "../bin/wtft.mjs";

// --- Fixed instants, named by what makes them interesting ---

// Named by what makes each instant interesting. The window hours are NOT
// re-typed here — read them from DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES; these
// fixtures say only "inside window 1", "outside both", and so on, so a
// schedule change makes the assertions fail rather than the comments lie.
const MON_INSIDE_WINDOW_1 = Date.UTC(2026, 7, 24, 2, 0, 0);   // Mon 2026-08-24 02:00Z
const MON_INSIDE_WINDOW_2 = Date.UTC(2026, 7, 24, 7, 0, 0);   // Mon 2026-08-24 07:00Z
const MON_OUTSIDE_WINDOWS = Date.UTC(2026, 7, 24, 12, 0, 0);  // Mon 2026-08-24 12:00Z
const SAT_INSIDE_WINDOW_1 = Date.UTC(2026, 7, 29, 2, 0, 0);   // Sat 2026-08-29 02:00Z
const SUN_INSIDE_WINDOW_2 = Date.UTC(2026, 7, 30, 7, 0, 0);   // Sun 2026-08-30 07:00Z

// Before the 2026-08-23 schedule change, a weekend inside a window was peak.
const SAT_BEFORE_SCHEDULE_CHANGE = Date.UTC(2026, 7, 15, 2, 0, 0); // Sat 2026-08-15 02:00Z

describe("#495 getDeepSeekPeakMultiplier — weekends are off-peak from 2026-08-23", () => {
	it("is peak on a weekday inside either window", () => {
		assert.strictEqual(getDeepSeekPeakMultiplier(MON_INSIDE_WINDOW_1), 2.0);
		assert.strictEqual(getDeepSeekPeakMultiplier(MON_INSIDE_WINDOW_2), 2.0);
	});

	it("is off-peak on a weekday outside both windows", () => {
		assert.strictEqual(getDeepSeekPeakMultiplier(MON_OUTSIDE_WINDOWS), 1.0);
	});

	it("is off-peak on a Saturday inside a window", () => {
		assert.strictEqual(getDeepSeekPeakMultiplier(SAT_INSIDE_WINDOW_1), 1.0);
	});

	it("is off-peak on a Sunday inside a window", () => {
		assert.strictEqual(getDeepSeekPeakMultiplier(SUN_INSIDE_WINDOW_2), 1.0);
	});

	it("still charges peak on a weekend before the 2026-08-23 change", () => {
		// The schedule change is not retroactive: a July or early-August
		// weekend session really was billed at the surge rate.
		assert.strictEqual(getDeepSeekPeakMultiplier(SAT_BEFORE_SCHEDULE_CHANGE), 2.0);
	});
});

// --- The rate card ---
//
// Rates below are transcribed from the committed scrape, not derived. The
// registry stores OFF-PEAK as the base and applies 2x at peak, which is the
// same card the docs state the other way round ("off-peak rates are half of
// the peak rates").

type Card = { cacheMiss: number; output: number; cacheHit: number };

const CARD_FROM_2026_08_16: Record<string, Card> = {
	"deepseek-v4-pro":              { cacheMiss: 0.66, output: 1.98, cacheHit: 0.022 },
	"deepseek-v4-flash":            { cacheMiss: 0.22, output: 0.66, cacheHit: 0.007 },
	"deepseek-v4-flash-vision-exp": { cacheMiss: 0.22, output: 0.66, cacheHit: 0.007 },
};

const CARD_BEFORE_2026_08_16: Record<string, Card> = {
	"deepseek-v4-pro":   { cacheMiss: 1.74, output: 3.48, cacheHit: 0.0145 },
	"deepseek-v4-flash": { cacheMiss: 0.14, output: 0.28, cacheHit: 0.0028 },
};

// A weekday outside both peak windows, on each side of the 16:00Z cutover.
const AFTER_CUTOVER = Date.UTC(2026, 7, 24, 12, 0, 0);   // Mon 2026-08-24 12:00Z
const BEFORE_CUTOVER = Date.UTC(2026, 6, 15, 12, 0, 0);  // Wed 2026-07-15 12:00Z

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

describe("#495 DeepSeek rate card, current and historical", () => {
	for (const [model, card] of Object.entries(CARD_FROM_2026_08_16)) {
		it(`prices ${model} at the post-2026-08-16 card`, () => {
			const cost = calculateClaudeCost(model, USAGE, AFTER_CUTOVER);
			assert.ok(
				Math.abs(cost - priceFromCard(card)) < 0.000001,
				`${model}: got ${cost}, want ${priceFromCard(card)}`,
			);
		});
	}

	for (const [model, card] of Object.entries(CARD_BEFORE_2026_08_16)) {
		it(`still prices ${model} at the old card before the cutover`, () => {
			const cost = calculateClaudeCost(model, USAGE, BEFORE_CUTOVER);
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
		}, AFTER_CUTOVER);
		assert.strictEqual(cost, 0);
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

// --- One definition of the windows ---
//
// The schedule was hardcoded in four places, with nothing that failed when a
// change missed one. These tests do NOT grep for the literals: a source-text
// check would survive deleting the thing it names (#408).
//
// What they actually guard, stated exactly, because an earlier wording here
// claimed more than the assertions deliver: they pin that the renderer
// DELEGATES to the pricing module rather than deciding surge itself. Today
// `getSurgeLocalHours` calls `getDeepSeekPeakMultiplier`, so with tz="UTC" the
// comparison below is a tautology and CANNOT fail — that is the point. It goes
// red the moment someone re-introduces an independent copy in the renderer that
// answers differently, which is the regression #495 removed. It is not, and
// cannot be, a check that a schedule change reached two places; there is only
// one place left for it to reach.

describe("#495 the renderer's surge display agrees with the pricing module", () => {
	it("marks exactly the hours the cost module charges 2x for, on a weekday", () => {
		const surge = getSurgeLocalHours("UTC", MON_OUTSIDE_WINDOWS);
		for (let hour = 0; hour < 24; hour++) {
			const ts = Date.UTC(2026, 7, 24, hour, 0, 0); // Mon 2026-08-24
			const charged = getDeepSeekPeakMultiplier(ts) === 2.0;
			assert.strictEqual(
				surge.has(hour), charged,
				`hour ${hour}: renderer says surge=${surge.has(hour)}, pricing charges ${getDeepSeekPeakMultiplier(ts)}x`,
			);
		}
	});

	it("marks no hours at all on a Saturday", () => {
		// Weekends have been off-peak since 2026-08-23, so a surge band drawn
		// across a Saturday timeline is a claim the bill will not back up.
		const surge = getSurgeLocalHours("UTC", SAT_INSIDE_WINDOW_1);
		assert.strictEqual(surge.size, 0);
	});

	it("treats an unparsed timestamp (0) as no surge, not as 'now'", () => {
		// wtft-parser stamps 0 when it cannot parse a turn's timestamp. `0 ||
		// Date.now()` used to hand that turn the wall clock, so the same historical
		// turn priced differently on every run. Unknown instant => no surge, which
		// is how resolveTieredRates already treats the same 0.
		assert.strictEqual(getDeepSeekPeakMultiplier(0), 1.0);
	});

	it("reports surge proximity from the passed instant, never the host clock", () => {
		assert.strictEqual(checkSurgeProximity(MON_INSIDE_WINDOW_1).status, "surge");
		assert.strictEqual(checkSurgeProximity(MON_INSIDE_WINDOW_1).multiplier, 2.0);
		assert.strictEqual(checkSurgeProximity(MON_OUTSIDE_WINDOWS).status, undefined);
		assert.strictEqual(checkSurgeProximity(MON_OUTSIDE_WINDOWS).multiplier, 1.0);
	});

	it("reports no surge inside a window on a weekend", () => {
		assert.strictEqual(checkSurgeProximity(SAT_INSIDE_WINDOW_1).status, undefined);
		assert.strictEqual(checkSurgeProximity(SAT_INSIDE_WINDOW_1).multiplier, 1.0);
		assert.strictEqual(checkSurgeProximity(SUN_INSIDE_WINDOW_2).status, undefined);
	});
});

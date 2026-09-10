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
 * #100 made the 2026-08-25 scrape a SUPERSEDED card too, so the same sentence
 * now applies to it: on 2026-09-10T04:00Z V4.1 Flash retired the whole V4 Flash
 * line, and on 2026-09-14T04:00Z it takes over `deepseek-v4-pro` as well. The
 * current card comes from a second committed scrape,
 * `research/100-deepseek-v41-flash/pricing-page-2026-09-10.md`. Three names now
 * bill at ONE card on a current turn, which is why the identity assertions below
 * matter more than the numeric ones: every numeric check would pass on the wrong
 * entry today.
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
	isModelPriced,
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

// The card in force ON `AFTER_CUTOVER` below — no longer "the current card",
// which is the whole of #100. It is the 2026-08-25 scrape, and it is now a
// dateTiers window on all three entries: it ended 2026-09-10T04:00Z for the two
// flash names and ends 2026-09-14T04:00Z for pro. Named for the instant it is
// asserted at rather than for an open-ended "from", so the next card change
// makes this table's name wrong rather than quietly makes its numbers wrong.
const CARD_ON_2026_08_24: Record<string, Card> = {
	"deepseek-v4-pro":              { cacheMiss: 0.66, output: 1.98, cacheHit: 0.022 },
	"deepseek-v4-flash":            { cacheMiss: 0.22, output: 0.66, cacheHit: 0.007 },
	"deepseek-v4-flash-vision-exp": { cacheMiss: 0.22, output: 0.66, cacheHit: 0.007 },
};

const CARD_BEFORE_2026_08_16: Record<string, Card> = {
	"deepseek-v4-pro":   { cacheMiss: 1.74, output: 3.48, cacheHit: 0.0145 },
	"deepseek-v4-flash": { cacheMiss: 0.14, output: 0.28, cacheHit: 0.0028 },
};

// The V4.1 Flash card (#100), transcribed from
// research/100-deepseek-v41-flash/pricing-page-2026-09-10.md. Off-peak, like
// every row in this file; peak is 2x.
const CARD_V41_FLASH: Card = { cacheMiss: 0.15, output: 0.60, cacheHit: 0.003 };

// A weekday outside both peak windows, on each side of the 16:00Z cutover.
const AFTER_CUTOVER = Date.UTC(2026, 7, 24, 12, 0, 0);   // Mon 2026-08-24 12:00Z
const BEFORE_CUTOVER = Date.UTC(2026, 6, 15, 12, 0, 0);  // Wed 2026-07-15 12:00Z

// #100's two cutovers, sampled on a weekday outside both peak windows so the
// surge multiplier is 1.0 and only the CARD is under test. Thu 2026-09-10 and
// Mon 2026-09-14 are both weekdays; 12:00Z is outside 01:00–04:00 and 06:00–10:00.
const AFTER_V41_FLASH = Date.UTC(2026, 8, 10, 12, 0, 0);   // Thu 2026-09-10 12:00Z
const BEFORE_V41_FLASH = Date.UTC(2026, 8, 9, 12, 0, 0);   // Wed 2026-09-09 12:00Z
const AFTER_PRO_REROUTE = Date.UTC(2026, 8, 14, 12, 0, 0); // Mon 2026-09-14 12:00Z
const BEFORE_PRO_REROUTE = Date.UTC(2026, 8, 11, 12, 0, 0);// Fri 2026-09-11 12:00Z

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
	for (const [model, card] of Object.entries(CARD_ON_2026_08_24)) {
		it(`prices ${model} at the card in force on 2026-08-24`, () => {
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

// --- #100: V4.1 Flash ---
//
// One model behind three names. `deepseek-flash` IS V4.1 Flash; the two v4-flash
// names route to it from 2026-09-10T04:00Z and `deepseek-v4-pro` from
// 2026-09-14T04:00Z. So on any current turn all four registry entries resolve to
// the same quad, and every NUMERIC assertion below would also pass against the
// wrong entry. The identity assertions are what carry the weight.

// 1M cache-miss input + 1M output, the shape #100's closer prices. No cache
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
		assert.ok(!"deepseek-v4-flash".includes("deepseek-flash"));
		assert.ok(!"deepseek-flash".includes("deepseek-v4-flash"));
		assert.strictEqual(
			lookupModelPricing("deepseek/deepseek-v4-flash"),
			MODEL_PRICING["deepseek-v4-flash"],
		);
	});

	it("prices 1M cache-miss in + 1M out at $0.75 off-peak", () => {
		const cost = calculateClaudeCost("deepseek-flash", MTOK_IN_OUT, AFTER_V41_FLASH);
		assert.ok(
			Math.abs(cost - 0.75) < 0.000001,
			`got ${cost}, want 0.75 (= ${priceMTokFromCard(CARD_V41_FLASH)} from the card)`,
		);
	});

	it("prices the same turn at $1.50 inside a weekday peak window", () => {
		// Thu 2026-09-10 02:00Z — inside window 1 on a weekday. Off-peak is half
		// of peak, which is the card DeepSeek publishes, so this is 2x the case
		// above and NOT an independently transcribed number.
		const peakInstant = Date.UTC(2026, 8, 10, 2, 0, 0);
		assert.strictEqual(getDeepSeekPeakMultiplier(peakInstant), 2.0);
		const cost = calculateClaudeCost("deepseek-flash", MTOK_IN_OUT, peakInstant);
		assert.ok(Math.abs(cost - 1.50) < 0.000001, `got ${cost}, want 1.50`);
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
	// Both flash names retired at 2026-09-10T04:00Z; pro reroutes 4 days later.
	// Each is checked on BOTH sides of ITS OWN cutover — a single shared date
	// would pass while pricing one of the two lines wrong for four days.
	const cases: Array<[string, number, number, Card]> = [
		["deepseek-v4-flash", BEFORE_V41_FLASH, AFTER_V41_FLASH, CARD_ON_2026_08_24["deepseek-v4-flash"]],
		["deepseek-v4-flash-vision-exp", BEFORE_V41_FLASH, AFTER_V41_FLASH, CARD_ON_2026_08_24["deepseek-v4-flash-vision-exp"]],
		["deepseek-v4-pro", BEFORE_PRO_REROUTE, AFTER_PRO_REROUTE, CARD_ON_2026_08_24["deepseek-v4-pro"]],
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

	it("charges deepseek-v4-pro the Pro card in the four-day gap between the cutovers", () => {
		// The gap is the whole reason there are two constants. A single
		// 2026-09-10 cutover for both lines would price a Fri 2026-09-11 pro
		// turn at 0.75 when DeepSeek billed 2.64 — and every other case in this
		// file would still be green.
		const cost = calculateClaudeCost("deepseek-v4-pro", MTOK_IN_OUT, BEFORE_PRO_REROUTE);
		assert.ok(Math.abs(cost - 2.64) < 0.000001, `got ${cost}, want 2.64`);
	});

	it("still prices all three at the pre-2026-08-16 card where they had one", () => {
		// The oldest window must survive gaining a newer sibling: dateTiers
		// resolution walks them earliest-cutoff-first and takes the FIRST match,
		// so an unsorted or wrongly-ordered pair would serve the newer card to
		// an old turn.
		for (const [model, card] of Object.entries(CARD_BEFORE_2026_08_16)) {
			const cost = calculateClaudeCost(model, MTOK_IN_OUT, BEFORE_CUTOVER);
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

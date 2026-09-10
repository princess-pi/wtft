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
 * Every number in the 2026-08-16 card comes from the rate card scraped on
 * 2026-08-25 and committed at
 * `princess-pi-tools/research/495-deepseek-pricing/pricing-page-2026-08-25.md`
 * — in the ORIGIN repo, not this one — never recomputed the way the code
 * computes it. That card is no longer the current one; see #100 below. The registry's unconditioned
 * rates are the off-peak card and peak is 2x, which is the same card the docs
 * state as "off-peak rates are half of the peak rates".
 *
 * `CARD_BEFORE_2026_08_16` is NOT from that scrape and cannot be: DeepSeek
 * publishes one card, the current one. Those numbers — six of them, two models
 * by three rates — are the superseded card, transcribed from issue #495's own
 * table (which measured them against 854 live turns). Said plainly because "every number comes from the scrape"
 * was written here first and was false.
 *
 * #100 made the 2026-08-25 scrape a SUPERSEDED card too, so the same sentence
 * now applies to it: on 2026-09-10T04:00Z V4.1 Flash retired the whole V4 Flash
 * line, and on 2026-09-14T04:00Z it takes over `deepseek-v4-pro` as well. The
 * current card comes from a second committed scrape,
 * `research/100-deepseek-v41-flash/pricing-page-2026-09-10.md`, which IS in this
 * repo.
 *
 * All four entries carry ONE standard row, so a current-card numeric check would
 * pass against the wrong entry — which is why the identity assertions matter
 * more than the numeric ones here. Stated exactly, because an earlier draft said
 * "every numeric check would pass on the wrong entry": the DATED windows still
 * discriminate, so the before-cutover cases and the $2.64 v4-pro case do bite on
 * identity. It is the current-card cases that cannot.
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

// The 2026-08-25 scrape's card. On 2026-08-24 it is in force for all three
// names; it is now a dateTiers window on each, ending 2026-09-10T04:00Z for the
// two flash names and 2026-09-14T04:00Z for pro — so on 2026-09-11 it is STILL
// the live card for v4-pro alone. Used at three instants below for exactly that
// reason, which is why it is named for the card and not for one instant.
// After 2026-09-14T04:00Z it is the current card for no name at all.
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
		//
		// Read the keys OUT OF THE REGISTRY. An earlier draft compared two string
		// literals, which is a fact about this file rather than about the code —
		// it passed unchanged with both entries deleted.
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
		// Stated in prose at the registry entry and, until now, asserted nowhere.
		// Adding a window there would leave every other case in this file green,
		// because all four entries share one standard row: the rates cannot tell
		// them apart, only the structure can.
		assert.strictEqual(MODEL_PRICING["deepseek-flash"].dateTiers, undefined);
		// The contrast that makes it meaningful — the three retired names do.
		for (const key of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4-pro"]) {
			assert.strictEqual(MODEL_PRICING[key].dateTiers?.length, 2, `${key} should carry two dated windows`);
		}
	});

	it("prices 1M cache-miss in + 1M out at $0.75 off-peak", () => {
		// The expected figure comes from the card, not a second hardcoded 0.75 —
		// an earlier draft asserted the literal while the failure message quoted
		// the card, so editing the fixture desynced the two without going red.
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
		assert.strictEqual(getDeepSeekPeakMultiplier(peakInstant), 2.0);
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
	// Both flash names retired at 2026-09-10T04:00Z; pro reroutes 4 days later.
	// Each is checked on BOTH sides of ITS OWN cutover — a single shared date
	// would pass while pricing one of the two lines wrong for four days.
	const cases: Array<[string, number, number, Card]> = [
		["deepseek-v4-flash", BEFORE_V41_FLASH, AFTER_V41_FLASH, CARD_2026_08_16["deepseek-v4-flash"]],
		["deepseek-v4-flash-vision-exp", BEFORE_V41_FLASH, AFTER_V41_FLASH, CARD_2026_08_16["deepseek-v4-flash-vision-exp"]],
		["deepseek-v4-pro", BEFORE_PRO_REROUTE, AFTER_PRO_REROUTE, CARD_2026_08_16["deepseek-v4-pro"]],
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

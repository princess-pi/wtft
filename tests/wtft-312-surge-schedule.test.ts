/**
 * A model card's surge field is the schedule. The id does not have to
 * contain a vendor name, and the approaching and ending leads are the
 * two constants beside checkSurgeProximity.
 */

import * as assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import {
	MODEL_PRICING,
	applyUserPricing,
	calculateClaudeCost,
	getPeakMultiplier,
	type ModelPricing,
} from "../extensions/lib/wtft-cost.ts";
import {
	SURGE_APPROACH_MINUTES,
	SURGE_ENDING_MINUTES,
	buildTimelineString,
	checkSurgeProximity,
	getSurgeLocalHours,
} from "../extensions/lib/wtft-renderer.ts";

const CARD = "acme-peak";
const MONDAY = Date.UTC(2026, 7, 24);
const minute = (m: number) => MONDAY + m * 60_000;

const card: ModelPricing = {
	input: 1, output: 1, cacheRead: 1, cacheWrite: 0,
	surge: { multiplier: 3, windowsUtcMinutes: [[60, 120]] },
};
MODEL_PRICING[CARD] = card;

after(() => {
	delete MODEL_PRICING[CARD];
});

const usage = {
	input_tokens: 1_000_000,
	output_tokens: 0,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 0,
	cache_creation: {},
};

describe("#312 a card carries its own surge schedule", () => {
	it("bills the card's multiplier inside its window and 1 outside", () => {
		assert.equal(getPeakMultiplier(CARD, minute(60)), 3);
		assert.equal(getPeakMultiplier(CARD, minute(119)), 3);
		assert.equal(getPeakMultiplier(CARD, minute(120)), 1);
		assert.equal(getPeakMultiplier("claude-opus-4-6", minute(60)), 1);
		assert.equal(calculateClaudeCost(CARD, usage, minute(60)), 3);
		assert.equal(calculateClaudeCost(CARD, usage, minute(120)), 1);
	});

	it("colors only the hours the card charges, and the badge prints the multiplier", () => {
		const hours = getSurgeLocalHours("UTC", minute(0), CARD);
		assert.deepEqual([...hours], [1]);
		assert.equal(getSurgeLocalHours("UTC", minute(0), "claude-opus-4-6").size, 0);
		const line = buildTimelineString(hours, 1, "surge", undefined, true, 3);
		assert.ok(line.includes("SURGE 3x"));
	});

	it("reads the two lead constants, both 20 minutes", () => {
		assert.equal(SURGE_APPROACH_MINUTES, 20);
		assert.equal(SURGE_ENDING_MINUTES, 20);
		assert.equal(checkSurgeProximity(minute(60 - SURGE_APPROACH_MINUTES), CARD).status, "approaching");
		assert.equal(checkSurgeProximity(minute(60 - SURGE_APPROACH_MINUTES - 1), CARD).status, undefined);
		assert.equal(checkSurgeProximity(minute(120 - SURGE_ENDING_MINUTES), CARD).status, "ending");
		assert.equal(checkSurgeProximity(minute(120 - SURGE_ENDING_MINUTES - 1), CARD).status, "surge");
	});

	it("rejects a surge schedule that cannot be walked, and keeps DeepSeek's schedule when an override omits it", () => {
		const flash = MODEL_PRICING["deepseek-flash"];
		applyUserPricing({
			"bad-surge": { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, surge: { multiplier: "no" } } as never,
		});
		assert.equal(MODEL_PRICING["bad-surge"], undefined);
		assert.equal(getPeakMultiplier("bad-surge", minute(60)), 1);

		applyUserPricing({ "deepseek-flash": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
		assert.equal(getPeakMultiplier("deepseek-flash", minute(60)), 2);
		MODEL_PRICING["deepseek-flash"] = flash;

		applyUserPricing({ "deepseek-v5": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
		assert.equal(getPeakMultiplier("deepseek-v5", minute(60)), 2);
		delete MODEL_PRICING["deepseek-v5"];

		applyUserPricing({
			"flat-surge": { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, surge: { multiplier: 1, windowsUtcMinutes: [[60, 120]] } } as never,
		});
		assert.equal(MODEL_PRICING["flat-surge"], undefined);
		applyUserPricing({
			"wrapped-window": { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, surge: { multiplier: 2, windowsUtcMinutes: [[1380, 60]] } } as never,
		});
		assert.equal(MODEL_PRICING["wrapped-window"], undefined);
	});

	it("bills a 1-hour cache write from the card's input, not the surged input", () => {
		MODEL_PRICING["acme-write"] = {
			input: 1, output: 1, cacheRead: 1, cacheWrite: 1.25,
			surge: { multiplier: 3, windowsUtcMinutes: [[60, 120]] },
		};
		const write = {
			input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
			cache_creation_input_tokens: 1_000_000,
			cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
		};
		assert.equal(calculateClaudeCost("acme-write", write, minute(60)), 2);
		delete MODEL_PRICING["acme-write"];
	});

	it("warns before a window that opens in the first approach minutes after midnight", () => {
		MODEL_PRICING["acme-midnight"] = {
			input: 1, output: 1, cacheRead: 1, cacheWrite: 0,
			surge: { multiplier: 2, windowsUtcMinutes: [[0, 60]] },
		};
		assert.equal(checkSurgeProximity(minute(1420), "acme-midnight").status, "approaching");
		assert.equal(checkSurgeProximity(minute(1419), "acme-midnight").status, undefined);
		delete MODEL_PRICING["acme-midnight"];
	});
});

describe("#20 SURGE ENDING is the last lead inside a DeepSeek window", () => {
	it("prints ending 40 times on a Wednesday and never on a Saturday", () => {
		const count = (day: number) => {
			const seen: Record<string, number> = {};
			for (let m = 0; m < 1440; m++) {
				const ts = Date.UTC(2026, 7, day, 0, m, 0);
				const status = String(checkSurgeProximity(ts, "deepseek-flash").status);
				seen[status] = (seen[status] ?? 0) + 1;
			}
			return seen;
		};
		const wednesday = count(26);
		assert.equal(wednesday.ending, 40);
		assert.equal(wednesday.approaching, 40);
		assert.equal(wednesday.surge, 380);
		const saturday = count(29);
		assert.equal(saturday.undefined, 1440);
		assert.equal(saturday.ending, undefined);
	});
});

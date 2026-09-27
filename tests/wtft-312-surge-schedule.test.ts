/**
 * A model card's surge field is the schedule. The id does not have to
 * contain a vendor name, and the approaching and ending leads are the
 * two constants beside checkSurgeProximity.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, after } from "node:test";
import {
	MODEL_PRICING,
	applyUserPricing,
	calculateClaudeCost,
	describeFallbackPricing,
	getPeakMultiplier,
	type ModelPricing,
} from "../extensions/lib/wtft-cost.ts";
import { loadUserPricing } from "../extensions/lib/wtft-pricing-config.ts";
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
		const line = buildTimelineString(hours, 1, "|", "|", "*", "surge", true, 3);
		assert.ok(line.includes("SURGE 3x"));
	});

	it("colors an hour when the window covers part of it", () => {
		MODEL_PRICING["acme-partial"] = {
			input: 1, output: 1, cacheRead: 1, cacheWrite: 0,
			surge: { multiplier: 3, windowsUtcMinutes: [[70, 110]] },
		};
		assert.deepEqual([...getSurgeLocalHours("UTC", minute(0), "acme-partial")], [1]);
		assert.equal(getPeakMultiplier("acme-partial", minute(60)), 1);
		assert.equal(getPeakMultiplier("acme-partial", minute(70)), 3);
		delete MODEL_PRICING["acme-partial"];
	});

	it("reads the two lead constants, both 20 minutes", () => {
		assert.equal(SURGE_APPROACH_MINUTES, 20);
		assert.equal(SURGE_ENDING_MINUTES, 20);
		assert.equal(checkSurgeProximity(minute(60 - SURGE_APPROACH_MINUTES), CARD).status, "approaching");
		assert.equal(checkSurgeProximity(minute(60 - SURGE_APPROACH_MINUTES - 1), CARD).status, undefined);
		assert.equal(checkSurgeProximity(minute(120 - SURGE_ENDING_MINUTES), CARD).status, "ending");
		assert.equal(checkSurgeProximity(minute(120 - SURGE_ENDING_MINUTES - 1), CARD).status, "surge");
	});

	it("keeps the rates when a surge schedule cannot be walked, and says why", () => {
		const flash = MODEL_PRICING["deepseek-flash"];
		const bad = applyUserPricing({
			"bad-surge": { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, surge: { multiplier: "no" } } as never,
		});
		assert.equal(bad.length, 1);
		assert.match(bad[0].reason, /above 1/);
		assert.equal(MODEL_PRICING["bad-surge"].input, 1);
		assert.equal(getPeakMultiplier("bad-surge", minute(60)), 1);
		delete MODEL_PRICING["bad-surge"];

		applyUserPricing({ "deepseek-flash": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
		assert.equal(getPeakMultiplier("deepseek-flash", minute(60)), 2);
		MODEL_PRICING["deepseek-flash"] = flash;

		applyUserPricing({ "deepseek-v5": { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
		assert.equal(getPeakMultiplier("deepseek-v5", minute(60)), 2);
		delete MODEL_PRICING["deepseek-v5"];

		applyUserPricing({
			"deepseek-flash": { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, surge: null },
		});
		assert.equal(getPeakMultiplier("deepseek-flash", minute(60)), 1);
		assert.equal(calculateClaudeCost("deepseek-flash", usage, minute(60)), 9);
		MODEL_PRICING["deepseek-flash"] = flash;

		const flat = applyUserPricing({
			"flat-surge": { input: 4, output: 1, cacheRead: 1, cacheWrite: 0, surge: { multiplier: 1, windowsUtcMinutes: [[60, 120]] } } as never,
		});
		assert.equal(flat.length, 1);
		assert.equal(MODEL_PRICING["flat-surge"].input, 4);
		assert.equal(getPeakMultiplier("flat-surge", minute(60)), 1);
		delete MODEL_PRICING["flat-surge"];

		const wrapped = applyUserPricing({
			"wrapped-window": { input: 5, output: 1, cacheRead: 1, cacheWrite: 0, surge: { multiplier: 2, windowsUtcMinutes: [[1380, 60]] } } as never,
		});
		assert.equal(wrapped.length, 1);
		assert.match(wrapped[0].reason, /two windows/);
		assert.equal(MODEL_PRICING["wrapped-window"].input, 5);
		assert.equal(getPeakMultiplier("wrapped-window", minute(60)), 1);
		delete MODEL_PRICING["wrapped-window"];
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

	it("asks the next UTC day whether a midnight window will bill", () => {
		const from = Date.parse("2026-08-23T00:00:00Z");
		MODEL_PRICING["acme-weekend"] = {
			input: 1, output: 1, cacheRead: 1, cacheWrite: 0,
			surge: { multiplier: 2, windowsUtcMinutes: [[0, 60]], weekendOffPeakFrom: from },
		};
		const friday = Date.UTC(2026, 7, 28, 23, 40, 0);
		const sunday = Date.UTC(2026, 7, 30, 23, 40, 0);
		assert.equal(checkSurgeProximity(friday, "acme-weekend").status, undefined);
		assert.equal(checkSurgeProximity(sunday, "acme-weekend").status, "approaching");
		delete MODEL_PRICING["acme-weekend"];
	});

	it("keeps surge while the next window still bills, including across midnight", () => {
		MODEL_PRICING["acme-split"] = {
			input: 1, output: 1, cacheRead: 1, cacheWrite: 0,
			surge: { multiplier: 2, windowsUtcMinutes: [[0, 60], [1380, 1440]] },
		};
		assert.equal(checkSurgeProximity(minute(1425), "acme-split").status, "surge");
		delete MODEL_PRICING["acme-split"];

		MODEL_PRICING["acme-touch"] = {
			input: 1, output: 1, cacheRead: 1, cacheWrite: 0,
			surge: { multiplier: 2, windowsUtcMinutes: [[60, 240], [240, 300]] },
		};
		assert.equal(checkSurgeProximity(minute(220), "acme-touch").status, "surge");
		assert.equal(checkSurgeProximity(minute(280), "acme-touch").status, "ending");
		delete MODEL_PRICING["acme-touch"];

		MODEL_PRICING["acme-late"] = {
			input: 1, output: 1, cacheRead: 1, cacheWrite: 0,
			surge: { multiplier: 2, windowsUtcMinutes: [[1380, 1440]] },
		};
		assert.equal(checkSurgeProximity(minute(1425), "acme-late").status, "ending");
		delete MODEL_PRICING["acme-late"];
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

describe("a surge schedule that cannot be walked is printed", () => {
	it("loadUserPricing names the key and the reason on stderr", () => {
		const tmp = path.join(os.tmpdir(), `wtft-312-bad-surge-${process.pid}.json`);
		fs.writeFileSync(tmp, JSON.stringify({
			"loud-surge": {
				input: 1, output: 1, cacheRead: 1, cacheWrite: 0,
				surge: { multiplier: 2, windowsUtcMinutes: [[1380, 60]] },
			},
		}));
		const lines: string[] = [];
		const orig = console.error;
		console.error = (msg?: unknown) => { lines.push(String(msg)); };
		try {
			loadUserPricing(tmp);
			assert.equal(MODEL_PRICING["loud-surge"].input, 1);
		} finally {
			console.error = orig;
			fs.unlinkSync(tmp);
			delete MODEL_PRICING["loud-surge"];
		}
		assert.match(lines.join("\n"), /loud-surge/);
		assert.match(lines.join("\n"), /two windows/);
	});
});

describe("fallback warning follows the sibling schedule", () => {
	it("omits the surge note when the sibling card has no schedule", () => {
		assert.match(describeFallbackPricing("deepseek-reasoner"), /surge multiplier applied/);
		const flash = MODEL_PRICING["deepseek-v4-flash"];
		const saved = flash.surge;
		flash.surge = null;
		try {
			assert.doesNotMatch(describeFallbackPricing("deepseek-reasoner"), /surge multiplier applied/);
		} finally {
			flash.surge = saved;
		}
	});
});

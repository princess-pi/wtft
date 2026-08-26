/**
 * @package princess-pi-packages
 * @module wtft-pricing-manifest
 * @description Renders MODEL_PRICING as a manifest (#169).
 *
 * `docs/EXT_WTFT.html` used to hand-maintain its Model Pricing table. It went
 * stale the way a hand-maintained copy always does: it was still listing
 * Claude 4 and no Claude 5 family at all, no GPT-5.x, no notion of a dated or
 * size tier, and DeepSeek rates from before the 2026-08-16 card. A reader had
 * no way to know wtft prices those models at all.
 *
 * So the table is generated from the registry and the page fetches it, the same
 * shape as that page's flag reference. Stated precisely, because the looser
 * version of this sentence claimed too much: fetching removes PAGE-vs-MANIFEST
 * drift structurally — there is one copy, so there is nothing to disagree. It
 * does not remove MANIFEST-vs-CODE drift, which is a test's job. This manifest
 * gets that for free by being generated (`wtft-cmd.json` is hand-maintained and
 * relies on a test instead).
 *
 * `tests/wtft-pricing-manifest.test.ts` compares the committed manifest against
 * a fresh render, so a registry edit that skips `bun run build` is a red test
 * rather than a quietly stale page.
 */

import {
	MODEL_PRICING,
	DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES,
	DEEPSEEK_WEEKEND_OFFPEAK_FROM,
	type ModelPricing,
} from "./wtft-cost.js";

export const PRICING_MANIFEST_SCHEMA = "wtft-pricing/table@1";

/** One rate quad, plus the condition under which it applies. */
export interface ManifestRates {
	/** Human-readable condition. "" for a model's base rates. */
	condition: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ManifestModel {
	model: string;
	/** Base rates first, then any dated windows, then any size tiers. */
	rates: ManifestRates[];
}

export interface PricingManifest {
	schema: typeof PRICING_MANIFEST_SCHEMA;
	generatedFrom: string;
	units: string;
	deepseekSurge: {
		multiplier: number;
		windowsUtc: string[];
		weekendOffPeakFrom: string;
		note: string;
	};
	models: ManifestModel[];
}

/** "01:00–04:00" from a [start, end) pair of minutes since UTC midnight. */
function formatWindow([start, end]: readonly [number, number]): string {
	const hhmm = (m: number) =>
		`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
	return `${hhmm(start)}–${hhmm(end)}`;
}

/**
 * The UTC instant as ISO-8601, seconds precision — `2026-08-23T00:00:00Z`.
 *
 * An instant, not a day: these cutovers are exact moments (the rate card moved
 * at 16:00Z, not at midnight), and rounding one to a date would misprice the
 * hours on either side of it.
 */
function isoInstant(epochMs: number): string {
	// Truncate to the second rather than string-replacing ".000": a plain
	// String#replace only strips a literal ".000", so a cutover ever built with
	// a non-zero millisecond component would ship a stray ".123" into the
	// committed manifest instead of the documented seconds precision. Unreachable
	// today — every caller passes a Date.UTC value with no ms — which is exactly
	// when a guarantee stated only in prose rots unnoticed (PR #507 review).
	return new Date(Math.floor(epochMs / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

function ratesFor(pricing: ModelPricing): ManifestRates[] {
	const rows: ManifestRates[] = [{
		condition: "",
		input: pricing.input,
		output: pricing.output,
		cacheRead: pricing.cacheRead,
		cacheWrite: pricing.cacheWrite,
	}];

	for (const dt of [...(pricing.dateTiers ?? [])].sort((a, b) => a.effectiveBefore - b.effectiveBefore)) {
		rows.push({
			condition: `before ${isoInstant(dt.effectiveBefore)}`,
			input: dt.input, output: dt.output, cacheRead: dt.cacheRead, cacheWrite: dt.cacheWrite,
		});
	}

	for (const t of [...(pricing.tiers ?? [])].sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)) {
		rows.push({
			// "combined", because resolveTieredRates sums input + cacheRead +
			// cacheWrite tokens. Labelled "input over N" the threshold reads as
			// plain input, and a turn under it on that reading still gets the
			// higher rate.
			condition: `combined input over ${t.inputTokensAbove.toLocaleString("en-US")} tokens`,
			input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite,
		});
	}

	return rows;
}

/**
 * Render the current registry as a manifest. Pure — no fs, no clock, so the
 * test can compare it against the committed file without either drifting.
 */
export function buildPricingManifest(): PricingManifest {
	return {
		schema: PRICING_MANIFEST_SCHEMA,
		generatedFrom: "extensions/lib/wtft-cost.ts MODEL_PRICING",
		units: "USD per 1M tokens",
		deepseekSurge: {
			multiplier: 2.0,
			windowsUtc: DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES.map(formatWindow),
			weekendOffPeakFrom: isoInstant(DEEPSEEK_WEEKEND_OFFPEAK_FROM),
			// Every sentence names who it is true of. An earlier draft folded the
			// all-models reasoning-token rule into a DeepSeek-scoped paragraph, and
			// the page renders this under a table of Claude and GPT rows too (#495).
			// No backticks or markup: the page renders this through .textContent,
			// which would print them literally. And every sentence names who it is
			// true of — an earlier draft scoped an all-models rule to DeepSeek, and
			// then a correction overshot the other way and claimed the 1-hour rule
			// for models whose Cache Write is 0 (#495).
			note: "DeepSeek rows are the off-peak card; peak is 2x on the windows "
				+ "and weekdays given here. For DeepSeek only, the Input column is "
				+ "the cache-MISS rate and Cache Read the cache-HIT rate — the "
				+ "Anthropic-format endpoint reports no cache-creation tokens and "
				+ "bills a miss as plain input, so its cache writes genuinely cost "
				+ "nothing. For every model here, reasoning tokens bill at the "
				+ "output rate. Cache Write is the 5-minute-TTL rate; where it is "
				+ "above zero, a 1-hour-TTL write bills at 2x that row's input "
				+ "rate, and where it is zero both TTLs are free. Where a model "
				+ "shows a dated row, that row applies instead of the standard one "
				+ "until its date passes — the standard row is not necessarily the "
				+ "price in force today.",
		},
		models: Object.keys(MODEL_PRICING).sort().map(model => ({
			model,
			rates: ratesFor(MODEL_PRICING[model]),
		})),
	};
}

/** The exact bytes written to docs/manifests/wtft-pricing.json. */
export function renderPricingManifest(): string {
	return JSON.stringify(buildPricingManifest(), null, 2) + "\n";
}

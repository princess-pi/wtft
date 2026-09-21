/**
 * Renders MODEL_PRICING as a manifest.
 * The writer is `bun run manifest` (pricing-manifest.ts, at the repo root);
 * `bun run build` only CHECKS and fails naming that command.
 */

import {
	DEEPSEEK_V41_FLASH_FROM,
	DEEPSEEK_V4_PRO_REROUTE_FROM,
	MODEL_PRICING,
	DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES,
	DEEPSEEK_WEEKEND_OFFPEAK_FROM,
	type ModelPricing,
} from "./wtft-cost.js";

export const PRICING_MANIFEST_SCHEMA = "wtft-pricing/table@1";

export interface ManifestRates {
	condition: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ManifestModel {
	model: string;
	/** Standard row first, then any dated windows, then any size tiers. */
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

function formatWindow([start, end]: readonly [number, number]): string {
	const hhmm = (m: number) =>
		`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
	return `${hhmm(start)}–${hhmm(end)}`;
}

/**
 * An instant, not a day: these cutovers are exact moments (the rate card moved
 * at 16:00Z, not at midnight), and rounding one to a date would misprice the
 * hours on either side of it.
 */
function isoInstant(epochMs: number): string {
	// Truncate to the second rather than string-replacing ".000".
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
			// No backticks or markup: the page renders this through .textContent,
			// which would print them literally.
			note: "DeepSeek rows are the off-peak card; peak is 2x on the windows "
				+ "and weekdays given here. For DeepSeek only, the Input column is "
				+ "the cache-MISS rate and Cache Read the cache-HIT rate — the "
				+ "Anthropic-format endpoint reports no cache-creation tokens and "
				+ "bills a miss as plain input, so its cache writes genuinely cost "
				+ "nothing. For every model here, reasoning tokens bill at the "
				+ "output rate. Cache Write is the 5-minute-TTL rate; where it is "
				+ "above zero, a 1-hour-TTL write bills at 2x that row's input "
				+ "rate, and where it is zero both TTLs are free. Where a model "
				+ "shows dated rows, the EARLIEST one whose date has not yet "
				+ "passed applies instead of the standard row — so the standard "
				+ "row is not necessarily the price in force today, and with more "
				+ "than one dated row it is the first, not the last, that wins. "
				+ "A dated row is compared against the INTERACTION's instant, not "
				+ "against now, and a turn whose instant could not be read is "
				+ "priced at the standard row however old it is. For DeepSeek, "
				+ "the peak multiplier applies to Input, Output and Cache Read "
				+ "only — never to Cache Write. All four DeepSeek names carry the "
				+ "same standard row, because all four end up serving one model: "
				// Derived from the SAME constants the dated rows' conditions are
				// generated from, never re-typed.
				+ `V4.1 Flash retired the V4 Flash line at ${isoInstant(DEEPSEEK_V41_FLASH_FROM)} `
				+ `and takes over deepseek-v4-pro at ${isoInstant(DEEPSEEK_V4_PRO_REROUTE_FROM)}, with `
				+ "deepseek-flash as its own name. Only deepseek-v4-pro's dated "
				+ "row still differs from the other three.",
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

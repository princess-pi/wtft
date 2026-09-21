/** Pure cost calculation for model token pricing. */

// ---

export interface CostTier {
	/** Total input tokens (input + cacheRead + cacheWrite) must exceed this to apply. */
	inputTokensAbove: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * A dated rate window — applies when the interaction timestamp is strictly
 * before `effectiveBefore` (epoch ms). No timestamp, or no matching window,
 * falls back to the model's unconditioned rates. A missing or zero timestamp
 * is "unknown date" and returns the current card; this resolver never reads
 * the host clock.
 */
export interface DateTier {
	effectiveBefore: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelPricing {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: CostTier[];
	dateTiers?: DateTier[];
}

// ---

export const WEB_SEARCH_PRICE = 0.03;
export const WEB_FETCH_PRICE = 0.03;

/**
 * Per-request cost of server-side tool usage. Only Claude is billed today.
 *
 * "Is Claude" is a substring search for `claude` or `anthropic`, with any id
 * that also says `deepseek` excluded. Anchoring would miss mid-string forms
 * (`us.anthropic.claude-…`). A bare `opus`/`sonnet`/`haiku` alias is not
 * accepted: the same string is what a DeepSeek session records.
 */
export function calculateServerToolCost(
	model: string,
	webSearchRequests: number,
	webFetchRequests: number
): number {
	const m = (model || "").toLowerCase();
	if (m.includes("deepseek")) return 0;
	if (!m.includes("claude") && !m.includes("anthropic")) {
		return 0;
	}
	return (webSearchRequests * WEB_SEARCH_PRICE) + (webFetchRequests * WEB_FETCH_PRICE);
}

/**
 * The DeepSeek peak windows, as minutes since UTC midnight, half-open
 * `[start, end)` — 01:00–04:00 and 06:00–10:00 UTC.
 */
export const DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES: ReadonlyArray<readonly [number, number]> = [
	[60, 240],   // 01:00–04:00 UTC
	[360, 600],  // 06:00–10:00 UTC
];

/**
 * The instant weekends stopped being peak.
 *
 * Not retroactive: a weekend session before this really was billed at the
 * surge rate. Peak windows sit inside one Beijing daytime, so Mon–Fri UTC
 * is Mon–Fri Beijing here.
 */
export const DEEPSEEK_WEEKEND_OFFPEAK_FROM = Date.UTC(2026, 7, 23, 0, 0, 0);

/**
 * The instant the DeepSeek rate card changed. Interactions strictly before
 * this price at the old card, which the V4 names carry as their earliest
 * `dateTiers` window.
 */
export const DEEPSEEK_RATE_CARD_FROM = Date.UTC(2026, 7, 16, 16, 0, 0);

/**
 * The instant V4.1 Flash shipped. From here `deepseek-v4-flash` and
 * `deepseek-v4-flash-vision-exp` route to V4.1 Flash and bill at its card,
 * which is why both keep their old card as a `dateTiers` window.
 */
export const DEEPSEEK_V41_FLASH_FROM = Date.UTC(2026, 8, 10, 4, 0, 0);

/**
 * The instant `deepseek-v4-pro` starts routing to V4.1 Flash. Separate from
 * DEEPSEEK_V41_FLASH_FROM because the two dates are four days apart; a single
 * constant would misprice one line or the other.
 */
export const DEEPSEEK_V4_PRO_REROUTE_FROM = Date.UTC(2026, 8, 14, 4, 0, 0);

/**
 * The DeepSeek surge multiplier at `timestamp` — 2.0 inside a peak window on a
 * weekday, 1.0 otherwise.
 *
 * Reads the passed instant, never the host clock, except when the argument is
 * omitted (live callers). Zero means "unknown date" and surges at 1.0.
 */
export function getDeepSeekPeakMultiplier(timestamp?: number): number {
	if (timestamp === 0) return 1.0;
	const ts = timestamp === undefined ? Date.now() : timestamp;
	const d = new Date(ts);
	const utcTime = d.getUTCHours() * 60 + d.getUTCMinutes(); // minutes since UTC midnight

	// After DEEPSEEK_WEEKEND_OFFPEAK_FROM, Saturday and Sunday are off-peak.
	if (ts >= DEEPSEEK_WEEKEND_OFFPEAK_FROM) {
		const utcDay = d.getUTCDay(); // 0 = Sunday, 6 = Saturday
		if (utcDay === 0 || utcDay === 6) return 1.0;
	}

	for (const [start, end] of DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES) {
		if (utcTime >= start && utcTime < end) return 2.0;
	}
	return 1.0;
}

// ---

/**
 * Prices are per-1M tokens. Tiers apply when total input tokens
 * (input + cacheRead + cacheWrite) exceed inputTokensAbove.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
	// Claude — list rates per MTok. cacheWrite is the 5-min-TTL rate
	// (1.25x input); the 1h-TTL rate is derived as 2x input by the cw1h
	// handling in calculateClaudeCost. Fuzzy substring lookup resolves dated
	// IDs (claude-haiku-4-5-20251001) to their alias key. New top-tier names
	// (fable, mythos) MUST be here — they match no legacy fallback branch and
	// would otherwise silently price at Sonnet-tier defaults, ~3.3x under.
	"claude-fable-5":    { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 12.50 },
	"claude-mythos-5":   { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 12.50 },
	"claude-opus-5":     { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
	"claude-opus-4-8":   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
	"claude-opus-4-7":   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
	"claude-opus-4-6":   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
	"claude-opus-4-5":   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
	"claude-opus-4-1":   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
	"claude-sonnet-5":   {
		input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75,
		dateTiers: [
			{ effectiveBefore: 1788220800000 /* 2026-09-01T00:00:00Z */,
			  input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 },
		],
	},
	"claude-sonnet-4-6": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
	"claude-sonnet-4-5": { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
	"claude-haiku-4-5":  { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
	// DeepSeek — no size tiers; surge is getDeepSeekPeakMultiplier's job.
	//
	// Base rates are OFF-PEAK, which is the card DeepSeek publishes as "half of
	// the peak rates". `input` is the CACHE-MISS rate and `cacheRead` the
	// CACHE-HIT rate, because DeepSeek's Anthropic-format endpoint reports
	// cache_creation_input_tokens: 0 on every turn and bills a miss as plain
	// input_tokens. `cacheWrite: 0` is therefore
	// correct and must stay.
	//
	// The dateTiers windows carry every superseded card so historical sessions
	// still report what they actually cost.
	//
	// Order matters below: -vision-exp must precede -flash, because the fuzzy
	// lookup would otherwise match the shorter key inside the longer model id.
	// lookupModelPricing sorts longest-first so this is belt and braces, but a
	// reader reordering these should know the constraint exists.
	"deepseek-v4-flash-vision-exp": {
		input: 0.15, output: 0.60, cacheRead: 0.003, cacheWrite: 0,
		// The standard row is the V4.1 FLASH card, not this model's own: from
		// 2026-09-10T04:00Z the name routes to V4.1 Flash. Its real card
		// is the 0.22 window below.
		dateTiers: [
			{ effectiveBefore: DEEPSEEK_RATE_CARD_FROM /* 2026-08-16T16:00:00Z */,
			  input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
			{ effectiveBefore: DEEPSEEK_V41_FLASH_FROM /* 2026-09-10T04:00:00Z */,
			  input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
		],
	},
	"deepseek-v4-flash": {
		// Standard row is the V4.1 Flash card — the name routes there from
		// 2026-09-10T04:00Z.
		input: 0.15, output: 0.60, cacheRead: 0.003, cacheWrite: 0,
		dateTiers: [
			{ effectiveBefore: DEEPSEEK_RATE_CARD_FROM /* 2026-08-16T16:00:00Z */,
			  input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
			{ effectiveBefore: DEEPSEEK_V41_FLASH_FROM /* 2026-09-10T04:00:00Z */,
			  input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
		],
	},
	"deepseek-v4-pro": {
		// Standard row is the V4.1 Flash card — the name routes there from
		// 2026-09-14T04:00Z, four days after the Flash line, and there is no
		// opt-out and no V4.1 Pro to route to instead.
		input: 0.15, output: 0.60, cacheRead: 0.003, cacheWrite: 0,
		dateTiers: [
			{ effectiveBefore: DEEPSEEK_RATE_CARD_FROM /* 2026-08-16T16:00:00Z */,
			  input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
			{ effectiveBefore: DEEPSEEK_V4_PRO_REROUTE_FROM /* 2026-09-14T04:00:00Z */,
			  input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
		],
	},
	"deepseek-flash": {
		input: 0.15, output: 0.60, cacheRead: 0.003, cacheWrite: 0,
	},
	// GPT-5.x — tiered pricing (short-context ≤272K, long-context >272K total input)
	"gpt-5.4": {
		input: 2.50, output: 15.00, cacheRead: 0.25, cacheWrite: 0,
		tiers: [{ inputTokensAbove: 272000, input: 5.00, output: 22.50, cacheRead: 0.50, cacheWrite: 0 }],
	},
	"gpt-5.5": {
		input: 5.00, output: 30.00, cacheRead: 0.50, cacheWrite: 0,
		tiers: [{ inputTokensAbove: 272000, input: 10.00, output: 45.00, cacheRead: 1.00, cacheWrite: 0 }],
	},
	"gpt-5.6-sol": {
		input: 5.00, output: 30.00, cacheRead: 0.50, cacheWrite: 6.25,
		tiers: [{ inputTokensAbove: 272000, input: 10.00, output: 45.00, cacheRead: 1.00, cacheWrite: 12.50 }],
	},
	"gpt-5.6-terra": {
		input: 2.50, output: 15.00, cacheRead: 0.25, cacheWrite: 3.13,
		tiers: [{ inputTokensAbove: 272000, input: 5.00, output: 22.50, cacheRead: 0.50, cacheWrite: 6.25 }],
	},
	"gpt-5.6-luna": {
		input: 1.25, output: 7.50, cacheRead: 0.125, cacheWrite: 1.56,
		tiers: [{ inputTokensAbove: 272000, input: 2.50, output: 11.25, cacheRead: 0.25, cacheWrite: 3.13 }],
	},
};

/**
 * Resolve the active tier for a usage snapshot.
 * When total input (input + cacheRead + cacheWrite) exceeds a tier's
 * inputTokensAbove, that tier's rates replace the base rates for the
 * entire request. When multiple tiers match, the highest threshold wins.
 * Returns the base pricing if no tier matches.
 *
 * A dated window is resolved FIRST, before size tiering: when
 * `timestamp` is supplied and falls before one of `pricing.dateTiers`'
 * `effectiveBefore` cutoffs (earliest matching cutoff wins), that window's
 * quad becomes the base that size tiers apply on top of. No timestamp, or no
 * matching window, leaves `pricing`'s own four fields as the base — this
 * function never reads the host clock.
 */
export function resolveTieredRates(
	pricing: ModelPricing,
	usage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
	timestamp?: number,
): { input: number; output: number; cacheRead: number; cacheWrite: number } {
	const totalInput =
		(usage.input_tokens || 0) +
		(usage.cache_read_input_tokens || 0) +
		(usage.cache_creation_input_tokens || 0);

	let base = {
		input: pricing.input,
		output: pricing.output,
		cacheRead: pricing.cacheRead,
		cacheWrite: pricing.cacheWrite,
	};

	if (pricing.dateTiers && timestamp) {
		const sortedByEarliestCutoff = [...pricing.dateTiers].sort(
			(a, b) => a.effectiveBefore - b.effectiveBefore
		);
		for (const dateTier of sortedByEarliestCutoff) {
			if (timestamp < dateTier.effectiveBefore) {
				base = {
					input: dateTier.input,
					output: dateTier.output,
					cacheRead: dateTier.cacheRead,
					cacheWrite: dateTier.cacheWrite,
				};
				break;
			}
		}
	}

	let rates = { ...base };

	if (pricing.tiers) {
		// Sort descending — highest threshold first so first match wins
		const sorted = [...pricing.tiers].sort((a, b) => b.inputTokensAbove - a.inputTokensAbove);
		for (const tier of sorted) {
			if (totalInput > tier.inputTokensAbove) {
				rates = {
					input: tier.input,
					output: tier.output,
					cacheRead: tier.cacheRead,
					cacheWrite: tier.cacheWrite,
				};
				break;
			}
		}
	}

	return rates;
}

/**
 * Merge user-supplied pricing entries over the built-in registry.
 * Entries with the same key replace built-ins; new keys extend the registry.
 * Pure merge — reading the pricing file from disk lives in
 * wtft-pricing-config.ts so this module stays fs-free.
 */
export function applyUserPricing(overrides: Record<string, ModelPricing>): void {
	for (const [key, pricing] of Object.entries(overrides)) {
		if (!pricing || typeof pricing !== "object") continue;
		const { input, output, cacheRead, cacheWrite } = pricing;
		// Why validate: a malformed JSON entry must not poison cost math with NaN.
		if ([input, output, cacheRead, cacheWrite].some(v => typeof v !== "number" || !isFinite(v))) continue;
		MODEL_PRICING[key.toLowerCase().trim()] = pricing;
	}
}

/**
 * Whether a model resolves to REAL pricing — a (user-merged) registry
 * entry, or one of the legacy hardcoded rate branches in calculateClaudeCost.
 * False means the cost for this model is a fallback figure, and the caller
 * marks it: the renderer appends "?" to the cost cell and the CLI prints one
 * stderr warning per distinct model.
 *
 * The `deepseek` test comes FIRST and returns false, mirroring the branch order
 * in calculateClaudeCost. An id containing both — say
 * `deepseek-opus` — takes the sibling-guess branch there, because that branch is
 * tested first; checking `opus` first here would call it priced while it is
 * charged from the flash card rather than the $5.00 the `opus` branch would
 * charge.
 * The two functions must agree on which branch a model reaches, so they
 * ask in the same order.
 *
 * See describeFallbackPricing for what the caller should say about each class.
 */
export function isModelPriced(model: string): boolean {
	if (!model) return false;
	if (lookupModelPricing(model)) return true;
	const m = model.toLowerCase();
	if (m.includes("deepseek")) return false;
	return m.includes("haiku") || m.includes("opus");
}

/**
 * The registry key calculateClaudeCost borrows when a DeepSeek id matches
 * nothing — the "Guess" branch, named once so the warning text and the branch
 * cannot disagree. Both call this; neither re-types the condition.
 *
 * KNOWN GAP: both keys it can return
 * are names DeepSeek RETIRED, so the warning tells a user it is guessing with
 * "the deepseek-v4-flash rate card" for a model that no longer exists.
 */
export function deepSeekSiblingKey(model: string): "deepseek-v4-pro" | "deepseek-v4-flash" {
	return (model || "").toLowerCase().includes("v4-pro") ? "deepseek-v4-pro" : "deepseek-v4-flash";
}

/**
 * What calculateClaudeCost will actually charge a model isModelPriced rejects.
 */
export function describeFallbackPricing(model: string): string {
	const m = (model || "").toLowerCase();
	if (m.includes("deepseek")) {
		return `guessing with the ${deepSeekSiblingKey(m)} rate card (surge multiplier applied)`;
	}
	return "using default $3/$15 rates";
}

/**
 * Look up pricing for a model by matching its ID against the known registry.
 *
 * Two rules, in order: an EXACT (lower-cased, trimmed) key wins outright;
 * otherwise the LONGEST registry key that is a substring of the ID wins.
 * Longest-first is load-bearing, not a tidiness preference — `deepseek-v4-flash`
 * is a substring of `deepseek-v4-flash-vision-exp`, so insertion order would
 * otherwise decide which card the longer model is priced with.
 *
 * Returns null if nothing matches; the caller falls back to defaults.
 */
export function lookupModelPricing(model: string): ModelPricing | null {
	if (!model) return null;
	const m = model.toLowerCase().trim();
	if (MODEL_PRICING[m]) return MODEL_PRICING[m];
	// Fuzzy: the model ID contains a registry key (a provider prefix, a date
	// suffix). LONGEST KEY WINS.
	const keysLongestFirst = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length);
	for (const key of keysLongestFirst) {
		if (m.includes(key)) return MODEL_PRICING[key];
	}
	return null;
}

export function calculateClaudeCost(model: string, usage: any, timestamp?: number): number {
	if (!usage) return 0;
	
	// Default to Claude Sonnet 4.6 pricing ($3/$15 per 1M tokens)
	// Cache write: 1.25x input (5-min TTL), 2.00x input (1-hour TTL)
	// Cache read: 0.10x input (Anthropic standard)
	let inputPrice = 3.00;
	let outputPrice = 15.00;
	let cacheReadPrice = 0.30;
	let cacheWritePrice = 3.75; // 1.25x input for 5-min TTL
	
	const m = (model || "").toLowerCase();

	// Check registry first — handles DeepSeek (surge-adjusted), GPT-5.x (tiered)
	const registryPricing = lookupModelPricing(model);
	if (registryPricing) {
		const rates = resolveTieredRates(registryPricing, usage, timestamp);
		if (m.includes("deepseek")) {
			const peak = getDeepSeekPeakMultiplier(timestamp);
			rates.input *= peak;
			rates.output *= peak;
			rates.cacheRead *= peak;
		}
		inputPrice = rates.input;
		outputPrice = rates.output;
		cacheReadPrice = rates.cacheRead;
		cacheWritePrice = rates.cacheWrite; // already the per-1M 5-min TTL rate
	} else if (m.includes("deepseek")) {
		// A DeepSeek id no registry key matched — a model newer than this
		// registry. Guess with the closest sibling's entry, read FROM the
		// registry.
		const sibling = MODEL_PRICING[deepSeekSiblingKey(m)];
		const rates = resolveTieredRates(sibling, usage, timestamp);
		const peak = getDeepSeekPeakMultiplier(timestamp);
		inputPrice = rates.input * peak;
		outputPrice = rates.output * peak;
		cacheReadPrice = rates.cacheRead * peak;
		cacheWritePrice = 0;
	} else if (m.includes("haiku")) {
		inputPrice = 1.00;
		outputPrice = 5.00;
		cacheReadPrice = 0.10;
		cacheWritePrice = 1.25;
	} else if (m.includes("opus")) {
		inputPrice = 5.00;
		outputPrice = 25.00;
		cacheReadPrice = 0.50;
		cacheWritePrice = 6.25;
	}
	
	let cacheWriteCost = 0;
	const cc = usage.cache_creation || {};
	const cw5m = cc.ephemeral_5m_input_tokens ?? 0;
	const cw1h = cc.ephemeral_1h_input_tokens ?? 0;
	const cwFlat = Math.max(0, (usage.cache_creation_input_tokens || 0) - cw5m - cw1h);
	
	// Registry models: use cacheWrite rate from pricing config (0 for models
	// that don't charge for cache writes, e.g. GPT-5.x via OpenAI Responses).
	// Non-registry models: use the legacy 1.25x/2.00x input-price heuristic.
	if (registryPricing) {
		// 1h-TTL writes bill at 2x BASE INPUT (API rule), not 2x the 5m rate —
		// doubling cacheWritePrice (1.25x input) overbilled 1h writes by 25%.
		// Free-cache-write models stay free.
		const cw1hPrice = cacheWritePrice === 0 ? 0 : inputPrice * 2.00;
		cacheWriteCost =
			cw5m * (cacheWritePrice / 1000000) +
			cw1h * (cw1hPrice / 1000000) +
			cwFlat * (cacheWritePrice / 1000000);
	} else if (m.includes("deepseek")) {
		cacheWriteCost = 0;
	} else {
		cacheWriteCost =
			cw5m * (inputPrice * 1.25 / 1000000) +
			cw1h * (inputPrice * 2.00 / 1000000) +
			cwFlat * (inputPrice * 1.25 / 1000000);
	}
	
	const cost = 
		((usage.input_tokens || 0) * (inputPrice / 1000000)) +
		((usage.output_tokens || 0) * (outputPrice / 1000000)) +
		((usage.reasoning_tokens || usage.reasoning || 0) * (outputPrice / 1000000)) +
		cacheWriteCost +
		((usage.cache_read_input_tokens || 0) * (cacheReadPrice / 1000000));
		
	return cost;
}

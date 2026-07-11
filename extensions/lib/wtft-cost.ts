/**
 * @package princess-pi-packages
 * @module wtft-cost
 * @description Pure cost calculation for model token pricing.
 *   Supports Claude (Haiku/Sonnet/Opus) and DeepSeek (v4-flash/v4-pro)
 *   with DeepSeek peak-valley surge pricing, TTL-split cache-write costs,
 *   and input-based pricing tiers (GPT-5.x long-context rates).
 *
 *   Pi's built-in usage.cost.total is authoritative when available — this
 *   module is the fallback for models where Pi doesn't track cost (DeepSeek,
 *   some custom providers). For Claude/GPT/Codex, Pi's cost already includes
 *   tier resolution; the tier logic here is defense-in-depth.
 */

// ---
// TYPES
// ---

/** Per-1M-token rates for a single pricing tier. */
export interface CostTier {
	/** Total input tokens (input + cacheRead + cacheWrite) must exceed this to apply. */
	inputTokensAbove: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Complete pricing config for a model (base rates + optional tier overrides). */
export interface ModelPricing {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: CostTier[];
}

// ---
// PER-REQUEST TOOL PRICING (separate meter from token pricing)
// ---

/** Per-request fee for web_search tool (Claude models). */
export const WEB_SEARCH_PRICE = 0.03;  // $0.03 per search request
/** Per-request fee for web_fetch tool (Claude models). */
export const WEB_FETCH_PRICE = 0.03;   // $0.03 per fetch request

/**
 * Calculate the per-request cost of server-side tool usage for a given model.
 * Only Claude models are billed per-request for web search/fetch today.
 * DeepSeek, Gemini, and local models do not charge for server_tool_use.
 */
export function calculateServerToolCost(
	model: string,
	webSearchRequests: number,
	webFetchRequests: number
): number {
	const m = (model || "").toLowerCase();
	// Only Claude charges per-request for server tools.
	// Other providers (DeepSeek, Gemini, local) don't — return 0.
	if (!m.includes("claude") && !/\b(haiku|sonnet|opus)\b/.test(m)) {
		return 0;
	}
	return (webSearchRequests * WEB_SEARCH_PRICE) + (webFetchRequests * WEB_FETCH_PRICE);
}

export function getDeepSeekPeakMultiplier(timestamp?: number): number {
	const ts = timestamp || Date.now();
	const d = new Date(ts);
	const utcHour = d.getUTCHours();
	const utcMin = d.getUTCMinutes();
	const utcTime = utcHour * 60 + utcMin; // minutes since UTC midnight

	// Peak window 1: 01:00–04:00 UTC → minutes 60–240
	// Peak window 2: 06:00–10:00 UTC → minutes 360–600
	if ((utcTime >= 60 && utcTime < 240) || (utcTime >= 360 && utcTime < 600)) {
		return 2.0;
	}
	return 1.0;
}

// ---
// MODEL PRICING REGISTRY
// ---

/**
 * Known model pricing (including tier thresholds) for models where our
 * fallback cost calculator is used. Pi's built-in cost tracking handles
 * Claude/GPT/Codex — this registry covers DeepSeek and popular models
 * where the fallback matters.
 *
 * Prices are per-1M tokens. Tiers apply when total input tokens
 * (input + cacheRead + cacheWrite) exceed inputTokensAbove.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
	// DeepSeek — no tiers, surge pricing handled by getDeepSeekPeakMultiplier
	"deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
	"deepseek-v4-pro":   { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
	// GPT-5.x — tiered pricing (short-context ≤272K, long-context >272K total input)
	// Source: pi-ai openai.models.js (v0.80.6)
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
 */
export function resolveTieredRates(
	pricing: ModelPricing,
	usage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
): { input: number; output: number; cacheRead: number; cacheWrite: number } {
	const totalInput =
		(usage.input_tokens || 0) +
		(usage.cache_read_input_tokens || 0) +
		(usage.cache_creation_input_tokens || 0);

	let rates = {
		input: pricing.input,
		output: pricing.output,
		cacheRead: pricing.cacheRead,
		cacheWrite: pricing.cacheWrite,
	};

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
 * Look up pricing for a model by fuzzy-matching its ID against the known
 * registry. Returns null if no match found (caller falls back to defaults).
 */
export function lookupModelPricing(model: string): ModelPricing | null {
	if (!model) return null;
	const m = model.toLowerCase().trim();
	// Exact match first
	if (MODEL_PRICING[m]) return MODEL_PRICING[m];
	// Fuzzy: check if any registry key is a substring of the model ID
	for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
		if (m.includes(key)) return pricing;
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
		const rates = resolveTieredRates(registryPricing, usage);
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
		// Legacy path — DeepSeek not in registry (shouldn't happen, kept for safety)
		const peak = getDeepSeekPeakMultiplier(timestamp);
		if (m.includes("v4-pro")) {
			inputPrice = 1.74 * peak;
			outputPrice = 3.48 * peak;
			cacheReadPrice = 0.0145 * peak;
		} else {
			inputPrice = 0.14 * peak;
			outputPrice = 0.28 * peak;
			cacheReadPrice = 0.0028 * peak;
		}
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
		cacheWriteCost =
			cw5m * (cacheWritePrice / 1000000) +
			cw1h * (cacheWritePrice * 2.00 / 1000000) +
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

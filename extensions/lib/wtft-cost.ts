/**
 * @package princess-pi-packages
 * @module wtft-cost
 * @description Pure cost calculation for model token pricing.
 *   Supports Claude (Haiku/Sonnet/Opus) and DeepSeek (v4-flash/v4-pro)
 *   with DeepSeek peak-valley surge pricing and TTL-split cache-write costs.
 */

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

export function calculateClaudeCost(model: string, usage: any, timestamp?: number): number {
	if (!usage) return 0;
	
	// Default to Claude Sonnet 4.6 pricing ($3/$15 per 1M tokens)
	// Cache write: 1.25x input (5-min TTL), 2.00x input (1-hour TTL)
	// Cache read: 0.10x input (Anthropic standard)
	let inputPrice = 3.00;
	let outputPrice = 15.00;
	let cacheReadPrice = 0.30;
	
	const m = (model || "").toLowerCase();
	if (m.includes("deepseek")) {
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
	} else if (m.includes("haiku")) {
		inputPrice = 1.00;
		outputPrice = 5.00;
		cacheReadPrice = 0.10;
	} else if (m.includes("opus")) {
		inputPrice = 5.00;
		outputPrice = 25.00;
		cacheReadPrice = 0.50;
	}
	
	let cacheWriteCost = 0;
	const cc = usage.cache_creation || {};
	const cw5m = cc.ephemeral_5m_input_tokens ?? 0;
	const cw1h = cc.ephemeral_1h_input_tokens ?? 0;
	const cwFlat = Math.max(0, (usage.cache_creation_input_tokens || 0) - cw5m - cw1h);
	
	if (m.includes("deepseek")) {
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

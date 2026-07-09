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
		// DeepSeek models — input/output/reasoning pricing. Cache-read pricing
		// uses DeepSeek's cache-hit discount rate (confirmed via Pi usage schema).
		const peak = getDeepSeekPeakMultiplier(timestamp);
		if (m.includes("v4-pro")) {
			// deepseek-v4-pro: $1.74/M input, $3.48/M output, cache-hit $0.0145/M.
			// Reasoning tokens priced at output rate.
			inputPrice = 1.74 * peak;
			outputPrice = 3.48 * peak;
			cacheReadPrice = 0.0145 * peak;
		} else {
			// deepseek-v4-flash + legacy deepseek-chat & deepseek-reasoner:
			// $0.14/M input, $0.28/M output, cache-hit $0.0028/M.
			// (legacy names deprecate 2026-07-24)
			inputPrice = 0.14 * peak;
			outputPrice = 0.28 * peak;
			cacheReadPrice = 0.0028 * peak;
		}
		// DeepSeek does not expose separate cache-write tokens → 0, no TTL split needed
	} else if (m.includes("haiku")) {
		// Claude Haiku 4.5: $1/M input, $5/M output
		inputPrice = 1.00;
		outputPrice = 5.00;
		cacheReadPrice = 0.10;
	} else if (m.includes("opus")) {
		// Claude Opus 4.6/4.7: $5/M input, $25/M output
		inputPrice = 5.00;
		outputPrice = 25.00;
		cacheReadPrice = 0.50;
	}
	
	// Cache-write pricing: split by TTL when the breakdown object is present (#55).
	// 5-minute TTL caches = 1.25× input; 1-hour TTL caches = 2.00× input.
	// Falls back to flat 1.25× when only the scalar cache_creation_input_tokens is available.
	let cacheWriteCost = 0;
	const cc = usage.cache_creation || {};
	const cw5m = cc.ephemeral_5m_input_tokens ?? 0;
	const cw1h = cc.ephemeral_1h_input_tokens ?? 0;
	const cwFlat = Math.max(0, (usage.cache_creation_input_tokens || 0) - cw5m - cw1h);
	
	if (m.includes("deepseek")) {
		// DeepSeek: no cache-write pricing (all zero)
		cacheWriteCost = 0;
	} else {
		cacheWriteCost =
			cw5m * (inputPrice * 1.25 / 1000000) +
			cw1h * (inputPrice * 2.00 / 1000000) +
			cwFlat * (inputPrice * 1.25 / 1000000); // unknown TTL → default 5-min (1.25×)
	}
	
	const cost = 
		((usage.input_tokens || 0) * (inputPrice / 1000000)) +
		((usage.output_tokens || 0) * (outputPrice / 1000000)) +
		((usage.reasoning_tokens || usage.reasoning || 0) * (outputPrice / 1000000)) +
		cacheWriteCost +
		((usage.cache_read_input_tokens || 0) * (cacheReadPrice / 1000000));
		
	return cost;
}

/**
 * @package princess-pi-tools
 * @module wtft-cost
 * @description Pure cost calculation for model token pricing.
 *   The registry covers the Claude 4 and 5 families (including fable and
 *   mythos), DeepSeek (v4-pro, v4-flash, v4-flash-vision-exp) and GPT-5.x.
 *   A rate resolves through three mechanisms, in this order: a DATED window
 *   (`dateTiers`, #148/#495 — an intro rate or a superseded card), then an
 *   input-SIZE tier (`tiers`, GPT-5.x long-context), then the entry's own
 *   unconditioned quad. On top of that, DeepSeek rates carry a peak-valley
 *   surge multiplier that is time-of-day AND weekday dependent, and cache
 *   writes are TTL-split.
 *
 *   A second, separate meter runs alongside tokens: web_search and web_fetch
 *   are billed per REQUEST, not per token (see WEB_SEARCH_PRICE below).
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

/**
 * A dated rate window (#148) — applies when the interaction timestamp is
 * strictly before `effectiveBefore` (epoch ms). Generalizes the DeepSeek
 * peak-multiplier idea (getDeepSeekPeakMultiplier, below) into a registry
 * field any model can carry, for launches that ship introductory pricing
 * ahead of a standard rate (Sonnet 5's $2/$10 intro through 2026-08-31 is
 * the first user). No timestamp, or no matching window, falls back to the
 * model's unconditioned rates.
 *
 * Scope of the no-host-clock guarantee (#96, sharpened #495): it covers THIS
 * resolver, which treats a missing or zero timestamp as "unknown date" and
 * returns the current card. `getDeepSeekPeakMultiplier` makes the same promise
 * separately — see its own docstring. Both are needed, because a cost is a
 * dated rate AND a surge multiplier, and either reading the clock makes the
 * same historical turn price differently on a second run.
 */
export interface DateTier {
	effectiveBefore: number;
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
	dateTiers?: DateTier[];
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
 *
 * The test for "is this Claude" is a VENDOR MARKER in the id — `claude` or
 * `anthropic` — and nothing else (#22 A). It used to also accept a bare alias,
 * `/\b(haiku|sonnet|opus)\b/`, to catch a Claude id written without the
 * `claude-` prefix. That arm billed DeepSeek: `claude-deepseek` exports
 * ANTHROPIC_MODEL="opus", so a DeepSeek turn recorded as plain `opus` was
 * charged $0.03 per web_search request against a provider this docstring says
 * does not charge. The two cases are byte-identical at this seam — a bare
 * `opus` from Claude Code and a bare `opus` from a DeepSeek session are the
 * same string — so the arm cannot be narrowed, only dropped.
 *
 * What that costs: a genuine Anthropic turn recorded with a bare alias AND a
 * server_tool_use block now undercounts by $0.03/request. No such turn exists
 * in this host's corpus; Claude Code stamps the full dated id on every message,
 * and every real Anthropic id form carries one of the two markers (dated API
 * ids, Vertex `claude-…`, Bedrock `us.anthropic.claude-…`).
 */
export function calculateServerToolCost(
	model: string,
	webSearchRequests: number,
	webFetchRequests: number
): number {
	const m = (model || "").toLowerCase();
	// Only Claude charges per-request for server tools.
	// Other providers (DeepSeek, Gemini, local) don't — return 0.
	if (!m.includes("claude") && !m.includes("anthropic")) {
		return 0;
	}
	return (webSearchRequests * WEB_SEARCH_PRICE) + (webFetchRequests * WEB_FETCH_PRICE);
}

/**
 * The DeepSeek peak windows, as minutes since UTC midnight, half-open
 * `[start, end)` — 01:00–04:00 and 06:00–10:00 UTC.
 *
 * This is the ONE definition (#495). The windows were hardcoded in four
 * places — here, and three more in wtft-renderer.ts — plus four prose copies,
 * with nothing that failed when a schedule change missed one. Everything that
 * needs the schedule imports this; nothing re-types the numbers.
 */
export const DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES: ReadonlyArray<readonly [number, number]> = [
	[60, 240],   // 01:00–04:00 UTC
	[360, 600],  // 06:00–10:00 UTC
];

/**
 * The instant weekends stopped being peak (2026-08-23T00:00:00Z).
 *
 * Not retroactive: a weekend session before this really was billed at the
 * surge rate, so historical sessions must keep reporting what they cost.
 *
 * EVIDENCE, and it is weaker than DEEPSEEK_RATE_CARD_FROM's — say so rather than
 * let the two dates borrow each other's confidence (PR #507 review). The scrape
 * at research/495-deepseek-pricing/pricing-page-2026-08-25.md confirms the rule
 * IS Monday-Friday as of 2026-08-25; it does not say when that started. The date
 * here comes from a secondary report (#495's Sources), not from the vendor's own
 * changelog. If the true cutover differs, weekend interactions between the two
 * dates are mispriced in one direction or the other, and no test here can catch
 * it — the tests verify the code agrees with this constant, not that the
 * constant matches DeepSeek's billing. Re-scrape before trusting it for a
 * historical audit that straddles this week.
 *
 * No Beijing-vs-UTC ambiguity, despite sources disagreeing on which calendar
 * the "weekday" belongs to: the windows are 09:00–12:00 and 14:00–18:00
 * Beijing, which sit entirely inside one Beijing daytime, so a peak window's
 * UTC date and Beijing date are always the same date. Mon–Fri UTC ≡ Mon–Fri
 * Beijing here, so resolving it in UTC is exact, not an approximation.
 */
export const DEEPSEEK_WEEKEND_OFFPEAK_FROM = Date.UTC(2026, 7, 23, 0, 0, 0);

/**
 * The instant the DeepSeek rate card changed (2026-08-16T16:00:00Z).
 *
 * Interactions strictly before this price at the old card, which `deepseek-v4-pro`
 * and `deepseek-v4-flash` carry as a `dateTiers` window. `deepseek-v4-flash-vision-exp`
 * deliberately carries none — see its registry entry for the reason and for how
 * well evidenced it is.
 *
 * v4-pro got much cheaper and v4-flash dearer, so the two errors partly cancel in a
 * TOTAL — which is exactly why nine days of wrong prices looked fine on screen (#495).
 */
export const DEEPSEEK_RATE_CARD_FROM = Date.UTC(2026, 7, 16, 16, 0, 0);

/**
 * The DeepSeek surge multiplier at `timestamp` — 2.0 inside a peak window on a
 * weekday, 1.0 otherwise.
 *
 * Resolution reads the PASSED instant and never the host clock (#96, #495).
 * The distinction that matters is omitted-vs-zero: `wtft-parser` stamps an
 * unparsed turn with `timestamp: 0`, and `0 || Date.now()` used to hand that
 * turn the current wall clock — so the same historical turn priced differently
 * on every run, and a re-run near a window edge flipped it. A zero timestamp
 * means "when this happened is unknown", and an unknown instant surges at 1.0,
 * matching how `resolveTieredRates` treats the same 0 (current card, no dated
 * window). Only an OMITTED argument reads the clock, for live callers.
 */
export function getDeepSeekPeakMultiplier(timestamp?: number): number {
	if (timestamp === 0) return 1.0;
	const ts = timestamp === undefined ? Date.now() : timestamp;
	const d = new Date(ts);
	const utcTime = d.getUTCHours() * 60 + d.getUTCMinutes(); // minutes since UTC midnight

	// Since 2026-08-23 the peak schedule is Monday–Friday; Saturday and Sunday
	// are off-peak all day, whatever the hour.
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
	// Claude (#139) — list rates per MTok. cacheWrite is the 5-min-TTL rate
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
	// claude-sonnet-5 base rates are the standard (post-intro) quad — the
	// permanent long-run rate. The dateTiers window is the exception: intro
	// pricing $2/$10/$0.20/$2.50 applies for interactions strictly before
	// 2026-09-01T00:00:00Z (epoch 1788220800000); $3/$15 from that instant on
	// (#148). 1h-TTL cache writes derive as 2x whichever input rate resolves
	// (calculateClaudeCost's cw1hPrice, below) — no separate dated field needed.
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
	// DeepSeek (#495) — no size tiers; surge is getDeepSeekPeakMultiplier's job.
	//
	// Base rates are OFF-PEAK, which is the card DeepSeek publishes as "half of
	// the peak rates". `input` is the CACHE-MISS rate and `cacheRead` the
	// CACHE-HIT rate, because DeepSeek's Anthropic-format endpoint reports
	// cache_creation_input_tokens: 0 on every turn and bills a miss as plain
	// input_tokens — measured across 854 turns. `cacheWrite: 0` is therefore
	// correct and must stay.
	//
	// The dateTiers window carries the pre-2026-08-16T16:00Z card so historical
	// sessions still report what they actually cost. Rates verified against
	// research/495-deepseek-pricing/pricing-page-2026-08-25.md.
	//
	// Order matters below: -vision-exp must precede -flash, because the fuzzy
	// lookup would otherwise match the shorter key inside the longer model id.
	// lookupModelPricing sorts longest-first so this is belt and braces, but a
	// reader reordering these should know the constraint exists.
	"deepseek-v4-flash-vision-exp": {
		input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0,
		// No dateTiers: the model was released after the 2026-08-16 rate change,
		// so no interaction of it can predate the current card, and an old-card
		// window here would be a fiction nothing could ever hit.
		//
		// How well evidenced (PR #507 review): the release date 2026-08-21 comes
		// from #495's Sources, NOT from the committed scrape — that page lists
		// this model with no date suffix, while flash carries -0731 and pro
		// -0813. What IS measured: every vision-exp turn in this host's corpus is
		// dated 2026-08-24, comfortably after the cutover. So the omission is
		// right for all observed data. The exposure, if the model actually
		// shipped before 2026-08-16T16:00Z, is that such a turn prices at the
		// current card rather than the old one — and no test here would catch
		// it, because the tests check the code against this constant, not the
		// constant against DeepSeek.
	},
	"deepseek-v4-flash": {
		input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0,
		dateTiers: [
			{ effectiveBefore: DEEPSEEK_RATE_CARD_FROM /* 2026-08-16T16:00:00Z */,
			  input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
		],
	},
	"deepseek-v4-pro": {
		input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0,
		dateTiers: [
			{ effectiveBefore: DEEPSEEK_RATE_CARD_FROM /* 2026-08-16T16:00:00Z */,
			  input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
		],
	},
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
 *
 * A dated window (#148) is resolved FIRST, before size tiering: when
 * `timestamp` is supplied and falls before one of `pricing.dateTiers`'
 * `effectiveBefore` cutoffs (earliest matching cutoff wins), that window's
 * quad becomes the base that size tiers apply on top of. No timestamp, or no
 * matching window, leaves `pricing`'s own four fields as the base — this
 * function never reads the host clock (#96).
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
 * Merge user-supplied pricing entries over the built-in registry (#140).
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
 * Whether a model resolves to real pricing (#140) — via the (user-merged)
 * registry or one of the legacy substring fallback branches in
 * calculateClaudeCost. False means calculateClaudeCost silently used the
 * hardcoded Sonnet-tier defaults and totals for this model are a guess.
 */
export function isModelPriced(model: string): boolean {
	if (!model) return false;
	if (lookupModelPricing(model)) return true;
	const m = model.toLowerCase();
	return m.includes("deepseek") || m.includes("haiku") || m.includes("opus");
}

/**
 * Look up pricing for a model by matching its ID against the known registry.
 *
 * Two rules, in order: an EXACT (lower-cased, trimmed) key wins outright;
 * otherwise the LONGEST registry key that is a substring of the ID wins.
 * Longest-first is load-bearing, not a tidiness preference — `deepseek-v4-flash`
 * is a substring of `deepseek-v4-flash-vision-exp`, so insertion order would
 * otherwise decide which card the longer model is priced with (#495).
 *
 * Returns null if nothing matches; the caller falls back to defaults.
 */
export function lookupModelPricing(model: string): ModelPricing | null {
	if (!model) return null;
	const m = model.toLowerCase().trim();
	// Exact match first
	if (MODEL_PRICING[m]) return MODEL_PRICING[m];
	// Fuzzy: the model ID contains a registry key (a provider prefix, a date
	// suffix). LONGEST KEY WINS (#495) — some keys are substrings of others
	// ("deepseek-v4-flash" inside "deepseek-v4-flash-vision-exp"), and matching
	// in registry-insertion order silently priced the longer model with the
	// shorter one's card. That was harmless only while their rates happened to
	// be equal; the day they diverge, insertion order is not a pricing decision
	// anyone made.
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
		// registry (#495): this branch used to hold a second hardcoded copy of
		// the rate card, and it was still serving the pre-2026-08-16 numbers
		// long after the registry moved on, because nothing linked the two.
		const sibling = MODEL_PRICING[m.includes("v4-pro") ? "deepseek-v4-pro" : "deepseek-v4-flash"];
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
		// doubling cacheWritePrice (1.25x input) overbilled 1h writes by 25%
		// (#146; Claude Code caches on the 1h tier, so every CC session read
		// high). Free-cache-write models stay free.
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

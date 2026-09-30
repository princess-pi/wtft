import { buildWtftLines, chartLimit, wholeLimit } from "./wtft-renderer.js";
import type { Interaction } from "./wtft-shared.js";

export type ChartUnit = "cost" | "tokens";
type ChartMode = "cumulative" | "bucket";

/** What the user asked for this run. A key left out was not asked. */
export interface ChartAsked {
	interval?: string;
	limit?: number;
	mode?: ChartMode;
	timezone?: string;
	width?: number;
	enableEmoji?: boolean;
	showCostColumns?: boolean;
	showTokenColumns?: boolean;
}

/** What stands in for anything not asked. `width` is the most the chart may be, before the 1023 cap. */
export interface ChartFallback {
	width: number;
	interval?: string;
	limit?: number;
	mode?: ChartMode;
	timezone?: string;
	disabledEmoji?: boolean;
}

/** The shapes `askedOf` reads: parsed flags (`WtftCliOptions`) and the `--watch` settings both fit. */
export interface ParsedChartOptions {
	hasInterval?: boolean;
	interval?: string;
	hasLimit?: boolean;
	limit?: number;
	hasMode?: boolean;
	mode?: ChartMode;
	hasTimezone?: boolean;
	timezone?: string | undefined;
	enableEmoji?: boolean | undefined;
	disabledEmoji?: boolean | undefined;
	hideCostColumns?: boolean;
	hideTokenColumns?: boolean;
	showCostColumns?: boolean;
	showTokenColumns?: boolean;
}

export function askedOf(opts: ParsedChartOptions): ChartAsked {
	const asked: ChartAsked = {};
	if (opts.hasInterval) asked.interval = opts.interval;
	if (opts.hasLimit) asked.limit = opts.limit;
	if (opts.hasMode) asked.mode = opts.mode;
	if (opts.hasTimezone) asked.timezone = opts.timezone;
	if (typeof opts.enableEmoji === "boolean") asked.enableEmoji = opts.enableEmoji;
	else if (typeof opts.disabledEmoji === "boolean") asked.enableEmoji = !opts.disabledEmoji;
	asked.showCostColumns = typeof opts.showCostColumns === "boolean" ? opts.showCostColumns : !opts.hideCostColumns;
	asked.showTokenColumns = typeof opts.showTokenColumns === "boolean" ? opts.showTokenColumns : !opts.hideTokenColumns;
	return asked;
}

/** `--cost` over `--tokens` over the config's `tokens`. */
export function chartUnit(opts: { hasTokens?: boolean; hasCost?: boolean }, configTokens: boolean | undefined): ChartUnit {
	let unit: ChartUnit = configTokens ? "tokens" : "cost";
	if (opts.hasTokens) unit = "tokens";
	if (opts.hasCost) unit = "cost";
	return unit;
}

/**
 * The chart lines for one session: each setting is what was asked, else the fallback, else a default
 * (`1h`, 17 rows, cumulative, no timezone, emoji on). Returns what `buildWtftLines` returns.
 * `padRows` fills the chart out to its limit with placeholder rows, or to `padRowsCap` when that is fewer.
 */
export function chartLines(call: {
	interactions: Interaction[];
	asked: ChartAsked;
	fallback: ChartFallback;
	unit: ChartUnit;
	/** Full path; the title shows the last four characters of its file name. */
	sessionFile?: string;
	model?: string;
	padRows?: boolean;
	padRowsCap?: number;
}): string[] | null {
	const { asked, fallback } = call;
	const interval = asked.interval ?? fallback.interval ?? "1h";
	const limit = chartLimit({ hasLimit: asked.limit !== undefined, limit: asked.limit ?? 0 }, fallback.limit);
	const mode = asked.mode ?? fallback.mode ?? "cumulative";
	const timezone = asked.timezone ?? fallback.timezone;
	const width = Math.min(asked.width ?? fallback.width, 1023);
	const disabledEmoji = asked.enableEmoji !== undefined ? !asked.enableEmoji : (fallback.disabledEmoji ?? false);
	return buildWtftLines(call.interactions, { interval: "1h", limit: 100, width, mode: "cumulative", timezone: undefined }, {
		interval,
		limit,
		padRowsTo: call.padRows ? Math.min(limit, call.padRowsCap === undefined ? limit : wholeLimit(call.padRowsCap)) : undefined,
		width,
		mode,
		timezone,
		disabledEmoji,
		model: call.model,
		sessionNameSuffix: call.sessionFile?.slice(call.sessionFile.lastIndexOf("/") + 1),
		unit: call.unit,
		showCostColumns: asked.showCostColumns,
		showTokenColumns: asked.showTokenColumns,
	});
}

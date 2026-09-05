/**
 * @package princess-pi-tools
 * @module wtft-renderer
 * @description Bar chart rendering, histograms, token summaries, and terminal utilities.
 *   Builds visual output from parsed Interaction arrays: binned bar charts,
 *   SURGE timeline markers, "Other" command histograms, and per-model token tables.
 *
 *   One renderer takes input that is NOT an Interaction array:
 *   `renderUncountedBillables` prints counts of billed-but-unrecorded events
 *   (#149) below TOTAL. It is the only output here that reports spend wtft
 *   cannot price, and it deliberately carries no dollar figure.
 */

import type { Interaction, Category } from "./wtft-shared.js";
import type { UncountedBillables } from "./wtft-parser.ts";
import {
	classifyInteraction,
	normalizeCommand,
	deduplicateInteractions
} from "./wtft-shared.js";
import {
	isModelPriced,
	getDeepSeekPeakMultiplier,
	DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES,
} from "./wtft-cost.js";
import { execSync } from "node:child_process";
import wcwidth from "wcwidth";
export interface Bin {
	key?: string; // ISO bin key (e.g. "2026-07-15T18:00") — populated at creation
	label: string;
	dateStr: string;
	costs: Record<Category, number>;
	total_cost: number;
	incremental_cost?: number;
	/** Token-mode fields — populated when unit==="tokens" (#14) */
	tokens?: Record<Category, { total: number; output: number }>;
	total_tokens?: number;
	incremental_tokens?: number;
	/** Per-category incremental token copies saved before cumulative conversion (#125). */
	_incTokens?: Record<Category, { total: number }>;
	/** True when any interaction in this bin fell within DeepSeek surge-pricing hours (#119). */
	surgePriced?: boolean;
}

// ---
// TOKEN-UNIT MODE (#14): Background colors and rendering
// ---

// ---
// CATEGORY ORDER + STYLE (#52 amendment 2, #103 reorder) — single source of truth.
// Overhead-first: Ovrhd (recache) → Waste (interrupted) → workflow → Cmpct → Other.
// Legend, cost-mode stacking, bucket-mode markers, and token-mode segments
// all derive from this table, so bar order matches legend order by construction.
// ---

export const CATEGORY_ORDER: Category[] = [
	"overhead", "interrupted", "plan", "spec", "research", "web", "grep", "code", "tests", "git",
	"agents", "prompt", "compaction", "other",
];

/** fg = legend/bar ANSI 256 color (used for token-mode block-height chars
 *  and cost-mode half-block rendering #109); char = bar glyph (█ for cost-mode);
 *  label = legend text.
 *  Phase 3 (#52) wired the overhead trio: Ovrhd = recache (full-context 1h-tier
 *  rewrite), Waste = user-killed turns, Cmpct = compaction cache re-write.
 *  Palette rebalanced (#109): adjacent-pair distinctness, no red/green adjacency. */
const CATEGORY_STYLE: Record<Category, { fg: number; bg: number; char: string; label: string | null }> = {
	plan:        { fg: 75,  bg: 30,  char: "█", label: "Plan" },
	spec:        { fg: 117, bg: 22,  char: "█", label: "Spec" },
	research:    { fg: 141, bg: 54,  char: "█", label: "Research" },
	web:         { fg: 209, bg: 88,  char: "█", label: "Web" },
	grep:        { fg: 68,  bg: 24,  char: "█", label: "Grep" },
	code:        { fg: 179, bg: 130, char: "█", label: "Code" },
	tests:       { fg: 149, bg: 178, char: "█", label: "Tests" },
	git:         { fg: 110, bg: 23,  char: "█", label: "Git" },
	agents:      { fg: 204, bg: 55,  char: "█", label: "Agents" },
	prompt:      { fg: 216, bg: 89,  char: "█", label: "Prompt" },
	compaction:  { fg: 143, bg: 58,  char: "█", label: "Cmpct" },
	interrupted: { fg: 197, bg: 52,  char: "█", label: "Waste" },
	overhead:    { fg: 180, bg: 94,  char: "█", label: "Ovrhd" },
	other:       { fg: 245, bg: 236, char: "█", label: "Other" },
};

/** Block-height chars for token-mode old/new segment split (#125). */
const BLOCK_OLD = "▃" as const;   // cached carryover from past bins
const BLOCK_NEW = "▇" as const;   // new incremental tokens this bin
const BLOCK_BUCKET = "█" as const; // bucket mode: full height (each row = a data point)

/**
 * Compute total tokens for an interaction (mirrors Anthropic API fields — mutually exclusive, no double-count).
 */
export function interactionTotalTokens(i: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }): number {
	return i.inputTokens + i.outputTokens + i.cacheReadTokens + i.cacheWriteTokens + i.reasoningTokens;
}

/**
 * Compute Pi-style footer summary line.
 *   ↑47k ↓14k R1.3M CH99.7%
 */
export function tokenFooterSummary(interactions: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }[]): string {
	let input = 0, output = 0, cr = 0, cw = 0, reasoning = 0;
	for (const i of interactions) {
		input += i.inputTokens + i.cacheReadTokens + i.cacheWriteTokens;
		output += i.outputTokens;
		cr += i.cacheReadTokens;
		cw += i.cacheWriteTokens;
		reasoning += i.reasoningTokens;
	}
	const totalCacheOps = cr + cw + input - cr - cw; // input-only portion...
	// Actually: cache hit rate = cacheRead / (cacheRead + cacheWrite + inputTokens uncached)
	// input already includes cache? No — field layout: inputTokens = non-cached, cacheRead = separate, cacheWrite = separate
	const denom = (input - cr - cw) + cr + cw; // = input (total input including cache)
	const hitRate = denom > 0 ? ((cr / denom) * 100).toFixed(0) : "0";
	const parts: string[] = [];
	if (input > 0) parts.push(`↑${formatTokenCount(input)}`);
	if (output > 0) parts.push(`↓${formatTokenCount(output)}`);
	if (reasoning > 0) parts.push(`R${formatTokenCount(reasoning)}`);
	if (cr > 0 || cw > 0) parts.push(`CH${hitRate}%`);
	return parts.join(" ");
}

/**
 * Accumulate tokens into a Bin alongside cost data during the binning loop.
 * Call this inside the interaction→bin loop in binInteractions().
 */
export function accumulateTokens(bin: Bin, category: Category, interaction: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }): void {
	if (!bin.tokens) {
		bin.tokens = {} as Record<Category, { total: number; output: number }>;
		for (const cat of CATEGORY_ORDER) {
			bin.tokens[cat] = { total: 0, output: 0 };
		}
		bin.total_tokens = 0;
	}
	const t = interactionTotalTokens(interaction);
	const o = interaction.outputTokens + interaction.reasoningTokens;
	bin.tokens[category].total += t;
	bin.tokens[category].output += o;
	bin.total_tokens! += t;
}

export interface IntervalConfig {
	size: number;
	unit: "m" | "h" | "d" | "w" | "t";
	type: "time" | "turns";
}

/**
 * Parse an `--interval` argument into a binning configuration.
 *
 * Two accepted shapes, and `--help` has historically only advertised the first
 * (see #160):
 *   - **time**  — `<n>m` / `<n>h` / `<n>d` / `<n>w`, e.g. `7m`, `4h`, `2w`
 *   - **turns** — `<n>t` / `<n>turn` / `<n>turns`, e.g. `7t` (#121)
 *
 * Unparseable input does not throw: it falls back to `1h`, because an interval
 * typo should degrade to the default chart rather than kill the widget mid-render.
 *
 * @param val - Raw `--interval` value as typed by the user
 * @returns The parsed size, unit, and whether binning is by time or by turn
 */
export function parseInterval(val: string): IntervalConfig {
	const timeMatch = /^(\d+)([mhdw])$/.exec(val);
	if (timeMatch) {
		const size = parseInt(timeMatch[1], 10);
		const unit = timeMatch[2] as "m" | "h" | "d" | "w";
		if (size > 0) return { size, unit, type: "time" };
	}
	const turnMatch = /^(\d+)(?:t|turns?)$/.exec(val);
	if (turnMatch) {
		const size = parseInt(turnMatch[1], 10);
		if (size > 0) return { size, unit: "t", type: "turns" };
	}
	return { size: 1, unit: "h", type: "time" };
}

export function getZonedParts(timestamp: number, tz?: string) {
	const d = new Date(timestamp);
	if (!tz) {
		return {
			year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
			hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds()
		};
	}
	try {
		const formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
			hour: "numeric", minute: "numeric", second: "numeric", hour12: false
		});
		const parts = formatter.formatToParts(d);
		const partMap: Record<string, string> = {};
		for (const p of parts) partMap[p.type] = p.value;
		let hour = parseInt(partMap.hour, 10);
		if (hour === 24) hour = 0;
		return {
			year: parseInt(partMap.year, 10), month: parseInt(partMap.month, 10), day: parseInt(partMap.day, 10),
			hour, minute: parseInt(partMap.minute, 10), second: parseInt(partMap.second, 10)
		};
	} catch {
		return {
			year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
			hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds()
		};
	}
}

export function getIsoWeekAndMonday(parts: { year: number; month: number; day: number }) {
	const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
	const day = date.getUTCDay();
	const diffToMonday = day === 0 ? 6 : day - 1;
	const mondayDate = new Date(date.getTime() - diffToMonday * 24 * 60 * 60 * 1000);
	const thursdayDate = new Date(mondayDate.getTime() + 3 * 24 * 60 * 60 * 1000);
	const targetYear = thursdayDate.getUTCFullYear();
	const jan1 = new Date(Date.UTC(targetYear, 0, 1));
	const jan1Day = jan1.getUTCDay();
	const firstThursday = new Date(jan1.getTime() + ((4 - jan1Day + 7) % 7) * 24 * 60 * 60 * 1000);
	const weekNum = 1 + Math.round((thursdayDate.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
	return {
		weekNum,
		mondayYear: mondayDate.getUTCFullYear(),
		mondayMonth: mondayDate.getUTCMonth() + 1,
		mondayDay: mondayDate.getUTCDate()
	};
}

export function getBinInfo(timestamp: number, config: IntervalConfig, turnIndex: number, tz?: string) {
	const parts = getZonedParts(timestamp, tz);
	const pad = (n: number) => String(n).padStart(2, "0");
	const dateStr = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
	const { size, unit, type } = config;

	// Turn-based binning (#121): bin by interaction sequence position, not time.
	// turnIndex is 1-based (first interaction = turn 1). Label = highest turn # in bucket.
	if (type === "turns") {
		const binEnd = Math.ceil(turnIndex / size) * size;
		return { key: `turn:${String(binEnd).padStart(6, "0")}`, label: `${binEnd}t`, dateStr };
	}

	if (unit === "m") {
		const totalMins = parts.hour * 60 + parts.minute;
		const binnedMins = Math.floor(totalMins / size) * size;
		return {
			key: `${dateStr}T${pad(Math.floor(binnedMins / 60))}:${pad(binnedMins % 60)}:00`,
			label: `${pad(Math.floor(binnedMins / 60))}:${pad(binnedMins % 60)}`,
			dateStr
		};
	} else if (unit === "h") {
		const startHours = Math.floor(parts.hour / size) * size;
		return {
			key: `${dateStr}T${pad(startHours)}:00:00`,
			label: `${pad(startHours)}:00`,
			dateStr
		};
	} else if (unit === "d") {
		const binnedDays = Math.floor((parts.day - 1) / size) * size;
		const label = `${parts.year}-${pad(parts.month)}-${pad(binnedDays + 1)}`;
		return { key: `${label}T00:00:00`, label, dateStr: label };
	} else {
		const info = getIsoWeekAndMonday(parts);
		const label = `W${pad(info.weekNum)} ${pad(info.mondayMonth)}-${pad(info.mondayDay)}`;
		return {
			key: `${info.mondayYear}-${pad(info.mondayMonth)}-${pad(info.mondayDay)}T00:00:00`,
			label,
			dateStr: `${info.mondayYear}-${pad(info.mondayMonth)}-${pad(info.mondayDay)}`
		};
	}
}

export function distributeChars(costs: Record<Category, number>, barWidth: number): Record<Category, number> {
	const total = Object.values(costs).reduce((sum, val) => sum + val, 0);
	const result = {} as Record<Category, number>;
	const remainders = {} as Record<Category, number>;
	const categories = Object.keys(costs) as Category[];
	
	if (total <= 0 || barWidth <= 0) {
		for (const cat of categories) result[cat] = 0;
		return result;
	}

	let allocated = 0;
	for (const cat of categories) {
		const raw = (costs[cat] / total) * barWidth;
		result[cat] = Math.floor(raw);
		remainders[cat] = raw - result[cat];
		allocated += result[cat];
	}

	while (allocated < barWidth) {
		let maxCat: Category | null = null;
		let maxRemainder = -1;
		for (const cat of categories) {
			if (remainders[cat] > maxRemainder) {
				maxRemainder = remainders[cat];
				maxCat = cat;
			}
		}
		if (maxCat) {
			result[maxCat]++;
			remainders[maxCat] = -1;
			allocated++;
		} else {
			break;
		}
	}
	return result;
}

// ---
// HALF-BLOCK RENDERING (#109): double resolution inside each terminal cell.
// Each cell encodes 2 half-slots via a single glyph:
//   █ (full block) when both half-slots are the same category (FG only)
//   ▌ (left half block) when they differ (FG=left category, BG=right category)
// ---

/**
 * Distribute proportional counts across barWidth × 2 half-slots.
 * Same remainder-distribution algorithm as {@link distributeChars}, but at
 * double resolution for half-block rendering.
 */
export function distributeHalfSlots(costs: Record<Category, number>, barWidth: number): Record<Category, number> {
	const total = Object.values(costs).reduce((sum, val) => sum + val, 0);
	const result = {} as Record<Category, number>;
	const remainders = {} as Record<Category, number>;
	const categories = Object.keys(costs) as Category[];
	const halfSlots = barWidth * 2;

	if (total <= 0 || halfSlots <= 0) {
		for (const cat of categories) result[cat] = 0;
		return result;
	}

	let allocated = 0;
	for (const cat of categories) {
		const raw = (costs[cat] / total) * halfSlots;
		result[cat] = Math.floor(raw);
		remainders[cat] = raw - result[cat];
		allocated += result[cat];
	}

	while (allocated < halfSlots) {
		let maxCat: Category | null = null;
		let maxRemainder = -1;
		for (const cat of categories) {
			if (remainders[cat] > maxRemainder) {
				maxRemainder = remainders[cat];
				maxCat = cat;
			}
		}
		if (maxCat) {
			result[maxCat]++;
			remainders[maxCat] = -1;
			allocated++;
		} else {
			break;
		}
	}
	return result;
}

/**
 * Render half-slots into terminal glyphs.
 *
 * Walks the half-slot array left-to-right, pairing slots[2n] + slots[2n+1]
 * into one terminal cell each:
 * - Same category → █ (full block) with FG = category color
 * - Different categories → ▌ (left half block) with FG = left cat, BG = right cat
 *
 * @param halfSlots - Array of category tags, length = barWidth × 2
 * @param styles - CATEGORY_STYLE lookup for FG colors
 * @returns ANSI string for the bar (barWidth cells wide)
 */
export function renderHalfBlockBar(
	halfSlots: Category[],
	styles: Record<Category, { fg: number }>
): string {
	let out = "";
	for (let i = 0; i < halfSlots.length; i += 2) {
		const left = halfSlots[i];
		const right = halfSlots[i + 1];
		const fgLeft = styles[left]?.fg ?? 245;
		if (left === right || right === undefined) {
			out += `\x1b[38;5;${fgLeft}m█\x1b[0m`;
		} else {
			const fgRight = styles[right]?.fg ?? 245;
			out += `\x1b[38;5;${fgLeft};48;5;${fgRight}m▌\x1b[0m`;
		}
	}
	return out;
}

/**
 * Flatten per-category half-slot counts into a half-slot array ordered by
 * CATEGORY_ORDER, for feeding into {@link renderHalfBlockBar}.
 *
 * Example: { plan: 2, code: 3 } → ["plan", "plan", "code", "code", "code"]
 */
export function halfSlotCountsToArray(counts: Record<Category, number>): Category[] {
	const result: Category[] = [];
	for (const cat of CATEGORY_ORDER) {
		for (let i = 0; i < (counts[cat] || 0); i++) {
			result.push(cat);
		}
	}
	return result;
}

export function calculateScaleMax(total: number): number {
	if (total <= 0) return 1.0;
	if (total > 20) {
		return Math.ceil(total / 5) * 5;
	} else {
		return Math.ceil(total);
	}
}

/**
 * Build tick line with token-count labels (e.g. "0.0", "25.0k", "50.0k").
 * Same layout as buildTickLine: decimal-point alignment, overlap-avoidance.
 * Forces one decimal place on all tick values so every label has a "." to
 * align — the zero tick ("0") becomes "0.0" (#99).
 */
export function buildTokenTickLine(maxTokens: number, barWidth: number, prefixWidth: number, labelPrefix: string): string | null {
	if (maxTokens <= 0 || barWidth < 15) return null;

	const totalWidth = prefixWidth + barWidth;
	const chars = Array(totalWidth).fill("─");

	const cleanPrefix = labelPrefix.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	for (let i = 0; i < cleanPrefix.length; i++) {
		chars[i] = cleanPrefix[i];
	}

	const ticks = [
		prefixWidth,
		prefixWidth + Math.floor(barWidth / 4),
		prefixWidth + Math.floor(barWidth / 2),
		prefixWidth + Math.floor((barWidth * 3) / 4),
		prefixWidth + barWidth - 1
	];

	const labels: {text: string, start: number, end: number}[] = [];
	const tickValues = [0, maxTokens / 4, maxTokens / 2, (maxTokens * 3) / 4, maxTokens];

	for (let i = 0; i < ticks.length; i++) {
		// Force one decimal place so every label has a "." to align on the tick.
		const text = formatTokenCount(Math.round(tickValues[i]));
		const displayStr = text.includes(".") ? ` ${text} ` : ` ${text}.0 `;
		// Align the decimal point exactly on the tick (same strategy as buildTickLine).
		const dotIdx = displayStr.indexOf(".");
		const startIdx = ticks[i] - dotIdx;
		const endIdx = startIdx + displayStr.length;

		let overlap = false;
		for (const l of labels) {
			if (startIdx < l.end && endIdx > l.start) {
				overlap = true; break;
			}
		}
		if (!overlap) {
			labels.push({ text: displayStr, start: startIdx, end: endIdx });
		}
	}

	labels.sort((a, b) => a.start - b.start);

	let result = "";
	let cursor = 0;
	for (const l of labels) {
		if (l.start > cursor) {
			result += chars.slice(cursor, Math.min(l.start, chars.length)).join("");
			if (l.start > chars.length) {
				result += " ".repeat(l.start - Math.max(cursor, chars.length));
			}
		}
		result += `\x1b[7m${l.text}\x1b[27m`;
		cursor = Math.max(cursor, l.end);
	}
	if (cursor < chars.length) {
		result += chars.slice(cursor).join("");
	}
	return result;
}

export function buildTickLine(maxCost: number, barWidth: number, prefixWidth: number, labelPrefix: string): string | null {
	if (maxCost <= 0 || barWidth < 15) return null;
	
	// Create the unified background characters array for the ENTIRE line width
	const totalWidth = prefixWidth + barWidth;
	const chars = Array(totalWidth).fill("─");

	// Fill the date prefix into the start of the characters array
	const cleanPrefix = labelPrefix.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ""); // Strip ANSI if any
	for (let i = 0; i < cleanPrefix.length; i++) {
		chars[i] = cleanPrefix[i];
	}

	// Calculate absolute tick index positions in the overall line
	const ticks = [
		prefixWidth,
		prefixWidth + Math.floor(barWidth / 4),
		prefixWidth + Math.floor(barWidth / 2),
		prefixWidth + Math.floor((barWidth * 3) / 4),
		prefixWidth + barWidth - 1
	];

	const labels: {text: string, start: number, end: number}[] = [];
	const tickValues = [0, maxCost / 4, maxCost / 2, (maxCost * 3) / 4, maxCost];

	for (let i = 0; i < ticks.length; i++) {
		const text = formatCost(tickValues[i]);
		const displayStr = ` ${text} `; // Inverted block padding
		
		const dotIdx = displayStr.indexOf(".");
		// Align the decimal point exactly on the tick index inside the overall line
		const startIdx = ticks[i] - dotIdx;
		const endIdx = startIdx + displayStr.length;

		// Check overlap with existing placed labels
		let overlap = false;
		for (const l of labels) {
			if (startIdx < l.end && endIdx > l.start) {
				overlap = true; break;
			}
		}
		if (!overlap) {
			labels.push({
				text: displayStr,
				start: startIdx,
				end: endIdx
			});
		}
	}

	// Sort labels left-to-right
	labels.sort((a, b) => a.start - b.start);

	let result = "";
	let cursor = 0;

	for (const l of labels) {
		// Fill in the horizontal bar lines before the label
		if (l.start > cursor) {
			result += chars.slice(cursor, Math.min(l.start, chars.length)).join("");
			// If a label starts past the end of the base characters array, pad with spaces
			if (l.start > chars.length) {
				result += " ".repeat(l.start - Math.max(cursor, chars.length));
			}
		}
		// Wrap the label with the ANSI Invert sequence and reset-to-dark-grey sequence
		result += `\x1b[7m${l.text}\x1b[27m`;
		cursor = Math.max(cursor, l.end);
	}

	// Fill in any remaining horizontal bar characters
	if (cursor < chars.length) {
		result += chars.slice(cursor).join("");
	}

	return result;
}

export function padString(str: string, len: number): string {
	return str.length >= len ? str : str + " ".repeat(len - str.length);
}

export function formatCost(cost: number): string {
	// Adaptive precision: 4 decimal places for sub-cent values, 2 otherwise,
	// so DeepSeek's sub-cent per-turn costs stay readable without cluttering
	// Claude/Gemini displays. No rate is quoted here on purpose — the one that
	// used to be ($0.14/M) was the pre-2026-08-16 card and outlived it (#495).
	// NOTE the guard is `> 0`: a negative cost gets 2 decimals, not 4.
	const decimals = cost > 0 && cost < 0.01 ? 4 : 2;
	return `$${cost.toFixed(decimals)}`;
}

export function formatMmmDdStr(dateStr: string): string {
	const parts = dateStr.split("-");
	if (parts.length === 3) {
		const monthIdx = parseInt(parts[1], 10) - 1;
		const day = parseInt(parts[2], 10);
		const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		const pad = (n: number) => String(n).padStart(2, "0");
		if (monthIdx >= 0 && monthIdx < 12) {
			return `${months[monthIdx]}-${pad(day)}`;
		}
	}
	return dateStr;
}

/**
 * Compute visual (monospace cell) width of a string after stripping ANSI escapes.
 * Delegates to the wcwidth library for proper Unicode East Asian Width handling
 * (#103), with one correction: wcwidth reports the "ambiguous"-width emoji in
 * U+2600–U+27BF (☀️ U+2600, ⚡ U+26A1, ⚠️ U+26A0, ✅ U+2705, ❌ U+274C) as one
 * column, but every modern terminal renders them as two. Measuring them at 1
 * made the SURGE timeline a column short at noon — right where the current-hour
 * clock sits after the sun (#64).
 */
export function getVisualLength(str: string): number {
	const clean = str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	let width = 0;
	for (const ch of clean) {
		const cp = ch.codePointAt(0)!;
		// Variation selectors are zero-width; the preceding character's width
		// is what they modify, so they add nothing on their own.
		if (cp === 0xfe0f || cp === 0xfe0e) continue;
		const w = cp >= 0x2600 && cp <= 0x27bf ? 2 : wcwidth(ch);
		// wcwidth returns -1 for control bytes and 0 for combining marks —
		// neither should be summed into a width (a stray control byte used to
		// poison the whole-line wcwidth with -1).
		if (w > 0) width += w;
	}
	return width;
}

// MAIN LAYOUT COMPILER

export function getTerminalWidth(isWidget = false, disabledEmoji = false): number {
	let width = 80;
	if (process.stdout && process.stdout.columns) {
		width = process.stdout.columns;
	} else if (process.stderr && process.stderr.columns) {
		width = process.stderr.columns;
	} else if (process.env.COLUMNS) {
		const num = parseInt(process.env.COLUMNS, 10);
		if (!isNaN(num) && num > 0) width = num;
	}
	if (width === 80 && process.env.TMUX) {
		try {
			const tmuxWidth = execSync("tmux display-message -p '#{pane_width}'", { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim();
			const num = parseInt(tmuxWidth, 10);
			if (!isNaN(num) && num > 0) width = num;
		} catch (e) {}
	}
	if (width === 80) {
		try {
			const cols = execSync("tput cols", { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim();
			const num = parseInt(cols, 10);
			if (!isNaN(num) && num > 0) width = num;
		} catch (e) {}
	}
	// Widgets: subtract minimal breathing room (1 char per side).
	// Pi's setWidget() does not enforce its own padding on raw line arrays,
	// so we only need 2 chars total. Previously subtracted 4 unnecessarily.
	return isWidget ? width - 2 : width;
}

// SURGE TIMELINE: 24-hour bar showing normal (green) vs surge (orange) pricing
// Used by both Pi TUI widget and CLI watch mode.

/**
 * Get the current local hour (0-23) for a given timezone.
 */
export function getCurrentLocalHour(tz?: string): number {
	const parts = getZonedParts(Date.now(), tz);
	return parts.hour;
}

/**
 * Get the UTC offset in ms for a given timezone at a given timestamp.
 */
export function getTimezoneOffsetMs(timestamp: number, tz: string): number {
	const parts = getZonedParts(timestamp, tz);
	const utcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
	return utcMs - timestamp;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves one (year, month, day, hour) wall-clock reading in `tz` to the
 * UTC instant it names — correctly on a day the zone's offset changes,
 * where a single sampled offset is wrong for whichever side of the
 * transition a given hour falls on (#24).
 *
 * Samples the offset a full day on each side of the target instant — far
 * enough that neither sample can itself be inside the transition being
 * resolved — then converts the wall-clock digits with each. On an ordinary
 * day the two offsets agree and either conversion is the answer. On a
 * transition day they disagree, and which converted instant is REAL is
 * decided by asking `getZonedParts` whether converting it back reproduces
 * the same (year, month, day, hour, :00:00): a candidate that fails is a
 * computed timestamp nobody's wall clock actually shows. Minute and second
 * are checked too, not just the hour (pinned in
 * `tests/wtft-24-dst-hours.test.ts` via Australia/Lord_Howe's 30-minute
 * shift): comparing hour alone would accept a candidate that reads
 * `HH:30:00` as if it were the requested `HH:00:00`, since only the digit
 * this function was asked to convert can be trusted to be exactly `:00`.
 * The one-hour gap-width algebra a few paragraphs down assumes a whole-hour
 * shift, which does not hold for Lord Howe's own 30-minute one — this
 * function still resolves every ORDINARY (non-transition) hour correctly
 * there, but the gap/fold hour's resolution loses the "same instant as the
 * adjacent hour" property outside the common whole-hour case.
 *
 * Two ambiguous cases fall out of that check, both resolved the same way —
 * prefer the later (post-transition) candidate when it is real, the earlier
 * one otherwise:
 *   - **Fall-back fold** (both candidates reproduce the hour, because it
 *     genuinely happens twice): resolves to the LATER of the two real
 *     instants.
 *   - **Spring-forward gap** (NEITHER candidate reproduces the hour, because
 *     it never happens): falls through to the earlier candidate — which
 *     algebraically is the exact instant the FOLLOWING hour resolves to
 *     (the earlier offset applied to hour H's digits equals the later
 *     offset applied to (H+1)'s digits, since the digits and the offset
 *     shift move by the same one-hour gap width). So the skipped hour reads
 *     as the hour right after it, matching what `Date.prototype.setHours`
 *     already does natively (verified for both directions in
 *     `tests/wtft-24-dst-hours.test.ts`, across zones on both sides of UTC)
 *     — this function needed the explicit rule; the host engine gets it for
 *     free from ECMA-262's own `UTC` abstract operation.
 *
 * The fold case is where this function and the host engine deliberately
 * diverge: `Date.prototype.setHours` resolves a repeated hour to its
 * EARLIER occurrence, not its later one (also pinned by the same tests) —
 * a documented, tested choice on each side, not a defect to reconcile.
 */
export function resolveZonedLocalHour(year: number, month: number, day: number, hour: number, tz: string): number {
	const wallUtcMs = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
	const earlyOffsetMs = getTimezoneOffsetMs(wallUtcMs - ONE_DAY_MS, tz);
	const candidateEarly = wallUtcMs - earlyOffsetMs;

	const lateOffsetMs = getTimezoneOffsetMs(wallUtcMs + ONE_DAY_MS, tz);
	if (lateOffsetMs === earlyOffsetMs) return candidateEarly;

	const candidateLate = wallUtcMs - lateOffsetMs;
	const lateParts = getZonedParts(candidateLate, tz);
	const lateIsReal = lateParts.year === year && lateParts.month === month
		&& lateParts.day === day && lateParts.hour === hour
		&& lateParts.minute === 0 && lateParts.second === 0;
	return lateIsReal ? candidateLate : candidateEarly;
}

/**
 * Returns which local hours (0-23) fall in a surge window, in the configured
 * timezone, for the day containing `now` (default: the host clock).
 *
 * The schedule is NOT re-typed here (#495). This asks
 * `getDeepSeekPeakMultiplier` what each hour actually costs, so the display
 * cannot disagree with the bill — the windows were hardcoded in four places
 * and a schedule change had no way to fail when it missed one.
 *
 * `now` is a parameter rather than a `Date.now()` call so a test can pin it
 * (#96: a dated DeepSeek surge test that read the host clock went flaky near
 * a window edge). Which day it describes is #496's question, not this one's.
 *
 * **Per-hour offset, not per-day (#24).** `now` is sampled once to pick which
 * calendar day (in `tz`) to describe, but on a day the zone's offset changes,
 * a single offset applied to all 24 local hours puts the hours on the far
 * side of the transition an hour off — which the display would then colour
 * (or fail to colour) wrong. Each candidate hour below resolves its OWN
 * offset via {@link resolveZonedLocalHour} — see its docstring for exactly
 * how a skipped or repeated local hour resolves, and why that resolution is
 * the same regardless of which side of UTC the zone sits on (measured for
 * both, in `tests/wtft-24-dst-hours.test.ts`). The `else` branch needs no
 * equivalent change — a fresh `new Date(now)` per iteration already gets
 * per-hour resolution for free, because `Date.prototype.setHours` re-derives
 * the offset from the target local time rather than reusing one.
 */
export function getSurgeLocalHours(tz?: string, now: number = Date.now()): Set<number> {
	const result = new Set<number>();
	const parts = tz ? getZonedParts(now, tz) : null;

	for (let localHour = 0; localHour < 24; localHour++) {
		let ts: number;
		if (tz && parts) {
			ts = resolveZonedLocalHour(parts.year, parts.month, parts.day, localHour, tz);
		} else {
			const d = new Date(now);
			d.setHours(localHour, 0, 0, 0);
			ts = d.getTime();
		}
		if (getDeepSeekPeakMultiplier(ts) > 1.0) {
			result.add(localHour);
		}
	}
	return result;
}

/**
 * Checks surge proximity (in UTC) at `at` — default the host clock. Returns
 * status and multiplier.
 *
 * The windows come from `DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES` rather than a
 * fourth hardcoded copy (#495), and a day that is entirely off-peak reports
 * no proximity at all: on a weekend there is no window to approach.
 */
export function checkSurgeProximity(at: number = Date.now()): { status: 'surge' | 'approaching' | 'ending' | undefined; multiplier: number } {
	const now = new Date(at);
	const currentUtcMinute = now.getUTCHours() * 60 + now.getUTCMinutes();

	// Ask the pricing module whether this day surges at all. Since 2026-08-23
	// weekends are off-peak end to end, so "approaching" a window that will
	// never open would be a warning about a charge that is not coming.
	const daySurges = DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES.some(([start]) => {
		const probe = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0) + start * 60000;
		return getDeepSeekPeakMultiplier(probe) > 1.0;
	});
	if (!daySurges) return { status: undefined, multiplier: 1.0 };

	for (const [start, end] of DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES) {
		if (currentUtcMinute >= start && currentUtcMinute < end) {
			return { status: 'surge', multiplier: 2.0 };
		}
		if (currentUtcMinute >= start - 20 && currentUtcMinute < start) {
			return { status: 'approaching', multiplier: 2.0 };
		}
		if (currentUtcMinute >= end - 20 && currentUtcMinute < end) {
			return { status: 'ending', multiplier: 2.0 };
		}
	}
	return { status: undefined, multiplier: 1.0 };
}

// Moon phase emoji — 8 phases from new moon through waning crescent.
const MOON_PHASES = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
const SYNODIC_MONTH_MS = 29.53058867 * 86400000;
// Reference new moon: 2026-07-14 09:43 UTC. Re-centre every ~2 years.
const REF_NEW_MOON = new Date("2026-07-14T09:43:00Z").getTime();

function getMoonPhase(date: Date): string {
	const ageMs = (date.getTime() - REF_NEW_MOON) % SYNODIC_MONTH_MS;
	const ageDays = (ageMs + SYNODIC_MONTH_MS) % SYNODIC_MONTH_MS / 86400000;
	// Offset by half a phase width so each bucket is centred on its
	// astronomical event (e.g. 🌑 covers ±1.8d around exact new moon,
	// not 0-3.7d which would classify a 2-day crescent as "new").
	const centered = ((ageDays + 29.53058867 / 16) / 29.53058867);
	const phase = Math.floor(centered * 8) % 8;
	return MOON_PHASES[phase];
}

/**
 * Build a 24-hour surge timeline string in the format:
 * 🌘──────🕔───☀️───────🌘 [⚡ SURGE 2x] [⚡ SURGE APPROACHING]
 *
 * One glyph per hour: `─` normally, `☀️` at noon, and a clock-face emoji at the
 * current hour (except noon — ☀️ owns position 12). Green = normal pricing,
 * orange = surge. The whole run is bookended by the current moon phase.
 *
 * The bookends are the only glyphs guaranteed present at every hour, so they —
 * not the clock face — are what callers and tests should key off to identify
 * the timeline (#158).
 *
 * Kept immediately above the function (#163): four declarations — `MOON_PHASES`,
 * `SYNODIC_MONTH_MS`, `REF_NEW_MOON`, `getMoonPhase` — used to sit between this
 * text and the function, so every editor hover attached it to `MOON_PHASES` and
 * the function itself read as undocumented. The misbinding predates #158 (it is
 * already there at `9b2a16e`); #158 rewrote the docstring's *text* in place and
 * inherited the bad binding without noticing. That is the lesson: a docstring is
 * only as good as the symbol it binds to, and correcting its words does not
 * re-point it.
 *
 * @param surgeHours - Set of local hours (0-23) that are surge-priced
 * @param currentHour - Current local hour (0-23) for the clock-face marker
 * @param proximityStatus - If set, appends the appropriate surge badge
 * @param date - Date for moon-phase bookends — defaults to now.
 * @param disabledEmoji - If true, swaps moon/sun/clock emoji for single-width
 *   ASCII — `|`, `*`, `@` — so the bar renders on terminals without those
 *   glyphs (#62).
 */
export function buildTimelineString(
	surgeHours: Set<number>,
	currentHour: number,
	proximityStatus?: 'surge' | 'approaching' | 'ending',
	/** Date for moon-phase bookends — defaults to now. */
	date?: Date,
	disabledEmoji?: boolean
): string {
	const segments: { color: string; text: string }[] = [];
	let lastColor: string | null = null;

	const CLOCK_FACES = ["🕛","🕐","🕑","🕒","🕓","🕔","🕕","🕖","🕗","🕘","🕙","🕚"];

	// 24 hour glyphs first; the sun is a 25th glyph spliced in below. The old
	// code rendered ☀️ IN PLACE OF hour 12, which ate the noon hour's slot — 23
	// hour-positions (12 left / 11 right) and no clock face during the
	// 12:00p–12:59p hour (#7).
	const glyphs: { color: string; char: string }[] = [];
	for (let h = 0; h < 24; h++) {
		const isSurge = surgeHours.has(h);
		const isCurrent = h === currentHour;

		const color = isCurrent ? "1;" + (isSurge ? "38;5;208" : "32") : (isSurge ? "38;5;208" : "32");
		// Current hour → clock face emoji (or `@` when emoji is disabled).
		// Otherwise → ─ box-drawing rule.
		glyphs.push({ color, char: isCurrent ? (disabledEmoji ? "@" : CLOCK_FACES[h % 12]) : "─" });
	}

	// Solar noon, between hour 11 (11am) and hour 12 (noon). It borrows hour 12's
	// surge color so noon surge-pricing still shows, but it is never "current" —
	// the clock face is the current-hour marker.
	const noonSurge = surgeHours.has(12);
	glyphs.splice(12, 0, { color: noonSurge ? "38;5;208" : "32", char: disabledEmoji ? "*" : "☀️" });

	for (const g of glyphs) {
		if (g.color !== lastColor) {
			segments.push({ color: g.color, text: g.char });
			lastColor = g.color;
		} else {
			segments[segments.length - 1].text += g.char;
		}
	}

	const timelineBody = segments.map(s => `\x1b[${s.color}m${s.text}\x1b[0m`).join("");
	const moon = disabledEmoji ? "|" : getMoonPhase(date ?? new Date());
	let result = `${moon}${timelineBody}${moon}`;

	// The badge is part of the same timeline string, so `--no-emoji` must swap
	// its ⚡ too — the manifest promises ASCII across the whole widget (#62).
	const bolt = disabledEmoji ? "!!" : "⚡";
	if (proximityStatus === 'surge') {
		result += ` \x1b[1;38;5;208m${bolt} SURGE 2x\x1b[0m`;
	} else if (proximityStatus === 'approaching') {
		result += ` \x1b[1;5;38;5;208m${bolt} SURGE APPROACHING\x1b[0m`;
	} else if (proximityStatus === 'ending') {
		result += ` \x1b[1;5;32m${bolt} SURGE ENDING\x1b[0m`;
	}

	return result;
}

// CACHE EFFICIENCY HELPER (#79)
// Compute cache hit rate from a set of interactions:
//   CH% = cacheReadTokens / (cacheReadTokens + cacheWriteTokens + inputTokens)
// Returns undefined if no cache-related tokens are present.
function computeCacheMetrics(interactions: Interaction[]): { hitRate: string; readTokens: string; totalOps: string } | undefined {
	let cr = 0, cw = 0, input = 0;
	for (const i of interactions) {
		cr += i.cacheReadTokens;
		cw += i.cacheWriteTokens;
		input += i.inputTokens;
	}
	const total = cr + cw + input;
	if (total === 0) return undefined;
	const hitRate = ((cr / total) * 100).toFixed(0);
	return { hitRate, readTokens: formatTokenCount(cr), totalOps: formatTokenCount(total) };
}

// ---

export function buildWtftLines(
	interactions: Interaction[],
	defaultSettings: {
		interval: string;
		limit: number;
		width: number;
		showTicks: boolean;
		mode: "bucket" | "cumulative";
		timezone?: string;
		disabledEmoji?: boolean;
	},
	opts?: {
		interval?: string;
		limit?: number;
		width?: number;
		showTicks?: boolean;
		mode?: "bucket" | "cumulative";
		timezone?: string;
		isWidget?: boolean;
		disabledEmoji?: boolean;
		/** Model ID for SURGE timeline coloring (pass "deepseek-..." for orange surge segments + badges). Auto-detected from interactions if omitted. */
		model?: string;
		/** Unit for bar scaling: "cost" (default) or "tokens" (#14). */
		unit?: "cost" | "tokens";
		/** Session filename; last 4 chars shown as a dim title suffix. */
		sessionNameSuffix?: string;
	}
): string[] | null {
	const intervalStr = opts?.interval !== undefined ? opts.interval : defaultSettings.interval;
	const limit = opts?.limit !== undefined ? opts.limit : defaultSettings.limit;
	const unit: "cost" | "tokens" = opts?.unit ?? "cost";
	
	const isWidget = opts?.isWidget ?? false;
	const disabledEmoji = opts?.disabledEmoji !== undefined ? opts.disabledEmoji : defaultSettings.disabledEmoji;
	const termWidth = getTerminalWidth(isWidget, disabledEmoji);
	const rawWidth = opts?.width !== undefined ? opts.width : defaultSettings.width;
	const width = Math.min(rawWidth, termWidth);
	const showTicks = opts?.showTicks !== undefined ? opts.showTicks : defaultSettings.showTicks;
	const mode = opts?.mode !== undefined ? opts.mode : defaultSettings.mode;
	const tz = opts?.timezone !== undefined ? opts.timezone : defaultSettings.timezone;

	const intervalConfig = parseInterval(intervalStr);

	// Deduplicate by message.id before binning (#54): Claude Code emits multiple
	// JSONL lines per API response, each echoing the same message-level usage.
	// Summing per line inflates costs ~1.8×.
	interactions = deduplicateInteractions(interactions);

	// Group interactions into binned intervals
	const binMap = new Map<string, Bin>();
	let totalSessionCost = 0;
	let turnIndex = 0; // 1-based counter for turn-based binning (#121)

	// Bins containing a cache miss — drives the "Cache Miss" divider (#106, #152).
	// Populated inline below: the miss is a property of the single interaction, so
	// unlike the TTL model this replaced it needs no neighbour comparison, no second
	// chronological sort, and no exemption for turn-based intervals.
	const cacheMissBins = new Set<string>();

	const ALL_CATEGORIES = CATEGORY_ORDER;

	for (const interaction of interactions) {
		turnIndex++;
		const classification = classifyInteraction(interaction);
		const { key, label, dateStr } = getBinInfo(interaction.timestamp, intervalConfig, turnIndex, tz);
		totalSessionCost += interaction.cost;

		// Observed cache miss (#152): decided at parse time against raw usage and
		// carried here, because the meter-split makes cr/cw unreadable for this by
		// the time the renderer sees them. Ground truth, not a TTL guess — it also
		// catches invalidation that consumed no time (model switch, prompt edit),
		// which the clock-based rule this replaced could never see.
		if (interaction.cacheMiss) {
			cacheMissBins.add(key);
		}

		let bin = binMap.get(key);
		if (!bin) {
			const costs = {} as Record<Category, number>;
			for (const cat of ALL_CATEGORIES) {
				costs[cat] = 0;
			}
			bin = { key, label, dateStr, costs, total_cost: 0 };
			binMap.set(key, bin);
		}

		// Turn-based mode (#121): always update label to highest turn # in bucket
		// and dateStr to latest interaction's date (for date separator logic).
		if (intervalConfig.type === "turns") {
			bin.label = `${turnIndex}t`;
			bin.dateStr = dateStr;
		}

		bin.costs[classification] += interaction.cost;
		bin.total_cost += interaction.cost;

		// Track surge-pricing: mark bin if any interaction fell in DeepSeek peak hours (#119)
		if (interaction.surgePriced) bin.surgePriced = true;

		// Server-side tool cost is a separate line item, not token spend (#73).
		// Attribute it to the "web" category independently of file classification.
		if (interaction.serverToolCost) {
			bin.costs["web"] += interaction.serverToolCost;
			bin.total_cost += interaction.serverToolCost;
			totalSessionCost += interaction.serverToolCost;
		}

		// Token accumulation for --tokens mode (#14)
		if (unit === "tokens") {
			accumulateTokens(bin, classification, interaction);
		}
	}

	// Sort bins chronological (ascending)
	const sortedBins = Array.from(binMap.entries())
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(entry => entry[1]);

	// Apply mode conversions
	if (mode === "cumulative") {
		// Save per-category incremental tokens before cumulative overwrite (#125)
		if (unit === "tokens") {
			for (const bin of sortedBins) {
				if (bin.tokens) {
					bin._incTokens = {} as Record<Category, { total: number }>;
					for (const cat of ALL_CATEGORIES) {
						bin._incTokens[cat] = { total: bin.tokens[cat].total };
					}
				}
			}
		}

		const runningCosts = {} as Record<Category, number>;
		for (const cat of ALL_CATEGORIES) {
			runningCosts[cat] = 0;
		}
		let running_total = 0;

		for (const bin of sortedBins) {
			bin.incremental_cost = bin.total_cost; // Preserve binned cost
			running_total += bin.total_cost;

			for (const cat of Object.keys(bin.costs) as Category[]) {
				runningCosts[cat] += bin.costs[cat];
				bin.costs[cat] = runningCosts[cat];
			}
			bin.total_cost = running_total;

			// Token cumulative tracking (#14)
			if (unit === "tokens" && bin.tokens && bin.total_tokens != null) {
				bin.incremental_tokens = bin.total_tokens;
			}
		}

		// Second pass for cumulative token totals (need incremental_tokens preserved first)
		if (unit === "tokens") {
			let runningTokens = 0;
			const runningTokByCat = {} as Record<Category, { total: number; output: number }>;
			for (const cat of ALL_CATEGORIES) {
				runningTokByCat[cat] = { total: 0, output: 0 };
			}
			for (const bin of sortedBins) {
				if (bin.tokens) {
					runningTokens += bin.total_tokens!;
					for (const cat of ALL_CATEGORIES) {
						runningTokByCat[cat].total += bin.tokens[cat].total;
						runningTokByCat[cat].output += bin.tokens[cat].output;
						bin.tokens[cat] = { ...runningTokByCat[cat] };
					}
					bin.total_tokens = runningTokens;
				}
			}
		}
	}

	// Token mode: compute global totals for scale
	const totalSessionTokens = unit === "tokens"
		? interactions.reduce((sum, i) => sum + interactionTotalTokens(i), 0)
		: 0;

	// Descending order for binned bars display
	const reversedBins = sortedBins.reverse();
	const displayedBins = reversedBins.slice(0, limit);

	if (displayedBins.length === 0) {
		return null;
	}

	const maxBarValue = mode === "cumulative"
		? (unit === "tokens" ? totalSessionTokens : totalSessionCost)
		: Math.max(...displayedBins.map(b => unit === "tokens" ? (b.total_tokens ?? 0) : b.total_cost), 0);
	const scaleMax = unit === "tokens"
		? Math.ceil(maxBarValue / 1000) * 1000  // round to nearest 1k for tokens
		: calculateScaleMax(maxBarValue);

	// Token mode: format scale label for tick marks
	const formatScaleLabel = (v: number): string => {
		if (unit === "tokens") return formatTokenCount(v);
		return formatCost(v);
	};

	// Compute the exact prefix width of the bar rows dynamically to prevent alignment offsets when costs grow wide
	const labelWidth = Math.max(...displayedBins.map(b => b.label.length), 5);
	let prefixWidth = labelWidth + 2; // labelPart + "  "
	
	let maxIncLen = 6;
	let maxCostLen = 6;

	if (unit === "tokens") {
		// Token mode: show cumulative tokens + incremental tokens
		if (mode === "cumulative") {
			maxIncLen = Math.max(...displayedBins.map(bin => {
				const incSign = (bin.incremental_tokens ?? 0) >= 0 ? "+" : "";
				return `${incSign}${formatTokenCount(bin.incremental_tokens ?? 0)}`.length;
			}), 6);
			maxCostLen = Math.max(...displayedBins.map(b => formatTokenCount(b.total_tokens ?? 0).length), 6);
			prefixWidth += maxIncLen + 2 + maxCostLen + 2 + 4; // +4 for " tok" unit suffix
		} else {
			maxCostLen = Math.max(...displayedBins.map(b => formatTokenCount(b.total_tokens ?? 0).length), 6);
			prefixWidth += maxCostLen + 2 + 4; // +4 for " tok" unit suffix
		}
	} else if (mode === "cumulative") {
		maxIncLen = Math.max(...displayedBins.map(bin => {
			const incSign = (bin.incremental_cost ?? 0) >= 0 ? "+" : "";
			return `${incSign}${formatCost(bin.incremental_cost ?? 0)}`.length;
		}), 6);
		maxCostLen = Math.max(...displayedBins.map(b => formatCost(b.total_cost).length), 6);
		prefixWidth += maxIncLen + 2 + maxCostLen + 2; // incPart + "  " + costPart + "  "
	} else {
		maxCostLen = Math.max(...displayedBins.map(b => formatCost(b.total_cost).length), 6);
		prefixWidth += maxCostLen + 2; // costPart + "  "
	}

	const finalWidth = Math.max(width, 40);
	
	// We reserve characters at the end of the line so tick labels aligned by
	// decimal point (e.g. ` $100.00 `, ` 13.1M `) don't overflow. Cost-mode
	// labels ("$0.50") need 3 trailing chars; token-mode labels ("13.1M") are
	// wider and need 5 trailing chars (#99).
	const tickReserve = unit === "tokens" ? 5 : 3;
	const maxBarWidth = finalWidth - prefixWidth - tickReserve;

	// Resolve the newest local date for display on the ticks line
	const newestBin = displayedBins[0];
	let titleDateStr = "";
	if (newestBin) {
		titleDateStr = formatMmmDdStr(newestBin.dateStr);
	} else {
		const nowParts = getZonedParts(Date.now(), tz);
		const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		const pad = (n: number) => String(n).padStart(2, "0");
		titleDateStr = `${months[nowParts.month - 1]}-${pad(nowParts.day)}`;
	}

	const widgetLines: string[] = [];
	
	const titleLeft = unit === "tokens"
		? (disabledEmoji ? "[#] WTF Tokens?" : "🔢 WTF Tokens?")
		: (disabledEmoji ? "[$] WTF Tokens?" : "💸 WTF Tokens?");
	
	// Append session suffix (last 4 chars of session name) if available
	const sessionSuffix = opts?.sessionNameSuffix ? ` \x1b[90m...${opts.sessionNameSuffix.replace(/.jsonl$/, "").slice(-4)}\x1b[0m` : "";
	const titleLeftFinal = titleLeft + sessionSuffix;
	
	// --- SURGE timeline (computed early so title row can account for its width) ---
	// Model auto-detected from interactions if caller doesn't pass one explicitly.
	let surgeModel = opts?.model;
	if (!surgeModel) {
		for (const i of interactions) {
			if (i.model) { surgeModel = i.model; break; }
		}
	}
	const isDeepSeek = (surgeModel || "").toLowerCase().includes("deepseek");
	const surgeHours = isDeepSeek ? getSurgeLocalHours(tz) : new Set<number>();
	const currentHour = getCurrentLocalHour(tz);
	const proximity = isDeepSeek ? checkSurgeProximity() : { status: undefined as ReturnType<typeof checkSurgeProximity>["status"], multiplier: 1.0 };
	const timelineStr = buildTimelineString(surgeHours, currentHour, proximity.status, undefined, disabledEmoji);
	const timelineLen = getVisualLength(timelineStr);

	const legendItems = CATEGORY_ORDER
		.filter(c => CATEGORY_STYLE[c].label !== null)
		.map(c => `\x1b[38;5;${CATEGORY_STYLE[c].fg}m${CATEGORY_STYLE[c].char}\x1b[0m${CATEGORY_STYLE[c].label}`);
	const legendStr = legendItems.join(" ");
	

	// Title + timeline on row 0, legend always on row 1.
	// Putting the legend on its own row avoids layout flip-flop when the
	// SURGE proximity badge appears/disappears (shifts timelineLen
	// ~20 chars, potentially crossing an inline-fit threshold).
	widgetLines.push(titleLeftFinal + "  " + timelineStr);
	widgetLines.push(legendStr);

	// Render single-row collapsed ticks line
	if (showTicks && scaleMax > 0) {
		const dateLabel = `── ${titleDateStr} `;
		const paddingLen = Math.max(0, prefixWidth - dateLabel.length);
		const labelPrefix = dateLabel + "─".repeat(paddingLen);
		// Use formatScaleLabel for tick labels in token mode
		const ticksLine = unit === "tokens"
			? buildTokenTickLine(scaleMax, maxBarWidth, prefixWidth, labelPrefix)
			: buildTickLine(scaleMax, maxBarWidth, prefixWidth, labelPrefix);
		if (ticksLine) {
			widgetLines.push(`\x1b[90m${ticksLine}\x1b[0m`);
		}
	}

	// Pre-compute cumulative cost-mode half-slot allocations in chronological
	// order with clamping (#106, #109). Half-slot distribution preserves boundary
	// precision (▌ at category transitions). Clamping only applies to categories
	// with ≥ 2 half-slots (1 full char) to avoid the "every category gets 1
	// half-slot" artifact.
	const precomputedHalfSlots: Map<Bin, Record<Category, number>> = new Map();
	if (mode === "cumulative" && unit === "cost") {
		const chronological = [...displayedBins].reverse();
		let prevSlots: Record<Category, number> | null = null;
		for (const bin of chronological) {
			const barWidthCells = scaleMax > 0 ? Math.round((bin.total_cost / scaleMax) * maxBarWidth) : 0;
			const halfSlotWidth = barWidthCells * 2;
			const slots = {} as Record<Category, number>;
			let allocated = 0;
			const remainders = {} as Record<Category, number>;

			for (const cat of CATEGORY_ORDER) {
				const raw = scaleMax > 0 ? (bin.costs[cat] / scaleMax) * halfSlotWidth : 0;
				slots[cat] = Math.floor(raw);
				remainders[cat] = raw - slots[cat];
				allocated += slots[cat];
			}

			// Clamp to previous bin — only for categories with ≥ 2 half-slots
			// (1 full char). Tiny 1-half-slot allocations from remainder
			// distribution are allowed to flicker; clamping them would make
			// every category permanently visible.
			if (prevSlots) {
				let clampedTotal = 0;
				for (const cat of CATEGORY_ORDER) {
					if (prevSlots[cat] >= 2) {
						slots[cat] = Math.max(slots[cat], prevSlots[cat]);
					}
					clampedTotal += slots[cat];
				}
				// If clamping overshot halfSlotWidth, trim from categories that grew
				// the most (they stole from others' remainder slots).
				let excess = clampedTotal - halfSlotWidth;
				while (excess > 0) {
					let maxGrow = -1, maxCat: Category | null = null;
					for (const cat of CATEGORY_ORDER) {
						if (slots[cat] <= 0) continue;
						const grow = slots[cat] - (prevSlots[cat] || 0);
						if (grow > maxGrow) { maxGrow = grow; maxCat = cat; }
					}
					if (maxCat) { slots[maxCat]--; excess--; }
					else break;
				}
				// Recompute allocated from actual slot total.
				// When clampedTotal < halfSlotWidth, excess is negative and
				// halfSlotWidth - excess overshoots — remainder loop would skip.
				allocated = 0;
				for (const cat of CATEGORY_ORDER) allocated += slots[cat];
			}

			// Distribute remaining half-slots to categories furthest below their
			// ideal proportional share. No gate on floor > 0 — the deficit formula
			// naturally prefers categories with meaningful cost shares.
			while (allocated < halfSlotWidth) {
				let maxDeficit = -Infinity;
				let maxCat: Category | null = null;
				for (const cat of CATEGORY_ORDER) {
					const ideal = (bin.costs[cat] / bin.total_cost) * halfSlotWidth;
					const deficit = ideal - slots[cat];
					if (deficit > maxDeficit) {
						maxDeficit = deficit;
						maxCat = cat;
					}
				}
				if (maxCat) {
					slots[maxCat]++;
					allocated++;
				} else {
					break;
				}
			}

			precomputedHalfSlots.set(bin, slots);
			prevSlots = { ...slots };
		}
	}

	// Helper: build a tick-aligned divider line with a left-side label.
	// Same format as day change dividers, reused for cache TTL expiry (#106).
	const buildDividerLine = (labelText: string): string => {
		const prefix = `── ${labelText} `;
		const dividerLen = Math.max(0, (finalWidth - tickReserve) - prefix.length);
		const chars = Array.from({ length: dividerLen }, () => "─");
		const tickPositions = [
			prefixWidth,
			prefixWidth + Math.floor(maxBarWidth / 4),
			prefixWidth + Math.floor(maxBarWidth / 2),
			prefixWidth + Math.floor((maxBarWidth * 3) / 4),
			prefixWidth + maxBarWidth - 1
		];
		for (const t of tickPositions) {
			const idx = t - prefix.length;
			if (idx >= 0 && idx < chars.length) {
				chars[idx] = "┼";
			}
		}
		return prefix + chars.join("");
	};

	// Render binned stacked bars
	for (let i = 0; i < displayedBins.length; i++) {
		const bin = displayedBins[i];

		// Day boundary divider (only with --ticks enabled)
		if (showTicks && i > 0 && bin.dateStr !== displayedBins[i - 1].dateStr) {
			widgetLines.push(`\x1b[90m${buildDividerLine(formatMmmDdStr(bin.dateStr))}\x1b[0m`);
		}

		// Cache miss divider (#106, #152) — always shown, even with --no-ticks.
		// Labelled "Miss" not "Expired": the usage block proves the re-prime happened,
		// but says nothing about why, and TTL is only one of the causes.
		if (bin.key && cacheMissBins.has(bin.key)) {
			widgetLines.push(`\x1b[90m${buildDividerLine("Cache Miss")}\x1b[0m`);
		}

		const labelPart = padString(bin.label, labelWidth);

		// Surge-pricing UI (#119, #128): orange for bins with surge-priced interactions.
		// Label, increment, and cumulative cost all get the surge treatment — it's the
		// time slot that triggers surge, so all cost/revenue of that bin is affected.
		const surgeActive = bin.surgePriced === true;
		const surgeLabel = surgeActive ? "\x1b[1;38;5;208m" : "\x1b[90m";
		const surgeInc = surgeActive ? "\x1b[1;38;5;208m" : "\x1b[90m";
		const costColor = surgeActive ? "\x1b[1;38;5;208m" : "\x1b[1;37m";
		const coloredLabel = `${surgeLabel}${labelPart}\x1b[0m`;
		// ⚡ is double-width — it fills the 2-char column gap on its own, numbers stay aligned.
		const boltGap = surgeActive ? "\x1b[1;38;5;208m\u26A1\x1b[0m" : "  ";

		if (unit === "tokens" && bin.tokens) {
			// --- TOKEN MODE BAR RENDERING (#14, amended #125 block-height) ---
			const barMax = Math.max(0, maxBarWidth - 2); // 2-char safety margin for Pi TUI padding
			const barWidth = scaleMax > 0 && barMax > 0 ? Math.round(((bin.total_tokens ?? 0) / scaleMax) * barMax) : 0;
			// Token bar: colored fg block-height char on default background per $/tok (#125)
			let barStr = "";
			let allChars: number = 0;
			for (const cat of ALL_CATEGORIES) {
				const t = bin.tokens[cat];
				if (!t || t.total <= 0) continue;
				const segWidth = scaleMax > 0 && barMax > 0 ? Math.round(((bin.total_tokens ?? 0) / scaleMax) * barMax * (t.total / (bin.total_tokens || 1))) : 0;
				// distribute proportional chars
				const segChars = Math.max(0, Math.min(segWidth, barMax - allChars));
				if (segChars <= 0) continue;
				const fg = CATEGORY_STYLE[cat]?.fg ?? 245;

				if (mode === "cumulative") {
					// Cumulative mode: split segment into old (cached carryover → ▃)
					// and new (incremental this turn → ▇) portions (#125).
					// Use per-category incremental tokens (saved before cumulative conversion).
					const incTokens = bin._incTokens?.[cat]?.total ?? 0;
					const catIncRatio = t.total > 0 ? incTokens / t.total : 0;
					const rawNew = segChars * catIncRatio;
					const newChars = rawNew > 0 ? Math.max(1, Math.round(rawNew)) : 0;
					const oldChars = segChars - newChars;

					if (oldChars > 0) barStr += `\x1b[38;5;${fg}m${BLOCK_OLD.repeat(oldChars)}\x1b[0m`;
					if (newChars > 0) barStr += `\x1b[38;5;${fg}m${BLOCK_NEW.repeat(newChars)}\x1b[0m`;
				} else {
					// Bucket mode: full-height character (each row = a data point)
					barStr += `\x1b[38;5;${fg}m${BLOCK_BUCKET.repeat(segChars)}\x1b[0m`;
				}
				allChars += segChars;
			}

			// Server tool cost marker ($) at bar tail if no tokens but had cost (#14)
			const hasServerToolCost = (bin.costs["web"] || 0) > 0 && (bin.tokens["web"]?.total ?? 0) === 0;
			if (hasServerToolCost && allChars < barMax) {
				barStr += `\x1b[38;5;209m$\x1b[0m`;
				allChars++;
			}

			// Prefix: incremental + cumulative tokens
			if (mode === "cumulative") {
				const incSign = (bin.incremental_tokens ?? 0) >= 0 ? "+" : "";
				const incStr = `${incSign}${formatTokenCount(bin.incremental_tokens ?? 0)}`;
				const incPart = padString(incStr, maxIncLen);
				const tokPart = padString(formatTokenCount(bin.total_tokens ?? 0), maxCostLen);
				widgetLines.push(`${coloredLabel}  ${surgeInc}${incPart}\x1b[0m${boltGap}${costColor}${tokPart} tok\x1b[0m  ${barStr}`);
			} else {
				const tokPart = padString(formatTokenCount(bin.total_tokens ?? 0), maxCostLen);
				widgetLines.push(`${coloredLabel}${boltGap}${costColor}${tokPart} tok\x1b[0m  ${barStr}`);
			}
		} else {
			// --- COST MODE BAR RENDERING (#109: half-block resolution) ---
			let barStr = "";
			if (mode === "cumulative") {
				// Use precomputed half-slots directly (#109). Clamping threshold
				// (≥ 2 half-slots) prevents tiny categories from persisting.
				const halfSlotCounts = precomputedHalfSlots.get(bin)!;
				const halfSlots = halfSlotCountsToArray(halfSlotCounts);
				barStr = renderHalfBlockBar(halfSlots, CATEGORY_STYLE);
			} else {
				// Bucket mode: two-pass cost-based collision resolution (#109).
				// Pass 1: accumulate categories per position with their costs.
				const buckets = new Map<number, { cat: Category; cost: number }[]>();
				for (const cat of CATEGORY_ORDER) {
					const cost = bin.costs[cat] || 0;
					if (cost > 0 && scaleMax > 0) {
						const pos = Math.round((cost / scaleMax) * (maxBarWidth - 1));
						if (pos >= 0 && pos < maxBarWidth) {
							if (!buckets.has(pos)) buckets.set(pos, []);
							buckets.get(pos)!.push({ cat, cost });
						}
					}
				}
				// Pass 2: per position, pick top 2 by cost, render as █ or ▌.
				for (let pos = 0; pos < maxBarWidth; pos++) {
					const entries = buckets.get(pos);
					if (!entries || entries.length === 0) {
						barStr += " ";
					} else if (entries.length === 1) {
						const fg = CATEGORY_STYLE[entries[0].cat].fg;
						barStr += `\x1b[38;5;${fg}m█\x1b[0m`;
					} else {
						// Top 2 by cost
						entries.sort((a, b) => b.cost - a.cost);
						const fg = CATEGORY_STYLE[entries[0].cat].fg;
						const bg = CATEGORY_STYLE[entries[1].cat].fg;
						barStr += `\x1b[38;5;${fg};48;5;${bg}m▌\x1b[0m`;
					}
				}
			}

			if (mode === "cumulative") {
				const incSign = (bin.incremental_cost ?? 0) >= 0 ? "+" : "";
				const incStr = `${incSign}${formatCost(bin.incremental_cost ?? 0)}`;
				const incPart = padString(incStr, maxIncLen);
				const coloredInc = `${surgeInc}${incPart}\x1b[0m`;
				const costPart = padString(formatCost(bin.total_cost), maxCostLen);
				const coloredCost = `${costColor}${costPart}\x1b[0m`;
				widgetLines.push(`${coloredLabel}  ${coloredInc}${boltGap}${coloredCost}  ${barStr}`);
			} else {
				const costPart = padString(formatCost(bin.total_cost), maxCostLen);
				const coloredCost = `${costColor}${costPart}\x1b[0m`;
				widgetLines.push(`${coloredLabel}${boltGap}${coloredCost}  ${barStr}`);
			}
		}
	}

	// PROACTIVE "OTHER" BLOAT WARNING (#17) — cost mode only
	if (unit === "cost") {
		const totalOtherCost = interactions
			.filter(i => classifyInteraction(i) === "other")
			.reduce((sum, i) => sum + i.cost, 0);
		if (totalSessionCost > 0) {
			const otherPct = totalOtherCost / totalSessionCost;
			if (otherPct > 0.20 && totalOtherCost > 6.00) {
				const pctStr = `${Math.round(otherPct * 100)}%`;
				const costStr = formatCost(totalOtherCost);
				widgetLines.push(`\x1b[1;33m⚠️  "Other" category: ${pctStr} of session cost (${costStr}). Run wtft --other to drill down.\x1b[0m`);
			}
		}
	}

	// --- TOKEN MODE FOOTER (#14, amended #125): block-height key bar + Pi-style summary ---
	if (unit === "tokens") {
		// Block-height key bar (#125): ▃ = cached/carryover, ▇ = new/uncached
		widgetLines.push(`\x1b[90m  \x1b[37m▃\x1b[0m\x1b[90m cached/carryover  \x1b[37m▇\x1b[0m\x1b[90m new/uncached  \x1b[90m\$ = cost-only (web tools)\x1b[0m`);
		// Footer summary
		const summary = tokenFooterSummary(interactions);
		if (summary) {
			widgetLines.push(`\x1b[37m  ${summary}\x1b[0m`);
		}
		// Still show cache efficiency if relevant
		const cacheMetrics = computeCacheMetrics(interactions);
		if (cacheMetrics) {
			widgetLines.push(`\x1b[90m  CH: ${cacheMetrics.hitRate}% cache hit (${cacheMetrics.readTokens} read / ${cacheMetrics.totalOps} total ops)\x1b[0m`);
		}
	}

	// Cache efficiency metric line (#79) — cost mode only
	if (unit === "cost") {
		const cacheMetrics = computeCacheMetrics(interactions);
		if (cacheMetrics) {
			widgetLines.push(`\x1b[90m  CH: ${cacheMetrics.hitRate}% cache hit (${cacheMetrics.readTokens} read / ${cacheMetrics.totalOps} total ops)\x1b[0m`);
		}
	}

	return widgetLines;
}

// SEMANTIC COMMAND SUB-CLASSIFICATION
// Maps bare command names to semantic groups for wtft-other histogram.

const SEMANTIC_GROUPS: Record<string, { label: string; commands: Set<string> }> = {
	build: {
		label: "Build & Bundling",
		commands: new Set(["npm", "npx", "esbuild", "webpack", "vite", "tsc", "make", "gcc", "cargo", "go", "pnpm", "yarn", "bun", "node", "tsx", "ts-node", "cmake", "ninja", "g++"])
	},
	deps: {
		label: "Dependency Management",
		commands: new Set(["pip", "pip3", "gem", "brew", "apt-get", "apt", "dnf", "pacman", "zypper", "apk"])
	},
	lint: {
		label: "Linting & Formatting",
		commands: new Set(["eslint", "prettier", "black", "rustfmt", "shfmt", "biome", "stylelint", "shellcheck", "ruff", "flake8", "pylint", "clippy"])
	},
	test: {
		label: "Testing",
		commands: new Set(["jest", "vitest", "pytest", "cypress", "playwright", "mocha", "ava", "tap", "karma"])
	},
	db: {
		label: "Database & Infrastructure",
		commands: new Set(["sqlite3", "psql", "mysql", "docker", "kubectl", "aws", "terraform", "gh", "fly", "railway", "mongo", "redis-cli", "pg_dump", "pg_restore"])
	},
	sys: {
		label: "System & File Utilities",
		commands: new Set(["ls", "mkdir", "cp", "rm", "mv", "chmod", "chown", "touch", "wc", "du", "df", "which", "echo", "pwd", "cd", "ln", "stat", "file", "realpath", "readlink", "dirname", "basename", "tar", "gzip", "gunzip", "zip", "unzip", "curl", "wget", "ssh", "scp", "rsync"])
	},
	git: {
		label: "Git Operations",
		commands: new Set(["git"])
	},
	session: {
		label: "Session & Agent",
		commands: new Set(["pi", "python", "python3", "bash", "zsh", "clear", "exit", "source", ".", "exec", "env", "export", "alias", "unalias"])
	}
};

export function getSemanticCommandGroup(command: string): string | null {
	const base = command.split("/").pop() || command; // Strip path prefix e.g. /usr/bin/ls → ls
	for (const [key, group] of Object.entries(SEMANTIC_GROUPS)) {
		if (group.commands.has(base)) return group.label;
	}
	// Git subcommands: anything starting with "git" → Git Operations
	if (base === "git" || command.startsWith("git ")) return SEMANTIC_GROUPS.git.label;
	// npm subcommands → Build & Bundling (covers npm run/build/test/install/etc.)
	if (command.startsWith("npm ")) return SEMANTIC_GROUPS.build.label;
	// yarn/pnpm/bun subcommands → Build & Bundling
	if (command.startsWith("yarn ") || command.startsWith("pnpm ") || command.startsWith("bun ")) return SEMANTIC_GROUPS.build.label;
	// go subcommands → Build & Bundling
	if (command.startsWith("go ")) return SEMANTIC_GROUPS.build.label;
	// cargo subcommands not already matched
	if (command.startsWith("cargo ")) return SEMANTIC_GROUPS.build.label;
	// pip subcommands → Deps
	if (command.startsWith("pip ") || command.startsWith("pip3 ")) return SEMANTIC_GROUPS.deps.label;
	return null;
}

export function renderOtherHistogram(interactions: Interaction[], maxWidth: number = 80): string {
	const commandMap = new Map<string, { count: number; cost: number }>();

	for (const interaction of interactions) {
		const classification = classifyInteraction(interaction);
		if (classification === "other") {
			// Extract exact primary command for bash
			const primaryCommands: string[] = [];
			for (const rawCmd of interaction.commands) {
				const normalized = normalizeCommand(rawCmd);
				if (!normalized) continue; // stripped to nothing (pure cd, pure var assignment)
				const lines = normalized.split('\n');
				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed && !trimmed.startsWith("#")) {
						const parts = trimmed.split(" ");
						const primary = parts[0];
						if (primary) {
							primaryCommands.push(primary);
							break; // Only capture the first effective command
						}
					}
				}
			}

			for (const cmd of primaryCommands) {
				const existing = commandMap.get(cmd) || { count: 0, cost: 0 };
				commandMap.set(cmd, {
					count: existing.count + 1,
					cost: existing.cost + interaction.cost
				});
			}
		}
	}

	if (commandMap.size === 0) {
		return "No 'Other' commands found in this session.";
	}

	// Group commands by semantic category
	const groups = new Map<string, { count: number; cost: number; commands: Map<string, { count: number; cost: number }> }>();

	for (const [cmd, data] of commandMap) {
		const groupName = getSemanticCommandGroup(cmd) || "Unclassified";
		let group = groups.get(groupName);
		if (!group) {
			group = { count: 0, cost: 0, commands: new Map() };
			groups.set(groupName, group);
		}
		group.count += data.count;
		group.cost += data.cost;
		group.commands.set(cmd, data);
	}

	// Sort groups: known categories first (by spec order), then Unclassified last
	const groupOrder = [
		"Build & Bundling",
		"Dependency Management",
		"Linting & Formatting",
		"Testing",
		"Database & Infrastructure",
		"System & File Utilities",
		"Git Operations",
		"Session & Agent"
	];
	const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
		const ai = groupOrder.indexOf(a[0]);
		const bi = groupOrder.indexOf(b[0]);
		if (ai === -1 && bi === -1) return a[0].localeCompare(b[0]);
		if (ai === -1) return 1;
		if (bi === -1) return -1;
		return ai - bi;
	});

	let output = "--- 'Other' Command Histogram ---\n";

	// Find max command length for alignment
	let maxCmdLen = 0;
	for (const cmd of commandMap.keys()) maxCmdLen = Math.max(maxCmdLen, cmd.length);

	const countWidth = 7;
	const costWidth = 10;

	for (const [groupName, group] of sortedGroups) {
		const groupCostStr = `$${group.cost.toFixed(4)}`;
		output += `\n[${groupName}]  (${group.count} calls, ${groupCostStr})\n`;

		// Sort commands within group by count descending
		const sortedCmds = Array.from(group.commands.entries()).sort((a, b) => b[1].count - a[1].count);

		for (const [cmd, data] of sortedCmds) {
			const countStr = `(${data.count})`.padStart(countWidth);
			const costStr = `$${data.cost.toFixed(4)}`.padStart(costWidth);

			const barWidth = Math.max(5, maxWidth - maxCmdLen - countWidth - costWidth - 10);
			const bar = "#".repeat(Math.min(data.count, barWidth));

			output += `  ${cmd.padEnd(maxCmdLen)} ${costStr} ${countStr} : ${bar}\n`;
		}
	}

	return output;
}

// TOKEN SUMMARY TABLE (per-model, deduped)
// Renders token counts for cross-referencing with Claude Code /usage.
// Wire via --tokens flag (CLI) or /wtft --tokens (Pi TUI).

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function shortenModel(model: string): string {
	// Strip "claude-" prefix and trim version suffix for display
	return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

/**
 * @param uncounted Billed-but-unrecorded events found in the session (#149).
 *   Omitted or all-zero renders nothing new — existing output is unchanged.
 */
export function renderTokenSummary(interactions: Interaction[], maxWidth: number = 80, thinkingBudget?: number, uncounted?: UncountedBillables): string {
	// Dedup before aggregating (caller may pass raw, we ensure consistent counts)
	const deduped = deduplicateInteractions(interactions);

	// Group by model
	type ModelAgg = {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		reasoningTokens: number;
		cost: number;
	};
	const byModel = new Map<string, ModelAgg>();
	let unmatched = 0;

	for (const i of deduped) {
		const model = i.model || "(unknown)";
		// Skip synthetic/system entries (no real tokens) and untagged entries
		if (model === "(unknown)" || model === "<synthetic>") {
			unmatched++;
			continue;
		}
		const agg = byModel.get(model) || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0 };
		agg.inputTokens += i.inputTokens;
		agg.outputTokens += i.outputTokens;
		agg.cacheReadTokens += i.cacheReadTokens;
		agg.cacheWriteTokens += i.cacheWriteTokens;
		agg.reasoningTokens += i.reasoningTokens;
		agg.cost += i.cost;
		byModel.set(model, agg);
	}

	if (byModel.size === 0) {
		return unmatched > 0
			? `No model-tagged interactions found (${unmatched} untagged).`
			: "No model-tagged interactions found.";
	}

	// Sort by cost descending
	const sorted = Array.from(byModel.entries())
		.sort((a, b) => b[1].cost - a[1].cost);

	// Column widths
	const modelColW = Math.max(10, ...sorted.map(([m]) => shortenModel(m).length));
	const numColW = 10; // fixed width for numbers

	const sep = "─".repeat(Math.min(maxWidth, modelColW + numColW * 5 + 24));

	let out = "";
	out += `\n── Token Summary (per model, deduped) ──${unmatched > 0 ? `  (${unmatched} untagged interactions skipped)` : ""}\n`;

	// Header
	out += [
		"Model".padEnd(modelColW),
		"Input".padStart(numColW),
		"Output".padStart(numColW),
		"Reasoning".padStart(numColW),
		"Cache-Read".padStart(numColW),
		"Cache-Write".padStart(numColW),
		"Cost".padStart(numColW)
	].join(" ") + "\n";

	// Rows — a "?" on the cost marks a model priced at fallback defaults
	// (no registry entry, no legacy branch): the figure is a guess (#140).
	let totalInput = 0, totalOutput = 0, totalCr = 0, totalCw = 0, totalReasoning = 0, totalCost = 0;
	let anyUnpriced = false;
	for (const [model, agg] of sorted) {
		const unpriced = !isModelPriced(model);
		if (unpriced) anyUnpriced = true;
		out += [
			shortenModel(model).padEnd(modelColW),
			formatTokenCount(agg.inputTokens).padStart(numColW),
			formatTokenCount(agg.outputTokens).padStart(numColW),
			formatTokenCount(agg.reasoningTokens).padStart(numColW),
			formatTokenCount(agg.cacheReadTokens).padStart(numColW),
			formatTokenCount(agg.cacheWriteTokens).padStart(numColW),
			(formatCost(agg.cost) + (unpriced ? "?" : "")).padStart(numColW)
		].join(" ") + "\n";
		// Cache hit rate detail line (#79)
		const cacheTotal = agg.cacheReadTokens + agg.cacheWriteTokens + agg.inputTokens;
		if (cacheTotal > 0) {
			const hitRate = ((agg.cacheReadTokens / cacheTotal) * 100).toFixed(0);
			out += `  Cache: ${hitRate}% hit (${formatTokenCount(agg.cacheReadTokens)} read / ${formatTokenCount(cacheTotal)} total ops)\n`;
		}
		// Thinking detail line (#79)
		if (agg.reasoningTokens > 0) {
			if (thinkingBudget && thinkingBudget > 0) {
				const utilized = ((agg.reasoningTokens / thinkingBudget) * 100).toFixed(0);
				out += `  Think: ${formatTokenCount(agg.reasoningTokens)} tokens (budget: ${formatTokenCount(thinkingBudget)} — ${utilized}% utilized)\n`;
			} else {
				out += `  Think: ${formatTokenCount(agg.reasoningTokens)} tokens\n`;
			}
		}
		totalInput += agg.inputTokens;
		totalOutput += agg.outputTokens;
		totalCr += agg.cacheReadTokens;
		totalCw += agg.cacheWriteTokens;
		totalReasoning += agg.reasoningTokens;
		totalCost += agg.cost;
	}

	// Total row
	out += sep + "\n";
	out += [
		"TOTAL".padEnd(modelColW),
		formatTokenCount(totalInput).padStart(numColW),
		formatTokenCount(totalOutput).padStart(numColW),
		formatTokenCount(totalReasoning).padStart(numColW),
		formatTokenCount(totalCr).padStart(numColW),
		formatTokenCount(totalCw).padStart(numColW),
		(formatCost(totalCost) + (anyUnpriced ? "?" : "")).padStart(numColW)
	].join(" ") + "\n";
	if (anyUnpriced) {
		out += `? = model not in pricing registry — priced at default $3/$15 rates; totals may be unreliable\n`;
	}

	// Compaction summary (#90) — show how many tokens were freed by compaction
	let totalCompacted = 0;
	let compactionCount = 0;
	for (const i of deduped) {
		if (i.compactionTokensBefore) {
			totalCompacted += i.compactionTokensBefore;
			compactionCount++;
		}
	}
	if (compactionCount > 0) {
		out += `\nCompaction: ${compactionCount} event(s), ${formatTokenCount(totalCompacted)} total tokens freed\n`;
	}

	// Uncounted billables (#149) — the blind spot, named. Deliberately below the
	// TOTAL row and deliberately without a dollar figure: TOTAL stays strictly
	// derived from recorded `usage`, and these events write none. Measured at
	// 4.72% of Claude Code's own counter across seven sessions, so leaving them
	// unmentioned misleads; estimating them would make TOTAL partly modelled.
	out += renderUncountedBillables(uncounted);

	return out;
}

/** The UNCOUNTED block, or "" when there is no blind spot to report. Split out
 *  so the daemon/watch paths can reuse the exact wording (#149). */
export function renderUncountedBillables(uncounted?: UncountedBillables): string {
	if (!uncounted) return "";
	const parts: string[] = [];
	if (uncounted.compaction > 0) parts.push(`${uncounted.compaction} compaction${uncounted.compaction === 1 ? "" : "s"}`);
	if (uncounted.recap > 0) parts.push(`${uncounted.recap} recap${uncounted.recap === 1 ? "" : "s"}`);
	if (parts.length === 0) return "";
	return `\nUNCOUNTED  ${parts.join(", ")} — billed by the harness; the transcript records\n` +
	       `           no usage for them, so they are NOT in TOTAL above (#149)\n`;
}

// WATCH MODE: tail -f style live re-rendering (#45)
// Watches a .jsonl session file for changes and re-renders in-place.

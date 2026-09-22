/** Bar chart rendering, histograms, token summaries, and terminal utilities. */

import type { Interaction, Category } from "./wtft-shared.js";
import type { UncountedBillables } from "./wtft-parser.ts";
import { isModelTagged } from "./wtft-parser.js";
import {
	classifyInteraction,
	normalizeCommand,
	deduplicateInteractions
} from "./wtft-shared.js";
import {
	isModelPriced,
	describeFallbackPricing,
	getDeepSeekPeakMultiplier,
	DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES,
} from "./wtft-cost.js";
import { execSync } from "node:child_process";
import wcwidth from "wcwidth";
import { treeTotals, type SpawnTree } from "./wtft-spawn-tree.js";
import type { UnrecordedSpawn } from "./wtft-unrecorded.js";
export interface Bin {
	key?: string;
	label: string;
	dateStr: string;
	costs: Record<Category, number>;
	total_cost: number;
	incremental_cost?: number;
	tokens?: Record<Category, { total: number; output: number }>;
	total_tokens?: number;
	incremental_tokens?: number;
	_incTokens?: Record<Category, { total: number }>;
	surgePriced?: boolean;
}

// ---
// CATEGORY ORDER + STYLE — single source of truth.
// Overhead-first: Ovrhd (recache) → Waste (interrupted) → workflow → Cmpct → Other.
// Legend, cost-mode stacking, bucket-mode markers, and token-mode segments
// all derive from this table, so bar order matches legend order by construction.
// ---

export const CATEGORY_ORDER: Category[] = [
	"overhead", "interrupted", "plan", "spec", "research", "web", "grep", "code", "tests", "git",
	"agents", "prompt", "compaction", "other",
];

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

const BLOCK_OLD = "▃" as const;   // cached carryover from past bins
const BLOCK_NEW = "▇" as const;
const BLOCK_BUCKET = "█" as const;

export function interactionTotalTokens(i: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }): number {
	return i.inputTokens + i.outputTokens + i.cacheReadTokens + i.cacheWriteTokens + i.reasoningTokens;
}

export function tokenFooterSummary(interactions: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }[]): string {
	let input = 0, output = 0, cr = 0, cw = 0, reasoning = 0;
	for (const i of interactions) {
		input += i.inputTokens + i.cacheReadTokens + i.cacheWriteTokens;
		output += i.outputTokens;
		cr += i.cacheReadTokens;
		cw += i.cacheWriteTokens;
		reasoning += i.reasoningTokens;
	}
	const totalCacheOps = cr + cw + input - cr - cw;
	const denom = (input - cr - cw) + cr + cw;
	const hitRate = denom > 0 ? ((cr / denom) * 100).toFixed(0) : "0";
	const parts: string[] = [];
	if (input > 0) parts.push(`↑${formatTokenCount(input)}`);
	if (output > 0) parts.push(`↓${formatTokenCount(output)}`);
	if (reasoning > 0) parts.push(`R${formatTokenCount(reasoning)}`);
	if (cr > 0 || cw > 0) parts.push(`CH${hitRate}%`);
	return parts.join(" ");
}

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
 * Unparseable input does not throw: it falls back to `1h`, because an interval
 * typo should degrade to the default chart rather than kill the widget mid-render.
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
// HALF-BLOCK RENDERING: double resolution inside each terminal cell.
// Each cell encodes 2 half-slots via a single glyph:
//   █ (full block) when both half-slots are the same category (FG only)
//   ▌ (left half block) when they differ (FG=left category, BG=right category)
// ---

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
	const tickValues = [0, maxCost / 4, maxCost / 2, (maxCost * 3) / 4, maxCost];

	for (let i = 0; i < ticks.length; i++) {
		const text = formatCost(tickValues[i]);
		const displayStr = ` ${text} `;
		
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
			labels.push({
				text: displayStr,
				start: startIdx,
				end: endIdx
			});
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

export function padString(str: string, len: number): string {
	return str.length >= len ? str : str + " ".repeat(len - str.length);
}

export function formatCost(cost: number): string {
	// Adaptive precision: 4 decimal places for sub-cent values, 2 otherwise
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
 * wcwidth reports the "ambiguous"-width emoji in
 * U+2600–U+27BF (☀️ U+2600, ⚡ U+26A1, ⚠️ U+26A0, ✅ U+2705, ❌ U+274C) as one
 * column, but every modern terminal renders them as two. Measuring them at 1
 * made the SURGE timeline a column short at noon — right where the current-hour
 * clock sits after the sun.
 */
export function getVisualLength(str: string): number {
	const clean = str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	let width = 0;
	for (const ch of clean) {
		const cp = ch.codePointAt(0)!;
		// Variation selectors are zero-width.
		if (cp === 0xfe0f || cp === 0xfe0e) continue;
		const w = cp >= 0x2600 && cp <= 0x27bf ? 2 : wcwidth(ch);
		// wcwidth returns -1 for control bytes and 0 for combining marks
		if (w > 0) width += w;
	}
	return width;
}

/**
 * Fit `str` into exactly `width` terminal COLUMNS: truncate with an ellipsis if
 * it is too wide, pad with spaces if it is too narrow.
 * Why this is not `slice` + `padEnd`: both of those count UTF-16 CODE UNITS.
 * A BMP wide character — CJK, Hangul, the fullwidth forms — is ONE code unit
 * and TWO columns, so 40 of them slip past a `length > 40` guard untouched and
 * `padEnd(40)` adds nothing, while the terminal lays out 80 columns and every
 * figure to the right shifts.
 */
export function fitVisual(str: string, width: number): string {
	if (width <= 0) return "";
	const full = getVisualLength(str);
	if (full <= width) return str + " ".repeat(width - full);

	let out = "";
	let used = 0;
	for (const ch of str) {
		const w = getVisualLength(ch);
		if (used + w > width - 1) break;
		out += ch;
		used += w;
	}
	out += "\u2026";
	used += 1;
	// A wide character that could not fit leaves a one-column gap; pad it, so
	// the field is exactly `width` whatever the text was.
	return out + " ".repeat(width - used);
}


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
	// Pi's setWidget() does not enforce its own padding on raw line arrays,
	// so we only need 2 chars total.
	return isWidget ? width - 2 : width;
}

// SURGE TIMELINE: 24-hour bar showing normal (green) vs surge (orange) pricing

export function getCurrentLocalHour(tz?: string): number {
	const parts = getZonedParts(Date.now(), tz);
	return parts.hour;
}

export function getTimezoneOffsetMs(timestamp: number, tz: string): number {
	const parts = getZonedParts(timestamp, tz);
	const utcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
	return utcMs - timestamp;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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
 * The schedule is NOT re-typed here. This asks `getDeepSeekPeakMultiplier`
 * what each hour actually costs, so the display cannot disagree with the bill.
 * Per-hour offset, not per-day: on a day the zone's offset changes, a single
 * offset applied to all 24 local hours puts far-side hours an hour off. Each
 * candidate hour resolves its own offset via {@link resolveZonedLocalHour}.
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
 * Windows come from `DEEPSEEK_PEAK_WINDOWS_UTC_MINUTES` rather than a
 * hardcoded copy; a day that is entirely off-peak reports no proximity.
 */
export function checkSurgeProximity(at: number = Date.now()): { status: 'surge' | 'approaching' | 'ending' | undefined; multiplier: number } {
	const now = new Date(at);
	const currentUtcMinute = now.getUTCHours() * 60 + now.getUTCMinutes();

	// Weekends are off-peak end to end, so "approaching" a window that will
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
 * The bookends are the only glyphs guaranteed present at every hour, so they —
 * not the clock face — are what callers and tests should key off to identify
 * the timeline.
 */
export function buildTimelineString(
	surgeHours: Set<number>,
	currentHour: number,
	proximityStatus?: 'surge' | 'approaching' | 'ending',
	date?: Date,
	disabledEmoji?: boolean
): string {
	const segments: { color: string; text: string }[] = [];
	let lastColor: string | null = null;

	const CLOCK_FACES = ["🕛","🕐","🕑","🕒","🕓","🕔","🕕","🕖","🕗","🕘","🕙","🕚"];

	const glyphs: { color: string; char: string }[] = [];
	for (let h = 0; h < 24; h++) {
		const isSurge = surgeHours.has(h);
		const isCurrent = h === currentHour;

		const color = isCurrent ? "1;" + (isSurge ? "38;5;208" : "32") : (isSurge ? "38;5;208" : "32");
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
		model?: string;
		unit?: "cost" | "tokens";
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

	interactions = deduplicateInteractions(interactions);

	const binMap = new Map<string, Bin>();
	let totalSessionCost = 0;
	let turnIndex = 0;

	const cacheMissBins = new Set<string>();

	const ALL_CATEGORIES = CATEGORY_ORDER;

	for (const interaction of interactions) {
		turnIndex++;
		const classification = classifyInteraction(interaction);
		const { key, label, dateStr } = getBinInfo(interaction.timestamp, intervalConfig, turnIndex, tz);
		totalSessionCost += interaction.cost;

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

		if (intervalConfig.type === "turns") {
			bin.label = `${turnIndex}t`;
			bin.dateStr = dateStr;
		}

		bin.costs[classification] += interaction.cost;
		bin.total_cost += interaction.cost;

		if (interaction.surgePriced) bin.surgePriced = true;

		if (interaction.serverToolCost) {
			bin.costs["web"] += interaction.serverToolCost;
			bin.total_cost += interaction.serverToolCost;
			totalSessionCost += interaction.serverToolCost;
		}

		if (unit === "tokens") {
			accumulateTokens(bin, classification, interaction);
		}
	}

	const sortedBins = Array.from(binMap.entries())
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(entry => entry[1]);

	if (mode === "cumulative") {
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
			bin.incremental_cost = bin.total_cost;
			running_total += bin.total_cost;

			for (const cat of Object.keys(bin.costs) as Category[]) {
				runningCosts[cat] += bin.costs[cat];
				bin.costs[cat] = runningCosts[cat];
			}
			bin.total_cost = running_total;

			if (unit === "tokens" && bin.tokens && bin.total_tokens != null) {
				bin.incremental_tokens = bin.total_tokens;
			}
		}

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

	const totalSessionTokens = unit === "tokens"
		? interactions.reduce((sum, i) => sum + interactionTotalTokens(i), 0)
		: 0;

	const reversedBins = sortedBins.reverse();
	const displayedBins = reversedBins.slice(0, limit);

	if (displayedBins.length === 0) {
		return null;
	}

	const maxBarValue = mode === "cumulative"
		? (unit === "tokens" ? totalSessionTokens : totalSessionCost)
		: Math.max(...displayedBins.map(b => unit === "tokens" ? (b.total_tokens ?? 0) : b.total_cost), 0);
	const scaleMax = unit === "tokens"
		? Math.ceil(maxBarValue / 1000) * 1000
		: calculateScaleMax(maxBarValue);

	const formatScaleLabel = (v: number): string => {
		if (unit === "tokens") return formatTokenCount(v);
		return formatCost(v);
	};

	const labelWidth = Math.max(...displayedBins.map(b => b.label.length), 5);
	let prefixWidth = labelWidth + 2;
	
	let maxIncLen = 6;
	let maxCostLen = 6;

	if (unit === "tokens") {
		if (mode === "cumulative") {
			maxIncLen = Math.max(...displayedBins.map(bin => {
				const incSign = (bin.incremental_tokens ?? 0) >= 0 ? "+" : "";
				return `${incSign}${formatTokenCount(bin.incremental_tokens ?? 0)}`.length;
			}), 6);
			maxCostLen = Math.max(...displayedBins.map(b => formatTokenCount(b.total_tokens ?? 0).length), 6);
			prefixWidth += maxIncLen + 2 + maxCostLen + 2 + 4;
		} else {
			maxCostLen = Math.max(...displayedBins.map(b => formatTokenCount(b.total_tokens ?? 0).length), 6);
			prefixWidth += maxCostLen + 2 + 4;
		}
	} else if (mode === "cumulative") {
		maxIncLen = Math.max(...displayedBins.map(bin => {
			const incSign = (bin.incremental_cost ?? 0) >= 0 ? "+" : "";
			return `${incSign}${formatCost(bin.incremental_cost ?? 0)}`.length;
		}), 6);
		maxCostLen = Math.max(...displayedBins.map(b => formatCost(b.total_cost).length), 6);
		prefixWidth += maxIncLen + 2 + maxCostLen + 2;
	} else {
		maxCostLen = Math.max(...displayedBins.map(b => formatCost(b.total_cost).length), 6);
		prefixWidth += maxCostLen + 2;
	}

	const finalWidth = Math.max(width, 40);
	
	const tickReserve = unit === "tokens" ? 5 : 3;
	const maxBarWidth = finalWidth - prefixWidth - tickReserve;

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
	
	const sessionSuffix = opts?.sessionNameSuffix ? ` \x1b[90m...${opts.sessionNameSuffix.replace(/.jsonl$/, "").slice(-4)}\x1b[0m` : "";
	const titleLeftFinal = titleLeft + sessionSuffix;
	
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
	

	// Putting the legend on its own row avoids layout flip-flop when the
	// SURGE proximity badge appears/disappears (shifts timelineLen,
	// potentially crossing an inline-fit threshold).
	widgetLines.push(titleLeftFinal + "  " + timelineStr);
	widgetLines.push(legendStr);

	if (showTicks && scaleMax > 0) {
		const dateLabel = `── ${titleDateStr} `;
		const paddingLen = Math.max(0, prefixWidth - dateLabel.length);
		const labelPrefix = dateLabel + "─".repeat(paddingLen);
		const ticksLine = unit === "tokens"
			? buildTokenTickLine(scaleMax, maxBarWidth, prefixWidth, labelPrefix)
			: buildTickLine(scaleMax, maxBarWidth, prefixWidth, labelPrefix);
		if (ticksLine) {
			widgetLines.push(`\x1b[90m${ticksLine}\x1b[0m`);
		}
	}

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
								// When clampedTotal < halfSlotWidth, excess is negative and
				// halfSlotWidth - excess overshoots — remainder loop would skip.
				allocated = 0;
				for (const cat of CATEGORY_ORDER) allocated += slots[cat];
			}

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

	for (let i = 0; i < displayedBins.length; i++) {
		const bin = displayedBins[i];

		if (showTicks && i > 0 && bin.dateStr !== displayedBins[i - 1].dateStr) {
			widgetLines.push(`\x1b[90m${buildDividerLine(formatMmmDdStr(bin.dateStr))}\x1b[0m`);
		}

		// Labelled "Miss" not "Expired": the usage block proves the re-prime happened,
		// but says nothing about why, and TTL is only one of the causes.
		if (bin.key && cacheMissBins.has(bin.key)) {
			widgetLines.push(`\x1b[90m${buildDividerLine("Cache Miss")}\x1b[0m`);
		}

		const labelPart = padString(bin.label, labelWidth);

		const surgeActive = bin.surgePriced === true;
		const surgeLabel = surgeActive ? "\x1b[1;38;5;208m" : "\x1b[90m";
		const surgeInc = surgeActive ? "\x1b[1;38;5;208m" : "\x1b[90m";
		const costColor = surgeActive ? "\x1b[1;38;5;208m" : "\x1b[1;37m";
		const coloredLabel = `${surgeLabel}${labelPart}\x1b[0m`;
		// ⚡ is double-width — it fills the 2-char column gap on its own, numbers stay aligned.
		const boltGap = surgeActive ? "\x1b[1;38;5;208m\u26A1\x1b[0m" : "  ";

		if (unit === "tokens" && bin.tokens) {
			const barMax = Math.max(0, maxBarWidth - 2);
			const barWidth = scaleMax > 0 && barMax > 0 ? Math.round(((bin.total_tokens ?? 0) / scaleMax) * barMax) : 0;
			let barStr = "";
			let allChars: number = 0;
			for (const cat of ALL_CATEGORIES) {
				const t = bin.tokens[cat];
				if (!t || t.total <= 0) continue;
				const segWidth = scaleMax > 0 && barMax > 0 ? Math.round(((bin.total_tokens ?? 0) / scaleMax) * barMax * (t.total / (bin.total_tokens || 1))) : 0;
				const segChars = Math.max(0, Math.min(segWidth, barMax - allChars));
				if (segChars <= 0) continue;
				const fg = CATEGORY_STYLE[cat]?.fg ?? 245;

				if (mode === "cumulative") {
					const incTokens = bin._incTokens?.[cat]?.total ?? 0;
					const catIncRatio = t.total > 0 ? incTokens / t.total : 0;
					const rawNew = segChars * catIncRatio;
					const newChars = rawNew > 0 ? Math.max(1, Math.round(rawNew)) : 0;
					const oldChars = segChars - newChars;

					if (oldChars > 0) barStr += `\x1b[38;5;${fg}m${BLOCK_OLD.repeat(oldChars)}\x1b[0m`;
					if (newChars > 0) barStr += `\x1b[38;5;${fg}m${BLOCK_NEW.repeat(newChars)}\x1b[0m`;
				} else {
					barStr += `\x1b[38;5;${fg}m${BLOCK_BUCKET.repeat(segChars)}\x1b[0m`;
				}
				allChars += segChars;
			}

			const hasServerToolCost = (bin.costs["web"] || 0) > 0 && (bin.tokens["web"]?.total ?? 0) === 0;
			if (hasServerToolCost && allChars < barMax) {
				barStr += `\x1b[38;5;209m$\x1b[0m`;
				allChars++;
			}

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
			let barStr = "";
			if (mode === "cumulative") {
				const halfSlotCounts = precomputedHalfSlots.get(bin)!;
				const halfSlots = halfSlotCountsToArray(halfSlotCounts);
				barStr = renderHalfBlockBar(halfSlots, CATEGORY_STYLE);
			} else {
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
				for (let pos = 0; pos < maxBarWidth; pos++) {
					const entries = buckets.get(pos);
					if (!entries || entries.length === 0) {
						barStr += " ";
					} else if (entries.length === 1) {
						const fg = CATEGORY_STYLE[entries[0].cat].fg;
						barStr += `\x1b[38;5;${fg}m█\x1b[0m`;
					} else {
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

	if (unit === "tokens") {
		widgetLines.push(`\x1b[90m  \x1b[37m▃\x1b[0m\x1b[90m cached/carryover  \x1b[37m▇\x1b[0m\x1b[90m new/uncached  \x1b[90m\$ = cost-only (web tools)\x1b[0m`);
		const summary = tokenFooterSummary(interactions);
		if (summary) {
			widgetLines.push(`\x1b[37m  ${summary}\x1b[0m`);
		}
		const cacheMetrics = computeCacheMetrics(interactions);
		if (cacheMetrics) {
			widgetLines.push(`\x1b[90m  CH: ${cacheMetrics.hitRate}% cache hit (${cacheMetrics.readTokens} read / ${cacheMetrics.totalOps} total ops)\x1b[0m`);
		}
	}

	if (unit === "cost") {
		const cacheMetrics = computeCacheMetrics(interactions);
		if (cacheMetrics) {
			widgetLines.push(`\x1b[90m  CH: ${cacheMetrics.hitRate}% cache hit (${cacheMetrics.readTokens} read / ${cacheMetrics.totalOps} total ops)\x1b[0m`);
		}
	}

	return widgetLines;
}


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
		commands: new Set(["sqlite3", "psql", "mysql", "docker", "kubectl", "aws", "terraform", "fly", "railway", "mongo", "redis-cli", "pg_dump", "pg_restore"])
	},
	text: {
		label: "Text & File Processing",
		commands: new Set(["sed", "awk", "cut", "tr", "sort", "uniq", "paste", "join", "comm", "diff", "patch", "jq", "yq", "xmllint", "column", "fold", "rev", "strings", "od", "xxd", "iconv", "base64"])
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
		commands: new Set(["pi", "claude", "herdr", "ax", "clear", "exit", "source", ".", "alias", "unalias", "tmux", "screen"])
	}
};

export const PARSE_MISS_GROUP = "Parse miss";

export const PARSE_MISS_MARKER = "##PARSE-MISS##";

export const PARSE_MISS_PREFIX = "\u0000miss\u0000";

const MAX_TOKEN_LEN = 48;

/**
 * Tokens are attacker-influenced: they come from commands an agent was induced
 * to run. Control characters are stripped and length is capped before anything
 * reaches the screen.
 */
export function sanitizeCommandToken(token: string): string {
	const clean = token.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
	return clean.length > MAX_TOKEN_LEN ? `${clean.slice(0, MAX_TOKEN_LEN - 1)}\u2026` : clean;
}

/**
 * A trailing ellipsis is DISPLAY truncation added by sanitizeCommandToken,
 * not evidence about the token. The caller judges the original; this tolerates
 * the trimmed form for anyone who does not.
 */
export function isPlausibleCommandToken(token: string): boolean {
	if (!token) return false;
	const bare = token.endsWith("…") ? token.slice(0, -1) : token;
	if (!bare) return false;
	return /^[A-Za-z0-9_.~@/][A-Za-z0-9_.~@/+-]*$/.test(bare);
}

export function getSemanticCommandGroup(command: string): string | null {
	if (command.startsWith(PARSE_MISS_PREFIX)) return PARSE_MISS_GROUP;
	// Judge the EXECUTABLE token, not the whole command line.
	if (!isPlausibleCommandToken(command.split(/\s/)[0]!)) return PARSE_MISS_GROUP;
	const base = command.split("/").pop() || command;
	for (const [key, group] of Object.entries(SEMANTIC_GROUPS)) {
		if (group.commands.has(base)) return group.label;
	}
	if (base === "git" || command.startsWith("git ")) return SEMANTIC_GROUPS.git.label;
	if (command.startsWith("npm ")) return SEMANTIC_GROUPS.build.label;
	if (command.startsWith("yarn ") || command.startsWith("pnpm ") || command.startsWith("bun ")) return SEMANTIC_GROUPS.build.label;
	if (command.startsWith("go ")) return SEMANTIC_GROUPS.build.label;
	if (command.startsWith("cargo ")) return SEMANTIC_GROUPS.build.label;
	if (command.startsWith("pip ") || command.startsWith("pip3 ")) return SEMANTIC_GROUPS.deps.label;
	return null;
}

export function renderOtherHistogram(interactions: Interaction[], maxWidth: number = 80): string {
	const commandMap = new Map<string, { count: number; cost: number }>();

	for (const interaction of interactions) {
		const classification = classifyInteraction(interaction);
		if (classification === "other") {
			const primaryCommands: string[] = [];
			for (const rawCmd of interaction.commands) {
				const normalized = normalizeCommand(rawCmd);
				if (!normalized) continue;
				const primary = normalized.split(/\s/)[0];
				if (primary) {
					const display = sanitizeCommandToken(primary);
					primaryCommands.push(isPlausibleCommandToken(primary) ? display : `${PARSE_MISS_PREFIX}${display}`);
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

	const groupOrder = [
		"Build & Bundling",
		"Dependency Management",
		"Linting & Formatting",
		"Testing",
		"Database & Infrastructure",
		"Text & File Processing",
		"System & File Utilities",
		"Git Operations",
		"Session & Agent",
		PARSE_MISS_GROUP,
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

	let maxCmdLen = 0;
	for (const cmd of commandMap.keys())
		maxCmdLen = Math.max(maxCmdLen, (cmd.startsWith(PARSE_MISS_PREFIX) ? cmd.slice(PARSE_MISS_PREFIX.length) : cmd).length);

	const countWidth = 7;
	const costWidth = 10;

	for (const [groupName, group] of sortedGroups) {
		const groupCostStr = `$${group.cost.toFixed(4)}`;
		const isMiss = groupName === PARSE_MISS_GROUP;
		output += `\n[${groupName}]  (${group.count} calls, ${groupCostStr})\n`;
		if (isMiss) {
			output += `  these tokens are normalizer residue, not commands wtft saw run\n`;
		}

		const sortedCmds = Array.from(group.commands.entries()).sort((a, b) => b[1].count - a[1].count);

		for (const [cmd, data] of sortedCmds) {
			const countStr = `(${data.count})`.padStart(countWidth);
			const costStr = `$${data.cost.toFixed(4)}`.padStart(costWidth);

			const barWidth = Math.max(5, maxWidth - maxCmdLen - countWidth - costWidth - 10);
			const bar = "#".repeat(Math.min(data.count, barWidth));

			// A parse miss carries a stable marker so misses are countable across
			// sessions by a machine, not only visible to a human. The marker is
			// the contract; the prose above is not.
			const shown = cmd.startsWith(PARSE_MISS_PREFIX) ? cmd.slice(PARSE_MISS_PREFIX.length) : cmd;
			const label = isMiss ? `${PARSE_MISS_MARKER} ${shown}` : shown.padEnd(maxCmdLen);
			output += `  ${label} ${costStr} ${countStr} : ${bar}\n`;
		}
	}

	return output;
}


function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function shortenModel(model: string): string {
	return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// ---
// SESSION SUMMARY — the single aggregation both readers consume.
//
// `renderTokenSummary` formats this for a human; `buildSessionJson`
// (wtft-json.ts) serialises the same object for a machine. Neither does the
// arithmetic itself, which is the whole reason the rendered table and
// `wtft --json` cannot report different numbers. See docs/spec-26-json.md.
// ---

/** Exact token and cost totals. Never abbreviated, never rounded. */
export interface TokenTotals {
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export interface ModelTotals extends TokenTotals {
	model: string;
	priced: boolean;
}

export interface CategoryTotals extends TokenTotals {
	category: Category;
}

export interface SessionTotal extends TokenTotals {
	/** The cost EXCLUDED from `costUsd` above because it belongs to an
	 *  untagged interaction (`untaggedInteractions`) — the same per-interaction
	 *  figures the bar chart bins for those turns: `i.cost` (the tag file's
	 *  `c`) plus `i.serverToolCost` when present. So
	 *  `costUsd + untaggedCostUsd` equals the chart's own running
	 *  total within float accumulation error (docs/spec-26-json.md). */
	untaggedCostUsd: number;
}

export interface SessionSummary {
	total: SessionTotal;
	models: ModelTotals[];
	categories: CategoryTotals[];
	/** Interactions excluded from every total above because they carry no model
	 *  id (`(unknown)` or `<synthetic>`) — the table's "(N untagged … skipped)". */
	untaggedInteractions: number;
	compaction: { events: number; tokensFreed: number };
}

export function emptyTotals(): TokenTotals {
	return { costUsd: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function addInteraction(into: TokenTotals, i: Interaction): void {
	into.costUsd += i.cost;
	into.inputTokens += i.inputTokens;
	into.outputTokens += i.outputTokens;
	into.reasoningTokens += i.reasoningTokens;
	into.cacheReadTokens += i.cacheReadTokens;
	into.cacheWriteTokens += i.cacheWriteTokens;
}

/**
 * Aggregate a session once, for both readers.
 *
 * Dedups first — a caller may pass raw interactions, and Claude Code emits
 * several JSONL lines per API response echoing the same message-level `usage`.
 *
 * Model-tagged only, in EVERY total including the per-category rows: an
 * interaction with no model id is counted in `untaggedInteractions` and appears
 * nowhere else. That is what makes `sum(models) === sum(categories) === total`
 * hold.
 *
 * SERVER-SIDE TOOL SPEND IS IN THESE TOTALS.
 *
 * It is attributed the way the chart attributes it — to `web`, not to the
 * requesting turn's own category — so `sum(categories) === total` still holds
 * and a category row names the same category the bars do.
 * Per model it goes to the model that made the request, which is the only model
 * that could have.
 * WHAT THIS FUNCTION COUNTS IS ONE SESSION'S OWN TURNS — "self". A
 * launcher-spawned descendant is a different session with a different
 * transcript, and nothing here reaches it; `computeSpawnTree` calls this
 * function once per descendant and the caller adds the two. So a caller after
 * "what did this branch of work cost" wants `tree`, not this.
 */
export function computeSessionSummary(interactions: Interaction[]): SessionSummary {
	const deduped = deduplicateInteractions(interactions);

	const total = emptyTotals();
	const byModel = new Map<string, TokenTotals>();
	const byCategory = new Map<Category, TokenTotals>();
	for (const c of CATEGORY_ORDER) byCategory.set(c, emptyTotals());
	let untaggedInteractions = 0;
	let untaggedCostUsd = 0;
	let compactionEvents = 0;
	let compactionTokensFreed = 0;

	for (const i of deduped) {
		// Compaction is counted over EVERY interaction, tagged or not: it
		// describes context freed, not spend, so the model-tag exclusion below
		// has nothing to do with it.
		if (i.compactionTokensBefore) {
			compactionTokensFreed += i.compactionTokensBefore;
			compactionEvents++;
		}

		const model = i.model || "(unknown)";
		if (!isModelTagged(i)) {
			untaggedInteractions++;
			untaggedCostUsd += i.cost + (i.serverToolCost || 0);
			continue;
		}

		addInteraction(total, i);

		let m = byModel.get(model);
		if (!m) { m = emptyTotals(); byModel.set(model, m); }
		addInteraction(m, i);

		// `classifyInteraction` returns the stored `_cat` for a tag-file read and
		// re-derives it otherwise — the same call the bar chart makes.
		// `_cat` reaches that call UNVALIDATED (`readClassifiedTagFile` does
		// `_cat: obj.cat || undefined`), so a tag written by a future tagger — or
		// a hand-edited one — can name a category this build has never heard of.
		// Such a row is folded into `other`, the vocabulary's own catch-all,
		// rather than given a row of its own.
		const cat = classifyInteraction(i);
		const c = byCategory.get(cat) ?? byCategory.get("other")!;
		addInteraction(c, i);

		// Server-side tool requests are billed PER REQUEST, on a meter with no
		// tokens on it, so this is a cost-only addition — adding it inside
		// `addInteraction` would have been wrong for exactly one field and right
		// for none of the others. `web` rather than `cat` because that is where
		// the bar chart puts it.
		// Assumption: `i.cost` does not already contain this charge. It is a sum,
		// not a replacement, so a harness whose native per-turn cost is its BILLED
		// figure — which could include web-search spend — would be double-counted.
		if (i.serverToolCost) {
			total.costUsd += i.serverToolCost;
			m.costUsd += i.serverToolCost;
			byCategory.get("web")!.costUsd += i.serverToolCost;
		}
	}

	const models: ModelTotals[] = Array.from(byModel.entries())
		.sort((a, b) => b[1].costUsd - a[1].costUsd)
		.map(([model, t]) => ({ model, priced: isModelPriced(model), ...t }));

	const categories: CategoryTotals[] = CATEGORY_ORDER
		.map(category => ({ category, ...(byCategory.get(category) ?? emptyTotals()) }));

	return {
		total: { ...total, untaggedCostUsd },
		models,
		categories,
		untaggedInteractions,
		compaction: { events: compactionEvents, tokensFreed: compactionTokensFreed },
	};
}

export function renderTokenSummary(interactions: Interaction[], maxWidth: number = 80, thinkingBudget?: number, uncounted?: UncountedBillables, spawned?: SpawnTree): string {
	const summary = computeSessionSummary(interactions);
	const unmatched = summary.untaggedInteractions;

	if (summary.models.length === 0) {
		const head = unmatched > 0
			? `No model-tagged interactions found (${unmatched} untagged).`
			: "No model-tagged interactions found.";
		return head + renderUncountedBillables(uncounted) + renderSpawnTree(summary.total, spawned);
	}

	const modelColW = Math.max(10, ...summary.models.map(m => shortenModel(m.model).length));
	const numColW = 10;

	const sep = "─".repeat(Math.min(maxWidth, modelColW + numColW * 5 + 24));

	let out = "";
	out += `\n── Token Summary (per model, deduped) ──${unmatched > 0 ? `  (${unmatched} untagged interactions skipped)` : ""}\n`;

	out += [
		"Model".padEnd(modelColW),
		"Input".padStart(numColW),
		"Output".padStart(numColW),
		"Reasoning".padStart(numColW),
		"Cache-Read".padStart(numColW),
		"Cache-Write".padStart(numColW),
		"Cost".padStart(numColW)
	].join(" ") + "\n";

	let anyUnpriced = false;
	for (const agg of summary.models) {
		if (!agg.priced) anyUnpriced = true;
		out += [
			shortenModel(agg.model).padEnd(modelColW),
			formatTokenCount(agg.inputTokens).padStart(numColW),
			formatTokenCount(agg.outputTokens).padStart(numColW),
			formatTokenCount(agg.reasoningTokens).padStart(numColW),
			formatTokenCount(agg.cacheReadTokens).padStart(numColW),
			formatTokenCount(agg.cacheWriteTokens).padStart(numColW),
			(formatCost(agg.costUsd) + (agg.priced ? "" : "?")).padStart(numColW)
		].join(" ") + "\n";
		const cacheTotal = agg.cacheReadTokens + agg.cacheWriteTokens + agg.inputTokens;
		if (cacheTotal > 0) {
			const hitRate = ((agg.cacheReadTokens / cacheTotal) * 100).toFixed(0);
			out += `  Cache: ${hitRate}% hit (${formatTokenCount(agg.cacheReadTokens)} read / ${formatTokenCount(cacheTotal)} total ops)\n`;
		}
		if (agg.reasoningTokens > 0) {
			if (thinkingBudget && thinkingBudget > 0) {
				const utilized = ((agg.reasoningTokens / thinkingBudget) * 100).toFixed(0);
				out += `  Think: ${formatTokenCount(agg.reasoningTokens)} tokens (budget: ${formatTokenCount(thinkingBudget)} — ${utilized}% utilized)\n`;
			} else {
				out += `  Think: ${formatTokenCount(agg.reasoningTokens)} tokens\n`;
			}
		}
	}

	out += sep + "\n";
	out += [
		"TOTAL".padEnd(modelColW),
		formatTokenCount(summary.total.inputTokens).padStart(numColW),
		formatTokenCount(summary.total.outputTokens).padStart(numColW),
		formatTokenCount(summary.total.reasoningTokens).padStart(numColW),
		formatTokenCount(summary.total.cacheReadTokens).padStart(numColW),
		formatTokenCount(summary.total.cacheWriteTokens).padStart(numColW),
		(formatCost(summary.total.costUsd) + (anyUnpriced ? "?" : "")).padStart(numColW)
	].join(" ") + "\n";
	if (anyUnpriced) {
		out += `? = model not in pricing registry — where wtft priced the turn:\n`;
		for (const m of summary.models) {
			if (!m.priced) {
				out += `    ${shortenModel(m.model)} — ${describeFallbackPricing(m.model)}\n`;
			}
		}
		out += `  A harness-native per-turn cost is used unchanged where the transcript has one; totals may be unreliable\n`;
	}

	if (summary.compaction.events > 0) {
		out += `\nCompaction: ${summary.compaction.events} event(s), ${formatTokenCount(summary.compaction.tokensFreed)} total tokens freed\n`;
	}

	out += renderUncountedBillables(uncounted);

	out += renderSpawnTree(summary.total, spawned);

	return out;
}

export function renderSpawnTree(self: TokenTotals, spawned?: SpawnTree): string {
	if (!spawned) return "";
	return renderRecordedSpawns(self, spawned) + renderUnrecordedSpawns(spawned.unrecorded);
}

/** Every untrusted string on this surface goes through one sanitiser. A
 *  newline forges report lines and an ESC starts an OSC sequence. U+FFFD
 *  rather than deletion, so a reader sees something was removed. */
const safeSpawnText = (v: string) => v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "\uFFFD");

/** The #128 list. Printed after SPAWNED, and on its own when nothing was
 *  recorded: its rows are the ones the ledger does not know. A `named` row is
 *  printed on its own; `inferred` rows collapse to one line per basis, because
 *  a busy host puts every peer's programmatic child in the window. */
function renderUnrecordedSpawns(rows: UnrecordedSpawn[] | undefined): string {
	if (!rows || rows.length === 0) return "";
	const line = (tier: string, name: string, money: string) =>
		`           ${tier.padEnd(9)} ${fitVisual(safeSpawnText(name), 30)} ${money.padStart(12)}\n`;
	let out = `\nUNRECORDED ${rows.length} session(s) no spawn record names (#128) —\n`;
	out += `           NOT in TOTAL or TREE: a list, not a claim; every row is in --json\n`;
	for (const row of rows.filter(r => r.tier === "named")) {
		out += line("named", row.cwd, row.total ? formatCost(row.total.costUsd) : `(${row.skip ?? "unreadable"})`);
	}
	const where: Record<string, string> = { worktree: "in this repo's worktrees", tmp: "in temp sandboxes" };
	for (const basis of ["worktree", "tmp"] as const) {
		const group = rows.filter(r => r.tier === "inferred" && r.basis === basis);
		if (group.length === 0) continue;
		const unreadable = group.filter(r => !r.total).length;
		const cost = group.reduce((sum, r) => sum + (r.total?.costUsd ?? 0), 0);
		const name = `${group.length} ${where[basis]}` + (unreadable > 0 ? `, ${unreadable} unreadable` : "");
		out += line("inferred", name, formatCost(cost));
	}
	return out;
}

function renderRecordedSpawns(self: TokenTotals, spawned: SpawnTree): string {
	// Every untrusted string on this surface goes through one sanitiser, declared
	// before the first arm that prints one. `mechanism`, `label`, and `ledgerError`
	// are untrusted: a newline forges report lines and an ESC starts an OSC
	// sequence. U+FFFD rather than deletion, so a reader sees something was
	// removed; a silently shortened path reads as the real one.
	const safe = (v: string) => v.replace(/[\u0000-\u001f\u007f-\u009f]/g, "\uFFFD");
	if (spawned.ledgerError !== null) {
		// Loud, and NOT an empty block: an unreadable ledger must not render the
		// same silence as a session that spawned nothing.
		return `\nSPAWNED    spawn ledger could not be read (#116) — descendants unknown, not zero\n` +
		       `           ${safe(String(spawned.ledgerError))}\n`;
	}
	if (spawned.edges.length === 0) {
		// No edges FOR THIS SESSION. Say nothing — unless the reader needs to
		// know the ledger itself is damaged, which is a fact about the ledger
		// rather than about this session and is otherwise reported nowhere on
		// this surface.
		if (spawned.malformedLedgerLines > 0) {
			return `\nSPAWNED    no descendants recorded for this session, but ` +
			       `${spawned.malformedLedgerLines} unusable spawn-ledger line(s) were skipped (#116)\n`;
		}
		return "";
	}

const rows: string[] = [];
	for (const edge of spawned.edges) {
		const full = edge.label ? `${safe(edge.mechanism)}  ${safe(edge.label)}` : safe(edge.mechanism);
		// Fitted to 40 COLUMNS, not 40 code units.
		const name = fitVisual(full, 40);
		// A skipped edge prints its REASON where its cost would be. A dash or a
		// $0.00 would both read as "this child was free", which is the one thing
		// we do not know about it.
		const money = edge.total ? formatCost(edge.total.costUsd) : `(${edge.skip})`;
		rows.push(`           ${name} ${money.padStart(12)}`);
	}

	// Two different units, named as such. `descendants` counts SESSIONS priced;
	// `edges.length` counts EDGES, and every skipped edge adds one without adding
	// a session.
	let out = `\nSPAWNED    ${spawned.descendants} session(s) priced from ${spawned.edges.length} recorded edge(s) (#116) —\n`;
	out += `           NOT in TOTAL above, which is this session's own turns\n`;
	out += rows.join("\n") + "\n";
	if (spawned.unattributed.length > 0) {
		out += `           ${spawned.unattributed.length} unattributed — cost unknown, deliberately not estimated\n`;
	}
	if (spawned.depthCapped > 0) {
		out += `           ${spawned.depthCapped} edge(s) past the depth cap of ${spawned.maxDepth}, not walked\n`;
	}
	if (spawned.malformedLedgerLines > 0) {
		out += `           ${spawned.malformedLedgerLines} unusable ledger line(s) skipped\n`;
	}
	// The SPAWNED subtotal is printed, because TREE names it as an addend and a
	// reader should not have to sum the rows to check the arithmetic — nor try,
	// when some rows carry a skip reason instead of a number.
	out += `SPAWNED    ${"subtotal".padEnd(40)} ${formatCost(spawned.total.costUsd).padStart(12)}\n`;
	out += `TREE       ${"TOTAL + SPAWNED".padEnd(40)} ${formatCost(treeTotals(self, spawned).costUsd).padStart(12)}\n`;
	return out;
}

export function renderUncountedBillables(uncounted?: UncountedBillables): string {
	if (!uncounted) return "";
	const parts: string[] = [];
	if (uncounted.compaction > 0) parts.push(`${uncounted.compaction} compaction${uncounted.compaction === 1 ? "" : "s"}`);
	if (uncounted.recap > 0) parts.push(`${uncounted.recap} recap${uncounted.recap === 1 ? "" : "s"}`);
	if (parts.length === 0) return "";
	return `\nUNCOUNTED  ${parts.join(", ")} — billed by the harness; the transcript records\n` +
	       `           no usage for them, so they are NOT in TOTAL above (#149)\n`;
}


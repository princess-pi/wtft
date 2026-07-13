/**
 * @package princess-pi-packages
 * @module wtft-renderer
 * @description Bar chart rendering, histograms, token summaries, and terminal utilities.
 *   Builds visual output from parsed Interaction arrays: binned bar charts,
 *   SURGE timeline markers, "Other" command histograms, and per-model token tables.
 */

import type { Interaction, Category, Bin, IntervalConfig } from "./wtft-shared.js";
import {
	classifyInteraction,
	normalizeCommand,
	deduplicateInteractions
} from "./wtft-shared.js";
export interface Bin {
	label: string;
	dateStr: string;
	costs: Record<Category, number>;
	total_cost: number;
	incremental_cost?: number;
	/** Token-mode fields — populated when unit==="tokens" (#14) */
	tokens?: Record<Category, { total: number; output: number }>;
	total_tokens?: number;
	incremental_tokens?: number;
}

// ---
// TOKEN-UNIT MODE (#14): Background colors, density calculation, and rendering
// ---

/** 256-color background codes for token-mode bar segments (dark tones for bright-white density chars). */
const TOKEN_BG_COLORS: Record<Category, number> = {
	spec: 22,        // deep forest green
	mixed: 94,       // dark gold / earth
	code: 130,       // burnt orange
	tests: 178,      // warm tan
	research: 54,    // midnight plum
	git: 23,         // deep teal
	grep: 24,        // navy blue
	web: 88,         // crimson
	agents: 55,      // dark purple (#52)
	plan: 30,        // dark cyan (#52)
	prompt: 89,      // dark mauve
	compaction: 58,  // dark olive (#52, wired in Phase 3)
	interrupted: 52, // dark red (#52, wired in Phase 3)
	other: 236,      // near-black charcoal
};

/** Density chars mapped by output-token share quartile. */
const DENSITY_CHARS = ["░", "▒", "▓", "█"] as const;

/**
 * Map output-token share (0–1) to a density character.
 *   0–25% → ░ (cheap — input/cache-heavy)
 *   25–50% → ▒
 *   50–75% → ▓
 *   75–100% → █ (expensive — output-heavy)
 */
export function densityChar(outputShare: number): string {
	const idx = Math.min(3, Math.floor(outputShare * 4));
	return DENSITY_CHARS[idx];
}

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
		for (const cat of ["spec", "code", "mixed", "tests", "research", "git", "grep", "web", "agents", "plan", "prompt", "compaction", "interrupted", "other"] as Category[]) {
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
	unit: "m" | "h" | "d" | "w";
}

// SHARED FILE PARSER (#54 DRY refactor)
// Single source of truth for reading a .jsonl session file into Interaction[]
// (raw, undeduped). Consumers (session selector, CLI chart, Pi TUI) read lines
// differently (File I/O vs ctx.sessionManager), but the parseEntryToInteraction
// call and subsequent dedup are identical — those live here.

/**
 * Parse a .jsonl session file into raw (undeduped) interactions.
 * Caller is responsible for deduplication via {@link deduplicateInteractions}.
 *
 * @param filePath - Absolute path to the .jsonl session log
 * @returns Array of parsed interactions (may contain duplicate message.id entries)
 */
export function parseInterval(val: string): IntervalConfig {
	const match = /^(\d+)([mhdw])$/.exec(val);
	if (match) {
		const size = parseInt(match[1], 10);
		const unit = match[2] as "m" | "h" | "d" | "w";
		if (size > 0) return { size, unit };
	}
	return { size: 1, unit: "h" };
}

// COMMAND NORMALIZATION (#63)
// Strips cd /path prefixes and VAR=value assignments from chained bash commands
// so that 'cd /foo && git push' classifies as 'git', not 'other'.

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

export function getBinInfo(timestamp: number, config: IntervalConfig, tz?: string) {
	const parts = getZonedParts(timestamp, tz);
	const pad = (n: number) => String(n).padStart(2, "0");
	const dateStr = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
	const { size, unit } = config;

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

export function calculateScaleMax(total: number): number {
	if (total <= 0) return 1.0;
	if (total > 20) {
		return Math.ceil(total / 5) * 5;
	} else {
		return Math.ceil(total);
	}
}

/**
 * Build tick line with token-count labels (e.g. "0", "25k", "50k").
 * Same layout as buildTickLine but uses formatTokenCount instead of formatCost.
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
		const text = formatTokenCount(Math.round(tickValues[i]));
		const displayStr = ` ${text} `;
		const startIdx = ticks[i]; // align start of label to tick
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
	// Adaptive precision: 4 decimal places for sub-cent values (< $0.01),
	// 2 decimal places otherwise. Handles DeepSeek's sub-cent pricing
	// ($0.14/M input) without cluttering Claude/Gemini displays.
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

export function getVisualLength(str: string): number {
	const clean = str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	let len = 0;
	for (let i = 0; i < clean.length; i++) {
		const code = clean.charCodeAt(i);
		if (code >= 0xD800 && code <= 0xDBFF && i + 1 < clean.length) {
			len += 2;
			i++;
		} else if (code >= 0x3000 && code <= 0x9FFF) {
			len += 2;
		} else {
			len += 1;
		}
	}
	return len;
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

/**
 * Returns which local hours (0-23) fall in a surge window,
 * given the configured timezone. Surge windows defined in UTC:
 * 01:00-04:00 and 06:00-10:00 UTC.
 */
export function getSurgeLocalHours(tz?: string): Set<number> {
	const result = new Set<number>();
	const now = Date.now();

	for (let localHour = 0; localHour < 24; localHour++) {
		let ts: number;
		if (tz) {
			const parts = getZonedParts(now, tz);
			const offsetMs = getTimezoneOffsetMs(now, tz);
			ts = Date.UTC(parts.year, parts.month - 1, parts.day, localHour, 0, 0, 0) - offsetMs;
		} else {
			const d = new Date();
			d.setHours(localHour, 0, 0, 0);
			ts = d.getTime();
		}
		const utcHour = new Date(ts).getUTCHours();
		if ((utcHour >= 1 && utcHour < 4) || (utcHour >= 6 && utcHour < 10)) {
			result.add(localHour);
		}
	}
	return result;
}

/**
 * Checks current surge proximity (in UTC). Returns status and multiplier.
 */
export function checkSurgeProximity(): { status: 'surge' | 'approaching' | 'ending' | undefined; multiplier: number } {
	const now = new Date();
	const currentUtcMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
	const surgeWindows: [number, number][] = [[60, 240], [360, 600]];

	for (const [start, end] of surgeWindows) {
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

/**
 * Build a 24-hour surge timeline string in the format:
 * (---[colored]---◆---) [⚡ SURGE 2x] [⚡ SURGE APPROACHING]
 *
 * @param surgeHours - Set of local hours (0-23) that are surge-priced
 * @param currentHour - Current local hour (0-23) for diamond marker
 * @param proximityStatus - If set, appends the appropriate surge badge
 */
export function buildTimelineString(
	surgeHours: Set<number>,
	currentHour: number,
	proximityStatus?: 'surge' | 'approaching' | 'ending'
): string {
	const segments: { color: string; text: string }[] = [];
	let lastColor: string | null = null;

	for (let h = 0; h < 24; h++) {
		const isSurge = surgeHours.has(h);
		const isCurrent = h === currentHour;

		// Noon divider: always emit the | separator at hour 12
		// If h=12 is also the current hour, emit both | and the diamond
		if (h === 12) {
			if (lastColor !== "") {
				segments.push({ color: "", text: "|" });
				lastColor = "";
			} else {
				segments[segments.length - 1].text += "|";
			}
			if (isCurrent) {
				// Also emit the diamond marker after the separator
				const diaColor = "1;" + (isSurge ? "38;5;208" : "32");
				if (diaColor !== lastColor) {
					segments.push({ color: diaColor, text: "◆" });
					lastColor = diaColor;
				} else {
					segments[segments.length - 1].text += "◆";
				}
			}
			continue;
		}

		const color = isCurrent ? "1;" + (isSurge ? "38;5;208" : "32") : (isSurge ? "38;5;208" : "32");
		const char = isCurrent ? "◆" : "-";

		if (color !== lastColor) {
			segments.push({ color, text: char });
			lastColor = color;
		} else {
			segments[segments.length - 1].text += char;
		}
	}

	const timelineBody = segments.map(s => `\x1b[${s.color}m${s.text}\x1b[0m`).join("");
	let result = `(${timelineBody})`;

	if (proximityStatus === 'surge') {
		result += ` \x1b[1;38;5;208m⚡ SURGE 2x\x1b[0m`;
	} else if (proximityStatus === 'approaching') {
		result += ` \x1b[1;5;38;5;208m⚡ SURGE APPROACHING\x1b[0m`;
	} else if (proximityStatus === 'ending') {
		result += ` \x1b[1;5;32m⚡ SURGE ENDING\x1b[0m`;
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

	const ALL_CATEGORIES = ["spec", "code", "mixed", "tests", "research", "git", "grep", "web", "agents", "plan", "prompt", "compaction", "interrupted", "other"] as Category[];

	for (const interaction of interactions) {
		const classification = classifyInteraction(interaction);
		const { key, label, dateStr } = getBinInfo(interaction.timestamp, intervalConfig, tz);
		totalSessionCost += interaction.cost;

		let bin = binMap.get(key);
		if (!bin) {
			const costs = {} as Record<Category, number>;
			for (const cat of ALL_CATEGORIES) {
				costs[cat] = 0;
			}
			bin = { label, dateStr, costs, total_cost: 0 };
			binMap.set(key, bin);
		}

		bin.costs[classification] += interaction.cost;
		bin.total_cost += interaction.cost;

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
			prefixWidth += maxIncLen + 2 + maxCostLen + 2;
		} else {
			maxCostLen = Math.max(...displayedBins.map(b => formatTokenCount(b.total_tokens ?? 0).length), 6);
			prefixWidth += maxCostLen + 2;
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
	
	// We reserve 3 characters at the very end of the line.
	// Why? To guarantee that when the final label (e.g. ` $100.00 `) is aligned so its `.` 
	// sits on the final tick, the `.00 ` trailing characters do not overflow `finalWidth`.
	// Shaving exactly 3 characters makes the ticks row length perfectly match `finalWidth`.
	const maxBarWidth = finalWidth - prefixWidth - 3;

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
	const proximity = isDeepSeek ? checkSurgeProximity() : { status: undefined as string | undefined, multiplier: 1.0 };
	const timelineStr = buildTimelineString(surgeHours, currentHour, proximity.status);
	const timelineLen = getVisualLength(timelineStr);
	
	const legendItems = [
		`\x1b[38;5;108m█\x1b[0mSpec`,
		`\x1b[38;5;108;48;5;173m▒\x1b[0mMixed`,
		`\x1b[38;5;173m█\x1b[0mCode`,
		`\x1b[38;5;223m█\x1b[0mTests`,
		`\x1b[38;5;134m█\x1b[0mResearch`,
		`\x1b[38;5;73m█\x1b[0mGit`,
		`\x1b[38;5;67m█\x1b[0mGrep`,
		`\x1b[38;5;209m▓\x1b[0mWeb`,
		`\x1b[38;5;141m█\x1b[0mAgents`,
		`\x1b[38;5;116m█\x1b[0mPlan`,
		`\x1b[38;5;168m░\x1b[0mPrompt`,
		`\x1b[38;5;238m░\x1b[0mOther`
	];
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

	// Render binned stacked bars
	for (let i = 0; i < displayedBins.length; i++) {
		const bin = displayedBins[i];

		// Day boundary divider (same for both modes)
		if (showTicks && i > 0 && bin.dateStr !== displayedBins[i - 1].dateStr) {
			const labelDay = formatMmmDdStr(bin.dateStr);
			const dayChangeText = `── ${labelDay} `;
			const dividerLen = Math.max(0, (finalWidth - 3) - dayChangeText.length);
			const dividerChars = Array.from({ length: dividerLen }, () => "─");
			const tickPositions = [
				prefixWidth,
				prefixWidth + Math.floor(maxBarWidth / 4),
				prefixWidth + Math.floor(maxBarWidth / 2),
				prefixWidth + Math.floor((maxBarWidth * 3) / 4),
				prefixWidth + maxBarWidth - 1
			];
			for (const t of tickPositions) {
				const idx = t - dayChangeText.length;
				if (idx >= 0 && idx < dividerChars.length) {
					dividerChars[idx] = "┼";
				}
			}
			const dividerLine = dayChangeText + dividerChars.join("");
			widgetLines.push(`\x1b[90m${dividerLine}\x1b[0m`);
		}

		const labelPart = padString(bin.label, labelWidth);
		const coloredLabel = `\x1b[90m${labelPart}\x1b[0m`;

		if (unit === "tokens" && bin.tokens) {
			// --- TOKEN MODE BAR RENDERING (#14) ---
			const barWidth = scaleMax > 0 ? Math.round(((bin.total_tokens ?? 0) / scaleMax) * maxBarWidth) : 0;
			// Token bar: bg color for category, fg white density char per output share
			let barStr = "";
			let allChars: number = 0;
			for (const cat of ALL_CATEGORIES) {
				const t = bin.tokens[cat];
				if (!t || t.total <= 0) continue;
				const segWidth = scaleMax > 0 ? Math.round(((bin.total_tokens ?? 0) / scaleMax) * maxBarWidth * (t.total / (bin.total_tokens || 1))) : 0;
				// distribute proportional chars
				const segChars = Math.max(0, Math.min(segWidth, maxBarWidth - allChars));
				if (segChars <= 0) continue;
				const outputShare = t.total > 0 ? t.output / t.total : 0;
				const dc = densityChar(outputShare);
				const bg = TOKEN_BG_COLORS[cat] ?? 236;
				barStr += `\x1b[48;5;${bg}m\x1b[38;5;15m${dc.repeat(segChars)}\x1b[0m`;
				allChars += segChars;
			}

			// Server tool cost marker ($) at bar tail if no tokens but had cost (#14)
			const hasServerToolCost = (bin.costs["web"] || 0) > 0 && (bin.tokens["web"]?.total ?? 0) === 0;
			if (hasServerToolCost && allChars < maxBarWidth) {
				barStr += `\x1b[38;5;209m$\x1b[0m`;
				allChars++;
			}

			// Prefix: incremental + cumulative tokens
			if (mode === "cumulative") {
				const incSign = (bin.incremental_tokens ?? 0) >= 0 ? "+" : "";
				const incStr = `${incSign}${formatTokenCount(bin.incremental_tokens ?? 0)}`;
				const incPart = padString(incStr, maxIncLen);
				const tokPart = padString(formatTokenCount(bin.total_tokens ?? 0), maxCostLen);
				widgetLines.push(`${coloredLabel}  \x1b[90m${incPart}\x1b[0m  \x1b[1;37m${tokPart} tok\x1b[0m  ${barStr}`);
			} else {
				const tokPart = padString(formatTokenCount(bin.total_tokens ?? 0), maxCostLen);
				widgetLines.push(`${coloredLabel}  \x1b[1;37m${tokPart} tok\x1b[0m  ${barStr}`);
			}
		} else {
			// --- COST MODE BAR RENDERING (original) ---
			let barStr = "";
			if (mode === "cumulative") {
				const barWidth = scaleMax > 0 ? Math.round((bin.total_cost / scaleMax) * maxBarWidth) : 0;
				const chars = distributeChars(bin.costs, barWidth);

				if (chars.spec > 0) {
					barStr += `\x1b[38;5;108m${"█".repeat(chars.spec)}\x1b[0m`;
				}
				if (chars.mixed > 0) {
					barStr += `\x1b[38;5;108;48;5;173m${"▒".repeat(chars.mixed)}\x1b[0m`;
				}
				if (chars.code > 0) {
					barStr += `\x1b[38;5;173m${"█".repeat(chars.code)}\x1b[0m`;
				}
				if (chars.tests > 0) {
					barStr += `\x1b[38;5;223m${"█".repeat(chars.tests)}\x1b[0m`;
				}
				if (chars.research > 0) {
					barStr += `\x1b[38;5;134m${"█".repeat(chars.research)}\x1b[0m`;
				}
				if (chars.git > 0) {
					barStr += `\x1b[38;5;73m${"█".repeat(chars.git)}\x1b[0m`;
				}
				if (chars.grep > 0) {
					barStr += `\x1b[38;5;67m${"█".repeat(chars.grep)}\x1b[0m`;
				}
				if (chars.web > 0) {
					barStr += `\x1b[38;5;209m${"▓".repeat(chars.web)}\x1b[0m`;
				}
				if (chars.agents > 0) {
					barStr += `\x1b[38;5;141m${"█".repeat(chars.agents)}\x1b[0m`;
				}
				if (chars.plan > 0) {
					barStr += `\x1b[38;5;116m${"█".repeat(chars.plan)}\x1b[0m`;
				}
				if (chars.prompt > 0) {
					barStr += `\x1b[38;5;168m${"░".repeat(chars.prompt)}\x1b[0m`;
				}
				if (chars.compaction > 0) {
					barStr += `\x1b[38;5;143m${"░".repeat(chars.compaction)}\x1b[0m`;
				}
				if (chars.interrupted > 0) {
					barStr += `\x1b[38;5;167m${"░".repeat(chars.interrupted)}\x1b[0m`;
				}
				if (chars.other > 0) {
					barStr += `\x1b[38;5;238m${"░".repeat(chars.other)}\x1b[0m`;
				}
			} else {
				const cells = Array(maxBarWidth).fill(" ");
				const categoriesInReverse: { cat: Category; color: string; char: string }[] = [
					{ cat: "other", color: "\x1b[38;5;238m", char: "░" },
					{ cat: "interrupted", color: "\x1b[38;5;167m", char: "░" },
					{ cat: "compaction", color: "\x1b[38;5;143m", char: "░" },
					{ cat: "prompt", color: "\x1b[38;5;168m", char: "░" },
					{ cat: "plan", color: "\x1b[38;5;116m", char: "█" },
					{ cat: "grep", color: "\x1b[38;5;67m", char: "█" },
					{ cat: "web", color: "\x1b[38;5;209m", char: "▓" },
					{ cat: "agents", color: "\x1b[38;5;141m", char: "█" },
					{ cat: "git", color: "\x1b[38;5;73m", char: "█" },
					{ cat: "research", color: "\x1b[38;5;134m", char: "█" },
					{ cat: "tests", color: "\x1b[38;5;223m", char: "█" },
					{ cat: "code", color: "\x1b[38;5;173m", char: "█" },
					{ cat: "mixed", color: "\x1b[38;5;108;48;5;173m", char: "▒" },
					{ cat: "spec", color: "\x1b[38;5;108m", char: "█" }
				];

				for (const { cat, color, char } of categoriesInReverse) {
					const cost = bin.costs[cat] || 0;
					if (cost > 0 && scaleMax > 0) {
						const pos = Math.round((cost / scaleMax) * (maxBarWidth - 1));
						if (pos >= 0 && pos < maxBarWidth) {
							cells[pos] = `${color}${char}\x1b[0m`;
						}
					}
				}
				barStr = cells.join("");
			}

			if (mode === "cumulative") {
				const incSign = (bin.incremental_cost ?? 0) >= 0 ? "+" : "";
				const incStr = `${incSign}${formatCost(bin.incremental_cost ?? 0)}`;
				const incPart = padString(incStr, maxIncLen);
				const coloredInc = `\x1b[90m${incPart}\x1b[0m`;
				const costPart = padString(formatCost(bin.total_cost), maxCostLen);
				const coloredCost = `\x1b[1;37m${costPart}\x1b[0m`;
				widgetLines.push(`${coloredLabel}  ${coloredInc}  ${coloredCost}  ${barStr}`);
			} else {
				const costPart = padString(formatCost(bin.total_cost), maxCostLen);
				const coloredCost = `\x1b[1;37m${costPart}\x1b[0m`;
				widgetLines.push(`${coloredLabel}  ${coloredCost}  ${barStr}`);
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

	// --- TOKEN MODE FOOTER (#14): density key bar + Pi-style summary ---
	if (unit === "tokens") {
		// Density key bar
		widgetLines.push(`\x1b[90m  cheap \$/tok  \x1b[37m░\x1b[0m\x1b[37m░\x1b[0m \x1b[37m▒\x1b[0m\x1b[37m▒\x1b[0m \x1b[37m▓\x1b[0m\x1b[37m▓\x1b[0m \x1b[37m█\x1b[0m\x1b[37m█\x1b[0m  expensive \$/tok  \x1b[90m\$ = cost-only (web tools)\x1b[0m`);
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

export function renderTokenSummary(interactions: Interaction[], maxWidth: number = 80, thinkingBudget?: number): string {
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

	// Rows
	let totalInput = 0, totalOutput = 0, totalCr = 0, totalCw = 0, totalReasoning = 0, totalCost = 0;
	for (const [model, agg] of sorted) {
		out += [
			shortenModel(model).padEnd(modelColW),
			formatTokenCount(agg.inputTokens).padStart(numColW),
			formatTokenCount(agg.outputTokens).padStart(numColW),
			formatTokenCount(agg.reasoningTokens).padStart(numColW),
			formatTokenCount(agg.cacheReadTokens).padStart(numColW),
			formatTokenCount(agg.cacheWriteTokens).padStart(numColW),
			formatCost(agg.cost).padStart(numColW)
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
		formatCost(totalCost).padStart(numColW)
	].join(" ") + "\n";

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

	return out;
}

// WATCH MODE: tail -f style live re-rendering (#45)
// Watches a .jsonl session file for changes and re-renders in-place.

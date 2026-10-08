import type { Category } from "./wtft-shared.js";
import {
	type Bin,
	CATEGORY_ORDER,
	CATEGORY_STYLE,
	calculateScaleMax,
	buildTokenTickLine,
	buildTickLine,
	padString,
	formatCost,
	formatMmmDdStr,
	getSurgeLocalHours,
	getCurrentLocalHour,
	checkSurgeProximity,
	buildTimelineString,
	getMoonPhase,
	getZonedParts,
	resolveZonedLocalHour,
	formatTokenCount,
	getVisualLength,
} from "./wtft-renderer.js";

/** Local midnight that opens the strip's day, and the next local midnight. */
export function stripMidnights(now: number, tz?: string): { start: Date; end: Date } {
	if (!tz) {
		const start = new Date(now);
		start.setHours(0, 0, 0, 0);
		const end = new Date(start);
		end.setDate(end.getDate() + 1);
		return { start, end };
	}
	const parts = getZonedParts(now, tz);
	const start = new Date(resolveZonedLocalHour(parts.year, parts.month, parts.day, 0, tz));
	const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
	const end = new Date(resolveZonedLocalHour(
		next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, tz,
	));
	return { start, end };
}

/** Beginning moon, ending moon, and the noon glyph. Emoji-off uses `|` and `*`. */
export function timelineGlyphs(now: number, tz: string | undefined, disabledEmoji?: boolean): {
	start: string; end: string; noon: string;
} {
	if (disabledEmoji) return { start: "|", end: "|", noon: "*" };
	const { start, end } = stripMidnights(now, tz);
	return { start: getMoonPhase(start), end: getMoonPhase(end), noon: "☀️" };
}

const BLOCK_BUCKET = "\u2588" as const;

const PLACEHOLDER_PREFIX = "\x1b[90m-";

/** Padding stops here whatever the limit: `-l 1000000000` is a valid row limit, not a request for a billion rows. */
export const MAX_PADDED_ROWS = 1000;

const XTERM_LEVELS = [0, 95, 135, 175, 215, 255];
const XTERM_BASIC: number[][] = [
	[0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16], [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
	[136, 136, 136], [241, 76, 76], [35, 209, 139], [245, 245, 67], [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
];
// WCAG relative luminance of every ✨ cell's background, which sets ✨'s contrast against it. Set to
// personal preference. Dimmer values, around 0.08 to 0.12, give ✨ the most contrast, but at those
// dimmer values the core color is lost. Initially set to 0.2 as a balance between identifying the
// color category and the sparkle's contrast.
const SPARKLE_BG_LUMINANCE = 0.20;

/** The xterm 256-colour palette entry `n` as sRGB channels; outside 0-255, palette entry 7. */
export function xtermChannels(n: number): number[] {
	if (n < 16 || n > 255) return XTERM_BASIC[n] ?? XTERM_BASIC[7];
	if (n >= 232) return Array(3).fill(8 + (n - 232) * 10);
	const i = n - 16;
	return [XTERM_LEVELS[Math.floor(i / 36)], XTERM_LEVELS[Math.floor(i / 6) % 6], XTERM_LEVELS[i % 6]];
}

/** xterm 256-colour index in, the same hue as 24-bit sRGB out, scaled to SPARKLE_BG_LUMINANCE. */
export function sparkleBackground(fg: number): number[] {
	const linear = xtermChannels(fg).map((c) => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
	const [base, from] = luminance === 0 ? [[1, 1, 1], 1] : [linear, luminance];
	return base.map((c) => {
		const v = Math.min(1, c * SPARKLE_BG_LUMINANCE / from);
		return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
	});
}

/** A padding row: the watch drops these first when the frame is taller than the terminal. */
export function isPlaceholderRow(line: string): boolean {
	return line.startsWith(PLACEHOLDER_PREFIX);
}

export interface ChartCategory {
	slot: Category;
	label: string | null;
	fg: number;
	char?: string;
}

/** docs/spec-398-chart-words.md */
export interface ChartWords {
	title?: string;
	categories?: ChartCategory[];
	tokenUnit?: { name: string; short: string };
	currency?: string;
	cacheMissLabel?: string;
	key?: { earlier: string; thisBin: string; costOnly?: string };
	tokenFooter?: boolean;
	cacheLine?: boolean;
	otherWarning?: string | false;
}

/** Past this share of the width, the label area (time label and number columns) is compacted. */
const MAX_LABEL_SHARE = 0.25;
const MAX_COMPACT = 5;

/** `$487.25` → `$487`; under $1 unchanged. */
export function wholeCost(n: number, currency = "$"): string {
	return Math.abs(n) >= 1 ? `${currency}${Math.sign(n) * Math.round(Math.abs(n))}` : formatCost(n, currency);
}

/** `778.8M` → `779M`, `589.5k` → `590k`; under 1k unchanged. */
export function wholeTokens(n: number): string {
	const sign = n < 0 ? "-" : "";
	const a = Math.abs(n);
	const k = Math.round(a / 1_000);
	if (k >= 1_000) return `${sign}${Math.round(a / 1_000_000)}M`;
	return a >= 1_000 ? `${sign}${k}k` : String(n);
}

/** The four number columns' text at compaction step `compact` (0 to MAX_COMPACT); a cost column keeps
 *  its cents on every row when any of `bins` shows them there. */
function columnTexts(compact: number, bins: Bin[], words?: ChartWords) {
	const currency = words?.currency ?? "$";
	const unit = words?.tokenUnit ?? { name: "tok", short: "t" };
	const costColumn = (values: number[]) => {
		const whole = compact >= 2 && values.every((n) => Math.abs(n) >= 1);
		return (n: number) => (whole ? wholeCost(n, currency) : formatCost(n, currency));
	};
	const incCostOf = (bin: Bin) => bin.incremental_cost ?? 0;
	const totalCostOf = (bin: Bin) => bin.column_total_cost ?? bin.total_cost;
	const incCost = costColumn(bins.map(incCostOf));
	const totalCost = costColumn(bins.map(totalCostOf));
	const tokens = compact >= 2 ? wholeTokens : formatTokenCount;
	const plus = (n: number) => (n >= 0 && compact < 3 ? "+" : "");
	return {
		incCost: (bin: Bin) => {
			const n = incCostOf(bin);
			const text = `${plus(n)}${incCost(n)}`;
			return compact >= 4 ? text.replace(currency, "") : text;
		},
		totalCost: (bin: Bin) => totalCost(totalCostOf(bin)),
		incTok: (bin: Bin) => {
			const n = bin.incremental_tokens ?? 0;
			return `${plus(n)}${tokens(n)}`;
		},
		totalTok: (bin: Bin) => `${tokens(bin.column_total_tokens ?? bin.total_tokens ?? 0)}${compact >= 5 ? unit.short : ` ${unit.name}`}`,
	};
}

export function renderWtftChart(input: {
	displayedBins: Bin[];
	mode: "bucket" | "cumulative";
	unit: "cost" | "tokens";
	width: number;
	disabledEmoji?: boolean;
	tz?: string;
	model?: string;
	sessionNameSuffix?: string;
	cacheMissBins: ReadonlySet<string>;
	totalSessionCost: number;
	totalSessionTokens: number;
	otherWarning: string | null;
	tokenFooter: string | null;
	cacheLine: string | null;
	showCostColumns?: boolean;
	showTokenColumns?: boolean;
	padRowsTo?: number;
	words?: ChartWords;
	live?: boolean;
	newestAt?: number;
}): string[] {
	const {
		displayedBins, mode, unit, width, disabledEmoji, tz,
		cacheMissBins, totalSessionCost, totalSessionTokens,
		otherWarning, tokenFooter, cacheLine,
	} = input;
	let showCost = input.showCostColumns !== false;
	let showTokens = input.showTokenColumns !== false;
	const opts = { model: input.model, sessionNameSuffix: input.sessionNameSuffix };
	const words = input.words;
	const listed = (words?.categories ?? []).filter((c, i, all) => CATEGORY_ORDER.includes(c.slot) && all.findIndex((o) => o.slot === c.slot) === i);
	const order: Category[] = [...listed.map((c) => c.slot), ...CATEGORY_ORDER.filter((c) => !listed.some((l) => l.slot === c))];
	const styleOf = (cat: Category): { fg: number; char: string; label: string | null } => {
		const own = listed.find((l) => l.slot === cat);
		return own ? { fg: own.fg, char: own.char ?? "█", label: own.label } : words?.categories ? { ...CATEGORY_STYLE[cat], label: null } : CATEGORY_STYLE[cat];
	};
	const ALL_CATEGORIES = order;
	const THIS_BIN = disabledEmoji ? "**" : "✨";
	const splitSegment = (cells: number, newShare: number, fg: number): string => {
		const raw = cells * newShare;
		const evenCells = cells - (cells % 2);
		const fresh = raw > 0 && evenCells >= 2 ? Math.min(evenCells, Math.max(2, 2 * Math.round(raw / 2))) : 0;
		const earlier = cells - fresh;
		let out = "";
		if (earlier > 0) out += `\x1b[38;5;${fg}m${"█".repeat(earlier)}\x1b[0m`;
		if (fresh > 0) out += `\x1b[48;2;${sparkleBackground(fg).join(";")}m${disabledEmoji ? "*".repeat(fresh) : "✨".repeat(fresh / 2)}\x1b[0m`;
		return out;
	};

	const maxBarValue = mode === "cumulative"
		? (unit === "tokens" ? totalSessionTokens : totalSessionCost)
		: Math.max(...displayedBins.map(b => unit === "tokens" ? (b.total_tokens ?? 0) : b.total_cost), 0);
	const scaleMax = unit === "tokens"
		? Math.ceil(maxBarValue / 1000) * 1000
		: calculateScaleMax(maxBarValue);

	const labelWidth = Math.max(...displayedBins.map(b => b.label.length), 5);
	const finalWidth = Math.max(width, 40);
	const tickReserve = unit === "tokens" ? 5 : 3;
	// buildTickLine and buildTokenTickLine return null below 15 cells.
	const minBar = 15;
	const layoutFor = (cost: boolean, tokens: boolean, compact: number) => {
		const texts = columnTexts(compact, displayedBins, words);
		const shown: ((bin: Bin) => string)[] = [];
		if (cost) shown.push(texts.incCost, texts.totalCost);
		if (tokens) shown.push(texts.incTok, texts.totalTok);
		const widths = shown.map((text) => Math.max(...displayedBins.map((bin) => getVisualLength(text(bin))), 1));
		const gap = compact >= 1 ? 1 : 2;
		let prefix = labelWidth + gap;
		for (const columnWidth of widths) prefix += columnWidth + gap;
		return { widths, prefix, gap, texts, bar: finalWidth - prefix - tickReserve };
	};
	const fit = (cost: boolean, tokens: boolean) => {
		let compact = 0;
		let candidate = layoutFor(cost, tokens, compact);
		while (candidate.prefix > finalWidth * MAX_LABEL_SHARE && compact < MAX_COMPACT) candidate = layoutFor(cost, tokens, ++compact);
		return candidate;
	};
	let laid = fit(showCost, showTokens);
	if (laid.bar < minBar && showTokens) {
		showTokens = false;
		laid = fit(showCost, false);
	}
	if (laid.bar < minBar && showCost) {
		showCost = false;
		laid = fit(false, showTokens);
	}
	const columnWidths = laid.widths;
	const prefixWidth = laid.prefix;
	const maxBarWidth = Math.max(0, laid.bar);
	const gap = " ".repeat(laid.gap);
	const { incCost: incCostText, totalCost: totalCostText, incTok: incTokText, totalTok: totalTokText } = laid.texts;

	const titleDateStr = formatMmmDdStr(displayedBins[0].dateStr);

	const widgetLines: string[] = [];
	
	const titleLeft = words?.title ?? (unit === "tokens"
		? (disabledEmoji ? "[#] WTF Tokens?" : "🔢 WTF Tokens?")
		: (disabledEmoji ? "[$] WTF Tokens?" : "💸 WTF Tokens?"));
	
	const sessionSuffix = opts?.sessionNameSuffix ? ` \x1b[90m...${opts.sessionNameSuffix.replace(/\.jsonl$/, "").slice(-4)}\x1b[0m` : "";
	const titleLeftFinal = titleLeft + sessionSuffix;
	
	const now = Date.now();
	const newestAt = input.newestAt;
	const live = input.live === true || newestAt === undefined || now - newestAt < 3_600_000;
	const anchor = live ? now : newestAt;
	const surgeHours = getSurgeLocalHours(tz, anchor, opts?.model);
	const currentHour = getCurrentLocalHour(tz, anchor);
	const proximity = live ? checkSurgeProximity(now, opts?.model) : { status: undefined, multiplier: 1 };
	const glyphs = timelineGlyphs(anchor, tz, disabledEmoji);
	const timelineStr = buildTimelineString(
		surgeHours, currentHour, glyphs.start, glyphs.end, glyphs.noon,
		proximity.status, disabledEmoji, proximity.multiplier,
	);

	const legendItems = order
		.filter(c => styleOf(c).label !== null)
		.map(c => `\x1b[38;5;${styleOf(c).fg}m${styleOf(c).char}\x1b[0m${styleOf(c).label}`);
	const legendStr = legendItems.join(" ");

	widgetLines.push(titleLeftFinal + "  " + timelineStr);
	widgetLines.push(legendStr);

	if (scaleMax > 0) {
		const dateLabel = `── ${titleDateStr} `;
		const paddingLen = Math.max(0, prefixWidth - dateLabel.length);
		const labelPrefix = dateLabel + "─".repeat(paddingLen);
		const ticksLine = unit === "tokens"
			? buildTokenTickLine(scaleMax, maxBarWidth, prefixWidth, labelPrefix)
			: buildTickLine(scaleMax, maxBarWidth, prefixWidth, labelPrefix, words?.currency);
		if (ticksLine) {
			widgetLines.push(`\x1b[90m${ticksLine}\x1b[0m`);
		}
	}

	const precomputedCells: Map<Bin, Record<Category, number>> = new Map();
	if (mode === "cumulative" && unit === "cost") {
		const chronological = [...displayedBins].reverse();
		let prevSlots: Record<Category, number> | null = null;
		for (const bin of chronological) {
			const cellWidth = scaleMax > 0 ? Math.round((bin.total_cost / scaleMax) * maxBarWidth) : 0;
			const slots = {} as Record<Category, number>;
			let allocated = 0;

			for (const cat of order) {
				const raw = scaleMax > 0 ? (bin.costs[cat] / scaleMax) * cellWidth : 0;
				slots[cat] = Math.floor(raw);
				allocated += slots[cat];
			}

			if (prevSlots) {
				let clampedTotal = 0;
				for (const cat of order) {
					if (prevSlots[cat] >= 1) slots[cat] = Math.max(slots[cat], prevSlots[cat]);
					clampedTotal += slots[cat];
				}
				let excess = clampedTotal - cellWidth;
				while (excess > 0) {
					let maxGrow = -1, maxCat: Category | null = null;
					for (const cat of order) {
						if (slots[cat] <= 0) continue;
						const grow = slots[cat] - (prevSlots[cat] || 0);
						if (grow > maxGrow) { maxGrow = grow; maxCat = cat; }
					}
					if (maxCat) { slots[maxCat]--; excess--; }
					else break;
				}
				allocated = 0;
				for (const cat of order) allocated += slots[cat];
			}

			while (allocated < cellWidth && bin.total_cost > 0) {
				let maxDeficit = -Infinity;
				let maxCat: Category | null = null;
				for (const cat of order) {
					const ideal = (bin.costs[cat] / bin.total_cost) * cellWidth;
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

			precomputedCells.set(bin, slots);
			prevSlots = { ...slots };
		}
	}

	const buildDividerLine = (labelText: string): string => {
		const prefix = `── ${labelText} `;
		const dividerLen = Math.max(0, (finalWidth - tickReserve) - getVisualLength(prefix));
		const chars = Array.from({ length: dividerLen }, () => "─");
		const tickPositions = [
			prefixWidth,
			prefixWidth + Math.floor(maxBarWidth / 4),
			prefixWidth + Math.floor(maxBarWidth / 2),
			prefixWidth + Math.floor((maxBarWidth * 3) / 4),
			prefixWidth + maxBarWidth - 1
		];
		for (const t of tickPositions) {
			const idx = t - getVisualLength(prefix);
			if (idx >= 0 && idx < chars.length) {
				chars[idx] = "┼";
			}
		}
		return prefix + chars.join("");
	};

	// Labelled "Miss" not "Expired": the usage block proves the re-prime happened,
	// but says nothing about why, and TTL is only one of the causes.
	// Drawn BELOW the missed row: rows are newest-first, so below is earlier in
	// time, between the missed turn and the older turns it could not reuse.
	const cacheMissLine = `\x1b[90m${buildDividerLine(words?.cacheMissLabel ?? "Cache Miss")}\x1b[0m`;
	const missed = (b: typeof displayedBins[number] | undefined) => !!b?.key && cacheMissBins.has(b.key);

	const rowWithColumns = (
		coloredLabel: string,
		surgeInc: string,
		costColor: string,
		boltGap: string,
		surgeActive: boolean,
		barStr: string,
		bin: Bin,
	): string => {
		let widthIndex = 0;
		const colored: string[] = [];
		const pushCol = (text: string, color: string) => {
			colored.push(`${color}${text}${" ".repeat(Math.max(0, columnWidths[widthIndex++] - getVisualLength(text)))}\x1b[0m`);
		};
		if (showCost) {
			pushCol(incCostText(bin), surgeInc);
			pushCol(totalCostText(bin), costColor);
		}
		if (showTokens) {
			pushCol(incTokText(bin), surgeInc);
			pushCol(totalTokText(bin), costColor);
		}
		if (colored.length === 0) {
			return surgeActive ? `${coloredLabel}${boltGap}${barStr}` : `${coloredLabel}${gap}${barStr}`;
		}
		if (colored.length === 1) return `${coloredLabel}${boltGap}${colored[0]}${gap}${barStr}`;
		return `${coloredLabel}${gap}${colored[0]}${boltGap}${colored.slice(1).join(gap)}${gap}${barStr}`;
	};

	let drewDollar = false;
	for (let i = 0; i < displayedBins.length; i++) {
		const bin = displayedBins[i];

		if (i > 0 && missed(displayedBins[i - 1])) widgetLines.push(cacheMissLine);

		if (i > 0 && bin.dateStr !== displayedBins[i - 1].dateStr) {
			widgetLines.push(`\x1b[90m${buildDividerLine(formatMmmDdStr(bin.dateStr))}\x1b[0m`);
		}

		const labelPart = padString(bin.label, labelWidth);

		const surgeActive = bin.surgePriced === true;
		const surgeLabel = surgeActive ? "\x1b[1;38;5;208m" : "\x1b[90m";
		const surgeInc = surgeActive ? "\x1b[1;38;5;208m" : "\x1b[90m";
		const costColor = surgeActive ? "\x1b[1;38;5;208m" : "\x1b[1;37m";
		const coloredLabel = `${surgeLabel}${labelPart}\x1b[0m`;
		// ⚡ is double-width — it fills the 2-char column gap on its own, numbers stay aligned.
		const boltGap = surgeActive && gap.length === 2 ? `\x1b[1;38;5;208m${disabledEmoji ? "!!" : "\u26A1"}\x1b[0m` : gap;

		if (unit === "tokens" && bin.tokens) {
			const barMax = Math.max(0, maxBarWidth - 2);
			let barStr = "";
			let allChars: number = 0;
			for (const cat of ALL_CATEGORIES) {
				const t = bin.tokens[cat];
				if (!t || t.total <= 0) continue;
				const segWidth = scaleMax > 0 && barMax > 0 ? Math.round(((bin.total_tokens ?? 0) / scaleMax) * barMax * (t.total / (bin.total_tokens || 1))) : 0;
				const segChars = Math.max(0, Math.min(segWidth, barMax - allChars));
				if (segChars <= 0) continue;
				const fg = styleOf(cat).fg;

				if (mode === "cumulative") {
					const incTokens = bin._incTokens?.[cat]?.total ?? 0;
					barStr += splitSegment(segChars, t.total > 0 ? incTokens / t.total : 0, fg);
				} else {
					barStr += `\x1b[38;5;${fg}m${BLOCK_BUCKET.repeat(segChars)}\x1b[0m`;
				}
				allChars += segChars;
			}

			const hasServerToolCost = (bin.costs["web"] || 0) > 0 && (bin.tokens["web"]?.total ?? 0) === 0;
			if (hasServerToolCost && allChars < barMax) {
				barStr += `\x1b[38;5;${styleOf("web").fg}m${words?.currency || "$"}\x1b[0m`;
				allChars++;
				drewDollar = true;
			}

			widgetLines.push(rowWithColumns(coloredLabel, surgeInc, costColor, boltGap, surgeActive, barStr, bin));
		} else {
			let barStr = "";
			if (mode === "cumulative") {
				const counts = precomputedCells.get(bin);
				for (const cat of order) {
					const n = counts?.[cat] ?? 0;
					if (n <= 0) continue;
					const total = bin.costs[cat] || 0;
					barStr += splitSegment(n, total > 0 ? (bin._incCosts?.[cat] ?? 0) / total : 0, styleOf(cat).fg);
				}
			} else {
				const buckets = new Map<number, { cat: Category; cost: number }[]>();
				for (const cat of order) {
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
					} else {
						let best = entries[0];
						for (const entry of entries) if (entry.cost > best.cost) best = entry;
						const fg = styleOf(best.cat).fg;
						barStr += `\x1b[38;5;${fg}m█\x1b[0m`;
					}
				}
			}

			widgetLines.push(rowWithColumns(coloredLabel, surgeInc, costColor, boltGap, surgeActive, barStr, bin));
		}
	}
	if (missed(displayedBins[displayedBins.length - 1])) widgetLines.push(cacheMissLine);

	const placeholder = PLACEHOLDER_PREFIX + [padString("-", labelWidth), ...columnWidths.map(w => padString("-", w))].join(gap).slice(1) + "\x1b[0m";
	for (let n = displayedBins.length; n < Math.min(input.padRowsTo ?? 0, MAX_PADDED_ROWS); n++) widgetLines.push(placeholder);

	if (otherWarning) widgetLines.push(otherWarning);

	{
		const keyParts: string[] = [];
		if (mode === "cumulative") keyParts.push(`\x1b[37m█\x1b[0m\x1b[90m ${words?.key?.earlier ?? "earlier bins"}  \x1b[48;2;${sparkleBackground(7).join(";")}m${THIS_BIN}\x1b[0m\x1b[90m ${words?.key?.thisBin ?? "this bin"}`);
		if (drewDollar) keyParts.push(`${words?.currency || "$"} = ${words?.key?.costOnly ?? "cost-only (web tools)"}`);
		if (keyParts.length > 0) widgetLines.push(`\x1b[90m  ${keyParts.join("  ")}\x1b[0m`);
		if (unit === "tokens" && tokenFooter) widgetLines.push(`\x1b[37m  ${tokenFooter}\x1b[0m`);
	}

	if (cacheLine) {
		widgetLines.push(`\x1b[90m  CH: ${cacheLine}\x1b[0m`);
	}

	return widgetLines;
}

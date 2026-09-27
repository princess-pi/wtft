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
	formatTokenCount,
} from "./wtft-renderer.js";

const BLOCK_OLD = "\u2583" as const;
const BLOCK_NEW = "\u2587" as const;
const BLOCK_BUCKET = "\u2588" as const;

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
}): string[] {
	const {
		displayedBins, mode, unit, width, disabledEmoji, tz,
		cacheMissBins, totalSessionCost, totalSessionTokens,
		otherWarning, tokenFooter, cacheLine,
	} = input;
	let showCost = input.showCostColumns !== false;
	let showTokens = input.showTokenColumns !== false;
	const opts = { model: input.model, sessionNameSuffix: input.sessionNameSuffix };
	const ALL_CATEGORIES = CATEGORY_ORDER;

	const maxBarValue = mode === "cumulative"
		? (unit === "tokens" ? totalSessionTokens : totalSessionCost)
		: Math.max(...displayedBins.map(b => unit === "tokens" ? (b.total_tokens ?? 0) : b.total_cost), 0);
	const scaleMax = unit === "tokens"
		? Math.ceil(maxBarValue / 1000) * 1000
		: calculateScaleMax(maxBarValue);

	const labelWidth = Math.max(...displayedBins.map(b => b.label.length), 5);
	const incCostText = (bin: Bin) => {
		const n = bin.incremental_cost ?? 0;
		const sign = n >= 0 ? "+" : "";
		return `${sign}${formatCost(n)}`;
	};
	const totalCostText = (bin: Bin) => formatCost(bin.column_total_cost ?? bin.total_cost);
	const incTokText = (bin: Bin) => {
		const n = bin.incremental_tokens ?? 0;
		const sign = n >= 0 ? "+" : "";
		return `${sign}${formatTokenCount(n)}`;
	};
	const totalTokText = (bin: Bin) => `${formatTokenCount(bin.column_total_tokens ?? bin.total_tokens ?? 0)} tok`;
	const finalWidth = Math.max(width, 40);
	const tickReserve = unit === "tokens" ? 5 : 3;
	// buildTickLine and buildTokenTickLine return null below 15 cells.
	const minBar = 15;
	const layoutFor = (cost: boolean, tokens: boolean) => {
		const texts: ((bin: Bin) => string)[] = [];
		if (cost) texts.push(incCostText, totalCostText);
		if (tokens) texts.push(incTokText, totalTokText);
		const widths = texts.map((text) => Math.max(...displayedBins.map((bin) => text(bin).length), 1));
		let prefix = labelWidth + 2;
		for (const columnWidth of widths) prefix += columnWidth + 2;
		return { widths, prefix, bar: finalWidth - prefix - tickReserve };
	};
	let laid = layoutFor(showCost, showTokens);
	if (laid.bar < minBar && showTokens) {
		showTokens = false;
		laid = layoutFor(showCost, false);
	}
	if (laid.bar < minBar && showCost) {
		showCost = false;
		laid = layoutFor(false, showTokens);
	}
	const columnWidths = laid.widths;
	const prefixWidth = laid.prefix;
	const maxBarWidth = Math.max(0, laid.bar);

	const titleDateStr = formatMmmDdStr(displayedBins[0].dateStr);

	const widgetLines: string[] = [];
	
	const titleLeft = unit === "tokens"
		? (disabledEmoji ? "[#] WTF Tokens?" : "🔢 WTF Tokens?")
		: (disabledEmoji ? "[$] WTF Tokens?" : "💸 WTF Tokens?");
	
	const sessionSuffix = opts?.sessionNameSuffix ? ` \x1b[90m...${opts.sessionNameSuffix.replace(/.jsonl$/, "").slice(-4)}\x1b[0m` : "";
	const titleLeftFinal = titleLeft + sessionSuffix;
	
	const surgeHours = getSurgeLocalHours(tz, Date.now(), opts?.model);
	const currentHour = getCurrentLocalHour(tz);
	const proximity = checkSurgeProximity(Date.now(), opts?.model);
	const timelineStr = buildTimelineString(surgeHours, currentHour, proximity.status, undefined, disabledEmoji, proximity.multiplier);

	const legendItems = CATEGORY_ORDER
		.filter(c => CATEGORY_STYLE[c].label !== null)
		.map(c => `\x1b[38;5;${CATEGORY_STYLE[c].fg}m${CATEGORY_STYLE[c].char}\x1b[0m${CATEGORY_STYLE[c].label}`);
	const legendStr = legendItems.join(" ");

	widgetLines.push(titleLeftFinal + "  " + timelineStr);
	widgetLines.push(legendStr);

	if (scaleMax > 0) {
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

	const precomputedCells: Map<Bin, Record<Category, number>> = new Map();
	if (mode === "cumulative" && unit === "cost") {
		const chronological = [...displayedBins].reverse();
		let prevSlots: Record<Category, number> | null = null;
		for (const bin of chronological) {
			const cellWidth = scaleMax > 0 ? Math.round((bin.total_cost / scaleMax) * maxBarWidth) : 0;
			const slots = {} as Record<Category, number>;
			let allocated = 0;

			for (const cat of CATEGORY_ORDER) {
				const raw = scaleMax > 0 ? (bin.costs[cat] / scaleMax) * cellWidth : 0;
				slots[cat] = Math.floor(raw);
				allocated += slots[cat];
			}

			if (prevSlots) {
				let clampedTotal = 0;
				for (const cat of CATEGORY_ORDER) {
					if (prevSlots[cat] >= 1) slots[cat] = Math.max(slots[cat], prevSlots[cat]);
					clampedTotal += slots[cat];
				}
				let excess = clampedTotal - cellWidth;
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
				allocated = 0;
				for (const cat of CATEGORY_ORDER) allocated += slots[cat];
			}

			while (allocated < cellWidth && bin.total_cost > 0) {
				let maxDeficit = -Infinity;
				let maxCat: Category | null = null;
				for (const cat of CATEGORY_ORDER) {
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

	// Labelled "Miss" not "Expired": the usage block proves the re-prime happened,
	// but says nothing about why, and TTL is only one of the causes.
	// Drawn BELOW the missed row: rows are newest-first, so below is earlier in
	// time, between the missed turn and the older turns it could not reuse.
	const cacheMissLine = `\x1b[90m${buildDividerLine("Cache Miss")}\x1b[0m`;
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
			colored.push(`${color}${padString(text, columnWidths[widthIndex++])}\x1b[0m`);
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
			return surgeActive ? `${coloredLabel}${boltGap}${barStr}` : `${coloredLabel}  ${barStr}`;
		}
		if (colored.length === 1) return `${coloredLabel}${boltGap}${colored[0]}  ${barStr}`;
		return `${coloredLabel}  ${colored[0]}${boltGap}${colored.slice(1).join("  ")}  ${barStr}`;
	};

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
		const boltGap = surgeActive ? "\x1b[1;38;5;208m\u26A1\x1b[0m" : "  ";

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

			widgetLines.push(rowWithColumns(coloredLabel, surgeInc, costColor, boltGap, surgeActive, barStr, bin));
		} else {
			let barStr = "";
			if (mode === "cumulative") {
				const counts = precomputedCells.get(bin);
				for (const cat of CATEGORY_ORDER) {
					const n = counts?.[cat] ?? 0;
					if (n <= 0) continue;
					const fg = CATEGORY_STYLE[cat]?.fg ?? 245;
					barStr += `\x1b[38;5;${fg}m${"█".repeat(n)}\x1b[0m`;
				}
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
					} else {
						let best = entries[0];
						for (const entry of entries) if (entry.cost > best.cost) best = entry;
						const fg = CATEGORY_STYLE[best.cat].fg;
						barStr += `\x1b[38;5;${fg}m█\x1b[0m`;
					}
				}
			}

			widgetLines.push(rowWithColumns(coloredLabel, surgeInc, costColor, boltGap, surgeActive, barStr, bin));
		}
	}
	if (missed(displayedBins[displayedBins.length - 1])) widgetLines.push(cacheMissLine);

	if (otherWarning) widgetLines.push(otherWarning);

	if (unit === "tokens") {
		widgetLines.push(`\x1b[90m  \x1b[37m▃\x1b[0m\x1b[90m cached/carryover  \x1b[37m▇\x1b[0m\x1b[90m new/uncached  \x1b[90m\$ = cost-only (web tools)\x1b[0m`);
		if (tokenFooter) widgetLines.push(`\x1b[37m  ${tokenFooter}\x1b[0m`);
	}

	if (cacheLine) {
		widgetLines.push(`\x1b[90m  CH: ${cacheLine}\x1b[0m`);
	}

	return widgetLines;
}

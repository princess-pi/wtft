import { buildWtftLines, CATEGORY_ORDER, CATEGORY_STYLE } from "../../extensions/lib/wtft-renderer.ts";
import type { ChartWords } from "../../extensions/lib/wtft-chart.ts";
import { fairBooth, FAIR_ITEMS, FAIR_TZ, SOUVENIRS } from "./fair-session.ts";
import { withTerminal } from "./report.ts";
import { stripAnsi } from "./ansi.ts";

export interface FairState {
	columns: number;
	interval: string;
	limit: number;
	mode: "cumulative" | "bucket";
	unit: "cost" | "tokens";
	showCostColumns: boolean;
	showTokenColumns: boolean;
	timezone: string;
	souvenirs: boolean;
	now?: number;
}

/** One word the booth takes from the chart's default. */
export interface Substitution {
	id: string;
	says: string;
	becomes: string;
	/** How many lines of the first view carry the word the booth replaces. */
	count: number;
}

export interface FairPicture {
	/** The `buildWtftLines` call, as a caller writes it. */
	call: string;
	/** What the chart returns. */
	today: string[];
	/** The chart called again with the booth's own words. */
	generic: string[];
	/** Each thing the booth says in its own words, with how many lines of the first view carried wtft's. */
	substitutions: Substitution[];
}

const SESSION = "booth-0042.jsonl";

interface Word {
	id: string;
	says: string;
	becomes: string;
	/** Matches a line of the first view that carries what the word replaces. */
	seen: (line: string, index: number) => boolean;
}

const WORDS: Word[] = [
	{ id: "title", says: "💸 WTF Tokens? ...0042", becomes: "🍎 Booth 42", seen: (line) => /(💸|🔢|\[\$\]|\[#\]) WTF Tokens\?/.test(line) },
	{ id: "legend", says: "█Ovrhd █Waste █Plan … all 14 categories, named for wtft", becomes: "█Lattes █Apples … the booth's own items", seen: (line, index) => index === 1 && line.includes("Ovrhd") },
	{ id: "units", says: "2.2k tok", becomes: "2.2k pcs", seen: (line) => / tok\b|\d[kM]?t\b/.test(stripAnsi(line).trim().replace(/^\S+/, "")) },
	{ id: "key", says: "▃ earlier bins  ▇ this bin", becomes: "▃ sold earlier  ▇ sold this bin", seen: (line) => line.includes("earlier bins") },
	{ id: "footer", says: "↑2.2k", becomes: "(no line)", seen: (line) => /^\x1b\[37m {2}[↑↓R]/.test(line) },
	{ id: "cache-line", says: "CH: 0% cache hit (0 read / 2.2k total ops)", becomes: "(no line)", seen: (line) => /^\x1b\[90m {2}CH: /.test(line) },
	{ id: "miss", says: "Cache Miss", becomes: "Power cut", seen: (line) => line.includes("── Cache Miss ") },
	{ id: "warning", says: "⚠️  \"Other\" category: 24% of session cost ($4752.00). Run wtft --other to drill down.", becomes: "⚠️  Souvenirs: 24% of revenue ($4752.00).", seen: (line) => /"Other" category: \d+% of session cost/.test(line) },
];

/** The booth's own words for the chart. */
function boothWords(souvenirs: boolean): ChartWords {
	const items = souvenirs ? [...FAIR_ITEMS, SOUVENIRS] : FAIR_ITEMS;
	return {
		title: "🍎 Booth 42",
		categories: [...items]
			.sort((a, b) => CATEGORY_ORDER.indexOf(a.slot) - CATEGORY_ORDER.indexOf(b.slot))
			.map((item) => ({ slot: item.slot, label: item.label, fg: CATEGORY_STYLE[item.slot].fg })),
		tokenUnit: { name: "pcs", short: "p" },
		cacheMissLabel: "Power cut",
		key: { earlier: "sold earlier", thisBin: "sold this bin" },
		tokenFooter: false,
		cacheLine: false,
		otherWarning: "Souvenirs: {pct} of revenue ({cost}).",
	};
}

/** The fair's booth drawn twice through `buildWtftLines`: with the chart's own words, and with the booth's. */
export function renderFair(state: FairState): FairPicture {
	const interactions = fairBooth({ souvenirs: state.souvenirs });
	const width = Math.min(state.columns - 2, 1023);
	const options = {
		interval: state.interval,
		limit: state.limit,
		padRowsTo: state.limit,
		width,
		mode: state.mode,
		timezone: state.timezone,
		unit: state.unit,
		sessionNameSuffix: SESSION,
		showCostColumns: state.showCostColumns,
		showTokenColumns: state.showTokenColumns,
	};
	const today = withTerminal(state.columns, state.now, () => buildWtftLines(interactions, {
		interval: "1h", limit: 100, width, mode: "cumulative", timezone: undefined,
	}, options)) ?? [];

	const words = boothWords(state.souvenirs);
	const { sessionNameSuffix: _suffix, ...bare } = options;
	const generic = withTerminal(state.columns, state.now, () => buildWtftLines(interactions, {
		interval: "1h", limit: 100, width, mode: "cumulative", timezone: undefined,
	}, { ...bare, words })) ?? [];

	const call = [
		"buildWtftLines(sales, defaults, {",
		`  interval: ${JSON.stringify(state.interval)}, limit: ${state.limit}, padRowsTo: ${state.limit}, width: ${width},`,
		`  mode: ${JSON.stringify(state.mode)}, unit: ${JSON.stringify(state.unit)}, timezone: ${JSON.stringify(state.timezone)},`,
		`  sessionNameSuffix: ${JSON.stringify(SESSION)},`,
		`  showCostColumns: ${state.showCostColumns}, showTokenColumns: ${state.showTokenColumns},`,
		"})",
		"",
		"then again, without the session name and with the booth's words:",
		"buildWtftLines(sales, defaults, {",
		"  ...the same options,",
		`  words: ${JSON.stringify(words, null, 2).replace(/\n/g, "\n  ")},`,
		"})",
	].join("\n");

	return {
		call,
		today,
		generic,
		substitutions: WORDS.map(({ id, says, becomes, seen }) => ({ id, says, becomes, count: today.filter((line, index) => seen(line, index)).length })),
	};
}

export const FAIR_DEFAULTS: FairState = {
	columns: 160,
	interval: "1h",
	limit: 24,
	mode: "cumulative",
	unit: "cost",
	showCostColumns: true,
	showTokenColumns: true,
	timezone: FAIR_TZ,
	souvenirs: false,
};

import { buildWtftLines, CATEGORY_ORDER, CATEGORY_STYLE } from "../../extensions/lib/wtft-renderer.ts";
import { fairBooth, FAIR_ITEMS, FAIR_TZ, SOUVENIRS } from "./fair-session.ts";
import { withTerminal } from "./report.ts";

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

/** One place the chart says something only wtft means. */
export interface Substitution {
	id: string;
	says: string;
	becomes: string;
	/** How many lines it rewrote in this picture. */
	count: number;
}

export interface FairPicture {
	/** The `buildWtftLines` call, as a caller writes it. */
	call: string;
	/** What the chart returns. */
	today: string[];
	/** The same lines after the substitutions. */
	generic: string[];
	/** Each substitution, with how often it fired. */
	substitutions: Substitution[];
}

const SESSION = "booth-0042.jsonl";

function legendLine(souvenirs: boolean): string {
	const items = souvenirs ? [...FAIR_ITEMS, SOUVENIRS] : FAIR_ITEMS;
	return [...items]
		.sort((a, b) => CATEGORY_ORDER.indexOf(a.slot) - CATEGORY_ORDER.indexOf(b.slot))
		.map((item) => `\x1b[38;5;${CATEGORY_STYLE[item.slot].fg}m█\x1b[0m${item.label}`)
		.join(" ");
}

interface Rule {
	id: string;
	says: string;
	becomes: string;
	rewrite: (line: string, index: number, state: FairState) => string | null | undefined;
}

const RULES: Rule[] = [
	{
		id: "title",
		says: "💸 WTF Tokens? ...0042",
		becomes: "🍎 Booth 42",
		rewrite: (line) => /(💸|🔢|\[\$\]|\[#\]) WTF Tokens\?/.test(line)
			? line.replace(/(?:💸|🔢|\[\$\]|\[#\]) WTF Tokens\?(?: \x1b\[90m\.\.\.[^\x1b]*\x1b\[0m)?/, "🍎 Booth 42")
			: undefined,
	},
	{
		id: "legend",
		says: "█Ovrhd █Waste █Plan … all 14 categories, named for wtft",
		becomes: "█Lattes █Apples … the booth's own items",
		rewrite: (line, index, state) => index === 1 && line.includes("Ovrhd") ? legendLine(state.souvenirs) : undefined,
	},
	{
		id: "units",
		says: "2.2k tok",
		becomes: "2.2k pcs",
		rewrite: (line) => / tok(?= *\x1b)/.test(line) ? line.replace(/ tok(?= *\x1b)/g, " pcs") : undefined,
	},
	{
		id: "key",
		says: "▃ earlier bins  ▇ this bin",
		becomes: "▃ sold earlier  ▇ sold this bin",
		rewrite: (line) => line.includes("earlier bins")
			? "\x1b[90m  \x1b[37m▃\x1b[0m\x1b[90m sold earlier  \x1b[37m▇\x1b[0m\x1b[90m sold this bin\x1b[0m"
			: undefined,
	},
	{
		id: "footer",
		says: "↑2.2k",
		becomes: "(no line)",
		rewrite: (line) => /^\x1b\[37m {2}[↑↓R]/.test(line) ? null : undefined,
	},
	{
		id: "cache-line",
		says: "CH: 0% cache hit (0 read / 2.2k total ops)",
		becomes: "(no line)",
		rewrite: (line) => /^\x1b\[90m {2}CH: /.test(line) ? null : undefined,
	},
	{
		id: "miss",
		says: "Cache Miss",
		becomes: "Power cut",
		rewrite: (line) => line.includes("── Cache Miss ") ? line.replace("Cache Miss", "Power cut ") : undefined,
	},
	{
		id: "warning",
		says: "⚠️  \"Other\" category: 24% of session cost ($4752.00). Run wtft --other to drill down.",
		becomes: "⚠️  Souvenirs: 24% of revenue ($4752.00).",
		rewrite: (line) => {
			const m = /^\x1b\[1;33m⚠️ {2}"Other" category: (\d+%) of session cost \((\$[\d.,]+)\)\. Run wtft --other to drill down\.\x1b\[0m$/.exec(line);
			return m ? `\x1b[1;33m⚠️  Souvenirs: ${m[1]} of revenue (${m[2]}).\x1b[0m` : undefined;
		},
	},
];

/** The fair's booth drawn twice through `buildWtftLines`: as it comes back, and with `RULES` applied. */
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

	const counts = new Map<string, number>();
	const generic: string[] = [];
	today.forEach((line, index) => {
		let current: string | null = line;
		for (const rule of RULES) {
			if (current === null) break;
			const next = rule.rewrite(current, index, state);
			if (next === undefined) continue;
			counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
			current = next;
		}
		if (current !== null) generic.push(current);
	});

	const call = [
		"buildWtftLines(sales, defaults, {",
		`  interval: ${JSON.stringify(state.interval)}, limit: ${state.limit}, padRowsTo: ${state.limit}, width: ${width},`,
		`  mode: ${JSON.stringify(state.mode)}, unit: ${JSON.stringify(state.unit)}, timezone: ${JSON.stringify(state.timezone)},`,
		`  sessionNameSuffix: ${JSON.stringify(SESSION)},`,
		`  showCostColumns: ${state.showCostColumns}, showTokenColumns: ${state.showTokenColumns},`,
		"})",
	].join("\n");

	return {
		call,
		today,
		generic,
		substitutions: RULES.map(({ id, says, becomes }) => ({ id, says, becomes, count: counts.get(id) ?? 0 })),
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

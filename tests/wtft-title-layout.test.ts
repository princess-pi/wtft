#!/usr/bin/env -S npx tsx
/**
 * @package princess-pi-packages
 * @test wtft-title-layout
 * @description Strictly validates that the title row layout is consistent
 *   across all code paths (CLI cost, CLI tokens, CLI --watch, Pi widget)
 *   at narrow, medium, and wide terminal widths.
 *
 *   Invariant: the SURGE timeline (---◆---) MUST be on the title row
 *   (widgetLines[0]), never on its own row. If the legend doesn't fit
 *   alongside the title + timeline, the legend moves to row 1.
 */

import {
	buildWtftLines,
	type Interaction,
} from "../extensions/lib/wtft-shared.ts";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean) {
	if (ok) {
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} else {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		failed++;
	}
}

// ---
// Fixture: deepseek interactions so the SURGE timeline has colored segments
// (longer visual string — exercises the overflow case).
// ---
const now = Date.now();
const interactions: Interaction[] = [
	{
		timestamp: now - 3600_000,
		cost: 0.05,
		model: "deepseek-v4-pro",
		inputTokens: 10000, outputTokens: 500, cacheReadTokens: 500000,
		cacheWriteTokens: 0, reasoningTokens: 0,
		webSearchRequests: 0, webFetchRequests: 0, serverToolCost: 0,
		files: [{ path: "src/main.ts", action: "write" }],
		commands: [], texts: ["code change"]
	},
	{
		timestamp: now - 1800_000,
		cost: 0.02,
		model: "deepseek-v4-pro",
		inputTokens: 5000, outputTokens: 200, cacheReadTokens: 200000,
		cacheWriteTokens: 0, reasoningTokens: 0,
		webSearchRequests: 0, webFetchRequests: 0, serverToolCost: 0,
		files: [{ path: "docs/readme.md", action: "write" }],
		commands: [], texts: ["doc update"]
	},
];

const defaultSettings = {
	interval: "1h", limit: 10, width: 60,
	showTicks: true, mode: "cumulative" as const, timezone: "UTC",
};

// --- Helper: check if a row contains the legend ---
// The legend row has ANSI escapes between █ and the category names,
// so we check for "Spec" (first legend item) or the combined pattern.
function isLegendRow(line: string): boolean {
	return line.includes("Spec") && line.includes("Mixed") && line.includes("Code");
}

// --- Helper: run buildWtftLines with a controlled COLUMNS width ---
function renderAt(width: number, opts: {
	unit?: "cost" | "tokens";
	forceLegendRow?: boolean;
	sessionNameSuffix?: string;
}) {
	const prevCols = process.env.COLUMNS;
	process.env.COLUMNS = String(width);
	try {
		return buildWtftLines(interactions, defaultSettings, {
			width,
			unit: opts.unit ?? "cost",
			forceLegendRow: opts.forceLegendRow ?? false,
			sessionNameSuffix: opts.sessionNameSuffix,
		});
	} finally {
		if (prevCols !== undefined) process.env.COLUMNS = prevCols;
		else delete process.env.COLUMNS;
	}
}

// ---
// Test matrix: width × code path
// ---

const WIDTHS = [60, 120, 240] as const;
const CASES: { name: string; unit: "cost" | "tokens"; forceLegendRow: boolean; hasSuffix: boolean }[] = [
	{ name: "CLI cost",       unit: "cost",   forceLegendRow: false, hasSuffix: true  },
	{ name: "CLI tokens",     unit: "tokens", forceLegendRow: false, hasSuffix: true  },
	{ name: "CLI --watch",    unit: "cost",   forceLegendRow: true,  hasSuffix: false },
	{ name: "Pi widget",      unit: "cost",   forceLegendRow: true,  hasSuffix: true  },
	{ name: "Pi widget tok",  unit: "tokens", forceLegendRow: true,  hasSuffix: true  },
];

for (const width of WIDTHS) {
	for (const c of CASES) {
		const label = `${c.name} @ ${width} cols`;
		const suffix = c.hasSuffix ? "2026-07-12T18-41-22-949Z_019f57a2.jsonl" : undefined;
		const lines = renderAt(width, {
			unit: c.unit,
			forceLegendRow: c.forceLegendRow,
			sessionNameSuffix: suffix,
		});

		check(`${label}: produces output`, lines !== null && (lines?.length ?? 0) >= 2);
		if (!lines || lines.length < 2) continue;

		// --- INVARIANT 1: timeline on title row ---
		const titleRow = lines[0];
		check(`${label}: timeline on title row (contains ◆)`, titleRow.includes("◆"));

		// --- INVARIANT 2: timeline NOT on its own row ---
		// Check all non-title, non-legend rows for the timeline diamond
		let timelineOnOwnRow = false;
		for (let j = 1; j < lines.length; j++) {
			if (lines[j].includes("◆") && !isLegendRow(lines[j])) {
				timelineOnOwnRow = true;
				break;
			}
		}
		check(`${label}: timeline NOT on own row`, !timelineOnOwnRow);

		// --- INVARIANT 3: legend placement ---
		const legendOnTitle = isLegendRow(titleRow);
		const legendRow1 = isLegendRow(lines[1] ?? "");
		const legendRow2 = isLegendRow(lines[2] ?? "");

		if (c.forceLegendRow) {
			// forceLegendRow: legend ALWAYS on its own row (row 1 or 2)
			check(`${label}: legend NOT on title row (forceLegendRow)`, !legendOnTitle);
			check(`${label}: legend on own row (forceLegendRow)`, legendRow1 || legendRow2);
		} else if (width >= 240) {
			// Wide terminal, non-watch: legend SHOULD fit on title row
			check(`${label}: legend on title row (wide)`, legendOnTitle);
		} else if (width <= 60) {
			// Narrow terminal: legend must be on own row
			check(`${label}: legend on own row (narrow)`, legendRow1 || legendRow2);
		}
	}
}

// ---
// Prefix and suffix assertions
// ---
const s = "2026-07-12T18-41-22-949Z_019f57a2.jsonl";
const costLines = renderAt(120, { unit: "cost", sessionNameSuffix: s });
const tokenLines = renderAt(120, { unit: "tokens" });
check("cost mode title : 💸 WTF Tokens?", costLines?.[0]?.includes("💸 WTF Tokens?") ?? false);
check("token mode title: 🔢 WTF Tokens?", tokenLines?.[0]?.includes("🔢 WTF Tokens?") ?? false);

// Session suffix: basename=".../019f57a2.jsonl" → strip .jsonl, take last 4 → "57a2"
check("session suffix in title: ...57a2", costLines?.[0]?.includes("...57a2") ?? false);

// No suffix when not provided
const noSuffix = renderAt(120, { unit: "cost" });
check("no session suffix when omitted", !(noSuffix?.[0]?.includes("...") ?? false));

console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

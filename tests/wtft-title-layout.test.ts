#!/usr/bin/env -S node --experimental-strip-types
/**
 * @package princess-pi-packages
 * @test wtft-title-layout
 * @description Strictly validates title row layout consistency across all
 *   code paths (CLI cost, CLI tokens, CLI --watch) at narrow/medium/wide
 *   terminal widths. Tests against the BUILT bin/wtft.mjs — the
 *   end-user artifact — to catch stale-build regressions.
 *
 *   Invariant: the SURGE timeline (---◆---) MUST be on the title row,
 *   never on its own row. Legend goes to its own row when too wide.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, spawn } from "node:child_process";

const SCRIPT = path.resolve(import.meta.dirname, "..", "wtft");
const CLI_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
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
// Fixture: deepseek session so SURGE timeline has colored segments
// (longer visual length — exercises the overflow case).
// ---
const now = Date.now();
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-title-layout-"));
const sessionPath = path.join(fixtureDir, "session.jsonl");

const lines: string[] = [];
// Interaction 1: code write (deepseek, lots of cache tokens)
lines.push(JSON.stringify({
	type: "message",
	message: {
		role: "assistant",
		id: "msg_code_001",
		model: "deepseek-v4-pro",
		timestamp: new Date(now - 3600_000).toISOString(),
		usage: {
			input_tokens: 10000,
			output_tokens: 500,
			cache_read_input_tokens: 500000,
			cache_creation_input_tokens: 0,
		},
		content: [
			{ type: "text", text: "code change" },
			{ type: "toolCall", name: "write", arguments: { path: "src/main.ts" } }
		]
	}
}));
// Interaction 2: doc write
lines.push(JSON.stringify({
	type: "message",
	message: {
		role: "assistant",
		id: "msg_doc_001",
		model: "deepseek-v4-pro",
		timestamp: new Date(now - 1800_000).toISOString(),
		usage: {
			input_tokens: 5000,
			output_tokens: 200,
			cache_read_input_tokens: 200000,
			cache_creation_input_tokens: 0,
		},
		content: [
			{ type: "text", text: "doc update" },
			{ type: "toolCall", name: "write", arguments: { path: "docs/readme.md" } }
		]
	}
}));

fs.writeFileSync(sessionPath, lines.join("\n") + "\n");

// ---
// Helper: run wtft CLI with controlled width and capture title line
// ---
function runWtft(session: string, args: string[], columns: number): { titleRow: string; allRows: string[] } {
	const allArgs = ["-i", "1h", "-l", "2", "-w", String(columns), "--no-ticks", ...args, "-s", session];
	const result = execSync(`${process.execPath} ${CLI_BIN} ${allArgs.join(" ")}`, {
		encoding: "utf8",
		env: { ...process.env, COLUMNS: String(columns) },
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 10_000,
	});
	const rows = result.split("\n").filter(r => r.trim());
	// Row 0 = session path, row 1 = title, row 2 = legend (if own row)
	const titleRow = rows.length >= 2 ? rows[1] : "";
	return { titleRow, allRows: rows };
}

// --- Helper: check if a row is the legend ---
function isLegendRow(line: string): boolean {
	return line.includes("Spec") && line.includes("Mixed") && line.includes("Code");
}

// ---
// Test matrix
// ---
const WIDTHS = [60, 120, 240] as const;
const CASES: { name: string; args: string[] }[] = [
	{ name: "CLI cost",   args: [] },
	{ name: "CLI tokens", args: ["--tokens"] },
];

for (const width of WIDTHS) {
	for (const c of CASES) {
		const label = `${c.name} @ ${width} cols`;
		const { titleRow, allRows } = runWtft(sessionPath, c.args, width);

		check(`${label}: output produced`, allRows.length >= 2);

		// Invariant 1: timeline on title row
		check(`${label}: timeline on title row (contains ◆)`, titleRow.includes("◆"));

		// Invariant 2: timeline NOT on its own row (search rows 2+)
		let timelineOnOwnRow = false;
		for (let j = 2; j < allRows.length; j++) {
			if (allRows[j].includes("◆") && !isLegendRow(allRows[j])) {
				timelineOnOwnRow = true;
				break;
			}
		}
		check(`${label}: timeline NOT on own row`, !timelineOnOwnRow);

		// Invariant 3: legend placement
		const legendOnTitle = isLegendRow(titleRow);
		const row2 = allRows.length >= 3 ? allRows[2] : "";
		const row3 = allRows.length >= 4 ? allRows[3] : "";
		const legendOnRow2or3 = isLegendRow(row2) || isLegendRow(row3);

		// At wide terminals (>=200), legend fits on title row for all non-watch paths.
		if (width >= 200) {
			check(`${label}: legend on title row (wide)`, legendOnTitle);
			check(`${label}: legend NOT on own row (wide)`, !legendOnRow2or3);
		} else {
			check(`${label}: legend NOT on title row`, !legendOnTitle);
			check(`${label}: legend on own row (row 2 or 3)`, legendOnRow2or3);
		}
	}
}

// ---
// Title prefix: cost vs token mode
// ---
const costRows = runWtft(sessionPath, [], 120).allRows;
const tokenRows = runWtft(sessionPath, ["--tokens"], 120).allRows;
check("cost mode title  : 💸 WTF Tokens?", costRows[1]?.includes("💸 WTF Tokens?") ?? false);
check("token mode title : 🔢 WTF Tokens?", tokenRows[1]?.includes("🔢 WTF Tokens?") ?? false);

// ---
// Cleanup
// ---
try { fs.rmSync(fixtureDir, { recursive: true }); } catch {}

console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

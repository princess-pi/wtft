import { buildWtftLines, type Interaction } from "../extensions/lib/wtft-shared.ts";
import * as assert from "node:assert";

// 1. Create mock data matching Example 1 from the spec:
// Timestamp starts at Jun 20, 2026, 22:42 (using UTC to keep it stable)
const startTs = new Date("2026-06-20T22:42:00Z").getTime();

const mockInteractions: Interaction[] = [
	{
		timestamp: startTs,
		cost: 13.00, // Total cost is 13.00
		files: [
			{ path: "docs/spec.md", action: "write" }, // Spec
			{ path: "src/main.ts", action: "write" },  // Code
			{ path: "tests/main.test.ts", action: "write" } // Tests -> Mixed
		],
		commands: [],
		texts: []
	}
];

const width = 80;
const settings = {
	interval: "6m",
	limit: 5,
	width: width,
	showTicks: true,
	mode: "cumulative" as "cumulative" | "bucket",
	timezone: "UTC"
};

const lines = buildWtftLines(mockInteractions, settings);
if (!lines) {
	console.error("❌ Failed to render wtft lines.");
	process.exit(1);
}

// Helper to strip ANSI codes
function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

const cleanLines = lines.map(stripAnsi);

console.log("=== AUTOMATED SPEC ALIGNMENT TEST ===");
for (const line of cleanLines) {
	console.log(line);
}
console.log("=====================================");

const ticksRow = cleanLines[2]; // Index 2 is the ticks line (index 0 is title, index 1 is legend)
const firstBarRow = cleanLines[3]; // Index 3 is the first bar row

const firstDotIdx = ticksRow.indexOf(".");
const lastDotIdx = ticksRow.lastIndexOf(".");

// Find the end of the bar (either solid block or shaded block)
const lastBarCharIdx = Math.max(
	firstBarRow.lastIndexOf("█"),
	firstBarRow.lastIndexOf("░"),
	firstBarRow.lastIndexOf("▒")
);

// We need to find the actual start of the bar. It's the first non-space character
// after the timestamp, incremental cost, and total cost columns.
const barStartIdx = firstBarRow.search(/[^ ]/);
// Wait, the timestamp has non-space characters.
// We need to find the first character after the 3rd column.
// The easiest way is to find the index of the first '█', '░', or '▒'
const actualBarStart = Math.min(
	firstBarRow.indexOf("█") !== -1 ? firstBarRow.indexOf("█") : Infinity,
	firstBarRow.indexOf("░") !== -1 ? firstBarRow.indexOf("░") : Infinity,
	firstBarRow.indexOf("▒") !== -1 ? firstBarRow.indexOf("▒") : Infinity
);

console.log(`Ticks Row Length:      ${ticksRow.length}`);
console.log(`Bar Row Prefix Width:  ${actualBarStart}`);
console.log(`First Dot Align Index: ${firstDotIdx} (Expected: ${actualBarStart})`);
console.log(`Last Dot Align Index:  ${lastDotIdx} (Expected: ${lastBarCharIdx})`);

try {
	assert.strictEqual(ticksRow.length, width, "Ticks row length must match configured terminal width exactly");
	assert.strictEqual(firstDotIdx, actualBarStart, "The decimal point of the $0.00 label must perfectly align with the start of the bar");
	assert.strictEqual(lastDotIdx, lastBarCharIdx, "The decimal point of the maximum cost label must perfectly align with the end of the bar");
	console.log("\n✅ ALL ALIGNMENT CHECKS PASSED PERFECTLY!");
} catch (err: any) {
	console.error(`\n❌ ALIGNMENT CHECK FAILED: ${err.message}`);
	process.exit(1);
}

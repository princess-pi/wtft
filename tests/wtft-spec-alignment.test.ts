import { buildWtftLines, type Interaction } from "../extensions/lib/wtft-shared.ts";
import * as assert from "node:assert";

// Helper to strip ANSI codes
function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

// 1. Create mock data matching Example 1 from the spec:
// Timestamp starts at Jun 20, 2026, 22:42 (using UTC to keep it stable)
const startTs = new Date("2026-06-20T22:42:00Z").getTime();

const mockInteractions: Interaction[] = [
	{
		timestamp: startTs,
		cost: 13.00, // First bin cost is 13.00
		files: [
			{ path: "docs/spec.md", action: "write" }, // Spec
			{ path: "src/main.ts", action: "write" },  // Code
			{ path: "tests/main.test.ts", action: "write" } // Tests -> Mixed
		],
		commands: [],
		texts: []
	},
	{
		timestamp: startTs - 3600000, // 1 hour earlier
		cost: 5.00, // Second bin cost is 5.00
		files: [
			{ path: "src/main.ts", action: "write" } // Code
		],
		commands: [],
		texts: []
	}
];

const width = 80;
console.log("=== RUNNING CUMULATIVE ALIGNMENT TESTS ===");
runAlignmentTest("cumulative");

console.log("\n=== RUNNING BUCKET ALIGNMENT TESTS ===");
runAlignmentTest("bucket");

function runAlignmentTest(mode: "cumulative" | "bucket") {
	const settings = {
		interval: "1h",
		limit: 5,
		width: width,
		showTicks: true,
		mode: mode,
		timezone: "UTC"
	};

	const lines = buildWtftLines(mockInteractions, settings);
	if (!lines) {
		console.error("❌ Failed to render wtft lines.");
		process.exit(1);
	}

	const cleanLines = lines.map(stripAnsi);

	for (const line of cleanLines) {
		console.log(line);
	}
	console.log("-------------------------------------");

	// Find the ticks row (the one starting with "──" or containing "$0.00")
	const ticksRow = cleanLines.find(l => l.includes("$0.00")) || "";
	// The bar rows are the ones starting with time (e.g. "22:00", "21:00")
	const barRows = cleanLines.filter(l => /^[0-9]{2}:[0-9]{2}/.test(l));

	if (!ticksRow || barRows.length === 0) {
		console.error("❌ Failed to find ticks line or bar lines in the output.");
		process.exit(1);
	}

	const firstBarRow = barRows[0]; // Newest/highest value bar row

	const firstDotIdx = ticksRow.indexOf(".");
	const lastDotIdx = ticksRow.lastIndexOf(".");

	// Find the end of the first bar (either solid block or shaded block)
	const lastBarCharIdx = Math.max(
		firstBarRow.lastIndexOf("█"),
		firstBarRow.lastIndexOf("░"),
		firstBarRow.lastIndexOf("▒")
	);

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
		console.log(`✅ ${mode.toUpperCase()} ALIGNMENT CHECKS PASSED PERFECTLY!`);
	} catch (err: any) {
		console.error(`\n❌ ${mode.toUpperCase()} ALIGNMENT CHECK FAILED: ${err.message}`);
		process.exit(1);
	}
}

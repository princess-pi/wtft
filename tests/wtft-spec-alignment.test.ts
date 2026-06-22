import { buildWtftLines, type Interaction, parseEntryToInteraction, classifyInteraction } from "../extensions/lib/wtft-shared.ts";
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
		if (mode === "cumulative") {
			assert.strictEqual(firstDotIdx, actualBarStart, "The decimal point of the $0.00 label must perfectly align with the start of the bar");
			assert.strictEqual(lastDotIdx, lastBarCharIdx, "The decimal point of the maximum cost label must perfectly align with the end of the bar");
		} else {
			// Bucket mode: verify that the $0.00 dot aligns with prefixWidth
			assert.strictEqual(firstDotIdx, 15, "The decimal point of the $0.00 label must perfectly align with prefixWidth (15)");
			
			// Verify that the newest bin's Mixed work character '▒' is exactly on the maximum tick (index 76)
			assert.strictEqual(firstBarRow.indexOf("▒"), 76, "The point-of-spend marker '▒' for the max cost bin must reside exactly at index 76");
			
			// Verify that the older bin's Code work character '█' is located at the $5.00 point on the scale.
			// Scale max is $13.00. Cost is $5.00. 
			// maxBarWidth = 80 - 15 - 3 = 62.
			// pos = Math.round((5 / 13) * (62 - 1)) = Math.round(0.3846 * 61) = Math.round(23.46) = 23.
			// Absolute index = prefixWidth (15) + 23 = 38.
			const secondBarRow = barRows[1];
			assert.strictEqual(secondBarRow.indexOf("█"), 38, "The point-of-spend marker '█' for the $5.00 bin must reside exactly at index 38");
		}
		console.log(`✅ ${mode.toUpperCase()} ALIGNMENT CHECKS PASSED PERFECTLY!`);
	} catch (err: any) {
		console.error(`\n❌ ${mode.toUpperCase()} ALIGNMENT CHECK FAILED: ${err.message}`);
		process.exit(1);
	}
}

// ---
// MOCK PI SCHEMA 'BASH CAT' TEST
// ---
console.log("\n=== RUNNING PI SCHEMA BASH CAT HEURISTIC TEST ===");
const mockPiEntry = {
	type: "message",
	timestamp: "2026-06-20T22:42:00Z",
	message: {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				name: "bash",
				arguments: {
					command: "cat docs/EXT_WTFT.html"
				}
			}
		],
		usage: {
			cost: {
				total: 1.50
			}
		}
	}
};

const parsed = parseEntryToInteraction(mockPiEntry);
try {
	assert.ok(parsed, "Parsed interaction must not be null");
	assert.strictEqual(parsed.files.length, 1, "Must extract 1 file read from Pi bash cat command");
	assert.strictEqual(parsed.files[0].path, "docs/EXT_WTFT.html", "Extracted path must be docs/EXT_WTFT.html");
	assert.strictEqual(parsed.files[0].action, "read", "Action must be read");
	
	const classification = classifyInteraction(parsed);
	assert.strictEqual(classification, "spec", "Interaction reading docs/ must be classified as 'spec' instead of 'other'");
	console.log("✅ PI SCHEMA BASH CAT PARSING AND TAXONOMY TEST PASSED PERFECTLY!");
} catch (err: any) {
	console.error(`❌ PI SCHEMA BASH CAT TEST FAILED: ${err.message}`);
	process.exit(1);
}

// ---
// MOCK PI SCHEMA 'NODE_MODULES RESEARCH' TEST
// ---
console.log("\n=== RUNNING PI SCHEMA NODE_MODULES RESEARCH TEST ===");
const mockPiNodeModulesEntry = {
	type: "message",
	timestamp: "2026-06-20T22:42:00Z",
	message: {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				name: "bash",
				arguments: {
					command: "cat ~/.nvm/versions/node/v22.22.3/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md"
				}
			}
		],
		usage: {
			cost: {
				total: 1.50
			}
		}
	}
};

const parsedNodeModules = parseEntryToInteraction(mockPiNodeModulesEntry);
try {
	assert.ok(parsedNodeModules, "Parsed node_modules interaction must not be null");
	assert.strictEqual(parsedNodeModules.files.length, 1, "Must extract 1 file read from node_modules bash cat command");
	
	const classification = classifyInteraction(parsedNodeModules);
	assert.strictEqual(classification, "research", "Interaction reading platform docs inside node_modules/ must be classified as 'research' instead of 'spec'");
	console.log("✅ PI SCHEMA NODE_MODULES RESEARCH CLASSIFICATION TEST PASSED PERFECTLY!");
} catch (err: any) {
	console.error(`❌ PI SCHEMA NODE_MODULES RESEARCH TEST FAILED: ${err.message}`);
	process.exit(1);
}

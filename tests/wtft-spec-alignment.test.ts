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

// ---
// MOCK PI SCHEMA 'HEREDOC WRITE' TEST
// ---
console.log("\n=== RUNNING PI SCHEMA HEREDOC WRITE HEURISTIC TEST ===");
const mockPiHeredocEntry = {
	type: "message",
	timestamp: "2026-06-20T22:42:00Z",
	message: {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				name: "bash",
				arguments: {
					command: "cat << 'EOF' > debug/strip-ts.mjs\nconsole.log('hi');\nEOF"
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

const parsedHeredoc = parseEntryToInteraction(mockPiHeredocEntry);
try {
	assert.ok(parsedHeredoc, "Parsed heredoc interaction must not be null");
	assert.strictEqual(parsedHeredoc.files.length, 1, "Must extract 1 file write from heredoc");
	assert.strictEqual(parsedHeredoc.files[0].path, "debug/strip-ts.mjs", "Extracted path must be debug/strip-ts.mjs");
	assert.strictEqual(parsedHeredoc.files[0].action, "write", "Action must be 'write' instead of 'read' for heredoc redirection");
	
	const classification = classifyInteraction(parsedHeredoc);
	assert.strictEqual(classification, "code", "Heredoc writing code to debug/ must be classified as 'code'");
	console.log("✅ PI SCHEMA HEREDOC WRITE TEST PASSED PERFECTLY!");
} catch (err: any) {
	console.error(`❌ PI SCHEMA HEREDOC WRITE TEST FAILED: ${err.message}`);
	process.exit(1);
}

// ---
// MOCK PI SCHEMA 'BARE FILE READ' TEST
// ---
console.log("\n=== RUNNING PI SCHEMA BARE FILE READ TAXONOMY TEST ===");
const mockPiBareEntry = {
	type: "message",
	timestamp: "2026-06-20T22:42:00Z",
	message: {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				name: "bash",
				arguments: {
					command: "cat wtft"
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

const parsedBare = parseEntryToInteraction(mockPiBareEntry);
try {
	assert.ok(parsedBare, "Parsed bare file interaction must not be null");
	assert.strictEqual(parsedBare.files.length, 1, "Must extract 1 file read from bare file command");
	assert.strictEqual(parsedBare.files[0].path, "wtft", "Extracted path must be wtft");
	
	const classification = classifyInteraction(parsedBare);
	assert.strictEqual(classification, "code", "Bare wrapper files with no extension must be classified as 'code'");
	console.log("✅ PI SCHEMA BARE FILE READ TAXONOMY TEST PASSED PERFECTLY!");
} catch (err: any) {
	console.error(`❌ PI SCHEMA BARE FILE READ TEST FAILED: ${err.message}`);
	process.exit(1);
}

// ---
// MOCK PI SCHEMA 'JSONL AND DEBUG' TAXONOMY TEST
// ---
console.log("\n=== RUNNING PI SCHEMA JSONL AND DEBUG TAXONOMY TEST ===");
const mockPiJsonlEntry = {
	type: "message",
	timestamp: "2026-06-20T22:42:00Z",
	message: {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				name: "bash",
				arguments: {
					command: "cat ~/.claude/projects/test/sessions/session-1.jsonl"
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

const parsedJsonl = parseEntryToInteraction(mockPiJsonlEntry);
try {
	assert.ok(parsedJsonl, "Parsed JSONL interaction must not be null");
	assert.strictEqual(parsedJsonl.files[0].path, "~/.claude/projects/test/sessions/session-1.jsonl", "Extracted path must match");
	
	const classification = classifyInteraction(parsedJsonl);
	assert.strictEqual(classification, "code", "Session log JSONL files must be classified as 'code'");
	console.log("✅ PI SCHEMA JSONL TEST PASSED PERFECTLY!");
} catch (err: any) {
	console.error(`❌ PI SCHEMA JSONL TEST FAILED: ${err.message}`);
	process.exit(1);
}

const mockPiDebugEntry = {
	type: "message",
	timestamp: "2026-06-20T22:42:00Z",
	message: {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				name: "bash",
				arguments: {
					command: "cat << 'EOF' > debug/issue-body.txt\nissue outline\nEOF"
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

const parsedDebug = parseEntryToInteraction(mockPiDebugEntry);
try {
	assert.ok(parsedDebug, "Parsed debug interaction must not be null");
	assert.strictEqual(parsedDebug.files[0].path, "debug/issue-body.txt", "Extracted path must be debug/issue-body.txt");
	
	const classification = classifyInteraction(parsedDebug);
	assert.strictEqual(classification, "code", "Diagnostic files under debug/ must be classified as 'code'");
	console.log("✅ PI SCHEMA DEBUG FILES TEST PASSED PERFECTLY!");
} catch (err: any) {
	console.error(`❌ PI SCHEMA DEBUG FILES TEST FAILED: ${err.message}`);
	process.exit(1);
}

// ---
// EMOJI TOGGLE TEST
// ---
console.log("\n=== RUNNING WTFT EMOJI TOGGLE TESTS ===");
const settingsWithEmoji = {
	interval: "1h",
	limit: 5,
	width: 80,
	showTicks: true,
	mode: "cumulative" as const,
	timezone: "UTC",
	disabledEmoji: false
};

const settingsNoEmoji = {
	interval: "1h",
	limit: 5,
	width: 80,
	showTicks: true,
	mode: "cumulative" as const,
	timezone: "UTC",
	disabledEmoji: true
};

const linesWithEmoji = buildWtftLines(mockInteractions, settingsWithEmoji);
const linesNoEmoji = buildWtftLines(mockInteractions, settingsNoEmoji);

try {
	assert.ok(linesWithEmoji);
	assert.ok(linesNoEmoji);
	assert.ok(linesWithEmoji[0].includes("💸"), "Header must contain 💸 emoji");
	assert.ok(linesNoEmoji[0].includes("[$]"), "Header must contain [$] placeholder when emojis are disabled");
	console.log("✅ WTFT EMOJI TOGGLE TESTS PASSED PERFECTLY!");
} catch (err: any) {
	console.error(`❌ WTFT EMOJI TOGGLE TESTS FAILED: ${err.message}`);
	process.exit(1);
}

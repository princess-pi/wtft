import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";
import { 
	buildWtftLines, 
	parseEntryToInteraction, 
	getTerminalWidth,
} from "../bin/wtft.mjs";
import type { Interaction } from "../extensions/lib/wtft-shared.ts";

// Helper to strip ANSI escape codes
function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

console.log("🚀 STARTING AUTOMATED WTFT AUTO-FIT & SCHEMAS TESTS...");

// ---
// 1. IMPROVED MOCK DATA WITH GEMINI & CLAUDE
// ---

const startTs = new Date("2026-06-22T12:00:00Z").getTime();

// Define mock interactions with realistic values including Gemini Option B schema
const mockInteractions: Interaction[] = [
	{
		timestamp: startTs,
		cost: 1.25,
		files: [{ path: "src/main.ts", action: "write" }],
		commands: [],
		texts: ["Implementing auto-fit features"]
	},
	{
		timestamp: startTs - 1800000, // 30 mins ago
		cost: 0.75,
		files: [{ path: "tests/main.test.ts", action: "write" }],
		commands: [],
		texts: ["Writing tests"]
	}
];

// ---
// 2. AUTOMATE TESTS FOR /WTFT WIDGET VERSION (SIMULATION)
// ---
console.log("\n🧪 Test 1: Widget Auto-Fit Clamping");

const defaultSettings = {
	interval: "1h",
	limit: 10,
	width: 240, // Reset persisted width to 240 max
	showTicks: true,
	mode: "cumulative" as "cumulative" | "bucket",
	timezone: "UTC"
};

const widgetLines = buildWtftLines(mockInteractions, defaultSettings, { isWidget: true, width: 240 });
assert.ok(widgetLines, "Widget rendering should succeed");

const cleanWidgetLines = widgetLines.map(stripAnsi);
const widgetTermWidth = getTerminalWidth(true); // terminal width - 4

console.log(`Configured width: 240`);
console.log(`Active widget terminal width (isWidget = true): ${widgetTermWidth}`);

// Find the ticks line and day changers
const ticksLine = cleanWidgetLines.find(l => l.includes("$0.00"));
assert.ok(ticksLine, "Should render ticks line");
console.log(`Ticks line length: ${ticksLine.length} (Expected: <= ${widgetTermWidth})`);

// Ensure it didn't overflow the active terminal width
assert.ok(ticksLine.length <= widgetTermWidth, `Ticks line length (${ticksLine.length}) exceeds widget terminal width limit (${widgetTermWidth})!`);

// ---
// 3. AUTOMATE TESTS FOR CLI VERSION OF WTFT
// ---
console.log("\n🧪 Test 2: CLI Auto-Fit Clamping & execution");

// Prepare a mock JSONL log file to test the CLI
const tempDir = path.join(process.cwd(), "tmp");
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
const tempLogFile = path.join(tempDir, "mock-session.jsonl");

const mockJsonlLines = [
	// Gemini Option B format
	JSON.stringify({
		type: "message",
		timestamp: "2026-06-22T11:45:00.000Z",
		message: { role: "assistant", content: [] },
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-flash-latest",
		usage: {
			input: 8500,
			output: 400,
			cacheRead: 25000,
			totalTokens: 33900,
			cost: { total: 0.020 }
		}
	}),
	// Claude format
	JSON.stringify({
		type: "message",
		timestamp: "2026-06-22T12:00:00.000Z",
		message: {
			role: "assistant",
			content: [],
			model: "claude-3-5-sonnet-20241022",
			usage: {
				input_tokens: 5000,
				output_tokens: 300
			}
		}
	})
];

fs.writeFileSync(tempLogFile, mockJsonlLines.join("\n") + "\n", "utf8");

// Run the compiled CLI wtft.mjs binary against the temp log file with width 240
try {
	const cliTermWidth = getTerminalWidth(false);
	console.log(`Executing CLI wtft.mjs with mock log... (Max Width: 240, Terminal Limit: ${cliTermWidth})`);
	const cliStdout = execSync(`node bin/wtft.mjs -s ${tempLogFile} -w 240`, { encoding: "utf8" });
	
	const cliLines = cliStdout.split("\n").filter(Boolean).map(stripAnsi);
	const cliTicksLine = cliLines.find(l => l.includes("$0.00"));
	
	assert.ok(cliTicksLine, "CLI rendering should have ticks line");
	console.log(`CLI Ticks line length: ${cliTicksLine.length} (Expected: <= ${cliTermWidth})`);
	
	// Ensure it didn't overflow active CLI terminal width
	assert.ok(cliTicksLine.length <= cliTermWidth, `CLI Ticks line length (${cliTicksLine.length}) exceeds CLI terminal width limit (${cliTermWidth})!`);
	
	// Check if date change divider is also aligned
	const cliDayDivider = cliLines.find(l => l.includes("── Jun-22"));
	if (cliDayDivider) {
		console.log(`CLI Day Divider length: ${cliDayDivider.length} (Expected: <= ${cliTermWidth})`);
		assert.ok(cliDayDivider.length <= cliTermWidth, `CLI Day Divider exceeds terminal width limit!`);
	}
	
	console.log("✅ CLI auto-fit and execution test passed!");
} catch (err: any) {
	console.error(`❌ CLI test failed: ${err.message}`);
	process.exit(1);
} finally {
	// Clean up
	if (fs.existsSync(tempLogFile)) {
		fs.unlinkSync(tempLogFile);
	}
}

console.log("\n🎉 ALL AUTO-FIT AND COMPREHENSIVE TESTS PASSED PERFECTLY!");

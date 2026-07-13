#!/usr/bin/env -S npx tsx
/**
 * @package princess-pi-packages
 * @test wtft-watch-vs-nonwatch-render-parity
 * @description Compares the bar chart output between non-watch and --watch
 *   (immediate 'q') modes to catch rendering divergence. The bar segments,
 *   tick labels, costs, and legend should be identical — only the daemon
 *   status indicator and footer line differ.
 *
 *   Regression guard for DRY violations like forceLegendRow causing
 *   different title/legend layout between the two paths.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawn } from "node:child_process";

const SCRIPT = path.resolve(import.meta.dirname, "..", "wtft");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function assert(label: string, ok: boolean) {
	if (ok) {
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} else {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		failed++;
	}
}

// ---
// Fixture: a session with multiple interactions across different categories
// ---

const SESSION_ID = "fixture-watch-render-parity";
const MSG_1 = "msg_render_001";
const MSG_2 = "msg_render_002";
const TS = Date.now();

function makeFixture(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-render-parity-"));
	const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);

	const lines = [
		// Message 1: read spec, write code (spec + code mixed)
		JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				id: MSG_1,
				model: "claude-sonnet-4-20250514",
				timestamp: new Date(TS - 1800000).toISOString(), // 30 min ago
				usage: { input_tokens: 2000, output_tokens: 500 },
				content: [
					{ type: "tool_use", name: "read", input: { file_path: "docs/spec.md" } },
					{ type: "tool_use", name: "write", input: { file_path: "src/main.ts" } },
				],
			},
		}),
		// Message 2: git + grep (git category)
		JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				id: MSG_2,
				model: "claude-sonnet-4-20250514",
				timestamp: new Date(TS - 1200000).toISOString(), // 20 min ago
				usage: { input_tokens: 500, output_tokens: 200 },
				content: [
					{ type: "tool_use", name: "bash", input: { command: "git diff --stat" } },
				],
			},
		}),
	];
	fs.writeFileSync(sessionPath, lines.join("\n") + "\n");
	return sessionPath;
}

// ---
// Helpers
// ---

/**
 * Strip ANSI escape sequences from a string so we can compare content.
 */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Extract bar-content lines (ticks + bars) from watch or non-watch output.
 * Excludes the path line, title, legend, and footer — those may differ in
 * layout (inline vs separate row) due to forceLegendRow / daemon status.
 *
 * Keeps lines with:
 *   ── tick scale lines, bar segments (█ ░ ▓ ▒), cost labels.
 */
function extractBarLines(output: string): string[] {
	const rawLines = output.split("\n").filter(l => l.trim());

	return rawLines.filter(l => {
		const s = stripAnsi(l);
		if (s.includes("WTF Tokens")) return false;
		if (s.includes(".jsonl")) return false;
		if (s.includes("'q' to exit")) return false;
		return l.includes("\u2500") || l.includes("\u2588") || l.includes("\u2591") ||
		       l.includes("\u2593") || l.includes("\u2592") ||
		       /\d+:\d+/.test(s) || s.includes("$");
	});
}

// ---
// Test
// ---

const sessionPath = makeFixture();

// 1. Non-watch output
console.log("1. Capture non-watch output");
const nonWatchResult = execSync(
	`${SCRIPT} -s '${sessionPath}' -l 2 -i 30m --no-emoji`,
	{ encoding: "utf8", timeout: 10000 }
);
const nonWatchLines = extractBarLines(nonWatchResult);
assert("non-watch produces chart lines", nonWatchLines.length >= 3);

// 2. --watch output (immediate q)
console.log("\n2. Capture --watch output (immediate q)");

const watchResult = await new Promise<string>((resolve, reject) => {
	const s = spawn(
		"script",
		["-q", "-c", `${SCRIPT} --watch -s '${sessionPath}' -l 2 -i 30m --no-emoji 2>&1`, "/dev/null"],
		{ stdio: ["pipe", "pipe", "pipe"] }
	);

	let output = "";
	s.stdout.on("data", (d: Buffer) => { output += d.toString(); });
	s.stderr.on("data", (d: Buffer) => { output += d.toString(); });

	// Send 'q' after the chart renders
	setTimeout(() => { s.stdin.write("q"); }, 1500);

	const timer = setTimeout(() => {
		s.kill();
		assert("--watch did not time out", false);
		resolve(output);
	}, 10000);

	s.on("exit", (code) => {
		clearTimeout(timer);
		if (code !== 0) {
			assert(`--watch exit code ${code} (expected 0)`, false);
		}
		resolve(output);
	});
	s.on("error", reject);
});

const watchLines = extractBarLines(watchResult);
assert("watch produces chart lines", watchLines.length >= 3);

// 3. Compare bar chart lines (ticks + bars — layout-invariant content)
console.log("\n3. Compare bar content (ticks + bars — identical between paths)");

// Compare tick line: find lines with ── (deduplicate for watch exit reprint)
const nonWatchTicks = [...new Set(nonWatchLines.filter(l => l.includes("\u2500")).map(stripAnsi).map(s => s.trim()))];
const watchTicks = [...new Set(watchLines.filter(l => l.includes("\u2500")).map(stripAnsi).map(s => s.trim()))];
assert("both have tick lines", nonWatchTicks.length > 0 && watchTicks.length > 0);

// Tick date labels should match
if (nonWatchTicks.length > 0 && watchTicks.length > 0) {
	const nwDate = nonWatchTicks[0].replace(/\$\d+\.\d+/g, "$").trim();
	const wDate = watchTicks[0].replace(/\$\d+\.\d+/g, "$").trim();
	assert("tick date labels match", nwDate === wDate);
}

// Compare bar lines: find lines with time labels (HH:MM) + bar characters
// Lines start with ANSI color codes and optional whitespace, so match
// time pattern anywhere. Deduplicate because watch exit handler re-prints.
const nonWatchBars = [...new Set(nonWatchLines.filter(l => {
	const s = stripAnsi(l);
	return /(^|\s)\d+:\d+/.test(s) && (l.includes("\u2588") || l.includes("\u2591"));
}).map(stripAnsi).map(s => s.trim()))];
const watchBars = [...new Set(watchLines.filter(l => {
	const s = stripAnsi(l);
	return /(^|\s)\d+:\d+/.test(s) && (l.includes("\u2588") || l.includes("\u2591"));
}).map(stripAnsi).map(s => s.trim()))];

assert("same number of bar lines", nonWatchBars.length === watchBars.length);

if (nonWatchBars.length === watchBars.length) {
	for (let i = 0; i < nonWatchBars.length; i++) {
		const nwParts = nonWatchBars[i].trim().split(/\s+/);
		const wParts = watchBars[i].trim().split(/\s+/);
		assert(`bar ${i} time label matches`, nwParts[0] === wParts[0]);
		const nwCost = nwParts.find((p: string) => p.startsWith("$") || p.startsWith("+$"));
		const wCost = wParts.find((p: string) => p.startsWith("$") || p.startsWith("+$"));
		assert(`bar ${i} cost label matches`, nwCost === wCost);
	}
}

// 4. Legend categories are present in both outputs (layout may differ)
console.log("\n4. Legend categories appear in both outputs");
const nonWatchAll = stripAnsi(nonWatchResult);
const watchAll = stripAnsi(watchResult);

// Workflow order, mixed removed (#52 amendment 2)
const legendCats = ["Plan", "Spec", "Research", "Web", "Grep", "Code", "Tests", "Git", "Agents", "Prompt", "Other"];
for (const cat of legendCats) {
	assert(
		`"${cat}" in non-watch output`,
		nonWatchAll.includes(cat)
	);
	assert(
		`"${cat}" in watch output`,
		watchAll.includes(cat)
	);
}

// Cleanup
try {
	fs.rmSync(path.dirname(sessionPath), { recursive: true, force: true });
} catch {}

// ---
// Results
// ---
console.log("\n──────────────────────────────");
console.log(
	`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`
);
process.exit(failed > 0 ? 1 : 0);

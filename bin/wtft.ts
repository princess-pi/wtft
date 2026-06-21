#!/usr/bin/env -S node --experimental-strip-types
/**
 * @package princess-pi-packages
 * @command wtft
 * @description Command-line cost auditing tool for Pi Coding Agent session logs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	buildWtftLines,
	parseEntryToInteraction,
	type Interaction,
	type Category
} from "../extensions/lib/wtft-shared.ts";

// ---
// DEFAULT CONFIG
// ---

let intervalStr = "1h";
let limit = 100; // Large default for CLI
let width = 80;
let mode: "bucket" | "cumulative" = "cumulative";
let showTicks = true;
let targetSessionPath: string | undefined = undefined;
let timezone: string | undefined = undefined;
let harnessOption: "auto" | "pi" | "claude-code" = "auto";

// ---
// HELP MENU
// ---

function printHelp() {
	console.log(`
Usage: wtft [options]

Options:
  -s, --session <path>    Specify an explicit session .jsonl log file path (defaults to latest active session).
  --harness <type>        Target a specific harness for auto-discovery (pi, claude-code, or auto). Default: auto.
  -i, --interval <val>    Group cost data into binned intervals (e.g., 1m, 7m, 4h, 1d, 2w; default: 1h).
  -l, --limit <number>    Limit the number of interval bars displayed (default: 100).
  -w, --width <number>    Set the maximum character width of the CLI output (default: 80).
  -c, --cumulative        Render running cumulative sums (default behavior).
  -b, --bucket            Render discrete binned interval cost buckets.
  --ticks                 Enable the proportional cost scale ticks above the bars (default behavior).
  --no-ticks              Disable the proportional cost scale ticks above the bars.
  -t, --tz <zone>         Specify a display timezone (e.g. America/Los_Angeles).
  -h, --help              Display this help menu.
`);
}

// ---
// ARGUMENT PARSING
// ---

for (let i = 2; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (arg === "-h" || arg === "--help") {
		printHelp();
		process.exit(0);
	} else if (arg === "-s" || arg === "--session") {
		targetSessionPath = process.argv[++i];
	} else if (arg === "-i" || arg === "--interval") {
		intervalStr = process.argv[++i];
	} else if (arg === "-l" || arg === "--limit") {
		limit = parseInt(process.argv[++i], 10);
	} else if (arg === "-w" || arg === "--width") {
		width = parseInt(process.argv[++i], 10);
	} else if (arg === "-c" || arg === "--cumulative") {
		mode = "cumulative";
	} else if (arg === "-b" || arg === "--bucket") {
		mode = "bucket";
	} else if (arg === "--no-ticks") {
		showTicks = false;
	} else if (arg === "--ticks") {
		showTicks = true;
	} else if (arg === "-t" || arg === "--tz") {
		timezone = process.argv[++i];
	} else if (arg === "--harness") {
		const val = process.argv[++i];
		if (val === "pi" || val === "claude-code" || val === "auto") {
			harnessOption = val;
		}
	}
}

// ---
// SESSION AUTO-DISCOVERY
// ---

function findLatestSession(harness: "pi" | "claude-code" | "auto" = "auto"): string | null {
	const piSessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
	
	// We dynamically locate the current project's Claude Code session directory
	// Claude maps ~/.claude/projects/<slug>/sessions/
	let claudeSessionsDir: string | null = null;
	const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
	if (fs.existsSync(claudeProjectsDir)) {
		// Replace / or \ with - for the project slug, similar to how Claude encodes it
		const cwdSlug = process.cwd().replace(/[/\\\\]/g, "-");
		const possibleDir = path.join(claudeProjectsDir, cwdSlug, "sessions");
		// Fallback: If Claude Code is tracking this repo, the .jsonl files might just be directly inside the project root folder in .claude
		const alternativeDir = path.join(claudeProjectsDir, cwdSlug);
		if (fs.existsSync(possibleDir)) claudeSessionsDir = possibleDir;
		else if (fs.existsSync(alternativeDir)) claudeSessionsDir = alternativeDir;
	}

	let newestFile: string | null = null;
	let newestMtime = 0;

	// Recursively walk through session worktrees
	const walk = (dir: string) => {
		const files = fs.readdirSync(dir);
		for (const f of files) {
			const fullPath = path.join(dir, f);
			const stat = fs.statSync(fullPath);
			if (stat.isDirectory()) {
				walk(fullPath);
			} else if (f.endsWith(".jsonl")) {
				if (stat.mtimeMs > newestMtime) {
					newestMtime = stat.mtimeMs;
					newestFile = fullPath;
				}
			}
		}
	};

	try {
		if (harness === "auto" || harness === "pi") {
			if (fs.existsSync(piSessionsDir)) walk(piSessionsDir);
		}
		if (harness === "auto" || harness === "claude-code") {
			if (claudeSessionsDir) walk(claudeSessionsDir);
		}
	} catch {
		// Ignore walk errors
	}

	return newestFile;
}

const finalSessionPath = targetSessionPath || findLatestSession(harnessOption);
if (!finalSessionPath || !fs.existsSync(finalSessionPath)) {
	console.error("❌ Error: No active session log files found. Ensure Pi has been run, or specify an explicit session log path with -s.");
	process.exit(1);
}

// ---
// READ & PARSE LOGS
// ---

const lines = fs.readFileSync(finalSessionPath, "utf8").split("\n");
const interactions: Interaction[] = [];

for (const line of lines) {
	if (!line.trim()) continue;
	try {
		const entry = JSON.parse(line);
		const interaction = parseEntryToInteraction(entry);
		if (interaction) {
			interactions.push(interaction);
		}
	} catch {}
}

// ---
// COMPILING AND PRINTING
// ---

const defaultSettings = {
	interval: "1h",
	limit: 100,
	width: 80,
	showTicks: true,
	mode: "cumulative" as "cumulative" | "bucket",
	timezone: undefined
};

const outputLines = buildWtftLines(interactions, defaultSettings, {
	interval: intervalStr,
	limit,
	width,
	showTicks,
	mode,
	timezone
});

if (!outputLines) {
	console.log("No binned data found in session logs.");
	process.exit(0);
}

for (const line of outputLines) {
	console.log(line);
}

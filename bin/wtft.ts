#!/usr/bin/env -S node --experimental-strip-types
/**
 * @package princess-pi-packages
 * @command wtft
 * @description Command-line cost auditing tool for Pi Coding Agent session logs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import {
	buildWtftLines,
	parseEntryToInteraction,
	renderOtherHistogram,
	getSemanticCommandGroup,
	formatCost,
	type Interaction,
	type Category,
	getTerminalWidth
} from "../extensions/lib/wtft-shared.ts";

// ---
// DEFAULT CONFIG
// ---

let intervalStr = "1h";
let limit = 100; // Large default for CLI
let maxWidthOption: number | null = null;
let mode: "bucket" | "cumulative" = "cumulative";
let showTicks = true;
let targetSessionPath: string | undefined = undefined;
let timezone: string | undefined = undefined;
let harnessOption: "auto" | "pi" | "claude-code" = "auto";
let showOther = false;

// ---
// HELP MENU
// ---

function printWhy(): void {
	try {
		const manifestPath = path.join(process.cwd(), "docs", "manifests", "wtft-cmd.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		let text = `${manifest.name} - ${manifest.tagline}

`;
		text += `${manifest.description}

`;
		text += `Why run wtft?

`;
		const scenarios = manifest.why || [];
		for (const s of scenarios) {
			text += `  ${s.scenario}
`;
			for (const cmd of s.commands) {
				text += `    $ wtft${cmd ? " " + cmd : ""}
`;
			}
			text += `    → ${s.result}

`;
		}
		text += `Run wtft --help for the full flag reference.
`;
		console.log(text);
	} catch (err) {
		console.error(`⚠️ Failed to load command manifest: ${err}`);
		process.exitCode = 1;
	}
}

function printHelp() {
	console.log(`
Usage: wtft [options]

Options:
  -s, --session <path>    Specify an explicit session .jsonl log file path (defaults to latest active session).
  --harness <type>        Target a specific harness for auto-discovery (pi, claude-code, or auto). Default: auto.
  -i, --interval <val>    Group cost data into binned intervals (e.g., 1m, 7m, 4h, 1d, 2w; default: 1h).
  -l, --limit <number>    Limit the number of interval bars displayed (default: 100).
  -w, --width <number>    Set the maximum character width of the CLI output (default: 240).
  -c, --cumulative        Render running cumulative sums (default behavior).
  -b, --bucket            Render discrete binned interval cost buckets.
  --ticks                 Enable the proportional cost scale ticks above the bars (default behavior).
  --no-ticks              Disable the proportional cost scale ticks above the bars.
  -t, --tz <zone>         Specify a display timezone (e.g. America/Los_Angeles).
  -o, --other             Instead of the visual timeline, print a histogram of commands categorized as 'Other'.
  --why                   Explain why you'd run this tool, with user scenarios and anti-use-cases.
  -h, --help              Display this help menu.
`);
}

// ---
// ARGUMENT PARSING
// ---

let hasInterval = false;
let hasLimit = false;
let hasWidth = false;
let hasCumulative = false;
let hasBucket = false;
let hasNoTicks = false;
let hasTicks = false;
let hasTz = false;
let hasOther = false;

for (let i = 2; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (arg === "-h" || arg === "--help") {
		printHelp();
		process.exit(0);
	} else if (arg === "--why") {
		printWhy();
		process.exit(0);
	} else if (arg === "-s" || arg === "--session") {
		targetSessionPath = process.argv[++i];
	} else if (arg === "-i" || arg === "--interval") {
		intervalStr = process.argv[++i];
		hasInterval = true;
	} else if (arg === "-l" || arg === "--limit") {
		limit = parseInt(process.argv[++i], 10);
		hasLimit = true;
	} else if (arg === "-w" || arg === "--width") {
		maxWidthOption = parseInt(process.argv[++i], 10);
		hasWidth = true;
	} else if (arg === "-c" || arg === "--cumulative") {
		mode = "cumulative";
		hasCumulative = true;
	} else if (arg === "-b" || arg === "--bucket") {
		mode = "bucket";
		hasBucket = true;
	} else if (arg === "--no-ticks") {
		showTicks = false;
		hasNoTicks = true;
	} else if (arg === "--ticks") {
		showTicks = true;
		hasTicks = true;
	} else if (arg === "-t" || arg === "--tz") {
		timezone = process.argv[++i];
		hasTz = true;
	} else if (arg === "-o" || arg === "--other") {
		showOther = true;
		hasOther = true;
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

interface SessionCandidate {
	path: string;
	harness: "pi" | "claude-code";
	timestamp: number; // mtime of file
	name: string;      // e.g. "1422cc01-4b08-4ff5-8583-42beaab8665a.jsonl"
}

function discoverSessions(harness: "pi" | "claude-code" | "auto" = "auto"): SessionCandidate[] {
	const piSessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
	
	let claudeSessionsDirs: string[] = [];
	const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
	if (fs.existsSync(claudeProjectsDir)) {
		// Replace / or \ with - for the project slug, similar to how Claude encodes it
		const cwdSlug = process.cwd().replace(/[/\\\\]/g, "-");
		const possibleDir = path.join(claudeProjectsDir, cwdSlug, "sessions");
		const alternativeDir = path.join(claudeProjectsDir, cwdSlug);
		if (fs.existsSync(possibleDir)) claudeSessionsDirs.push(possibleDir);
		if (fs.existsSync(alternativeDir)) claudeSessionsDirs.push(alternativeDir);
	}

	const candidates: SessionCandidate[] = [];

	const walk = (dir: string, type: "pi" | "claude-code") => {
		const files = fs.readdirSync(dir);
		for (const f of files) {
			const fullPath = path.join(dir, f);
			const stat = fs.statSync(fullPath);
			if (stat.isDirectory()) {
				// Avoid recursing into 'subagents' directory during selection candidates discovery
				// (We only want the parent sessions, not the individual subagent logs)
				if (f !== "subagents" && f !== "tool-results" && f !== "memory") {
					walk(fullPath, type);
				}
			} else if (f.endsWith(".jsonl")) {
				candidates.push({
					path: fullPath,
					harness: type,
					timestamp: stat.mtimeMs,
					name: f
				});
			}
		}
	};

	try {
		if (harness === "auto" || harness === "pi") {
			if (fs.existsSync(piSessionsDir)) walk(piSessionsDir, "pi");
		}
		if (harness === "auto" || harness === "claude-code") {
			for (const dir of claudeSessionsDirs) {
				if (fs.existsSync(dir)) walk(dir, "claude-code");
			}
		}
	} catch {}

	// Sort candidates by timestamp descending (newest first)
	return candidates.sort((a, b) => b.timestamp - a.timestamp);
}

function getSessionSummary(filePath: string): { turns: number; cost: number } {
	let turns = 0;
	let cost = 0;
	try {
		const content = fs.readFileSync(filePath, "utf8");
		const lines = content.split("\n");
		for (const line of lines) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line);
			// Count assistant turns
			if (entry.type === "assistant" || (entry.message && entry.message.role === "assistant")) {
				turns++;
			}
			const i = parseEntryToInteraction(entry);
			if (i) {
				cost += i.cost;
			}
		}
	} catch {}
	return { turns, cost };
}

async function selectSessionPrompt(candidates: SessionCandidate[]): Promise<string> {
	return new Promise((resolve) => {
		// If stdout is not a TTY, fallback to non-interactive list and select index 0
		if (!process.stdout.isTTY) {
			console.log(`\x1b[90mNon-interactive environment detected. Defaulting to newest session [1]:\x1b[0m`);
			for (let i = 0; i < Math.min(candidates.length, 5); i++) {
				const c = candidates[i];
				const stats = getSessionSummary(c.path);
				const shortName = c.name.length > 25
					? `${c.name.substring(0, 10)}...${c.name.substring(c.name.length - 15)}`
					: c.name;
				const dateStr = new Date(c.timestamp).toLocaleString();
				console.log(`  [${i + 1}] ${shortName.padEnd(28)} (${dateStr}) - ${stats.turns} turns, ${formatCost(stats.cost)} [${c.harness.toUpperCase()}]`);
			}
			console.log(`\x1b[90mRun 'wtft -s <number>' to target a specific session index.\x1b[0m\n`);
			resolve(candidates[0].path);
			return;
		}

		// Interactive Select Mode (TTY)
		let selectedIndex = 0;
		const limit = 10;
		const displayCandidates = candidates.slice(0, limit);

		// We pre-calculate stats for the displayed candidates so the user has context!
		const statsList = displayCandidates.map(c => getSessionSummary(c.path));

		const stdin = process.stdin;
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");

		// Hide terminal cursor
		process.stdout.write("\x1b[?25l");

		const render = () => {
			let out = `\x1b[1m\x1b[36m💸 WTFT Session Selector\x1b[0m (Use ↑/↓ keys, Enter to select, Ctrl+C to cancel):\n`;
			for (let i = 0; i < displayCandidates.length; i++) {
				const c = displayCandidates[i];
				const stats = statsList[i];
				const shortName = c.name.length > 25
					? `${c.name.substring(0, 10)}...${c.name.substring(c.name.length - 15)}`
					: c.name;
				const dateStr = new Date(c.timestamp).toLocaleString();
				
				const isSelected = i === selectedIndex;
				const prefix = isSelected ? `\x1b[36m\x1b[1m > \x1b[0m` : "   ";
				const highlight = isSelected ? `\x1b[1m\x1b[36m` : "";
				const reset = isSelected ? `\x1b[0m` : "";
				
				const costStr = `\x1b[32m${formatCost(stats.cost).padStart(7)}\x1b[0m`;
			out += `${prefix}${highlight}${shortName.padEnd(28)}${reset} \x1b[90m(${dateStr})\x1b[0m  ${costStr} \x1b[90m(${stats.turns} turns) [${c.harness.toUpperCase()}]\x1b[0m\n`;
			}
			process.stdout.write(out);
		};

		const cleanScreen = () => {
			// Move cursor up by (displayCandidates.length + 1) lines and clear them
			const linesToClear = displayCandidates.length + 1;
			process.stdout.write(`\x1b[${linesToClear}A\x1b[J`);
		};

		render();

		const onKey = (key: string) => {
			if (key === "\u0003") { // Ctrl+C
				cleanup();
				process.exit(130);
			} else if (key === "\r" || key === "\n") { // Enter
				cleanup();
				resolve(displayCandidates[selectedIndex].path);
			} else if (key === "\u001b[A" || key === "k") { // Up Arrow or 'k'
				selectedIndex = (selectedIndex - 1 + displayCandidates.length) % displayCandidates.length;
				cleanScreen();
				render();
			} else if (key === "\u001b[B" || key === "j") { // Down Arrow or 'j'
				selectedIndex = (selectedIndex + 1) % displayCandidates.length;
				cleanScreen();
				render();
			}
		};

		const cleanup = () => {
			stdin.removeListener("data", onKey);
			stdin.setRawMode(false);
			stdin.pause();
			// Show cursor again
			process.stdout.write("\x1b[?25h");
		};

		stdin.on("data", onKey);
	});
}

// ---
// MAIN EXECUTION FLOW (ASYNC)
// ---

async function main() {
	const isIndex = /^\d+$/.test(targetSessionPath || "");
	const candidates = discoverSessions(harnessOption);
	
	let finalSessionPath = "";
	if (targetSessionPath && isIndex) {
		const idx = parseInt(targetSessionPath, 10);
		if (idx > 0 && idx <= candidates.length) {
			finalSessionPath = candidates[idx - 1].path;
		} else {
			console.error(`❌ Error: Session index '${targetSessionPath}' is out of range. Discovered ${candidates.length} sessions.`);
			process.exit(1);
		}
	} else if (targetSessionPath) {
		finalSessionPath = targetSessionPath;
	} else {
		// Auto select or show selector prompt
		if (candidates.length === 0) {
			console.error("❌ Error: No active session log files found. Ensure Pi or Claude has been run, or specify an explicit session log path with -s.");
			process.exit(1);
		} else if (candidates.length === 1) {
			finalSessionPath = candidates[0].path;
		} else {
			// Show select menu!
			finalSessionPath = await selectSessionPrompt(candidates);
		}
	}

	if (!finalSessionPath || !fs.existsSync(finalSessionPath)) {
		console.error("❌ Error: Selected session log file path is invalid or does not exist.");
		process.exit(1);
	}

	// Resolve all subagent files to recursively roll up cost if applicable
	const sessionFiles: string[] = [finalSessionPath];
	const extName = path.extname(finalSessionPath);
	if (extName === ".jsonl") {
		const baseName = path.basename(finalSessionPath, extName);
		const parentDir = path.dirname(finalSessionPath);
		// Claude Code puts subagents inside <parentDir>/<session-id>/subagents/
		const possibleSubagentsDir = path.join(parentDir, baseName, "subagents");
		if (fs.existsSync(possibleSubagentsDir)) {
			try {
				const subFiles = fs.readdirSync(possibleSubagentsDir);
				for (const f of subFiles) {
					if (f.startsWith("agent-") && f.endsWith(".jsonl")) {
						sessionFiles.push(path.join(possibleSubagentsDir, f));
					}
				}
			} catch {}
		}
	}

	// Read lines from all associated session files
	const lines: string[] = [];
	for (const file of sessionFiles) {
		try {
			const content = fs.readFileSync(file, "utf8");
			lines.push(...content.split("\n"));
		} catch {}
	}

	const interactions: Interaction[] = [];
	let disabledEmoji = false;

	// Saved session log options
	let sessionInterval: string | undefined;
	let sessionLimit: number | undefined;
	let sessionWidth: number | undefined;
	let sessionMode: "cumulative" | "bucket" | undefined;
	let sessionShowTicks: boolean | undefined;
	let sessionTimezone: string | undefined;

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry.type === "custom" && entry.customType === "emoji-settings") {
				if (entry.data && typeof entry.data.disabled === "boolean") {
					disabledEmoji = entry.data.disabled;
				}
			} else if (entry.type === "custom" && entry.customType === "wtft-settings") {
				if (entry.data) {
					if (typeof entry.data.interval === "string") sessionInterval = entry.data.interval;
					if (typeof entry.data.limit === "number") sessionLimit = entry.data.limit;
					if (typeof entry.data.width === "number") sessionWidth = entry.data.width;
					if (entry.data.mode === "cumulative" || entry.data.mode === "bucket") {
						sessionMode = entry.data.mode;
					}
					if (typeof entry.data.showTicks === "boolean") sessionShowTicks = entry.data.showTicks;
					if (typeof entry.data.timezone === "string") sessionTimezone = entry.data.timezone;
				}
			}
			const interaction = parseEntryToInteraction(entry);
			if (interaction) {
				interactions.push(interaction);
			}
		} catch {}
	}

	// ---
	// COMPILING AND PRINTING
	// ---

	const termColumns = getTerminalWidth();
	const maxWidth = hasWidth ? (maxWidthOption as number) : (sessionWidth ?? 240);
	const finalInterval = hasInterval ? intervalStr : (sessionInterval ?? "1h");
	const finalLimit = hasLimit ? limit : (sessionLimit ?? 100);
	const finalMode = (hasCumulative || hasBucket) ? mode : (sessionMode ?? "cumulative");
	const finalShowTicks = (hasTicks || hasNoTicks) ? showTicks : (sessionShowTicks ?? true);
	const finalTimezone = hasTz ? timezone : sessionTimezone;

	const defaultSettings = {
		interval: "1h",
		limit: 100,
		width: maxWidth,
		showTicks: true,
		mode: "cumulative" as "cumulative" | "bucket",
		timezone: undefined
	};

	const outputLines = buildWtftLines(interactions, defaultSettings, {
		interval: finalInterval,
		limit: finalLimit,
		width: maxWidth,
		showTicks: finalShowTicks,
		mode: finalMode,
		timezone: finalTimezone,
		disabledEmoji
	});

	if (!outputLines) {
		console.log("No binned data found in session logs.");
		process.exit(0);
	}

	for (const line of outputLines) {
		console.log(line);
	}

	if (showOther) {
		console.log(""); // empty line spacer
		const otherOutput = renderOtherHistogram(interactions, maxWidth);
		console.log(otherOutput);
	}
}

main().catch(err => {
	console.error(`❌ System Error: ${err.message}`);
	process.exit(1);
});

#!/usr/bin/env -S node --experimental-strip-types
/**
 * @package princess-pi-packages
 * @command wtft
 * @description Command-line cost auditing tool for Pi Coding Agent session logs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildWtftLines,
	parseSessionFile,
	renderOtherHistogram,
	renderTokenSummary,
	getSemanticCommandGroup,
	deduplicateInteractions,
	watchMode,
	watchTagFile,
	readClassifiedTagFile,
	type WatchSettings,
	type Interaction,
	type Category,
	getTerminalWidth
} from "../extensions/lib/wtft-shared.ts";
import { execSync, spawn } from "node:child_process";
import {
	discoverSessions,
	selectSessionPrompt
} from "../extensions/lib/session-selector.ts";

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
let cwdOverride: string | undefined = undefined;
let showOther = false;
let showTokens = false;

// ---
// HELP MENU
// ---

function printWhy(): void {
	try {
		const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "manifests", "wtft-cmd.json");
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
			if (s.demo && (s.demo as string[]).length > 0) {
				for (const line of (s.demo as string[])) {
					text += `    ${line}
`;
				}
			}
			text += `
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
  --dir, --cwd <path>     Working directory for Claude Code session discovery (default: current directory).
  --harness <type>        Target a specific harness for auto-discovery (pi, claude-code, or auto). Default: auto.
  -i, --interval <val>    Group cost data into binned intervals (e.g., 1m, 7m, 4h, 1d, 2w; default: 1h).
  -l, --limit <number>    Limit the number of interval bars displayed (default: 100).
  -w, --width <number>    Set the maximum character width of the CLI output (default: 240).
  -c, --cumulative        Render running cumulative sums (default behavior).
  -b, --bucket            Render discrete binned interval cost buckets.
  --ticks                 Enable the proportional cost scale ticks above the bars (default behavior).
  --no-ticks              Disable the proportional cost scale ticks above the bars.
  -t, --tz <zone>         Specify a display timezone (e.g. America/Los_Angeles).
  -o, --other             Print a histogram of 'Other' commands grouped by semantic sub-category (Build, Lint, System, etc.).
  -T, --tokens            Print a per-model token summary table (deduped) for cross-referencing with /usage.
  -W, --watch             Watch a session file for changes and re-render the bar chart in real-time.
  --version               Display this tool's version.
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
let hasTokens = false;
let showWatch = false;

for (let i = 2; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (arg === "-h" || arg === "--help") {
		printHelp();
		process.exit(0);
	} else if (arg === "--why") {
		printWhy();
		process.exit(0);
	} else if (arg === "--version") {
		const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "manifests", "wtft-cmd.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
		console.log(`${manifest.name} ${manifest.version}`);
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
	} else if (arg === "--tokens" || arg === "-T") {
		showTokens = true;
		hasTokens = true;
	} else if (arg === "-W" || arg === "--watch") {
		showWatch = true;
	} else if (arg === "--dir" || arg === "--cwd") {
		cwdOverride = process.argv[++i];
	} else if (arg === "--harness") {
		const val = process.argv[++i];
		if (val === "pi" || val === "claude-code" || val === "auto") {
			harnessOption = val;
		}
	}
}

// ---
// ---
// MAIN EXECUTION FLOW
// ---

async function main() {
	const isIndex = /^\d+$/.test(targetSessionPath || "");
	const candidates = discoverSessions(harnessOption, cwdOverride);
	
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

	// ---
	// WATCH MODE: enter live re-render loop (#45, #53)
	// Spawns the wtft-daemon for classified tag output, then watches the
	// tag file via inotify (fs.watch) instead of polling session.jsonl.
	// ---
	if (showWatch) {
		const termColumns = getTerminalWidth();
		const maxWidth = hasWidth ? (maxWidthOption as number) : 240;

		// Compute tag file path (matches daemon's path logic: wtft-tags/<base>.wtft-tag.v2.0.0.jsonl)
		const sessionDir = path.dirname(finalSessionPath);
		const sessionBase = path.basename(finalSessionPath);
		const tagsDir = path.join(sessionDir, "wtft-tags");
		const tagPath = path.join(tagsDir, sessionBase + ".wtft-tag.v2.0.0.jsonl");

		// Auto-spawn daemon if not already running (singleton via PID file).
		const daemonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "wtft-daemon.mjs");
		try {
			const child = spawn(process.execPath, [daemonPath, "--session", finalSessionPath], {
				detached: true,
				stdio: "ignore"
			});
			child.unref();
		} catch (err) {
			// Daemon spawn failed — fall back to polling mode
			console.error(`\x1b[33m⚠ Daemon spawn failed, falling back to polling mode: ${err}\x1b[0m`);
			await watchMode(finalSessionPath, {
				interval: hasInterval ? intervalStr : "1h",
				limit: hasLimit ? limit : 100,
				width: Math.min(maxWidth, termColumns),
				mode: (hasCumulative || hasBucket) ? mode : "cumulative",
				showTicks: (hasTicks || hasNoTicks) ? showTicks : true,
				timezone: hasTz ? timezone : undefined,
				disabledEmoji: false
			});
			return;
		}

		// Wait briefly for daemon to write the first classified lines, then
		// enter the inotify-based watch loop.
		await new Promise(resolve => setTimeout(resolve, 500));
		await watchTagFile(finalSessionPath, tagPath, {
			interval: hasInterval ? intervalStr : "1h",
			limit: hasLimit ? limit : 100,
			width: Math.min(maxWidth, termColumns),
			mode: (hasCumulative || hasBucket) ? mode : "cumulative",
			showTicks: (hasTicks || hasNoTicks) ? showTicks : true,
			timezone: hasTz ? timezone : undefined,
			disabledEmoji: false
		});
		return; // watchTagFile never returns until SIGINT
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

	// Parse interactions from all session files (parent + subagents) using the
	// shared parseSessionFile utility (#54 DRY refactor).
	const interactions: Interaction[] = [];
	for (const file of sessionFiles) {
		interactions.push(...parseSessionFile(file));
	}

	// Separate pass: read parent file for custom entries (emoji/wtft settings, Pi-only).
	let disabledEmoji = false;
	let sessionInterval: string | undefined;
	let sessionLimit: number | undefined;
	let sessionWidth: number | undefined;
	let sessionMode: "cumulative" | "bucket" | undefined;
	let sessionShowTicks: boolean | undefined;
	let sessionTimezone: string | undefined;

	if (sessionFiles.length > 0) {
		try {
			const content = fs.readFileSync(sessionFiles[0], "utf8");
			for (const line of content.split("\n")) {
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
				} catch {
					// Skip unparseable lines
				}
			}
		} catch {
			// File may not exist or be unreadable
		}
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

	// Session file path above chart (once)
	console.log(`\x1b[90m${finalSessionPath}\x1b[0m`);
	for (const line of outputLines) {
		console.log(line);
	}

	if (showOther) {
		console.log(""); // empty line spacer
		const dedupedInteractions = deduplicateInteractions(interactions);
		const otherOutput = renderOtherHistogram(dedupedInteractions, maxWidth);
		console.log(otherOutput);
	}

	if (showTokens) {
		const tokenOutput = renderTokenSummary(interactions, maxWidth);
		console.log(tokenOutput);
	}
}

main().catch(err => {
	console.error(`❌ System Error: ${err.message}`);
	process.exit(1);
});

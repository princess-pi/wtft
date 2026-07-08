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
	deduplicateInteractions,
	watchMode,
	watchTagFile,
	readClassifiedTagFile,
	WTFT_TAGGER_VERSION,
	type WatchSettings,
	type Interaction,
	getTerminalWidth
} from "../extensions/lib/wtft-shared.ts";
import { execSync, spawn } from "node:child_process";
import { readConfig, hasConfig } from "../extensions/lib/config.ts";
import {
	discoverSessions,
	selectSessionPrompt
} from "../extensions/lib/session-selector.ts";

// ---
// DEFAULT CONFIG
// ---

let intervalStr = "1h";
let limit = 100; // Large default for CLI
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
  -s, --session <path|filter>  Explicit session .jsonl path, or fuzzy substring filter (e.g. 'b04c'). Skips selector on single match.
  --dir, --cwd <path>     Working directory for Claude Code session discovery (default: current directory).
  --harness <type>        Target a specific harness for auto-discovery (pi, claude-code, or auto). Default: auto.
  -i, --interval <val>    Group cost data into binned intervals (e.g., 1m, 7m, 4h, 1d, 2w; default: 1h).
  -l, --limit <number>    Limit the number of interval bars displayed (default: 100).
  -c, --cumulative        Render running cumulative sums (default behavior).
  -b, --bucket            Render discrete binned interval cost buckets.
  --ticks                 Enable the proportional cost scale ticks above the bars (default behavior).
  --no-ticks              Disable the proportional cost scale ticks above the bars.
  -t, --tz <zone>         Specify a display timezone (e.g. America/Los_Angeles).
  -o, --other             Print a histogram of 'Other' commands grouped by semantic sub-category (Build, Lint, System, etc.).
  -T, --tokens            Print a per-model token summary table (deduped) for cross-referencing with /usage.
  -W, --watch             Watch a session file for changes and re-render the bar chart in real-time.

Log parser management:
  --list                  List all running log parsers with session path, PID, parser version, and idle time.
  --cleanup               Kill log parsers whose source session no longer exists.
  --restart               Kill all running log parsers (fresh spawn on next wtft).
  --stop <session>        Stop log parser for a specific session path.

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
let hasCumulative = false;
let hasBucket = false;
let hasNoTicks = false;
let hasTicks = false;
let hasTz = false;
let hasOther = false;
let hasTokens = false;
let showWatch = false;
let daemonList = false;
let daemonCleanup = false;
let daemonRestart = false;
let daemonStop: string | undefined;

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
	} else if (arg === "--list") {
		daemonList = true;
	} else if (arg === "--cleanup") {
		daemonCleanup = true;
	} else if (arg === "--restart") {
		daemonRestart = true;
	} else if (arg === "--stop") {
		daemonStop = process.argv[++i];
	} else if (arg === "-s" || arg === "--session") {
		targetSessionPath = process.argv[++i];
	} else if (arg === "-i" || arg === "--interval") {
		intervalStr = process.argv[++i];
		hasInterval = true;
	} else if (arg === "-l" || arg === "--limit") {
		limit = parseInt(process.argv[++i], 10);
		hasLimit = true;
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
	// ---
	// DAEMON MANAGEMENT COMMANDS: passthrough to wtft-daemon
	// ---
	if (daemonList || daemonCleanup || daemonRestart || daemonStop) {
		const daemonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "wtft-daemon.mjs");
		const daemonArgs = [daemonPath];
		if (daemonList) daemonArgs.push("--list");
		if (daemonCleanup) daemonArgs.push("--cleanup");
		if (daemonRestart) daemonArgs.push("--restart");
		if (daemonStop) daemonArgs.push("--stop", daemonStop);
		try {
			const result = execSync(`${process.execPath} ${daemonArgs.join(" ")}`, {
				encoding: "utf8",
				timeout: 10000
			});
			if (result) console.log(result.trim());
		} catch (err: any) {
			if (err.stdout) console.log(err.stdout.trim());
			if (err.stderr) console.error(err.stderr.trim());
		}
		return;
	}

	const candidates = discoverSessions(harnessOption, cwdOverride);
	
	let finalSessionPath = "";
	if (targetSessionPath) {
		// Direct path — use as-is if it exists
		if (fs.existsSync(targetSessionPath)) {
			finalSessionPath = targetSessionPath;
		} else {
			// Fuzzy substring filter against discovered sessions
			const filter = targetSessionPath.toLowerCase();
			const filtered = candidates.filter(c =>
				c.path.toLowerCase().includes(filter) ||
				c.name.toLowerCase().includes(filter)
			);
			if (filtered.length === 0) {
				console.error(`❌ Error: Session '${targetSessionPath}' does not exist as a file and matches no discovered sessions (${candidates.length} available).`);
				process.exit(1);
			} else if (filtered.length === 1) {
				finalSessionPath = filtered[0].path;
			} else {
				finalSessionPath = await selectSessionPrompt(filtered);
			}
		}
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

		// Tag file path — always use the current version. The daemon
		// handles stale-version cleanup internally on startup.
		const sessionDir = path.dirname(finalSessionPath);
		const sessionBase = path.basename(finalSessionPath);
		const tagsDir = path.join(sessionDir, "wtft-tags");
		const tagPath = path.join(tagsDir, sessionBase + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);

		// Auto-spawn daemon if not already running (singleton via PID file).
		const daemonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "wtft-daemon.mjs");
		try {
			const child = spawn(process.execPath, [daemonPath, "--session", finalSessionPath], {
				detached: true,
				stdio: "ignore"
			});
			child.unref();
		} catch (err) {
			// Log parser spawn failed — fall back to polling mode
			console.error(`\x1b[33m⚠ Log parser spawn failed, falling back to polling mode: ${err}\x1b[0m`);
			await watchMode(finalSessionPath, {
				interval: hasInterval ? intervalStr : "1h",
				limit: hasLimit ? limit : 100,
				mode: (hasCumulative || hasBucket) ? mode : "cumulative",
				showTicks: (hasTicks || hasNoTicks) ? showTicks : true,
				timezone: hasTz ? timezone : undefined,
				hasInterval, hasLimit, hasMode: hasCumulative || hasBucket,
				hasTicks: hasTicks || hasNoTicks, hasTimezone: hasTz
			});
			return;
		}

		// Wait briefly for daemon to write the first classified lines, then
		// enter the inotify-based watch loop.
		await new Promise(resolve => setTimeout(resolve, 500));
		await watchTagFile(finalSessionPath, tagPath, {
			interval: hasInterval ? intervalStr : "1h",
			limit: hasLimit ? limit : 100,
			mode: (hasCumulative || hasBucket) ? mode : "cumulative",
			showTicks: (hasTicks || hasNoTicks) ? showTicks : true,
			timezone: hasTz ? timezone : undefined,
			daemonPath,
			hasInterval, hasLimit, hasMode: hasCumulative || hasBucket,
			hasTicks: hasTicks || hasNoTicks, hasTimezone: hasTz
		});
		return; // watchTagFile never returns until SIGINT
	}

	// ---
	// NON-WATCH MODE: spawn daemon, read classified tag file, render.
	// Both watch and non-watch now read from the same tag file format —
	// the daemon is the sole harness→tag converter.
	// ---

	// Compute tag path — always use the current version (no stale-version scan).
	const sessionDir = path.dirname(finalSessionPath);
	const sessionBase = path.basename(finalSessionPath);
	const tagsDir = path.join(sessionDir, "wtft-tags");
	const tagPath = path.join(tagsDir, sessionBase + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);

	// Auto-spawn daemon (singleton via PID file).
	const daemonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "wtft-daemon.mjs");
	try {
		const child = spawn(process.execPath, [daemonPath, "--session", finalSessionPath], {
			detached: true,
			stdio: "ignore"
		});
		child.unref();
	} catch (err) {
		// Log parser spawn failed — fall back to direct session parsing
		console.error(`\x1b[33m⚠ Log parser spawn failed, falling back to direct parse: ${err}\x1b[0m`);
	}

	// Wait for daemon to process existing entries (poll up to 3s for classified data).
	// Daemon poll cycle is 667ms; 3s ≈ 4 cycles for a full re-parse.
	const waitStart = Date.now();
	while (Date.now() - waitStart < 3000) {
		if (fs.existsSync(tagPath)) {
			const content = fs.readFileSync(tagPath, "utf8");
			if (content.split("\n").some(l => l.trim() && !l.includes('"_hb"'))) break;
		}
		await new Promise(r => setTimeout(r, 250));
	}

	// Read interactions from the classified tag file (harness-agnostic).
	const interactions: Interaction[] = readClassifiedTagFile(tagPath);

	// If daemon produced nothing, fall back to direct session parsing.
	if (interactions.length === 0) {
		interactions.push(...parseSessionFile(finalSessionPath));
	}

	// Read settings from harness-agnostic config file (#72).
	// Falls back to .jsonl custom entries if no config file exists (backward compat).
	const config = readConfig("wtft");
	let disabledEmoji = (typeof config.disabledEmoji === "boolean" ? config.disabledEmoji : false) as boolean;
	let sessionInterval = (typeof config.interval === "string" ? config.interval : undefined) as string | undefined;
	let sessionLimit = (typeof config.limit === "number" ? config.limit : undefined) as number | undefined;
	let sessionMode = (config.mode === "cumulative" || config.mode === "bucket" ? config.mode : undefined) as "cumulative" | "bucket" | undefined;
	let sessionShowTicks = (typeof config.showTicks === "boolean" ? config.showTicks : undefined) as boolean | undefined;
	let sessionTimezone = (typeof config.timezone === "string" ? config.timezone : undefined) as string | undefined;

	// Backward compat: if no config file exists, fall back to legacy .jsonl entries
	if (!hasConfig("wtft")) {
		try {
			const content = fs.readFileSync(finalSessionPath, "utf8");
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
							if (typeof entry.data.interval === "string" && sessionInterval === undefined) sessionInterval = entry.data.interval;
							if (typeof entry.data.limit === "number" && sessionLimit === undefined) sessionLimit = entry.data.limit;
							if ((entry.data.mode === "cumulative" || entry.data.mode === "bucket") && sessionMode === undefined) {
								sessionMode = entry.data.mode;
							}
							if (typeof entry.data.showTicks === "boolean" && sessionShowTicks === undefined) sessionShowTicks = entry.data.showTicks;
							if (typeof entry.data.timezone === "string" && sessionTimezone === undefined) sessionTimezone = entry.data.timezone;
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
	const finalInterval = hasInterval ? intervalStr : (sessionInterval ?? "1h");
	const finalLimit = hasLimit ? limit : (sessionLimit ?? 100);
	const finalMode = (hasCumulative || hasBucket) ? mode : (sessionMode ?? "cumulative");
	const finalShowTicks = (hasTicks || hasNoTicks) ? showTicks : (sessionShowTicks ?? true);
	const finalTimezone = hasTz ? timezone : sessionTimezone;

	const defaultSettings = {
		interval: "1h",
		limit: 100,
		width: Math.min(getTerminalWidth(), 1023),
		showTicks: true,
		mode: "cumulative" as "cumulative" | "bucket",
		timezone: undefined
	};

	const outputLines = buildWtftLines(interactions, defaultSettings, {
		interval: finalInterval,
		limit: finalLimit,
		width: Math.min(getTerminalWidth(), 1023),
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
		const otherOutput = renderOtherHistogram(dedupedInteractions, Math.min(getTerminalWidth(), 1023));
		console.log(otherOutput);
	}

	if (showTokens) {
		const tokenOutput = renderTokenSummary(interactions, Math.min(getTerminalWidth(), 1023));
		console.log(tokenOutput);
	}
}

main().catch(err => {
	console.error(`❌ System Error: ${err.message}`);
	process.exit(1);
});

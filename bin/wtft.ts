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
	getDaemonPidPath,
	getTagPath,
	WTFT_TAGGER_VERSION,
	type WatchSettings,
	type Interaction,
	getTerminalWidth
} from "../extensions/lib/wtft-shared.ts";
import { execSync, spawn } from "node:child_process";
import { loadConfig, readConfig } from "../extensions/lib/config.ts";
import {
	discoverSessions,
	selectSessionPrompt
} from "../extensions/lib/session-selector.ts";

// ---
// DEFAULT CONFIG
// ---

// Load config file (#20) — overrides hardcoded defaults, CLI flags override both
const cfg = loadConfig("wtft", { interval: "1h", limit: 100, mode: "cumulative" }) as {
	interval?: string;
	limit?: number;
	mode?: "bucket" | "cumulative";
	timezone?: string;
};

let intervalStr = String(cfg.interval ?? "1h");
let limit = Number(cfg.limit ?? 100);
let mode: "bucket" | "cumulative" = (cfg.mode as "bucket" | "cumulative") ?? "cumulative";
let showTicks = true;
let targetSessionPath: string | undefined = undefined;
let timezone: string | undefined = cfg.timezone || undefined;
let harnessOption: "auto" | "pi" | "claude-code" = "auto";
let cwdOverride: string | undefined = undefined;
let showOther = false;
let showTokens = false;
let pad = 1;
let hasPad = false;

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
  --thinking-budget <n>   Thinking token budget for utilization display in --tokens (default: no budget shown).
  -W, --watch             Watch a session file for changes and re-render the bar chart in real-time.
  -F, --force             Kill the log parser, delete tag files, and force a full session re-parse.
  --pad <N>               Pad output with N spaces on each side (default: 1, max: floor(term/2)-1).
                          Makes CLI output width match Pi TUI widget in the same terminal.
  --debug                 Print diagnostic cost totals (tag file vs direct parse + dedup).

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
let debugMode = false;
let forceReparse = false;
let thinkingBudget: number | undefined = undefined; // --thinking-budget for --tokens detail (#79)

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
	} else if (arg === "--pad") {
		const val = parseInt(process.argv[++i], 10);
		if (!isNaN(val) && val >= 0) {
			pad = val;
			hasPad = true;
		}
	} else if (arg === "--debug") {
		debugMode = true;
	} else if (arg === "--force" || arg === "-F") {
		forceReparse = true;
	} else if (arg === "--thinking-budget") {
		const val = parseInt(process.argv[++i], 10);
		if (!isNaN(val) && val > 0) {
			thinkingBudget = val;
		}
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
	// --force: kill existing daemon, delete tag file, re-parse from scratch.
	// ---
	if (forceReparse) {
		const forceTagPath = getTagPath(finalSessionPath);
		const forcePidPath = getDaemonPidPath(finalSessionPath);
		// Kill existing daemon
		try {
			const pid = parseInt(fs.readFileSync(forcePidPath, "utf8").trim(), 10);
			if (pid > 0) {
				try { process.kill(pid, "SIGTERM"); } catch {}
			}
			try { fs.unlinkSync(forcePidPath); } catch {}
		} catch {}
		// Delete tag file (and any stale-version tag files)
		const forceTagsDir = path.dirname(forceTagPath);
		const forceSessionBase = path.basename(finalSessionPath);
		try {
			for (const f of fs.readdirSync(forceTagsDir)) {
				if (f.startsWith(forceSessionBase + ".wtft-tag.v") && f.endsWith(".jsonl")) {
					fs.unlinkSync(path.join(forceTagsDir, f));
				}
			}
		} catch {}
		console.error(`\x1b[33mForce re-parse: killed daemon + deleted tag files for ${path.basename(finalSessionPath)}\x1b[0m`);
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
				pad,
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
			pad,
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

	// Wait for daemon to finish its initial parse. Poll until the tag file
	// entry count matches a direct session parse + dedup (the daemon is caught
	// up). Retry every 667ms, capped at 30s.
	const waitStart = Date.now();
	let tagInteractions: Interaction[] = [];
	let directCost = 0;
	while (Date.now() - waitStart < 30000) {
		if (fs.existsSync(tagPath)) {
			tagInteractions = readClassifiedTagFile(tagPath);
			if (tagInteractions.length > 0) {
				// Compute direct parse cost once (expensive, so cache it).
				if (directCost === 0) {
					const directInteractions = deduplicateInteractions(parseSessionFile(finalSessionPath));
					directCost = directInteractions.reduce((sum, i) => sum + i.cost, 0);
				}
				// Wait for daemon to catch up: compare total cost, not entry count.
				// Classified entries may split interactions into multiple lines,
				// so count-based comparison can diverge. Cost is the real target.
				const tagCost = tagInteractions.reduce((sum, i) => sum + i.cost, 0);
				if (tagCost >= directCost - 0.001) break; // within 0.1¢
			}
		}
		await new Promise(r => setTimeout(r, 667));
	}

	// Read interactions from the classified tag file (harness-agnostic).
	const interactions: Interaction[] = tagInteractions.length > 0
		? tagInteractions
		: [];

	// If daemon produced nothing, fall back to direct session parsing.
	if (interactions.length === 0) {
		interactions.push(...parseSessionFile(finalSessionPath));
	}

	// Read settings from harness-agnostic config file (#72).
	const config = readConfig("wtft");
	const disabledEmoji = (typeof config.disabledEmoji === "boolean" ? config.disabledEmoji : false) as boolean;
	const sessionInterval = (typeof config.interval === "string" ? config.interval : undefined) as string | undefined;
	const sessionLimit = (typeof config.limit === "number" ? config.limit : undefined) as number | undefined;
	const sessionMode = (config.mode === "cumulative" || config.mode === "bucket" ? config.mode : undefined) as "cumulative" | "bucket" | undefined;
	const sessionShowTicks = (typeof config.showTicks === "boolean" ? config.showTicks : undefined) as boolean | undefined;
	const sessionTimezone = (typeof config.timezone === "string" ? config.timezone : undefined) as string | undefined;
	// ---
	// COMPILING AND PRINTING
	// ---

	const termColumns = getTerminalWidth();
	// Pad: default 1 to match Pi TUI widget's enforced 1-space padding.
	// Clamp to valid range (max: floor(term/2)-1).
	if (!hasPad) pad = 1;
	const maxPad = Math.max(0, Math.floor(termColumns / 2) - 1);
	pad = Math.min(pad, maxPad);
	const padStr = " ".repeat(pad);
	const paddedWidth = termColumns - 2 * pad;
	const finalInterval = hasInterval ? intervalStr : (sessionInterval ?? "1h");
	const finalLimit = hasLimit ? limit : (sessionLimit ?? 100);
	const finalMode = (hasCumulative || hasBucket) ? mode : (sessionMode ?? "cumulative");
	const finalShowTicks = (hasTicks || hasNoTicks) ? showTicks : (sessionShowTicks ?? true);
	const finalTimezone = hasTz ? timezone : sessionTimezone;

	const defaultSettings = {
		interval: "1h",
		limit: 100,
		width: Math.min(paddedWidth, 1023),
		showTicks: true,
		mode: "cumulative" as "cumulative" | "bucket",
		timezone: undefined
	};

	const outputLines = buildWtftLines(interactions, defaultSettings, {
		interval: finalInterval,
		limit: finalLimit,
		width: Math.min(paddedWidth, 1023),
		showTicks: finalShowTicks,
		mode: finalMode,
		timezone: finalTimezone,
		disabledEmoji
	});

	if (!outputLines) {
		console.log(padStr + "No binned data found in session logs.");
		process.exit(0);
	}

	// Session file path above chart (once)
	console.log(padStr + `\x1b[90m${finalSessionPath}\x1b[0m`);
	for (const line of outputLines) {
		console.log(padStr + line);
	}

	// --- Debug: compare tag file cost vs direct parse + dedup cost ---
	if (debugMode) {
		const tagCost = interactions.reduce((sum: number, i: any) => sum + (i.cost || 0), 0);
		const rawInteractions = parseSessionFile(finalSessionPath);
		const directCost = deduplicateInteractions(rawInteractions).reduce((sum, i) => sum + i.cost, 0);
		console.log(padStr + `\x1b[90m── debug ─────────────────────────────────────────────\x1b[0m`);
		console.log(padStr + `\x1b[90m  tag file (daemon): $${tagCost.toFixed(4)}  (${interactions.length} entries)\x1b[0m`);
		console.log(padStr + `\x1b[90m  direct parse+dedup: $${directCost.toFixed(4)}  (${deduplicateInteractions(rawInteractions).length} entries)\x1b[0m`);
		console.log(padStr + `\x1b[90m  raw parse (no dedup): $${rawInteractions.reduce((sum, i) => sum + i.cost, 0).toFixed(4)}  (${rawInteractions.length} entries)\x1b[0m`);
	}

	if (showOther) {
		console.log(""); // empty line spacer
		const dedupedInteractions = deduplicateInteractions(interactions);
		const otherOutput = renderOtherHistogram(dedupedInteractions, Math.min(paddedWidth, 1023));
		for (const line of otherOutput.split("\n")) {
			console.log(padStr + line);
		}
	}

	if (showTokens) {
		const tokenOutput = renderTokenSummary(interactions, Math.min(paddedWidth, 1023), thinkingBudget);
		for (const line of tokenOutput.split("\n")) {
			console.log(padStr + line);
		}
	}
}

main().catch(err => {
	console.error(`❌ System Error: ${err.message}`);
	process.exit(1);
});

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
import { fileURLToPath } from "node:url";
import {
	buildWtftLines,
	parseEntryToInteraction,
	renderOtherHistogram,
	getSemanticCommandGroup,
	formatCost,
	watchMode,
	type WatchSettings,
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
  -W, --watch             Watch a session file for changes and re-render the bar chart in real-time.
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
let showWatch = false;

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
	} else if (arg === "-W" || arg === "--watch") {
		showWatch = true;
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
	name: string;      // e.g. "2026-07-02T01-38-34-253Z_019f207a-4e8d-7527-8290-deb8bc53268a.jsonl"
	displayPath: string; // e.g. "~/g-p/princess-pi-packages/2026-07-02...268a"
}

/**
 * Build a compact display path from the session file's directory slug and filename.
 * Pi slugs use -- as path separator (e.g. --home-user--git-projects--project--).
 * Claude slugs use - and are lossy, so we reconstruct the project name from the
 * known prefix structure.
 */
function buildDisplayPath(filename: string, dirSlug: string, harness: "pi" | "claude-code"): string {
	// UUID tail: last 4 hex chars before .jsonl
	const uuidMatch = filename.match(/([a-f0-9]{4})\.jsonl$/i);
	const uuidTail = uuidMatch ? uuidMatch[1] : "";

	// Strip wrappers: Pi uses --prefix--suffix--, Claude uses -prefix
	let slug = harness === "pi"
		? dirSlug.replace(/^--/, "").replace(/--$/, "")
		: dirSlug.replace(/^-/, "");

	// Known path prefix: home-<user>-git-projects
	// Extract the username from the home directory path
	const homeDir = os.homedir();
	const userName = path.basename(homeDir); // e.g. "princess-pi"
	const knownPrefix = `home-${userName}-git-projects`;

	if (slug.startsWith(knownPrefix + "-")) {
		const projectName = slug.slice(knownPrefix.length + 1); // +1 for the trailing -
		const datePrefix = harness === "pi" ? (filename.split("_")[0] || "") : "";
		const pathStr = `~/g-p/${projectName}`;
		return uuidTail
			? `${pathStr}/${datePrefix}...${uuidTail}`
			: datePrefix ? `${pathStr}/${datePrefix}` : pathStr;
	}

	// Non-standard slug (e.g. --root--, --tmp-pi-test--, --Users-duppy-GitHub-does-it-glider--)
	// Just show it with basic cleanup
	const cleanedSlug = slug.replace(/-/g, "/");
	const datePrefix = harness === "pi" ? (filename.split("_")[0] || "") : "";
	return uuidTail
		? `${cleanedSlug}/${datePrefix}...${uuidTail}`
		: datePrefix ? `${cleanedSlug}/${datePrefix}` : cleanedSlug;
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
				// Compute the project slug from the parent directory
				let slug: string;
				if (type === "pi") {
					slug = path.basename(dir);
				} else {
					// Claude sessions may be in a 'sessions/' subdir
					const base = path.basename(dir);
					slug = base === "sessions" ? path.basename(path.dirname(dir)) : base;
				}
				candidates.push({
					path: fullPath,
					harness: type,
					timestamp: stat.mtimeMs,
					name: f,
					displayPath: buildDisplayPath(f, slug, type)
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

/**
 * Format a timestamp as a relative time string (e.g. "2m ago", "3h ago", "2d ago").
 */
function formatRelativeTime(ts: number): string {
	const diffMs = Date.now() - ts;
	const diffSec = Math.floor(diffMs / 1000);
	if (diffSec < 60) return "just now";
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHr = Math.floor(diffMin / 60);
	if (diffHr < 24) return `${diffHr}h ago`;
	const diffDay = Math.floor(diffHr / 24);
	if (diffDay < 30) return `${diffDay}d ago`;
	const diffMo = Math.floor(diffDay / 30);
	if (diffMo < 12) return `${diffMo}mo ago`;
	return `${Math.floor(diffDay / 365)}y ago`;
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
			// Compute max displayPath width for alignment
			const maxPathLen = Math.max(...candidates.slice(0, 5).map(c => c.displayPath.length), 10);
			for (let i = 0; i < Math.min(candidates.length, 5); i++) {
				const c = candidates[i];
				const stats = getSessionSummary(c.path);
				const relTime = formatRelativeTime(c.timestamp);
				console.log(`  [${i + 1}] ${c.displayPath.padEnd(maxPathLen)}  ${formatCost(stats.cost).padStart(7)}  (${stats.turns}t) [${c.harness === "claude-code" ? "CC" : "PI"}]  \x1b[90m${relTime}\x1b[0m`);
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

		// Compute max displayPath width for alignment across all pages
		const maxPathLen = Math.max(...displayCandidates.map(c => c.displayPath.length), 10);

		const render = () => {
			let out = `\x1b[1m\x1b[36m💸 WTFT Session Selector\x1b[0m (Use ↑/↓ keys, Enter to select, Ctrl+C to cancel):\n`;
			// Full path of currently selected session (unselectable, dim)
			const selected = displayCandidates[selectedIndex];
			out += `  \x1b[90m${selected.path}\x1b[0m\n`;
			for (let i = 0; i < displayCandidates.length; i++) {
				const c = displayCandidates[i];
				const stats = statsList[i];
				const relTime = formatRelativeTime(c.timestamp);
				
				const isSelected = i === selectedIndex;
				const prefix = isSelected ? `\x1b[36m\x1b[1m > \x1b[0m` : "   ";
				const highlight = isSelected ? `\x1b[1m\x1b[36m` : "";
				const reset = isSelected ? `\x1b[0m` : "";
				
				const harnessLabel = c.harness === "claude-code" ? "CC" : "PI";
				const costStr = `\x1b[32m${formatCost(stats.cost).padStart(7)}\x1b[0m`;
				out += `${prefix}${highlight}${c.displayPath.padEnd(maxPathLen)}${reset}  ${costStr}  (${stats.turns}t) [${harnessLabel}]  \x1b[90m${relTime}\x1b[0m\n`;
			}
			process.stdout.write(out);
		};

		const cleanScreen = () => {
			// Move cursor up by (displayCandidates.length + 2) lines (+2 for header + full-path row)
			const linesToClear = displayCandidates.length + 2;
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

// ---
// WATCH MODE: tail -f style live re-rendering (#45)
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

	// ---
	// WATCH MODE: enter live re-render loop (#45)
	// ---
	if (showWatch) {
		const termColumns = getTerminalWidth();
		const maxWidth = hasWidth ? (maxWidthOption as number) : 240;
		await watchMode(finalSessionPath, {
			interval: hasInterval ? intervalStr : "1h",
			limit: hasLimit ? limit : 100,
			width: Math.min(maxWidth, termColumns),
			mode: (hasCumulative || hasBucket) ? mode : "cumulative",
			showTicks: (hasTicks || hasNoTicks) ? showTicks : true,
			timezone: hasTz ? timezone : undefined,
			disabledEmoji: false
		});
		return; // watchMode never returns until SIGINT
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

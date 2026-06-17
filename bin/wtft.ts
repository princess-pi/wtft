#!/usr/bin/env -S node --experimental-strip-types
/**
 * @package princess-pi-packages
 * @command wtft-cli
 * @description Command-line cost auditing tool for Pi Coding Agent session logs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---
// DATA STRUCTURES & TYPES
// ---

type Category = "spec" | "code" | "mixed" | "tests" | "research" | "git" | "grep" | "prompt" | "other";

interface Interaction {
	timestamp: number;
	cost: number;
	files: { path: string; action: "read" | "write" }[];
	commands: string[];
	texts: string[];
}

interface Bin {
	label: string;
	dateStr: string;
	costs: Record<Category, number>;
	total_cost: number;
	incremental_cost?: number;
}

interface IntervalConfig {
	size: number;
	unit: "m" | "h" | "d" | "w";
}

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

// ---
// HELP MENU
// ---

function printHelp() {
	console.log(`
Usage: wtft-cli [options]

Options:
  -s, --session <path>    Specify an explicit session .jsonl log file path (defaults to latest active session).
  -i, --interval <val>    Group cost data into binned intervals (e.g., 1m, 7m, 4h, 1d, 2w; default: 1h).
  -l, --limit <number>    Limit the number of interval bars displayed (default: 100).
  -w, --width <number>    Set the maximum character width of the CLI output (default: 80).
  -c, --cumulative        Render running cumulative sums (default behavior).
  -b, --bucket            Render discrete binned interval cost buckets.
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
	}
}

// ---
// SESSION AUTO-DISCOVERY
// ---

function findLatestSession(): string | null {
	const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
	if (!fs.existsSync(sessionsDir)) return null;

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
		walk(sessionsDir);
	} catch {
		return null;
	}

	return newestFile;
}

const finalSessionPath = targetSessionPath || findLatestSession();
if (!finalSessionPath || !fs.existsSync(finalSessionPath)) {
	console.error("❌ Error: No active session log files found. Ensure Pi has been run, or specify an explicit session log path with -s.");
	process.exit(1);
}

// ---
// LOG PARSER & CLASSIFICATION
// ---

function parseInterval(val: string): IntervalConfig {
	const match = /^(\d+)([mhdw])$/.exec(val);
	if (match) {
		const size = parseInt(match[1], 10);
		const unit = match[2] as "m" | "h" | "d" | "w";
		if (size > 0) return { size, unit };
	}
	return { size: 1, unit: "h" };
}

function classifyInteraction(interaction: Interaction): Category {
	const specPaths = new Set<string>();
	const codePaths = new Set<string>();
	const testsPaths = new Set<string>();
	const researchPaths = new Set<string>();

	for (const f of interaction.files) {
		const norm = f.path.replace(/\\/g, "/");
		let category: "spec" | "code" | "tests" | "research" | null = null;

		if (norm.startsWith("docs/") || norm.includes("/docs/") || norm.endsWith("AGENTS.md") || norm.endsWith("ARCHITECTURE.md") || norm.endsWith("README.md") || path.extname(norm).toLowerCase() === ".md") {
			category = "spec";
		} else if (norm.startsWith("tests/") || norm.includes("/tests/")) {
			category = "tests";
		} else if (norm.startsWith("research/") || norm.includes("/research/")) {
			category = "research";
		} else if (norm.startsWith(".pi/extensions/") || norm.includes("/.pi/extensions/") || norm.startsWith("extensions/") || norm.includes("/extensions/") || norm.startsWith("src/") || norm.includes("/src/") || norm.startsWith("public/") || norm.includes("/public/") || norm.startsWith("bin/") || norm.includes("/bin/")) {
			category = "code";
		} else {
			const ext = path.extname(norm).toLowerCase();
			if ([".ts", ".js", ".mjs", ".json", ".css", ".tsx", ".jsx", ".py", ".rs", ".go", ".sh", ".yml", ".yaml"].includes(ext)) {
				category = "code";
			}
		}

		if (category === "spec") specPaths.add(f.action);
		else if (category === "code") codePaths.add(f.action);
		else if (category === "tests") testsPaths.add(f.action);
		else if (category === "research") researchPaths.add(f.action);
	}

	const specWrites = specPaths.has("write");
	const codeWrites = codePaths.has("write");
	const testsWrites = testsPaths.has("write");
	const researchWrites = researchPaths.has("write");
	const writeCount = (specWrites ? 1 : 0) + (codeWrites ? 1 : 0) + (testsWrites ? 1 : 0) + (researchWrites ? 1 : 0);

	if (writeCount > 1) return "mixed";
	if (writeCount === 1) {
		if (specWrites) return "spec";
		if (codeWrites) return "code";
		if (testsWrites) return "tests";
		if (researchWrites) return "research";
	}

	const hasSpec = specPaths.has("read");
	const hasCode = codePaths.has("read");
	const hasTests = testsPaths.has("read");
	const hasResearch = researchPaths.has("read");
	const readCount = (hasSpec ? 1 : 0) + (hasCode ? 1 : 0) + (hasTests ? 1 : 0) + (hasResearch ? 1 : 0);
	
	if (readCount > 1) return "mixed";
	if (hasSpec) return "spec";
	if (hasCode) return "code";
	if (hasTests) return "tests";
	if (hasResearch) return "research";

	if (interaction.commands.length > 0) {
		let isGit = false;
		let isGrep = false;
		for (const cmd of interaction.commands) {
			const lower = cmd.toLowerCase().trim();
			if (lower === "git" || lower.startsWith("git ")) {
				isGit = true;
			} else if (lower === "grep" || lower.startsWith("grep ") || lower === "rg" || lower.startsWith("rg ") || lower === "ripgrep" || lower.startsWith("ripgrep ") || lower === "find" || lower.startsWith("find ")) {
				isGrep = true;
			}
		}
		if (isGit) return "git";
		if (isGrep) return "grep";
		return "other";
	}

	if (interaction.texts.length > 0) return "prompt";
	return "other";
}

function getZonedParts(timestamp: number, tz?: string) {
	const d = new Date(timestamp);
	if (!tz) {
		return {
			year: d.getFullYear(),
			month: d.getMonth() + 1,
			day: d.getDate(),
			hour: d.getHours(),
			minute: d.getMinutes(),
			second: d.getSeconds()
		};
	}
	try {
		const formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: tz, year: "numeric", month: "numeric", day: "numeric",
			hour: "numeric", minute: "numeric", second: "numeric", hour12: false
		});
		const parts = formatter.formatToParts(d);
		const partMap: Record<string, string> = {};
		for (const p of parts) partMap[p.type] = p.value;
		let hour = parseInt(partMap.hour, 10);
		if (hour === 24) hour = 0;
		return {
			year: parseInt(partMap.year, 10), month: parseInt(partMap.month, 10), day: parseInt(partMap.day, 10),
			hour, minute: parseInt(partMap.minute, 10), second: parseInt(partMap.second, 10)
		};
	} catch {
		return {
			year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
			hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds()
		};
	}
}

function getIsoWeekAndMonday(parts: { year: number; month: number; day: number }) {
	const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
	const day = date.getUTCDay();
	const diffToMonday = day === 0 ? 6 : day - 1;
	const mondayDate = new Date(date.getTime() - diffToMonday * 24 * 60 * 60 * 1000);
	const thursdayDate = new Date(mondayDate.getTime() + 3 * 24 * 60 * 60 * 1000);
	const targetYear = thursdayDate.getUTCFullYear();
	const jan1 = new Date(Date.UTC(targetYear, 0, 1));
	const jan1Day = jan1.getUTCDay();
	const firstThursday = new Date(jan1.getTime() + ((4 - jan1Day + 7) % 7) * 24 * 60 * 60 * 1000);
	const weekNum = 1 + Math.round((thursdayDate.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
	return {
		weekNum,
		mondayYear: mondayDate.getUTCFullYear(),
		mondayMonth: mondayDate.getUTCMonth() + 1,
		mondayDay: mondayDate.getUTCDate()
	};
}

function getBinInfo(timestamp: number, config: IntervalConfig, tz?: string) {
	const parts = getZonedParts(timestamp, tz);
	const pad = (n: number) => String(n).padStart(2, "0");
	const dateStr = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
	const { size, unit } = config;

	if (unit === "m") {
		const totalMins = parts.hour * 60 + parts.minute;
		const binnedMins = Math.floor(totalMins / size) * size;
		return {
			key: `${dateStr}T${pad(Math.floor(binnedMins / 60))}:${pad(binnedMins % 60)}:00`,
			label: `${pad(Math.floor(binnedMins / 60))}:${pad(binnedMins % 60)}`,
			dateStr
		};
	} else if (unit === "h") {
		const startHours = Math.floor(parts.hour / size) * size;
		return {
			key: `${dateStr}T${pad(startHours)}:00:00`,
			label: `${pad(startHours)}:00`,
			dateStr
		};
	} else if (unit === "d") {
		const binnedDays = Math.floor((parts.day - 1) / size) * size;
		const label = `${parts.year}-${pad(parts.month)}-${pad(binnedDays + 1)}`;
		return { key: `${label}T00:00:00`, label, dateStr: label };
	} else {
		const info = getIsoWeekAndMonday(parts);
		const label = `W${pad(info.weekNum)} ${pad(info.mondayMonth)}-${pad(info.mondayDay)}`;
		return {
			key: `${info.mondayYear}-${pad(info.mondayMonth)}-${pad(info.mondayDay)}T00:00:00`,
			label,
			dateStr: `${info.mondayYear}-${pad(info.mondayMonth)}-${pad(info.mondayDay)}`
		};
	}
}

function distributeChars(costs: Record<Category, number>, barWidth: number): Record<Category, number> {
	const total = Object.values(costs).reduce((sum, val) => sum + val, 0);
	const result = {} as Record<Category, number>;
	const remainders = {} as Record<Category, number>;
	const categories = Object.keys(costs) as Category[];
	
	if (total <= 0 || barWidth <= 0) {
		for (const cat of categories) result[cat] = 0;
		return result;
	}

	let allocated = 0;
	for (const cat of categories) {
		const raw = (costs[cat] / total) * barWidth;
		result[cat] = Math.floor(raw);
		remainders[cat] = raw - result[cat];
		allocated += result[cat];
	}

	while (allocated < barWidth) {
		let maxCat: Category | null = null;
		let maxRemainder = -1;
		for (const cat of categories) {
			if (remainders[cat] > maxRemainder) {
				maxRemainder = remainders[cat];
				maxCat = cat;
			}
		}
		if (maxCat) {
			result[maxCat]++;
			remainders[maxCat] = -1;
			allocated++;
		} else {
			break;
		}
	}
	return result;
}

function buildTickLines(maxCost: number, barWidth: number) {
	if (maxCost <= 0 || barWidth < 15) return { labelsLine: null, markersLine: null };
	const labelArr = Array(barWidth).fill(" ");
	const markerArr = Array(barWidth).fill("─");
	const occupied = Array(barWidth).fill(false);
	const midIdx = Math.floor(barWidth / 2);
	const q1Idx = Math.floor(barWidth / 4);
	const q3Idx = Math.floor((barWidth * 3) / 4);

	markerArr[0] = "┿"; markerArr[barWidth - 1] = "┿";
	markerArr[midIdx] = "┿"; markerArr[q1Idx] = "┿"; markerArr[q3Idx] = "┿";

	const tryPlaceLabel = (text: string, startIdx: number) => {
		const len = text.length;
		if (startIdx + len > barWidth) startIdx = barWidth - len;
		if (startIdx < 0) return false;
		for (let i = startIdx; i < startIdx + len; i++) if (occupied[i]) return false;
		for (let i = 0; i < len; i++) labelArr[startIdx + i] = text[i];
		const padStart = Math.max(0, startIdx - 1);
		const padEnd = Math.min(barWidth - 1, startIdx + len);
		for (let i = padStart; i <= padEnd; i++) occupied[i] = true;
		return true;
	};

	tryPlaceLabel("$0.00", 0);
	tryPlaceLabel(`$${maxCost.toFixed(2)}`, barWidth - 1);
	if (maxCost > 0) {
		tryPlaceLabel(`$${(maxCost / 2).toFixed(2)}`, midIdx);
		tryPlaceLabel(`$${(maxCost / 4).toFixed(2)}`, q1Idx);
		tryPlaceLabel(`$${((maxCost * 3) / 4).toFixed(2)}`, q3Idx);
	}
	return { labelsLine: labelArr.join(""), markersLine: markerArr.join("") };
}

// ---
// READ & COMPILE LOGS
// ---

const intervalConfig = parseInterval(intervalStr);
const lines = fs.readFileSync(finalSessionPath, "utf8").split("\n");
const interactions: Interaction[] = [];

for (const line of lines) {
	if (!line.trim()) continue;
	try {
		const entry = JSON.parse(line);
		if (entry.type === "message" && entry.message && entry.message.role === "assistant") {
			const assistantMsg = entry.message;
			const cost = assistantMsg.usage?.cost?.total || 0;
			const timestamp = assistantMsg.timestamp || new Date(entry.timestamp).getTime();

			const files: { path: string; action: "read" | "write" }[] = [];
			const commands: string[] = [];
			const texts: string[] = [];

			if (Array.isArray(assistantMsg.content)) {
				for (const block of assistantMsg.content) {
					if (block.type === "text") texts.push(block.text);
					else if (block.type === "thinking") texts.push(block.thinking);
					else if (block.type === "toolCall") {
						const name = block.name;
						const args = block.arguments || {};
						if (name === "read") {
							if (args.path) files.push({ path: args.path, action: "read" });
						} else if (name === "write" || name === "edit") {
							if (args.path) files.push({ path: args.path, action: "write" });
						} else if (name === "bash") {
							if (args.command) commands.push(args.command);
						}
					}
				}
			}
			interactions.push({ timestamp, cost, files, commands, texts });
		}
	} catch {}
}

const binMap = new Map<string, Bin>();
let totalSessionCost = 0;

for (const interaction of interactions) {
	const classification = classifyInteraction(interaction);
	const { key, label, dateStr } = getBinInfo(interaction.timestamp, intervalConfig, timezone);
	totalSessionCost += interaction.cost;

	let bin = binMap.get(key);
	if (!bin) {
		const costs = {} as Record<Category, number>;
		for (const cat of ["spec", "code", "mixed", "tests", "research", "git", "grep", "prompt", "other"] as Category[]) {
			costs[cat] = 0;
		}
		bin = { label, dateStr, costs, total_cost: 0 };
		binMap.set(key, bin);
	}

	bin.costs[classification] += interaction.cost;
	bin.total_cost += interaction.cost;
}

const sortedBins = Array.from(binMap.entries())
	.sort((a, b) => a[0].localeCompare(b[0]))
	.map(entry => entry[1]);

if (mode === "cumulative") {
	const runningCosts = {} as Record<Category, number>;
	for (const cat of ["spec", "code", "mixed", "tests", "research", "git", "grep", "prompt", "other"] as Category[]) {
		runningCosts[cat] = 0;
	}
	let running_total = 0;

	for (const bin of sortedBins) {
		bin.incremental_cost = bin.total_cost;
		running_total += bin.total_cost;
		for (const cat of Object.keys(bin.costs) as Category[]) {
			runningCosts[cat] += bin.costs[cat];
			bin.costs[cat] = runningCosts[cat];
		}
		bin.total_cost = running_total;
	}
}

const reversedBins = sortedBins.reverse();
const displayedBins = reversedBins.slice(0, limit);

if (displayedBins.length === 0) {
	console.log("No binned data found in session logs.");
	process.exit(0);
}

const maxCostInDisplayed = Math.max(...displayedBins.map(b => b.total_cost), 0);
const labelWidth = Math.max(...displayedBins.map(b => b.label.length), 5);
const prefixWidth = mode === "cumulative" ? (labelWidth + 18) : (labelWidth + 10);
const finalWidth = Math.max(width, 40);
const maxBarWidth = finalWidth - prefixWidth;

const newestBin = displayedBins[0];
let titleDateStr = "";
if (newestBin) {
	const parts = newestBin.dateStr.split("-");
	if (parts.length === 3) {
		const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		titleDateStr = `${months[parseInt(parts[1], 10) - 1]}-${String(parts[2]).padStart(2, "0")}`;
	}
}

// Draw Title
const titleLeft = "💸 Where The F***ing Tokens?!";
const titleRight = `Total Cost: $${totalSessionCost.toFixed(2)}`;
const padString = (s: string, len: number) => s.length >= len ? s : s + " ".repeat(len - s.length);
console.log(titleLeft.padEnd(finalWidth - titleRight.length) + titleRight);

// Draw Ticks
if (showTicks && maxCostInDisplayed > 0) {
	const labelPrefix = padString(titleDateStr, prefixWidth);
	const markerPrefix = " ".repeat(prefixWidth);
	const { labelsLine, markersLine } = buildTickLines(maxCostInDisplayed, maxBarWidth);
	if (labelsLine) console.log(labelPrefix + `\x1b[2m${labelsLine}\x1b[0m`);
	if (markersLine) console.log(markerPrefix + `\x1b[2m${markersLine}\x1b[0m`);
}

// Draw Stacked Bars
for (let i = 0; i < displayedBins.length; i++) {
	const bin = displayedBins[i];

	if (showTicks && i > 0 && bin.dateStr !== displayedBins[i - 1].dateStr) {
		const parts = bin.dateStr.split("-");
		const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		const labelDay = `${months[parseInt(parts[1], 10) - 1]}-${String(parts[2]).padStart(2, "0")}`;
		const dayChangeText = `─── ${labelDay} `;
		console.log(`\x1b[2m${dayChangeText + "─".repeat(Math.max(0, finalWidth - dayChangeText.length))}\x1b[0m`);
	}

	const barWidth = maxCostInDisplayed > 0 ? Math.round((bin.total_cost / maxCostInDisplayed) * maxBarWidth) : 0;
	const chars = distributeChars(bin.costs, barWidth);

	let barStr = "";
	if (chars.spec > 0) barStr += `\x1b[92m${"█".repeat(chars.spec)}\x1b[0m`;
	if (chars.mixed > 0) barStr += `\x1b[38;5;120;48;5;208m${"▒".repeat(chars.mixed)}\x1b[0m`;
	if (chars.code > 0) barStr += `\x1b[38;5;208m${"█".repeat(chars.code)}\x1b[0m`;
	if (chars.tests > 0) barStr += `\x1b[93m${"█".repeat(chars.tests)}\x1b[0m`;
	if (chars.research > 0) barStr += `\x1b[95m${"█".repeat(chars.research)}\x1b[0m`;
	if (chars.git > 0) barStr += `\x1b[96m${"█".repeat(chars.git)}\x1b[0m`;
	if (chars.grep > 0) barStr += `\x1b[94m${"█".repeat(chars.grep)}\x1b[0m`;
	if (chars.prompt > 0) barStr += `\x1b[37m${"░".repeat(chars.prompt)}\x1b[0m`;
	if (chars.other > 0) barStr += `\x1b[90m${"░".repeat(chars.other)}\x1b[0m`;

	const labelPart = padString(bin.label, labelWidth);
	const coloredLabel = `\x1b[2m${labelPart}\x1b[0m`;

	if (mode === "cumulative") {
		const incSign = (bin.incremental_cost ?? 0) >= 0 ? "+" : "";
		const incStr = `${incSign}${(bin.incremental_cost ?? 0).toFixed(2)}`;
		const coloredInc = `\x1b[37m${padString(incStr, 6)}\x1b[0m`;
		const coloredCost = `\x1b[1;37m${padString(`$${bin.total_cost.toFixed(2)}`, 6)}\x1b[0m`;
		console.log(`${coloredLabel}  ${coloredInc}  ${coloredCost}  ${barStr}`);
	} else {
		const coloredCost = `\x1b[1;37m${padString(`$${bin.total_cost.toFixed(2)}`, 6)}\x1b[0m`;
		console.log(`${coloredLabel}  ${coloredCost}  ${barStr}`);
	}
}

console.log(`Legend: \x1b[92m█\x1b[0m Spec   \x1b[38;5;120;48;5;208m▒\x1b[0m Mixed   \x1b[38;5;208m█\x1b[0m Code   \x1b[93m█\x1b[0m Tests   \x1b[95m█\x1b[0m Research   \x1b[96m█\x1b[0m Git   \x1b[94m█\x1b[0m Grep   \x1b[37m░\x1b[0m Prompt   \x1b[90m░\x1b[0m Other`);

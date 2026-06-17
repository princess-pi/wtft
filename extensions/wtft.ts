import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

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
	incremental_cost?: number; // Stores the original bucket cost before cumulative summing
}

interface IntervalConfig {
	size: number;
	unit: "m" | "h" | "d" | "w";
}

// ---
// ARGUMENT PARSING
// ---

/**
 * Parses a raw interval string like "7m", "4h", "3d", "2w" into structured numeric size and unit.
 * Defaults to size: 1, unit: "h" if invalid.
 */
function parseInterval(val: string): IntervalConfig {
	const match = /^(\d+)([mhdw])$/.exec(val);
	if (match) {
		const size = parseInt(match[1], 10);
		const unit = match[2] as "m" | "h" | "d" | "w";
		if (size > 0) {
			return { size, unit };
		}
	}
	return { size: 1, unit: "h" }; // Default 1h
}

/**
 * Parses raw command argument string into typed options.
 * Supports standard flags (-i, --interval, -l, --limit, -w, --width, -c, --cumulative, -b, --bucket, --ticks, --no-ticks, -H, --hide, -S, --show, -h, --help, -t, --tz, --timezone).
 */
function parseArgs(argsStr: string = "") {
	const str = argsStr || "";
	const args = str.trim().split(/\s+/).filter(Boolean);
	let interval = "1h";
	let limit = 10;
	let width = 80;
	let timezone: string | undefined = undefined;
	let hideWidget = false;
	let showWidget = false;
	let showHelp = false;
	let showTicks = true;
	let mode: "bucket" | "cumulative" = "cumulative";

	let hasInterval = false;
	let hasLimit = false;
	let hasWidth = false;
	let hasTicks = false;
	let hasMode = false;
	let hasTimezone = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			showHelp = true;
		} else if (arg === "--hide" || arg === "-H") {
			hideWidget = true;
		} else if (arg === "--show" || arg === "-S") {
			showWidget = true;
		} else if (arg === "--ticks") {
			showTicks = true;
			hasTicks = true;
		} else if (arg === "--no-ticks") {
			showTicks = false;
			hasTicks = true;
		} else if (arg === "--cumulative" || arg === "-c") {
			mode = "cumulative";
			hasMode = true;
		} else if (arg === "--bucket" || arg === "-b") {
			mode = "bucket";
			hasMode = true;
		} else if (arg === "-i" || arg === "--interval") {
			const val = args[i + 1];
			if (val && /^(\d+)([mhdw])$/.test(val)) {
				interval = val;
				hasInterval = true;
				i++;
			}
		} else if (arg === "-l" || arg === "--limit") {
			const val = args[i + 1];
			const num = parseInt(val, 10);
			if (!isNaN(num) && num > 0) {
				limit = num;
				hasLimit = true;
				i++;
			}
		} else if (arg === "-w" || arg === "--width") {
			const val = args[i + 1];
			const num = parseInt(val, 10);
			if (!isNaN(num) && num > 0) {
				width = num;
				hasWidth = true;
				i++;
			}
		} else if (arg === "-t" || arg === "--tz" || arg === "--timezone") {
			const val = args[i + 1];
			if (val && !val.startsWith("-")) {
				timezone = val;
				hasTimezone = true;
				i++;
			}
		} else if (arg.startsWith("--interval=")) {
			const val = arg.split("=")[1];
			if (val && /^(\d+)([mhdw])$/.test(val)) {
				interval = val;
				hasInterval = true;
			}
		} else if (arg.startsWith("--limit=")) {
			const val = arg.split("=")[1];
			const num = parseInt(val, 10);
			if (!isNaN(num) && num > 0) {
				limit = num;
				hasLimit = true;
			}
		} else if (arg.startsWith("--width=")) {
			const val = arg.split("=")[1];
			const num = parseInt(val, 10);
			if (!isNaN(num) && num > 0) {
				width = num;
				hasWidth = true;
			}
		} else if (arg.startsWith("--tz=")) {
			timezone = arg.split("=")[1];
			hasTimezone = true;
		} else if (arg.startsWith("--timezone=")) {
			timezone = arg.split("=")[1];
			hasTimezone = true;
		}
	}

	return {
		interval,
		limit,
		width,
		timezone,
		hideWidget,
		showWidget,
		showTicks,
		mode,
		showHelp,
		hasInterval,
		hasLimit,
		hasWidth,
		hasTicks,
		hasMode,
		hasTimezone
	};
}

// ---
// LOG PARSER & CLASSIFICATION
// ---

/**
 * Classifies an interaction based on file modifications/reads, executed bash commands,
 * and text keywords. If both spec and code indicators are triggered, it is classified as "mixed".
 * 
 * NOTE: This classification runs 100% locally in JavaScript and consumes ZERO LLM tokens!
 */
function classifyInteraction(interaction: Interaction): Category {
	const specPaths = new Set<string>();
	const codePaths = new Set<string>();
	const testsPaths = new Set<string>();
	const researchPaths = new Set<string>();

	// Categorize file paths
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

	// Priority logic for writes
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

	// Read only logic
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

	// No files, look at commands
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

	// No files, no commands, look at texts
	if (interaction.texts.length > 0) return "prompt";
	return "other";
}

// ---
// TIMEZONE AND TIME BINNING
// ---

/**
 * Returns year, month (1-indexed), day, hour, minute, second for a timestamp in a given timezone.
 * Defaults to the local system time if tz is undefined or invalid.
 */
function getZonedParts(timestamp: number, tz?: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
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
			timeZone: tz,
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
			hour12: false
		});
		const parts = formatter.formatToParts(d);
		const partMap: Record<string, string> = {};
		for (const p of parts) {
			partMap[p.type] = p.value;
		}

		let hour = parseInt(partMap.hour, 10);
		if (hour === 24) hour = 0; // en-US standard sometimes returns 24 instead of 00 at midnight when hour12 is false

		return {
			year: parseInt(partMap.year, 10),
			month: parseInt(partMap.month, 10),
			day: parseInt(partMap.day, 10),
			hour,
			minute: parseInt(partMap.minute, 10),
			second: parseInt(partMap.second, 10)
		};
	} catch {
		// Fallback to local system time if timezone is invalid
		return {
			year: d.getFullYear(),
			month: d.getMonth() + 1,
			day: d.getDate(),
			hour: d.getHours(),
			minute: d.getMinutes(),
			second: d.getSeconds()
		};
	}
}

/**
 * Calculates the ISO week number and the preceding Monday for a given date.
 * ISO 8601 weeks always start on Monday.
 */
function getIsoWeekAndMonday(parts: { year: number; month: number; day: number }): { weekNum: number; mondayMonth: number; mondayDay: number; mondayYear: number } {
	const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
	const day = date.getUTCDay();
	
	// Preceding Monday offset: Sunday (0) goes back 6 days, Mon (1) goes back 0 days...
	const diffToMonday = day === 0 ? 6 : day - 1;
	const mondayDate = new Date(date.getTime() - diffToMonday * 24 * 60 * 60 * 1000);
	
	// Find the Thursday of this ISO week
	const thursdayDate = new Date(mondayDate.getTime() + 3 * 24 * 60 * 60 * 1000);
	const targetYear = thursdayDate.getUTCFullYear();
	
	// First Thursday of targetYear
	const jan1 = new Date(Date.UTC(targetYear, 0, 1));
	const jan1Day = jan1.getUTCDay();
	const firstThursday = new Date(jan1.getTime() + ((4 - jan1Day + 7) % 7) * 24 * 60 * 60 * 1000);
	
	// Calculate weeks difference
	const weekNum = 1 + Math.round((thursdayDate.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
	
	return {
		weekNum,
		mondayYear: mondayDate.getUTCFullYear(),
		mondayMonth: mondayDate.getUTCMonth() + 1,
		mondayDay: mondayDate.getUTCDate()
	};
}

/**
 * Maps a timestamp to an interval key, a shortened formatted display label,
 * and a standardized date string. Evaluates in the configured timezone.
 */
function getBinInfo(timestamp: number, config: IntervalConfig, tz?: string): { key: string; label: string; dateStr: string } {
	const parts = getZonedParts(timestamp, tz);
	const pad = (n: number) => String(n).padStart(2, "0");
	const dateStr = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
	const { size, unit } = config;

	if (unit === "m") {
		const totalMins = parts.hour * 60 + parts.minute;
		const binnedMins = Math.floor(totalMins / size) * size;
		const startHours = Math.floor(binnedMins / 60);
		const startMins = binnedMins % 60;
		
		const label = `${pad(startHours)}:${pad(startMins)}`;
		const key = `${dateStr}T${pad(startHours)}:${pad(startMins)}:00`;
		return { key, label, dateStr };
	} else if (unit === "h") {
		const startHours = Math.floor(parts.hour / size) * size;
		const label = `${pad(startHours)}:00`;
		const key = `${dateStr}T${pad(startHours)}:00:00`;
		return { key, label, dateStr };
	} else if (unit === "d") {
		const binnedDays = Math.floor((parts.day - 1) / size) * size;
		const startDay = binnedDays + 1;
		const label = `${parts.year}-${pad(parts.month)}-${pad(startDay)}`;
		const key = `${parts.year}-${pad(parts.month)}-${pad(startDay)}T00:00:00`;
		return { key, label, dateStr: label };
	} else {
		// unit === "w" (ISO 8601 week number & Monday)
		const info = getIsoWeekAndMonday(parts);
		const label = `W${pad(info.weekNum)} ${pad(info.mondayMonth)}-${pad(info.mondayDay)}`;
		const key = `${info.mondayYear}-${pad(info.mondayMonth)}-${pad(info.mondayDay)}T00:00:00`;
		return { key, label, dateStr: `${info.mondayYear}-${pad(info.mondayMonth)}-${pad(info.mondayDay)}` };
	}
}

// ---
// MATHEMATICAL CHARS DISTRIBUTION
// ---

/**
 * Distributes character counts across all categories using
 * the Largest Remainder Method, ensuring the total matches barWidth exactly.
 */
function distributeChars(
	costs: Record<Category, number>,
	barWidth: number
): Record<Category, number> {
	const total = Object.values(costs).reduce((sum, val) => sum + val, 0);
	const result = {} as Record<Category, number>;
	const remainders = {} as Record<Category, number>;
	
	const categories = Object.keys(costs) as Category[];
	
	if (total <= 0 || barWidth <= 0) {
		for (const cat of categories) {
			result[cat] = 0;
		}
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
			remainders[maxCat] = -1; // Mark as allocated
			allocated++;
		} else {
			break;
		}
	}

	return result;
}

// ---
// SCALE TICKS GENERATOR
// ---

/**
 * Places tick markers above the bars at mathematically proportional intervals.
 */
function buildTickLines(maxCost: number, barWidth: number): { labelsLine: string | null; markersLine: string | null } {
	if (maxCost <= 0 || barWidth < 15) {
		return { labelsLine: null, markersLine: null };
	}

	const labelArr = Array(barWidth).fill(" ");
	const markerArr = Array(barWidth).fill("─");
	const occupied = Array(barWidth).fill(false);

	const midIdx = Math.floor(barWidth / 2);
	const q1Idx = Math.floor(barWidth / 4);
	const q3Idx = Math.floor((barWidth * 3) / 4);

	markerArr[0] = "┿";
	markerArr[barWidth - 1] = "┿";
	markerArr[midIdx] = "┿";
	markerArr[q1Idx] = "┿";
	markerArr[q3Idx] = "┿";
	const markersLine = markerArr.join("");

	const tryPlaceLabel = (text: string, startIdx: number): boolean => {
		const len = text.length;
		if (startIdx + len > barWidth) {
			startIdx = barWidth - len;
		}
		if (startIdx < 0) {
			return false;
		}

		for (let i = startIdx; i < startIdx + len; i++) {
			if (occupied[i]) return false;
		}

		for (let i = 0; i < len; i++) {
			labelArr[startIdx + i] = text[i];
		}

		const padStart = Math.max(0, startIdx - 1);
		const padEnd = Math.min(barWidth - 1, startIdx + len);
		for (let i = padStart; i <= padEnd; i++) {
			occupied[i] = true;
		}
		return true;
	};

	tryPlaceLabel("$0.00", 0);
	tryPlaceLabel(`$${maxCost.toFixed(2)}`, barWidth - 1);

	if (maxCost > 0) {
		tryPlaceLabel(`$${(maxCost / 2).toFixed(2)}`, midIdx);
	}

	if (maxCost > 0) {
		tryPlaceLabel(`$${(maxCost / 4).toFixed(2)}`, q1Idx);
		tryPlaceLabel(`$${((maxCost * 3) / 4).toFixed(2)}`, q3Idx);
	}

	const labelsLine = labelArr.join("");
	return { labelsLine, markersLine };
}

// ---
// STATE PERSISTENCE (STORE/RETRIEVE)
// ---

/**
 * Retrieves setting configurations stored persistently in the session log.
 * Defaults mode to "cumulative" for cohesive cost progression tracks.
 */
function getSettings(ctx: any) {
	let interval = "1h";
	let limit = 10;
	let width = 80;
	let visible = false; // Default invisible on fresh session
	let showTicks = true;
	let mode: "bucket" | "cumulative" = "cumulative";
	let timezone: string | undefined = "America/Los_Angeles";

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === "wtft-settings") {
			if (entry.data) {
				if (entry.data.interval) interval = entry.data.interval;
				if (typeof entry.data.limit === "number") limit = entry.data.limit;
				if (typeof entry.data.width === "number") width = entry.data.width;
				if (typeof entry.data.visible === "boolean") visible = entry.data.visible;
				if (typeof entry.data.showTicks === "boolean") showTicks = entry.data.showTicks;
				if (entry.data.mode) mode = entry.data.mode;
				if (entry.data.timezone) timezone = entry.data.timezone;
			}
		}
	}

	return { interval, limit, width, visible, showTicks, mode, timezone };
}

// ---
// FORMATTING HELPERS
// ---

function padString(str: string, len: number): string {
	return str.length >= len ? str : str + " ".repeat(len - str.length);
}

function formatCost(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

/**
 * Formats a standardized date string of format YYYY-MM-DD into a localized Mmm-Dd string.
 */
function formatMmmDdStr(dateStr: string): string {
	const parts = dateStr.split("-");
	if (parts.length === 3) {
		const monthIdx = parseInt(parts[1], 10) - 1;
		const day = parseInt(parts[2], 10);
		const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		const pad = (n: number) => String(n).padStart(2, "0");
		if (monthIdx >= 0 && monthIdx < 12) {
			return `${months[monthIdx]}-${pad(day)}`;
		}
	}
	return dateStr;
}

/**
 * Computes visual width of strings, correctly treating surrogate pairs and double-width emojis as 2.
 */
function getVisualLength(str: string): number {
	const clean = str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	let len = 0;
	for (let i = 0; i < clean.length; i++) {
		const code = clean.charCodeAt(i);
		if (code >= 0xD800 && code <= 0xDBFF && i + 1 < clean.length) {
			len += 2;
			i++;
		} else if (code >= 0x3000 && code <= 0x9FFF) {
			len += 2;
		} else {
			len += 1;
		}
	}
	return len;
}

// ---
// TUI WIDGET UPDATE ENGINE
// ---

/**
 * Dynamically computes costs binned by interval and updates the TUI widget
 * positioned below the editor. Operates in the configured timezone.
 */
function updateWtftWidget(
	ctx: any,
	pi: ExtensionAPI,
	opts?: {
		interval?: string;
		limit?: number;
		width?: number;
		visible?: boolean;
		showTicks?: boolean;
		mode?: "bucket" | "cumulative";
		timezone?: string;
	}
) {
	const current = getSettings(ctx);
	const intervalStr = opts?.interval !== undefined ? opts.interval : current.interval;
	const limit = opts?.limit !== undefined ? opts.limit : current.limit;
	const width = opts?.width !== undefined ? opts.width : current.width;
	const visible = opts?.visible !== undefined ? opts.visible : current.visible;
	const showTicks = opts?.showTicks !== undefined ? opts.showTicks : current.showTicks;
	const mode = opts?.mode !== undefined ? opts.mode : current.mode;
	const tz = opts?.timezone !== undefined ? opts.timezone : current.timezone;

	if (!visible) {
		ctx.ui.setWidget("wtft", undefined);
		return;
	}

	const intervalConfig = parseInterval(intervalStr);
	const branch = ctx.sessionManager.getBranch();
	const interactions: Interaction[] = [];

	for (let i = 0; i < branch.length; i++) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message && entry.message.role === "assistant") {
			const assistantMsg = entry.message;
			const cost = assistantMsg.usage?.cost?.total || 0;
			const timestamp = assistantMsg.timestamp || new Date(entry.timestamp).getTime();

			const files: { path: string; action: "read" | "write" }[] = [];
			const commands: string[] = [];
			const texts: string[] = [];

			if (Array.isArray(assistantMsg.content)) {
				for (const block of assistantMsg.content) {
					if (block.type === "text") {
						texts.push(block.text);
					} else if (block.type === "thinking") {
						texts.push(block.thinking);
					} else if (block.type === "toolCall") {
						const name = block.name;
						const args = block.arguments || {};
						if (name === "read") {
							if (args.path) files.push({ path: args.path, action: "read" });
						} else if (name === "write" || name === "edit") {
							if (args.path) files.push({ path: args.path, action: "write" });
						} else if (name === "bash") {
							if (args.command) {
								commands.push(args.command);
							}
						}
					}
				}
			}

			interactions.push({ timestamp, cost, files, commands, texts });
		}
	}

	// Group interactions into binned intervals
	const binMap = new Map<string, Bin>();
	let totalSessionCost = 0;

	for (const interaction of interactions) {
		const classification = classifyInteraction(interaction);
		const { key, label, dateStr } = getBinInfo(interaction.timestamp, intervalConfig, tz);
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

	// Sort bins chronological (ascending)
	const sortedBins = Array.from(binMap.entries())
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(entry => entry[1]);

	// Apply mode conversions
	if (mode === "cumulative") {
		const runningCosts = {} as Record<Category, number>;
		for (const cat of ["spec", "code", "mixed", "tests", "research", "git", "grep", "prompt", "other"] as Category[]) {
			runningCosts[cat] = 0;
		}
		let running_total = 0;

		for (const bin of sortedBins) {
			bin.incremental_cost = bin.total_cost; // Preserve binned cost
			running_total += bin.total_cost;

			for (const cat of Object.keys(bin.costs) as Category[]) {
				runningCosts[cat] += bin.costs[cat];
				bin.costs[cat] = runningCosts[cat];
			}
			bin.total_cost = running_total;
		}
	}

	// Descending order for binned bars display
	const reversedBins = sortedBins.reverse();
	const displayedBins = reversedBins.slice(0, limit);

	if (displayedBins.length === 0) {
		ctx.ui.setWidget("wtft", undefined);
		return;
	}

	const maxCostInDisplayed = Math.max(...displayedBins.map(b => b.total_cost), 0);

	// Compute dynamic column and prefix widths based on the max width of binned labels in this redraw
	const labelWidth = Math.max(...displayedBins.map(b => b.label.length), 5);
	const prefixWidth = mode === "cumulative" ? (labelWidth + 18) : (labelWidth + 10);
	const finalWidth = Math.max(width, 40);
	const maxBarWidth = finalWidth - prefixWidth;

	// Resolve the newest local date for display on the ticks line
	const newestBin = displayedBins[0];
	let titleDateStr = "";
	if (newestBin) {
		titleDateStr = formatMmmDdStr(newestBin.dateStr);
	} else {
		const nowParts = getZonedParts(Date.now(), tz);
		const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		const pad = (n: number) => String(n).padStart(2, "0");
		titleDateStr = `${months[nowParts.month - 1]}-${pad(nowParts.day)}`;
	}

	const widgetLines: string[] = [];
	
	// Format tight-justified title using the money-with-wings emoji 💸 (no date, right-justified Total Cost unit)
	const titleLeft = "💸 Where The F***ing Tokens?!";
	const titleRight = `Total Cost: ${formatCost(totalSessionCost)}`;
	const leftLen = getVisualLength(titleLeft);
	const rightLen = getVisualLength(titleRight);
	const spacesNeeded = Math.max(1, finalWidth - leftLen - rightLen);
	const titleLine = titleLeft + " ".repeat(spacesNeeded) + titleRight;
	
	widgetLines.push(titleLine);

	// Render tick labels and marker lines above the bars if enabled
	if (showTicks && maxCostInDisplayed > 0) {
		// Embed the date right-aligned inside the prefix spaces before the first tick label starts!
		const labelPrefix = padString(titleDateStr, prefixWidth);
		const markerPrefix = " ".repeat(prefixWidth);

		const { labelsLine, markersLine } = buildTickLines(maxCostInDisplayed, maxBarWidth);
		if (labelsLine) {
			widgetLines.push(labelPrefix + `\x1b[2m${labelsLine}\x1b[0m`);
		}
		if (markersLine) {
			widgetLines.push(markerPrefix + `\x1b[2m${markersLine}\x1b[0m`);
		}
	}

	// Render binned stacked bars
	for (let i = 0; i < displayedBins.length; i++) {
		const bin = displayedBins[i];

		// If crossing a local day boundary (current bin date is different from previous in descending loop),
		// draw a visual day change indicator line only if ticks are enabled!
		if (showTicks && i > 0 && bin.dateStr !== displayedBins[i - 1].dateStr) {
			const labelDay = formatMmmDdStr(bin.dateStr);
			const dayChangeText = `─── ${labelDay} `;
			const dividerLine = dayChangeText + "─".repeat(Math.max(0, finalWidth - dayChangeText.length));
			widgetLines.push(`\x1b[2m${dividerLine}\x1b[0m`);
		}

		const barWidth = maxCostInDisplayed > 0 ? Math.round((bin.total_cost / maxCostInDisplayed) * maxBarWidth) : 0;
		const chars = distributeChars(bin.costs, barWidth);

		let barStr = "";
		if (chars.spec > 0) {
			barStr += `\x1b[92m${"█".repeat(chars.spec)}\x1b[0m`; // Spec Work (Green)
		}
		if (chars.mixed > 0) {
			// Blended Spec + Code (Green foreground, Orange background, Medium Shade glyph)
			barStr += `\x1b[38;5;120;48;5;208m${"▒".repeat(chars.mixed)}\x1b[0m`; // Mixed Work (Blended)
		}
		if (chars.code > 0) {
			barStr += `\x1b[38;5;208m${"█".repeat(chars.code)}\x1b[0m`; // Code Work (Orange)
		}
		if (chars.tests > 0) {
			barStr += `\x1b[93m${"█".repeat(chars.tests)}\x1b[0m`; // Tests Work (Yellow)
		}
		if (chars.research > 0) {
			barStr += `\x1b[95m${"█".repeat(chars.research)}\x1b[0m`; // Research Work (Magenta)
		}
		if (chars.git > 0) {
			barStr += `\x1b[96m${"█".repeat(chars.git)}\x1b[0m`; // Git Work (Cyan)
		}
		if (chars.grep > 0) {
			barStr += `\x1b[94m${"█".repeat(chars.grep)}\x1b[0m`; // Grep Work (Blue)
		}
		if (chars.prompt > 0) {
			barStr += `\x1b[37m${"░".repeat(chars.prompt)}\x1b[0m`; // Prompt Work (White/Dim)
		}
		if (chars.other > 0) {
			barStr += `\x1b[90m${"░".repeat(chars.other)}\x1b[0m`; // Other Work (Dark Grey)
		}

		const labelPart = padString(bin.label, labelWidth);
		const coloredLabel = `\x1b[2m${labelPart}\x1b[0m`; // Dim White
		
		if (mode === "cumulative") {
			// Prepend plus to the incremental cost
			const incSign = (bin.incremental_cost ?? 0) >= 0 ? "+" : "";
			const incStr = `${incSign}${formatCost(bin.incremental_cost ?? 0)}`;
			const incPart = padString(incStr, 6);
			const coloredInc = `\x1b[37m${incPart}\x1b[0m`; // Slightly brighter than dim (Normal grey/white)

			const costPart = padString(formatCost(bin.total_cost), 6);
			const coloredCost = `\x1b[1;37m${costPart}\x1b[0m`; // Normal/Bright White
			
			widgetLines.push(`${coloredLabel}  ${coloredInc}  ${coloredCost}  ${barStr}`);
		} else {
			// Bucket mode (no cumulative or incremental, just simple bucket cost)
			const costPart = padString(formatCost(bin.total_cost), 6);
			const coloredCost = `\x1b[1;37m${costPart}\x1b[0m`; // Normal/Bright White
			widgetLines.push(`${coloredLabel}  ${coloredCost}  ${barStr}`);
		}
	}

	widgetLines.push(`Legend: \x1b[92m█\x1b[0m Spec   \x1b[38;5;120;48;5;208m▒\x1b[0m Mixed   \x1b[38;5;208m█\x1b[0m Code   \x1b[93m█\x1b[0m Tests   \x1b[95m█\x1b[0m Research   \x1b[96m█\x1b[0m Git   \x1b[94m█\x1b[0m Grep   \x1b[37m░\x1b[0m Prompt   \x1b[90m░\x1b[0m Other`);

	ctx.ui.setWidget("wtft", widgetLines, { placement: "belowEditor" });
}

// ---
// MAIN EXTENSION ENTRY POINT
// ---

export default function wtftExtension(pi: ExtensionAPI) {
	// 1. Auto-restore on startup
	pi.on("session_start", async (_event, ctx) => {
		const current = getSettings(ctx);
		if (current.visible) {
			updateWtftWidget(ctx, pi);
		}
	});

	// 2. Auto-refresh on turn completion (zero token cost)
	pi.on("agent_end", async (_event, ctx) => {
		const current = getSettings(ctx);
		if (current.visible) {
			updateWtftWidget(ctx, pi);
		}
	});

	// 3. Command registration
	pi.registerCommand("wtft", {
		description: "Where The F***ing Tokens?! (WTFT) - Cost Auditing Widget",
		handler: async (args, ctx) => {
			const {
				interval,
				limit,
				width,
				timezone,
				hideWidget,
				showWidget,
				showTicks,
				mode,
				showHelp,
				hasInterval,
				hasLimit,
				hasWidth,
				hasTicks,
				hasMode,
				hasTimezone
			} = parseArgs(args);

			// Render manifest help menu if requested
			if (showHelp) {
				try {
					const manifestPath = path.join(process.cwd(), "docs", "manifests", "wtft-cmd.json");
					const manifestStr = fs.readFileSync(manifestPath, "utf8");
					const manifest = JSON.parse(manifestStr);

					let helpText = `\x1b[1m\x1b[36m${manifest.name}\x1b[0m - ${manifest.tagline}\n\n`;
					helpText += `${manifest.description}\n\n`;

					helpText += `\x1b[1mUsage:\x1b[0m\n`;
					for (const u of manifest.usage) {
						helpText += `  ${manifest.name} ${(u.flags).padEnd(28)} ${u.desc}\n`;
					}

					helpText += `\n\x1b[1mExamples:\x1b[0m\n`;
					for (const e of manifest.examples) {
						helpText += `  ${(e.cmd).padEnd(30)} ${e.desc}\n`;
					}

					ctx.ui.notify(helpText, "info");
				} catch (err) {
					ctx.ui.notify(`⚠️ Failed to load WTFT command manifest: ${err}`, "error");
				}
				return;
			}

			const current = getSettings(ctx);

			if (hideWidget) {
				pi.appendEntry("wtft-settings", {
					interval: current.interval,
					limit: current.limit,
					width: current.width,
					visible: false,
					showTicks: current.showTicks,
					mode: current.mode,
					timezone: current.timezone
				});
				ctx.ui.setWidget("wtft", undefined);
				ctx.ui.notify("Token cost audit widget hidden.", "info");
				return;
			}

			const nextInterval = hasInterval ? interval : current.interval;
			const nextLimit = hasLimit ? limit : current.limit;
			const nextWidth = hasWidth ? width : current.width;
			const nextTicks = hasTicks ? showTicks : current.showTicks;
			const nextMode = hasMode ? mode : current.mode;
			const nextTimezone = hasTimezone ? timezone : current.timezone;

			pi.appendEntry("wtft-settings", {
				interval: nextInterval,
				limit: nextLimit,
				width: nextWidth,
				visible: true,
				showTicks: nextTicks,
				mode: nextMode,
				timezone: nextTimezone
			});

			updateWtftWidget(ctx, pi, {
				interval: nextInterval,
				limit: nextLimit,
				width: nextWidth,
				visible: true,
				showTicks: nextTicks,
				mode: nextMode,
				timezone: nextTimezone
			});

			ctx.ui.notify("Token cost audit widget updated below the editor.", "info");
		}
	});

	// 4. Debugging command
	pi.registerCommand("wtft-other", {
		description: "Debug 'other' interactions with a bash command histogram",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const commandMap = new Map<string, { count: number; cost: number }>();

			for (const entry of branch) {
				if (entry.type === "message" && entry.message && entry.message.role === "assistant") {
					const assistantMsg = entry.message;
					const cost = assistantMsg.usage?.cost?.total || 0;
					const interaction: Interaction = {
						timestamp: assistantMsg.timestamp || new Date(entry.timestamp).getTime(),
						cost: cost,
						files: [],
						commands: [],
						texts: []
					};

					if (Array.isArray(assistantMsg.content)) {
						for (const block of assistantMsg.content) {
							if (block.type === "toolCall") {
								const args = block.arguments || {};
								if (block.name === "bash") {
									if (args.command) {
										// Split by lines first, then take the first non-empty/non-comment line
										const lines = args.command.split('\n');
										for (const line of lines) {
											const trimmed = line.trim();
											if (trimmed && !trimmed.startsWith("#")) {
												const parts = trimmed.split(" ");
												const primary = parts[0];
												if (primary) {
													interaction.commands.push(primary);
													break; // Only capture the first effective command
												}
											}
										}
									}
								} else if (block.name === "read") {
									if (args.path) interaction.files.push({ path: args.path, action: "read" });
								} else if (block.name === "write" || block.name === "edit") {
									if (args.path) interaction.files.push({ path: args.path, action: "write" });
								}
							}
						}
					}

					if (classifyInteraction(interaction) === "other") {
						for (const cmd of interaction.commands) {
							const existing = commandMap.get(cmd) || { count: 0, cost: 0 };
							commandMap.set(cmd, {
								count: existing.count + 1,
								cost: existing.cost + cost
							});
						}
					}
				}
			}

            let output = "--- 'Other' Command Histogram ---\n";
            
            // Sort command map entries by count descending
            const sortedEntries = Array.from(commandMap.entries()).sort((a, b) => b[1].count - a[1].count);

            // Find max command length for alignment
            let maxCmdLen = 0;
            for (const cmd of commandMap.keys()) maxCmdLen = Math.max(maxCmdLen, cmd.length);
            
            const settings = getSettings(ctx);
            const width = Math.max(settings.width, 40);
            const countWidth = 7; // Fixed width for "(count)"
            const costWidth = 10; // Fixed width for "$1.0000"

            for (const [cmd, data] of sortedEntries) {
                const countStr = `(${data.count})`.padStart(countWidth);
                const costStr = `$${data.cost.toFixed(4)}`.padStart(costWidth);
                
                // Available space for bars
                const barWidth = Math.max(5, width - maxCmdLen - countWidth - costWidth - 10);
                const bar = "#".repeat(Math.min(data.count, barWidth));
                
                output += `${cmd.padEnd(maxCmdLen)} ${costStr} ${countStr} : ${bar}\n`;
            }
            ctx.ui.notify(output, "info");
		}
	});
}

/**
 * @package princess-pi-packages
 * @module wtft-shared
 * @description Shared types, parsers, and visual layout compilers for WTFT (TUI widget & CLI).
 */

import * as path from "node:path";

// ---
// DATA STRUCTURES & TYPES
// ---

export type Category = "spec" | "code" | "mixed" | "tests" | "research" | "git" | "grep" | "prompt" | "other";

export interface Interaction {
	timestamp: number;
	cost: number;
	files: { path: string; action: "read" | "write" }[];
	commands: string[];
	texts: string[];
}

export function calculateClaudeCost(model: string, usage: any): number {
	if (!usage) return 0;
	
	// Default to Sonnet pricing
	let inputPrice = 3.00;
	let outputPrice = 15.00;
	let cacheWritePrice = 3.75;
	let cacheReadPrice = 0.30;
	
	const m = (model || "").toLowerCase();
	if (m.includes("haiku")) {
		inputPrice = 0.80;
		outputPrice = 4.00;
		cacheWritePrice = 1.00;
		cacheReadPrice = 0.08;
	} else if (m.includes("opus")) {
		inputPrice = 15.00;
		outputPrice = 75.00;
		cacheWritePrice = 18.75;
		cacheReadPrice = 1.50;
	}
	
	const cost = 
		((usage.input_tokens || 0) * (inputPrice / 1000000)) +
		((usage.output_tokens || 0) * (outputPrice / 1000000)) +
		((usage.cache_creation_input_tokens || 0) * (cacheWritePrice / 1000000)) +
		((usage.cache_read_input_tokens || 0) * (cacheReadPrice / 1000000));
		
	return cost;
}

function extractFilesFromBashCommand(command: string, files: { path: string; action: "read" | "write" }[]) {
	// Heuristically extract the file path to ensure these turns don't fall through to "other" classification.
	const cmdLines = command.split('\n');
	for (const line of cmdLines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("cat ") || trimmed.startsWith("head ") || trimmed.startsWith("tail ")) {
			const parts = trimmed.split(/\s+/);
			if (parts.length > 1) {
				// parts[1] is typically the file path. Handle potential quotes.
				const possiblePath = parts[1].replace(/['"]/g, '');
				if (possiblePath && !possiblePath.startsWith("-")) { // Ignore flags like `cat -n`
					files.push({ path: possiblePath, action: "read" });
				} else if (parts.length > 2 && parts[1].startsWith("-")) {
					// Handle `cat -n file.txt` or `tail -n 50 file.txt`
					// We just try to find the first argument that doesn't start with '-' and isn't a number
					for (let i = 2; i < parts.length; i++) {
						const candidate = parts[i].replace(/['"]/g, '');
						if (!candidate.startsWith("-") && isNaN(Number(candidate))) {
							files.push({ path: candidate, action: "read" });
							break;
						}
					}
				}
			}
		}
	}
}

export function parseEntryToInteraction(entry: any): Interaction | null {
	if (!entry) return null;
	
	// Support both Pi schema (entry.type === "message") and Claude Code schema (entry.type === "assistant" or lacking type but having message)
	const isPiSchema = entry.type === "message" && entry.message && entry.message.role === "assistant";
	const isClaudeSchema = entry.type === "assistant" && entry.message && entry.message.role === "assistant";

	if (isPiSchema || isClaudeSchema) {
		const assistantMsg = entry.message;
		
		let cost = 0;
		if (assistantMsg.usage?.cost?.total !== undefined) {
			// Pi Coding Agent native cost tracking
			cost = assistantMsg.usage.cost.total;
		} else if (assistantMsg.model && assistantMsg.usage) {
			// Claude Code token usage fallback calculation
			cost = calculateClaudeCost(assistantMsg.model, assistantMsg.usage);
		}

		// Use assistantMsg.timestamp if available (Pi), fallback to top-level entry.timestamp (Claude Code)
		let timestampStr = assistantMsg.timestamp || entry.timestamp;
		let timestamp = 0;
		if (typeof timestampStr === "string") {
			timestamp = new Date(timestampStr).getTime();
		} else if (typeof timestampStr === "number") {
			timestamp = timestampStr;
		}

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
					// Pi Schema
					const name = block.name;
					const args = block.arguments || {};
					if (name === "read") {
						if (args.path) files.push({ path: args.path, action: "read" });
					} else if (name === "write" || name === "edit") {
						if (args.path) files.push({ path: args.path, action: "write" });
					} else if (name === "bash") {
						if (args.command) {
							commands.push(args.command);
							extractFilesFromBashCommand(args.command, files);
						}
					}
				} else if (block.type === "tool_use") {
					// Claude Code Schema
					const name = (block.name || "").toLowerCase();
					const args = block.input || {};
					
					if (name === "read" || name === "view" || name === "glob" || name === "ls") {
						const p = args.file_path || args.path || args.directory || args.target;
						if (p) files.push({ path: p, action: "read" });
					} else if (name === "edit" || name === "write" || name === "replace") {
						const p = args.file_path || args.path || args.target;
						if (p) files.push({ path: p, action: "write" });
					} else if (name === "bash" || name === "run") {
						if (args.command) {
							commands.push(args.command);
							extractFilesFromBashCommand(args.command, files);
						}
					}
				}
			}
		}

		return { timestamp, cost, files, commands, texts };
	}
	
	return null;
}

export interface Bin {
	label: string;
	dateStr: string;
	costs: Record<Category, number>;
	total_cost: number;
	incremental_cost?: number;
}

export interface IntervalConfig {
	size: number;
	unit: "m" | "h" | "d" | "w";
}

// ---
// HELPERS & PARSERS
// ---

export function parseInterval(val: string): IntervalConfig {
	const match = /^(\d+)([mhdw])$/.exec(val);
	if (match) {
		const size = parseInt(match[1], 10);
		const unit = match[2] as "m" | "h" | "d" | "w";
		if (size > 0) return { size, unit };
	}
	return { size: 1, unit: "h" };
}

export function classifyInteraction(interaction: Interaction): Category {
	const specPaths = new Set<string>();
	const codePaths = new Set<string>();
	const testsPaths = new Set<string>();
	const researchPaths = new Set<string>();

	for (const f of interaction.files) {
		const norm = f.path.replace(/\\/g, "/");
		let category: "spec" | "code" | "tests" | "research" | null = null;

		if (norm.includes("node_modules/")) {
			// Third-party library documentation/READMEs represent reference material (Research)
			if (path.extname(norm).toLowerCase() === ".md" || norm.includes("/docs/")) {
				category = "research";
			} else {
				category = "code";
			}
		} else if (norm.startsWith("docs/") || norm.includes("/docs/") || norm.endsWith("AGENTS.md") || norm.endsWith("ARCHITECTURE.md") || norm.endsWith("README.md") || path.extname(norm).toLowerCase() === ".md") {
			category = "spec";
		} else if (norm.startsWith("tests/") || norm.includes("/tests/")) {
			category = "tests";
		} else if (norm.startsWith("research/") || norm.includes("/research/")) {
			category = "research";
		} else if (norm.startsWith(".pi/extensions/") || norm.includes("/.pi/extensions/") || norm.startsWith("extensions/") || norm.includes("/extensions/") || norm.startsWith("src/") || norm.includes("/src/") || norm.startsWith("public/") || norm.includes("/public/") || norm.startsWith("bin/") || norm.includes("/bin/")) {
			category = "code";
		} else {
			const ext = path.extname(norm).toLowerCase();
			if ([".ts", ".js", ".mjs", ".json", ".css", ".tsx", ".jsx", ".py", ".rs", ".go", ".sh", ".yml", ".yaml", ".sql"].includes(ext) || norm.endsWith(".gitignore") || norm.endsWith(".dockerignore")) {
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

export function getZonedParts(timestamp: number, tz?: string) {
	const d = new Date(timestamp);
	if (!tz) {
		return {
			year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
			hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds()
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

export function getIsoWeekAndMonday(parts: { year: number; month: number; day: number }) {
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

export function getBinInfo(timestamp: number, config: IntervalConfig, tz?: string) {
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

export function distributeChars(costs: Record<Category, number>, barWidth: number): Record<Category, number> {
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

export function calculateScaleMax(total: number): number {
	if (total <= 0) return 1.0;
	if (total > 20) {
		return Math.ceil(total / 5) * 5;
	} else {
		return Math.ceil(total);
	}
}

export function buildTickLine(maxCost: number, barWidth: number, prefixWidth: number, labelPrefix: string): string | null {
	if (maxCost <= 0 || barWidth < 15) return null;
	
	// Create the unified background characters array for the ENTIRE line width
	const totalWidth = prefixWidth + barWidth;
	const chars = Array(totalWidth).fill("─");

	// Fill the date prefix into the start of the characters array
	const cleanPrefix = labelPrefix.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ""); // Strip ANSI if any
	for (let i = 0; i < cleanPrefix.length; i++) {
		chars[i] = cleanPrefix[i];
	}

	// Calculate absolute tick index positions in the overall line
	const ticks = [
		prefixWidth,
		prefixWidth + Math.floor(barWidth / 4),
		prefixWidth + Math.floor(barWidth / 2),
		prefixWidth + Math.floor((barWidth * 3) / 4),
		prefixWidth + barWidth - 1
	];

	// Draw tick indicators directly into the unified horizontal line
	for (const t of ticks) {
		if (t < chars.length) chars[t] = "┿";
	}

	const labels: {text: string, start: number, end: number}[] = [];
	const tickValues = [0, maxCost / 4, maxCost / 2, (maxCost * 3) / 4, maxCost];

	for (let i = 0; i < ticks.length; i++) {
		const text = `$${tickValues[i].toFixed(2)}`;
		const displayStr = ` ${text} `; // Inverted block padding
		
		const dotIdx = displayStr.indexOf(".");
		// Align the decimal point exactly on the tick index inside the overall line
		const startIdx = ticks[i] - dotIdx;
		const endIdx = startIdx + displayStr.length;

		// Check overlap with existing placed labels
		let overlap = false;
		for (const l of labels) {
			if (startIdx < l.end && endIdx > l.start) {
				overlap = true; break;
			}
		}
		if (!overlap) {
			labels.push({
				text: displayStr,
				start: startIdx,
				end: endIdx
			});
		}
	}

	// Sort labels left-to-right
	labels.sort((a, b) => a.start - b.start);

	let result = "";
	let cursor = 0;

	for (const l of labels) {
		// Fill in the horizontal bar lines before the label
		if (l.start > cursor) {
			result += chars.slice(cursor, Math.min(l.start, chars.length)).join("");
			// If a label starts past the end of the base characters array, pad with spaces
			if (l.start > chars.length) {
				result += " ".repeat(l.start - Math.max(cursor, chars.length));
			}
		}
		// Wrap the label with the ANSI Invert sequence and reset-to-dark-grey sequence
		result += `\x1b[7m${l.text}\x1b[27m`;
		cursor = Math.max(cursor, l.end);
	}

	// Fill in any remaining horizontal bar characters
	if (cursor < chars.length) {
		result += chars.slice(cursor).join("");
	}

	return result;
}

export function padString(str: string, len: number): string {
	return str.length >= len ? str : str + " ".repeat(len - str.length);
}

export function formatCost(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

export function formatMmmDdStr(dateStr: string): string {
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

export function getVisualLength(str: string): number {
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
// MAIN LAYOUT COMPILER
// ---

export function buildWtftLines(
	interactions: Interaction[],
	defaultSettings: {
		interval: string;
		limit: number;
		width: number;
		showTicks: boolean;
		mode: "bucket" | "cumulative";
		timezone?: string;
	},
	opts?: {
		interval?: string;
		limit?: number;
		width?: number;
		showTicks?: boolean;
		mode?: "bucket" | "cumulative";
		timezone?: string;
	}
): string[] | null {
	const intervalStr = opts?.interval !== undefined ? opts.interval : defaultSettings.interval;
	const limit = opts?.limit !== undefined ? opts.limit : defaultSettings.limit;
	const width = opts?.width !== undefined ? opts.width : defaultSettings.width;
	const showTicks = opts?.showTicks !== undefined ? opts.showTicks : defaultSettings.showTicks;
	const mode = opts?.mode !== undefined ? opts.mode : defaultSettings.mode;
	const tz = opts?.timezone !== undefined ? opts.timezone : defaultSettings.timezone;

	const intervalConfig = parseInterval(intervalStr);

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
		return null;
	}

	const maxBarValue = mode === "cumulative"
		? totalSessionCost
		: Math.max(...displayedBins.map(b => b.total_cost), 0);
	const scaleMax = calculateScaleMax(maxBarValue);

	// Compute the exact prefix width of the bar rows dynamically to prevent alignment offsets when costs grow wide
	const labelWidth = Math.max(...displayedBins.map(b => b.label.length), 5);
	let prefixWidth = labelWidth + 2; // labelPart + "  "
	
	let maxIncLen = 6;
	let maxCostLen = 6;

	if (mode === "cumulative") {
		maxIncLen = Math.max(...displayedBins.map(bin => {
			const incSign = (bin.incremental_cost ?? 0) >= 0 ? "+" : "";
			return `${incSign}${formatCost(bin.incremental_cost ?? 0)}`.length;
		}), 6);
		maxCostLen = Math.max(...displayedBins.map(b => formatCost(b.total_cost).length), 6);
		prefixWidth += maxIncLen + 2 + maxCostLen + 2; // incPart + "  " + costPart + "  "
	} else {
		maxCostLen = Math.max(...displayedBins.map(b => formatCost(b.total_cost).length), 6);
		prefixWidth += maxCostLen + 2; // costPart + "  "
	}

	const finalWidth = Math.max(width, 40);
	
	// We reserve 3 characters at the very end of the line.
	// Why? To guarantee that when the final label (e.g. ` $100.00 `) is aligned so its `.` 
	// sits on the final tick, the `.00 ` trailing characters do not overflow `finalWidth`.
	// Shaving exactly 3 characters makes the ticks row length perfectly match `finalWidth`.
	const maxBarWidth = finalWidth - prefixWidth - 3;

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
	
	const titleLeft = "💸 WTF Tokens?";
	
	const legendItems = [
		`\x1b[38;5;108m█\x1b[0m Spec`,
		`\x1b[38;5;108;48;5;173m▒\x1b[0m Mixed`,
		`\x1b[38;5;173m█\x1b[0m Code`,
		`\x1b[38;5;223m█\x1b[0m Tests`,
		`\x1b[38;5;134m█\x1b[0m Research`,
		`\x1b[38;5;73m█\x1b[0m Git`,
		`\x1b[38;5;67m█\x1b[0m Grep`,
		`\x1b[38;5;168m░\x1b[0m Prompt`,
		`\x1b[38;5;238m░\x1b[0m Other`
	];
	const legendStr = legendItems.join("  ");
	
	const leftLen = getVisualLength(titleLeft);
	const legendLen = getVisualLength(legendStr);
	const totalNeeded = leftLen + legendLen + 4; // 4 spaces margin
	
	if (totalNeeded <= finalWidth - 3) {
		const remainingSpaces = (finalWidth - 3) - leftLen - legendLen;
		const titleLine = titleLeft + " ".repeat(remainingSpaces) + legendStr;
		widgetLines.push(titleLine);
	} else {
		widgetLines.push(titleLeft);
		// 2nd row has the legend
		widgetLines.push(legendStr);
	}

	// Render single-row collapsed ticks line
	if (showTicks && scaleMax > 0) {
		const dateLabel = `── ${titleDateStr} `;
		const paddingLen = Math.max(0, prefixWidth - dateLabel.length);
		const labelPrefix = dateLabel + "─".repeat(paddingLen);
		const ticksLine = buildTickLine(scaleMax, maxBarWidth, prefixWidth, labelPrefix);
		if (ticksLine) {
			// Using \x1b[90m (Dark Grey) for the entire tick line (which now contains the prefix already built-in!)
			widgetLines.push(`\x1b[90m${ticksLine}\x1b[0m`);
		}
	}

	// Render binned stacked bars
	for (let i = 0; i < displayedBins.length; i++) {
		const bin = displayedBins[i];

		// If crossing a local day boundary (current bin date is different from previous in descending loop),
		// draw a visual day change indicator line only if ticks are enabled!
		if (showTicks && i > 0 && bin.dateStr !== displayedBins[i - 1].dateStr) {
			const labelDay = formatMmmDdStr(bin.dateStr);
			const dayChangeText = `── ${labelDay} `;
			const dividerLine = dayChangeText + "─".repeat(Math.max(0, (finalWidth - 3) - dayChangeText.length));
			// Use \x1b[30;47m for the day change divider to avoid pure black backgrounds on some terminal themes
			// Wait, the divider is just "dim" text usually. The issue said: "date rows and the time stamp labels... have the jarring black background".
			// If \x1b[2m (dim) is causing black backgrounds on that terminal emulator, it's because
			// the terminal treats "dim" as a background modification in some color schemes, or it's interacting poorly.
			// Let's just use \x1b[90m (bright black/dark grey) which gives the exact same visual "dim" effect 
			// without using the \x1b[2m dim attribute that breaks backgrounds.
			widgetLines.push(`\x1b[90m${dividerLine}\x1b[0m`);
		}

		let barStr = "";
		if (mode === "cumulative") {
			const barWidth = scaleMax > 0 ? Math.round((bin.total_cost / scaleMax) * maxBarWidth) : 0;
			const chars = distributeChars(bin.costs, barWidth);

			if (chars.spec > 0) {
				barStr += `\x1b[38;5;108m${"█".repeat(chars.spec)}\x1b[0m`; // Spec Work (Sage Green)
			}
			if (chars.mixed > 0) {
				// Blended Spec + Code (Sage Green foreground, Terracotta Rust background, Medium Shade glyph)
				barStr += `\x1b[38;5;108;48;5;173m${"▒".repeat(chars.mixed)}\x1b[0m`; // Mixed Work (Blended)
			}
			if (chars.code > 0) {
				barStr += `\x1b[38;5;173m${"█".repeat(chars.code)}\x1b[0m`; // Code Work (Terracotta Rust)
			}
			if (chars.tests > 0) {
				barStr += `\x1b[38;5;223m${"█".repeat(chars.tests)}\x1b[0m`; // Tests Work (Chalky Sand)
			}
			if (chars.research > 0) {
				barStr += `\x1b[38;5;134m${"█".repeat(chars.research)}\x1b[0m`; // Research Work (Plum Lavender)
			}
			if (chars.git > 0) {
				barStr += `\x1b[38;5;73m${"█".repeat(chars.git)}\x1b[0m`; // Git Work (Petrol Teal)
			}
			if (chars.grep > 0) {
				barStr += `\x1b[38;5;67m${"█".repeat(chars.grep)}\x1b[0m`; // Grep Work (Steel Blue)
			}
			if (chars.prompt > 0) {
				barStr += `\x1b[38;5;168m${"░".repeat(chars.prompt)}\x1b[0m`; // Prompt Work (Matte Rose Pink)
			}
			if (chars.other > 0) {
				barStr += `\x1b[38;5;238m${"░".repeat(chars.other)}\x1b[0m`; // Other Work (Charcoal)
			}
		} else {
			// Point-of-spend multi-line chart mode for bucket display
			const cells = Array(maxBarWidth).fill(" ");
			const categoriesInReverse: { cat: Category; color: string; char: string }[] = [
				{ cat: "other", color: "\x1b[38;5;238m", char: "░" },
				{ cat: "prompt", color: "\x1b[38;5;168m", char: "░" },
				{ cat: "grep", color: "\x1b[38;5;67m", char: "█" },
				{ cat: "git", color: "\x1b[38;5;73m", char: "█" },
				{ cat: "research", color: "\x1b[38;5;134m", char: "█" },
				{ cat: "tests", color: "\x1b[38;5;223m", char: "█" },
				{ cat: "code", color: "\x1b[38;5;173m", char: "█" },
				{ cat: "mixed", color: "\x1b[38;5;108;48;5;173m", char: "▒" },
				{ cat: "spec", color: "\x1b[38;5;108m", char: "█" }
			];

			for (const { cat, color, char } of categoriesInReverse) {
				const cost = bin.costs[cat] || 0;
				if (cost > 0 && scaleMax > 0) {
					const pos = Math.round((cost / scaleMax) * (maxBarWidth - 1));
					if (pos >= 0 && pos < maxBarWidth) {
						cells[pos] = `${color}${char}\x1b[0m`;
					}
				}
			}
			barStr = cells.join("");
		}

		const labelPart = padString(bin.label, labelWidth);
		// Replace \x1b[2m with \x1b[90m (dark grey foreground) to avoid terminal emulator background bugs
		const coloredLabel = `\x1b[90m${labelPart}\x1b[0m`; // Dark Grey / Dim White effect
		
		if (mode === "cumulative") {
			// Prepend plus to the incremental cost
			const incSign = (bin.incremental_cost ?? 0) >= 0 ? "+" : "";
			const incStr = `${incSign}${formatCost(bin.incremental_cost ?? 0)}`;
			const incPart = padString(incStr, maxIncLen);
			// Using \x1b[90m for Dark Grey / Bright Black.
			// \x1b[37m is standard white/light-grey, \x1b[1;30m is bold black, and \x1b[90m is high-intensity black (dark grey)
			const coloredInc = `\x1b[90m${incPart}\x1b[0m`; // Dark Grey / Bright Black

			const costPart = padString(formatCost(bin.total_cost), maxCostLen);
			const coloredCost = `\x1b[1;37m${costPart}\x1b[0m`; // Normal/Bright White
			
			widgetLines.push(`${coloredLabel}  ${coloredInc}  ${coloredCost}  ${barStr}`);
		} else {
			// Bucket mode (no cumulative or incremental, just simple bucket cost)
			const costPart = padString(formatCost(bin.total_cost), maxCostLen);
			const coloredCost = `\x1b[1;37m${costPart}\x1b[0m`; // Normal/Bright White
			widgetLines.push(`${coloredLabel}  ${coloredCost}  ${barStr}`);
		}
	}

	return widgetLines;
}

export function renderOtherHistogram(interactions: Interaction[], maxWidth: number = 80): string {
	const commandMap = new Map<string, { count: number; cost: number }>();

	for (const interaction of interactions) {
		const classification = classifyInteraction(interaction);
		if (classification === "other") {
			// Extract exact primary command for bash
			const primaryCommands: string[] = [];
			for (const rawCmd of interaction.commands) {
				const lines = rawCmd.split('\n');
				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed && !trimmed.startsWith("#")) {
						const parts = trimmed.split(" ");
						const primary = parts[0];
						if (primary) {
							primaryCommands.push(primary);
							break; // Only capture the first effective command
						}
					}
				}
			}

			for (const cmd of primaryCommands) {
				const existing = commandMap.get(cmd) || { count: 0, cost: 0 };
				commandMap.set(cmd, {
					count: existing.count + 1,
					cost: existing.cost + interaction.cost
				});
			}
		}
	}

	if (commandMap.size === 0) {
		return "No 'Other' commands found in this session.";
	}

	let output = "--- 'Other' Command Histogram ---\n";
	
	// Sort command map entries by count descending
	const sortedEntries = Array.from(commandMap.entries()).sort((a, b) => b[1].count - a[1].count);

	// Find max command length for alignment
	let maxCmdLen = 0;
	for (const cmd of commandMap.keys()) maxCmdLen = Math.max(maxCmdLen, cmd.length);
	
	const countWidth = 7; // Fixed width for "(count)"
	const costWidth = 10; // Fixed width for "$1.0000"

	for (const [cmd, data] of sortedEntries) {
		const countStr = `(${data.count})`.padStart(countWidth);
		const costStr = `$${data.cost.toFixed(4)}`.padStart(costWidth);
		
		// Available space for bars
		const barWidth = Math.max(5, maxWidth - maxCmdLen - countWidth - costWidth - 10);
		const bar = "#".repeat(Math.min(data.count, barWidth));
		
		output += `${cmd.padEnd(maxCmdLen)} ${costStr} ${countStr} : ${bar}\n`;
	}
	
	return output;
}

/**
 * @package princess-pi-packages
 * @module wtft-shared
 * @description Shared types, parsers, and visual layout compilers for WTFT (TUI widget & CLI).
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { enterRawStdin, showCursor, hideCursor } from "./tty-helpers.ts";

// ---
// DATA STRUCTURES & TYPES
// ---

export type Category = "spec" | "code" | "mixed" | "tests" | "research" | "git" | "grep" | "prompt" | "other";

export interface Interaction {
	timestamp: number;
	cost: number;
	messageId?: string;
	requestId?: string;
	model?: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	files: { path: string; action: "read" | "write" }[];
	commands: string[];
	texts: string[];
	/** Pre-computed classification from the daemon tag file. When set, classifyInteraction() returns this directly. */
	_cat?: Category;
}

// ---
// MODEL COST CALCULATOR
// Supports: Claude (Haiku, Sonnet, Opus) + DeepSeek (v4-flash, v4-pro, legacy chat/reasoner)
// Pricing per 1M tokens. DeepSeek: cache-hit vs cache-miss input pricing;
// conservatively defaults to cache-miss until the DeepSeek Anthropic-compat usage schema is confirmed.
// DeepSeek peak-valley surge pricing (2x) applies during UTC 01:00–04:00 and 06:00–10:00.
// ---

/**
 * DeepSeek peak-valley surge pricing: 2x during peak UTC hours.
 * Peak windows (UTC): 01:00–04:00 and 06:00–10:00.
 * Off-peak: all other hours. Returns 2.0 or 1.0 multiplier.
 */
export function getDeepSeekPeakMultiplier(timestamp?: number): number {
	const ts = timestamp || Date.now();
	const d = new Date(ts);
	const utcHour = d.getUTCHours();
	const utcMin = d.getUTCMinutes();
	const utcTime = utcHour * 60 + utcMin; // minutes since UTC midnight

	// Peak window 1: 01:00–04:00 UTC → minutes 60–240
	// Peak window 2: 06:00–10:00 UTC → minutes 360–600
	if ((utcTime >= 60 && utcTime < 240) || (utcTime >= 360 && utcTime < 600)) {
		return 2.0;
	}
	return 1.0;
}

export function calculateClaudeCost(model: string, usage: any, timestamp?: number): number {
	if (!usage) return 0;
	
	// Default to Claude Sonnet 4.6 pricing ($3/$15 per 1M tokens)
	// Cache write: 1.25x input (5-min TTL), 2.00x input (1-hour TTL)
	// Cache read: 0.10x input (Anthropic standard)
	let inputPrice = 3.00;
	let outputPrice = 15.00;
	let cacheReadPrice = 0.30;
	
	const m = (model || "").toLowerCase();
	if (m.includes("deepseek")) {
		// DeepSeek models — input/output/reasoning pricing. Cache-read pricing
		// uses DeepSeek's cache-hit discount rate (confirmed via Pi usage schema).
		const peak = getDeepSeekPeakMultiplier(timestamp);
		if (m.includes("v4-pro")) {
			// deepseek-v4-pro: $1.74/M input, $3.48/M output, cache-hit $0.0145/M.
			// Reasoning tokens priced at output rate.
			inputPrice = 1.74 * peak;
			outputPrice = 3.48 * peak;
			cacheReadPrice = 0.0145 * peak;
		} else {
			// deepseek-v4-flash + legacy deepseek-chat & deepseek-reasoner:
			// $0.14/M input, $0.28/M output, cache-hit $0.0028/M.
			// (legacy names deprecate 2026-07-24)
			inputPrice = 0.14 * peak;
			outputPrice = 0.28 * peak;
			cacheReadPrice = 0.0028 * peak;
		}
		// DeepSeek does not expose separate cache-write tokens → 0, no TTL split needed
	} else if (m.includes("haiku")) {
		// Claude Haiku 4.5: $1/M input, $5/M output
		inputPrice = 1.00;
		outputPrice = 5.00;
		cacheReadPrice = 0.10;
	} else if (m.includes("opus")) {
		// Claude Opus 4.6/4.7: $5/M input, $25/M output
		inputPrice = 5.00;
		outputPrice = 25.00;
		cacheReadPrice = 0.50;
	}
	
	// ----
	// Cache-write pricing: split by TTL when the breakdown object is present (#55).
	// 5-minute TTL caches = 1.25× input; 1-hour TTL caches = 2.00× input.
	// Falls back to flat 1.25× when only the scalar cache_creation_input_tokens is available.
	// ----
	let cacheWriteCost = 0;
	const cc = usage.cache_creation || {};
	const cw5m = cc.ephemeral_5m_input_tokens ?? 0;
	const cw1h = cc.ephemeral_1h_input_tokens ?? 0;
	const cwFlat = Math.max(0, (usage.cache_creation_input_tokens || 0) - cw5m - cw1h);
	
	if (m.includes("deepseek")) {
		// DeepSeek: no cache-write pricing (all zero)
		cacheWriteCost = 0;
	} else {
		cacheWriteCost =
			cw5m * (inputPrice * 1.25 / 1000000) +
			cw1h * (inputPrice * 2.00 / 1000000) +
			cwFlat * (inputPrice * 1.25 / 1000000); // unknown TTL → default 5-min (1.25×)
	}
	
	const cost = 
		((usage.input_tokens || 0) * (inputPrice / 1000000)) +
		((usage.output_tokens || 0) * (outputPrice / 1000000)) +
		((usage.reasoning_tokens || usage.reasoning || 0) * (outputPrice / 1000000)) +
		cacheWriteCost +
		((usage.cache_read_input_tokens || 0) * (cacheReadPrice / 1000000));
		
	return cost;
}

function extractFilesFromBashCommand(command: string, files: { path: string; action: "read" | "write" }[]) {
	// Heuristically extract the file path to ensure these turns don't fall through to "other" classification.
	const cmdLines = command.split('\n');
	for (const line of cmdLines) {
		const trimmed = line.trim();
		
		// 1. Intercept heredoc write redirections: cat << 'EOF' > file.txt or cat <<EOF >> file.txt
		if (trimmed.startsWith("cat ") && trimmed.includes("<<") && trimmed.includes(">")) {
			const parts = trimmed.split(/>+/);
			if (parts.length > 1) {
				const possiblePath = parts[1].trim().replace(/['"]/g, '');
				if (possiblePath && !possiblePath.startsWith("-")) {
					files.push({ path: possiblePath, action: "write" });
					continue; // Parsed successfully as write, skip standard read extraction
				}
			}
		}

		// 2. Standard read commands (cat, head, tail)
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

		// Parse timestamp first — used below for DeepSeek peak pricing
		let timestampStr = assistantMsg.timestamp || entry.timestamp;
		let timestamp = 0;
		if (typeof timestampStr === "string") {
			timestamp = new Date(timestampStr).getTime();
		} else if (typeof timestampStr === "number") {
			timestamp = timestampStr;
		}

		let cost = 0;
		// Prefer Pi's native cost tracking, but fall through to manual calculation
		// when cost.total is 0 while actual tokens were consumed (e.g. DeepSeek pricing
		// not yet supported by Pi's internal cost tracker). Also normalize Pi's field
		// names (input/output) to the Anthropic-compat names (input_tokens/output_tokens).
		const usage = assistantMsg.usage || {};
		const piCost = usage.cost?.total;
		const hasTokens = (usage.input_tokens || usage.input || 0) > 0 ||
		                  (usage.output_tokens || usage.output || 0) > 0 ||
		                  (usage.cache_read_input_tokens || usage.cacheRead || 0) > 0 ||
		                  (usage.cache_creation_input_tokens || usage.cacheWrite || 0) > 0 ||
		                  (usage.reasoning_tokens || usage.reasoning || 0) > 0;
		if (piCost !== undefined && piCost !== null && !(piCost === 0 && hasTokens)) {
			cost = piCost;
		} else if (assistantMsg.model && hasTokens) {
			// Normalize Pi field names to Anthropic-compat for calculateClaudeCost.
			// Pass the cache_creation sub-object through for TTL-split pricing (#55).
			const normalizedUsage = {
				input_tokens: usage.input_tokens ?? usage.input ?? 0,
				output_tokens: usage.output_tokens ?? usage.output ?? 0,
				cache_creation_input_tokens: usage.cache_creation_input_tokens ?? usage.cacheWrite ?? 0,
				cache_read_input_tokens: usage.cache_read_input_tokens ?? usage.cacheRead ?? 0,
				cache_creation: usage.cache_creation || null,
				reasoning_tokens: usage.reasoning_tokens ?? usage.reasoning ?? 0,
			};
			cost = calculateClaudeCost(assistantMsg.model, normalizedUsage, timestamp);
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

		return { timestamp, cost, messageId: assistantMsg.id, requestId: entry.requestId,
			model: assistantMsg.model || undefined,
			inputTokens: (usage.input_tokens || usage.input || 0) as number,
			outputTokens: (usage.output_tokens || usage.output || 0) as number,
			cacheReadTokens: (usage.cache_read_input_tokens || usage.cacheRead || 0) as number,
			cacheWriteTokens: (usage.cache_creation_input_tokens || usage.cacheWrite || 0) as number,
			reasoningTokens: (usage.reasoning || 0) as number,
			files, commands, texts };
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
// SHARED FILE PARSER (#54 DRY refactor)
// Single source of truth for reading a .jsonl session file into Interaction[]
// (raw, undeduped). Consumers (session selector, CLI chart, Pi TUI) read lines
// differently (File I/O vs ctx.sessionManager), but the parseEntryToInteraction
// call and subsequent dedup are identical — those live here.
// ---

/**
 * Parse a .jsonl session file into raw (undeduped) interactions.
 * Caller is responsible for deduplication via {@link deduplicateInteractions}.
 *
 * @param filePath - Absolute path to the .jsonl session log
 * @returns Array of parsed interactions (may contain duplicate message.id entries)
 */
export function parseSessionFile(filePath: string): Interaction[] {
	const interactions: Interaction[] = [];
	try {
		const content = fs.readFileSync(filePath, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				const interaction = parseEntryToInteraction(entry);
				if (interaction) interactions.push(interaction);
			} catch {
				// Skip unparseable lines (partial writes, non-JSON)
			}
		}
	} catch {
		// File may not exist or be unreadable
	}
	return interactions;
}

// ---
// MESSAGE-ID DEDUPLICATION (#54)
// Claude Code emits multiple JSONL lines per API response (one per content block +
// streaming/compaction re-logging), each echoing the same message-level `usage`.
// Summing per line inflates costs ~1.8×. Dedup by message.id: keep the max-cost
// copy (handles streaming partials where usage grows), merge content blocks from
// all copies for correct classification.
// ---

export function deduplicateInteractions(interactions: Interaction[]): Interaction[] {
	const byId = new Map<string, Interaction[]>();
	const withoutId: Interaction[] = [];

	for (const i of interactions) {
		if (i.messageId) {
			const existing = byId.get(i.messageId);
			if (existing) {
				existing.push(i);
			} else {
				byId.set(i.messageId, [i]);
			}
		} else {
			withoutId.push(i);
		}
	}

	const deduped: Interaction[] = [...withoutId];

	for (const [, group] of byId) {
		if (group.length === 1) {
			deduped.push(group[0]);
		} else {
			// Take max cost (handles streaming partials), merge content for classification
			let best = group[0];
			for (let j = 1; j < group.length; j++) {
				if (group[j].cost > best.cost) best = group[j];
			}
			const merged: Interaction = {
				...best,
				files: [],
				commands: [],
				texts: []
			};
			const seenFiles = new Set<string>();
			for (const i of group) {
				for (const f of i.files) {
					const key = `${f.path}:${f.action}`;
					if (!seenFiles.has(key)) {
						seenFiles.add(key);
						merged.files.push(f);
					}
				}
				for (const c of i.commands) {
					if (!merged.commands.includes(c)) merged.commands.push(c);
				}
				for (const t of i.texts) {
					if (!merged.texts.includes(t)) merged.texts.push(t);
				}
			}
			deduped.push(merged);
		}
	}

	return deduped;
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

// ---
// COMMAND NORMALIZATION (#63)
// Strips cd /path prefixes and VAR=value assignments from chained bash commands
// so that 'cd /foo && git push' classifies as 'git', not 'other'.
// ---

function normalizeCommand(cmd: string): string {
	let normalized = cmd.trim();
	let changed = true;
	while (changed) {
		changed = false;
		// Strip leading variable assignments: VAR=val (val is non-space, double-quoted, or single-quoted)
		const stripped = normalized.replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*)+/, '');
		if (stripped !== normalized) { normalized = stripped.trim(); changed = true; }
		// Strip leading shell separators left after var stripping (&&, ;, |, ||)
		const afterSep = normalized.replace(/^(?:&&|;|\|\|?)\s*/, '');
		if (afterSep !== normalized) { normalized = afterSep; changed = true; }
		// Strip leading cd <path> && / cd <path> ;
		const afterCd = normalized.replace(/^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/, '');
		if (afterCd !== normalized) { normalized = afterCd; changed = true; }
	}
	return normalized;
}

export function classifyInteraction(interaction: Interaction): Category {
	// When the interaction was read from a pre-classified daemon tag file,
	// use the stored category directly (avoids re-classification which fails
	// for "prompt" because texts are not serialized to the tag file).
	if (interaction._cat) return interaction._cat;

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
		} else if (norm.startsWith(".pi/extensions/") || norm.includes("/.pi/extensions/") || norm.startsWith("extensions/") || norm.includes("/extensions/") || norm.startsWith("src/") || norm.includes("/src/") || norm.startsWith("public/") || norm.includes("/public/") || norm.startsWith("bin/") || norm.includes("/bin/") || norm.startsWith("debug/") || norm.includes("/debug/")) {
			category = "code";
		} else {
			const ext = path.extname(norm).toLowerCase();
			if ([".ts", ".js", ".mjs", ".json", ".jsonl", ".css", ".tsx", ".jsx", ".py", ".rs", ".go", ".sh", ".yml", ".yaml", ".sql", ".txt"].includes(ext) || norm.endsWith(".gitignore") || norm.endsWith(".dockerignore")) {
				category = "code";
			} else if (ext === "") {
				// Bare files with no extension (like wrapper scripts 'wtft', 'serve', 'merge') are Code
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
			const normalized = normalizeCommand(cmd);
			if (!normalized) continue; // stripped to nothing (pure cd, pure var assignment)
			const lower = normalized.toLowerCase().trim();
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

	const labels: {text: string, start: number, end: number}[] = [];
	const tickValues = [0, maxCost / 4, maxCost / 2, (maxCost * 3) / 4, maxCost];

	for (let i = 0; i < ticks.length; i++) {
		const text = formatCost(tickValues[i]);
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
	// Adaptive precision: 4 decimal places for sub-cent values (< $0.01),
	// 2 decimal places otherwise. Handles DeepSeek's sub-cent pricing
	// ($0.14/M input) without cluttering Claude/Gemini displays.
	const decimals = cost > 0 && cost < 0.01 ? 4 : 2;
	return `$${cost.toFixed(decimals)}`;
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

export function getTerminalWidth(isWidget = false, disabledEmoji = false): number {
	let width = 80;
	if (process.stdout && process.stdout.columns) {
		width = process.stdout.columns;
	} else if (process.stderr && process.stderr.columns) {
		width = process.stderr.columns;
	} else if (process.env.COLUMNS) {
		const num = parseInt(process.env.COLUMNS, 10);
		if (!isNaN(num) && num > 0) width = num;
	}
	if (width === 80 && process.env.TMUX) {
		try {
			const tmuxWidth = execSync("tmux display-message -p '#{pane_width}'", { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim();
			const num = parseInt(tmuxWidth, 10);
			if (!isNaN(num) && num > 0) width = num;
		} catch (e) {}
	}
	if (width === 80) {
		try {
			const cols = execSync("tput cols", { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim();
			const num = parseInt(cols, 10);
			if (!isNaN(num) && num > 0) width = num;
		} catch (e) {}
	}
	// Widgets: subtract minimal breathing room (1 char per side).
	// Pi's setWidget() does not enforce its own padding on raw line arrays,
	// so we only need 2 chars total. Previously subtracted 4 unnecessarily.
	return isWidget ? width - 2 : width;
}

// ---
// SURGE TIMELINE: 24-hour bar showing normal (green) vs surge (orange) pricing
// Used by both Pi TUI widget and CLI watch mode.
// ---

/**
 * Get the current local hour (0-23) for a given timezone.
 */
export function getCurrentLocalHour(tz?: string): number {
	const parts = getZonedParts(Date.now(), tz);
	return parts.hour;
}

/**
 * Get the UTC offset in ms for a given timezone at a given timestamp.
 */
export function getTimezoneOffsetMs(timestamp: number, tz: string): number {
	const parts = getZonedParts(timestamp, tz);
	const utcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
	return utcMs - timestamp;
}

/**
 * Returns which local hours (0-23) fall in a surge window,
 * given the configured timezone. Surge windows defined in UTC:
 * 01:00-04:00 and 06:00-10:00 UTC.
 */
export function getSurgeLocalHours(tz?: string): Set<number> {
	const result = new Set<number>();
	const now = Date.now();

	for (let localHour = 0; localHour < 24; localHour++) {
		let ts: number;
		if (tz) {
			const parts = getZonedParts(now, tz);
			const offsetMs = getTimezoneOffsetMs(now, tz);
			ts = Date.UTC(parts.year, parts.month - 1, parts.day, localHour, 0, 0, 0) - offsetMs;
		} else {
			const d = new Date();
			d.setHours(localHour, 0, 0, 0);
			ts = d.getTime();
		}
		const utcHour = new Date(ts).getUTCHours();
		if ((utcHour >= 1 && utcHour < 4) || (utcHour >= 6 && utcHour < 10)) {
			result.add(localHour);
		}
	}
	return result;
}

/**
 * Checks current surge proximity (in UTC). Returns status and multiplier.
 */
export function checkSurgeProximity(): { status: 'surge' | 'approaching' | 'ending' | undefined; multiplier: number } {
	const now = new Date();
	const currentUtcMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
	const surgeWindows: [number, number][] = [[60, 240], [360, 600]];

	for (const [start, end] of surgeWindows) {
		if (currentUtcMinute >= start && currentUtcMinute < end) {
			return { status: 'surge', multiplier: 2.0 };
		}
		if (currentUtcMinute >= start - 20 && currentUtcMinute < start) {
			return { status: 'approaching', multiplier: 2.0 };
		}
		if (currentUtcMinute >= end - 20 && currentUtcMinute < end) {
			return { status: 'ending', multiplier: 2.0 };
		}
	}
	return { status: undefined, multiplier: 1.0 };
}

/**
 * Build a 24-hour surge timeline string in the format:
 * (---[colored]---◆---) [⚡ SURGE 2x] [⚡ SURGE APPROACHING]
 *
 * @param surgeHours - Set of local hours (0-23) that are surge-priced
 * @param currentHour - Current local hour (0-23) for diamond marker
 * @param proximityStatus - If set, appends the appropriate surge badge
 */
export function buildTimelineString(
	surgeHours: Set<number>,
	currentHour: number,
	proximityStatus?: 'surge' | 'approaching' | 'ending'
): string {
	const segments: { color: string; text: string }[] = [];
	let lastColor: string | null = null;

	for (let h = 0; h < 24; h++) {
		const isSurge = surgeHours.has(h);
		const isCurrent = h === currentHour;

		// Noon divider: always emit the | separator at hour 12
		// If h=12 is also the current hour, emit both | and the diamond
		if (h === 12) {
			if (lastColor !== "") {
				segments.push({ color: "", text: "|" });
				lastColor = "";
			} else {
				segments[segments.length - 1].text += "|";
			}
			if (isCurrent) {
				// Also emit the diamond marker after the separator
				const diaColor = "1;" + (isSurge ? "38;5;208" : "32");
				if (diaColor !== lastColor) {
					segments.push({ color: diaColor, text: "◆" });
					lastColor = diaColor;
				} else {
					segments[segments.length - 1].text += "◆";
				}
			}
			continue;
		}

		const color = isCurrent ? "1;" + (isSurge ? "38;5;208" : "32") : (isSurge ? "38;5;208" : "32");
		const char = isCurrent ? "◆" : "-";

		if (color !== lastColor) {
			segments.push({ color, text: char });
			lastColor = color;
		} else {
			segments[segments.length - 1].text += char;
		}
	}

	const timelineBody = segments.map(s => `\x1b[${s.color}m${s.text}\x1b[0m`).join("");
	let result = `(${timelineBody})`;

	if (proximityStatus === 'surge') {
		result += ` \x1b[1;38;5;208m⚡ SURGE 2x\x1b[0m`;
	} else if (proximityStatus === 'approaching') {
		result += ` \x1b[1;5;38;5;208m⚡ SURGE APPROACHING\x1b[0m`;
	} else if (proximityStatus === 'ending') {
		result += ` \x1b[1;5;32m⚡ SURGE ENDING\x1b[0m`;
	}

	return result;
}

export function buildWtftLines(
	interactions: Interaction[],
	defaultSettings: {
		interval: string;
		limit: number;
		width: number;
		showTicks: boolean;
		mode: "bucket" | "cumulative";
		timezone?: string;
		disabledEmoji?: boolean;
	},
	opts?: {
		interval?: string;
		limit?: number;
		width?: number;
		showTicks?: boolean;
		mode?: "bucket" | "cumulative";
		timezone?: string;
		isWidget?: boolean;
		disabledEmoji?: boolean;
		forceLegendRow?: boolean;
		/** Model ID for SURGE timeline coloring (pass "deepseek-..." for orange surge segments + badges). Auto-detected from interactions if omitted. */
		model?: string;
	}
): string[] | null {
	const intervalStr = opts?.interval !== undefined ? opts.interval : defaultSettings.interval;
	const limit = opts?.limit !== undefined ? opts.limit : defaultSettings.limit;
	
	const isWidget = opts?.isWidget ?? false;
	const disabledEmoji = opts?.disabledEmoji !== undefined ? opts.disabledEmoji : defaultSettings.disabledEmoji;
	const termWidth = getTerminalWidth(isWidget, disabledEmoji);
	const rawWidth = opts?.width !== undefined ? opts.width : defaultSettings.width;
	const width = Math.min(rawWidth, termWidth);
	const showTicks = opts?.showTicks !== undefined ? opts.showTicks : defaultSettings.showTicks;
	const mode = opts?.mode !== undefined ? opts.mode : defaultSettings.mode;
	const tz = opts?.timezone !== undefined ? opts.timezone : defaultSettings.timezone;

	const intervalConfig = parseInterval(intervalStr);

	// Deduplicate by message.id before binning (#54): Claude Code emits multiple
	// JSONL lines per API response, each echoing the same message-level usage.
	// Summing per line inflates costs ~1.8×.
	interactions = deduplicateInteractions(interactions);

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
	
	const titleLeft = disabledEmoji ? "[$] WTF Tokens?" : "💸 WTF Tokens?";
	
	const legendItems = [
		`\x1b[38;5;108m█\x1b[0mSpec`,
		`\x1b[38;5;108;48;5;173m▒\x1b[0mMixed`,
		`\x1b[38;5;173m█\x1b[0mCode`,
		`\x1b[38;5;223m█\x1b[0mTests`,
		`\x1b[38;5;134m█\x1b[0mResearch`,
		`\x1b[38;5;73m█\x1b[0mGit`,
		`\x1b[38;5;67m█\x1b[0mGrep`,
		`\x1b[38;5;168m░\x1b[0mPrompt`,
		`\x1b[38;5;238m░\x1b[0mOther`
	];
	const legendStr = legendItems.join(" ");
	
	const leftLen = getVisualLength(titleLeft);
	const legendLen = getVisualLength(legendStr);
	const totalNeeded = leftLen + legendLen + 4; // 4 spaces margin
	const forceLegendRow = opts?.forceLegendRow ?? false;
	
	if (!forceLegendRow && totalNeeded <= finalWidth - 3) {
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
			const dividerLen = Math.max(0, (finalWidth - 3) - dayChangeText.length);
			// Build the divider as an array so we can punch tick marks through the horizontal line
			const dividerChars = Array.from({ length: dividerLen }, () => "─");
			
			// Punch ┼ (light vertical + light horizontal) at the same tick positions as the main scale line.
			// ┼ matches the ─ horizontal weight better than ┿ (which has a heavy horizontal stroke).
			const tickPositions = [
				prefixWidth,
				prefixWidth + Math.floor(maxBarWidth / 4),
				prefixWidth + Math.floor(maxBarWidth / 2),
				prefixWidth + Math.floor((maxBarWidth * 3) / 4),
				prefixWidth + maxBarWidth - 1
			];
			for (const t of tickPositions) {
				const idx = t - dayChangeText.length;
				if (idx >= 0 && idx < dividerChars.length) {
					dividerChars[idx] = "┼";
				}
			}
			
			const dividerLine = dayChangeText + dividerChars.join("");
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

	// ---
	// SURGE TIMELINE: 24-hour bar showing normal (green) vs surge (orange) pricing.
	// Colored by model: DeepSeek gets orange surge segments + badges; others get all-green.
	// Model auto-detected from interactions if caller doesn't pass one explicitly.
	// ---
	let surgeModel = opts?.model;
	if (!surgeModel) {
		for (const i of interactions) {
			if (i.model) { surgeModel = i.model; break; }
		}
	}
	const isDeepSeek = (surgeModel || "").toLowerCase().includes("deepseek");
	const surgeHours = isDeepSeek ? getSurgeLocalHours(tz) : new Set<number>();
	const currentHour = getCurrentLocalHour(tz);
	const proximity = isDeepSeek ? checkSurgeProximity() : { status: undefined, multiplier: 1.0 };
	const timelineStr = buildTimelineString(surgeHours, currentHour, proximity.status);
	widgetLines[0] = widgetLines[0] + "  " + timelineStr;

	// ---
	// Proactive "Other" bloat warning (#17)
	// Trigger: other > 20% of total session cost AND absolute other > $6.00
	// Uses raw interactions (not bin costs) to avoid double-counting in cumulative mode
	// where bin.costs[n].other is a running total, summing across bins inflates the value.
	// ---
	const totalOtherCost = interactions
		.filter(i => classifyInteraction(i) === "other")
		.reduce((sum, i) => sum + i.cost, 0);
	if (totalSessionCost > 0) {
		const otherPct = totalOtherCost / totalSessionCost;
		if (otherPct > 0.20 && totalOtherCost > 6.00) {
			const pctStr = `${Math.round(otherPct * 100)}%`;
			const costStr = formatCost(totalOtherCost);
			// Warning line: bright yellow bold for visibility in widget and CLI
			widgetLines.push(`\x1b[1;33m⚠️  "Other" category: ${pctStr} of session cost (${costStr}). Run wtft --other to drill down.\x1b[0m`);
		}
	}

	return widgetLines;
}

// ---
// SEMANTIC COMMAND SUB-CLASSIFICATION
// Maps bare command names to semantic groups for wtft-other histogram.
// ---

const SEMANTIC_GROUPS: Record<string, { label: string; commands: Set<string> }> = {
	build: {
		label: "Build & Bundling",
		commands: new Set(["npm", "npx", "esbuild", "webpack", "vite", "tsc", "make", "gcc", "cargo", "go", "pnpm", "yarn", "bun", "node", "tsx", "ts-node", "cmake", "ninja", "g++"])
	},
	deps: {
		label: "Dependency Management",
		commands: new Set(["pip", "pip3", "gem", "brew", "apt-get", "apt", "dnf", "pacman", "zypper", "apk"])
	},
	lint: {
		label: "Linting & Formatting",
		commands: new Set(["eslint", "prettier", "black", "rustfmt", "shfmt", "biome", "stylelint", "shellcheck", "ruff", "flake8", "pylint", "clippy"])
	},
	test: {
		label: "Testing",
		commands: new Set(["jest", "vitest", "pytest", "cypress", "playwright", "mocha", "ava", "tap", "karma"])
	},
	db: {
		label: "Database & Infrastructure",
		commands: new Set(["sqlite3", "psql", "mysql", "docker", "kubectl", "aws", "terraform", "gh", "fly", "railway", "mongo", "redis-cli", "pg_dump", "pg_restore"])
	},
	sys: {
		label: "System & File Utilities",
		commands: new Set(["ls", "mkdir", "cp", "rm", "mv", "chmod", "chown", "touch", "wc", "du", "df", "which", "echo", "pwd", "cd", "ln", "stat", "file", "realpath", "readlink", "dirname", "basename", "tar", "gzip", "gunzip", "zip", "unzip", "curl", "wget", "ssh", "scp", "rsync"])
	},
	git: {
		label: "Git Operations",
		commands: new Set(["git"])
	},
	session: {
		label: "Session & Agent",
		commands: new Set(["pi", "python", "python3", "bash", "zsh", "clear", "exit", "source", ".", "exec", "env", "export", "alias", "unalias"])
	}
};

export function getSemanticCommandGroup(command: string): string | null {
	const base = command.split("/").pop() || command; // Strip path prefix e.g. /usr/bin/ls → ls
	for (const [key, group] of Object.entries(SEMANTIC_GROUPS)) {
		if (group.commands.has(base)) return group.label;
	}
	// Git subcommands: anything starting with "git" → Git Operations
	if (base === "git" || command.startsWith("git ")) return SEMANTIC_GROUPS.git.label;
	// npm subcommands → Build & Bundling (covers npm run/build/test/install/etc.)
	if (command.startsWith("npm ")) return SEMANTIC_GROUPS.build.label;
	// yarn/pnpm/bun subcommands → Build & Bundling
	if (command.startsWith("yarn ") || command.startsWith("pnpm ") || command.startsWith("bun ")) return SEMANTIC_GROUPS.build.label;
	// go subcommands → Build & Bundling
	if (command.startsWith("go ")) return SEMANTIC_GROUPS.build.label;
	// cargo subcommands not already matched
	if (command.startsWith("cargo ")) return SEMANTIC_GROUPS.build.label;
	// pip subcommands → Deps
	if (command.startsWith("pip ") || command.startsWith("pip3 ")) return SEMANTIC_GROUPS.deps.label;
	return null;
}

export function renderOtherHistogram(interactions: Interaction[], maxWidth: number = 80): string {
	const commandMap = new Map<string, { count: number; cost: number }>();

	for (const interaction of interactions) {
		const classification = classifyInteraction(interaction);
		if (classification === "other") {
			// Extract exact primary command for bash
			const primaryCommands: string[] = [];
			for (const rawCmd of interaction.commands) {
				const normalized = normalizeCommand(rawCmd);
				if (!normalized) continue; // stripped to nothing (pure cd, pure var assignment)
				const lines = normalized.split('\n');
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

	// Group commands by semantic category
	const groups = new Map<string, { count: number; cost: number; commands: Map<string, { count: number; cost: number }> }>();

	for (const [cmd, data] of commandMap) {
		const groupName = getSemanticCommandGroup(cmd) || "Unclassified";
		let group = groups.get(groupName);
		if (!group) {
			group = { count: 0, cost: 0, commands: new Map() };
			groups.set(groupName, group);
		}
		group.count += data.count;
		group.cost += data.cost;
		group.commands.set(cmd, data);
	}

	// Sort groups: known categories first (by spec order), then Unclassified last
	const groupOrder = [
		"Build & Bundling",
		"Dependency Management",
		"Linting & Formatting",
		"Testing",
		"Database & Infrastructure",
		"System & File Utilities",
		"Git Operations",
		"Session & Agent"
	];
	const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
		const ai = groupOrder.indexOf(a[0]);
		const bi = groupOrder.indexOf(b[0]);
		if (ai === -1 && bi === -1) return a[0].localeCompare(b[0]);
		if (ai === -1) return 1;
		if (bi === -1) return -1;
		return ai - bi;
	});

	let output = "--- 'Other' Command Histogram ---\n";

	// Find max command length for alignment
	let maxCmdLen = 0;
	for (const cmd of commandMap.keys()) maxCmdLen = Math.max(maxCmdLen, cmd.length);

	const countWidth = 7;
	const costWidth = 10;

	for (const [groupName, group] of sortedGroups) {
		const groupCostStr = `$${group.cost.toFixed(4)}`;
		output += `\n[${groupName}]  (${group.count} calls, ${groupCostStr})\n`;

		// Sort commands within group by count descending
		const sortedCmds = Array.from(group.commands.entries()).sort((a, b) => b[1].count - a[1].count);

		for (const [cmd, data] of sortedCmds) {
			const countStr = `(${data.count})`.padStart(countWidth);
			const costStr = `$${data.cost.toFixed(4)}`.padStart(costWidth);

			const barWidth = Math.max(5, maxWidth - maxCmdLen - countWidth - costWidth - 10);
			const bar = "#".repeat(Math.min(data.count, barWidth));

			output += `  ${cmd.padEnd(maxCmdLen)} ${costStr} ${countStr} : ${bar}\n`;
		}
	}

	return output;
}

// ---
// TOKEN SUMMARY TABLE (per-model, deduped)
// Renders token counts for cross-referencing with Claude Code /usage.
// Wire via --tokens flag (CLI) or /wtft --tokens (Pi TUI).
// ---

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function shortenModel(model: string): string {
	// Strip "claude-" prefix and trim version suffix for display
	return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function renderTokenSummary(interactions: Interaction[], maxWidth: number = 80): string {
	// Dedup before aggregating (caller may pass raw, we ensure consistent counts)
	const deduped = deduplicateInteractions(interactions);

	// Group by model
	type ModelAgg = {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		reasoningTokens: number;
		cost: number;
	};
	const byModel = new Map<string, ModelAgg>();
	let unmatched = 0;

	for (const i of deduped) {
		const model = i.model || "(unknown)";
		// Skip synthetic/system entries (no real tokens) and untagged entries
		if (model === "(unknown)" || model === "<synthetic>") {
			unmatched++;
			continue;
		}
		const agg = byModel.get(model) || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0 };
		agg.inputTokens += i.inputTokens;
		agg.outputTokens += i.outputTokens;
		agg.cacheReadTokens += i.cacheReadTokens;
		agg.cacheWriteTokens += i.cacheWriteTokens;
		agg.reasoningTokens += i.reasoningTokens;
		agg.cost += i.cost;
		byModel.set(model, agg);
	}

	if (byModel.size === 0) {
		return unmatched > 0
			? `No model-tagged interactions found (${unmatched} untagged).`
			: "No model-tagged interactions found.";
	}

	// Sort by cost descending
	const sorted = Array.from(byModel.entries())
		.sort((a, b) => b[1].cost - a[1].cost);

	// Column widths
	const modelColW = Math.max(10, ...sorted.map(([m]) => shortenModel(m).length));
	const numColW = 10; // fixed width for numbers

	const sep = "─".repeat(Math.min(maxWidth, modelColW + numColW * 5 + 24));

	let out = "";
	out += `\n── Token Summary (per model, deduped) ──${unmatched > 0 ? `  (${unmatched} untagged interactions skipped)` : ""}\n`;

	// Header
	out += [
		"Model".padEnd(modelColW),
		"Input".padStart(numColW),
		"Output".padStart(numColW),
		"Reasoning".padStart(numColW),
		"Cache-Read".padStart(numColW),
		"Cache-Write".padStart(numColW),
		"Cost".padStart(numColW)
	].join(" ") + "\n";

	// Rows
	let totalInput = 0, totalOutput = 0, totalCr = 0, totalCw = 0, totalReasoning = 0, totalCost = 0;
	for (const [model, agg] of sorted) {
		out += [
			shortenModel(model).padEnd(modelColW),
			formatTokenCount(agg.inputTokens).padStart(numColW),
			formatTokenCount(agg.outputTokens).padStart(numColW),
			formatTokenCount(agg.reasoningTokens).padStart(numColW),
			formatTokenCount(agg.cacheReadTokens).padStart(numColW),
			formatTokenCount(agg.cacheWriteTokens).padStart(numColW),
			formatCost(agg.cost).padStart(numColW)
		].join(" ") + "\n";
		totalInput += agg.inputTokens;
		totalOutput += agg.outputTokens;
		totalCr += agg.cacheReadTokens;
		totalCw += agg.cacheWriteTokens;
		totalReasoning += agg.reasoningTokens;
		totalCost += agg.cost;
	}

	// Total row
	out += sep + "\n";
	out += [
		"TOTAL".padEnd(modelColW),
		formatTokenCount(totalInput).padStart(numColW),
		formatTokenCount(totalOutput).padStart(numColW),
		formatTokenCount(totalReasoning).padStart(numColW),
		formatTokenCount(totalCr).padStart(numColW),
		formatTokenCount(totalCw).padStart(numColW),
		formatCost(totalCost).padStart(numColW)
	].join(" ") + "\n";

	return out;
}

// ---
// WATCH MODE: tail -f style live re-rendering (#45)
// Watches a .jsonl session file for changes and re-renders in-place.
// ---

export interface WatchSettings {
	interval: string;
	limit: number;
	width: number;
	mode: "cumulative" | "bucket";
	showTicks: boolean;
	timezone?: string;
	disabledEmoji: boolean;
	daemonPath?: string; // path to wtft-daemon.mjs (CLI watch mode only)
}

export async function watchMode(
	sessionPath: string,
	settings: WatchSettings
): Promise<void> {
	if (!process.stdout.isTTY) {
		console.error("❌ --watch requires a real terminal (TTY). Refusing to start.");
		process.exit(1);
	}

	let totalCost = 0;
	let interactionCount = 0;
	let lastSize = 0;
	let needsRedraw = true;
	let _lastRenderMin = -1;
	// Alt screen buffer — live updates inside, main screen restored on exit.
	process.stdout.write("\x1b[?1049h");
	hideCursor();

	let lastBuffer: string[] = []; // saved for exit printout
	let lastLineCount = 0;         // visual lines rendered (for in-place overwrite)

	// Shared exit: clears chart output, restores terminal, prints final chart.
	const exitWatch = () => {
		process.stdout.write("\x1b[?1049l");
		showCursor();
		cleanupStdin();
		if (lastBuffer.length > 0) {
			for (const l of lastBuffer) console.log(l);
		}
		console.log(`WTFT watch stopped \u2014 ${interactionCount} interactions, $${totalCost.toFixed(4)} total cost.`);
		process.exit(0);
	};

	process.on("SIGINT", exitWatch);

	// Raw stdin for 'q'/'Q' quit.
	const cleanupStdin = enterRawStdin((key: string) => {
		if (key === "q" || key === "Q" || key === "\u0003") {
			exitWatch();
		}
	});

	const parseInteractions = (filePath: string): { interactions: Interaction[]; disabledEmoji: boolean; sessionInterval?: string; sessionLimit?: number; sessionMode?: "cumulative" | "bucket"; sessionShowTicks?: boolean; sessionTimezone?: string; } => {
		const interactions: Interaction[] = [];
		let disabledEmoji = false;
		let sessionInterval: string | undefined;
		let sessionLimit: number | undefined;
		let sessionMode: "cumulative" | "bucket" | undefined;
		let sessionShowTicks: boolean | undefined;
		let sessionTimezone: string | undefined;

		try {
			const stat = fs.statSync(filePath);
			const currentSize = stat.size;

			if (currentSize < lastSize) {
				// File truncated or rotated — reset
				lastSize = 0;
			}

			if (currentSize <= lastSize) return { interactions, disabledEmoji, sessionInterval, sessionLimit, sessionMode, sessionShowTicks, sessionTimezone };

			const fd = fs.openSync(filePath, "r");
			const buf = Buffer.alloc(currentSize - lastSize);
			fs.readSync(fd, buf, 0, buf.length, lastSize);
			fs.closeSync(fd);
			lastSize = currentSize;

			const newContent = buf.toString("utf8");
			const lines = newContent.split("\n");

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
							if (entry.data.mode === "cumulative" || entry.data.mode === "bucket") sessionMode = entry.data.mode;
							if (typeof entry.data.showTicks === "boolean") sessionShowTicks = entry.data.showTicks;
							if (typeof entry.data.timezone === "string") sessionTimezone = entry.data.timezone;
						}
					}
					const interaction = parseEntryToInteraction(entry);
					if (interaction) {
						interactions.push(interaction);
					}
				} catch {
					// Skip unparseable lines (partial writes, non-JSON)
				}
			}
		} catch {
			// File may not exist yet — just return empty
		}

		return { interactions, disabledEmoji, sessionInterval, sessionLimit, sessionMode, sessionShowTicks, sessionTimezone };
	};

	// Accumulator
	let allInteractions: Interaction[] = [];
	let disabledEmoji = settings.disabledEmoji;
	let sessionInterval: string | undefined;
	let sessionLimit: number | undefined;
	let sessionMode: "cumulative" | "bucket" | undefined;
	let sessionShowTicks: boolean | undefined;
	let sessionTimezone: string | undefined;

	// Save cursor before first render (DECSC \x1b7 — tmux-compatible).
	// On every re-render, restore + clear erases old output before writing new.
	process.stdout.write("\x1b7");

	const render = () => {
		// Home cursor + clear — safe inside alt screen, prevents scrollback accumulation
		process.stdout.write("\x1b[H\x1b[J");

		const width = getTerminalWidth();
		const finalInterval = sessionInterval ?? settings.interval;
		const finalLimit = sessionLimit ?? settings.limit;
		const finalMode = sessionMode ?? settings.mode;
		const finalShowTicks = sessionShowTicks ?? settings.showTicks;
		const finalTimezone = sessionTimezone ?? settings.timezone;
		const finalWidth = Math.min(settings.width, width);

		const defaultSettings = {
			interval: "1h", limit: 100, width: finalWidth,
			showTicks: true, mode: "cumulative" as "cumulative" | "bucket",
			timezone: undefined
		};

		const lines = buildWtftLines(allInteractions, defaultSettings, {
			interval: finalInterval,
			limit: finalLimit,
			width: finalWidth,
			showTicks: finalShowTicks,
			mode: finalMode,
			timezone: finalTimezone,
			disabledEmoji,
			forceLegendRow: true
		});

		const buf: string[] = [];
		// Session file path first (no interaction count, no cost — just path)
		buf.push(`\x1b[90m${sessionPath}\x1b[0m`);
		totalCost = deduplicateInteractions(allInteractions).reduce((sum, i) => sum + i.cost, 0);

		if (lines && lines.length > 0) {
			for (const l of lines) buf.push(l);
		} else {
			buf.push("\x1b[90mWaiting for session data...\x1b[0m");
		}

		// Footer row (always last line)
		buf.push(`'q' to exit`);

		lastBuffer = [...buf]; // save for exit printout
		// Compute visual line count for in-place overwrite on next render
		const cols = process.stdout.columns || 80;
		lastLineCount = buf.join("\n").split("\n").length;
		process.stdout.write(buf.join("\n"));
		needsRedraw = false;
		_lastRenderMin = new Date().getMinutes();
	};

	// Initial render
	render();

	// SIGWINCH handler — re-render immediately on terminal resize
	process.on("SIGWINCH", () => {
		needsRedraw = true;
		render();
	});

	// Poll loop
	const POLL_MS = 667;
	while (true) {
		await new Promise(resolve => setTimeout(resolve, POLL_MS));

		// Check if file still exists
		if (!fs.existsSync(sessionPath)) {
			lastSize = 0;
			needsRedraw = true;
			render();
			continue;
		}

		const { interactions: newInteractions, disabledEmoji: newDisabledEmoji, sessionInterval: newInterval, sessionLimit: newLimit, sessionMode: newMode, sessionShowTicks: newTicks, sessionTimezone: newTz } = parseInteractions(sessionPath);

		if (newDisabledEmoji !== undefined) disabledEmoji = newDisabledEmoji;
		if (newInterval !== undefined) sessionInterval = newInterval;
		if (newLimit !== undefined) sessionLimit = newLimit;
		if (newMode !== undefined) sessionMode = newMode;
		if (newTicks !== undefined) sessionShowTicks = newTicks;
		if (newTz !== undefined) sessionTimezone = newTz;

		if (newInteractions.length > 0) {
			allInteractions.push(...newInteractions);
			needsRedraw = true;
		}

		// Re-render every minute for timeline diamond/badge live-updates
		const _curMin = new Date().getMinutes();
		if (_curMin !== _lastRenderMin) {
			needsRedraw = true;
		}

		if (needsRedraw) {
			render();
		}
	}
}

// ---
// CLASSIFIED TAG FILE READER (#53 — daemon output → Interaction[])
// The daemon writes pre-classified, pre-costed entries to
// wtft-tags/<session>.wtft-tag.v{N}.jsonl. These helpers read them back
// without re-parsing raw harness entries or re-calculating costs.
// ---

/**
 * Convert a single classified tag-file line to an Interaction.
 * The classified format is: {t, c, cat, f: [{p, a}], cmd}
 * cost is already computed by the daemon with current pricing (#54/#55).
 * files/commands are populated so classifyInteraction produces the same
 * category the daemon already computed.
 */
export function classifiedToInteraction(obj: any): Interaction | null {
	if (!obj || typeof obj.t !== "number" || typeof obj.c !== "number") return null;
	return {
		timestamp: obj.t,
		cost: obj.c,
		messageId: obj.id || undefined,
		model: obj.m || undefined,
		files: (obj.f || []).map((f: any) => ({ path: f.p || "", action: (f.a === "w" ? "write" : "read") as "read" | "write" })),
		commands: obj.cmd || [],
		texts: [],
		inputTokens: obj.in || 0,
		outputTokens: obj.out || 0,
		cacheReadTokens: obj.cr || 0,
		cacheWriteTokens: obj.cw || 0,
		reasoningTokens: obj.rs || 0,
		_cat: obj.cat || undefined,
	};
}

/**
 * Read all classified interactions from a tag file, skipping heartbeat lines.
 *
 * @param tagPath - Absolute path to the .wtft-tag.v{N}.jsonl file
 * @returns Array of Interactions (costs already computed by daemon)
 */
export function readClassifiedTagFile(tagPath: string): Interaction[] {
	const interactions: Interaction[] = [];
	try {
		const content = fs.readFileSync(tagPath, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const obj = JSON.parse(line);
				if (obj._hb) continue; // skip heartbeat lines
				const interaction = classifiedToInteraction(obj);
				if (interaction) interactions.push(interaction);
			} catch {
				// Skip unparseable lines
			}
		}
	} catch {
		// File may not exist yet
	}
	return interactions;
}

// ---
// INOTIFY-BASED WATCH MODE (#53)
// Replaces the poll-loop watchMode with fs.watch on the daemon's classified
// tag file. Auto-spawn of the daemon happens in the CLI entry point (bin/wtft.ts).
// ---

/**
 * Watch a classified tag file via inotify (fs.watch) and re-render the bar
 * chart in real time on every write. The daemon guarantees:
 *   - Writes at most every 667ms (90bpm)
 *   - Every line is a complete, valid JSON line (atomic writes)
 *   - No partial lines, no mid-write reads
 *
 * This means the consumer can use event-driven fs.watch — no polling,
 * no throttling, no partial-line handling.
 *
 * @param sessionPath - Path to the session.jsonl (shown in title)
 * @param tagPath - Path to the daemon's classified tag file
 * @param settings - Display settings (interval, limit, width, etc.)
 */

// ---
// DAEMON HEALTH CHECK (used by watchTagFile + Pi widget)
// ---

/**
/**
 * Compute the tag file path for a given session path.
 * Scans wtft-tags/ subdirectory for the current version's tag file.
 */
export const WTFT_TAGGER_VERSION = "2.3.2";

export function getTagPath(sessionPath: string): string {
	const sessionDir = path.dirname(sessionPath);
	const sessionBase = path.basename(sessionPath);
	const tagsDir = path.join(sessionDir, "wtft-tags");
	const defaultPath = path.join(tagsDir, sessionBase + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	try {
		const prefix = sessionBase + ".wtft-tag.v";
		for (const f of fs.readdirSync(tagsDir)) {
			if (f.startsWith(prefix) && f.endsWith(".jsonl")) {
				return path.join(tagsDir, f);
			}
		}
	} catch {}
	return defaultPath;
}

export function getDaemonPidPath(sessionPath: string): string {
	const sessionHash = createHash("sha256").update(sessionPath).digest("hex").slice(0, 12);
	return path.join(os.tmpdir(), `wtft-daemon-${sessionHash}.pid`);
}

export interface DaemonStatus {
	alive: boolean;
	reason?: string;
	lastHbTime?: string; // HH:MM local time of last heartbeat
}

export function checkDaemonHealth(sessionPath: string, tagPath: string): DaemonStatus {
	// Fast path: check if PID file exists and process is alive.
	const pidPath = getDaemonPidPath(sessionPath);
	let pidAlive = false;
	try {
		const pid = parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
		if (pid > 0) {
			try { process.kill(pid, 0); pidAlive = true; } catch {}
		}
	} catch {}

	if (pidAlive) return { alive: true };

	// PID dead or missing — read last _hb heartbeat for stop reason + time.
	let lastHbMs = 0;
	try {
		const stat = fs.statSync(tagPath);
		// Read last ~8KB to find the most recent heartbeat line.
		const readStart = Math.max(0, stat.size - 8192);
		const fd = fs.openSync(tagPath, "r");
		const buf = Buffer.alloc(stat.size - readStart);
		fs.readSync(fd, buf, 0, buf.length, readStart);
		fs.closeSync(fd);
		const lines = buf.toString("utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const obj = JSON.parse(line);
				if (obj._hb && obj._hb.last) {
					lastHbMs = obj._hb.last;
					break;
				}
			} catch {}
		}
	} catch {}

	if (lastHbMs === 0) {
		return { alive: false, reason: "log parser not found" };
	}

	// Format the heartbeat time as local HH:MM.
	const d = new Date(lastHbMs);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const timeStr = `${hh}:${mm}`;

	return { alive: false, reason: "idle timeout", lastHbTime: timeStr };
}

export function restartDaemon(sessionPath: string, daemonPath: string): boolean {
	// Kill existing daemon (stale or alive) for this session.
	const pidPath = getDaemonPidPath(sessionPath);
	try {
		const pid = parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
		if (pid > 0) {
			try { process.kill(pid, "SIGTERM"); } catch {}
		}
		try { fs.unlinkSync(pidPath); } catch {}
	} catch {}

	// Spawn fresh daemon.
	try {
		const child = spawn(process.execPath, [daemonPath, "--session", sessionPath], {
			detached: true,
			stdio: "ignore"
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

// ---

export async function watchTagFile(
	sessionPath: string,
	tagPath: string,
	settings: WatchSettings
): Promise<void> {
	if (!process.stdout.isTTY) {
		console.error("❌ --watch requires a real terminal (TTY). Refusing to start.");
		process.exit(1);
	}

	let totalCost = 0;
	let interactionCount = 0;
	let needsRedraw = true;
	let _lastRenderMin = -1;

	// Alt screen buffer — live updates inside, main screen restored on exit.
	process.stdout.write("\x1b[?1049h");
	hideCursor();

	let lastBuffer: string[] = [];

	// Shared exit: clears chart output, restores terminal, prints final chart.
	const exitWatch = () => {
		if (watcher) watcher.close();
		process.stdout.write("\x1b[?1049l");
		showCursor();
		cleanupStdin();
		if (lastBuffer.length > 0) {
			for (const l of lastBuffer) console.log(l);
		}
		console.log(`WTFT watch stopped \u2014 ${interactionCount} interactions, $${totalCost.toFixed(4)} total cost.`);
		process.exit(0);
	};

	process.on("SIGINT", exitWatch);

	// ---
	// DAEMON HEALTH TRACKING
	// ---
	let daemonDead = false;
	let daemonStopReason = "";
	let daemonStopTime = "";
	let daemonRestarting = false;

	const updateDaemonHealth = () => {
		if (daemonRestarting) {
			// Check if daemon came back online after restart.
			const health = checkDaemonHealth(sessionPath, tagPath);
			if (health.alive) {
				daemonRestarting = false;
				daemonDead = false;
				daemonStopReason = "";
				daemonStopTime = "";
			}
			return;
		}
		const health = checkDaemonHealth(sessionPath, tagPath);
		if (!health.alive) {
			daemonDead = true;
			daemonStopReason = health.reason || "unknown";
			daemonStopTime = health.lastHbTime || "";
		} else {
			daemonDead = false;
			daemonStopReason = "";
			daemonStopTime = "";
		}
	};

	// Raw stdin for 'q'/'Q' quit and 'r' log parser restart.
	const cleanupStdin = enterRawStdin((key: string) => {
		if (key === "q" || key === "Q" || key === "\u0003") {
			exitWatch();
		}
		if (key === "r" || key === "R") {
			if (settings.daemonPath) {
				daemonRestarting = true;
				daemonDead = false;
				const ok = restartDaemon(sessionPath, settings.daemonPath);
				if (!ok) {
					daemonRestarting = false;
					daemonDead = true;
					daemonStopReason = "restart failed";
				}
				needsRedraw = true;
				render();
				// Fast health re-check: poll every second for up to 5s after restart.
				let pollCount = 0;
				const postRestartPoll = setInterval(() => {
					pollCount++;
					updateDaemonHealth();
					if (!daemonRestarting || pollCount >= 5) {
						clearInterval(postRestartPoll);
					}
					needsRedraw = true;
					render();
				}, 1000);
			}
		}
	});

	// Read initial classified entries from tag file (daemon may have already
	// processed part of the session before we started watching).
	let allInteractions: Interaction[] = readClassifiedTagFile(tagPath);
	let lastReadOffset = 0;
	try {
		lastReadOffset = fs.statSync(tagPath).size;
	} catch {}

	// Session-level settings from inline wtft-settings entries (same as watchMode).
	let disabledEmoji = settings.disabledEmoji;
	let sessionInterval: string | undefined;
	let sessionLimit: number | undefined;
	let sessionMode: "cumulative" | "bucket" | undefined;
	let sessionShowTicks: boolean | undefined;
	let sessionTimezone: string | undefined;

	// Parse inline wtft-settings from the tag file (if the daemon wrote any).
	// wtft-settings are written as custom entries in the session.jsonl, not the
	// classified tag file, so we read the session directly for settings only.
	try {
		const sessionContent = fs.readFileSync(sessionPath, "utf8");
		for (const line of sessionContent.split("\n")) {
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
						if (entry.data.mode === "cumulative" || entry.data.mode === "bucket") sessionMode = entry.data.mode;
						if (typeof entry.data.showTicks === "boolean") sessionShowTicks = entry.data.showTicks;
						if (typeof entry.data.timezone === "string") sessionTimezone = entry.data.timezone;
					}
				}
			} catch {
				// Skip unparseable lines
			}
		}
	} catch {
		// Session file may not exist or be unreadable
	}

	const render = () => {
		// Home cursor + clear — safe inside alt screen, prevents scrollback accumulation
		process.stdout.write("\x1b[H\x1b[J");

		const width = getTerminalWidth();
		const finalInterval = sessionInterval ?? settings.interval;
		const finalLimit = sessionLimit ?? settings.limit;
		const finalMode = sessionMode ?? settings.mode;
		const finalShowTicks = sessionShowTicks ?? settings.showTicks;
		const finalTimezone = sessionTimezone ?? settings.timezone;
		const finalWidth = Math.min(settings.width, width);

		const defaultSettings = {
			interval: "1h", limit: 100, width: finalWidth,
			showTicks: true, mode: "cumulative" as "cumulative" | "bucket",
			timezone: undefined
		};

		// Deduplicate by message.id — classified entries from the daemon are already
		// deduped (the daemon uses the same message-ID dedup logic), so this is a no-op
		// in normal operation. Present as cheap insurance against edge cases.
		const deduped = deduplicateInteractions(allInteractions);
		interactionCount = deduped.length;

		const lines = buildWtftLines(deduped, defaultSettings, {
			interval: finalInterval,
			limit: finalLimit,
			width: finalWidth,
			showTicks: finalShowTicks,
			mode: finalMode,
			timezone: finalTimezone,
			disabledEmoji,
			forceLegendRow: true
		});

		const buf: string[] = [];
		buf.push(`\x1b[90m${sessionPath}\x1b[0m`);
		totalCost = deduped.reduce((sum, i) => sum + i.cost, 0);

		if (lines && lines.length > 0) {
			// ---
			// Append daemon status (inline if it fits, otherwise separate line).
			// ---
			let daemonStatusStr = "";
			if (daemonRestarting) {
				daemonStatusStr = "  \x1b[33m●\x1b[0m restarting...";
			} else if (daemonDead) {
				const label = daemonStopTime
					? `stopped ${daemonStopTime}`
					: daemonStopReason;
				daemonStatusStr = `  \x1b[31m●\x1b[0m ${label}`;
			} else {
				daemonStatusStr = "  \x1b[32m●\x1b[0m live";
			}

			if (daemonStatusStr) {
				const titleVisualLen = getVisualLength(lines[0]);
				const statusVisualLen = getVisualLength(daemonStatusStr);
				if (titleVisualLen + statusVisualLen <= finalWidth - 2) {
					lines[0] = lines[0] + daemonStatusStr;
				} else {
					// Doesn't fit — insert as a separate line after the title
					lines.splice(1, 0, daemonStatusStr.trim());
				}
			}

			for (const l of lines) buf.push(l);
		} else {
			buf.push("\x1b[90mWaiting for session data...\x1b[0m");
		}

		// Footer row
		const restartHint = settings.daemonPath
			? (daemonDead ? `, \x1b[31m'r' to restart parser\x1b[0m` : `, using v${WTFT_TAGGER_VERSION}, 'r' to restart parser`)
			: "";
		buf.push(`'q' to exit${restartHint}`);

		lastBuffer = [...buf];
		process.stdout.write(buf.join("\n"));
		needsRedraw = false;
		_lastRenderMin = new Date().getMinutes();
	};

	// Initial render
	render();

	// SIGWINCH handler — re-render immediately on terminal resize
	process.on("SIGWINCH", () => {
		needsRedraw = true;
		render();
	});

	// ---
	// fs.watch on the classified tag file (inotify on Linux).
	// The daemon guarantees:
	//   - Writes at most every 667ms (90bpm)
	//   - Every line is a complete JSON + \n (atomic fs.appendFileSync)
	//   - No partial lines, no mid-write reads
	// Therefore every "change" event = one or more complete lines ready.
	// No debounce needed — double-fire is harmless (stat.size check is a no-op).
	//
	// Wait up to 5s for the daemon to create the tag file before watching.
	// ---
	let watcher: fs.FSWatcher | null = null;

	const startWatching = () => {
		watcher = fs.watch(tagPath, (eventType) => {
			if (eventType !== "change") return;

			try {
				const stat = fs.statSync(tagPath);
				if (stat.size <= lastReadOffset) return;

				const fd = fs.openSync(tagPath, "r");
				const buf = Buffer.alloc(stat.size - lastReadOffset);
				fs.readSync(fd, buf, 0, buf.length, lastReadOffset);
				fs.closeSync(fd);
				lastReadOffset = stat.size;

				const newContent = buf.toString("utf8");
				const lines = newContent.split("\n");
				let newCount = 0;
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const obj = JSON.parse(line);
						if (obj._hb) continue; // skip heartbeats
						const interaction = classifiedToInteraction(obj);
						if (interaction) {
							allInteractions.push(interaction);
							newCount++;
						}
					} catch {
						// Skip unparseable lines
					}
				}

				if (newCount > 0) {
					needsRedraw = true;
					render();
				}
			} catch {
				// Tag file may have been deleted or truncated — re-read from zero
				try {
					lastReadOffset = 0;
					allInteractions = readClassifiedTagFile(tagPath);
					lastReadOffset = fs.statSync(tagPath).size;
					needsRedraw = true;
					render();
				} catch {
					// File gone — wait for it to reappear
				}
			}
		});
	};

	// Poll for the tag file to appear (daemon creates it on first write).
	const fileWaitStart = Date.now();
	while (!fs.existsSync(tagPath) && Date.now() - fileWaitStart < 5000) {
		await new Promise(r => setTimeout(r, 250));
	}

	if (fs.existsSync(tagPath)) {
		startWatching();
	} else {
		console.error("❌ Log parser did not create tag file within 5s. Is wtft-daemon installed?");
		console.error(`   Expected: ${tagPath}`);
		process.exit(1);
	}

	// Initial daemon health check (10s after startup to let daemon settle).
	setTimeout(() => { updateDaemonHealth(); needsRedraw = true; render(); }, 10000);

	// Per-minute re-render for timeline diamond/badge + daemon health updates.
	const minuteInterval = setInterval(() => {
		const _curMin = new Date().getMinutes();
		if (_curMin !== _lastRenderMin) {
			updateDaemonHealth();
			needsRedraw = true;
			render();
		}
	}, 60000);

	// Keep the process alive (fs.watch is the primary event source).
	// The minuteInterval also prevents exit when watcher is quiet.
	// This is an intentional infinite await — exitWatch() calls process.exit().
	await new Promise(() => {});
}

/**
 * @package princess-pi-packages
 * @module wtft-parser
 * @description Session log parsing and interaction classification.
 *   Reads Pi and Claude Code session.jsonl files, extracts token usage
 *   and cost per assistant message, normalizes field names across
 *   schemas, and classifies interactions into spec/code/other categories.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { calculateClaudeCost, calculateServerToolCost } from "./wtft-cost.js";
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

export function parseEntryToInteraction(entry: any, thinkingLevel?: string, compactionTokensBefore?: number): Interaction | null {
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

		// Server-side tool requests: per-request billed, separate meter from tokens.
		// Claude Code surfaces web_search / web_fetch via usage.server_tool_use (#73).
		const serverToolRequests = usage.server_tool_use || {};
		const serverToolCost = calculateServerToolCost(
			assistantMsg.model || "",
			serverToolRequests.web_search_requests || 0,
			serverToolRequests.web_fetch_requests || 0
		);

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
			webSearchRequests: (serverToolRequests.web_search_requests || 0) as number,
			webFetchRequests: (serverToolRequests.web_fetch_requests || 0) as number,
			serverToolCost,
			thinkingLevel,
			compactionTokensBefore,
			files, commands, texts };
	}
	
	return null;
}

export function parseSessionFile(filePath: string): Interaction[] {
	const interactions: Interaction[] = [];
	let currentThinkingLevel: string | undefined;
	let lastCompactionTokensBefore: number | undefined;
	try {
		const content = fs.readFileSync(filePath, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				// Track thinking level changes (#77)
				if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
					currentThinkingLevel = entry.thinkingLevel;
					continue;
				}
				// Track compaction entries — stamp tokensBefore onto the next
				// assistant interaction so cost/token summaries can surface
				// how much context was freed (#90).
				if (entry.type === "compaction" && typeof entry.tokensBefore === "number") {
					lastCompactionTokensBefore = entry.tokensBefore;
					continue;
				}
				const interaction = parseEntryToInteraction(entry, currentThinkingLevel, lastCompactionTokensBefore);
				if (interaction) {
					interactions.push(interaction);
					lastCompactionTokensBefore = undefined; // consumed by this interaction
				}
			} catch {
				// Skip unparseable lines (partial writes, non-JSON)
			}
		}
	} catch {
		// File may not exist or be unreadable
	}
	return interactions;
}

// MESSAGE-ID DEDUPLICATION (#54)
// Claude Code emits multiple JSONL lines per API response (one per content block +
// streaming/compaction re-logging), each echoing the same message-level `usage`.
// Summing per line inflates costs ~1.8×. Dedup by message.id: keep the max-cost
// copy (handles streaming partials where usage grows), merge content blocks from
// all copies for correct classification.

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

// HELPERS & PARSERS

export function normalizeCommand(cmd: string): string {
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

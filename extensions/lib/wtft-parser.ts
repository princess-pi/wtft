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
import * as os from "node:os";
import { calculateClaudeCost, calculateServerToolCost, getDeepSeekPeakMultiplier } from "./wtft-cost.js";

// ---
// TYPES (#52) — single source of truth for parser output. These were referenced
// module-wide but never defined after the #68 monolith split (build.mjs strips
// types without checking, so the gap was invisible until #52 grew the union).
// ---

export type Category =
	| "plan" | "spec" | "research" | "web" | "grep"
	| "code" | "tests" | "git" | "agents"
	| "prompt" | "compaction" | "interrupted" | "overhead" | "other";

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
	webSearchRequests: number;
	webFetchRequests: number;
	serverToolCost: number;
	thinkingLevel?: string;
	compactionTokensBefore?: number;
	/** Observed prompt-cache TTL class from usage.cache_creation — data beats
	 *  the model-name guess for the idle countdown (#95). */
	cacheTtl?: "1h" | "5m";
	/** Turn was killed by the user — whole cost is discarded work (#52 Phase 3). */
	interrupted?: boolean;
	/** Turn immediately follows a compact summary — its cache_write component
	 *  is the compaction bill (#52 Phase 3 meter-split). */
	afterCompaction?: boolean;
	/** 1h-tier share of cacheWriteTokens; recache-signature input (#52 Phase 3). */
	cacheWrite1hTokens?: number;
	/** usage.iterations length when present; recache-signature guard. */
	iterations?: number;
	/** Subagent sidechain entry — excluded from prevCtx recache tracking. */
	isSidechain?: boolean;
	files: { path: string; action: "read" | "write" }[];
	commands: string[];
	texts: string[];
	/** Categories implied by recognized non-file tools (Task→agents, WebSearch→web, …) (#52) */
	toolCats?: Category[];
	/** Message carried a tool_use we don't model — classifies "other", never "prompt" (#52) */
	unrecognizedTool?: boolean;
	/** Pre-classified category from the daemon tag file — short-circuits classifyInteraction */
	_cat?: Category;
	/** True when this interaction's timestamp falls within DeepSeek surge-pricing hours (#119).
	 *  Populated by parseEntryToInteraction from effectiveModel (assistantMsg.model ||
	 *  currentModel from model_change events, #128). Serialized to tag file as `sp` field
	 *  (serializeClassified / classifiedToInteraction round-trip in wtft-daemon-lib.ts). */
	surgePriced?: boolean;
}

// ---
// TOOL → CATEGORY MAP (#52) — non-file tools that earn a category directly.
// Why: unmapped tools previously fell into "prompt"/"other", so a turn that
// spawned three subagents was billed as conversation. Names are lowercased.
// ---
const TOOL_CATEGORY_MAP: Record<string, Category> = {
	// Subagent orchestration — largest measured unmodeled spend (#52 measurements)
	task: "agents", agent: "agents", workflow: "agents",
	// Server-side web tools — token side joins the request-cost side (#73)
	websearch: "web", webfetch: "web",
	// Standalone Grep tool joins bash grep/rg in the existing category
	grep: "grep",
	// Planning/steering tools — split out of "prompt" so prompt = pure reply
	todowrite: "plan", taskcreate: "plan", taskupdate: "plan", taskget: "plan",
	tasklist: "plan", askuserquestion: "plan", enterplanmode: "plan",
	exitplanmode: "plan", skill: "plan", toolsearch: "plan",
};

/** Route one non-file tool call into toolCats / unrecognizedTool flags (#52). */
function mapToolToCategory(name: string, toolCats: Set<Category>): boolean {
	const cat = TOOL_CATEGORY_MAP[name];
	if (cat) {
		toolCats.add(cat);
		return true;
	}
	return false;
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

export function parseEntryToInteraction(entry: any, thinkingLevel?: string, compactionTokensBefore?: number, afterCompaction?: boolean, currentModel?: string): Interaction | null {
	if (!entry) return null;
	
	// Support both Pi schema (entry.type === "message") and Claude Code schema (entry.type === "assistant" or lacking type but having message)
	const isPiSchema = entry.type === "message" && entry.message && entry.message.role === "assistant";
	const isClaudeSchema = entry.type === "assistant" && entry.message && entry.message.role === "assistant";

	if (isPiSchema || isClaudeSchema) {
		const assistantMsg = entry.message;

		// Resolve effective model: Pi sessions track model via model_change events
		// (passed as currentModel), not on each message. Claude Code stores it
		// directly on assistantMsg.model.
		//
		// Spec (#128): model_change entries carry provider + modelId. We track
		// modelId as currentModel through both parseSessionFile and the daemon's
		// incremental parseNewLines. When assistantMsg.model is absent (Pi),
		// the tracked currentModel fills in — enabling DeepSeek surge-pricing
		// detection, cost calculation, and server-tool-cost lookups that previously
		// failed silently. Claude Code's message.model always takes precedence.
		const effectiveModel = assistantMsg.model || currentModel || "";

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
		} else if (effectiveModel && hasTokens) {
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
			cost = calculateClaudeCost(effectiveModel, normalizedUsage, timestamp);
		}

		// Observed cache TTL class (#95): the transcript records which ephemeral
		// tier cache writes actually used — authoritative over any model-name guess.
		const cacheCreation = usage.cache_creation || {};
		const cacheTtl: "1h" | "5m" | undefined =
			(cacheCreation.ephemeral_1h_input_tokens || 0) > 0 ? "1h"
			: (cacheCreation.ephemeral_5m_input_tokens || 0) > 0 ? "5m"
			: undefined;

		// Server-side tool requests: per-request billed, separate meter from tokens.
		// Claude Code surfaces web_search / web_fetch via usage.server_tool_use (#73).
		const serverToolRequests = usage.server_tool_use || {};
		const serverToolCost = calculateServerToolCost(
			effectiveModel,
			serverToolRequests.web_search_requests || 0,
			serverToolRequests.web_fetch_requests || 0
		);

		// Surge-pricing tag (#119): mark interactions that fell within DeepSeek peak hours
		const surgePriced = effectiveModel.toLowerCase().includes("deepseek")
			? getDeepSeekPeakMultiplier(timestamp) > 1.0 : undefined;

		const files: { path: string; action: "read" | "write" }[] = [];
		const commands: string[] = [];
		const texts: string[] = [];
		const toolCats = new Set<Category>();
		let unrecognizedTool = false;

		if (Array.isArray(assistantMsg.content)) {
			for (const block of assistantMsg.content) {
				if (block.type === "text") {
					texts.push(block.text);
				} else if (block.type === "thinking") {
					texts.push(block.thinking);
				} else if (block.type === "toolCall") {
					// Pi Schema
					const name = (block.name || "").toLowerCase();
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
					} else if (!mapToolToCategory(name, toolCats)) {
						unrecognizedTool = true;
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
					} else if (name === "notebookedit") {
						// Notebook edits classify by path like any other file write (#52)
						if (args.notebook_path) files.push({ path: args.notebook_path, action: "write" });
					} else if (name === "bash" || name === "run") {
						if (args.command) {
							commands.push(args.command);
							extractFilesFromBashCommand(args.command, files);
						}
					} else if (!mapToolToCategory(name, toolCats)) {
						unrecognizedTool = true;
					}
				}
			}
		}

		return { timestamp, cost, messageId: assistantMsg.id, requestId: entry.requestId,
			model: effectiveModel || undefined,
			inputTokens: (usage.input_tokens || usage.input || 0) as number,
			outputTokens: (usage.output_tokens || usage.output || 0) as number,
			cacheReadTokens: (usage.cache_read_input_tokens || usage.cacheRead || 0) as number,
			cacheWriteTokens: (usage.cache_creation_input_tokens || usage.cacheWrite || 0) as number,
			reasoningTokens: (usage.reasoning || 0) as number,
			webSearchRequests: (serverToolRequests.web_search_requests || 0) as number,
			webFetchRequests: (serverToolRequests.web_fetch_requests || 0) as number,
			serverToolCost,
		surgePriced,
			thinkingLevel,
			compactionTokensBefore,
			cacheTtl,
			afterCompaction: (afterCompaction || compactionTokensBefore !== undefined) || undefined,
			cacheWrite1hTokens: (cacheCreation.ephemeral_1h_input_tokens || 0) > 0
				? cacheCreation.ephemeral_1h_input_tokens : undefined,
			iterations: Array.isArray(usage.iterations) ? usage.iterations.length : undefined,
			isSidechain: entry.isSidechain === true || undefined,
			files, commands, texts,
			toolCats: toolCats.size > 0 ? [...toolCats] : undefined,
			unrecognizedTool: unrecognizedTool || undefined };
	}

	return null;
}

// ---
// HARNESS-OVERHEAD DETECTION (#52 Phase 3)
// ---

/** Both marker spellings: "[Request interrupted by user]" and
 *  "[Request interrupted by user for tool use]". */
export const INTERRUPT_PREFIX = "[Request interrupted by user";

/** True when a transcript entry is a user interrupt marker — stamps the
 *  PRECEDING assistant interaction as interrupted (whole cost = waste).
 *  Only user-entry content counts; the literal inside tool results or
 *  assistant text must not reclassify anything. */
export function isInterruptMarker(entry: any): boolean {
	if (!entry || entry.type !== "user") return false;
	const c = entry.message?.content;
	if (typeof c === "string") return c.includes(INTERRUPT_PREFIX);
	if (Array.isArray(c)) {
		return c.some((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.includes(INTERRUPT_PREFIX));
	}
	return false;
}

/**
 * Meter-split overhead detection (#52 Phase 3, grounded in
 * docs/research/52-split-strategies/): returns the slice of this
 * interaction's cost that is context maintenance rather than work.
 *
 *  - compaction: the turn after a compact summary pays the summary's
 *    cache re-creation bill — its cache_write $ component → "compaction".
 *  - overhead (recache): Claude Code rewriting the whole context into the
 *    1h cache tier — exact 5-condition meter conjunction, measured at
 *    13.7–39.1% of session cost. cache_write $ component → "overhead".
 *
 * The dollar component is the rate-weighted cache_write share of the
 * interaction's real cost (conserves totals exactly; works for Pi-native
 * costs too since only the meter RATIOS matter).
 *
 * @param prevCtxTokens input+cacheRead+cacheWrite of the previous
 *   non-sidechain deduped interaction (0 = unknown → no recache detection)
 */
export function splitOverheadCost(
	interaction: Interaction,
	prevCtxTokens: number
): { kind: "compaction" | "overhead"; overheadCost: number } | null {
	const cw = interaction.cacheWriteTokens;
	if (cw <= 0 || interaction.cost <= 0) return null;

	let kind: "compaction" | "overhead" | null = null;
	if (interaction.afterCompaction) {
		kind = "compaction";
	} else if (!interaction.isSidechain) {
		const cr = interaction.cacheReadTokens;
		const ctx = interaction.inputTokens + cr + cw;
		const isRecache =
			cw > 30_000 &&
			interaction.inputTokens <= 16 &&
			cr < 0.2 * (cr + cw) &&
			prevCtxTokens > 0 && Math.abs(ctx - prevCtxTokens) < 0.15 * prevCtxTokens &&
			(interaction.iterations || 0) <= 1;
		if (isRecache) kind = "overhead";
	}
	if (!kind) return null;

	// cache_write $ share via the production rate resolver: full cost minus
	// the same usage with cache writes removed — no rate table duplication.
	const cw1h = interaction.cacheWrite1hTokens || 0;
	const usage = {
		input_tokens: interaction.inputTokens,
		output_tokens: interaction.outputTokens,
		cache_read_input_tokens: interaction.cacheReadTokens,
		cache_creation_input_tokens: cw,
		cache_creation: cw1h > 0
			? { ephemeral_1h_input_tokens: cw1h, ephemeral_5m_input_tokens: Math.max(0, cw - cw1h) }
			: null,
		reasoning_tokens: interaction.reasoningTokens,
	};
	const model = interaction.model || "claude";
	const full = calculateClaudeCost(model, usage, interaction.timestamp);
	const withoutCw = calculateClaudeCost(model, {
		...usage, cache_creation_input_tokens: 0, cache_creation: null,
	}, interaction.timestamp);
	if (full <= 0 || full <= withoutCw) return null;
	const cwFraction = (full - withoutCw) / full;
	const overheadCost = interaction.cost * cwFraction;
	if (overheadCost <= 0) return null;
	return { kind, overheadCost };
}

export function parseSessionFile(filePath: string): Interaction[] {
	const interactions: Interaction[] = [];
	let currentThinkingLevel: string | undefined;
	let currentModel: string | undefined;
	let lastCompactionTokensBefore: number | undefined;
	let pendingAfterCompaction = false;
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
				// Track model from model_change events for Pi sessions (#128).
				// Pi does not store the model on each message; it emits
				// model_change entries with provider + modelId.
				if (entry.type === "model_change" && entry.modelId) {
					currentModel = entry.modelId;
					continue;
				}
				// Track compaction entries — stamp tokensBefore onto the next
				// assistant interaction so cost/token summaries can surface
				// how much context was freed (#90).
				if (entry.type === "compaction" && typeof entry.tokensBefore === "number") {
					lastCompactionTokensBefore = entry.tokensBefore;
					continue;
				}
				// Claude Code compact summary marker → flag the next assistant
				// interaction for the compaction meter-split (#52 Phase 3).
				if (entry.isCompactSummary === true) {
					pendingAfterCompaction = true;
					continue;
				}
				// User interrupt marker → the PRECEDING assistant turn was
				// killed; its whole cost is discarded work (#52 Phase 3).
				if (isInterruptMarker(entry)) {
					if (interactions.length > 0) interactions[interactions.length - 1].interrupted = true;
					continue;
				}
				const interaction = parseEntryToInteraction(entry, currentThinkingLevel, lastCompactionTokensBefore, pendingAfterCompaction, currentModel);
				if (interaction) {
					interactions.push(interaction);
					lastCompactionTokensBefore = undefined; // consumed by this interaction
					pendingAfterCompaction = false;
				}
			} catch {
				// Skip unparseable lines (partial writes, non-JSON)
			}
		}
	} catch {
		// File may not exist or be unreadable
	}

	// Claude bash sub-agent discovery (#138): find sub-agent sessions
	// spawned by `claude -p` bash commands and attribute their token
	// totals to the parent interactions. Done inside parseSessionFile so
	// callers always get complete data — no separate attribution step.
	attributeClaudeSubAgentCosts(interactions);

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
				texts: [],
				toolCats: undefined,
				unrecognizedTool: undefined
			};
			const seenFiles = new Set<string>();
			const mergedToolCats = new Set<Category>();
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
				for (const tc of i.toolCats || []) mergedToolCats.add(tc);
				if (i.unrecognizedTool) merged.unrecognizedTool = true;
				// Overhead flags must survive the merge — any copy carrying
				// them marks the whole billed message (#52 Phase 3).
				if (i.interrupted) merged.interrupted = true;
				if (i.afterCompaction) merged.afterCompaction = true;
				if (i.surgePriced) merged.surgePriced = true;
			}
			if (mergedToolCats.size > 0) merged.toolCats = [...mergedToolCats];
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

	// Interrupted wins whole-message (#52 Phase 3): the turn's spend was
	// discarded work — calling it "code" would overstate useful code spend.
	// (Compaction/recache meter-splits extract their cache_write component
	// BEFORE this classification; see splitOverheadCost.)
	if (interaction.interrupted) return "interrupted";

	const specPaths = new Set<string>();
	const codePaths = new Set<string>();
	const testsPaths = new Set<string>();
	const researchPaths = new Set<string>();
	const planPaths = new Set<string>();

	for (const f of interaction.files) {
		const norm = f.path.replace(/\\/g, "/");
		let category: "spec" | "code" | "tests" | "research" | "plan" | null = null;

		if (norm.includes("node_modules/")) {
			// Third-party library documentation/READMEs represent reference material (Research)
			if (path.extname(norm).toLowerCase() === ".md" || norm.includes("/docs/")) {
				category = "research";
			} else {
				category = "code";
			}
		} else if (norm.startsWith("docs/research/") || norm.includes("/docs/research/")) {
			// Written explorations (analyses, audits, why-not docs) are thinking
			// artifacts, not normative specs — checked before the docs/ → spec rule (#52)
			category = "plan";
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
		else if (category === "plan") planPaths.add(f.action);
	}

	// Multi-category turns resolve by latest-workflow-stage-wins (no more "mixed",
	// #52 amendment 2): the furthest stage is the turn's real progress; earlier-stage
	// touches (a spec tweak mid-coding) are supporting edits. Writes beat reads.
	if (testsPaths.has("write")) return "tests";
	if (codePaths.has("write")) return "code";
	if (researchPaths.has("write")) return "research";
	if (specPaths.has("write")) return "spec";
	if (planPaths.has("write")) return "plan";

	if (testsPaths.has("read")) return "tests";
	if (codePaths.has("read")) return "code";
	if (researchPaths.has("read")) return "research";
	if (specPaths.has("read")) return "spec";
	if (planPaths.has("read")) return "plan";

	// Tool-implied categories (#52) — priority: agents (spawn cost dominates) >
	// web (joins #73 request-cost billing) > plan > grep. Sits below file ops
	// (a turn that edits AND spawns is still the edit) and above bash commands.
	if (interaction.toolCats && interaction.toolCats.length > 0) {
		for (const cat of ["agents", "web", "plan", "grep"] as Category[]) {
			if (interaction.toolCats.includes(cat)) return cat;
		}
	}

	if (interaction.commands.length > 0) {
		let isGit = false;
		let isGrep = false;
		let isAgents = false;
		for (const cmd of interaction.commands) {
			const normalized = normalizeCommand(cmd);
			if (!normalized) continue; // stripped to nothing (pure cd, pure var assignment)
			const lower = normalized.toLowerCase().trim();
			if (/(?:^|\s)claude(?:\s+-|\s*\||\s*$)/.test(lower)) {
				isAgents = true;
			} else if (lower === "git" || lower.startsWith("git ")) {
				isGit = true;
			} else if (lower === "grep" || lower.startsWith("grep ") || lower === "rg" || lower.startsWith("rg ") || lower === "ripgrep" || lower.startsWith("ripgrep ") || lower === "find" || lower.startsWith("find ")) {
				isGrep = true;
			}
		}
		if (isAgents) return "agents";
		if (isGit) return "git";
		if (isGrep) return "grep";
		return "other";
	}

	// Prompt purification (#52): a message that fired an unmodeled tool is not
	// conversation, even if it narrated first — "prompt" means pure reply.
	if (interaction.texts.length > 0 && !interaction.unrecognizedTool) return "prompt";
	return "other";
}

// ---
// SUBAGENT SESSION DISCOVERY (#82/#83)
// Recursive walk of subagent directories up to a configurable depth.
// Claude Code stores subagent sessions as agent-*.jsonl files under
// <session-dir>/<session-name>/subagents/. Each subagent may itself
// have nested subagents (depth ≤ 5 per Claude Code docs).
//
// Pi convention (pre-emptive): sibling .jsonl files with a
// "parentSession" header matching the parent session ID.
// ---

const MAX_SUBAGENT_DEPTH = 5; // Claude Code hard limit

/**
 * Discover subagent session files for a given parent session, walking
 * subdirectories recursively up to maxDepth (Claude Code convention).
 *
 * Pattern 1 (Claude Code): <session-dir>/<session-name>/subagents/agent-*.jsonl
 * Pattern 2 (Pi, pre-emptive): sibling files with parentSession header match
 */
export function discoverSubagentSessionFiles(
	sessionPath: string,
	maxDepth: number = MAX_SUBAGENT_DEPTH,
): string[] {
	const files: string[] = [];
	const sessionDir = path.dirname(sessionPath);
	const sessionBase = path.basename(sessionPath, ".jsonl");

	// Pattern 1: Claude Code recursive convention
	const ccBaseDir = path.join(sessionDir, sessionBase, "subagents");
	if (fs.existsSync(ccBaseDir)) {
		walkSubagentDir(ccBaseDir, 1, maxDepth, files);
	}

	// Pattern 2: Pi parentSession convention (pre-emptive, non-recursive —
	// Pi subagents would each get their own discoverSubagentSessionFiles call
	// if they are themselves discovered as subagent files)
	let mainSessionId: string | undefined;
	try {
		const mainHeader = JSON.parse(fs.readFileSync(sessionPath, "utf8").split("\n")[0]);
		if (mainHeader.type === "session") mainSessionId = mainHeader.id;
	} catch { /* header unreadable */ }

	if (mainSessionId) {
		try {
			for (const f of fs.readdirSync(sessionDir)) {
				if (!f.endsWith(".jsonl")) continue;
				const fullPath = path.join(sessionDir, f);
				if (fullPath === sessionPath) continue;
				if (files.includes(fullPath)) continue;
				try {
					const header = JSON.parse(fs.readFileSync(fullPath, "utf8").split("\n")[0]);
					if (header.type === "session" && header.parentSession === mainSessionId) {
						files.push(fullPath);
					}
				} catch { /* skip unreadable files */ }
			}
		} catch { /* dir unreadable */ }
	}

	return files;
}

/** Recursively walk a subagent directory, collecting agent-*.jsonl files.
 * Subagent directories are named agent-<hash>/ and may contain their own
 * subagents/ subdirectory (Claude Code nested subagent convention). */
function walkSubagentDir(
	dir: string,
	depth: number,
	maxDepth: number,
	files: string[],
): void {
	if (depth > maxDepth) return;
	try {
		for (const f of fs.readdirSync(dir)) {
			const fullPath = path.join(dir, f);
			try {
				const stat = fs.statSync(fullPath);
				if (stat.isDirectory()) {
					// Recurse into directories that could contain nested subagents:
					//   "subagents" / "ns" — the nested subagents container itself
					//   "agent-*" — an individual subagent's session dir (may have
					//     its own subagents/ subdirectory with grandchild agents)
					if (f === "subagents" || f === "ns" || f.startsWith("agent-")) {
						walkSubagentDir(fullPath, depth + (f === "subagents" || f === "ns" ? 1 : 0), maxDepth, files);
					}
				} else if (f.startsWith("agent-") && f.endsWith(".jsonl")) {
					files.push(fullPath);
				}
			} catch { /* stat failed — skip */ }
		}
	} catch { /* dir unreadable */ }
}

/**
 * Parse and classify subagent interactions from raw session files.
 * Returns interactions stamped with _cat for downstream short-circuit.
 */
export function loadSubagentInteractions(
	subagentFiles: string[],
	parseFn = parseSessionFile,
	classifyFn = classifyInteraction,
	dedupFn = deduplicateInteractions,
): Interaction[] {
	const interactions: Interaction[] = [];
	for (const file of subagentFiles) {
		try {
			const raw = parseFn(file);
			const deduped = dedupFn(raw);
			for (const interaction of deduped) {
				interaction._cat = classifyFn(interaction);
				interactions.push(interaction);
			}
		} catch { /* file unreadable or unparseable */ }
	}
	return interactions;
}

// ---
// CLAUDE BASH SUB-AGENT DISCOVERY (#138)
// When a parent session spawns `claude -p` via a bash command, discover the
// sub-agent's session file and attribute its tokens to the parent turn.
// ---

const CLAUDE_SUBAGENT_WINDOW_MS = 15_000; // ±15s window for timestamp matching

/** Extract the CWD from a bash command's `cd <dir>` prefix.
 *  Handles: `cd /path && ...`, `cd "/path" && ...`,
 *  `cd /path 2>/dev/null || cd /tmp\n...`
 *  Returns the first cd target directory, or null if no cd found. */
export function extractCwdFromBashCommand(cmd: string): string | null {
	const firstLine = cmd.split('\n')[0].trim();
	const m = firstLine.match(/^cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/);
	if (!m) return null;
	return m[1] || m[2] || m[3] || null;
}

/** Convert a CWD path to the Claude Code project directory slug.
 *  Replaces all `/` with `-` (the leading `/` becomes leading `-`). */
export function cwdToClaudeProjectSlug(cwd: string): string {
	return cwd.replace(/\//g, '-');
}

/** Discover sub-agent session files spawned by a bash `claude -p` command.
 *  Scans `~/.claude/projects/<slug>/` for `.jsonl` files whose first
 *  timestamp falls within `windowMs` of `parentTimestamp`. */
export function discoverClaudeSubAgentSessionFiles(
	cwd: string,
	parentTimestamp: number,
	windowMs: number = CLAUDE_SUBAGENT_WINDOW_MS,
): string[] {
	const slug = cwdToClaudeProjectSlug(cwd);
	const projectDir = path.join(os.homedir(), '.claude', 'projects', slug);
	if (!fs.existsSync(projectDir)) return [];

	const files: string[] = [];
	const tsWindowStart = parentTimestamp - windowMs;
	const tsWindowEnd = parentTimestamp + windowMs;

	try {
		for (const f of fs.readdirSync(projectDir)) {
			if (!f.endsWith('.jsonl')) continue;
			const fullPath = path.join(projectDir, f);
			try {
				// Scan first 10 lines for a timestamp — the first line may be
				// an ai-title entry with no timestamp field.
				const head = fs.readFileSync(fullPath, 'utf8').split('\n').slice(0, 10);
				let ts: string | undefined;
				for (const line of head) {
					if (!line.trim()) continue;
					try {
						const entry = JSON.parse(line);
						ts = entry.timestamp || entry.createdAt || entry.startTime;
						if (ts) break;
					} catch { /* skip */ }
				}
				if (!ts) continue;
				const tsMs = new Date(ts).getTime();
				if (tsMs >= tsWindowStart && tsMs <= tsWindowEnd) {
					files.push(fullPath);
				}
			} catch { /* skip unreadable files */ }
		}
	} catch { /* dir unreadable */ }

	return files;
}

/** Check if any command in an interaction invokes `claude` as a sub-agent.
 *  Uses the same regex as classifyInteraction's claude detection. */
function interactionHasClaudeCommand(interaction: Interaction): boolean {
	return interaction.commands.some(cmd => {
		const normalized = normalizeCommand(cmd);
		if (!normalized) return false;
		return /(?:^|\s)claude(?:\s+-|\s*\||\s*$)/.test(normalized.toLowerCase());
	});
}

/** Post-processing pass: for each interaction that spawns `claude -p` via bash,
 *  discover the sub-agent session files, parse them, and add their token
 *  totals to the parent interaction. Mutates interactions in place.
 *
 *  Sub-agent session IDs are tracked globally to prevent double-counting
 *  across multiple interactions that reference the same session. */
export function attributeClaudeSubAgentCosts(
	interactions: Interaction[],
): void {
	const seenSessionIds = new Set<string>();

	for (const interaction of interactions) {
		if (!interactionHasClaudeCommand(interaction)) continue;
		// Already attributed by a prior call (e.g. parseSessionFile did it
		// internally, and the CLI is doing a post-hoc pass on tag-file data)
		if ((interaction as any).claudeSubAgentSessionIds) continue;

		// Extract CWD from the first command that has a cd prefix
		let cwd: string | null = null;
		for (const cmd of interaction.commands) {
			cwd = extractCwdFromBashCommand(cmd);
			if (cwd) break;
		}
		if (!cwd) continue;

		const subAgentFiles = discoverClaudeSubAgentSessionFiles(
			cwd, interaction.timestamp,
		);

		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalReasoning = 0;
		let totalCost = 0;
		const sessionIds: string[] = [];

		for (const file of subAgentFiles) {
			const sessionId = path.basename(file, '.jsonl');
			if (seenSessionIds.has(sessionId)) continue;
			seenSessionIds.add(sessionId);
			sessionIds.push(sessionId);

			try {
				const subInteractions = parseSessionFile(file);
				const deduped = deduplicateInteractions(subInteractions);
				for (const si of deduped) {
					totalInput += si.inputTokens || 0;
					totalOutput += si.outputTokens || 0;
					totalCacheRead += si.cacheReadTokens || 0;
					totalCacheWrite += si.cacheWriteTokens || 0;
					totalReasoning += si.reasoningTokens || 0;
					totalCost += si.cost || 0;
				}
			} catch { /* file unreadable */ }
		}

		if (sessionIds.length > 0) {
			interaction.inputTokens += totalInput;
			interaction.outputTokens += totalOutput;
			interaction.cacheReadTokens += totalCacheRead;
			interaction.cacheWriteTokens += totalCacheWrite;
			interaction.reasoningTokens += totalReasoning;
			interaction.cost += totalCost;
			(interaction as any).claudeSubAgentSessionIds = sessionIds;
		}
	}
}

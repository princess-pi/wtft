/**
 * @package princess-pi-packages
 * @module wtft-parser
 * @description Session log parsing and interaction classification.
 *   Extracts token usage and cost per assistant message, and classifies
 *   interactions into spec/code/other categories.
 *
 *   It also runs one scan that yields NO interactions at all:
 *   `scanUncountedBillables` counts the entries that stand for API calls the
 *   harness bills for but writes no `usage` object for (#149). Counted, never
 *   priced — so TOTAL stays strictly derived from recorded usage while the
 *   omission stops being silent.
 *
 *   Schema knowledge lives behind the harness seam (#156):
 *   harness/<id>/parse.ts translates one harness's entry shape into the neutral
 *   AssistantTurn / ParsedBlock / ControlSignal / UncountedBillableClass
 *   vocabulary, and everything in
 *   this file operates on that vocabulary alone. Cost, cache observation, the
 *   meter-split, and classification stay here — shared — so a new harness
 *   cannot get billing wrong. Adding a harness must not require editing this
 *   file; see docs/adding-a-harness.md.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { calculateClaudeCost, calculateServerToolCost, getDeepSeekPeakMultiplier } from "./wtft-cost.js";
import { getParseAdapters } from "./harness/registry.ts";
import type { ControlSignal, UncountedBillableClass } from "./harness/types.ts";

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
	/** Whole prefix re-primed instead of read (cache_read 0, cache_creation > 0).
	 *  Set from raw usage at parse time and carried through the meter-split, which
	 *  otherwise destroys the signal; drives the "Cache Miss" divider (#152). */
	cacheMiss?: boolean;
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

	// Schema dispatch: the first harness that recognizes this entry owns it.
	let turn = null;
	for (const adapter of getParseAdapters()) {
		turn = adapter.matchAssistant(entry);
		if (turn) {
			return buildInteraction(turn, adapter, thinkingLevel, compactionTokensBefore, afterCompaction, currentModel);
		}
	}

	return null;
}

/**
 * Everything that is true regardless of which harness wrote the entry.
 * Operates only on the normalized AssistantTurn / ParsedBlock vocabulary.
 */
function buildInteraction(
	turn: import("./harness/types.ts").AssistantTurn,
	adapter: import("./harness/types.ts").HarnessParseAdapter,
	thinkingLevel?: string,
	compactionTokensBefore?: number,
	afterCompaction?: boolean,
	currentModel?: string
): Interaction {
	const usage = turn.usage;

	// Resolve effective model: harnesses that track the model via model_change
	// events rather than per message (Pi, #128) leave turn.model undefined and
	// the tracked currentModel fills in. A per-message model always wins.
	const effectiveModel = turn.model || currentModel || "";

	// Parse timestamp first — used below for DeepSeek peak pricing
	let timestamp = 0;
	if (typeof turn.timestamp === "string") {
		timestamp = new Date(turn.timestamp).getTime();
	} else if (typeof turn.timestamp === "number") {
		timestamp = turn.timestamp;
	}

	const hasTokens =
		usage.input_tokens > 0 ||
		usage.output_tokens > 0 ||
		usage.cache_read_input_tokens > 0 ||
		usage.cache_creation_input_tokens > 0 ||
		usage.reasoning_tokens > 0;

	// Prefer a harness-native per-turn cost, but fall through to manual
	// calculation when it is 0 while tokens were actually consumed (e.g. DeepSeek
	// pricing not yet supported by Pi's internal cost tracker).
	let cost = 0;
	const nativeCost = usage.nativeCost;
	if (nativeCost !== null && !(nativeCost === 0 && hasTokens)) {
		cost = nativeCost;
	} else if (effectiveModel && hasTokens) {
		cost = calculateClaudeCost(effectiveModel, {
			input_tokens: usage.input_tokens,
			output_tokens: usage.output_tokens,
			cache_creation_input_tokens: usage.cache_creation_input_tokens,
			cache_read_input_tokens: usage.cache_read_input_tokens,
			cache_creation: usage.cache_creation,
			reasoning_tokens: usage.reasoning_tokens,
		}, timestamp);
	}

	// Observed cache TTL class (#95): the transcript records which ephemeral
	// tier cache writes actually used — authoritative over any model-name guess.
	const cacheCreation = usage.cache_creation || {};
	const cacheTtl: "1h" | "5m" | undefined =
		(cacheCreation.ephemeral_1h_input_tokens || 0) > 0 ? "1h"
		: (cacheCreation.ephemeral_5m_input_tokens || 0) > 0 ? "5m"
		: undefined;

	// Observed cache miss (#152): the whole prefix was re-primed rather than read.
	// Decided HERE, against normalized usage, not later against the tag file — the
	// compaction/recache meter-split (#52 Phase 3) rewrites cr and cw across two
	// lines, so by tag-read time neither line can be told apart from a partial
	// re-prime. This is the only point where the original pair is still intact.
	const cacheMiss =
		usage.cache_read_input_tokens === 0 && usage.cache_creation_input_tokens > 0
			? true : undefined;

	// Server-side tool requests: per-request billed, separate meter from tokens.
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

	for (const rawBlock of turn.content) {
		const block = adapter.readBlock(rawBlock);
		if (!block) continue;
		if (block.kind === "text") {
			texts.push(block.text);
			continue;
		}
		// Tool block: the adapter mapped its own argument names to files and
		// commands; the shared side owns what those mean.
		if (block.files.length > 0) files.push(...block.files);
		for (const command of block.commands) {
			commands.push(command);
			extractFilesFromBashCommand(command, files);
		}
		if (!block.handled && !mapToolToCategory(block.name, toolCats)) {
			unrecognizedTool = true;
		}
	}

	return { timestamp, cost, messageId: turn.messageId, requestId: turn.requestId,
		model: effectiveModel || undefined,
		inputTokens: usage.input_tokens,
		outputTokens: usage.output_tokens,
		cacheReadTokens: usage.cache_read_input_tokens,
		cacheWriteTokens: usage.cache_creation_input_tokens,
		reasoningTokens: usage.reasoning_tokens,
		webSearchRequests: (serverToolRequests.web_search_requests || 0) as number,
		webFetchRequests: (serverToolRequests.web_fetch_requests || 0) as number,
		serverToolCost,
		surgePriced,
		thinkingLevel,
		compactionTokensBefore,
		cacheTtl,
		cacheMiss,
		afterCompaction: (afterCompaction || compactionTokensBefore !== undefined) || undefined,
		cacheWrite1hTokens: (cacheCreation.ephemeral_1h_input_tokens || 0) > 0
			? cacheCreation.ephemeral_1h_input_tokens : undefined,
		iterations: usage.iterations,
		isSidechain: turn.isSidechain || undefined,
		files, commands, texts,
		toolCats: toolCats.size > 0 ? [...toolCats] : undefined,
		unrecognizedTool: unrecognizedTool || undefined };
}

// ---
// HARNESS-OVERHEAD DETECTION (#52 Phase 3)
// ---

/** Both marker spellings: "[Request interrupted by user]" and
 *  "[Request interrupted by user for tool use]". */
export const INTERRUPT_PREFIX = "[Request interrupted by user";

/** True when a transcript entry is a user interrupt marker — stamps the
 *  PRECEDING assistant interaction as interrupted (whole cost = waste).
 *  Recognition now lives behind the harness seam (#156); this stays exported
 *  because the daemon and tests call it directly. */
export function isInterruptMarker(entry: any): boolean {
	return readControlEntry(entry)?.kind === "interrupt";
}

/**
 * Recognize a stream-control entry — a non-assistant line that changes how
 * following turns are read (model changes, thinking level, compaction markers,
 * interrupts).
 *
 * Every registered adapter is consulted, not just the one whose assistant
 * schema matched: control markers are not mutually exclusive across harnesses,
 * and the pre-seam code applied all of them to every transcript. Preserving
 * that is what makes the seam a refactor rather than a behaviour change.
 */
export function readControlEntry(entry: any): ControlSignal | null {
	if (!entry) return null;
	for (const adapter of getParseAdapters()) {
		const signal = adapter.readControlEntry(entry);
		if (signal) return signal;
	}
	return null;
}

/** Mutable per-file state threaded through a sequential transcript read. */
export interface ParseStreamState {
	thinkingLevel?: string;
	model?: string;
	compactionTokensBefore?: number;
	afterCompaction: boolean;
}

/** A fresh stream state — one per transcript read. */
export function newParseStreamState(): ParseStreamState {
	return { afterCompaction: false };
}

/**
 * Apply a control signal to the running stream state.
 * Returns true when the entry was a control entry and must not be parsed as an
 * assistant turn. `onInterrupt` stamps the preceding interaction, which the
 * caller owns (the file reader has a list; the daemon has a pending queue).
 */
export function applyControlEntry(
	entry: any,
	state: ParseStreamState,
	onInterrupt: () => void
): boolean {
	const signal = readControlEntry(entry);
	if (!signal) return false;
	switch (signal.kind) {
		case "thinking-level": state.thinkingLevel = signal.level; break;
		case "model": state.model = signal.modelId; break;
		case "compaction": state.compactionTokensBefore = signal.tokensBefore; break;
		case "after-compaction": state.afterCompaction = true; break;
		case "interrupt": onInterrupt(); break;
	}
	return true;
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

// SHARED FILE PARSER (#54 DRY refactor)
// Single source of truth for reading a .jsonl session file into Interaction[]
// (raw, undeduped). Consumers (session selector, CLI chart, Pi TUI) read lines
// differently (File I/O vs ctx.sessionManager), but the parseEntryToInteraction
// call and subsequent dedup are identical — those live here.

export function parseSessionFile(filePath: string): Interaction[] {
	const interactions: Interaction[] = [];
	const state = newParseStreamState();
	try {
		const content = fs.readFileSync(filePath, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				// Stream-control entries (thinking level #77, model_change #128,
				// compaction #90, compact summary + interrupt #52 Phase 3) are
				// recognized per harness and applied here.
				const isControl = applyControlEntry(entry, state, () => {
					if (interactions.length > 0) interactions[interactions.length - 1].interrupted = true;
				});
				if (isControl) continue;

				const interaction = parseEntryToInteraction(entry, state.thinkingLevel, state.compactionTokensBefore, state.afterCompaction, state.model);
				if (interaction) {
					interactions.push(interaction);
					state.compactionTokensBefore = undefined; // consumed by this interaction
					state.afterCompaction = false;
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

// ---
// UNCOUNTED BILLABLES (#149) — naming the blind spot instead of estimating it
//
// Measured over seven status-line-logged sessions: 4.72% of Claude Code's own
// `total_cost_usd` ($6.49 of $137.71) is spend the transcript records no `usage`
// for. It is not an arithmetic error — #146's per-turn formula reproduces Claude
// Code's counter to 4 decimal places — it is SCOPE. Two of the generating events
// do leave a marker entry behind, so wtft can count them even though it can
// never price them: `/compact` ($0.673267 measured on one Opus-5 compaction) and
// the away-recap (1:1 with an unexplained cost step on every logged session).
//
// This deliberately returns COUNTS and no dollars. wtft's TOTAL stays strictly
// derived from recorded usage — every dollar traceable to a `usage` object — and
// the omission becomes visible rather than silent. See
// docs/spec-149-compaction-cost-scope.md §5 for the roads not taken.
// ---

export interface UncountedBillables {
	/** `/compact` requests: billed, and no `usage` is written for them. */
	compaction: number;
	/** "While you were away" recaps: billed, and no `usage` is written for them. */
	recap: number;
}

export function newUncountedBillables(): UncountedBillables {
	return { compaction: 0, recap: 0 };
}

export function addUncountedBillables(a: UncountedBillables, b: UncountedBillables): UncountedBillables {
	return { compaction: a.compaction + b.compaction, recap: a.recap + b.recap };
}

/** First harness to claim the entry wins — an entry belongs to one schema, and
 *  summing across adapters would double-count a marker two harnesses both
 *  happen to recognize. */
export function readUncountedBillableClass(entry: any): UncountedBillableClass | null {
	for (const adapter of getParseAdapters()) {
		const hit = adapter.readUncountedBillable?.(entry);
		if (hit) return hit;
	}
	return null;
}

/**
 * Count the billed-but-unrecorded events in one session file.
 *
 * A standalone scan rather than a field on `Interaction` or a wider
 * `parseSessionFile` return type: these events attach to no interaction — that
 * is precisely what makes them invisible — and `parseSessionFile`'s signature is
 * load-bearing for the daemon tag file, watch mode and 40-odd suites.
 */
export function scanUncountedBillables(filePath: string): UncountedBillables {
	const counts = newUncountedBillables();
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return counts; // missing/unreadable file reports no blind spot, never throws
	}
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		const kind = readUncountedBillableClass(entry);
		if (kind) counts[kind]++;
	}
	return counts;
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

// COMMAND NORMALIZATION (#63)
// Strips cd /path prefixes and VAR=value assignments from chained bash commands
// so that 'cd /foo && git push' classifies as 'git', not 'other'.
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
					// Recurse into ALL subdirectories (#141) — the agent-*.jsonl
					// file filter gates what gets collected, so directory names
					// need no allowlist. This picks up Dynamic Workflow layouts
					// (subagents/workflows/wf_<runId>/agent-*.jsonl) and
					// future-proofs against the next harness layout change.
					// Depth still counts only "subagents"/"ns" containers, so
					// maxDepth keeps bounding NESTING depth (Claude Code limit),
					// not raw directory depth. "wtft-tags" is our own output —
					// its agent-*.jsonl.wtft-tag.v*.jsonl files would match the
					// file filter and double-count.
					if (f !== "wtft-tags") {
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

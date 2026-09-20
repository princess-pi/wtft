/**
 * Session log parsing and interaction classification.
 *
 * Extracts token usage and cost per assistant message, and classifies
 * interactions into categories. `scanUncountedBillables` counts billed API
 * calls that have no `usage` object — counted, never priced, so TOTAL stays
 * derived from recorded usage. Schema knowledge lives behind the harness
 * seam; this file operates on the neutral vocabulary alone.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { calculateClaudeCost, calculateServerToolCost, getDeepSeekPeakMultiplier } from "./wtft-cost.js";
import { getParseAdapters } from "./harness/registry.ts";
import { projectsDir } from "./harness/claude-code/discovery.ts";
import { cwdSlugVariants } from "./harness/session-cwd.ts";
import { extractCommandSegments, extractJoinedSegments, extractRealCommands, splitCommandWords, stripCommandPrefixes } from "./wtft-command-shapes.js";
import type { ControlSignal, UncountedBillableClass } from "./harness/types.ts";

// ---
// TYPES
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
	/** Observed prompt-cache TTL class from usage.cache_creation — beats the model-name guess. */
	cacheTtl?: "1h" | "5m";
	/** Whole prefix re-primed instead of read (cache_read 0, cache_creation > 0).
	 *  Set from raw usage at parse time; the meter-split otherwise destroys the signal. */
	cacheMiss?: boolean;
	/** Turn killed by the user — whole cost is discarded work. */
	interrupted?: boolean;
	/** Turn immediately follows a compact summary — its cache_write is the compaction bill. */
	afterCompaction?: boolean;
	/** 1h-tier share of cacheWriteTokens; recache-signature input. */
	cacheWrite1hTokens?: number;
	/** usage.iterations length when present; recache-signature guard. */
	iterations?: number;
	/** Subagent sidechain entry — excluded from prevCtx recache tracking. */
	isSidechain?: boolean;
	files: { path: string; action: "read" | "write" }[];
	commands: string[];
	texts: string[];
	/** Categories implied by recognized non-file tools (Task→agents, WebSearch→web, …). */
	toolCats?: Category[];
	/** Unmodeled tool_use — classifies "other", never "prompt". */
	unrecognizedTool?: boolean;
	/** Pre-classified category from the daemon tag file — short-circuits classifyInteraction. */
	_cat?: Category;
	/** Timestamp falls within DeepSeek surge-pricing hours. Serialized to tag file as `sp`. */
	surgePriced?: boolean;
}

// ---
// TOOL → CATEGORY MAP — non-file tools that earn a category directly.
// Unmapped tools fell into "prompt"/"other", so a spawn turn was billed as
// conversation. Names are lowercased. Harness spellings live here (meaning),
// not in adapters (schema).
// ---
const TOOL_CATEGORY_MAP: Record<string, Category> = {
	// Subagent orchestration, including tools that manage a spawned agent
	task: "agents", agent: "agents", workflow: "agents",
	taskoutput: "agents", taskstop: "agents", sendmessage: "agents",
	listagents: "agents", monitor: "agents",
	// Server-side web tools — token side joins the request-cost side
	websearch: "web", webfetch: "web",
	search_web: "web", web_search: "web", fetch_url: "web",
	// Worktree navigation is repo workflow
	enterworktree: "git", exitworktree: "git",
	grep: "grep", glob: "grep", find: "grep", search_files: "grep",
	// Planning/steering — split out of "prompt" so prompt = pure reply
	todowrite: "plan", todo_write: "plan", taskcreate: "plan", taskupdate: "plan",
	taskget: "plan", tasklist: "plan", askuserquestion: "plan", ask: "plan",
	enterplanmode: "plan", exitplanmode: "plan", skill: "plan", toolsearch: "plan",
	sendfeedback: "plan",
};

/** Pure navigation/bookkeeping: real calls, but not work — neither "other" nor poison `prompt`. */
const TOOL_NOOP = new Set(["change_working_directory", "cd", "pwd", "lsdir", "listmcpresourcestool"]);

/**
 * MCP tools arrive as `mcp__<server>__<tool>`; only the search/fetch family is
 * mapped. Anything else returns null — unknown, not conversation.
 */
function mapMcpToolToCategory(name: string): Category | null {
	if (!name.startsWith("mcp__")) return null;
	const tool = name.slice(name.indexOf("__", 5) + 2);
	if (/(?:^|_)(?:web_)?(?:search|fetch|browse|crawl)(?:_|$)/.test(tool)) return "web";
	return null;
}

/** Route one non-file tool call into toolCats / unrecognizedTool flags. */
function mapToolToCategory(name: string, toolCats: Set<Category>): boolean {
	const cat = TOOL_CATEGORY_MAP[name] || mapMcpToolToCategory(name);
	if (cat) {
		toolCats.add(cat);
		return true;
	}
	// Navigation is "handled" with no category: neither work nor disqualified from pure reply.
	if (TOOL_NOOP.has(name)) return true;
	return false;
}

/** Record every file a bash command touches so shell reads/edits classify as the work they did. */
function extractFilesFromBashCommand(command: string, files: { path: string; action: "read" | "write" }[]) {
	for (const real of extractRealCommands(command)) collectFilesFromShellCommand(real, files);
}

export function parseEntryToInteraction(entry: any, thinkingLevel?: string, compactionTokensBefore?: number, afterCompaction?: boolean, currentModel?: string): Interaction | null {
	if (!entry) return null;

	// First harness that recognizes this entry owns it.
	let turn = null;
	for (const adapter of getParseAdapters()) {
		turn = adapter.matchAssistant(entry);
		if (turn) {
			return buildInteraction(turn, adapter, thinkingLevel, compactionTokensBefore, afterCompaction, currentModel);
		}
	}

	return null;
}

/** Shared path over normalized AssistantTurn / ParsedBlock vocabulary. */
function buildInteraction(
	turn: import("./harness/types.ts").AssistantTurn,
	adapter: import("./harness/types.ts").HarnessParseAdapter,
	thinkingLevel?: string,
	compactionTokensBefore?: number,
	afterCompaction?: boolean,
	currentModel?: string
): Interaction {
	const usage = turn.usage;

	// Per-message model wins; otherwise fill from model_change tracking (Pi).
	const effectiveModel = turn.model || currentModel || "";

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

	// Prefer harness-native cost; fall through when it is 0 while tokens were consumed.
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

	// Observed cache TTL — authoritative over any model-name guess.
	const cacheCreation = usage.cache_creation || {};
	const cacheTtl: "1h" | "5m" | undefined =
		(cacheCreation.ephemeral_1h_input_tokens || 0) > 0 ? "1h"
		: (cacheCreation.ephemeral_5m_input_tokens || 0) > 0 ? "5m"
		: undefined;

	// Cache miss decided HERE against normalized usage: the meter-split rewrites
	// cr/cw across two lines, so by tag-read time the original pair is gone.
	// Parent-only: a sidechain starts empty, so read-0/write-everything is how it
	// begins, not something it lost.
	const cacheMiss =
		!turn.isSidechain &&
		usage.cache_read_input_tokens === 0 && usage.cache_creation_input_tokens > 0
			? true : undefined;

	const serverToolRequests = usage.server_tool_use || {};
	const serverToolCost = calculateServerToolCost(
		effectiveModel,
		serverToolRequests.web_search_requests || 0,
		serverToolRequests.web_fetch_requests || 0
	);

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
// HARNESS-OVERHEAD DETECTION
// ---

/** Both marker spellings: plain interrupt and "for tool use". */
export const INTERRUPT_PREFIX = "[Request interrupted by user";

/** User interrupt marker — stamps the PRECEDING assistant turn as interrupted. */
export function isInterruptMarker(entry: any): boolean {
	return readControlEntry(entry)?.kind === "interrupt";
}

/**
 * Recognize a stream-control entry (model change, thinking level, compaction,
 * interrupt). Every registered adapter is consulted — control markers are not
 * mutually exclusive across harnesses.
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

export function newParseStreamState(): ParseStreamState {
	return { afterCompaction: false };
}

/**
 * Apply a control signal to stream state. Returns true when the entry must not
 * be parsed as an assistant turn. `onInterrupt` stamps the preceding interaction.
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
 * Slice of this interaction's cost that is context maintenance rather than work.
 *
 *  - compaction: post-compact-summary turn's cache_write $ → "compaction"
 *  - overhead (recache): whole-context rewrite into the 1h cache tier → "overhead"
 *
 * Dollar component is the rate-weighted cache_write share (conserves totals;
 * only meter ratios matter, so Pi-native costs work too).
 *
 * @param prevCtxTokens input+cacheRead+cacheWrite of the previous non-sidechain
 *   deduped interaction (0 = unknown → no recache detection)
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

	// cache_write $ share: full cost minus the same usage with writes removed.
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

// ---
// SHARED FILE PARSER
// Read a .jsonl session into Interaction[] (raw, undeduped).
// ---

export function parseSessionFile(filePath: string): Interaction[] {
	const interactions: Interaction[] = [];
	const state = newParseStreamState();
	// Unreadable transcript throws (never returns [] as "empty"). Per-line
	// errors stay swallowed — bad line, not file-level failure.
	const content = fs.readFileSync(filePath, "utf8");
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
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

	// Attribute `claude -p` sub-agent costs so callers get complete data.
	attributeClaudeSubAgentCosts(interactions);

	return interactions;
}

// ---
// UNCOUNTED BILLABLES — billed events with no `usage` object
//
// Returns COUNTS, never dollars. TOTAL stays derived from recorded usage;
// the omission becomes visible rather than silent.
// ---

export interface UncountedBillables {
	/** `/compact` requests: billed, no `usage` written. */
	compaction: number;
	/** "While you were away" recaps: billed, no `usage` written. */
	recap: number;
}

export function newUncountedBillables(): UncountedBillables {
	return { compaction: 0, recap: 0 };
}

export function addUncountedBillables(a: UncountedBillables, b: UncountedBillables): UncountedBillables {
	return { compaction: a.compaction + b.compaction, recap: a.recap + b.recap };
}

/** First harness to claim the entry wins — summing would double-count. */
export function readUncountedBillableClass(entry: any): UncountedBillableClass | null {
	for (const adapter of getParseAdapters()) {
		const hit = adapter.readUncountedBillable?.(entry);
		if (hit) return hit;
	}
	return null;
}

/**
 * Count billed-but-unrecorded events in one session file.
 * Standalone scan: these events attach to no interaction, and
 * `parseSessionFile`'s signature is load-bearing elsewhere.
 */
export function scanUncountedBillables(filePath: string): UncountedBillables {
	return scanUncountedBillablesChecked(filePath).counts;
}

/**
 * Same scan, plus whether the file could be read. `readable: false` is distinct
 * from "read, found nothing" — zero counts alone would look complete.
 */
export function scanUncountedBillablesChecked(filePath: string): { counts: UncountedBillables; readable: boolean } {
	const counts = newUncountedBillables();
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return { counts, readable: false }; // never throws; the caller decides what unreadable means
	}
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		const kind = readUncountedBillableClass(entry);
		if (kind) counts[kind]++;
	}
	return { counts, readable: true };
}


/**
 * Which harness wrote this session?
 *
 * Same adapter dispatch as `parseEntryToInteraction`, but picks the first
 * adapter that claims the earliest claimable entry (not one arbitrary entry).
 * Returns null for "no claim" — empty, unreadable, or unknown format.
 */
export function detectSessionHarness(filePath: string): string | null {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return null; // missing or unreadable — no claim to make, never throws
	}
	const adapters = getParseAdapters();
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		for (const adapter of adapters) {
			if (adapter.matchAssistant(entry)) return adapter.id;
		}
	}
	return null;
}

// ---
// MESSAGE-ID DEDUPLICATION
// Multiple JSONL lines per API response echo the same message-level `usage`.
// Dedup by message.id: keep max-cost copy, merge content for classification.
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
			// Max cost (streaming partials), merge content for classification
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
				// Overhead flags: any copy carrying them marks the whole message.
				if (i.interrupted) merged.interrupted = true;
				if (i.afterCompaction) merged.afterCompaction = true;
				if (i.surgePriced) merged.surgePriced = true;
				// Clear cacheMiss when any copy is sidechain. Do NOT widen
				// `isSidechain` itself — it gates recache detection and prevCtx.
				if (i.isSidechain) merged.cacheMiss = undefined;
			}
			if (mergedToolCats.size > 0) merged.toolCats = [...mergedToolCats];
			deduped.push(merged);
		}
	}

	return deduped;
}

// ---
// COMMAND NORMALIZATION
// Primary command of a bash string — first non-navigation/assignment/wrapper.
// Empty when the string runs no such command. Returns the primary alone;
// callers that need every real command use `extractRealCommands`.
// ---
export function normalizeCommand(cmd: string): string {
	return extractRealCommands(cmd)[0] || "";
}

// ---
// BASH COMMAND -> CATEGORY
// Families of shell commands that ARE a category, so shell work is not "other".
// ---

/** Spawning another agent. Excludes `.claude/` paths and `CLAUDE.md`. */
const CLAUDE_SPAWN = /(?:^|\s)claude(?:\s+-|\s*\||\s*$)/;

/**
 * Does this bash command string spawn an agent?
 * THE one predicate — reads each real command's HEAD so heredoc text is not a spawn.
 */
export function commandSpawnsAgent(cmd: string): boolean {
	return extractRealCommands(cmd).some(real => CLAUDE_SPAWN.test(real.split("\n", 1)[0]!.toLowerCase()));
}

/**
 * Version-control / repo-workflow work. All of `gh` lands here by default;
 * GH_SPEC / GH_SEARCH carve out before this is tested.
 */
const GIT_COMMAND = /^(?:git|gh|tig|hub|glab|pr-(?:open|submit|ready|watch|threads|cleanup|merge|reject|review|verdict|guard)|git-(?:checkpoint|overview|snap)|wt-new|iarts-mirror|repo-gate)(?:\s|$)/;

/**
 * `gh issue` subcommands that touch issue content — that is spec work.
 * `list` and `close` stay `git`: navigation / workflow, not content.
 */
const GH_SPEC = /^gh\s+issue\s+(?:view|comment|create|edit|reopen|develop)(?:\s|$)/;

/** `gh` search family — GraphQL query and `gh search`. */
const GH_SEARCH = /^gh\s+(?:api\s+graphql|search)(?:\s|$)/;

/** Running a test suite. `bun test x` is tests; `bun build.ts` is not. */
const TEST_RUNNER = /^(?:(?:bun|npm|pnpm|yarn|deno)\s+(?:run\s+)?test\b|(?:bun|npx)\s+\S*tests?\/|(?:pytest|jest|vitest|mocha|ava|tap|cypress|playwright|ctest)\b|(?:go|cargo)\s+test\b|(?:bash|sh|zsh)\s+\S*tests?\/|\.?\/?tests?\/\S+\.(?:sh|ts|js|mjs|py)\b)/;

/** Building, typechecking or linting — a code activity, not "other". */
const BUILD_COMMAND = /^(?:(?:bun|npm|pnpm|yarn|deno)\s+run\s+(?:build|typecheck|lint|check|compile|bundle)\b|bun\s+build\S*|(?:tsc|esbuild|webpack|vite|rollup|make|cmake|ninja|gcc|g\+\+|clang|eslint|prettier|ruff|black|clippy|shellcheck)\b|(?:go|cargo)\s+(?:build|install)\b)/;

// ---
// SHELL FILE TOUCHES
// Bash read/write is the same work as Read/Edit — same path rules.
// ---

/**
 * Commands whose non-flag arguments are file paths being READ.
 * Excludes metadata commands (`stat`, `file`, `shasum`) — they name a path
 * without reading content.
 */
const FILE_READER = /^(?:sed|cat|head|tail|less|more|bat|nl|od|xxd|strings|wc|awk|cut|diff|jq|yq|pdftotext)(?:\s|$)/;

/**
 * Commands whose FIRST non-flag argument is a program, not a path
 * (`sed -n '…' file` — the script is not a second path).
 */
const PROGRAM_FIRST_ARG = /^(?:sed|awk|gawk|nawk|perl|jq|yq)(?:\s|$)/;

/** A bare number is an argument value (`tail -n 50`), never a path. */
const NUMERIC = /^\d+$/;

/**
 * Absolute paths that are real files but not repository work.
 * `classifyByFilePaths` grades by extension/dir and cannot tell a repo from
 * scratch — without this, `/dev/null` and `/tmp/*.txt` grade as `code`.
 */
const NOT_A_REPO_FILE = /^\/(?:dev|proc|sys|run|tmp|etc|var|boot|lib|sbin|opt)(?:\/|$)/;

/** Readers that are writing when the flag says so (`sed -i`). */
const IN_PLACE_EDIT = /^(?:sed\s+(?:-\S*\s+)*(?:-i\S*|--in-place(?:=\S+)?)|perl\s+(?:-\S+\s+)*-i\S*|tee)(?:\s|$)/;

/** Interpreters running an inline script rather than a file. */
const INLINE_SCRIPT = /^(?:python3?|node|bun|deno|perl|ruby|php|osascript)\s+(?:-\s*(?:$|<)|-\s|-c(?:\s|$)|-e(?:\s|$))/;

/**
 * Token that plausibly names a file. Permissive on extension, strict on
 * shell metacharacters (unexpanded globs must not enter the file list).
 */
const PATHLIKE = /^(?:~|\.\.?)?\/?[A-Za-z0-9_.@+][A-Za-z0-9_.@+/-]*$/;

/** Split one command into its argument words, quotes respected. */
function shellWords(cmd: string): string[] {
	const out: string[] = [];
	const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
	return out;
}

/**
 * Record every file a single real command touches, as read or write.
 * Conservative: unidentified paths contribute nothing; over-claiming is worse
 * than leaving spend in `other`.
 */
function collectFilesFromShellCommand(cmd: string, files: { path: string; action: "read" | "write" }[]): void {
	// Inline script: paths are string literals inside the body.
	if (INLINE_SCRIPT.test(cmd)) {
		const writes = /\b(?:open\s*\(\s*["']([^"']+)["']\s*,\s*["'][wa]|writeFileSync\s*\(\s*["']([^"']+)["']|write_text\s*\(|Path\s*\(\s*["']([^"']+)["']\s*\)\s*\.write)/g;
		const reads = /\b(?:open\s*\(\s*["']([^"']+)["']|readFileSync\s*\(\s*["']([^"']+)["']|read_text\s*\(|loadtxt\s*\(\s*["']([^"']+)["'])/g;
		let m: RegExpExecArray | null;
		const seen = new Set<string>();
		// NOT_A_REPO_FILE on every route, including heredoc bodies.
		while ((m = writes.exec(cmd)) !== null) {
			const p = m[1] || m[2] || m[3];
			if (p && !NOT_A_REPO_FILE.test(p) && PATHLIKE.test(p)) { files.push({ path: p, action: "write" }); seen.add(p); }
		}
		while ((m = reads.exec(cmd)) !== null) {
			const p = m[1] || m[2] || m[3];
			if (p && !seen.has(p) && !NOT_A_REPO_FILE.test(p) && PATHLIKE.test(p)) files.push({ path: p, action: "read" });
		}
		return;
	}

	// Only the command's own line carries its arguments — heredoc body is data.
	// splitCommandWords is quote-aware (`>` inside quotes is not a redirection).
	const { words, writes, reads } = splitCommandWords(cmd);

	// Redirection into a path is a write (`cat > bin/x.ts <<'EOF'`).
	const written = new Set<string>();
	for (const p of writes) {
		if (!p || NOT_A_REPO_FILE.test(p) || !PATHLIKE.test(p)) continue;
		files.push({ path: p, action: "write" });
		written.add(p);
	}

	const isEdit = IN_PLACE_EDIT.test(cmd);
	if (!FILE_READER.test(cmd) && !isEdit) return;

	// Input redirection is a READ, never a write.
	for (const p of reads) {
		if (!p || written.has(p) || NOT_A_REPO_FILE.test(p) || !PATHLIKE.test(p)) continue;
		files.push({ path: p, action: "read" });
	}

	// sed/awk take a program as their first non-flag argument; it is not a path.
	let skipProgram = PROGRAM_FIRST_ARG.test(cmd);
	for (const w of words.slice(1)) {
		if (w.startsWith("-")) continue;
		if (skipProgram) { skipProgram = false; continue; }
		if (NUMERIC.test(w)) continue;
		if (written.has(w)) continue;
		if (NOT_A_REPO_FILE.test(w)) continue;
		if (!PATHLIKE.test(w)) continue;
		files.push({ path: w, action: isEdit ? "write" : "read" });
	}
}

// ---
// PATH -> CATEGORY
// Single place a file path becomes a category — bash and Read/Edit share it.
// ---
function classifyByFilePaths(files: { path: string; action: "read" | "write" }[]): Category | null {
	const specPaths = new Set<string>();
	const codePaths = new Set<string>();
	const testsPaths = new Set<string>();
	const researchPaths = new Set<string>();
	const planPaths = new Set<string>();

	for (const f of files) {
		const norm = f.path.replace(/\\/g, "/");
		let category: "spec" | "code" | "tests" | "research" | "plan" | null = null;

		if (norm.includes("node_modules/")) {
			// Third-party docs/READMEs are reference material
			if (path.extname(norm).toLowerCase() === ".md" || norm.includes("/docs/")) {
				category = "research";
			} else {
				category = "code";
			}
		} else if (norm.startsWith("docs/research/") || norm.includes("/docs/research/")) {
			// Explorations are thinking artifacts, not normative specs — before docs/ → spec
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
				// Extensionless wrappers (wtft, serve, merge) are code
				category = "code";
			}
		}

		if (category === "spec") specPaths.add(f.action);
		else if (category === "code") codePaths.add(f.action);
		else if (category === "tests") testsPaths.add(f.action);
		else if (category === "research") researchPaths.add(f.action);
		else if (category === "plan") planPaths.add(f.action);
	}

	// Latest-workflow-stage wins; writes beat reads.
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

	return null;
}

export function classifyInteraction(interaction: Interaction): Category {
	// Tag-file short-circuit — texts are not serialized, so re-classify would fail "prompt".
	if (interaction._cat) return interaction._cat;

	// Interrupted wins whole-message (discarded work). Meter-splits run before this.
	if (interaction.interrupted) return "interrupted";

	const viaToolFiles = classifyByFilePaths(interaction.files);
	if (viaToolFiles) return viaToolFiles;

	// Tool-implied: agents > web > git > plan > grep. Below file ops, above bash.
	if (interaction.toolCats && interaction.toolCats.length > 0) {
		for (const cat of ["agents", "web", "git", "plan", "grep"] as Category[]) {
			if (interaction.toolCats.includes(cat)) return cat;
		}
	}

	if (interaction.commands.length > 0) {
		// Every real command, not just the first.
		const real = interaction.commands.flatMap(cmd => extractRealCommands(cmd));

		let isGit = false;
		let isGrep = false;
		let isAgents = false;
		let isTests = false;
		let isCode = false;
		let isSpec = false;
		for (const normalized of real) {
			// Lowercased HEAD only — not the heredoc body.
			const lower = normalized.split("\n", 1)[0]!.toLowerCase();
			if (CLAUDE_SPAWN.test(lower)) isAgents = true;
			// GH carve-outs before GIT_COMMAND (which also matches `gh`).
			else if (GH_SPEC.test(lower)) isSpec = true;
			else if (GH_SEARCH.test(lower)) isGrep = true;
			else if (GIT_COMMAND.test(lower)) isGit = true;
			else if (TEST_RUNNER.test(lower)) isTests = true;
			else if (BUILD_COMMAND.test(lower)) isCode = true;
			else if (/^(?:grep|rg|ripgrep|find|fd|ag|ack)(?:\s|$)/.test(lower)) isGrep = true;
		}
		// Priority: spawn > spec (more specific than git) > git > tests/code > grep.
		if (isAgents) return "agents";
		if (isSpec) return "spec";
		if (isGit) return "git";
		if (isTests) return "tests";
		if (isCode) return "code";
		if (isGrep) return "grep";
		// Empty real = navigation/assignment only — fall through to prompt rule.
		if (real.length > 0) return "other";
	}

	// "prompt" means pure reply — an unmodeled tool is not conversation.
	if (interaction.texts.length > 0 && !interaction.unrecognizedTool) return "prompt";
	return "other";
}

// ---
// SUBAGENT SESSION DISCOVERY
// Claude Code: agent-*.jsonl under <session-dir>/<session-name>/subagents/.
// Pi: sibling .jsonl with parentSession header matching parent session ID.
// ---

/**
 * What the harness writes beside every built-in (Task) subagent transcript.
 * `agentType` and `spawnDepth` are required; everything else is optional
 * (Dynamic Workflow children under `subagents/workflows/` carry neither
 * `description` nor `toolUseId`).
 */
export interface SubagentMeta {
	agentType: string;
	spawnDepth: number;
	/** Absent on Dynamic Workflow children. */
	description?: string;
	/** Absent on Dynamic Workflow children. */
	toolUseId?: string;
	model?: string;
	parentAgentId?: string;
	isFork?: boolean;
}

/**
 * The `.meta.json` beside a subagent transcript, or `null`.
 * Never throws, never partially succeeds — undocumented harness output; a
 * missing required field is `null` rather than a half-filled record.
 * Call {@link readSubagentMetaChecked} to distinguish unreadable from absent.
 */
export function readSubagentMeta(transcriptPath: string): SubagentMeta | null {
	return readSubagentMetaChecked(transcriptPath).meta;
}

/** {@link readSubagentMeta}, plus the error when the meta exists but could not be read.
 *  `error` is null for absent (ENOENT/ENOTDIR) and for parse failure — only read failure. */
export function readSubagentMetaChecked(transcriptPath: string): { meta: SubagentMeta | null; error: Error | null; metaPath: string | null } {
	if (!transcriptPath.endsWith(".jsonl")) return { meta: null, error: null, metaPath: null };
	const metaPath = transcriptPath.slice(0, -".jsonl".length) + ".meta.json";
	let raw: string;
	try {
		raw = fs.readFileSync(metaPath, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		const absent = code === "ENOENT" || code === "ENOTDIR";
		return { meta: null, error: absent ? null : (err instanceof Error ? err : new Error(String(err))), metaPath };
	}
	return { meta: parseSubagentMeta(raw), error: null, metaPath };
}

function parseSubagentMeta(raw: string): SubagentMeta | null {
	let obj: unknown;
	try {
		obj = JSON.parse(raw);
	} catch {
		return null;
	}
	if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
	const o = obj as Record<string, unknown>;

	// Two required fields, typed — `spawnDepth: "1"` is not a depth.
	if (typeof o.agentType !== "string") return null;
	if (typeof o.spawnDepth !== "number" || !Number.isFinite(o.spawnDepth)) return null;

	const meta: SubagentMeta = {
		agentType: o.agentType,
		spawnDepth: o.spawnDepth,
	};
	if (typeof o.description === "string") meta.description = o.description;
	if (typeof o.toolUseId === "string") meta.toolUseId = o.toolUseId;
	if (typeof o.model === "string") meta.model = o.model;
	if (typeof o.parentAgentId === "string") meta.parentAgentId = o.parentAgentId;
	if (typeof o.isFork === "boolean") meta.isFork = o.isFork;
	return meta;
}

/** First `count` lines of `file` without reading the rest. Throws on read failure. */
function readHeadLines(file: string, count: number): string[] {
	const fd = fs.openSync(file, "r");
	try {
		const chunk = Buffer.alloc(64 * 1024);
		const parts: Buffer[] = [];
		let total = 0;
		let newlines = 0;
		while (newlines < count) {
			const n = fs.readSync(fd, chunk, 0, chunk.length, total);
			if (n === 0) break;
			const got = chunk.subarray(0, n);
			for (let i = got.indexOf(0x0a); i !== -1 && newlines < count; i = got.indexOf(0x0a, i + 1)) newlines++;
			parts.push(Buffer.from(got));
			total += n;
		}
		return Buffer.concat(parts).toString("utf8").split("\n").slice(0, count);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Discover subagent session files for a parent session.
 *
 * Pattern 1 (Claude Code): <session-dir>/<session-name>/subagents/agent-*.jsonl
 * Pattern 2 (Pi): sibling files with parentSession header match
 */
export function discoverSubagentSessionFiles(
	sessionPath: string,
): { files: string[]; unreadable: Error | null } {
	const files: string[] = [];
	const sessionDir = path.dirname(sessionPath);
	const sessionBase = path.basename(sessionPath, ".jsonl");

	let firstUnreadable: Error | null = null;
	// Real paths already listed — a transcript reachable by two paths is listed once.
	const seen = new Set<string>();

	// Pattern 1: Claude Code. ENOENT/ENOTDIR stay silent; other stat errors throw.
	const ccBaseDir = path.join(sessionDir, sessionBase, "subagents");
	try {
		const ccStat = fs.statSync(ccBaseDir);
		if (ccStat.isDirectory()) {
			const walkErr = walkSubagentDir(ccBaseDir, files, seen);
			if (walkErr && !firstUnreadable) firstUnreadable = walkErr;
		}
	} catch (err) {
		// Rethrow a nested walk throw unchanged (already warned, names innermost dir).
		if (err instanceof Error && err.message.startsWith("subagents directory could not be read (")) {
			throw err;
		}
		if (
			(err as NodeJS.ErrnoException).code !== "ENOENT" &&
			(err as NodeJS.ErrnoException).code !== "ENOTDIR"
		) {
			warnUnreadableSubagentDir(ccBaseDir, err);
			throw new Error(`subagents directory could not be read (${ccBaseDir}): ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Pattern 2: Pi parentSession (non-recursive)
	let mainSessionId: string | undefined;
	let mainHeaderRaw: string | null = null;
	try {
		mainHeaderRaw = readHeadLines(sessionPath, 1)[0];
	} catch (err) {
		warnUnreadableTranscript(sessionPath, "at discovery", err, "the session transcript");
		if (!firstUnreadable) {
			firstUnreadable = new Error(
				`session transcript could not be read at discovery (${sessionPath}): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	if (mainHeaderRaw !== null) {
		try {
			const mainHeader = JSON.parse(mainHeaderRaw);
			if (mainHeader.type === "session") mainSessionId = mainHeader.id;
		} catch {
			// Unparseable header declares no id — broken, not unreadable.
		}
	}

	if (mainSessionId) {
		try {
			// Skip directories named *.jsonl (EISDIR would latch unreadable forever).
			for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
				const f = entry.name;
				if (!f.endsWith(".jsonl")) continue;
				if (entry.isDirectory()) continue;
				const fullPath = path.join(sessionDir, f);
				if (fullPath === sessionPath) continue;
				let realFile: string;
				try { realFile = fs.realpathSync(fullPath); } catch { realFile = fullPath; }
				if (seen.has(realFile)) continue;
				try {
					const raw = readHeadLines(fullPath, 1)[0];
					let header: unknown = null;
					try {
						header = JSON.parse(raw);
					} catch {
						continue;
					}
					const h = header as { type?: string; parentSession?: string };
					if (h?.type === "session" && h.parentSession === mainSessionId) {
						seen.add(realFile);
						files.push(fullPath);
					}
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "EISDIR") continue;
					warnUnreadableTranscript(fullPath, "at discovery", err);
					if (!firstUnreadable) {
						firstUnreadable = new Error(
							`subagent transcript could not be read at discovery (${fullPath}): ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}
		} catch (err) {
			warnUnreadableSubagentDir(sessionDir, err);
			throw new Error(`subagent sibling directory could not be read (${sessionDir}): ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (firstUnreadable) {
		// Report, not throw — readable files come back; caller owns the fail-safe.
		return { files, unreadable: firstUnreadable };
	}

	return { files, unreadable: null };
}

/**
 * Recursively collect agent-*.jsonl under a subagent directory.
 * Returns the first per-entry stat failure (reported, not thrown);
 * dir-level readdir failures throw.
 */
function walkSubagentDir(
	dir: string,
	files: string[],
	seen: Set<string>,
): Error | null {
	let realDir: string;
	try { realDir = fs.realpathSync(dir); } catch { realDir = dir; }
	if (seen.has(realDir)) return null;
	seen.add(realDir);
	let frameErr: Error | null = null;
	try {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const f = entry.name;
			const fullPath = path.join(dir, f);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(fullPath);
			} catch (err) {
				// ENOENT/ELOOP: no cost to miss. Other failures: warn, keep walking, report.
				const statCode = (err as NodeJS.ErrnoException).code;
				if (statCode !== "ENOENT" && statCode !== "ELOOP") {
					warnUnreadableTranscript(fullPath, "at discovery", err);
					if (!frameErr) {
						frameErr = new Error(
							`subagent transcript could not be read at discovery (${fullPath}): ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
				continue;
			}
			// Never recurse into a symlinked directory (acyclic foreign trees).
			if (entry.isSymbolicLink() && stat.isDirectory()) continue;
			if (stat.isDirectory()) {
				// Recurse all dirs; agent-*.jsonl filter gates collection.
				// Skip wtft-tags (our own output would double-count).
				if (f !== "wtft-tags") {
					const childErr = walkSubagentDir(fullPath, files, seen);
					if (childErr && !frameErr) frameErr = childErr;
				}
			} else if (f.startsWith("agent-") && f.endsWith(".jsonl")) {
				let realFile: string;
				try { realFile = fs.realpathSync(fullPath); } catch { realFile = fullPath; }
				if (seen.has(realFile)) continue;
				seen.add(realFile);
				files.push(fullPath);
			}
		}
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("subagents directory could not be read (")) {
			throw err;
		}
		warnUnreadableSubagentDir(dir, err);
		throw new Error(`subagents directory could not be read (${dir}): ${err instanceof Error ? err.message : String(err)}`);
	}
	return frameErr;
}

// Latched per file per process — these sites run every poll/refresh.
const warnedUnreadableFile = new Set<string>();

/**
 * Warn once per unreadable transcript per process.
 * `phase`: "at discovery" (head-scan) or "or parsed" (whole-file parse —
 * phrasing is load-bearing for daemon warnings and tests).
 */
export function warnUnreadableTranscript(file: string, phase: "at discovery" | "or parsed", err: unknown, what = "a subagent transcript"): void {
	if (warnedUnreadableFile.has(file)) return;
	warnedUnreadableFile.add(file);
	process.stderr.write(
		`[wtft-log-parser] WARNING: ${what} could not be read ${phase}, so its cost may be missing from this session's total (${file}): ${err instanceof Error ? err.message : String(err)}\n`,
	);
}

/**
 * Warn once per unreadable subagent directory per process.
 * An unreadable dir drops every transcript under it — skip must be loud.
 */
const warnedUnreadableDir = new Set<string>();
function warnUnreadableSubagentDir(dir: string, err: unknown): void {
	if (warnedUnreadableDir.has(dir)) return;
	warnedUnreadableDir.add(dir);
	process.stderr.write(
		`[wtft-log-parser] WARNING: a subagent transcripts directory could not be read, so its transcripts' costs may be missing from this session's total (${dir}): ${err instanceof Error ? err.message : String(err)}\n`,
	);
}

/**
 * Clear cacheMiss on every interaction from a subagent transcript.
 * Provenance settles the divider: Pi and nested workflow layouts have no
 * per-entry isSidechain. Only the divider flag is cleared — not isSidechain
 * (that gates recache detection). Mutates in place; returns the same array.
 */
export function clearSubagentCacheMiss<T extends { cacheMiss?: boolean }>(interactions: T[]): T[] {
	for (const interaction of interactions) interaction.cacheMiss = undefined;
	return interactions;
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
	return loadSubagentInteractionsChecked(subagentFiles, parseFn, classifyFn, dedupFn).interactions;
}

/** {@link loadSubagentInteractions}, plus the files it dropped. */
export function loadSubagentInteractionsChecked(
	subagentFiles: string[],
	parseFn = parseSessionFile,
	classifyFn = classifyInteraction,
	dedupFn = deduplicateInteractions,
): { interactions: Interaction[]; dropped: string[] } {
	const interactions: Interaction[] = [];
	const dropped: string[] = [];
	for (const file of subagentFiles) {
		try {
			const raw = parseFn(file);
			const deduped = dedupFn(raw);
			clearSubagentCacheMiss(deduped);
			for (const interaction of deduped) interaction._cat = classifyFn(interaction);
			// Push only after the whole file classified.
			for (const interaction of deduped) interactions.push(interaction);
		} catch (err) {
			warnUnreadableTranscript(file, "or parsed", err);
			dropped.push(file);
		}
	}
	return { interactions, dropped };
}

// ---
// CLAUDE BASH SUB-AGENT DISCOVERY
// Parent spawns `claude -p` via bash → find the sub-agent session and
// attribute its tokens to the parent turn.
// ---

const CLAUDE_SUBAGENT_WINDOW_MS = 15_000; // ±15s window for timestamp matching

/**
 * Directory a bash command's `claude -p` spawn ran in.
 * Last `cd` at or before the spawn, or null when unknown.
 * `cd` right of `||` is a fallback — keep the first of the chain.
 * Expandable targets (`$VAR`, `$(…)`) return null, not a wrong guess.
 */
export function extractCwdFromBashCommand(cmd: string): string | null {
	let found: string | null = null;
	// Immediate predecessor was a kept `cd` — not "a cd appeared somewhere earlier".
	let prevWasKeptCd = false;
	for (const { text, joinedBy } of extractJoinedSegments(cmd)) {
		const bare = stripCommandPrefixes(text);
		const head = bare.split("\n", 1)[0]!;
		// Stop at the spawn — a later `cd` is where the shell went next.
		if (CLAUDE_SPAWN.test(head.toLowerCase())) break;
		const m = head.match(/^cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/);
		if (!m) { prevWasKeptCd = false; continue; }
		// `A || B`: keep the first of a fallback chain.
		if (joinedBy === "||" && prevWasKeptCd) continue;
		prevWasKeptCd = true;
		const target = m[1] || m[2] || m[3] || "";
		// Expandable target: keep prior `found`, do not clear it.
		if (/[$`]/.test(target)) continue;
		found = target || found;
	}
	return found;
}

/**
 * Cwd of the command that actually contains the `claude -p` spawn.
 * Each `commands` entry is its own Bash call with its own shell.
 */
export function cwdForClaudeSpawn(commands: string[]): string | null {
	for (const cmd of commands) {
		if (!commandSpawnsAgent(cmd)) continue;
		const cwd = extractCwdFromBashCommand(cmd);
		if (cwd) return cwd;
	}
	return null;
}

/**
 * Discover `claude -p` sub-agent session files whose first timestamp falls
 * within `windowMs` of `parentTimestamp`, under every slug the cwd may be
 * filed under — a `.` in the cwd is folded to `-` as well as `/` (#179).
 */
export function discoverClaudeSubAgentSessionFiles(
	cwd: string,
	parentTimestamp: number,
	windowMs: number = CLAUDE_SUBAGENT_WINDOW_MS,
): { files: string[]; unreadable: Error | null } {
	const files: string[] = [];
	let unreadable: Error | null = null;
	for (const slug of cwdSlugVariants(cwd)) {
		const found = scanClaudeProjectDir(
			path.join(projectsDir(), slug), parentTimestamp - windowMs, parentTimestamp + windowMs,
		);
		files.push(...found.files);
		unreadable ??= found.unreadable;
	}
	return { files, unreadable };
}

function scanClaudeProjectDir(
	projectDir: string,
	tsWindowStart: number,
	tsWindowEnd: number,
): { files: string[]; unreadable: Error | null } {
	try {
		const projectStat = fs.statSync(projectDir);
		if (!projectStat.isDirectory()) return { files: [], unreadable: null };
	} catch (err) {
		// ENOENT = absent (silent). Other stat errors = read failure (warn + throw).
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { files: [], unreadable: null };
		warnUnreadableSubagentDir(projectDir, err);
		throw new Error(`claude subagent projects directory could not be read (${projectDir}): ${err instanceof Error ? err.message : String(err)}`);
	}

	const files: string[] = [];
	let firstUnreadable: Error | null = null;

	try {
		for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
			const f = entry.name;
			if (!f.endsWith('.jsonl')) continue;
			if (entry.isDirectory()) continue;
			const fullPath = path.join(projectDir, f);
			try {
				// First 10 lines — line 0 may be an ai-title with no timestamp.
				const head = readHeadLines(fullPath, 10);
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
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "EISDIR") continue;
				warnUnreadableTranscript(fullPath, "at discovery", err);
				if (!firstUnreadable) {
					firstUnreadable = new Error(
						`subagent transcript could not be read at discovery (${fullPath}): ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
	} catch (err) {
		warnUnreadableSubagentDir(projectDir, err);
		throw new Error(`claude subagent projects directory could not be read (${projectDir}): ${err instanceof Error ? err.message : String(err)}`);
	}

	if (firstUnreadable) {
		// Return readable matches alongside the failure; caller owns the fail-safe.
		return { files, unreadable: firstUnreadable };
	}

	return { files, unreadable: null };
}

/** Any command invokes `claude` as a sub-agent (same predicate as classification). */
function interactionHasClaudeCommand(interaction: Interaction): boolean {
	return interaction.commands.some(commandSpawnsAgent);
}

/**
 * For each interaction that spawns `claude -p`, discover sub-agent sessions,
 * parse them, and add their token totals to the parent. Mutates in place.
 * `seenSessionIds` is local to this call — re-calling over slices double-counts.
 */
export function attributeClaudeSubAgentCosts(
	interactions: Interaction[],
): void {
	const seenSessionIds = new Set<string>();

	for (const interaction of interactions) {
		if (!interactionHasClaudeCommand(interaction)) continue;
		// Already attributed by a prior call
		if ((interaction as any).claudeSubAgentSessionIds) continue;

		const cwd = cwdForClaudeSpawn(interaction.commands);
		if (!cwd) continue;

		const subAgentResult = discoverClaudeSubAgentSessionFiles(
			cwd, interaction.timestamp,
		);
		// This pass has no cross-session ambiguity — throw so the report stays loud.
		if (subAgentResult.unreadable) throw subAgentResult.unreadable;
		const subAgentFiles = subAgentResult.files;

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

			// Mark seen only after parse succeeds, so a failure retries later.
			let subInteractions: Interaction[];
			try {
				subInteractions = parseSessionFile(file);
			} catch (err) {
				throw new Error(
					`nested subagent transcript could not be read or parsed (${file}): ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			seenSessionIds.add(sessionId);
			sessionIds.push(sessionId);

			const deduped = deduplicateInteractions(subInteractions);
			for (const si of deduped) {
				totalInput += si.inputTokens || 0;
				totalOutput += si.outputTokens || 0;
				totalCacheRead += si.cacheReadTokens || 0;
				totalCacheWrite += si.cacheWriteTokens || 0;
				totalReasoning += si.reasoningTokens || 0;
				totalCost += si.cost || 0;
			}
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

/**
 * Session ids whose cost is already folded into this session's totals, so a
 * later spawn-ledger walk does not add them twice (`claude -p` by cwd/time,
 * and Task children under `subagents/`). Discovery only — never a parse.
 */
export function collectSelfAttributedSessionIds(
	sessionPath: string,
	interactions: Interaction[],
	subagentFiles?: string[],
): Set<string> {
	const ids = new Set<string>();

	let files = subagentFiles;
	if (!files) {
		try { files = discoverSubagentSessionFiles(sessionPath).files; }
		catch { /* unreadable subagents dir is reported elsewhere */ }
	}
	for (const file of files ?? []) ids.add(path.basename(file, ".jsonl"));

	for (const interaction of interactions) {
		const recorded = (interaction as any).claudeSubAgentSessionIds as string[] | undefined;
		if (recorded) {
			for (const id of recorded) ids.add(id);
			continue;
		}

		if (!interaction.commands?.length) continue;
		const cwd = cwdForClaudeSpawn(interaction.commands);
		if (!cwd) continue;
		try {
			for (const file of discoverClaudeSubAgentSessionFiles(cwd, interaction.timestamp).files) {
				ids.add(path.basename(file, ".jsonl"));
			}
		} catch { /* same rule: unenumerable is not attributed */ }
	}

	return ids;
}

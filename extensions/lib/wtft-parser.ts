/** Session log parsing and interaction classification. */

import * as path from "node:path";
import * as fs from "node:fs";
import { calculateClaudeCost, calculateServerToolCost, getDeepSeekPeakMultiplier } from "./wtft-cost.js";
import { getParseAdapters } from "./harness/registry.ts";
import { projectsDir } from "./harness/claude-code/discovery.ts";
import { cwdSlugVariants, resolveLastCwd } from "./harness/session-cwd.ts";
import { extractCommandSegments, extractJoinedSegments, extractRealCommands, splitCommandWords, stripCommandPrefixes } from "./wtft-command-shapes.js";
import type { ControlSignal, UncountedBillableClass } from "./harness/types.ts";

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
	cacheMiss?: boolean;
	interrupted?: boolean;
	/** Turn immediately follows a compact summary — its cache_write is the compaction bill. */
	afterCompaction?: boolean;
	cacheWrite1hTokens?: number;
	iterations?: number;
	/** Subagent sidechain entry — excluded from prevCtx recache tracking. */
	isSidechain?: boolean;
	files: { path: string; action: "read" | "write" }[];
	commands: string[];
	texts: string[];
	toolCats?: Category[];
	/** Unmodeled tool_use — classifies "other", never "prompt". */
	unrecognizedTool?: boolean;
	_cat?: Category;
	surgePriced?: boolean;
	/** Every `claude -p` session folded into this turn, at any depth. */
	claudeSubAgentFolds?: SubAgentFold[];
}

/** The six `TokenTotals` fields, for one folded session's OWN turns — not the
 *  sessions it folded in turn, which are their own entries. */
export interface FoldShare {
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export interface SubAgentFold {
	id: string;
	share: FoldShare;
	/** The transcript parsed, and its stat taken before the read — a later stat
	 *  that differs means this share is out of date. */
	file: string;
	stamp: string;
}

// ---
// TOOL → CATEGORY MAP — non-file tools that earn a category directly.
// Unmapped tools fell into "prompt"/"other", so a spawn turn was billed as
// conversation. Names are lowercased. Harness spellings live here (meaning),
// not in adapters (schema).
// ---
const TOOL_CATEGORY_MAP: Record<string, Category> = {
	task: "agents", agent: "agents", workflow: "agents",
	taskoutput: "agents", taskstop: "agents", sendmessage: "agents",
	listagents: "agents", monitor: "agents",
	websearch: "web", webfetch: "web",
	search_web: "web", web_search: "web", fetch_url: "web",
	enterworktree: "git", exitworktree: "git",
	grep: "grep", glob: "grep", find: "grep", search_files: "grep",
	todowrite: "plan", todo_write: "plan", taskcreate: "plan", taskupdate: "plan",
	taskget: "plan", tasklist: "plan", askuserquestion: "plan", ask: "plan",
	enterplanmode: "plan", exitplanmode: "plan", skill: "plan", toolsearch: "plan",
	sendfeedback: "plan",
};

/** Pure navigation/bookkeeping: real calls, but not work — neither "other" nor poison `prompt`. */
const TOOL_NOOP = new Set(["change_working_directory", "cd", "pwd", "lsdir", "listmcpresourcestool"]);

function mapMcpToolToCategory(name: string): Category | null {
	if (!name.startsWith("mcp__")) return null;
	const tool = name.slice(name.indexOf("__", 5) + 2);
	if (/(?:^|_)(?:web_)?(?:search|fetch|browse|crawl)(?:_|$)/.test(tool)) return "web";
	return null;
}

function mapToolToCategory(name: string, toolCats: Set<Category>): boolean {
	const cat = TOOL_CATEGORY_MAP[name] || mapMcpToolToCategory(name);
	if (cat) {
		toolCats.add(cat);
		return true;
	}
	if (TOOL_NOOP.has(name)) return true;
	return false;
}

function extractFilesFromBashCommand(command: string, files: { path: string; action: "read" | "write" }[]) {
	for (const real of extractRealCommands(command)) collectFilesFromShellCommand(real, files);
}

export function parseEntryToInteraction(entry: any, thinkingLevel?: string, compactionTokensBefore?: number, afterCompaction?: boolean, currentModel?: string): Interaction | null {
	if (!entry) return null;

	let turn = null;
	for (const adapter of getParseAdapters()) {
		turn = adapter.matchAssistant(entry);
		if (turn) {
			return buildInteraction(turn, adapter, thinkingLevel, compactionTokensBefore, afterCompaction, currentModel);
		}
	}

	return null;
}

function buildInteraction(
	turn: import("./harness/types.ts").AssistantTurn,
	adapter: import("./harness/types.ts").HarnessParseAdapter,
	thinkingLevel?: string,
	compactionTokensBefore?: number,
	afterCompaction?: boolean,
	currentModel?: string
): Interaction {
	const usage = turn.usage;

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

export const INTERRUPT_PREFIX = "[Request interrupted by user";

/** User interrupt marker — stamps the PRECEDING assistant turn as interrupted. */
export function isInterruptMarker(entry: any): boolean {
	return readControlEntry(entry)?.kind === "interrupt";
}

export function readControlEntry(entry: any): ControlSignal | null {
	if (!entry) return null;
	for (const adapter of getParseAdapters()) {
		const signal = adapter.readControlEntry(entry);
		if (signal) return signal;
	}
	return null;
}

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
 * be parsed as an assistant turn.
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
 *  - compaction: post-compact-summary turn's cache_write $ → "compaction"
 *  - overhead (recache): whole-context rewrite into the 1h cache tier → "overhead"
 * Dollar component is the rate-weighted cache_write share (conserves totals;
 * only meter ratios matter, so Pi-native costs work too).
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

export function parseSessionFile(filePath: string, ancestors: ReadonlySet<string> = new Set()): Interaction[] {
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
		}
	}

	attributeClaudeSubAgentCosts(interactions, resolveLastCwd(filePath), new Set([...ancestors, canonicalTranscriptPath(filePath)]));

	return interactions;
}

// ---
// UNCOUNTED BILLABLES — billed events with no `usage` object
//
// Returns COUNTS, never dollars. TOTAL stays derived from recorded usage;
// the omission becomes visible rather than silent.
// ---

export interface UncountedBillables {
	compaction: number;
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

export function scanUncountedBillables(filePath: string): UncountedBillables {
	return scanUncountedBillablesChecked(filePath).counts;
}

/**
 * `readable: false` is distinct
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


/** Returns null for "no claim" — empty, unreadable, or unknown format. */
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

/** THE one predicate — reads each real command's HEAD so heredoc text is not a spawn. */
export function commandSpawnsAgent(cmd: string): boolean {
	return extractRealCommands(cmd).some(real => CLAUDE_SPAWN.test(real.split("\n", 1)[0]!.toLowerCase()));
}

/**
 * Version-control / repo-workflow work. All of `gh` lands here by default;
 * GH_SPEC / GH_SEARCH carve out before this is tested.
 */
const GIT_COMMAND = /^(?:git|gh|tig|hub|glab|pr-(?:open|submit|ready|watch|threads|cleanup|merge|reject|review|verdict|guard)|git-(?:checkpoint|overview|snap)|wt-new|iarts-mirror|repo-gate)(?:\s|$)/;

/** `list` and `close` stay `git`: navigation / workflow, not content. */
const GH_SPEC = /^gh\s+issue\s+(?:view|comment|create|edit|reopen|develop)(?:\s|$)/;

const GH_SEARCH = /^gh\s+(?:api\s+graphql|search)(?:\s|$)/;

/** Running a test suite. `bun test x` is tests; `bun build.ts` is not. */
const TEST_RUNNER = /^(?:(?:bun|npm|pnpm|yarn|deno)\s+(?:run\s+)?test\b|(?:bun|npx)\s+\S*tests?\/|(?:pytest|jest|vitest|mocha|ava|tap|cypress|playwright|ctest)\b|(?:go|cargo)\s+test\b|(?:bash|sh|zsh)\s+\S*tests?\/|\.?\/?tests?\/\S+\.(?:sh|ts|js|mjs|py)\b)/;

const BUILD_COMMAND = /^(?:(?:bun|npm|pnpm|yarn|deno)\s+run\s+(?:build|typecheck|lint|check|compile|bundle)\b|bun\s+build\S*|(?:tsc|esbuild|webpack|vite|rollup|make|cmake|ninja|gcc|g\+\+|clang|eslint|prettier|ruff|black|clippy|shellcheck)\b|(?:go|cargo)\s+(?:build|install)\b)/;

// ---
// SHELL FILE TOUCHES
// Bash read/write is the same work as Read/Edit — same path rules.
// ---

/**
 * Excludes metadata commands (`stat`, `file`, `shasum`) — they name a path
 * without reading content.
 */
const FILE_READER = /^(?:sed|cat|head|tail|less|more|bat|nl|od|xxd|strings|wc|awk|cut|diff|jq|yq|pdftotext)(?:\s|$)/;

/**
 * Commands whose FIRST non-flag argument is a program, not a path
 * (`sed -n '…' file` — the script is not a second path).
 */
const PROGRAM_FIRST_ARG = /^(?:sed|awk|gawk|nawk|perl|jq|yq)(?:\s|$)/;

const NUMERIC = /^\d+$/;

/**
 * `classifyByFilePaths` grades by extension/dir and cannot tell a repo from
 * scratch — without this, `/dev/null` and `/tmp/*.txt` grade as `code`.
 */
const NOT_A_REPO_FILE = /^\/(?:dev|proc|sys|run|tmp|etc|var|boot|lib|sbin|opt)(?:\/|$)/;

const IN_PLACE_EDIT = /^(?:sed\s+(?:-\S*\s+)*(?:-i\S*|--in-place(?:=\S+)?)|perl\s+(?:-\S+\s+)*-i\S*|tee)(?:\s|$)/;

const INLINE_SCRIPT = /^(?:python3?|node|bun|deno|perl|ruby|php|osascript)\s+(?:-\s*(?:$|<)|-\s|-c(?:\s|$)|-e(?:\s|$))/;

/** unexpanded globs must not enter the file list */
const PATHLIKE = /^(?:~|\.\.?)?\/?[A-Za-z0-9_.@+][A-Za-z0-9_.@+/-]*$/;

function shellWords(cmd: string): string[] {
	const out: string[] = [];
	const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
	return out;
}

/**
 * Conservative: unidentified paths contribute nothing; over-claiming is worse
 * than leaving spend in `other`.
 */
function collectFilesFromShellCommand(cmd: string, files: { path: string; action: "read" | "write" }[]): void {
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

	const written = new Set<string>();
	for (const p of writes) {
		if (!p || NOT_A_REPO_FILE.test(p) || !PATHLIKE.test(p)) continue;
		files.push({ path: p, action: "write" });
		written.add(p);
	}

	const isEdit = IN_PLACE_EDIT.test(cmd);
	if (!FILE_READER.test(cmd) && !isEdit) return;

	for (const p of reads) {
		if (!p || written.has(p) || NOT_A_REPO_FILE.test(p) || !PATHLIKE.test(p)) continue;
		files.push({ path: p, action: "read" });
	}

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
 * `agentType` and `spawnDepth` are required; everything else is optional
 * (Dynamic Workflow children under `subagents/workflows/` carry neither
 * `description` nor `toolUseId`).
 */
export interface SubagentMeta {
	agentType: string;
	spawnDepth: number;
	description?: string;
	toolUseId?: string;
	model?: string;
	parentAgentId?: string;
	isFork?: boolean;
}

/**
 * Never throws, never partially succeeds — undocumented harness output; a
 * missing required field is `null` rather than a half-filled record.
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

/** An unreadable dir drops every transcript under it — skip must be loud. */
const warnedUnreadableDir = new Set<string>();
function warnUnreadableSubagentDir(dir: string, err: unknown): void {
	if (warnedUnreadableDir.has(dir)) return;
	warnedUnreadableDir.add(dir);
	process.stderr.write(
		`[wtft-log-parser] WARNING: a subagent transcripts directory could not be read, so its transcripts' costs may be missing from this session's total (${dir}): ${err instanceof Error ? err.message : String(err)}\n`,
	);
}

/**
 * Provenance settles the divider: Pi and nested workflow layouts have no
 * per-entry isSidechain. Only the divider flag is cleared — not isSidechain
 * (that gates recache detection). Mutates in place; returns the same array.
 */
export function clearSubagentCacheMiss<T extends { cacheMiss?: boolean }>(interactions: T[]): T[] {
	for (const interaction of interactions) interaction.cacheMiss = undefined;
	return interactions;
}

export function loadSubagentInteractions(
	subagentFiles: string[],
	parseFn = parseSessionFile,
	classifyFn = classifyInteraction,
	dedupFn = deduplicateInteractions,
	rootFile: string | null = null,
): Interaction[] {
	return loadSubagentInteractionsChecked(subagentFiles, parseFn, classifyFn, dedupFn, rootFile).interactions;
}

/** `rootFile` is the session these transcripts belong to: a child of it must
 *  never fold it back in, and only the caller knows which session that is. */
export function loadSubagentInteractionsChecked(
	subagentFiles: string[],
	parseFn = parseSessionFile,
	classifyFn = classifyInteraction,
	dedupFn = deduplicateInteractions,
	rootFile: string | null = null,
): { interactions: Interaction[]; dropped: string[] } {
	const interactions: Interaction[] = [];
	const dropped: string[] = [];
	const ancestors = new Set<string>(rootFile ? [canonicalTranscriptPath(rootFile)] : []);
	for (const file of subagentFiles) {
		try {
			const raw = parseFn(file, ancestors);
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

export const CLAUDE_SUBAGENT_WINDOW_MS = 15_000; // ±15s window for timestamp matching

/**
 * Last `cd` at or before the spawn, or null when unknown.
 * `cd` right of `||` is a fallback — keep the first of the chain.
 * Expandable targets (`$VAR`, `$(…)`) return null, not a wrong guess.
 */
export function extractCwdFromBashCommand(cmd: string): string | null {
	return cdBeforeSpawn(cmd).cwd;
}

/**
 * `sawCd` is what separates "ran where the session runs" from "ran somewhere we
 * cannot name": a command with no `cd` at all inherits the session's own cwd,
 * while one whose `cd` target is expandable ran elsewhere, so falling back to
 * the session's cwd for it would be a wrong guess, not a missing one.
 */
function cdBeforeSpawn(cmd: string): { cwd: string | null; sawCd: boolean } {
	let found: string | null = null;
	let sawCd = false;
	let prevWasKeptCd = false;
	for (const { text, joinedBy } of extractJoinedSegments(cmd)) {
		const bare = stripCommandPrefixes(text);
		const head = bare.split("\n", 1)[0]!;
		// Stop at the segment that RUNS the spawn — a later `cd` is where the
		// shell went next. Not at one that merely names it (`which claude`, a
		// launcher's `--kind claude`), whose own `cd` still applies.
		if (CLAUDE_HEAD.test(head.trim().toLowerCase())) break;
		const m = head.match(/^cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/);
		if (!m) {
			// `cd` with no argument goes to $HOME — a move we cannot name, which is
			// not the same as no move at all.
			if (/^cd\s*$/.test(head)) { sawCd = true; found = null; prevWasKeptCd = false; continue; }
			prevWasKeptCd = false;
			continue;
		}
		if (joinedBy === "||" && prevWasKeptCd) continue;
		prevWasKeptCd = true;
		sawCd = true;
		const target = m[1] || m[2] || m[3] || "";
		// Expandable target: keep prior `found`, do not clear it.
		if (/[$`]/.test(target)) continue;
		found = target || found;
	}
	return { cwd: found, sawCd };
}

/**
 * Every directory a turn's `claude -p` spawns may have run in, deduped, in
 * command order. Each `commands` entry is its own Bash call with its own shell,
 * so two spawns in one turn can sit in two directories. A spawn contributes its
 * own `cd` target; `ownCwd` stands in only for one that has no `cd` and whose
 * shell runs `claude` itself.
 */
export function claudeSpawnCwds(commands: string[], ownCwd: string | null): string[] {
	const cwds: string[] = [];
	for (const cmd of commands) {
		if (!commandSpawnsAgent(cmd)) continue;
		const { cwd, sawCd } = cdBeforeSpawn(cmd);
		const resolved = cwd || (!sawCd && runsClaudeDirectly(cmd) ? ownCwd : null);
		if (resolved && !cwds.includes(resolved)) cwds.push(resolved);
	}
	return cwds;
}

const CLAUDE_HEAD = /^claude(?:\s|$)/;

/** Identity for the self/ancestor guards: discovery builds paths by joining, so
 *  a symlinked transcript or project dir reaches them spelled differently from
 *  the session's own path, and a guard that compared spellings would miss it. */
export function canonicalTranscriptPath(file: string): string {
	try {
		return fs.realpathSync(path.resolve(file));
	} catch {
		return path.resolve(file);
	}
}

/**
 * Whether the shell itself runs `claude` — as opposed to a launcher that merely
 * names it in a flag (`herdr agent start … --kind claude`). Only a direct run
 * inherits the shell's working directory; a launcher starts its child in a
 * worktree or a sandbox, so the shell's cwd says nothing about where that
 * child's transcript landed.
 */
function runsClaudeDirectly(cmd: string): boolean {
	return extractRealCommands(cmd)
		.some(real => CLAUDE_HEAD.test(stripCommandPrefixes(real).split("\n", 1)[0]!.trim().toLowerCase()));
}

/**
 * Discover `claude -p` sub-agent session files whose first timestamp falls
 * within `windowMs` of `parentTimestamp`, under every slug the cwd may be
 * filed under — a `.` in the cwd is folded to `-` as well as `/`.
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

/**
 * Every `claude -p` child one turn's spawns may have written: one discovery per
 * distinct directory the turn's spawns name, with the session's own cwd
 * standing in for a command that has no `cd`.
 *
 * `searched` is how many directories were looked in. Zero means there was
 * nothing to look in — never "looked and found nothing", which is the
 * distinction a caller needs to decide whether to keep retrying.
 */
export function discoverClaudeSubAgentFilesForTurn(
	commands: string[],
	parentTimestamp: number,
	ownCwd: string | null,
	windowMs: number = CLAUDE_SUBAGENT_WINDOW_MS,
): { files: string[]; unreadable: Error | null; searched: number } {
	const files: string[] = [];
	let unreadable: Error | null = null;
	const cwds = claudeSpawnCwds(commands, ownCwd);
	for (const cwd of cwds) {
		// One unreadable directory must not discard what the others found: the
		// caller retries on `unreadable`, and a permanently unreadable directory
		// would otherwise keep a readable sibling's child out of the tag forever.
		let found: { files: string[]; unreadable: Error | null };
		try {
			found = discoverClaudeSubAgentSessionFiles(cwd, parentTimestamp, windowMs);
		} catch (err) {
			unreadable ??= err instanceof Error ? err : new Error(String(err));
			continue;
		}
		for (const file of found.files) if (!files.includes(file)) files.push(file);
		unreadable ??= found.unreadable;
	}
	return { files, unreadable, searched: cwds.length };
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
		return { files, unreadable: firstUnreadable };
	}

	return { files, unreadable: null };
}

function interactionHasClaudeCommand(interaction: Interaction): boolean {
	return interaction.commands.some(commandSpawnsAgent);
}

/** `seenSessionIds` is local to this call — re-calling over slices double-counts. */
export function attributeClaudeSubAgentCosts(
	interactions: Interaction[],
	ownCwd: string | null = null,
	ancestors: ReadonlySet<string> = new Set(),
): void {
	const seenSessionIds = new Set<string>();

	for (const interaction of interactions) {
		if (!interactionHasClaudeCommand(interaction)) continue;
		if (interaction.claudeSubAgentFolds) continue;

		const subAgentResult = discoverClaudeSubAgentFilesForTurn(
			interaction.commands, interaction.timestamp, ownCwd,
		);
		if (subAgentResult.searched === 0) continue;
		// This pass has no cross-session ambiguity — throw so the report stays loud.
		if (subAgentResult.unreadable) throw subAgentResult.unreadable;
		const subAgentFiles = subAgentResult.files;

		const added: FoldShare = emptyFoldShare();
		const folds: SubAgentFold[] = [];

		for (const file of subAgentFiles) {
			// A session never folds itself or one that folded it: discovery matches
			// on a timestamp window, and a transcript in the directory it searches
			// can be its own, or an ancestor's.
			if (ancestors.has(canonicalTranscriptPath(file))) continue;
			const sessionId = path.basename(file, '.jsonl');
			if (seenSessionIds.has(sessionId)) continue;

			// Mark seen only after parse succeeds, so a failure retries later.
			let subInteractions: Interaction[];
			let stamp: string;
			try {
				stamp = fileStamp(file);
				subInteractions = parseSessionFile(file, ancestors);
			} catch (err) {
				throw new Error(
					`nested subagent transcript could not be read or parsed (${file}): ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			const inclusive = emptyFoldShare();
			const nested: SubAgentFold[] = [];
			for (const si of deduplicateInteractions(subInteractions)) {
				inclusive.costUsd += si.cost || 0;
				inclusive.inputTokens += si.inputTokens || 0;
				inclusive.outputTokens += si.outputTokens || 0;
				inclusive.reasoningTokens += si.reasoningTokens || 0;
				inclusive.cacheReadTokens += si.cacheReadTokens || 0;
				inclusive.cacheWriteTokens += si.cacheWriteTokens || 0;
				nested.push(...(si.claudeSubAgentFolds ?? []));
			}
			const own = { ...inclusive };
			for (const n of nested) {
				for (const key of FOLD_SHARE_KEYS) own[key] -= n.share[key];
			}
			// Accounted per session id, by OWN share: a grandchild the child already
			// folded is also an in-window match in the same directory, so the turn
			// discovers it directly too. Summing each file's INCLUSIVE total would
			// then bill that grandchild once inside its parent and once on its own.
			for (const fold of [{ id: sessionId, share: own, file, stamp }, ...nested]) {
				if (seenSessionIds.has(fold.id)) continue;
				seenSessionIds.add(fold.id);
				folds.push(fold);
				for (const key of FOLD_SHARE_KEYS) added[key] += fold.share[key];
			}
		}

		if (folds.length > 0) {
			interaction.inputTokens += added.inputTokens;
			interaction.outputTokens += added.outputTokens;
			interaction.cacheReadTokens += added.cacheReadTokens;
			interaction.cacheWriteTokens += added.cacheWriteTokens;
			interaction.reasoningTokens += added.reasoningTokens;
			interaction.cost += added.costUsd;
			interaction.claudeSubAgentFolds = folds;
		}
	}
}

export function fileStamp(file: string): string {
	const st = fs.statSync(file);
	return `${st.size}:${st.mtimeMs}:${st.ino}`;
}

/** The last moment discovery could still find a `claude -p` child for one of
 *  these turns — its window runs from the spawning turn's timestamp. 0 when
 *  none spawns. */
export function claudeSpawnWindowClosesAt(interactions: Interaction[], ownCwd: string | null = null): number {
	let closes = 0;
	for (const interaction of interactions) {
		if (!interactionHasClaudeCommand(interaction)) continue;
		if (claudeSpawnCwds(interaction.commands, ownCwd).length === 0) continue;
		closes = Math.max(closes, interaction.timestamp + CLAUDE_SUBAGENT_WINDOW_MS);
	}
	return closes;
}

/** Whether an interaction counts toward a session's totals: untagged turns are
 *  reported apart, as `untaggedCostUsd`. */
export function isModelTagged(i: Interaction): boolean {
	return !!i.model && i.model !== "(unknown)" && i.model !== "<synthetic>";
}

const FOLD_SHARE_KEYS = ["costUsd", "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

function emptyFoldShare(): FoldShare {
	return { costUsd: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * Session ids whose cost is already inside a SELF total built from these
 * inputs, so a spawn-ledger walk does not add them twice: the tag's fold
 * records, any transcripts the caller merged into SELF itself, and every
 * session those interactions' folds name. A union of what it is handed —
 * never a discovery, which would answer for the filesystem as it is now
 * rather than for the total as it was built.
 */
export function collectSelfAttributedSessionIds(
	recordedFolds: ReadonlySet<string> | readonly string[],
	interactions: Interaction[],
	mergedFiles: string[] = [],
): Set<string> {
	const ids = new Set<string>(recordedFolds);
	for (const file of mergedFiles) ids.add(path.basename(file, ".jsonl"));
	// The same rule as the daemon's records: only a fold the total holds.
	for (const interaction of deduplicateInteractions(interactions)) {
		if (!isModelTagged(interaction)) continue;
		for (const fold of interaction.claudeSubAgentFolds ?? []) ids.add(fold.id);
	}
	return ids;
}

/**
 * @package princess-pi-tools
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
import { extractCommandSegments, extractJoinedSegments, extractRealCommands, splitCommandWords, stripCommandPrefixes } from "./wtft-command-shapes.js";
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
	// …and the tools that manage a spawned agent once it exists (#106). Reading
	// a subagent's output or stopping it is part of the orchestration, not a
	// separate kind of work.
	taskoutput: "agents", taskstop: "agents", sendmessage: "agents",
	listagents: "agents", monitor: "agents",
	// Server-side web tools — token side joins the request-cost side (#73)
	websearch: "web", webfetch: "web",
	// Pi spells the same tool differently, and the map only knew Claude Code's
	// spelling — 268 corpus calls of `search_web` fell straight to "other"
	// (#106 Finding 4). A harness's vocabulary belongs in the shared map, not in
	// its adapter, because the adapter translates SCHEMA and this is meaning.
	search_web: "web", web_search: "web", fetch_url: "web",
	// Worktree navigation is repo workflow, the same as the `wt-new` it wraps.
	enterworktree: "git", exitworktree: "git",
	// Standalone Grep tool joins bash grep/rg in the existing category
	grep: "grep", glob: "grep", find: "grep", search_files: "grep",
	// Planning/steering tools — split out of "prompt" so prompt = pure reply
	todowrite: "plan", todo_write: "plan", taskcreate: "plan", taskupdate: "plan",
	taskget: "plan", tasklist: "plan", askuserquestion: "plan", ask: "plan",
	enterplanmode: "plan", exitplanmode: "plan", skill: "plan", toolsearch: "plan",
	sendfeedback: "plan",
};

/**
 * Tools that are pure navigation or bookkeeping: real calls, but not work.
 *
 * They must neither create an "other" turn nor poison `prompt` — Pi's
 * `change_working_directory` (63 corpus calls) is the bash `cd` wearing a tool
 * name, and `cd` has been stripped since #63.
 */
const TOOL_NOOP = new Set(["change_working_directory", "cd", "pwd", "lsdir", "listmcpresourcestool"]);

/**
 * MCP tools arrive as `mcp__<server>__<tool>`, so the vendor prefix hides what
 * they do. The suffix is the only readable signal, and it is read narrowly:
 * search/fetch is the one family common enough across servers to be worth a
 * rule (#106 D2). Anything else returns null and the turn stays honest about
 * not knowing — it just must not be counted as conversation.
 */
function mapMcpToolToCategory(name: string): Category | null {
	if (!name.startsWith("mcp__")) return null;
	const tool = name.slice(name.indexOf("__", 5) + 2);
	if (/(?:^|_)(?:web_)?(?:search|fetch|browse|crawl)(?:_|$)/.test(tool)) return "web";
	return null;
}

/** Route one non-file tool call into toolCats / unrecognizedTool flags (#52). */
function mapToolToCategory(name: string, toolCats: Set<Category>): boolean {
	const cat = TOOL_CATEGORY_MAP[name] || mapMcpToolToCategory(name);
	if (cat) {
		toolCats.add(cat);
		return true;
	}
	// Navigation is "handled" with no category: the turn is neither work nor
	// disqualified from being a pure reply.
	if (TOOL_NOOP.has(name)) return true;
	return false;
}
/**
 * Record every file a bash command touches, so a turn that read or edited a
 * file through the shell classifies as the work it did (#11 items 2 and 3).
 *
 * Rebuilt in #106: the #63 version understood `cat`/`head`/`tail` and one
 * heredoc shape, which left `sed` as the most expensive single command in the
 * "other" bucket of BOTH sessions #10 and #11 measured. It now runs over the
 * segmented command list, so a file read inside a loop body or after a `cd` is
 * seen the same as one at the front of the string.
 */
function extractFilesFromBashCommand(command: string, files: { path: string; action: "read" | "write" }[]) {
	for (const real of extractRealCommands(command)) collectFilesFromShellCommand(real, files);
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
	//
	// Parent-only (#115): a sidechain starts with an empty context, so read-0 /
	// write-everything is how it BEGINS, not something it lost. The divider means
	// "your cached prefix was thrown away" and is actionable only about the
	// conversation the reader is in, so it follows the same exclusion
	// splitOverheadCost already applies to recache detection.
	const cacheMiss =
		!turn.isSidechain &&
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
	// #457 — the READ is loud: an unreadable transcript (EACCES, EISDIR, ENOMEM,
	// a mid-read I/O error, or the file vanishing) throws here instead of
	// returning [] and reading as a legitimately empty session. The caller
	// decides what a missing/unreadable file means: the daemon's
	// syncSubagentTranscript warns, leaves its change detector untouched, and
	// retries next poll; loadSubagentInteractions skips the file. Per-line
	// errors below stay swallowed as before — a throw out of JSON.parse, a
	// control entry, or parseEntryToInteraction is treated as a bad line
	// (partial writes, non-JSON, an unknown entry shape), not a file-level
	// failure.
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
	return scanUncountedBillablesChecked(filePath).counts;
}

/**
 * The same scan, plus whether the file could be read at all.
 *
 * `readable: false` is a distinct fact from "read, found nothing": a listed
 * subagent file that cannot be opened (mode 000, a race with deletion) leaves
 * its billables uncounted, and a caller that only sees zero counts would report
 * a complete-looking blind-spot scan. The verdict-flipping caller in `bin/wtft.ts`
 * reads this flag (PR #95 review, Medium); the unchecked form above keeps its
 * signature for the daemon and the suites that never needed the distinction.
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
 * Which harness wrote this session? (#26)
 *
 * Asked rather than assumed: `wtft -s <path>` bypasses discovery entirely, so
 * the candidate's `harness` field is not available on the path that
 * `wtft --json` is most often invoked on. The answer comes from the same
 * adapter dispatch `parseEntryToInteraction` uses, so a session can never be
 * labelled with a harness that would not, in fact, parse it.
 *
 * ONE DIFFERENCE from that dispatch, stated because it is decidable and a
 * reader would otherwise assume identity: `parseEntryToInteraction` picks the
 * first adapter that claims ONE entry, and this picks the first adapter that
 * claims the EARLIEST claimable entry. On a single-schema file — every file any
 * harness here writes — those are the same answer. On a hypothetical
 * mixed-schema file they can differ, and this one reports whoever wrote the
 * first assistant turn.
 *
 * Returns null when no adapter claims anything: an empty session, one not
 * written yet (#308), a file that could not be READ at all, or a format no
 * registered harness understands. Those four are not distinguished — null means
 * "no claim", never "empty".
 *
 * Reads the whole file, like `scanUncountedBillables` above, then stops scanning
 * at the first claimed entry. Those two are the non-watch CLI's only reads of
 * the session itself; everything else it reports comes from the tag file.
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
				// The DIVIDER's flag joins them, and #115 is why it now matters:
				// `cacheMiss` used to be a pure function of the winning copy's
				// own usage block, so the merge could not get it wrong. It is now
				// a function of the entry ENVELOPE, which a re-logged copy of the
				// same message id need not carry — and if that copy won on cost,
				// the divider fired on the very spawn the gate suppresses.
				//
				// `merged.isSidechain` itself is deliberately NOT widened here.
				// It gates `splitOverheadCost`'s recache detection and the
				// prevCtx chain that detection walks, so ORing it would move a
				// merged message's cache-write dollars between the overhead and
				// work buckets — and flip recache detection for LATER
				// interactions through prevCtx. That is a bigger change than this
				// issue, it would falsify this bump's "no bucket moves", and it
				// belongs with the subagent-accounting work (#15).
				//
				// SCOPE, stated because it is narrower than it looks (PR review
				// round 3): this only fires when both copies are in the SAME
				// array. The daemon's parent path dedups one poll batch at a
				// time, so two emissions of one id that straddle a 667ms poll
				// boundary never meet here — the known defect class named in
				// bin/wtft-daemon.ts, whose whole-file re-parse fix was applied
				// to subagent transcripts only. In that residual window a
				// sidechain turn could still write one tag line carrying
				// `miss: 1`, and no tag reader can undo it, since `isSidechain`
				// is deliberately not in the wire format. Closing it means the
				// parent path re-parsing whole files too, which is #97's
				// question, not this issue's.
				if (i.isSidechain) merged.cacheMiss = undefined;
			}
			if (mergedToolCats.size > 0) merged.toolCats = [...mergedToolCats];
			deduped.push(merged);
		}
	}

	return deduped;
}

// HELPERS & PARSERS

// COMMAND NORMALIZATION (#63, rebuilt on segmentation in #106)
//
// The PRIMARY command of a bash string — the first thing it runs that is not
// navigation, an assignment, a wrapper or shell grammar. Empty when the string
// runs no such command at all (a bare `cd`, a lone `export`).
//
// Why this is now one line over `extractRealCommands`: #63 did the job with
// three leading-prefix regexes, which demanded a literal `&&`/`;` after `cd`
// and could not see past the first command. Measured across the corpus in
// `research/other-corpus/`, that left `cd` as the LARGEST single "other"
// command — ~20% of the bucket — because the commonest real shape separates
// with a newline. The shapes and the reasoning live in wtft-command-shapes.ts.
//
// Contract change (#106): this returns the primary command ALONE, where #63
// returned the whole remaining string. Callers that scanned the remainder for a
// later command must read `extractRealCommands` instead — which sees more than
// the remainder ever did, because it also looks inside loop bodies.
export function normalizeCommand(cmd: string): string {
	return extractRealCommands(cmd)[0] || "";
}

// ---
// BASH COMMAND -> CATEGORY (#106, resolving #10 and #11)
//
// Each of these names a family of commands that IS a category, so a turn that
// did its work through the shell is counted as the work it did rather than as
// "other". The families were chosen from measured corpus spend, not guessed —
// see `research/other-corpus/` and the tables in #106.
// ---

/** Spawning another agent. Excludes `.claude/` paths and `CLAUDE.md` (#3/#138). */
const CLAUDE_SPAWN = /(?:^|\s)claude(?:\s+-|\s*\||\s*$)/;

/**
 * Does this bash command string spawn an agent?
 *
 * THE one predicate. The daemon carried a hand-copied twin of the regex while
 * this module owned `CLAUDE_SPAWN`, so a change here would not have reached it
 * — and the two decide the same thing: whether a subagent's cost gets
 * discovered. They disagreeing silently loses or double-counts money (#106
 * review round 4, Low/crossfile), which is the same class of defect as the
 * transcribed `normalizeCommand` this branch already deleted from that file.
 *
 * Reads each real command's HEAD, so a `claude -p` that is only text inside a
 * heredoc body is not mistaken for a spawn.
 */
export function commandSpawnsAgent(cmd: string): boolean {
	return extractRealCommands(cmd).some(real => CLAUDE_SPAWN.test(real.split("\n", 1)[0]!.toLowerCase()));
}

/**
 * Version-control work, including the tools that only ever do version-control
 * work. `gh` is the GitHub CLI, and `pr-*` / `git-*` / `wt-new` are this repo's
 * own workflow wrappers — every one of them a 1:1 git or GitHub operation
 * (#10 Findings 1 and 2), and together the second-largest reclaim measured.
 *
 * DESIGN NOTE — all of `gh` lands here, including `gh issue` and `gh api`.
 * #10 flagged that as a real fork: issue and comment traffic is arguably
 * "talking about the work" rather than doing version control. It goes to `git`
 * because `git` already means repo-and-workflow rather than the `git` binary,
 * and because the alternative — a new top-level category — changes the tag
 * format, the renderer and every spec that lists the categories. Splitting it
 * later is a one-line change here; the split is #106 D1, Duppy's call.
 */
const GIT_COMMAND = /^(?:git|gh|tig|hub|glab|pr-(?:open|submit|ready|watch|threads|cleanup|merge|reject|review|verdict|guard)|git-(?:checkpoint|overview|snap)|wt-new|iarts-mirror|repo-gate)(?:\s|$)/;

/**
 * `gh` subcommands that are NOT version control (#106 D1, Duppy 2026-09-12).
 *
 * **An issue IS the spec, so reading and writing one is spec work.** In this
 * workflow the issue body carries the spec gate and the closer, and the comments
 * carry the resolution, the dispositions and the design decisions — that is the
 * normative record, not chatter. Measured over 250 sessions, `gh issue` is
 * $189.71, the largest `gh` subcommand and nearly 3x `gh pr`; routing all of
 * `gh` to `git` made half the git bar issue traffic.
 *
 * `list` and `close` stay `git` deliberately: "what is open?" is navigation and
 * closing is a workflow action, neither touches the spec's content.
 */
const GH_SPEC = /^gh\s+issue\s+(?:view|comment|create|edit|reopen|develop)(?:\s|$)/;

/**
 * `gh` subcommands that are a SEARCH.
 *
 * A GraphQL query is a query (Duppy's amendment), and `gh search` is the same
 * rule by its own name — that second one is inference rather than instruction,
 * and is recorded as such in #106.
 */
const GH_SEARCH = /^gh\s+(?:api\s+graphql|search)(?:\s|$)/;

/**
 * Known imprecision, stated rather than hidden: `gh api` otherwise stays `git`,
 * even though $51.06 of `repos/…` calls in the corpus is partly issue traffic.
 * Telling an issue read from a branch-protection check needs URL parsing — real
 * work for a murky win. If the `git` bar looks wrong, this is the thread.
 */

/** Running a test suite. `bun test x` is tests; `bun build.ts` is not. */
const TEST_RUNNER = /^(?:(?:bun|npm|pnpm|yarn|deno)\s+(?:run\s+)?test\b|(?:bun|npx)\s+\S*tests?\/|(?:pytest|jest|vitest|mocha|ava|tap|cypress|playwright|ctest)\b|(?:go|cargo)\s+test\b|(?:bash|sh|zsh)\s+\S*tests?\/|\.?\/?tests?\/\S+\.(?:sh|ts|js|mjs|py)\b)/;

/** Building, typechecking or linting the code — a code activity, not "other". */
const BUILD_COMMAND = /^(?:(?:bun|npm|pnpm|yarn|deno)\s+run\s+(?:build|typecheck|lint|check|compile|bundle)\b|bun\s+build\S*|(?:tsc|esbuild|webpack|vite|rollup|make|cmake|ninja|gcc|g\+\+|clang|eslint|prettier|ruff|black|clippy|shellcheck)\b|(?:go|cargo)\s+(?:build|install)\b)/;

// ---
// SHELL FILE TOUCHES (#11 items 2 and 3)
//
// Bash commands that read or write a file are the same work as the Read/Edit
// tools, and must classify by the same path rules. Two shapes, both measured
// large: a plain reader/writer with the path in its arguments, and an inline
// script whose paths are inside its body.
// ---

/**
 * Commands whose non-flag arguments are file paths being READ.
 *
 * Deliberately excludes metadata commands (`stat`, `file`, `shasum`): they name
 * a path without reading its content, and counting them as reads would move
 * spend into `code` for turns that only looked at a file's size.
 */
const FILE_READER = /^(?:sed|cat|head|tail|less|more|bat|nl|od|xxd|strings|wc|awk|cut|diff|jq|yq|pdftotext)(?:\s|$)/;

/**
 * Commands whose FIRST non-flag argument is a program, not a path.
 *
 * `sed -n '300,350p' bin/wtft.ts` reads one file; its script is not a second
 * one. Without this, either the script gets counted as a path or — the way the
 * first cut of this went — the path test has to be so strict that `cat wtft`
 * stops finding a real, extensionless wrapper script.
 */
const PROGRAM_FIRST_ARG = /^(?:sed|awk|gawk|nawk|perl|jq|yq)(?:\s|$)/;

/** A bare number is an argument value (`tail -n 50`), never a path. */
const NUMERIC = /^\d+$/;

/**
 * Absolute paths that are real files but are not REPOSITORY work.
 *
 * `classifyByFilePaths` grades a path by extension and directory, and it has no
 * way to know a repo from a scratch dir — so `/dev/null` came back as an
 * extensionless `code` file, `cat /etc/hosts` graded as `code`, and
 * `echo hi > /tmp/notes.txt` turned deliberate shell noise into a code turn by
 * way of its `.txt` extension (#106 review rounds 1 and 3).
 *
 * The rule is "outside any checkout", not "temporary": a scratchpad script under
 * /tmp is genuine work, but it is not this repository's code, and calling it
 * `code` overstates code spend — which is the number #52 exists to get right.
 * A repo-relative path (`bin/x.ts`) is unaffected, and so is an absolute path
 * into a checkout, because neither starts with one of these roots.
 */
const NOT_A_REPO_FILE = /^\/(?:dev|proc|sys|run|tmp|etc|var|boot|lib|sbin|opt)(?:\/|$)/;

/** Readers that are actually writing when the flag says so (`sed -i`). */
const IN_PLACE_EDIT = /^(?:sed\s+(?:-\S*\s+)*(?:-i\S*|--in-place(?:=\S+)?)|perl\s+(?:-\S+\s+)*-i\S*|tee)(?:\s|$)/;

/** Interpreters running an inline script rather than a file. */
const INLINE_SCRIPT = /^(?:python3?|node|bun|deno|perl|ruby|php|osascript)\s+(?:-\s*(?:$|<)|-\s|-c(?:\s|$)|-e(?:\s|$))/;

/**
 * A token that plausibly names a file rather than a flag, a glob or a number.
 *
 * Permissive about the extension (`cat wtft` names a real extensionless wrapper
 * script), strict about shell metacharacters: a word carrying `*`, `?`, `$`,
 * `{` or a quote has not been expanded yet, and recording it as a path would
 * put a literal glob into the file list.
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
 *
 * Conservative on purpose: a path it cannot identify contributes nothing, and
 * the turn falls through to the command-name rules. Over-claiming a path would
 * move spend into `code`/`tests` on a guess, which is worse than leaving it in
 * `other` where the histogram still shows it.
 */
function collectFilesFromShellCommand(cmd: string, files: { path: string; action: "read" | "write" }[]): void {
	// Inline script: the paths are string literals inside the body, and the
	// interpreter name says nothing. `python3 - <<'PY' … open("bin/x.ts") … PY`
	// was #11's single most expensive misfiled command family.
	if (INLINE_SCRIPT.test(cmd)) {
		const writes = /\b(?:open\s*\(\s*["']([^"']+)["']\s*,\s*["'][wa]|writeFileSync\s*\(\s*["']([^"']+)["']|write_text\s*\(|Path\s*\(\s*["']([^"']+)["']\s*\)\s*\.write)/g;
		const reads = /\b(?:open\s*\(\s*["']([^"']+)["']|readFileSync\s*\(\s*["']([^"']+)["']|read_text\s*\(|loadtxt\s*\(\s*["']([^"']+)["'])/g;
		let m: RegExpExecArray | null;
		const seen = new Set<string>();
		// NOT_A_REPO_FILE applies here too. This branch returns early, so an
		// earlier cut checked it on every OTHER path shape and not on the one
		// inside a heredoc — `open('/tmp/scratch/x.mjs')` graded `code` while the
		// identical `echo x > /tmp/scratch/x.mjs` did not. One rule, every route.
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

	// Only the command's own line carries its arguments. A heredoc body is the
	// data being written, and every path-looking word in it belongs to the file
	// being authored, not to files the command reads.
	//
	// splitCommandWords is QUOTE-AWARE, so a `>` inside a quoted argument is
	// data rather than a redirection. The regex it replaced fabricated a file
	// write for `git commit -m "fix > bug"` — and because path-derived
	// categories outrank command names, that turn was reported as `code`
	// instead of `git` (#106 review round 2, High/correctness).
	const { words, writes, reads } = splitCommandWords(cmd);

	// A redirection into a path is a write, whatever opened it — this is what
	// makes `cat > bin/x.ts <<'EOF'` a code write rather than a `cat` read.
	const written = new Set<string>();
	for (const p of writes) {
		if (!p || NOT_A_REPO_FILE.test(p) || !PATHLIKE.test(p)) continue;
		files.push({ path: p, action: "write" });
		written.add(p);
	}

	const isEdit = IN_PLACE_EDIT.test(cmd);
	if (!FILE_READER.test(cmd) && !isEdit) return;

	// An input redirection is a READ of that file, never a write. `tee out <
	// /dev/null` recorded /dev/null as written, graded as an extensionless
	// `code` file, which turned shell noise into a code turn (round 1, Low).
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
// PATH -> CATEGORY (#52, extracted in #106)
//
// The single place a file path becomes a category. Extracted so a file touched
// through BASH classifies exactly as one touched through Read/Edit — `sed -n
// 300,350p bin/wtft.ts` is a read of a source file however it was spelled, and
// the corpus measured that spelling as the largest single slice of "other".
// A second copy of these rules would be a second place for them to drift.
// ---
/** Resolve a set of file touches to one category, or null when none apply. */
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

	return null;
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

	const viaToolFiles = classifyByFilePaths(interaction.files);
	if (viaToolFiles) return viaToolFiles;

	// Tool-implied categories (#52, extended #106) — priority: agents (spawn cost
	// dominates) > web (joins #73 request-cost billing) > git > plan > grep. Sits
	// below file ops (a turn that edits AND spawns is still the edit) and above
	// bash commands. `git` joined for the worktree tools, at the same rank its
	// bash commands hold relative to plan and grep.
	if (interaction.toolCats && interaction.toolCats.length > 0) {
		for (const cat of ["agents", "web", "git", "plan", "grep"] as Category[]) {
			if (interaction.toolCats.includes(cat)) return cat;
		}
	}

	if (interaction.commands.length > 0) {
		// Every real command the turn ran, not just the first (#106). A compound
		// command is classified on all of it: `until <cond>; do sleep 15; done;
		// gh pr checks 277` is git work, and the old first-command-only read saw
		// only the loop header.
		const real = interaction.commands.flatMap(cmd => extractRealCommands(cmd));

		let isGit = false;
		let isGrep = false;
		let isAgents = false;
		let isTests = false;
		let isCode = false;
		let isSpec = false;
		for (const normalized of real) {
			// EVERY family is tested against the lowercased form. Testing the
			// raw string made `Git status` and `Bun test` fall through to
			// `other` — a regression against the case-insensitive behaviour this
			// branch inherited (#106 review round 2, Low/correctness).
			//
			// …and against the command's HEAD, not its heredoc body: the body is
			// attached to its opener, so `cat <<'EOF' … claude -p … EOF` read as
			// an agent spawn when the text was only data (round 3).
			const lower = normalized.split("\n", 1)[0]!.toLowerCase();
			if (CLAUDE_SPAWN.test(lower)) isAgents = true;
			// The two `gh` carve-outs are tested BEFORE GIT_COMMAND, which also
			// matches `gh` — order is the whole mechanism here (#106 D1).
			else if (GH_SPEC.test(lower)) isSpec = true;
			else if (GH_SEARCH.test(lower)) isGrep = true;
			else if (GIT_COMMAND.test(lower)) isGit = true;
			else if (TEST_RUNNER.test(lower)) isTests = true;
			else if (BUILD_COMMAND.test(lower)) isCode = true;
			else if (/^(?:grep|rg|ripgrep|find|fd|ag|ack)(?:\s|$)/.test(lower)) isGrep = true;
		}
		// Priority: a spawn's cost dominates the turn; git is the workflow the
		// turn is performing; tests/code are what it is performing it ON; grep is
		// the weakest signal because it is so often incidental to another job.
		//
		// `spec` outranks `git` because it is the MORE SPECIFIC reading of the
		// same command — `gh issue view` matches both, and the whole point of
		// the D1 carve-out is that issue work was drowning the git bar. A turn
		// that reads an issue AND runs a git command is counted as reading the
		// issue; before D1 it was counted as git either way, so nothing that
		// used to read as spec now reads as git.
		if (isAgents) return "agents";
		if (isSpec) return "spec";
		if (isGit) return "git";
		if (isTests) return "tests";
		if (isCode) return "code";
		if (isGrep) return "grep";
		// `real` empty means every command was navigation or an assignment — a
		// turn that RAN something but did no work. Fall through rather than
		// returning "other" here, so a narrated `cd` reaches the prompt rule and
		// is counted as the reply it is. #63 has stripped `cd` from
		// classification since it landed; this is the same rule, applied to the
		// whole turn instead of to one command (#106 review, Medium/reasoning).
		if (real.length > 0) return "other";
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

/** What the harness writes beside every built-in (Task) subagent transcript.
 *
 *  TWO fields are universal and are what makes a meta a meta; the rest are
 *  optional because the corpus says so, not because it felt safer.
 *
 *  Re-measured 2026-09-17 with a RECURSIVE walk of `~/.claude/projects` — the
 *  earlier census globbed two path segments then `subagents/`, which cannot
 *  reach `subagents/workflows/wf_<id>/` — that is how four fields came to look
 *  universal:
 *    corpus 493 files, zero unparseable
 *    `agentType`   493/493   <- universal
 *    `spawnDepth`  493/493   <- universal
 *    `description` 445/493   absent on Dynamic Workflow children
 *    `toolUseId`   445/493   absent on the same 48
 *    `model`       437/493
 *    `parentAgentId` 25/493  — on exactly the files with `spawnDepth > 1`
 *  The 48 that carry only `{agentType, spawnDepth}` are the whole reason the
 *  required set is two and not four. */
export interface SubagentMeta {
	agentType: string;
	spawnDepth: number;
	/** Absent on workflow children — see the census above. */
	description?: string;
	/** Absent on workflow children — see the census above. */
	toolUseId?: string;
	model?: string;
	parentAgentId?: string;
	isFork?: boolean;
}

/** The `.meta.json` beside a subagent transcript, or `null` (#137).
 *
 *  WHY THIS EXISTS. #116 built a spawn ledger on the premise that "neither
 *  transcript names the other and there is nothing to re-derive afterwards".
 *  That is true of launcher-spawned children and has never been true of built-in
 *  subagents: the harness has been writing `toolUseId` — the exact `tool_use`
 *  block in the parent — to disk beside every one of them, and we inferred the
 *  link from directory position instead. `description` is the other half: it is
 *  the words a human typed at dispatch, which is the difference between a cost
 *  report and a hex dump.
 *
 *  WHY IT NEVER THROWS, AND NEVER PARTIALLY SUCCEEDS. This is UNDOCUMENTED
 *  harness output. It may vanish, gain fields or be renamed in any release, so
 *  every failure — absent, unreadable, unparseable, wrong shape — returns `null`
 *  and the caller renders exactly what it rendered before #137. A meta missing
 *  one required field is `null` rather than a half-filled record, because a
 *  report row labelled from a partial record is worse than one labelled from a
 *  hash: it looks authoritative.
 *
 *  The optional fields are genuinely optional. `model` is absent from **56 of
 *  493** files on this host — 11.4%, on the RECURSIVE census the interface
 *  above uses. So a caller gets `undefined` there and must have an arm for it:
 *  a null is a gap, not a zero.
 *
 *  This line read "20 of 439" (4.6%) until review round 2. That was the narrow
 *  glob's corpus, which the interface docstring a few lines up already said was
 *  superseded — two numbers for one fact in one file, and the smaller one made
 *  the field look far more reliable than it is.
 *
 *  `tests/wtft-137-subagent-meta.test.ts` pins the names in TWO halves, because
 *  one test cannot do both jobs. M7a pins the READER's expected names against
 *  our own fixture — it catches a wtft-side edit and says nothing about the
 *  harness. M7b pins the HARNESS's names against the NEWEST real `.meta.json`
 *  on this host, and is the only half that can see a rename; it is host-gated
 *  and SKIPS VISIBLY where there is no `~/.claude`, so CI does not check it.
 *
 *  An earlier docstring here claimed a single M7 made a harness rename "fail
 *  that suite loudly". It could not: it wrote its own fixture using the current
 *  names, so a rename changed both sides together. The test file retracted that
 *  in review round 2 and this sentence was left pointing at the retracted
 *  claim — which is the same drift, one artifact over. */
export function readSubagentMeta(transcriptPath: string): SubagentMeta | null {
	if (!transcriptPath.endsWith(".jsonl")) return null;
	const metaPath = transcriptPath.slice(0, -".jsonl".length) + ".meta.json";
	let raw: string;
	try {
		raw = fs.readFileSync(metaPath, "utf8");
	} catch {
		// Absent is the ORDINARY case — Pi and shell children have none — but this
		// catch also swallows EACCES, EIO and EISDIR, and the caller cannot tell
		// them apart. `null` is documented to consumers as "this harness wrote no
		// record", so an unreadable file currently reports a confident absence.
		// Narrowing it needs a new `notices[]` code, which is additive under
		// `wtft/session@1`; filed rather than smuggled into this branch.
		return null;
	}
	let obj: unknown;
	try {
		obj = JSON.parse(raw);
	} catch {
		return null;
	}
	if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
	const o = obj as Record<string, unknown>;

	// TWO required fields, checked for TYPE and not merely for presence —
	// `spawnDepth: "1"` is a harness change, not a depth.
	//
	// It was FOUR until the local audit round. The census that justified four
	// globbed two path segments then `subagents/`, which cannot reach
	// `subagents/workflows/wf_<id>/` — so it never saw the Dynamic Workflow
	// children, which carry only `{agentType, spawnDepth}`. The spec even
	// flagged the files the glob missed and then derived the rule from the rest.
	// Those missed files are EXACTLY the ones the rule rejected.
	//
	// The cost was not a stricter reader. It was a WRONG ANSWER: every failure
	// here returns `null`, and `null` is defined for consumers as "this harness
	// wrote no record". Measured on one real session, 30 of 33 children reported
	// no metadata with the file sitting on disk, readable, carrying two usable
	// fields. Requiring what the corpus actually makes universal keeps the
	// label where there is one and stops inventing absences where there are not.
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
): { files: string[]; unreadable: Error | null } {
	const files: string[] = [];
	const sessionDir = path.dirname(sessionPath);
	const sessionBase = path.basename(sessionPath, ".jsonl");

	// Round 7: one report slot for BOTH halves. The walk reports per-entry
	// stat failures and the Pi half reports per-file read failures; whichever
	// happens first wins, which is all the caller's fail-safe needs.
	let firstUnreadable: Error | null = null;

	// Pattern 1: Claude Code recursive convention. Round 6: the existsSync
	// gate was a silent boundary — a stat error (chmod-000 <base>/subagents,
	// an untraversable ancestor) returned false, so the whole walk was
	// skipped with no warning and the swept marker could stamp over the
	// missing costs. ENOENT is the absent case and stays silent (no Pattern-1
	// subagents); any OTHER stat error is a read failure, same dir-level rule
	// as the walk's own catch below: warn once per dir per process and throw.
	// Round 10 (macroscope, Medium): ENOTDIR joins the absent class — it
	// means an ancestor of <base>/subagents is a REGULAR file, so no
	// subagent can exist below it; branding that a read failure had the
	// daemon withhold the swept marker over a plain file name collision.
	const ccBaseDir = path.join(sessionDir, sessionBase, "subagents");
	try {
		const ccStat = fs.statSync(ccBaseDir);
		if (ccStat.isDirectory()) {
			// Round 7 — the walk now RETURNS its first per-entry stat failure
			// instead of only warning (see walkSubagentDir): report it here so
			// the caller's fail-safe stays honest — the daemon withholds the
			// swept marker, the CLI degrades to the subagent-unreadable reason.
			const walkErr = walkSubagentDir(ccBaseDir, 1, maxDepth, files);
			if (walkErr && !firstUnreadable) firstUnreadable = walkErr;
		}
	} catch (err) {
		// #457 (round 6) — the statSync gate's catch also sees the walk's
		// throws, and every throw out of walkSubagentDir already carries the
		// "subagents directory could not be read (" prefix AND was warned
		// (latched) by the walk frame that failed — its message names the
		// innermost failing dir, which is the one that matters. Rethrow those
		// unchanged: re-wrapping here would double-warn AND name the outer
		// ccBaseDir, which may be perfectly readable. Only the statSync-gate
		// failure itself (no prefix) is new to this catch: warn once per dir
		// per process and throw, the dir-level rule everywhere else.
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

	// Pattern 2: Pi parentSession convention (pre-emptive, non-recursive —
	// Pi subagents would each get their own discoverSubagentSessionFiles call
	// if they are themselves discovered as subagent files)
	let mainSessionId: string | undefined;
	let mainHeaderRaw: string | null = null;
	try {
		mainHeaderRaw = fs.readFileSync(sessionPath, "utf8");
	} catch (err) {
		// #457 (round 7) — the round-4 comment claimed the caller's own read
		// of the main file is "loud about the same failure"; it is not, on
		// either path it named. The daemon's main-session read is
		// parseNewLines, whose catch silently returns [] — an unreadable main
		// session file stalls the daemon with zero signal; the CLI never
		// parses the main session file at all (it reads the tag). A READ
		// failure here also means Pattern-2 discovery cannot run, so every Pi
		// sibling's cost is silently missing from the same discovery — the
		// #457 class. Warn + report it like any other discovery-boundary read.
		warnUnreadableTranscript(sessionPath, "at discovery", err, "the session transcript");
		if (!firstUnreadable) {
			firstUnreadable = new Error(
				`session transcript could not be read at discovery (${sessionPath}): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	if (mainHeaderRaw !== null) {
		try {
			const mainHeader = JSON.parse(mainHeaderRaw.split("\n")[0]);
			if (mainHeader.type === "session") mainSessionId = mainHeader.id;
		} catch {
			// #457 (round 6/7) — a header that cannot PARSE (empty file,
			// partial crash header) is skipped silently, the same carve-out
			// as the per-line JSON swallow: it can never declare an id, so
			// Pattern-2 siblings can never be matched to it. This is a broken
			// MAIN file, not an unreadable one — warning here would brand the
			// session's own transcript "unreadable" and withhold the marker
			// over a file whose cost the daemon's own parse already misses.
			// Only the READ failure above is reported.
		}
	}

	if (mainSessionId) {
		// #457 (round 5/6) — this half of discovery was the last silent boundary
		// of the unreadable-transcript class: an unreadable Pi-pattern sibling
		// was skipped with no warning and never reached the loud parse path, so
		// its cost vanished from the tag and the swept marker stamped over it.
		// Same rule as the claude half: warn once per file per process, collect
		// the first failure, and REPORT it in the result after the scan (round
		// 6 — the round-5 throw discarded the readable siblings collected
		// alongside it, so one unreadable file starved the whole subtree every
		// poll; the report keeps partial progress). Callers route the failure
		// (the daemon syncs the readable files and withholds the marker via
		// pollHadFailure; the TUI/CLI degrade). A failure here is never
		// recorded as discovered, so attribution recovers when readability
		// returns. (firstUnreadable itself is hoisted to the function top —
		// the walk's per-entry failures and the main-header read failure also
		// report into it.)
		try {
			// Round 10 (macroscope, Medium): readdirSync's bare names let a
			// DIRECTORY named *.jsonl through to readFileSync, whose EISDIR the
			// outer catch mislabeled "could not be read at discovery" — a dir
			// can never declare parentSession or hold cost, yet the daemon
			// withheld the swept marker forever over it. withFileTypes skips
			// the dir class outright; symlinks keep flowing to readFileSync
			// (it follows), matching the claude half's walk, where statSync
			// follows symlinks too — a symlink to a transcript is a
			// transcript.
			for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
				const f = entry.name;
				if (!f.endsWith(".jsonl")) continue;
				if (entry.isDirectory()) continue;
				const fullPath = path.join(sessionDir, f);
				if (fullPath === sessionPath) continue;
				if (files.includes(fullPath)) continue;
				try {
					const raw = fs.readFileSync(fullPath, "utf8");
					let header: unknown = null;
					try {
						header = JSON.parse(raw.split("\n")[0]);
					} catch {
						// #457 (round 6) — a header that cannot PARSE (empty
						// file, partial crash header, a non-transcript
						// .jsonl) is skipped silently, same rule as the
						// claude half's per-line JSON swallow: it can never
						// declare parentSession, so it can never contribute
						// cost to this session. Warning here would brand a
						// harmless sibling "unreadable" and withhold the
						// marker forever over nothing — the per-file report
						// below is for READ failures only, where cost may
						// genuinely be missing.
						continue;
					}
					// Round 11 (macroscope): the parse above can succeed with
					// runtime null (the literal `null` is valid JSON), which a
					// cast does not change — optional access keeps that
					// harmless sibling on the same silent-skip path.
					const h = header as { type?: string; parentSession?: string };
					if (h?.type === "session" && h.parentSession === mainSessionId) {
						files.push(fullPath);
					}
				} catch (err) {
					warnUnreadableTranscript(fullPath, "at discovery", err);
					if (!firstUnreadable) {
						firstUnreadable = new Error(
							`subagent transcript could not be read at discovery (${fullPath}): ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}
		} catch (err) {
			// Dir-level, same rule as walkSubagentDir: an unreadable session
			// dir drops every Pi-pattern sibling under it. Warn once per dir
			// per process and throw.
			warnUnreadableSubagentDir(sessionDir, err);
			throw new Error(`subagent sibling directory could not be read (${sessionDir}): ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (firstUnreadable) {
		// #457 (rounds 6/7) — report, not throw: the readable files collected
		// by either half are returned alongside the failure instead of being
		// discarded with it. An unreadable sibling's parentSession header was
		// never checkable, so it might BE this session's subagent — and an
		// unreadable walk entry or main-session header means the same: cost
		// may genuinely be missing. The caller owns the fail-safe — the
		// daemon syncs the readable files and still withholds the swept
		// marker (pollHadFailure), the CLI/TUI use the readable files and
		// degrade loudly.
		return { files, unreadable: firstUnreadable };
	}

	return { files, unreadable: null };
}

/** Recursively walk a subagent directory, collecting agent-*.jsonl files.
 * Subagent directories are named agent-<hash>/ and may contain their own
 * subagents/ subdirectory (Claude Code nested subagent convention).
 *
 * Returns the FIRST per-entry stat failure encountered (its own or a nested
 * frame's), or null when every entry was stat-able — see the per-entry catch
 * for why that class is REPORTED rather than thrown like the dir-level
 * readdir failures below. */
function walkSubagentDir(
	dir: string,
	depth: number,
	maxDepth: number,
	files: string[],
): Error | null {
	if (depth > maxDepth) return null;
	let frameErr: Error | null = null;
	try {
		for (const f of fs.readdirSync(dir)) {
			const fullPath = path.join(dir, f);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(fullPath);
			} catch (err) {
				// #457 (rounds 6/7) — the prose claimed "no silent-skip
				// boundary left"; a per-entry stat failure was still one. The
				// honest carve-out: an entry that no longer exists (ENOENT —
				// deleted between readdir and stat) or cannot be a transcript
				// (ELOOP) holds no cost to miss, and the next poll re-lists;
				// every OTHER stat failure (EACCES, EIO) means a
				// possibly-costly entry became unreadable — warn once per
				// file per process, keep walking (the dir itself is readable;
				// the readable siblings still land in `files`), and return
				// the first such failure up the frame chain. Round 6's
				// warn-only left the caller's fail-safe blind: the daemon
				// stamped the swept marker and the CLI stayed exit 0 with
				// that entry's cost missing from the token table. Reporting
				// closes it — the daemon withholds via pollHadFailure, the
				// CLI degrades to the subagent-unreadable reason.
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
					// #457 (round 5) — the recursion sits OUTSIDE the per-entry
					// stat try: a nested unreadable directory's readdir throw
					// must reach the outer catch below (and the caller's
					// pollHadFailure), not be swallowed as a stat failure.
					// Round 4's dir-level warning only ever fired for TOP-LEVEL
					// unreadable dirs for exactly this reason, yet the nested
					// layout (agent-<hash>/subagents/, workflows/wf_<runId>/)
					// is this walk's own documented norm. Round 7 — a nested
					// frame's REPORTED per-entry failure (not a throw) rides
					// up through the return value.
					const childErr = walkSubagentDir(fullPath, depth + (f === "subagents" || f === "ns" ? 1 : 0), maxDepth, files);
					if (childErr && !frameErr) frameErr = childErr;
				}
			} else if (f.startsWith("agent-") && f.endsWith(".jsonl")) {
				files.push(fullPath);
			}
		}
	} catch (err) {
		// #457 (round 4) — the dir-level readdir catch was the last silent
		// boundary of the unreadable-transcript class: an unreadable subagents
		// DIRECTORY drops every Task/agent cost under it, and in the daemon the
		// swept marker would still stamp over the loss. Warn once per dir per
		// process and throw; callers route the failure (the daemon sets
		// pollHadFailure, the TUI/CLI degrade to the latched warning).
		//
		// Round 5 — a throw from a NESTED frame is already warned (by that
		// frame, latched on the nested dir's path): rethrow it unchanged so
		// the dir named in the message is the one that failed, not this one.
		if (err instanceof Error && err.message.startsWith("subagents directory could not be read (")) {
			throw err;
		}
		warnUnreadableSubagentDir(dir, err);
		throw new Error(`subagents directory could not be read (${dir}): ${err instanceof Error ? err.message : String(err)}`);
	}
	return frameErr;
}

// #457 (round 4) — the unreadable-transcript warnings in this file are latched
// per file per process, like the daemon's warned* sets. These sites run on
// every daemon poll and on every TUI widget refresh, so an unlatched warning
// would re-print once per refresh for as long as the file stays unreadable —
// its own noise floor.
const warnedUnreadableFile = new Set<string>();

/**
 * Warn once per unreadable transcript per process, naming the file. `phase`
 * is what failed: "at discovery" (the head-scan read) or "or parsed" (the
 * whole-file parse). The "or parsed" phrasing is load-bearing: the daemon's
 * parse warning and the #457 tests anchor on "could not be read or parsed".
 * `what` names the file's role in the sentence — the main session file is
 * "the session transcript", everything else "a subagent transcript" (round 7,
 * PR review, Low/correctness: the old fixed noun mislabelled the main file).
 * Exported since round 9: the daemon's own read of the MAIN session file
 * (parseNewLines) reuses it, so the daemon's last silent read boundary emits
 * the same warning style the discovery read does. The latch is shared, so
 * when discovery and parseNewLines both fail on the same poll, one warning
 * is printed and the other is suppressed — which one is timing-dependent
 * and irrelevant; they say the same thing.
 */
export function warnUnreadableTranscript(file: string, phase: "at discovery" | "or parsed", err: unknown, what = "a subagent transcript"): void {
	if (warnedUnreadableFile.has(file)) return;
	warnedUnreadableFile.add(file);
	process.stderr.write(
		`[wtft-log-parser] WARNING: ${what} could not be read ${phase}, so its cost may be missing from this session's total (${file}): ${err instanceof Error ? err.message : String(err)}\n`,
	);
}

/**
 * Warn once per unreadable subagent DIRECTORY per process, naming the dir
 * (round 4). An unreadable directory drops every transcript under it, so the
 * skip must be loud — the accompanying throw is how callers route the failure
 * (the daemon sets pollHadFailure and withholds the swept marker; the TUI/CLI
 * degrade to this warning).
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
 * PROVENANCE, not the envelope, settles the Cache Miss divider (#115).
 *
 * Claude Code stamps `isSidechain` on every turn of a subagent transcript, so
 * the parse-time gate in `parseEntryToInteraction` already catches those. Pi
 * does not: it marks a subagent at FILE level, with a `parentSession` header and
 * no per-entry flag (Pattern 2 in `discoverSubagentSessionFiles`), and nothing
 * stamps the nested `subagents/workflows/wf_<id>/` layout either. Every
 * interaction that came out of a subagent transcript had a fresh context
 * whatever its harness writes in the envelope, so read-0 / write-everything is
 * how it began rather than something it lost.
 *
 * THIS IS A SEAM, NOT A ONE-LINER, because two readers of subagent transcripts
 * exist and only one of them is `loadSubagentInteractions` (PR review round 2):
 * the daemon's `syncSubagentTranscript` parses and serializes its own tag lines,
 * and the CLI renders from the TAG FILE. Clearing this in only one of them would
 * leave `miss: 1` baked into the tag file and make the Pi widget and the CLI
 * disagree about the same session.
 *
 * Only the divider's flag is cleared. `isSidechain` itself also gates
 * `splitOverheadCost`'s recache detection, and setting it from provenance would
 * move subagent interactions between overhead buckets — a bigger change than
 * this issue, and one that belongs with the subagent-accounting work (#15).
 *
 * Mutates in place and returns the same array, for use as a pass-through.
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
	const interactions: Interaction[] = [];
	for (const file of subagentFiles) {
		try {
			const raw = parseFn(file);
			const deduped = dedupFn(raw);
			clearSubagentCacheMiss(deduped);
			for (const interaction of deduped) {
				interaction._cat = classifyFn(interaction);
				interactions.push(interaction);
			}
		} catch (err) {
			// #457 — a nested parse throw drops the WHOLE file's cost here, so
			// the skip must not be silent: the daemon's parse handler is loud
			// about the same failure, and the CLI/TUI path deserves the same.
			// Same class phrase, file named, latched per file per process (the
			// TUI re-reads interactions on every widget refresh).
			warnUnreadableTranscript(file, "or parsed", err);
		}
	}
	return interactions;
}

// ---
// CLAUDE BASH SUB-AGENT DISCOVERY (#138)
// When a parent session spawns `claude -p` via a bash command, discover the
// sub-agent's session file and attribute its tokens to the parent turn.
// ---

const CLAUDE_SUBAGENT_WINDOW_MS = 15_000; // ±15s window for timestamp matching

/** The directory a bash command's `claude -p` spawn ran in.
 *
 *  Returns the LAST `cd` target at or before the spawn — the one in effect when
 *  it ran — or null when there is no `cd`, or when the target cannot be known.
 *  Handles `cd /path && …`, `cd "/path" && …`, a `cd` that is not the first
 *  command, and one inside a loop body.
 *
 *  `A || B` runs B only when A failed, so a `cd` to the right of `||` is a
 *  FALLBACK and the first of the chain is kept. `$( … )` returns null rather
 *  than a guess: the directory is invented at runtime, so any string would be
 *  certain to be wrong, and the daemon treats a wrong directory far worse than
 *  an unknown one. */
export function extractCwdFromBashCommand(cmd: string): string | null {
	// #106 review (Medium/correctness): this read only the FIRST line and only a
	// command STARTING with `cd`, while `hasClaudeCommand` was widened to find a
	// `claude -p` anywhere in a compound or inside a loop body. The two must
	// agree, because the daemon drops an interaction outright when the cwd comes
	// back null (`if (!cwd) continue`) — so a detection the extractor cannot
	// follow loses that subagent's whole cost, which is the exact failure #3
	// exists to prevent. Scan every segment for the LAST `cd` before the spawn,
	// which is the directory the spawn actually ran in.
	let found: string | null = null;
	// "The segment immediately before this one was a `cd` I kept" — NOT "a cd
	// appeared somewhere earlier". The weaker flag made any right-hand `cd` look
	// like the fallback of an earlier chain: in `cd /a && false || cd /b`, the
	// shell runs `cd /b` because `false` failed, and the stale flag suppressed it
	// (#106 review round 3, High/crossfile).
	let prevWasKeptCd = false;
	for (const { text, joinedBy } of extractJoinedSegments(cmd)) {
		const bare = stripCommandPrefixes(text);
		// Match against the command's HEAD only. A heredoc body is attached to
		// the segment that opened it, so testing the whole segment let a `claude
		// -p` that is merely DATA inside a heredoc read as a spawn (round 3,
		// Medium/crossfile).
		const head = bare.split("\n", 1)[0]!;
		// STOP at the spawn. The directory that matters is the one in effect when
		// `claude -p` ran; a `cd` AFTER it is where the shell went next, and
		// `claude -p 'x'; cd /elsewhere` was returning `/elsewhere` (round 2).
		if (CLAUDE_SPAWN.test(head.toLowerCase())) break;
		const m = head.match(/^cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/);
		if (!m) { prevWasKeptCd = false; continue; }
		// `A || B` runs B only when A FAILED, so a `cd` on the right of `||` is a
		// FALLBACK of the `cd` before it. Keep the first of such a chain.
		//
		// This is not a nicety. The real shape in the corpus is
		//   cd <scratchpad> 2>/dev/null || cd /tmp
		//   timeout 180 claude -p "…"
		// and reading it as "last cd wins" returned /tmp, so discovery looked in
		// the wrong project directory and a real subagent's $0.38 vanished from
		// the session total. Caught by the totals invariant in
		// research/other-corpus/before-after.ts, not by a unit test.
		if (joinedBy === "||" && prevWasKeptCd) continue;
		prevWasKeptCd = true;
		const target = m[1] || m[2] || m[3] || "";
		// A target the shell EXPANDS cannot be known statically — `cd $(mktemp
		// -d)` is a fresh temp dir, and `cd $SCRATCH` is whatever that variable
		// held. Checked on the EXTRACTED value so every spelling is caught at
		// once: `$(…)`, backticks, `$VAR`, `${VAR}`, and the quoted forms of all
		// of them, which the double-quote arm of the regex hands back as though
		// they were literal directories (#106 review rounds 3 and 4).
		//
		// Returning a wrong-but-non-null string is the WORST option: the daemon
		// accepts it, stats a path that cannot exist, and re-queues the
		// interaction every poll while the subagent's whole cost goes missing —
		// permanently, and with nothing raising a failure. Unknown must read as
		// unknown, because null makes the caller take a safe path and a bad
		// string makes it take a confident wrong one.
		// KEEP whatever was already found rather than clearing it. An earlier cut
		// set `found = null` here, so `cd /repo; cd "$MISSING"; claude -p 'go'`
		// threw away the perfectly good `/repo` and dropped the subagent — an
		// over-correction of the round-4 fix, and the shape occurs ~35 times in
		// the corpus (#108 review). With no earlier cd, `found` is already null,
		// so the unknown-reads-as-unknown contract is unchanged.
		if (/[$`]/.test(target)) continue;
		found = target || found;
	}
	return found;
}

/**
 * The cwd of the bash command that actually contains the `claude -p` spawn.
 *
 * Each entry in `interaction.commands` is a SEPARATE Bash tool call with its own
 * shell, so a `cd` in one entry says nothing about the working directory of a
 * spawn in another. Both callers previously walked the flat list and took the
 * first entry yielding any cwd at all, which for `['cd /a', 'claude -p "go"']`
 * ran discovery against `/a` — a directory the spawn never saw (#106 review
 * round 3, High/crossfile). Ask the command that did the spawning.
 */
export function cwdForClaudeSpawn(commands: string[]): string | null {
	for (const cmd of commands) {
		if (!commandSpawnsAgent(cmd)) continue;
		const cwd = extractCwdFromBashCommand(cmd);
		if (cwd) return cwd;
	}
	return null;
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
): { files: string[]; unreadable: Error | null } {
	const slug = cwdToClaudeProjectSlug(cwd);
	const projectDir = path.join(os.homedir(), '.claude', 'projects', slug);
	try {
		const projectStat = fs.statSync(projectDir);
		if (!projectStat.isDirectory()) return { files: [], unreadable: null };
	} catch (err) {
		// #457 (round 6) — existsSync swallowed stat errors: EACCES on an
		// unreadable ancestor of the projects dir (or ENOTDIR/ELOOP) returned
		// false, so an unreadable projects tree was indistinguishable from an
		// absent one — no warning, no report, no pollHadFailure, and the swept
		// marker stamped over the whole claude -p subtree's missing cost.
		// ENOENT is the absent case and stays silent; every other stat error
		// is a read failure, same dir-level rule as the readdirSync catch
		// below: warn once per dir per process and throw.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { files: [], unreadable: null };
		warnUnreadableSubagentDir(projectDir, err);
		throw new Error(`claude subagent projects directory could not be read (${projectDir}): ${err instanceof Error ? err.message : String(err)}`);
	}

	const files: string[] = [];
	const tsWindowStart = parentTimestamp - windowMs;
	const tsWindowEnd = parentTimestamp + windowMs;
	// First unreadable candidate, for the unreadable report at the end (round
	// 5 — the report replaces the throw, so the readable matches are returned
	// alongside the failure instead of being discarded with it). Collecting
	// every failure (rather than failing on the first) means one poll surfaces
	// ALL unreadable files in the dir, each warned once, instead of the loop
	// dying on candidate #1 and hiding the rest behind a perpetual retry.
	let firstUnreadable: Error | null = null;

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
			} catch (err) {
				// #457 (round 4, M2) — the discovery read is a read, and an
				// unreadable candidate must not be silently skipped. That is
				// the COMMON case for the unreadable-transcript scenario (a
				// file is readable or it is not; the discovery→parse race is
				// the rare one), and a silent skip stamps the swept marker
				// with the parent turn's attribution missing, never recovered
				// — the candidate is also never matched to its timestamp
				// window, so it might BE this command's transcript. Warn once
				// per file per process and report the failure in the result
				// (round 5): the caller owns the consequences — the daemon
				// registers the readable matches, withholds the swept marker,
				// and retries next poll; the attribution pass throws, keeping
				// the CLI/TUI loud. A failure here is also never recorded as
				// "discovered", so the attribution is recovered when
				// readability returns.
				warnUnreadableTranscript(fullPath, "at discovery", err);
				if (!firstUnreadable) {
					firstUnreadable = new Error(
						`subagent transcript could not be read at discovery (${fullPath}): ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
	} catch (err) {
		// #457 (round 4) — same dir-level rule as walkSubagentDir: an
		// unreadable ~/.claude/projects/<slug>/ drops every candidate under it
		// (and the daemon's marker would stamp over the loss). Warn once per
		// dir per process and throw; the daemon's discovery catch withholds
		// the marker and retries next poll.
		warnUnreadableSubagentDir(projectDir, err);
		throw new Error(`claude subagent projects directory could not be read (${projectDir}): ${err instanceof Error ? err.message : String(err)}`);
	}

	if (firstUnreadable) {
		// #457 (round 5) — the readable in-window matches are NOT discarded
		// with the failure. ~/.claude/projects/<slug>/ is SHARED across many
		// sessions, so an unreadable candidate is usually a different
		// session's transcript; the old throw stalled every pending claude -p
		// command sharing the cwd — their costs permanently missing while the
		// unreadable file stayed, every poll re-reading everything. Return the
		// matches and the error together; the caller owns the fail-safe: the
		// candidate's timestamp window was never checkable, so it might BE
		// this command's transcript — the daemon registers the readable
		// matches and still withholds the swept marker (pollHadFailure), the
		// attribution pass throws, keeping the CLI/TUI loud.
		return { files, unreadable: firstUnreadable };
	}

	return { files, unreadable: null };
}

/** Check if any command in an interaction invokes `claude` as a sub-agent.
 *  Uses the same regex as classifyInteraction's claude detection. */
function interactionHasClaudeCommand(interaction: Interaction): boolean {
	// Every real command, not just the primary one (#106): normalizeCommand now
	// returns the FIRST command alone, so a `claude -p` chained after another
	// command would be invisible to it — and missing one loses that subagent's
	// entire cost.
	// The command's HEAD, not the whole segment: a heredoc body is attached to
	// the command that opened it, so `cat <<'EOF' … claude -p "x" … EOF` matched
	// a spawn that is only DATA, classified the turn `agents`, and enqueued a
	// phony subagent (#106 review round 3, Medium/crossfile).
	return interaction.commands.some(commandSpawnsAgent);
}

/** Post-processing pass: for each interaction that spawns `claude -p` via bash,
 *  discover the sub-agent session files, parse them, and add their token
 *  totals to the parent interaction. Mutates interactions in place.
 *
 *  Sub-agent session IDs are tracked for the duration of THIS CALL only, to
 *  prevent double-counting across multiple interactions within the same
 *  array that reference the same session — `seenSessionIds` is a local Set,
 *  not a module-level one, so it carries no memory between calls. Calling
 *  this function more than once over slices of what should be one file (e.g.
 *  one poll batch at a time) re-attributes the same nested session's cost
 *  once per call (#420 — see docs/wtft-incremental-render-spec.md, "Per-Call,
 *  Not Global", and tests/wtft-420-subagent-call-site.test.ts, which pins
 *  this function to its single whole-file call site). */
export function attributeClaudeSubAgentCosts(
	interactions: Interaction[],
): void {
	const seenSessionIds = new Set<string>();

	for (const interaction of interactions) {
		if (!interactionHasClaudeCommand(interaction)) continue;
		// Already attributed by a prior call (e.g. parseSessionFile did it
		// internally, and the CLI is doing a post-hoc pass on tag-file data)
		if ((interaction as any).claudeSubAgentSessionIds) continue;

		// The cwd must come from the command that DID the spawning — each
		// `commands` entry is its own Bash call with its own shell (#106 review
		// round 3, High/crossfile).
		const cwd = cwdForClaudeSpawn(interaction.commands);
		if (!cwd) continue;

		const subAgentResult = discoverClaudeSubAgentSessionFiles(
			cwd, interaction.timestamp,
		);
		// #457 (round 5) — discovery no longer throws for a per-file failure:
		// it returns the readable matches alongside the report, because
		// ~/.claude/projects/<slug>/ is shared across many sessions and an
		// unreadable candidate is usually a different session's transcript.
		// THIS pass has no cross-session ambiguity to absorb: the parent turn
		// is this transcript's own command, its cost must land or the report
		// is silently incomplete. Throw — the caller keeps the CLI/TUI loud
		// (and the daemon's discovery path, which does NOT call this function,
		// has its own registration-side rule).
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

			// #457 — the nested read is a read: parseSessionFile throws when a
			// nested transcript is unreadable (EACCES, EISDIR, vanished between
			// discovery and read), and that propagates to the caller instead of
			// attributing a silent zero. The caller owns the consequences — the
			// daemon's parse handler warns, sets pollHadFailure (the swept
			// marker is withheld), and retries next poll; loadSubagentInteractions
			// skips the file, with a warning. The session id is marked seen only
			// after the parse succeeds, so a failure is never recorded as
			// attributed: a later pass retries it instead of skipping it forever.
			// There is no silent discovery boundary to hide behind (round 4):
			// discoverClaudeSubAgentSessionFiles warns and reports an unreadable
			// candidate in its result (round 5), and this pass throws on it
			// (above), so this read sees three failure classes —
			// the transient discovery→parse race (a file that vanished, or
			// became unreadable, between discovery's read and this one); a
			// statically unreadable Task/agent transcript (walkSubagentDir
			// discovers by name and stat only, never a content read); and a
			// registered claude -p transcript re-read every poll whose
			// unreadability was acquired after its one-time registration. All
			// three land here, loudly, and the caller's retry recovers them
			// next poll.
			let subInteractions: Interaction[];
			try {
				subInteractions = parseSessionFile(file);
			} catch (err) {
				// #457 (L5) — name the nested transcript that actually failed,
				// so a caller's warning points at it, not at the healthy outer
				// file whose parse was aborted as a consequence. The OS error
				// usually carries the path (EACCES/ENOENT do; EISDIR does not),
				// so naming it here is the guarantee.
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
 * Session ids whose cost is ALREADY folded into this session's own totals, so a
 * later pass does not add them a second time (#116).
 *
 * Two mechanisms fold a child in before the spawn-ledger walk ever runs:
 * `claude -p` spawns found by cwd and time (#138), and Task children under
 * `<session>/subagents/` (#82/#83). Nothing stops a spawner ALSO recording one
 * of those as a ledger edge — `cd /tmp/x && claude -p --session-id <uuid>` is
 * both — and the tree would then bill it twice, once in `total` and once in
 * `spawned.total`. Billing twice is the expensive direction to be wrong in.
 *
 * DISCOVERY ONLY, never a parse: this walks the same two discoveries the
 * attribution pass uses and keeps the basenames, so it costs directory reads
 * rather than transcript reads. A discovery that fails contributes nothing —
 * a child we cannot even enumerate was not attributed to self either, so the
 * walk treating it as fair game is the correct fallback, not a guess.
 */
export function collectSelfAttributedSessionIds(
	sessionPath: string,
	interactions: Interaction[],
): Set<string> {
	const ids = new Set<string>();

	try {
		for (const file of discoverSubagentSessionFiles(sessionPath).files) {
			ids.add(path.basename(file, ".jsonl"));
		}
	} catch { /* an unreadable subagents dir is reported elsewhere (#457) */ }

	for (const interaction of interactions) {
		// The ids a previous attribution pass recorded, when this array came
		// from a parse rather than from the tag file (the tag does not carry
		// them).
		const recorded = (interaction as any).claudeSubAgentSessionIds as string[] | undefined;
		if (recorded) {
			for (const id of recorded) ids.add(id);
			// The attribution pass already ran on this turn and wrote down what
			// it found, so re-running discovery for it would re-read the same
			// directory for the same answer.
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

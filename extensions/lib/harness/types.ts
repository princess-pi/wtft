/**
 * @package princess-pi-packages
 * @module harness/types
 * @description The two interfaces every harness implements (#156).
 *
 * This file is the seam. Everything on the far side of it — the `Interaction`
 * type, cost calculation, classification, the meter-split, dedup, tag
 * serialization, the daemon loop, and every renderer — is harness-agnostic and
 * must stay that way. A harness contributes exactly two things: where its
 * transcripts live (discovery) and what its entry schema means (parse).
 *
 * Why the parse side normalizes rather than parses whole: the two known schemas
 * differ in ~20 lines of field access inside a ~150-line body whose remainder is
 * identical and heavily tested. Putting cost logic behind the seam would let a
 * new harness get billing wrong. The seam sits between *schema* and *semantics*.
 */

// ---
// DISCOVERY
// ---

/** One discovered session log, ready for the selector. */
export interface SessionCandidate {
	path: string;
	harness: string;
	timestamp: number;   // mtime of file
	name: string;        // basename, e.g. "019f207a-….jsonl"
	displayPath: string; // e.g. "~/g-p/princess-pi-packages/2026-07-02...268a"
}

export interface HarnessDiscovery {
	/** Harness id — equals the directory name under harness/. */
	readonly id: string;
	/** Column label in the selector, e.g. "Claude" / "Pi". */
	readonly label: string;
	/**
	 * Session candidates for a target directory.
	 * @param targetCwd absolute directory to scope to, or null for "no filter"
	 */
	discover(targetCwd: string | null): SessionCandidate[];
	/**
	 * Resolve a session id to its current transcript path, wherever it now
	 * lives. This is the primitive the daemon's follow-on-move needs (#155):
	 * a moved session keeps its id and loses its path.
	 */
	resolveSessionById(sessionId: string): string | null;
}

// ---
// PARSE
// ---

/** Usage in Anthropic-compat field names. Adapters translate into this. */
export interface NormalizedUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number;
	cache_read_input_tokens: number;
	/** Raw cache_creation sub-object for the TTL split (#55), or null. */
	cache_creation: any | null;
	reasoning_tokens: number;
	server_tool_use: { web_search_requests?: number; web_fetch_requests?: number } | null;
	/** Number of agent iterations this turn, when the harness records them. */
	iterations: number | undefined;
	/**
	 * Harness-native per-turn cost, when the harness computes one (Pi does;
	 * Claude Code does not). null → the shared body prices it from tokens.
	 */
	nativeCost: number | null;
}

/** An assistant turn, with schema-specific field locations already resolved. */
export interface AssistantTurn {
	/** Raw assistant message — only `content` is read downstream. */
	content: any[];
	messageId: string | undefined;
	requestId: string | undefined;
	/** Model on the message, when the harness stamps it per message. */
	model: string | undefined;
	timestamp: string | number | undefined;
	isSidechain: boolean;
	usage: NormalizedUsage;
}

/** A file touched by a tool call. */
export interface FileRef {
	path: string;
	action: "read" | "write";
}

/**
 * One content block, interpreted.
 *
 * `handled` on a tool block means the adapter recognized the tool name and
 * took its own branch for it — extracting file/command arguments, or finding
 * none. An unhandled block falls through to shared category mapping, and an
 * unmapped one marks the interaction as using an unrecognized tool. Keeping
 * this explicit (rather than inferring it from empty files/commands) preserves
 * the pre-seam behaviour where e.g. a `read` call with no path argument is
 * still a known tool, not an unrecognized one.
 */
export type ParsedBlock =
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; handled: boolean; files: FileRef[]; commands: string[] };

/**
 * A non-assistant entry that changes how following turns are interpreted.
 * Shared code applies these; harnesses only recognize them.
 */
export type ControlSignal =
	| { kind: "thinking-level"; level: string }
	| { kind: "model"; modelId: string }
	| { kind: "compaction"; tokensBefore: number }
	| { kind: "after-compaction" }
	| { kind: "interrupt" };

/**
 * A class of API call the harness BILLS FOR but writes no `usage` object for
 * (#149). Counted, never priced — see `docs/spec-149-compaction-cost-scope.md`.
 *
 * `compaction` — the call that produces a `/compact` summary. Measured
 *   $0.673267 on one Opus-5 compaction; the transcript's `compactMetadata`
 *   describes the resulting CONTEXT, never the call that produced it.
 * `recap` — the "while you were away" summary. Every recap in the logged
 *   sessions coincided 1:1 with an unexplained step in Claude Code's own cost
 *   counter (3/3, 6/6, 3/3, 3/3 across four sessions).
 */
export type UncountedBillableClass = "compaction" | "recap";

export interface HarnessParseAdapter {
	/** Harness id — equals the directory name under harness/. */
	readonly id: string;
	/** Null when this entry is not this harness's assistant turn. */
	matchAssistant(entry: any): AssistantTurn | null;
	/** Interpret one content block. Null for blocks this harness ignores. */
	readBlock(block: any): ParsedBlock | null;
	/** Recognize a stream-control entry. Null when the entry is not one. */
	readControlEntry(entry: any): ControlSignal | null;
	/**
	 * Recognize an entry that stands for a billed API call carrying no `usage`
	 * (#149). Measured: 4.72% of Claude Code's own `total_cost_usd` across seven
	 * logged sessions is spend of this kind. wtft counts these so the omission is
	 * NAMED rather than silent; it never prices them, because the numbers reach
	 * no file any parser can read.
	 *
	 * Optional so out-of-tree harnesses registered through the #156 seam stay
	 * valid unchanged — a harness that omits it simply reports no blind spot.
	 */
	readUncountedBillable?(entry: any): UncountedBillableClass | null;
}

// ---
// REGISTRY ENTRY
// ---

/** A harness as the registry holds it: both halves plus its enabled state. */
export interface RegisteredHarness {
	id: string;
	discovery: HarnessDiscovery;
	parse: HarnessParseAdapter;
}

/** Shape of one entry in ~/.config/princess-pi-packages/wtft-harnesses.json. */
export interface HarnessConfigEntry {
	enabled?: boolean;
	label?: string;
	/** Module path — out-of-tree harnesses only. Must be .mjs/.js. */
	discovery?: string;
	/** Module path — out-of-tree harnesses only. Must be .mjs/.js. */
	parse?: string;
}

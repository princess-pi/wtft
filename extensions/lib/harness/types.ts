/**
 * @package @princess-pi/wtft
 * @module harness/types
 * @description The two interfaces every harness implements.
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
	displayPath: string; // e.g. "~/g-p/princess-pi-tools/2026-07-02...268a"
}

/**
 * How far `discover` looks, and how it costs what it looks at.
 *
 *   "worktree"  — the default: folder-name match on `targetCwd` ALONE. No
 *                  fan-out, no union (last-cwd) arm.
 *   "worktrees" — Ctrl+W: folder match across every checkout of the target's
 *                  repo (`fanOutCwd`), PLUS the union arm — a session whose
 *                  own recorded last cwd resolves into one of those checkouts,
 *                  even though it is physically filed elsewhere.
 *   "all"       — Ctrl+A / Tab: every session for this harness, cwd ignored
 *                  entirely.
 *   "branch"    — Ctrl+B: the single checkout matching `targetCwd`'s current
 *                  git branch (see `harness/worktrees.ts`'s
 *                  `resolveBranchCheckout`), folder-matched only, no union
 *                  arm. Falls back to `targetCwd` itself when the branch or a
 *                  matching checkout can't be resolved (no git, not a repo,
 *                  detached HEAD) — a documented no-op, never a silent wrong
 *                  scope.
 *
 * `windowMs` bounds EVERY scope uniformly: a candidate (and, for "worktrees",
 * a transcript the union arm would otherwise tail-read) whose mtime falls
 * outside the window is skipped before any read past a `stat`. `null` means
 * unbounded — full cost, a deliberate choice once a human has cycled `Ctrl+T`
 * all the way round.
 */
export type DiscoveryScope = "worktree" | "worktrees" | "all" | "branch";

export interface DiscoverScopeOptions {
	scope: DiscoveryScope;
	windowMs: number | null;
}

export interface HarnessDiscovery {
	/** Harness id — equals the directory name under harness/. */
	readonly id: string;
	/** Column label in the selector, e.g. "Claude" / "Pi". */
	readonly label: string;
	/**
	 * Session candidates for a target directory.
	 *
	 * @param targetCwd absolute directory to scope to. What a missing/`null`
	 *   target means is each harness's OWN policy, not a universal contract —
	 *   Pi treats it as "no filter" (`harness/pi/discovery.ts`'s
	 *   `discoverLegacy`); Claude Code has always been cwd-scoped and falls
	 *   back to `process.cwd()` instead (`harness/claude-code/discovery.ts`'s
	 *   `discover`). See `docs/adding-a-harness.md` §1.
	 * @param scopeOpts omitted → each harness's legacy default (union arm and
	 *   unbounded time for both built-ins, plus worktree fan-out for Claude
	 *   Code; Pi's legacy default has never fanned out). `bin/wtft.ts` passes
	 *   `{ scope: "worktree", windowMs: TIME_WINDOW_MS["20m"] }` as the
	 *   picker's starting population, and the picker's rescopes pass their own.
	 */
	discover(targetCwd: string | null, scopeOpts?: DiscoverScopeOptions): SessionCandidate[];
	/**
	 * Resolve a session id to its current transcript path, wherever it now
	 * lives. A moved session keeps its id and loses its path.
	 */
	resolveSessionById(sessionId: string): string | null;
	/**
	 * Every session transcript written at or after `sinceMs` (one created
	 * earlier may be omitted), with the facts the unrecorded-spawn listing
	 * needs. Optional: a harness that omits it never has its sessions listed.
	 * Throw on a read error, other than a path that is gone: an empty result
	 * must only mean "looked, found none".
	 */
	listSpawnCandidates?(sinceMs: number): SpawnCandidate[];
}

/** One transcript `listSpawnCandidates` found. Facts only — the tier rules
 *  live on the shared side (`wtft-unrecorded.ts`). */
export interface SpawnCandidate {
	path: string;
	sessionId: string;
	/** The cwd the transcript records. */
	cwd: string;
	/** First timestamp in the transcript, epoch ms. */
	startedAt: number;
	/** null: the harness does not say. */
	launchedBy: "program" | "human" | null;
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
	/** Raw cache_creation sub-object for the TTL split, or null. */
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
 * A class of API call the harness BILLS FOR but writes no `usage` object for.
 * Counted, never priced — see `docs/spec-149-compaction-cost-scope.md`.
 *
 * `compaction` — the call that produces a `/compact` summary. The transcript's
 *   `compactMetadata` describes the resulting CONTEXT, never the call that
 *   produced it.
 * `recap` — the "while you were away" summary.
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
	 * Recognize an entry that stands for a billed API call carrying no `usage`.
	 * wtft counts these so the omission is NAMED rather than silent; it never
	 * prices them, because the numbers reach no file any parser can read.
	 *
	 * Optional so out-of-tree harnesses stay valid unchanged — a harness that
	 * omits it simply reports no blind spot.
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

/** Shape of one entry in ~/.config/wtft/harnesses.json. */
export interface HarnessConfigEntry {
	enabled?: boolean;
	label?: string;
	/** Module path — out-of-tree harnesses only. Must be .mjs/.js. */
	discovery?: string;
	/** Module path — out-of-tree harnesses only. Must be .mjs/.js. */
	parse?: string;
}

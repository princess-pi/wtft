import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Interaction, Category } from "./wtft-parser.js";
import { getVisualLength, getTerminalWidth } from "./wtft-shared.js";
import {
	parseEntryToInteraction,
	deduplicateInteractions,
	classifyInteraction,
	buildWtftLines
} from "./wtft-shared.js";
import { splitOverheadCost } from "./wtft-parser.js";
import { getDiscoveries } from "./harness/registry.ts";
import { showCursor, hideCursor, enterRawStdin, clearPreviousLines, visualLineCount } from "./tty-helpers.js";
export interface WatchSettings {
	interval: string;
	limit: number;
	mode: "cumulative" | "bucket";
	showTicks: boolean;
	timezone?: string;
	unit?: "cost" | "tokens";
	daemonPath?: string; // path to wtft-daemon.mjs (CLI watch mode only)
	/**
	 * The daemon child this watch just spawned, when it did (#308). Lets the
	 * tag-file wait ask a fact — "did the process we started exit?" — instead of
	 * running a clock. Without it the wait falls back to a bounded ceiling.
	 */
	daemonChild?: ChildProcess | null;
	/** Padding spaces on each side of output (default 0 = no padding). */
	pad?: number;
	/** True when the user explicitly passed the flag from CLI (overrides file-read settings). */
	hasInterval?: boolean;
	hasLimit?: boolean;
	hasMode?: boolean;
	hasTicks?: boolean;
	hasTimezone?: boolean;
}

// CLASSIFIED TAG FILE READER (#53 — daemon output → Interaction[])
// The daemon writes pre-classified, pre-costed entries to
// wtft-tags/<session>.wtft-tag.v{N}.jsonl. These helpers read them back
// without re-parsing raw harness entries or re-calculating costs.

/**
 * Serialize an Interaction to a classified tag-file line.
 *
 * This is the single source of truth for the tag-file wire format.
 * Must stay in sync with classifiedToInteraction (below).
 * When adding a field, update BOTH functions in this file.
 */
export function serializeClassified(interaction: Interaction): string {
	// Round cost to 6 decimal places — the daemon cost calculator
	// produces a slightly different float than the in-memory widget.
	// Without rounding, accumulated drift causes $0.02-0.04 mismatches.
	const cost = Number(interaction.cost.toFixed(6));
	const line: any = {
		t: interaction.timestamp,
		c: cost,
		cat: classifyInteraction(interaction),
		f: interaction.files.map(f => ({ p: f.path, a: f.action === "write" ? "w" : "r" })),
		cmd: interaction.commands,
	};
	// Include message.id for cross-run dedup in tag-file consumers (#65)
	if (interaction.messageId) line.id = interaction.messageId;
	// Include model/token data when available (for -T summary table)
	if (interaction.model) line.m = interaction.model;
	if (interaction.inputTokens > 0) line.in = interaction.inputTokens;
	if (interaction.outputTokens > 0) line.out = interaction.outputTokens;
	if (interaction.cacheReadTokens > 0) line.cr = interaction.cacheReadTokens;
	if (interaction.cacheWriteTokens > 0) line.cw = interaction.cacheWriteTokens;
	if (interaction.reasoningTokens > 0) line.rs = interaction.reasoningTokens;
	// Server-side tool requests (per-request billed, #73)
	if (interaction.serverToolCost) line.sc = Number(interaction.serverToolCost.toFixed(6));
	if (interaction.webSearchRequests > 0) line.ws = interaction.webSearchRequests;
	if (interaction.webFetchRequests > 0) line.wf = interaction.webFetchRequests;
	// Thinking effort level (#77)
	if (interaction.thinkingLevel) line.tl = interaction.thinkingLevel;
	// Compaction tokens before this interaction (#90)
	if (interaction.compactionTokensBefore) line.cb = interaction.compactionTokensBefore;
	// Tool-implied categories + unrecognized-tool flag (#52)
	if (interaction.toolCats && interaction.toolCats.length > 0) line.tc = interaction.toolCats;
	if (interaction.unrecognizedTool) line.ut = 1;
	// Observed cache TTL class — idle countdown uses data over model-name guess (#95)
	if (interaction.cacheTtl) line.ttl = interaction.cacheTtl;
	// Whole prefix re-primed — "Cache Miss" divider (#152). Carried as its own
	// field because the meter-split below splits cr and cw onto separate lines,
	// after which cr/cw alone can no longer distinguish a full miss from a
	// partial re-prime.
	if (interaction.cacheMiss) line.miss = 1;
	// Interrupted turn — whole cost is discarded work (#52 Phase 3)
	if (interaction.interrupted) line.ir = 1;
	// DeepSeek surge-pricing tag (#119, #128)
	if (interaction.surgePriced) line.sp = 1;
	return JSON.stringify(line) + "\n";
}

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
		webSearchRequests: obj.ws || 0,
		webFetchRequests: obj.wf || 0,
		serverToolCost: obj.sc || 0,
		thinkingLevel: obj.tl || undefined,
		compactionTokensBefore: obj.cb || undefined,
		toolCats: obj.tc || undefined,
		unrecognizedTool: obj.ut ? true : undefined,
		cacheTtl: obj.ttl === "1h" || obj.ttl === "5m" ? obj.ttl : undefined,
		cacheMiss: obj.miss ? true : undefined,
		interrupted: obj.ir ? true : undefined,
		surgePriced: obj.sp ? true : undefined,
		_cat: obj.cat || undefined,
	};
}

/**
 * Read all classified interactions from a tag file, skipping heartbeat lines.
 *
 * @param tagPath - Absolute path to the .wtft-tag.v{N}.jsonl file
 * @returns Array of Interactions (costs already computed by daemon)
 */
/**
 * Collapse tag-file lines that share a `message.id` down to one interaction,
 * keeping the highest-cost copy (#270 review).
 *
 * The tag file is append-only and the daemon reads its sources incrementally,
 * so one billed message can reach it as more than one line: a harness re-emits
 * an assistant message with growing `usage` as it streams, and any two of those
 * emissions can land in different poll windows, where a within-batch dedup
 * cannot see them together. Measured over the twelve most recent live Claude
 * Code transcripts on this host, 39-76% of message ids carrying `usage` are
 * re-emitted at least once (117 of 293 = 39.9%, 72 of 95 = 75.8%, ...), with
 * the growing-usage form separated by `tool_result` lines and seconds of wall
 * clock — far wider than the 667ms beat. Without this, those lines are summed
 * and every consumer over-reports.
 *
 * This is the consumer half of a contract the wire format already declares:
 * serializeClassified writes `id` specifically "for cross-run dedup in tag-file
 * consumers (#65)", and until now no consumer did it.
 *
 * Max cost, never the sum and never the first — dropping the updated (higher)
 * usage would just trade the overcount for the undercount #270 exists to fix.
 * The compaction/recache meter-split is unaffected: its overhead line carries
 * `<id>#oh`, a distinct id, so the pair survives the collapse.
 *
 * First-appearance order is preserved so this is a pure subtraction — callers
 * that read the tag file in append order (bucket rendering, `limit`) see the
 * same sequence minus the duplicates. Returns the input array unchanged when
 * nothing repeats, which is the common case.
 */
export function dedupeClassifiedById(interactions: Interaction[]): Interaction[] {
	const groups = new Map<string, Interaction[]>();
	// One slot per output position: an interaction with no id goes in directly,
	// an id gets a placeholder at its FIRST appearance and is resolved below.
	const slots: (Interaction | null)[] = [];
	const slotIds: (string | null)[] = [];
	let anyDuplicate = false;

	for (const i of interactions) {
		const id = i.messageId;
		if (!id) { slots.push(i); slotIds.push(null); continue; }
		const group = groups.get(id);
		if (group) { group.push(i); anyDuplicate = true; continue; }
		groups.set(id, [i]);
		slots.push(null); slotIds.push(id);
	}

	if (!anyDuplicate) return interactions;

	const out: Interaction[] = [];
	for (let s = 0; s < slots.length; s++) {
		const direct = slots[s];
		if (direct) { out.push(direct); continue; }
		const group = groups.get(slotIds[s]!)!;
		// deduplicateInteractions is the single definition of "same message,
		// keep the max-cost copy, union its files/commands". A single-id group
		// always collapses to exactly one element.
		out.push(group.length === 1 ? group[0] : deduplicateInteractions(group)[0]);
	}
	return out;
}

/** Why a tag read is provisional. Null when it is settled. */
export type TagProvisionalReason = "stale-version" | "unswept";

export interface TagProvisional {
	/** True when the total this tag yields may still grow under the daemon. */
	provisional: boolean;
	/** The condition that made it provisional; null when settled. */
	reason: TagProvisionalReason | null;
}

/**
 * Is the total this tag yields still subject to repair by the daemon? (#443)
 *
 * A one-shot `wtft` spawns the daemon and reads the tag immediately afterwards,
 * so the read races the daemon it just started and loses. On the issue's
 * specimen that was $79.74 against a true $84.59 — a 5.7% undercount reported as
 * a plain total, with nothing to distinguish it from a settled one. This is the
 * signal that was missing; the caller decides what to do with it.
 *
 * TWO CONDITIONS, either sufficient, checked in this order because the first
 * outranks the second — a superseded-semantics tag is provisional whatever its
 * sweep state:
 *
 *   `stale-version` — the tag is not at WTFT_TAGGER_VERSION. getTagPath's rule 3
 *     falls back to "any-version tag in the own dir, newest mtime" (#95), so a
 *     read can land on a tag written under superseded pricing or parse semantics
 *     while the daemon builds a current-version one beside it.
 *
 *   `unswept` — a current-version tag holding classified data but no
 *     `_meta.swept`. The daemon appends that marker once its first
 *     scanForSubAgents() has completed, so its absence means NO daemon has read
 *     a single subagent transcript since this tag was written.
 *
 * A tag with no classified data is NOT provisional: it yields no total, so there
 * is nothing to doubt, and bin/wtft.ts already has waits for that case gated on
 * `interactions.length === 0`. Reporting provisional there would fire on every
 * fresh session and train the reader to ignore the flag.
 *
 * NO SCAN WINDOW, and that is a correction worth recording rather than a choice.
 * This first scanned only the last 8KB, justified as "matching
 * readLastMetaOffset". That justification does not survive contact:
 * readLastMetaOffset windows because it does a PARTIAL read — open, seek, read
 * 8KB, never load the file — whereas this function has already read the whole
 * tag into `content` to answer the has-classified-data question above.
 * Windowing content that is already in memory buys no I/O and costs a whole
 * failure mode: a marker buried past 8KB by a busy session would read `unswept`
 * forever. So the scan is the whole file.
 *
 * WHAT THAT COSTS, stated correctly — an earlier version of this comment claimed
 * "on a settled tag the marker is near the end, so the backward walk stops within
 * a few lines", and that is FALSE for the sessions this feature targets (PR
 * review). The daemon writes the marker exactly once, guarded by
 * `if (sweptAtMs === 0)`, right after its FIRST sweep — early in a session's
 * life. Every classified line produced afterwards is appended AFTER it, pushing
 * it further from the end, not closer; the `busy` case in
 * `tests/wtft-443-daemon-swept-marker.test.ts` floods 160 turns and asserts
 * exactly that. So the walk is proportional to how much data accumulated since
 * the first sweep — up to the whole file. It stays cheap in absolute terms only
 * because the `includes('"_meta"')` guard skips `JSON.parse` on the classified
 * lines, which are almost all of them, and because the content is already in
 * memory. Correctness never depended on the marker's position; only this cost
 * note did, and it was wrong.
 *
 * AN UNREADABLE TAG READS AS NOT-PROVISIONAL, which is deliberate and is NOT an
 * "err toward provisional" case — an earlier draft of this comment filed it under
 * that heading and was self-contradictory as a result (PR review). The rule is
 * narrower and has no exceptions: **a read is provisional only when a total was
 * produced that could still change.** An ENOENT/EACCES tag produces no total at
 * all, and `readClassifiedTagFile` will have yielded nothing from it either, so
 * there is nothing for the flag to qualify. Read errors are therefore invisible
 * here by design, not surfaced as doubt.
 */
export function readTagProvisional(tagPath: string): TagProvisional {
	let content: string;
	try {
		content = fs.readFileSync(tagPath, "utf8");
	} catch {
		// Missing or unreadable — no total was produced from it to doubt. The
		// version check still has to run, so it happens in the content form below.
		content = "";
	}
	return tagProvisionalFromContent(tagPath, content);
}

/**
 * The provisional verdict for tag content ALREADY IN HAND (#443, PR review).
 *
 * This exists because `readTagProvisional(path)` and `readClassifiedTagFile(path)`
 * each opened the file themselves, and a caller wanting both did two reads with a
 * gap between them. The daemon is a separate OS process appending to that same
 * file, so it can land the repaired lines AND the `_meta.swept` marker inside the
 * gap — after which the interactions are the stale ones and the verdict says
 * settled. That is #443's silent undercount again, through a narrower window,
 * which is exactly the shape of bug this issue exists to close rather than
 * relocate. `readTagFileWithVerdict` is the one-read entry point; this is the
 * pure half it and `readTagProvisional` share, so the two can never disagree.
 */
export function tagProvisionalFromContent(tagPath: string, content: string): TagProvisional {
	// Version first: it needs no content at all, and it outranks the sweep state.
	if (!path.basename(tagPath).endsWith(`.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`)) {
		return { provisional: true, reason: "stale-version" };
	}
	if (!content) return { provisional: false, reason: null };

	const lines = content.split("\n");

	// Does it yield a total at all? A classified line is one that parses and
	// carries neither _hb nor _meta — the same rule readClassifiedTagFile uses.
	let hasClassified = false;
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line);
			if (obj._hb || obj._meta) continue;
			hasClassified = true;
			break;
		} catch { continue; }
	}
	if (!hasClassified) return { provisional: false, reason: null };

	// POSITIONAL, not merely present (PR review). Scan backward and stop at the
	// first significant record: a `_meta.swept` settles the tag, a CLASSIFIED
	// line invalidates any marker further back.
	//
	// Presence alone was wrong. The daemon's `flushPending()` runs BEFORE
	// `scanForSubAgents()` in the same poll, so a new parent turn — including one
	// that spawns a new subagent — lands after a marker left by an earlier sweep
	// or an earlier daemon process. Accepting that historical marker reports
	// SETTLED for data no sweep has covered: #443's own undercount through a
	// narrower window. Requiring the marker to be LAST makes "swept" mean "swept
	// as of everything in this file", which is the only claim a reader can check.
	//
	// Heartbeats and `_meta.offset` lines are not significant either way — they
	// carry no cost — so the walk skips them and keeps looking.
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line.trim()) continue;
		// Cheap reject first: a line with neither marker is still possibly
		// classified, so only `_hb`/`_meta` candidates and non-JSON reach parse.
		try {
			const obj = JSON.parse(line);
			if (obj._hb) continue;
			if (obj._meta) {
				if (typeof obj._meta.swept === "number") {
					return { provisional: false, reason: null };
				}
				continue; // an offset line, or a marker shape this writer never emits
			}
			// A classified line, newer than any marker behind it.
			return { provisional: true, reason: "unswept" };
		} catch { continue; }
	}
	return { provisional: true, reason: "unswept" };
}

/**
 * Read a tag file ONCE and derive both the interactions and the provisional
 * verdict from that single buffer (#443, PR review).
 *
 * Any caller that needs both MUST use this rather than calling
 * `readClassifiedTagFile` and `readTagProvisional` in sequence — see
 * `tagProvisionalFromContent` for the race that pairing reopens.
 */
export function readTagFileWithVerdict(tagPath: string): {
	interactions: Interaction[];
	provisional: TagProvisional;
} {
	let content = "";
	try {
		content = fs.readFileSync(tagPath, "utf8");
	} catch { /* missing or unreadable — both halves handle "" */ }
	return {
		interactions: classifiedInteractionsFromContent(content),
		provisional: tagProvisionalFromContent(tagPath, content),
	};
}

/** Classified interactions from tag content already in hand. The pure half that
 *  `readClassifiedTagFile` and `readTagFileWithVerdict` share, so a caller that
 *  needs interactions AND the provisional verdict can get both from one read
 *  (#443, PR review). */
export function classifiedInteractionsFromContent(content: string): Interaction[] {
	const interactions: Interaction[] = [];
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
	// One billed message can occupy several lines here — collapse before any
	// caller sums it (#270 review).
	return dedupeClassifiedById(interactions);
}

export function readClassifiedTagFile(tagPath: string): Interaction[] {
	let content = "";
	try {
		content = fs.readFileSync(tagPath, "utf8");
	} catch {
		// File may not exist yet
	}
	return classifiedInteractionsFromContent(content);
}

// INOTIFY-BASED WATCH MODE (#53)
// Watches the daemon's classified tag file via fs.watch. Auto-spawned by CLI.
// tag file. Auto-spawn of the daemon happens in the CLI entry point (bin/wtft.ts).

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

// The version and its bump changelog live in wtft-tagger-version.ts — a leaf
// module, so tag readers that avoid daemon internals import it from there.
// Re-exported here for the existing importers (#499).
export { WTFT_TAGGER_VERSION } from "./wtft-tagger-version.js";
import { WTFT_TAGGER_VERSION } from "./wtft-tagger-version.js";

/**
 * Serialize one interaction to its classified tag-file line(s) (#52 Phase 3).
 * When a compaction/recache meter-split applies, emits TWO lines: the main
 * line with the work remainder (cache-write tokens zeroed) and an overhead
 * line ("<messageId>#oh") carrying the cache_write $ component under
 * "compaction"/"overhead". Message-id dedup treats "#oh" as distinct, and
 * both lines share a timestamp, so renderers need no changes — the split
 * stacks naturally in the same bucket.
 *
 * @param prevCtxTokens input+cacheRead+cacheWrite of the previous
 *   non-sidechain deduped interaction (recache signature input)
 */
export function serializeClassifiedWithOverheadSplit(interaction: Interaction, prevCtxTokens: number): string {
	const split = splitOverheadCost(interaction, prevCtxTokens);
	if (!split) return serializeClassified(interaction);
	const remainder: Interaction = {
		...interaction,
		cost: Math.max(0, interaction.cost - split.overheadCost),
		cacheWriteTokens: 0,
		afterCompaction: undefined,
	};
	const overheadLine: Interaction = {
		timestamp: interaction.timestamp,
		cost: split.overheadCost,
		messageId: interaction.messageId ? interaction.messageId + "#oh" : undefined,
		model: interaction.model,
		inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
		cacheWriteTokens: interaction.cacheWriteTokens,
		// Miss stays on the remainder line only — flagging both would be harmless
		// (bins are a Set) but would misreport the overhead line as its own event.
		cacheMiss: undefined,
		reasoningTokens: 0, webSearchRequests: 0, webFetchRequests: 0,
		serverToolCost: 0,
		files: [], commands: [], texts: [],
		_cat: split.kind,
	};
	return serializeClassified(remainder) + serializeClassified(overheadLine);
}

/**
 * True when a transcript basename carries a session UUID — the shape every real
 * harness session has: `<uuid>.jsonl` (Claude Code) or `<timestamp>_<uuid>.jsonl`
 * (Pi).
 *
 * This is the gate on both cross-directory behaviours below (#157). Both were
 * introduced by #155 keyed on the basename alone, which is only a safe identity
 * when the basename is globally unique. It is not: an arbitrary path handed to
 * `-s`, or a fixture named `session.jsonl`, collides with every other file of
 * the same name in a different directory. Two unrelated sessions then shared a
 * daemon lease, and a tag lookup wandered into unrelated directories.
 *
 * Anything without a UUID keeps the pre-#155 path-keyed behaviour, which is
 * strictly safer and loses nothing: only real harness sessions move between
 * project dirs, and those always carry a UUID.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function isSessionIdBasename(sessionPath: string): boolean {
	return UUID_RE.test(path.basename(sessionPath));
}

/**
 * Current-version tag file for this transcript basename in a *sibling* project
 * dir (#155). A session that moves — worktree enter/exit, or any switch that
 * changes its project dir — leaves its daemon writing to the tag path it opened
 * at startup, because `--watch` binds fs.watch once and never re-resolves. So
 * the tag file can legitimately live beside a different copy of the project dir
 * than the transcript does.
 *
 * Only the current-version filename is matched: stale-version tags elsewhere
 * are derived caches that a version bump is meant to regenerate. Basenames are
 * session UUIDs, so a cross-dir match cannot collide.
 */
function findSiblingTagPath(sessionPath: string): string | null {
	// Only real session transcripts move between project dirs (#157). Without
	// this gate the scan below walks the grandparent of ANY path — for
	// /tmp/<fixture>/session.jsonl that grandparent is /tmp itself.
	if (!isSessionIdBasename(sessionPath)) return null;
	const sessionBase = path.basename(sessionPath);
	const wanted = sessionBase + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`;
	// The project-dir parent: …/<projects-root>/<project-slug>/<session>.jsonl
	const projectsRoot = path.dirname(path.dirname(sessionPath));
	let best: { path: string; mtimeMs: number } | null = null;
	try {
		for (const slug of fs.readdirSync(projectsRoot)) {
			const candidate = path.join(projectsRoot, slug, "wtft-tags", wanted);
			try {
				const stat = fs.statSync(candidate);
				if (!stat.isFile()) continue;
				if (!best || stat.mtimeMs > best.mtimeMs) best = { path: candidate, mtimeMs: stat.mtimeMs };
			} catch { /* not present in this dir */ }
		}
	} catch { /* projects root unreadable */ }
	return best ? best.path : null;
}

/**
 * Where this session's tag file is, resolved in this order:
 *   1. current-version tag in the session's own dir;
 *   2. current-version tag in a sibling project dir (the moved-session case);
 *   3. any-version tag in the own dir, newest mtime — never readdir order,
 *      which made multi-version dirs a coin flip (#95);
 *   4. the default (current-version path in the own dir).
 *
 * Sibling outranks stale-own-dir deliberately: #155 measured a stale v2.6.1
 * 125-line tag in the main clone while the fuller v2.7.0 356-line tag sat in
 * the worktree's project dir. The more complete artifact should win rather than
 * be stranded.
 */
export function getTagPath(sessionPath: string): string {
	const sessionDir = path.dirname(sessionPath);
	const sessionBase = path.basename(sessionPath);
	const tagsDir = path.join(sessionDir, "wtft-tags");
	const defaultPath = path.join(tagsDir, sessionBase + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);

	let newest: { path: string; mtimeMs: number } | null = null;
	try {
		const prefix = sessionBase + ".wtft-tag.v";
		for (const f of fs.readdirSync(tagsDir)) {
			if (!f.startsWith(prefix) || !f.endsWith(".jsonl")) continue;
			const full = path.join(tagsDir, f);
			if (full === defaultPath) return defaultPath;                      // (1)
			try {
				const mtimeMs = fs.statSync(full).mtimeMs;
				if (!newest || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
			} catch {}
		}
	} catch {}

	const sibling = findSiblingTagPath(sessionPath);                         // (2)
	if (sibling) return sibling;

	if (newest) return newest.path;                                          // (3)
	return defaultPath;                                                      // (4)
}

/**
 * The current-version tag path a *writer* should open — own dir if it already
 * holds one, else a sibling project dir's (#155), else the own-dir default.
 *
 * Never returns a stale-version filename, unlike getTagPath()'s reader
 * fallback: the daemon owns the version protocol, and writing into an old
 * version's file is exactly what the version bump exists to stop (#95).
 */
export function getCurrentVersionTagPath(sessionPath: string): string {
	const sessionBase = path.basename(sessionPath);
	const own = path.join(
		path.dirname(sessionPath),
		"wtft-tags",
		sessionBase + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`
	);
	if (fs.existsSync(own)) return own;
	return findSiblingTagPath(sessionPath) || own;
}

/**
 * Singleton key for a session's daemon.
 *
 * Keyed on the transcript *basename*, not the full path (#155). A worktree
 * switch moves the transcript between project dirs; a path-keyed hash would
 * change under it, so a `wtft` run from the new directory would not recognise
 * the still-live daemon and would spawn a second one on the same transcript.
 * The basename is a session UUID (Claude Code) or `<timestamp>_<uuid>` (Pi) —
 * unique per session and invariant under a move.
 */
export function getDaemonPidPath(sessionPath: string): string {
	// Key on the basename only when it is a session UUID — unique across every
	// project dir, so it survives a move. Any other path keeps the full-path key
	// (#157): basenames like "session.jsonl" are not identities, and collapsing
	// them onto one lease made two unrelated sessions fight over one daemon.
	const key = isSessionIdBasename(sessionPath) ? path.basename(sessionPath) : sessionPath;
	const sessionHash = createHash("sha256").update(key).digest("hex").slice(0, 12);
	return path.join(os.tmpdir(), `wtft-daemon-${sessionHash}.pid`);
}

/**
 * Re-resolve a session transcript that vanished from its known path, by asking
 * every registered harness where that session id lives now (#155, #156).
 * Returns the new path, or null when the session is genuinely gone.
 */
export function resolveMovedSession(sessionPath: string): string | null {
	const sessionId = path.basename(sessionPath).replace(/\.jsonl$/i, "");
	for (const discovery of getDiscoveries()) {
		try {
			const found = discovery.resolveSessionById(sessionId);
			if (found && found !== sessionPath && fs.existsSync(found)) return found;
		} catch { /* a misbehaving harness must not break the daemon */ }
	}
	return null;
}

/** Threshold for "idle" state: 2m2s — a classic TV commercial break. */
export const IDLE_THRESHOLD_MS = 122_000;

/** Daemon self-exit: 24h of no new data. Polite to ps aux browsers. */
export const IDLE_EXIT_MS = 24 * 60 * 60 * 1000;

/**
 * Get the prompt cache TTL for a given model in milliseconds.
 * Returns null for local models (no remote cache) or unrecognized providers.
 *
 * NOTE: Cache TTLs are provider-dependent and can change. These are conservative
 * estimates used for the idle countdown display — not precise billing values.
 *
 * Recognized cloud providers with prompt caching:
 *   - DeepSeek:   hard-disk cache, cleared within hours-to-days. 1h display TTL.
 *   - Claude:     5-min ephemeral cache (default cache_control TTL).
 *   - Gemini:     ~1h cache TTL (varies by model, conservative).
 *   - GPT/OpenAI: variable (30m-1h). Conservative 30min display TTL.
 *   - OpenAI-compat providers (together.ai, fireworks, etc.): 30min.
 */
export function getModelCacheTtlMs(model: string): number | null {
	const m = model.toLowerCase();

	// --- Cloud providers with known prompt caching ---

	// DeepSeek first (independent of Claude substring overlap):
	// hard-disk cache, "automatically cleared within a few hours to a few days."
	if (m.includes("deepseek")) {
		return 60 * 60 * 1000;
	}

	// Claude: 5-minute ephemeral cache (the default cache_control TTL).
	// The 1-hour extended cache is opt-in and rare — default to 5 min.
	if (m.includes("claude")) {
		return 5 * 60 * 1000;
	}

	// Gemini: cache TTL varies — 5 min for short, ~1h for long contexts.
	// Conservative 1h display TTL.
	if (m.includes("gemini")) {
		return 60 * 60 * 1000;
	}

	// GPT / OpenAI: prompt caching with variable TTL (typically 5-30 min).
	// Conservative: 30 min display TTL.
	if (m.includes("gpt") || m.includes("o1") || m.includes("o3")) {
		return 30 * 60 * 1000;
	}

	// OpenAI-compat third-party providers commonly used through Pi:
	// together.ai, fireworks, openrouter, etc. Variable caching — 30min.
	if (m.includes("together") || m.includes("fireworks") || m.includes("openrouter")) {
		return 30 * 60 * 1000;
	}

	// Anthropic-specific model code patterns (non-Claude branded).
	// Covers: "haiku", "sonnet", "opus" (both standalone and in compound names).
	if (/\b(haiku|sonnet|opus)\b/.test(m)) {
		return 5 * 60 * 1000;
	}

	// Local models (ollama, llama.cpp, lmstudio, etc.) — no remote cache.
	if (m.includes("ollama") || m.includes("llama") || m.includes("lmstudio") || m.includes("local")) {
		return null;
	}

	// Unknown model — don't assume local; use a conservative 5-min display TTL
	// so the idle countdown still shows something. The worst case is showing a
	// short countdown for a model that has a longer cache — better than showing
	// "No Cache (local)" for a cloud model that DOES have caching.
	return 5 * 60 * 1000;
}

// ---
// DAEMON HEALTH REASON — code (contract) vs. text (copy)
//
// WHY the split (#179): `reason` used to be one `string` carrying a human sentence,
// read by two consumers with opposite requirements — a control comparison gating
// #124's startup grace window (which needs the string frozen forever) and the widget's
// display label (which wants it free to improve). #165 reworded both sides at once and
// only a manual `rg` stood between that sweep and a silent #124 regression.
//
// Now the code is the contract and the sentence is derived from it. Reword the sentence
// and nothing breaks; that is the entire point. See docs/spec-179-daemon-health-reason-codes.md.
// ---

/**
 * Stable machine-readable daemon health codes. THIS is the contract — control flow
 * compares these, never the rendered text. Adding a member is a feature; renaming or
 * removing one is a breaking change. The human sentences in DAEMON_REASON_TEXT are free
 * to change at any time precisely because this union exists.
 */
export type DaemonHealthReason =
	| "not-started"      // no daemon spawned for this session yet
	| "starting"         // spawned, inside the #124 startup grace window
	| "waiting-session"  // spawned, session .jsonl not created yet
	| "not-found"        // no live PID and no heartbeat on record
	| "idle-timeout"     // exited after idling out (lastHbTime carries when)
	| "restart-failed";  // respawn attempted and did not come up

/** Display copy for each code. Change freely — no control flow reads these. */
export const DAEMON_REASON_TEXT: Record<DaemonHealthReason, string> = {
	"not-started": "daemon not started",
	"starting": "starting...",
	"waiting-session": "waiting for session .jsonl...",
	"not-found": "daemon not found",
	"idle-timeout": "idle timeout",
	"restart-failed": "restart failed",
};

/** Render a health code as its human sentence. Unknown code → "unknown" (never throws). */
export function daemonReasonText(reason: DaemonHealthReason | undefined | null): string {
	return (reason && DAEMON_REASON_TEXT[reason]) || "unknown";
}

export interface DaemonStatus {
	alive: boolean;
	/** Machine-readable health code (#179). Compare THIS, never the rendered text. */
	reason?: DaemonHealthReason;
	lastHbTime?: string; // HH:MM local time of last heartbeat
	/** Daemon is alive but no new classified data for ≥ IDLE_THRESHOLD_MS. */
	idle?: boolean;
	/** Milliseconds since last non-heartbeat entry (when idle). */
	idleMs?: number;
	/** Raw timestamp (Date.now()) of the first heartbeat in the current idle
	 *  period. Used by renderDaemonStatus to compute a real-time countdown
	 *  without re-running checkDaemonHealth. */
	idleSinceMs?: number;
	/** Cache TTL in ms for the current model (null = local/no cache). */
	cacheTtlMs?: number | null;
	// NOTE (#179): the former `starting?: boolean` / `waiting?: boolean` flags are gone.
	// Each was true exactly when `reason` held one specific value, so they were two more
	// fields that could drift out of agreement with it. renderDaemonStatus switches on
	// the code directly.
}

/**
 * Render a daemon status indicator string (shared by Pi widget + CLI watch modes).
 * Returns e.g.:
 *   "  ● live" (green) — daemon active, recent data
 *   "  ● idle (cache expires in 3:22)" (yellow) — daemon idle, cache TTL ticking down
 *   "  ● No Cache (local)" (green) — daemon idle, local model (no remote cache)
 *   "  ● stopped 14:30" (red) — daemon exited cleanly
 *   "  ● restarting..." (yellow) — daemon being relaunched
 */
export function renderDaemonStatus(status: DaemonStatus, restarting = false): string {
	// Switch on the health CODE, then look the sentence up (#179) — the display text is
	// derived here and nowhere else, so rewording DAEMON_REASON_TEXT is a safe edit.
	if (status.reason === "waiting-session") {
		return `  \x1b[33m●\x1b[0m ${daemonReasonText("waiting-session")}`;
	}
	if (restarting || status.reason === "starting") {
		return `  \x1b[33m●\x1b[0m ${daemonReasonText("starting")}`;
	}
	if (!status.alive) {
		const label = status.lastHbTime
			? `stopped ${status.lastHbTime}`
			: daemonReasonText(status.reason);
		return `  \x1b[31m●\x1b[0m ${label}`;
	}
	if (status.idle) {
		const cacheTtlMs = status.cacheTtlMs;
		// Always show "idle" — cache info is supplementary.
		// Compute elapsed fresh from idleSinceMs (raw timestamp) so the
		// countdown updates every render without re-running checkDaemonHealth.
		const elapsedMs = status.idleSinceMs != null ? Date.now() - status.idleSinceMs : (status.idleMs || 0);
		if (cacheTtlMs != null && elapsedMs > 0) {
			const remainingMin = Math.ceil(Math.max(0, cacheTtlMs - elapsedMs) / 60_000);
			if (remainingMin <= 0) {
				return "  \x1b[33m●\x1b[0m idle (cache emptied)";
			}
			return `  \x1b[33m●\x1b[0m idle (cache expires in ${remainingMin}min)`;
		}
		// Cache TTL unknown — daemon is idle, we just don't know the cache window.
		// Show "local model" only when we confirmed the model has no remote cache.
		if (cacheTtlMs === null) {
			return "  \x1b[33m●\x1b[0m idle (local model)";
		}
		// cacheTtlMs is undefined (not null) — model unknown, just show idle.
		return "  \x1b[33m●\x1b[0m idle";
	}
	return "  \x1b[32m●\x1b[0m live";
}

/**
 * Fallback: scan the ENTIRE session file backwards for the most recent
 * assistant message's model. Used when the daemon tag file doesn't have a
 * recent classified entry with model info (only heartbeats).
 *
 * Reads the whole file — session files are typically < 1MB, so this is
 * fast enough. Using an 8KB window caused flickering because the model
 * entry could fall outside the window as the tag file grew.
 */
function getModelFromSessionFile(sessionPath: string): string | undefined {
	try {
		const content = fs.readFileSync(sessionPath, "utf8");
		const lines = content.split("\n");
		// Scan backwards for the most recent assistant message with model info.
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const entry = JSON.parse(line);
				// Pi schema: { type: "message", message: { role: "assistant", model: "..." } }
				if (entry.type === "message" && entry.message?.role === "assistant" && entry.message?.model) {
					return entry.message.model;
				}
				// Claude Code schema: { type: "assistant", message: { role: "assistant", model: "..." } }
				if (entry.type === "assistant" && entry.message?.role === "assistant" && entry.message?.model) {
					return entry.message.model;
				}
			} catch { continue; }
		}
	} catch { /* session file unreadable */ }
	return undefined;
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

	if (pidAlive) {
		// Daemon is alive — check if last tag entry was a heartbeat
		// for idle detection (no new classified data for ≥ IDLE_THRESHOLD_MS).
		// Also extract model from last classified entry for cache TTL countdown.
		try {
			const stat = fs.statSync(tagPath);
			if (stat.size > 0) {
				const fd = fs.openSync(tagPath, "r");
				const buf = Buffer.alloc(Math.min(stat.size, 8192));
				fs.readSync(fd, buf, 0, buf.length, Math.max(0, stat.size - 8192));
				fs.closeSync(fd);
				const lines = buf.toString("utf8").split("\n");
				let lastModel: string | undefined;
				let lastTtl: "1h" | "5m" | undefined;
				let idleMs: number | undefined;
				let idleSinceMs: number | undefined;
				let sawClassified = false;
				// Scan backwards: heartbeats are after classified entries, so we
				// encounter them first. Idle comes from the newest heartbeat's
				// range start, CLAMPED by the newest classified entry's timestamp
				// (#95) — heartbeats alone (possibly interleaved from a stale
				// duplicate daemon) can never declare idle when classified data
				// is fresher. Keep scanning past the newest classified entry for
				// model (#72, #73) and observed cache TTL class (#95).
				for (let i = lines.length - 1; i >= 0; i--) {
					const line = lines[i].trim();
					if (!line) continue;
					try {
						const obj = JSON.parse(line);
						// Track model + TTL class from most recent entries carrying them
						if (!lastModel && obj.m) lastModel = obj.m;
						if (!lastTtl && (obj.ttl === "1h" || obj.ttl === "5m")) lastTtl = obj.ttl;
						if (obj._hb) {
							// Only the newest heartbeat, and only if no classified
							// entry has been seen yet (i.e. it is truly the tail).
							if (typeof obj._hb === "object" && obj._hb.first && idleSinceMs === undefined && !sawClassified) {
								idleSinceMs = obj._hb.first;
							}
							continue;
						}
						// Classified entry — clamp the idle window start.
						if (!sawClassified) {
							sawClassified = true;
							if (typeof obj.t === "number" && idleSinceMs !== undefined && obj.t > idleSinceMs) {
								idleSinceMs = obj.t;
							}
						}
						if (lastModel && lastTtl) break;
					} catch { continue; }
				}
				if (idleSinceMs !== undefined) idleMs = Date.now() - idleSinceMs;
				if (idleMs !== undefined && idleMs >= IDLE_THRESHOLD_MS) {
					// If the tag file had no recent classified entry with model info
					// (only heartbeats), fall back to the session file.
					if (!lastModel) lastModel = getModelFromSessionFile(sessionPath);
					// Observed TTL class beats the model-name guess (#95).
					const cacheTtlMs = lastTtl
						? (lastTtl === "1h" ? 3_600_000 : 300_000)
						: (lastModel ? getModelCacheTtlMs(lastModel) : null);
					return { alive: true, idle: true, idleMs, idleSinceMs, cacheTtlMs };
				}
				// Heartbeat is too fresh (< IDLE_THRESHOLD) or absent.
				// Check the session file mtime: if the session hasn't been
				// written to for ≥ IDLE_THRESHOLD, the daemon just (re)started
				// on an already-idle session — report idle regardless of
				// heartbeat freshness.
				{
					try {
						const sessionStat = fs.statSync(sessionPath);
						const sessionIdleMs = Date.now() - sessionStat.mtimeMs;
						if (sessionIdleMs >= IDLE_THRESHOLD_MS) {
							if (!lastModel) lastModel = getModelFromSessionFile(sessionPath);
							const cacheTtlMs = lastTtl
								? (lastTtl === "1h" ? 3_600_000 : 300_000)
								: (lastModel ? getModelCacheTtlMs(lastModel) : null);
							return { alive: true, idle: true, idleMs: sessionIdleMs, idleSinceMs: sessionStat.mtimeMs, cacheTtlMs };
						}
					} catch { /* session file unreadable — fall through to live */ }
				}
			}
		} catch { /* tag file unreadable — assume live */ }
		return { alive: true };
	}

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
		return { alive: false, reason: "not-found" };
	}

	// Format the heartbeat time as local HH:MM.
	const d = new Date(lastHbMs);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const timeStr = `${hh}:${mm}`;

	return { alive: false, reason: "idle-timeout", lastHbTime: timeStr };
}

// ---
// DAEMON STARTUP PROOF (#309 review)
// ---

/**
 * What a freshly spawned daemon turned out to be. `"up"` and `"dead"` are
 * facts; `"unknown"` is the honest third answer — the child is still alive but
 * has claimed nothing yet, which is not evidence of failure.
 */
export type DaemonStartupState = "up" | "dead" | "unknown";

export interface DaemonStartupResult {
	state: DaemonStartupState;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
}

/**
 * Wait until the daemon we just spawned proves it came up — or proves it died.
 *
 * `spawnWtftDaemon` returning a handle means `spawn()` did not throw, nothing
 * more: a missing or broken `wtft-daemon.mjs` still yields a live-looking child
 * that exits a moment later. Any caller that goes on to TELL THE USER the daemon
 * is running owes them this check first (#309 review), or a dead daemon reads as
 * success.
 *
 * "Up" means exactly one thing: a live process holds the singleton lease
 * (`checkDaemonHealth().alive`). The daemon writes its PID file before
 * `initClassified()`, so the lease is the earliest and only proof — and it covers
 * the singleton case too: the child exits 0 immediately because an *older* daemon
 * already owns the session, which is up, not dead.
 *
 * A tag file on disk is NOT proof (#309 review, round 2). Tags outlive daemons —
 * a previous run's file, or a sibling-dir file the #155 lookup adopts — so "tag
 * exists" was reporting a dead daemon as up. Measured: a stale tag one directory
 * over under /tmp made a SIGKILLed stand-in read as "up".
 *
 * "Dead" needs both: the child is gone AND no lease is held — re-checked *after*
 * the exit is observed, because the lease can be claimed by a concurrent daemon in
 * the gap between our health check and the child's own singleton check (it then
 * exits 0 having found an owner: up, not dead).
 *
 * The ceiling bounds the ambiguous case only — a healthy daemon resolves in one
 * or two polls, so a one-shot CLI does not sit here. Hitting the ceiling returns
 * `"unknown"`, never `"dead"`: a slow box must not be reported as a failure.
 */
export async function awaitDaemonUp(
	sessionPath: string,
	child: ChildProcess | null,
	ceilingMs: number,
	pollMs = 50
): Promise<DaemonStartupResult> {
	const start = Date.now();
	const leaseAlive = () => checkDaemonHealth(sessionPath, getCurrentVersionTagPath(sessionPath)).alive;
	for (;;) {
		if (leaseAlive()) {
			return { state: "up", exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null };
		}
		const exitCode = child ? child.exitCode : null;
		const signalCode = child ? child.signalCode : null;
		if (child && (exitCode !== null || signalCode !== null)) {
			// Exit observed — but was the lease claimed between our check and its exit?
			if (leaseAlive()) return { state: "up", exitCode, signalCode };
			return { state: "dead", exitCode, signalCode };
		}
		if (Date.now() - start >= ceilingMs) {
			return { state: "unknown", exitCode, signalCode };
		}
		await new Promise(r => setTimeout(r, pollMs));
	}
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


export async function watchTagFile(
	sessionPath: string,
	tagPathHint: string,
	settings: WatchSettings
): Promise<void> {
	if (!process.stdout.isTTY) {
		console.error("❌ --watch requires a real terminal (TTY). Refusing to start.");
		process.exit(1);
	}

	// The reader's tag path is RESOLVED, never assumed (#309 review). A session
	// that changed project dirs (#155) leaves its tag file in the old dir, and the
	// daemon that replaces it adopts that same file (getCurrentVersionTagPath) —
	// so an own-dir path built from the session's *current* directory can be a
	// file nobody will ever write. The wait loop below has no exit for that state
	// (lease alive + own file absent), which made it hang forever. Mutable because
	// the move can also happen while we are still waiting.
	//
	// getCurrentVersionTagPath, not getTagPath: a watcher must bind to what the
	// WRITER picks. getTagPath's stale-version fallback is right for a one-shot
	// read and wrong here — the daemon deletes stale tags on startup (#95), so
	// fs.watch would attach to a file that is about to vanish.
	let tagPath = fs.existsSync(tagPathHint) ? tagPathHint : getCurrentVersionTagPath(sessionPath);

	let totalCost = 0;
	let interactionCount = 0;
	let needsRedraw = true;
	let daemonWatchdog: ReturnType<typeof setTimeout> | null = null;
	const HEALTHY_BEAT_MS = 1334; // 2 × 667ms daemon poll cycle
	const resetWatchdog = () => {
		if (daemonWatchdog) clearTimeout(daemonWatchdog);
		if (!daemonDead) {
			daemonWatchdog = setTimeout(() => {
				updateDaemonHealth();
				needsRedraw = true;
				render();
				if (!daemonDead) resetWatchdog();
			}, HEALTHY_BEAT_MS);
		}
	};

	// In-place rendering — preserves scrollback above. Each re-render clears
	// the previous render using visual-line counting (handles wrapping + resize).
	hideCursor();
	let lastLineCount = 0;
	let lastBuffer: string[] = [];

	// Shared exit: clear the live chart, print final copy to scrollback.
	const exitWatch = () => {
		if (watcher) watcher.close();
		if (daemonWatchdog) clearTimeout(daemonWatchdog);
		// Clear the in-place rendered chart
		if (lastLineCount > 0) clearPreviousLines(lastLineCount);
		showCursor();
		cleanupStdin();
		// Reprint final chart as static scrollback output
		if (lastBuffer.length > 0) {
			for (const l of lastBuffer) console.log(l);
		}
		console.log(`WTFT watch stopped \u2014 ${interactionCount} interactions, $${totalCost.toFixed(4)} total cost.`);
		process.exit(0);
	};

	process.on("SIGINT", exitWatch);

	// DAEMON HEALTH TRACKING
	let daemonDead = false;
	let daemonStopReason: DaemonHealthReason | null = null;
	let daemonStopTime = "";
	let daemonRestarting = false;
	let daemonIdle = false;
	let daemonIdleMs = 0;
	let daemonCacheTtlMs: number | null | undefined = undefined;
	let daemonChecked = false;  // true after first health check completes

	const updateDaemonHealth = () => {
		daemonChecked = true;
		if (daemonRestarting) {
			// Check if daemon came back online after restart.
			const health = checkDaemonHealth(sessionPath, tagPath);
			if (health.alive) {
				daemonRestarting = false;
				daemonDead = false;
				daemonStopReason = null;
				daemonStopTime = "";
				daemonIdle = false;
			}
			return;
		}
		const health = checkDaemonHealth(sessionPath, tagPath);
		if (!health.alive) {
			// Debounce: if the PID is dead but the tag file was recently written
			// (within 2s), a new daemon instance is spinning up — mask the restart
			// gap by treating the state as unchanged instead of "stopped."
			try {
				const tagStat = fs.statSync(tagPath);
				if (Date.now() - tagStat.mtimeMs < 2000 && tagStat.size > 0) return;
			} catch { /* tag file missing — genuinely dead */ }
			daemonDead = true;
			daemonStopReason = health.reason ?? null;
			daemonStopTime = health.lastHbTime || "";
			daemonIdle = false;
		} else if (health.idle) {
			daemonDead = false;
			daemonStopReason = null;
			daemonStopTime = "";
			daemonIdle = true;
			daemonIdleMs = health.idleMs || 0;
			daemonCacheTtlMs = health.cacheTtlMs;
		} else {
			daemonDead = false;
			daemonStopReason = null;
			daemonStopTime = "";
			daemonIdle = false;
		}
	};

	// Raw stdin for 'q'/'Q' quit and 'r' daemon restart.
	const cleanupStdin = enterRawStdin((key: string) => {
		if (key === "q" || key === "Q" || key === "\u0003") {
			exitWatch();
		}
		if (key === "r" || key === "R") {
			if (settings.daemonPath) {
				daemonRestarting = true;
				daemonDead = false;
				daemonIdle = false;
				const ok = restartDaemon(sessionPath, settings.daemonPath);
				if (!ok) {
					daemonRestarting = false;
					daemonDead = true;
					daemonStopReason = "restart-failed";
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
	// Read emoji setting from session file (not from WatchSettings — emoji disable
	// is only toggled via Pi, never from CLI flags)
	let disabledEmoji = false;
	let allInteractions: Interaction[] = readClassifiedTagFile(tagPath);
	let lastReadOffset = 0;
	try {
		lastReadOffset = fs.statSync(tagPath).size;
	} catch {}

	// Session-level settings from inline wtft-settings entries.
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
		// Clear previous render using visual-line count (handles wrapping + resize).
		if (lastLineCount > 0) clearPreviousLines(lastLineCount);

		const width = getTerminalWidth();
		const pad = settings.pad || 0;
		const maxPad = Math.max(0, Math.floor(width / 2) - 1);
		const actualPad = Math.min(pad, maxPad);
		const padStr = " ".repeat(actualPad);
		const paddedWidth = width - 2 * actualPad;
		const finalInterval = settings.hasInterval ? settings.interval : (sessionInterval ?? settings.interval);
		const finalLimit = settings.hasLimit ? settings.limit : (sessionLimit ?? settings.limit);
		const finalMode = settings.hasMode ? settings.mode : (sessionMode ?? settings.mode);
		const finalShowTicks = settings.hasTicks ? settings.showTicks : (sessionShowTicks ?? settings.showTicks);
		const finalTimezone = settings.hasTimezone ? settings.timezone : (sessionTimezone ?? settings.timezone);
		const finalWidth = Math.min(paddedWidth, 1023);

		const defaultSettings = {
			interval: "1h", limit: 100, width: finalWidth,
			showTicks: true, mode: "cumulative" as "cumulative" | "bucket",
			timezone: undefined
		};

		// Deduplicate by message.id — dedupeClassifiedById, NOT deduplicateInteractions.
		// `allInteractions` here always came from readClassifiedTagFile or the
		// fs.watch branch's own dedupeClassifiedById call — both already
		// collapse tag-file lines sharing one
		// message.id, taking max cost — so calling dedupeClassifiedById again is a
		// true no-op here (it returns the input unchanged when nothing repeats,
		// docs/wtft-incremental-render-spec.md#dedupeClassifiedById). Present as
		// cheap insurance against a caller reaching this point some other way.
		//
		// deduplicateInteractions is NOT safe as that insurance, even against
		// already-deduped input: it returns `[...withoutId, ...idGroups]`, so any
		// interaction lacking a message.id is moved ahead of every id-bearing one
		// regardless of true chronological order — the exact non-chronological
		// hazard this spec section's "Return Order Is Not Chronological" section
		// describes (docs/wtft-incremental-render-spec.md). dedupeClassifiedById
		// preserves first-appearance order (`slots`/`slotIds`), so it is the only
		// one of the two safe to call on data that's about to be rendered in order.
		const deduped = dedupeClassifiedById(allInteractions);
		interactionCount = deduped.length;

		const lines = buildWtftLines(deduped, defaultSettings, {
			interval: finalInterval,
			limit: finalLimit,
			width: finalWidth,
			showTicks: finalShowTicks,
			mode: finalMode,
			timezone: finalTimezone,
			unit: settings.unit,
			disabledEmoji,
		});

		const buf: string[] = [];
		buf.push(`\x1b[90m${sessionPath}\x1b[0m`);
		totalCost = deduped.reduce((sum, i) => sum + i.cost, 0);

		if (lines && lines.length > 0) {
			// Append daemon status (inline if it fits, otherwise separate line).
			let daemonStatusStr = "";
			if (!daemonChecked) {
				daemonStatusStr = "  \x1b[90m●\x1b[0m reading...";
			} else if (daemonRestarting) {
				daemonStatusStr = renderDaemonStatus({ alive: true }, true);
			} else if (daemonDead) {
				daemonStatusStr = renderDaemonStatus({ alive: false, reason: daemonStopReason ?? undefined, lastHbTime: daemonStopTime || undefined }, false);
			} else if (daemonIdle) {
				daemonStatusStr = renderDaemonStatus({ alive: true, idle: true, idleMs: daemonIdleMs, cacheTtlMs: daemonCacheTtlMs }, false);
			} else {
				daemonStatusStr = renderDaemonStatus({ alive: true }, false);
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
		} else if (!fs.existsSync(sessionPath)) {
			// #308: the transcript itself is unwritten — a fact, not a fault. Claude
			// Code writes it after the first real prompt (not a /command) completes.
			buf.push("\x1b[90mWaiting for session .jsonl to be written (first prompt not completed yet)...\x1b[0m");
		} else {
			buf.push("\x1b[90mWaiting for session data...\x1b[0m");
		}

		// Footer row
		const restartHint = settings.daemonPath
			? `, using v${WTFT_TAGGER_VERSION}, ` + (daemonDead ? `\x1b[31m'r' to restart\x1b[0m` : `'r' to restart`)
			: "";
		buf.push(`'q' to exit${restartHint}`);

		lastBuffer = [...buf];

		// Write all lines, then compute visual-line count for next clear
		const allLines = buf.map(l => padStr + l);
		const out = allLines.map(l => l + "\n").join("");
		process.stdout.write(out);
		const cols = process.stdout.columns || 80;
		lastLineCount = visualLineCount(out, cols);
		needsRedraw = false;
	};

	// Initial render
	render();
	resetWatchdog();

	// SIGWINCH handler — re-render on resize. clearPreviousLines uses the
	// previous render's visual-line count (computed at the old terminal width),
	// so it always clears the correct number of rows.
	process.on("SIGWINCH", () => {
		render();
		resetWatchdog();
	});

	// fs.watch on the classified tag file (inotify on Linux).
	// The daemon guarantees:
	//   - Writes at most every 667ms (90bpm)
	//   - Every line is a complete JSON + \n (atomic fs.appendFileSync)
	//   - No partial lines, no mid-write reads
	// Therefore every "change" event = one or more complete lines ready.
	// No debounce needed — double-fire is harmless (stat.size check is a no-op).
	//
	// Wait up to 5s for the daemon to create the tag file before watching.
	let watcher: fs.FSWatcher | null = null;

	const startWatching = () => {
		watcher = fs.watch(tagPath, (eventType) => {
			if (eventType !== "change") return;

			try {
				const stat = fs.statSync(tagPath);

				// File grew — read new data and accumulate
				if (stat.size > lastReadOffset) {
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
							if (obj._hb) continue;
							const interaction = classifiedToInteraction(obj);
							if (interaction) {
								allInteractions.push(interaction);
								newCount++;
							}
						} catch {}
					}

					if (newCount > 0) {
						// This path appends straight to the accumulator and never
						// goes through readClassifiedTagFile, so it needs the same
						// collapse (#270 review) — otherwise the live watch, the
						// one surface a human is actually staring at, is the only
						// consumer that still double-counts a re-emitted message.
						//
						// COST, measured rather than argued (PR review), because
						// this is a full pass over the WHOLE accumulator on every
						// append event, which over a session's life is O(n^2) in
						// interactions. That is true asymptotically and negligible
						// in practice, and the numbers are the reason this is left
						// as a single canonical call instead of being hand-rolled
						// into an incremental merge:
						//
						// Re-derive with `bun research/270-watch-dedup-bench.ts`
						// (median of 40 passes, JIT warmed, 50% of ids re-emitted):
						//
						//   n =  1,184 (the largest real session measured on this
						//                host, #270's own specimen 7c0c2b7e)
						//                        0.255ms/pass = 0.038% of a 667ms beat
						//   n =  4,736 (4x)      0.917ms/pass = 0.138%
						//   n = 11,840 (10x)     2.090ms/pass = 0.313%
						//   n = 23,680 (20x)     6.423ms/pass = 0.963%
						//
						// The first version of this table was a hand-run nobody
						// saved and it was not even MONOTONIC — it put 11,840
						// items (0.791ms) BELOW 4,736 (0.879ms), because the
						// smallest n had absorbed the JIT compile cost and the
						// others had not (PR review). That is the same defect
						// research/270-subagent-parse-bench.ts exists to prevent
						// for the parse figures, so these get the same treatment.
						//
						// What the corrected numbers say, stated no more strongly
						// than they support (PR review caught the first attempt
						// overstating this too, twice): per-item cost stays in a
						// NARROW BAND rather than being flat. Derived from the
						// table above and nothing else — ms/pass divided by n —
						// that band is 0.177-0.271us: 0.215 / 0.194 / 0.177 /
						// 0.271us at the four sizes, reliably highest at the 20x
						// point. So 20x the items costs ~25x the time, not 20x.
						// (Re-runs under load shift the whole band upward, to
						// ~0.32us at the 20x point — but that is a DIFFERENT run,
						// and quoting its peak beside this run's table is how the
						// previous draft came to state an upper bound its own
						// numbers did not support.) Each pass is O(n) by construction; the mild
						// super-linearity on top is allocation and cache pressure
						// from the larger Map, not a change in the algorithm.
						// Absolute figures move ~25% run to run with host load, so
						// treat the table as one representative run of the script,
						// not a constant.
						//
						// The practical bound is what carries the decision, and it
						// is unaffected: even at 20x the largest session this host
						// has ever produced, one pass is ~1% of a poll beat, so the
						// quadratic term over a session's life is nowhere near the
						// thing that matters. An
						// incremental merge would have to re-implement
						// deduplicateInteractions' max-cost-and-union-files rule
						// to save 0.1% of a poll, and a second implementation of
						// that rule is precisely the drift this file's other
						// review findings are about.
						allInteractions = dedupeClassifiedById(allInteractions);
						updateDaemonHealth();
						needsRedraw = true;
						render();
						resetWatchdog();
						return;
					}
				}

				// In-place modification (heartbeat overwrite): file didn't grow
				// but the idle timestamp changed. Refresh health status so the
				// countdown (e.g. "idle (cache expires in 3min)") stays current.
				updateDaemonHealth();
				needsRedraw = true;
				render();
				resetWatchdog();
			} catch {
				// Tag file may have been deleted or truncated — re-read from zero
				try {
					lastReadOffset = 0;
					allInteractions = readClassifiedTagFile(tagPath);
					lastReadOffset = fs.statSync(tagPath).size;
					needsRedraw = true;
					render();
					resetWatchdog();
				} catch {
					// File gone — wait for it to reappear
				}
			}
		});
	};

	// Wait for the tag file on STATE, not the clock (#308). The daemon creates it
	// at startup (initClassified) — before the session .jsonl even exists — so its
	// absence means one of three things, each answerable without a stopwatch:
	//   - the daemon is still starting → its lease is not claimed yet and the child
	//     we spawned has not exited → keep waiting;
	//   - another daemon owns the lease (singleton) → alive → keep waiting, its file
	//     is coming;
	//   - the child we spawned exited and nobody holds the lease → it is dead → say
	//     so, with its exit code, and stop.
	// The retired 5 s ceiling turned "still starting on a slow box" into a false
	// "did not create tag file". Without a child handle there is no fact to ask,
	// so that caller keeps a bounded ceiling — documented, not hidden.
	const child = settings.daemonChild ?? null;
	const NO_HANDLE_CEILING_MS = 5000;
	// Leave the terminal sane before an error exit: drop the in-place render,
	// restore the cursor and cooked stdin. (exitWatch() would exit 0 — wrong here.)
	const teardownForError = () => {
		if (daemonWatchdog) clearTimeout(daemonWatchdog);
		if (lastLineCount > 0) clearPreviousLines(lastLineCount);
		showCursor();
		cleanupStdin();
	};
	const fileWaitStart = Date.now();
	for (;;) {
		if (fs.existsSync(tagPath)) break;
		// Re-resolve before judging the lease (#309 review). A daemon that is alive
		// but writing into a sibling project dir is not "still starting" — its file
		// already exists, just not where we last looked. Without this, `leaseAlive`
		// stays true and the own-dir path never appears: neither exit condition can
		// ever fire, and the loop spins for the life of the terminal.
		const resolved = getCurrentVersionTagPath(sessionPath);
		if (resolved !== tagPath && fs.existsSync(resolved)) { tagPath = resolved; break; }
		const childExited = child ? (child.exitCode !== null || child.signalCode !== null) : false;
		const leaseAlive = checkDaemonHealth(sessionPath, tagPath).alive;
		if (child && childExited && !leaseAlive) {
			teardownForError();
			const how = child.signalCode ? `on ${child.signalCode}` : `with code ${child.exitCode}`;
			console.error(`❌ wtft-daemon exited ${how} before creating its tag file.`);
			console.error(`   Expected: ${tagPath}`);
			process.exit(1);
		}
		if (!child && Date.now() - fileWaitStart > NO_HANDLE_CEILING_MS && !leaseAlive) {
			teardownForError();
			console.error(`❌ No wtft-daemon holds the lease for this session and no tag file appeared within ${NO_HANDLE_CEILING_MS / 1000}s. Is wtft-daemon installed?`);
			console.error(`   Expected: ${tagPath}`);
			process.exit(1);
		}
		await new Promise(r => setTimeout(r, 250));
	}

	// Seed the reader from the file that actually won (#309 review). The initial
	// read above ran before the wait, when the path was still empty or pointed at
	// the wrong dir — so `allInteractions` is empty and `lastReadOffset` is 0. An
	// adopted sibling file already holds the whole session; without re-seeding,
	// the first frame renders nothing and everything written before now is only
	// picked up by luck, on whatever change event happens next.
	allInteractions = readClassifiedTagFile(tagPath);
	try { lastReadOffset = fs.statSync(tagPath).size; } catch { lastReadOffset = 0; }
	needsRedraw = true;
	render();

	startWatching();

	// Initial daemon health check — run after a short settle (500ms) instead of
	// 10s so the idle/live status updates quickly when the daemon is already idle.
	setTimeout(() => { updateDaemonHealth(); needsRedraw = true; render(); resetWatchdog(); }, 500);

	// Keep the process alive (fs.watch + watchdog are the event sources).
	// This is an intentional infinite await — exitWatch() calls process.exit().
	await new Promise(() => {});
}

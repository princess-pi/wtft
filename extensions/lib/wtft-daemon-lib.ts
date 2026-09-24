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
import { splitOverheadCost, isModelTagged } from "./wtft-parser.js";
import { getDiscoveries } from "./harness/registry.ts";
import { projectsDir } from "./harness/claude-code/discovery.js";
import { showCursor, hideCursor, enterRawStdin, clearPreviousLines, visualLineCount } from "./tty-helpers.js";
export interface WatchSettings {
	interval: string;
	limit: number;
	mode: "cumulative" | "bucket";
	showTicks: boolean;
	timezone?: string;
	unit?: "cost" | "tokens";
	daemonPath?: string; // path to wtft-daemon.mjs (CLI watch mode only)
	daemonChild?: ChildProcess | null;
	pad?: number;
	hasInterval?: boolean;
	hasLimit?: boolean;
	hasMode?: boolean;
	hasTicks?: boolean;
	hasTimezone?: boolean;
	disabledEmoji?: boolean;
}


/**
 * This is the single source of truth for the tag-file wire format.
 * Must stay in sync with classifiedToInteraction (below).
 * When adding a field, update BOTH functions in this file.
 * `source` is set for a child transcript's lines: see `transcriptSourceId`.
 */
export function serializeClassified(interaction: Interaction, source?: string): string {
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
	if (interaction.messageId) line.id = interaction.messageId;
	if (interaction.model) line.m = interaction.model;
	if (interaction.inputTokens > 0) line.in = interaction.inputTokens;
	if (interaction.outputTokens > 0) line.out = interaction.outputTokens;
	if (interaction.cacheReadTokens > 0) line.cr = interaction.cacheReadTokens;
	if (interaction.cacheWriteTokens > 0) line.cw = interaction.cacheWriteTokens;
	if (interaction.reasoningTokens > 0) line.rs = interaction.reasoningTokens;
	if (interaction.serverToolCost) line.sc = Number(interaction.serverToolCost.toFixed(6));
	if (interaction.webSearchRequests > 0) line.ws = interaction.webSearchRequests;
	if (interaction.webFetchRequests > 0) line.wf = interaction.webFetchRequests;
	if (interaction.thinkingLevel) line.tl = interaction.thinkingLevel;
	if (interaction.compactionTokensBefore) line.cb = interaction.compactionTokensBefore;
	if (interaction.toolCats && interaction.toolCats.length > 0) line.tc = interaction.toolCats;
	if (interaction.unrecognizedTool) line.ut = 1;
	if (interaction.cacheTtl) line.ttl = interaction.cacheTtl;
	if (interaction.cacheMiss) line.miss = 1;
	if (interaction.interrupted) line.ir = 1;
	if (interaction.surgePriced) line.sp = 1;
	if (source) line.s = source;
	return JSON.stringify(line) + "\n";
}

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
		source: typeof obj.s === "string" ? obj.s : undefined,
		_cat: obj.cat || undefined,
	};
}

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
		out.push(group.length === 1 ? group[0] : deduplicateInteractions(group)[0]);
	}
	return out;
}

export type TagProvisionalReason = "stale-version" | "unswept" | "subagent-unreadable" | "descendant-live";

export interface TagProvisional {
	provisional: boolean;
	reason: TagProvisionalReason | null;
}

export function describeProvisionalReason(provisional: { reason: string | null }, tagPath: string): string {
	if (provisional.reason === "stale-version") {
		const v = path.basename(tagPath).match(/\.wtft-tag\.v([^/]+)\.jsonl$/)?.[1] ?? "?";
		return `this tag was written by tagger v${v}, not v${WTFT_TAGGER_VERSION}`;
	}
	if (provisional.reason === "subagent-unreadable") {
		return "a subagent session file could not be read, so its cost may be missing";
	}
	if (provisional.reason === "descendant-live") {
		return `a descendant session wrote to its transcript in the last ${IDLE_THRESHOLD_MS / 1000} s, so the tree total may still grow`;
	}
	return "no subagent transcript has been read since this tag was written";
}

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

export function lastLineStartByte(fd: number, size: number, chunkSize = 512): number {
	if (size <= 0) return 0;
	const one = Buffer.alloc(1);
	if (fs.readSync(fd, one, 0, 1, size - 1) !== 1) {
		throw new Error(`could not read the last byte of a ${size}-byte tag file — refusing to guess a line boundary`);
	}
	// A terminating newline belongs to the last line, not to a line after it.
	let searchEnd = one[0] === 0x0a ? size - 1 : size;
	while (searchEnd > 0) {
		const readSize = Math.min(chunkSize, searchEnd);
		const start = searchEnd - readSize;
		const buf = Buffer.alloc(readSize);
		fs.readSync(fd, buf, 0, readSize, start);
		const nl = buf.lastIndexOf(0x0a);
		if (nl !== -1) return start + nl + 1;
		searchEnd = start;
	}
	return 0;
}

export function tagProvisionalFromContent(tagPath: string, content: string): TagProvisional {
	// Version first: it needs no content at all, and it outranks the sweep state.
	if (!path.basename(tagPath).endsWith(`.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`)) {
		return { provisional: true, reason: "stale-version" };
	}
	if (!content) return { provisional: false, reason: null };

	const lines = content.split("\n");

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

	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line);
			if (obj._hb) continue;
			if (obj._meta) {
				if (typeof obj._meta.unswept === "number") {
					return { provisional: true, reason: "unswept" };
				}
				if (typeof obj._meta.swept === "number") {
					return { provisional: false, reason: null };
				}
				continue; // an offset line, or a marker shape this writer never emits
			}
			return { provisional: true, reason: "unswept" };
		} catch { continue; }
	}
	return { provisional: true, reason: "unswept" };
}

export function readTagFileWithVerdict(tagPath: string): {
	interactions: Interaction[];
	provisional: TagProvisional;
	/** Sessions whose cost the daemon folded into this tag's lines. */
	folded: Set<string>;
} {
	let content = "";
	try {
		content = fs.readFileSync(tagPath, "utf8");
	} catch { /* missing or unreadable — every part handles "" */ }
	const records = currentGenerationRecords(content);
	return {
		interactions: interactionsFromRecords(records),
		provisional: tagProvisionalFromContent(tagPath, content),
		folded: foldedIdsFromRecords(records),
	};
}

/** The sessions a parsed child transcript puts into the tag's total: the child
 *  itself, and every session folded onto one of its model-tagged turns. A fold
 *  on an untagged turn lands in `untaggedCostUsd`, not in the total, so it is
 *  not recorded — the spawn walk would otherwise skip money no total holds. */
export function foldRecordIds(childSessionId: string, deduped: Interaction[]): string[] {
	const ids = [childSessionId];
	for (const interaction of deduped) {
		if (!isModelTagged(interaction)) continue;
		for (const fold of interaction.claudeSubAgentFolds ?? []) {
			if (!ids.includes(fold.id)) ids.push(fold.id);
		}
	}
	return ids;
}

export function foldRecordLine(parent: string, child: string, source: string): string {
	return JSON.stringify({ _fold: { parent, child, s: source } }) + "\n";
}

/** The `s` a child transcript's tag lines carry. Keyed on the path, not on the
 *  session id: two copies of one session are two sources. A child under the
 *  session directory is keyed on its path relative to it, so a session that
 *  moves keeps it; one outside is keyed on its absolute path, which the move
 *  does not change either. */
export function transcriptSourceId(file: string, sessionDir: string): string {
	const target = path.resolve(file);
	const rel = path.relative(path.resolve(sessionDir), target);
	const escapes = rel === ".." || rel.startsWith(".." + path.sep);
	const key = escapes || path.isAbsolute(rel) ? target : rel;
	return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

/** Opens a new generation for `source`: every earlier line carrying it stops counting. */
export function generationRecordLine(source: string, session: string): string {
	return JSON.stringify({ _gen: { s: source, session } }) + "\n";
}

/** Every parsed line of a tag, minus those a later `_gen` record for the same
 *  source superseded. A line with no `s` belongs to the tag's own session and
 *  is never superseded. */
export function currentGenerationRecords(content: string): any[] {
	const records: any[] = [];
	const lastGenAt = new Map<string, number>();
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let obj: any;
		try { obj = JSON.parse(line); } catch { continue; }
		if (!obj || typeof obj !== "object") continue;
		const gen = obj._gen?.s;
		if (typeof gen === "string") lastGenAt.set(gen, records.length);
		records.push(obj);
	}
	if (lastGenAt.size === 0) return records;
	return records.filter((obj, at) => {
		const s = obj._fold ? obj._fold.s : obj.s;
		if (typeof s !== "string") return true;
		const genAt = lastGenAt.get(s);
		return genAt === undefined || at > genAt;
	});
}

function foldedIdsFromRecords(records: any[]): Set<string> {
	const ids = new Set<string>();
	for (const obj of records) {
		const child = obj._fold?.child;
		if (typeof child === "string" && child) ids.add(child);
	}
	return ids;
}

function interactionsFromRecords(records: any[]): Interaction[] {
	const interactions: Interaction[] = [];
	for (const obj of records) {
		if (obj._hb) continue;
		try {
			const interaction = classifiedToInteraction(obj);
			if (interaction) interactions.push(interaction);
		} catch {
		}
	}
	return dedupeClassifiedById(interactions);
}

export function foldedSessionIdsFromContent(content: string): Set<string> {
	return foldedIdsFromRecords(currentGenerationRecords(content));
}

export function classifiedInteractionsFromContent(content: string): Interaction[] {
	return interactionsFromRecords(currentGenerationRecords(content));
}

export function readClassifiedTagFile(tagPath: string): Interaction[] {
	let content = "";
	try {
		content = fs.readFileSync(tagPath, "utf8");
	} catch {
	}
	return classifiedInteractionsFromContent(content);
}

export const PREFIX_SENTINEL_BYTES = 64;

export interface PrefixSentinel {
	/** Start byte of the last COMPLETE line at or before the reader's offset —
	 *  the boundary below which the file is append-only. Part of the comparison,
	 *  not bookkeeping: a rebuild that reshapes the file moves it. */
	anchor: number;
	bytes: Buffer;
}

export function readPrefixSentinel(tagPath: string, offset: number): PrefixSentinel | null {
	if (offset <= 0) return { anchor: 0, bytes: Buffer.alloc(0) };
	let fd: number;
	try { fd = fs.openSync(tagPath, "r"); } catch { return null; }
	try {
		// Scoped to the consumed prefix, not to the file: `offset` stands in for
		// `size`, so the anchor is the last line the READER took, never a line
		// appended since.
		const anchor = lastLineStartByte(fd, offset);
		const want = Math.min(PREFIX_SENTINEL_BYTES, anchor);
		if (want === 0) return { anchor, bytes: Buffer.alloc(0) };
		const buf = Buffer.alloc(want);
		const read = fs.readSync(fd, buf, 0, want, anchor - want);
		return read === want ? { anchor, bytes: buf } : null;
	} catch {
		return null;
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Did the consumed prefix survive? `null` on either side means "could not read",
 * which `watcherAction` turns into a re-seed rather than an idle.
 * BOTH fields count. The bytes catch a rebuild that rewrote the prefix in place;
 * the anchor catches one that kept those bytes but changed the line structure
 * above them — including the case where the anchor is 0 because the reader has
 * consumed a single line and there are no bytes below it to compare.
 */
export function sentinelMatches(a: PrefixSentinel | null, b: PrefixSentinel | null): boolean | null {
	if (a === null || b === null) return null;
	return a.anchor === b.anchor && a.bytes.equals(b.bytes);
}

/**
 * What a tag-file watcher should do with the file it just saw.
 * `reseed` — the prefix is gone or changed underneath us; re-read the file whole.
 * `read`   — the file grew and the prefix is intact; read from the offset.
 * `idle`   — nothing to do, or nothing we can substantiate.
 */
export type WatcherAction = "reseed" | "read" | "idle";

export function watcherAction(
	size: number,
	lastReadOffset: number,
	prefixMatches: boolean | null,
): WatcherAction {
	if (size < lastReadOffset) return "reseed";
	if (prefixMatches === false) return "reseed";
	// "Could not read" re-seeds. Idling here deadlocks the watch — see above.
	if (prefixMatches === null) return "reseed";
	if (size > lastReadOffset) return "read";
	return "idle";
}

/** Whether the bytes appended since `offset` open a new generation, which can
 *  drop lines already read — an incremental append cannot express that. */
function appendedGeneration(tagPath: string, offset: number, size: number): boolean {
	if (size <= offset) return false;
	const fd = fs.openSync(tagPath, "r");
	try {
		const buf = Buffer.alloc(size - offset);
		const read = fs.readSync(fd, buf, 0, buf.length, offset);
		// A short read leaves the tail zero-filled: reseed rather than miss a record.
		return read < buf.length || buf.subarray(0, read).includes('"_gen"');
	} finally {
		fs.closeSync(fd);
	}
}

export function seedClassifiedTagFile(tagPath: string): { interactions: Interaction[]; offset: number; read: boolean } {
	let buf: Buffer;
	try {
		buf = fs.readFileSync(tagPath);
	} catch {
		return { interactions: [], offset: 0, read: false };
	}
	const offset = buf.lastIndexOf(0x0a) + 1;   // -1 -> 0: no complete line yet
	return {
		interactions: classifiedInteractionsFromContent(buf.subarray(0, offset).toString("utf8")),
		offset,
		read: true,
	};
}


export { WTFT_TAGGER_VERSION } from "./wtft-tagger-version.js";
import { WTFT_TAGGER_VERSION } from "./wtft-tagger-version.js";

export function serializeClassifiedWithOverheadSplit(interaction: Interaction, prevCtxTokens: number): string {
	const split = splitOverheadCost(interaction, prevCtxTokens);
	if (!split) return serializeClassified(interaction);
	const remainder: Interaction = {
		...interaction,
		cost: Math.max(0, interaction.cost - split.overheadCost),
		cacheWriteTokens: 0,
		afterCompaction: undefined,
		// A recache is a Cache Miss even when a small prefix stayed cached, so
		// every Ovrhd recache also gets a divider.
		cacheMiss: split.kind === "overhead" ? true : interaction.cacheMiss,
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

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function isSessionIdBasename(sessionPath: string): boolean {
	return UUID_RE.test(path.basename(sessionPath));
}

function findSiblingTagPath(sessionPath: string): string | null {
	if (!isSessionIdBasename(sessionPath)) return null;
	const sessionBase = path.basename(sessionPath);
	const wanted = sessionBase + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`;
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

export function getDaemonPidPath(sessionPath: string): string {
	const key = isSessionIdBasename(sessionPath) ? path.basename(sessionPath) : sessionPath;
	const sessionHash = createHash("sha256").update(key).digest("hex").slice(0, 12);
	return path.join(os.tmpdir(), `wtft-daemon-${sessionHash}.pid`);
}

function pathIsUnder(file: string, root: string): boolean {
	const resolvedFile = path.resolve(file);
	const resolvedRoot = path.resolve(root);
	return resolvedFile === resolvedRoot || resolvedFile.startsWith(resolvedRoot + path.sep);
}

/** A session under a harness root is served by that root's one daemon. */
export function daemonLaunchArgs(sessionPath: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const claude = projectsDir(env);
	const pi = env.WTFT_PI_SESSIONS_DIR || path.join(os.homedir(), ".pi", "agent", "sessions");
	if (pathIsUnder(sessionPath, claude)) return ["--harness", "claude", "--session", sessionPath];
	if (pathIsUnder(sessionPath, pi)) return ["--harness", "pi", "--session", sessionPath];
	return ["--session", sessionPath];
}

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

export function getModelCacheTtlMs(model: string): number | null {
	const m = model.toLowerCase();

	if (m.includes("deepseek")) {
		return 60 * 60 * 1000;
	}

	if (m.includes("claude")) {
		return 5 * 60 * 1000;
	}

	if (m.includes("gemini")) {
		return 60 * 60 * 1000;
	}

	if (m.includes("gpt") || m.includes("o1") || m.includes("o3")) {
		return 30 * 60 * 1000;
	}

	if (m.includes("together") || m.includes("fireworks") || m.includes("openrouter")) {
		return 30 * 60 * 1000;
	}

	if (/\b(haiku|sonnet|opus)\b/.test(m)) {
		return 5 * 60 * 1000;
	}

	if (m.includes("ollama") || m.includes("llama") || m.includes("lmstudio") || m.includes("local")) {
		return null;
	}

	return 5 * 60 * 1000;
}

// ---

/**
 * Stable machine-readable daemon health codes. THIS is the contract — control flow
 * compares these, never the rendered text. Adding a member is a feature; renaming or
 * removing one is a breaking change. The human sentences in DAEMON_REASON_TEXT are free
 * to change at any time precisely because this union exists.
 */
export type DaemonHealthReason =
	| "not-started"      // no daemon spawned for this session yet
	| "starting"
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

export function daemonReasonText(reason: DaemonHealthReason | undefined | null): string {
	return (reason && DAEMON_REASON_TEXT[reason]) || "unknown";
}

export interface DaemonStatus {
	alive: boolean;
	reason?: DaemonHealthReason;
	lastHbTime?: string; // HH:MM local time of last heartbeat
	idle?: boolean;
	idleMs?: number;
	idleSinceMs?: number;
	cacheTtlMs?: number | null;
}

export function renderDaemonStatus(status: DaemonStatus, restarting = false): string {
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
		const elapsedMs = status.idleSinceMs != null ? Date.now() - status.idleSinceMs : (status.idleMs || 0);
		if (cacheTtlMs != null && elapsedMs > 0) {
			const remainingMin = Math.ceil(Math.max(0, cacheTtlMs - elapsedMs) / 60_000);
			if (remainingMin <= 0) {
				return "  \x1b[33m●\x1b[0m idle (cache emptied)";
			}
			return `  \x1b[33m●\x1b[0m idle (cache expires in ${remainingMin}min)`;
		}
		if (cacheTtlMs === null) {
			return "  \x1b[33m●\x1b[0m idle (local model)";
		}
		return "  \x1b[33m●\x1b[0m idle";
	}
	return "  \x1b[32m●\x1b[0m live";
}

/**
 * Fallback: scan the ENTIRE session file backwards for the most recent
 * assistant message's model.
 * Reads the whole file — session files are typically < 1MB, so this is
 * fast enough. Using an 8KB window caused flickering because the model
 * entry could fall outside the window as the tag file grew.
 */
function getModelFromSessionFile(sessionPath: string): string | undefined {
	try {
		const content = fs.readFileSync(sessionPath, "utf8");
		const lines = content.split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type === "message" && entry.message?.role === "assistant" && entry.message?.model) {
					return entry.message.model;
				}
				if (entry.type === "assistant" && entry.message?.role === "assistant" && entry.message?.model) {
					return entry.message.model;
				}
			} catch { continue; }
		}
	} catch { /* session file unreadable */ }
	return undefined;
}

export function checkDaemonHealth(sessionPath: string, tagPath: string): DaemonStatus {
	const pidPath = getDaemonPidPath(sessionPath);
	let pidAlive = false;
	try {
		const pid = parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
		if (pid > 0) {
			try { process.kill(pid, 0); pidAlive = true; } catch {}
		}
	} catch {}

	if (pidAlive) {
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
				for (let i = lines.length - 1; i >= 0; i--) {
					const line = lines[i].trim();
					if (!line) continue;
					try {
						const obj = JSON.parse(line);
						if (!lastModel && obj.m) lastModel = obj.m;
						if (!lastTtl && (obj.ttl === "1h" || obj.ttl === "5m")) lastTtl = obj.ttl;
						if (obj._hb) {
							if (typeof obj._hb === "object" && obj._hb.first && idleSinceMs === undefined && !sawClassified) {
								idleSinceMs = obj._hb.first;
							}
							continue;
						}
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
					if (!lastModel) lastModel = getModelFromSessionFile(sessionPath);
					const cacheTtlMs = lastTtl
						? (lastTtl === "1h" ? 3_600_000 : 300_000)
						: (lastModel ? getModelCacheTtlMs(lastModel) : null);
					return { alive: true, idle: true, idleMs, idleSinceMs, cacheTtlMs };
				}
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

	let lastHbMs = 0;
	try {
		const stat = fs.statSync(tagPath);
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

	const d = new Date(lastHbMs);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const timeStr = `${hh}:${mm}`;

	return { alive: false, reason: "idle-timeout", lastHbTime: timeStr };
}

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
	const pidPath = getDaemonPidPath(sessionPath);
	try {
		const pid = parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
		// A harness process serves every session under its root, so it is asked
		// to serve this one (the spawn below points it here), never stopped.
		if (pid > 0 && !isHarnessProcess(pid)) {
			try { process.kill(pid, "SIGTERM"); } catch {}
			try { fs.unlinkSync(pidPath); } catch {}
		}
	} catch {}

	try {
		const child = spawn(process.execPath, [daemonPath, ...daemonLaunchArgs(sessionPath)], {
			detached: true,
			stdio: "ignore"
		});
		child.unref();
		return true;
	} catch {
		return false;
	}
}


function isHarnessProcess(pid: number): boolean {
	try {
		return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes("--harness");
	} catch {
		return false;
	}
}

/** What `--watch` shows before the current tag has any turns. A stale-version
 *  tag means the log parser daemon is rebuilding it, which a reader should be
 *  told rather than left looking at an empty screen. */
export function waitingForDataLine(sessionPath: string, currentTagPath: string): string {
	if (!fs.existsSync(sessionPath)) return "Waiting for session .jsonl to be written (first prompt not completed yet)...";
	const newest = getTagPath(sessionPath);
	const stale = newest !== currentTagPath && fs.existsSync(newest) ? newest.match(/\.wtft-tag\.v([^/]+)\.jsonl$/)?.[1] : undefined;
	if (stale) return `Rebuilding this session's tag for tagger v${WTFT_TAGGER_VERSION} (the v${stale} tag is stale); its turns appear here when the log parser daemon reaches it...`;
	return "Waiting for session data...";
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

	hideCursor();
	let lastLineCount = 0;
	let lastBuffer: string[] = [];

	const exitWatch = () => {
		if (watcher) watcher.close();
		if (daemonWatchdog) clearTimeout(daemonWatchdog);
		if (lastLineCount > 0) clearPreviousLines(lastLineCount);
		showCursor();
		cleanupStdin();
		if (lastBuffer.length > 0) {
			for (const l of lastBuffer) console.log(l);
		}
		console.log(`WTFT watch stopped \u2014 ${interactionCount} interactions, $${totalCost.toFixed(4)} total cost.`);
		process.exit(0);
	};

	process.on("SIGINT", exitWatch);

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

	let disabledEmoji = typeof settings.disabledEmoji === "boolean" ? settings.disabledEmoji : false;
	let seed = seedClassifiedTagFile(tagPath);
	let allInteractions: Interaction[] = seed.interactions;
	let lastReadOffset = seed.offset;
	let prefixSentinel = readPrefixSentinel(tagPath, lastReadOffset);

	let sessionInterval: string | undefined;
	let sessionLimit: number | undefined;
	let sessionMode: "cumulative" | "bucket" | undefined;
	let sessionShowTicks: boolean | undefined;
	let sessionTimezone: string | undefined;

	try {
		const sessionContent = fs.readFileSync(sessionPath, "utf8");
		for (const line of sessionContent.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type === "custom" && entry.customType === "emoji-settings") {
					if (entry.data && typeof entry.data.disabled === "boolean" && settings.disabledEmoji === undefined) {
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
			}
		}
	} catch {
	}

	const render = () => {
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
					lines.splice(1, 0, daemonStatusStr.trim());
				}
			}

			for (const l of lines) buf.push(l);
		} else {
			buf.push(`\x1b[90m${waitingForDataLine(sessionPath, tagPath)}\x1b[0m`);
		}

		const restartHint = settings.daemonPath
			? `, using v${WTFT_TAGGER_VERSION}, ` + (daemonDead ? `\x1b[31m'r' to restart\x1b[0m` : `'r' to restart`)
			: "";
		buf.push(`'q' to exit${restartHint}`);

		lastBuffer = [...buf];

		const allLines = buf.map(l => padStr + l);
		const out = allLines.map(l => l + "\n").join("");
		process.stdout.write(out);
		const cols = process.stdout.columns || 80;
		lastLineCount = visualLineCount(out, cols);
		needsRedraw = false;
	};

	render();
	resetWatchdog();

	process.on("SIGWINCH", () => {
		render();
		resetWatchdog();
	});

	let watcher: fs.FSWatcher | null = null;

	const startWatching = () => {
		watcher = fs.watch(tagPath, (eventType) => {
			if (eventType !== "change") return;

			try {
				const stat = fs.statSync(tagPath);

				const sentinelNow = readPrefixSentinel(tagPath, lastReadOffset);
				const matches = sentinelMatches(sentinelNow, prefixSentinel);
				const action = watcherAction(stat.size, lastReadOffset, matches);
				if (action === "idle") return;
				if (action === "reseed" || appendedGeneration(tagPath, lastReadOffset, stat.size)) {
					const reseed = seedClassifiedTagFile(tagPath);
					if (!reseed.read) return;
					allInteractions = reseed.interactions;
					lastReadOffset = reseed.offset;
					prefixSentinel = readPrefixSentinel(tagPath, lastReadOffset);
					updateDaemonHealth();
					needsRedraw = true;
					render();
					resetWatchdog();
					return;
				}

				{
					const fd = fs.openSync(tagPath, "r");
					const buf = Buffer.alloc(stat.size - lastReadOffset);
					fs.readSync(fd, buf, 0, buf.length, lastReadOffset);
					fs.closeSync(fd);

					const lastNl = buf.lastIndexOf(0x0a);
					if (lastNl !== -1) {
						lastReadOffset += lastNl + 1;
						prefixSentinel = readPrefixSentinel(tagPath, lastReadOffset);

						const newContent = buf.subarray(0, lastNl + 1).toString("utf8");
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
							allInteractions = dedupeClassifiedById(allInteractions);
							updateDaemonHealth();
							needsRedraw = true;
							render();
							resetWatchdog();
							return;
						}
					}
				}

				// In-place modification (heartbeat overwrite): file didn't grow
				// but the idle timestamp changed.
				updateDaemonHealth();
				needsRedraw = true;
				render();
				resetWatchdog();
			} catch {
				try {
					const fresh = seedClassifiedTagFile(tagPath);
					if (!fresh.read) return;   // no information — keep the last good chart
					allInteractions = fresh.interactions;
					lastReadOffset = fresh.offset;
					prefixSentinel = readPrefixSentinel(tagPath, lastReadOffset);
					seed = fresh;
					needsRedraw = true;
					render();
					resetWatchdog();
				} catch {
				}
			}
		});
	};

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

	seed = seedClassifiedTagFile(tagPath);
	allInteractions = seed.interactions;
	lastReadOffset = seed.offset;
	prefixSentinel = readPrefixSentinel(tagPath, lastReadOffset);
	needsRedraw = true;
	render();

	startWatching();

	setTimeout(() => { updateDaemonHealth(); needsRedraw = true; render(); resetWatchdog(); }, 500);

	await new Promise(() => {});
}

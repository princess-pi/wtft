import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Interaction, Category } from "./wtft-parser.js";
import { getVisualLength, getTerminalWidth } from "./wtft-shared.js";
import {
	parseEntryToInteraction,
	deduplicateInteractions,
	classifyInteraction,
} from "./wtft-shared.js";
import { askedOf, chartLines } from "./chart-call.js";
import { isPlaceholderRow } from "./wtft-chart.js";
import { splitOverheadCost, isModelTagged } from "./wtft-parser.js";
import { getDiscoveries } from "./harness/registry.ts";
import { projectsDir } from "./harness/claude-code/discovery.js";
import { showCursor, hideCursor, enterRawStdin } from "./tty-helpers.js";
import { repaint, frameRows, eraseFrame, type RepaintFrame } from "./watch-repaint.js";
import { tagRecords, parseTagLine, currentGeneration, sweepState, isDataRecord, type TagRecord } from "./tag-log.js";
import { replaceLease, unlinkLeaseIf, leaseHolder, claimLeaseForChild, leasePid } from "./lease.js";
import { classifyPid, holdsLease, mayStop, processTable, stopHolder, stopHolderSync, verifiedKind, type StopOptions } from "./holder.js";
import {
	decideHealth, readHealthFacts, daemonReasonText, IDLE_THRESHOLD_MS,
	type DaemonStatus, type HealthOptions,
} from "./daemon-health.js";
export {
	IDLE_THRESHOLD_MS, getModelCacheTtlMs, DAEMON_REASON_TEXT, daemonReasonText,
	type DaemonHealthReason, type DaemonStatus, type HealthOptions,
} from "./daemon-health.js";
export interface WatchSettings {
	interval: string;
	limit: number;
	mode: "cumulative" | "bucket";
	timezone?: string;
	unit?: "cost" | "tokens";
	showCostColumns?: boolean;
	showTokenColumns?: boolean;
	daemonPath?: string; // path to wtft-daemon.mjs (CLI watch mode only)
	daemonChild?: ChildProcess | null;
	pad?: number;
	hasInterval?: boolean;
	hasLimit?: boolean;
	hasMode?: boolean;
	hasTimezone?: boolean;
	disabledEmoji?: boolean;
	defaultDisabledEmoji?: boolean;
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
	// A list field of the wrong shape makes the line no turn at all, so a hostile
	// or damaged line can never reach a merge or a render that iterates it.
	for (const key of ["f", "cmd", "tc"]) if (obj[key] !== undefined && !Array.isArray(obj[key])) return null;
	return {
		timestamp: obj.t,
		cost: obj.c,
		messageId: obj.id || undefined,
		model: obj.m || undefined,
		files: (obj.f || []).filter((f: any) => f && typeof f === "object").map((f: any) => ({ path: typeof f.p === "string" ? f.p : "", action: (f.a === "w" ? "write" : "read") as "read" | "write" })),
		commands: (obj.cmd || []).filter((c: unknown): c is string => typeof c === "string"),
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
	return "no clean read of the session and its subagents has finished since this tag was last written, so some cost may still be missing";
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

	const records = tagRecords(content);
	// Nothing but markers and heartbeats: no total was produced to doubt.
	if (!records.some(r => isDataRecord(r) || r.kind === "unknown")) return { provisional: false, reason: null };
	return sweepState(records) === "swept" ? { provisional: false, reason: null } : { provisional: true, reason: "unswept" };
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
	const records = currentGeneration(tagRecords(content));
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

function foldedIdsFromRecords(records: TagRecord[]): Set<string> {
	const ids = new Set<string>();
	for (const r of records) if (r.kind === "fold") ids.add(r.child);
	return ids;
}

function interactionsFromRecords(records: TagRecord[]): Interaction[] {
	const interactions: Interaction[] = [];
	for (const r of records) if (r.kind === "turn") interactions.push(r.interaction);
	return dedupeClassifiedById(interactions);
}

export function foldedSessionIdsFromContent(content: string): Set<string> {
	return foldedIdsFromRecords(currentGeneration(tagRecords(content)));
}

export function classifiedInteractionsFromContent(content: string): Interaction[] {
	return interactionsFromRecords(currentGeneration(tagRecords(content)));
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
		return read < buf.length || tagRecords(buf.subarray(0, read).toString("utf8")).some(r => r.kind === "generation");
	} finally {
		fs.closeSync(fd);
	}
}

/** The tag file a watch on `watchedPath` (inode `watchedIno`) should move to: the same path
 *  recreated, or the session's current tag file when the watched one is gone. `lost` (the
 *  watcher saw a rename or unlink) accepts a file at the same path even with the same inode,
 *  which a recreated file can reuse. Null when nothing should replace the watch yet. */
export function replacedTagFile(watchedPath: string, watchedIno: number, sessionPath: string, lost = false): { path: string; ino: number } | null {
	const candidate = fs.existsSync(watchedPath) ? watchedPath : getCurrentVersionTagPath(sessionPath);
	let ino: number;
	try { ino = fs.statSync(candidate).ino; } catch { return null; }
	return !lost && candidate === watchedPath && ino === watchedIno ? null : { path: candidate, ino };
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


export { WTFT_TAGGER_VERSION, taggerIsOlder } from "./wtft-tagger-version.js";
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

/**
 * `wtft -F`: rederive one session's tag from its transcript. A session a
 * harness daemon serves gets a `rebuild` lease, which that harness rebuilds as
 * soon as it sees it, so the harness and its other sessions keep running
 * ("rebuild"). Otherwise the lease and every version of the tag, beside the
 * transcript or in the sibling project a moved session's tag lives in, are
 * deleted, after stopping a live per-session daemon ("stopped") or with none
 * running ("deleted"); a daemon still running 2 s after the signal, or one
 * that claimed the session meanwhile, leaves everything in place ("busy"); a
 * lease that cannot be read ("unreadable"), a rebuild lease that cannot be
 * written ("unwritable"), a daemon that cannot be signalled ("unsignalled"),
 * and a lease or tag that cannot be deleted ("undeletable") are failures.
 * Unless busy or a failure, the caller then asks for the session.
 */
export type ForceRebuildFailure = "unreadable" | "unwritable" | "unsignalled" | "undeletable";

/** What a failed `-F` could not do, as a sentence fragment, or null. */
export function describeForceRebuildFailure(how: string): string | null {
	switch (how) {
		case "unreadable": return "its lease could not be read";
		case "unwritable": return "the rebuild lease could not be written";
		case "unsignalled": return "its log parser daemon could not be signalled";
		case "undeletable": return "a lease or tag file could not be deleted, so it would be resumed rather than rebuilt";
		default: return null;
	}
}

export function forceRebuildSession(sessionPath: string, stopOpts: StopOptions = {}): "rebuild" | "stopped" | "deleted" | "busy" | ForceRebuildFailure {
	const leasePath = getDaemonPidPath(sessionPath);
	let initial = "";
	try { initial = fs.readFileSync(leasePath, "utf8").trim(); }
	catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "unreadable"; }
	const kind = verifiedKind(leasePid(initial));
	if (kind === "harness" && processTable().inspectable()) {
		try {
			if (!replaceLease(leasePath, "rebuild", String(process.pid), initial)) return "busy";
		} catch {
			return "unwritable";
		}
		return "rebuild";
	}
	if (kind === "unverified") return "busy";
	// Its shutdown flushes into the tag, so the tag goes only once it has
	// exited; one still running after 2 s keeps its tag ("busy").
	const stopped = mayStop(kind);
	if (stopped) {
		const outcome = stopHolderSync(leasePid(initial), { ...stopOpts, killMs: 0 });
		if (outcome === "denied") return "unsignalled";
		if (outcome === "survived") return "busy";
	}
	// A daemon that claimed the session since owns lease and tag; leave both.
	let now = "";
	try { now = fs.readFileSync(leasePath, "utf8").trim(); }
	catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "unreadable"; }
	if (now !== "" && now !== initial) return "busy";
	// Anything left behind would be resumed, not rebuilt, so any error but
	// "already gone" fails the whole -F.
	const gone = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";
	if (now !== "" && !unlinkLeaseIf(leasePath, now)) {
		let after: string | null = null;
		try { after = fs.readFileSync(leasePath, "utf8").trim(); }
		catch (err) { if (!gone(err)) return "unreadable"; }
		if (after !== null) return after !== now ? "busy" : "undeletable";
	}
	const prefix = path.basename(sessionPath) + ".wtft-tag.v";
	const sibling = findSiblingTagPath(sessionPath);
	for (const tagsDir of new Set([path.join(path.dirname(sessionPath), "wtft-tags"), path.dirname(getTagPath(sessionPath)), ...(sibling ? [path.dirname(sibling)] : [])])) {
		let names: string[] = [];
		try { names = fs.readdirSync(tagsDir); } catch (err) { if (!gone(err)) return "undeletable"; }
		for (const f of names) {
			if (!f.startsWith(prefix) || !f.endsWith(".jsonl")) continue;
			try { fs.unlinkSync(path.join(tagsDir, f)); } catch (err) { if (!gone(err)) return "undeletable"; }
		}
	}
	return stopped ? "stopped" : "deleted";
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

/** Daemon self-exit: 24h of no new data. Polite to ps aux browsers. */
export const IDLE_EXIT_MS = 24 * 60 * 60 * 1000;

/** docs/spec-daemon-health.md: the one answer to "is this session's daemon alive". */
export function health(sessionPath: string, now: number, opts: HealthOptions = {}): DaemonStatus {
	const tagPath = opts.tagPath ?? getTagPath(sessionPath);
	return decideHealth(readHealthFacts(sessionPath, getDaemonPidPath(sessionPath), tagPath), now);
}

export function renderDaemonStatus(status: DaemonStatus): string {
	if (status.reason === "waiting-session") {
		return `  \x1b[33m●\x1b[0m ${daemonReasonText("waiting-session")}`;
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
	const pidPath = getDaemonPidPath(sessionPath);
	const own = child?.pid ? String(child.pid) : "";
	// The spawner claims the lease for its child at spawn, so a lease
	// naming the child proves only that it is alive. It is up once it has also
	// beaten into the tag since this wait began; any other live holder is up.
	const leaseUp = () => {
		const holder = leaseHolder(pidPath);
		const pid = leasePid(holder);
		if (!holdsLease(classifyPid(pid))) return false;
		if (!own || holder !== own) return true;
		const facts = readHealthFacts(sessionPath, pidPath, getCurrentVersionTagPath(sessionPath));
		return (facts.tag?.tail ?? []).some(r => r.kind === "heartbeat" && r.last >= start);
	};
	for (;;) {
		if (leaseUp()) {
			return { state: "up", exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null };
		}
		const exitCode = child ? child.exitCode : null;
		const signalCode = child ? child.signalCode : null;
		if (child && (exitCode !== null || signalCode !== null)) {
			// Exit observed — but was the lease claimed between our check and its exit?
			if (leaseUp()) return { state: "up", exitCode, signalCode };
			// The claim made for it at spawn is the spawner's to take back.
			if (own) unlinkLeaseIf(pidPath, own);
			return { state: "dead", exitCode, signalCode };
		}
		if (Date.now() - start >= ceilingMs) {
			return { state: "unknown", exitCode, signalCode };
		}
		await new Promise(r => setTimeout(r, pollMs));
	}
}

export async function restartDaemon(sessionPath: string, daemonPath: string): Promise<boolean> {
	const pidPath = getDaemonPidPath(sessionPath);
	try {
		const pid = leasePid(leaseHolder(pidPath));
		const kind = verifiedKind(pid);
		if (kind === "unverified") return false;
		// With no /proc a reused pid cannot be told apart before SIGKILL.
		if (mayStop(kind) && (await stopHolder(pid, processTable().inspectable() ? {} : { killMs: 0 })) !== "stopped") return false;
		if (kind === "other") unlinkLeaseIf(pidPath, String(pid));
	} catch {}

	let childPid = 0;
	try { childPid = processTable().spawn(process.execPath, [daemonPath, ...daemonLaunchArgs(sessionPath)], process.env); } catch {}
	if (childPid === 0) return false;
	try { claimLeaseForChild(pidPath, childPid); } catch { /* the child claims for itself */ }
	return true;
}

/** What `--watch` shows before the current tag has any turns. When a tag for
 *  another tagger version is on disk, the reader is told that this version's
 *  is still to be built, rather than left looking at an empty screen. */
export function waitingForDataLine(sessionPath: string): string {
	if (!fs.existsSync(sessionPath)) return "Waiting for session .jsonl to be written (first prompt not completed yet)...";
	// Once this version's tag exists it is built; an older one beside it is
	// only left over, and says nothing about what the reader waits on.
	if (fs.existsSync(getCurrentVersionTagPath(sessionPath))) return "Waiting for session data...";
	const prefix = path.basename(sessionPath) + ".wtft-tag.v";
	let stale: string | undefined;
	try {
		for (const f of fs.readdirSync(path.join(path.dirname(sessionPath), "wtft-tags"))) {
			if (!f.startsWith(prefix) || !f.endsWith(".jsonl")) continue;
			const version = f.slice(prefix.length, -".jsonl".length);
			if (version !== WTFT_TAGGER_VERSION) stale = version;
		}
	} catch { /* no tags dir yet */ }
	if (stale) return `The tag on disk was written by tagger v${stale}; waiting for the log parser daemon to build this session's v${WTFT_TAGGER_VERSION} tag...`;
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
	let lastFrame: RepaintFrame | null = null;
	let lastBuffer: string[] = [];

	const exitWatch = () => {
		if (watcher) watcher.close();
		if (rearmTimer) clearInterval(rearmTimer);
		if (daemonWatchdog) clearTimeout(daemonWatchdog);
		process.stdout.write(eraseFrame(lastFrame));
		showCursor();
		cleanupStdin();
		if (lastBuffer.length > 0) {
			for (const l of lastBuffer) console.log(l);
		}
		console.log(`WTFT watch stopped \u2014 ${interactionCount} interactions, $${totalCost.toFixed(4)} total cost.`);
		// A restart already stopped the old daemon; exiting now would leave none.
		if (pendingRestart) void pendingRestart.finally(() => process.exit(0));
		else process.exit(0);
	};

	process.on("SIGINT", exitWatch);

	let daemonDead = false;
	let daemonStatus: DaemonStatus | null = null;

	const updateDaemonHealth = () => {
		daemonStatus = health(sessionPath, Date.now(), { tagPath });
		daemonDead = !daemonStatus.alive;
	};

	let pendingRestart: Promise<boolean> | null = null;
	const cleanupStdin = enterRawStdin((key: string) => {
		if (key === "q" || key === "Q" || key === "\u0003") {
			exitWatch();
		}
		if ((key === "r" || key === "R") && settings.daemonPath && !pendingRestart) {
			pendingRestart = restartDaemon(sessionPath, settings.daemonPath);
			void pendingRestart.then(ok => {
				pendingRestart = null;
				if (ok) {
					updateDaemonHealth();
				} else {
					daemonStatus = { alive: false, reason: "restart-failed" };
					daemonDead = true;
				}
				needsRedraw = true;
				render();
				resetWatchdog();
			});
		}
	});

	let sessionDisabledEmoji: boolean | undefined;
	let seed = seedClassifiedTagFile(tagPath);
	let allInteractions: Interaction[] = seed.interactions;
	let lastReadOffset = seed.offset;
	let prefixSentinel = readPrefixSentinel(tagPath, lastReadOffset);

	let sessionInterval: string | undefined;
	let sessionLimit: number | undefined;
	let sessionMode: "cumulative" | "bucket" | undefined;
	let sessionTimezone: string | undefined;

	try {
		const sessionContent = fs.readFileSync(sessionPath, "utf8");
		for (const line of sessionContent.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type === "custom" && entry.customType === "emoji-settings") {
					if (entry.data && typeof entry.data.disabled === "boolean") {
						sessionDisabledEmoji = entry.data.disabled;
					}
				} else if (entry.type === "custom" && entry.customType === "wtft-settings") {
					if (entry.data) {
						if (typeof entry.data.interval === "string") sessionInterval = entry.data.interval;
						if (typeof entry.data.limit === "number") sessionLimit = entry.data.limit;
						if (entry.data.mode === "cumulative" || entry.data.mode === "bucket") sessionMode = entry.data.mode;
						if (typeof entry.data.timezone === "string") sessionTimezone = entry.data.timezone;
					}
				}
			} catch {
			}
		}
	} catch {
	}

	const render = () => {
		const width = getTerminalWidth();
		const pad = settings.pad || 0;
		const maxPad = Math.max(0, Math.floor(width / 2) - 1);
		const actualPad = Math.min(pad, maxPad);
		const padStr = " ".repeat(actualPad);
		const paddedWidth = width - 2 * actualPad;
		const finalWidth = Math.min(paddedWidth, 1023);

		const deduped = dedupeClassifiedById(allInteractions);
		interactionCount = deduped.length;

		const lines = chartLines({
			interactions: deduped,
			asked: askedOf(settings),
			fallback: {
				width: finalWidth,
				interval: sessionInterval ?? settings.interval,
				limit: sessionLimit ?? settings.limit,
				mode: sessionMode ?? settings.mode,
				timezone: sessionTimezone ?? settings.timezone,
				disabledEmoji: sessionDisabledEmoji ?? settings.defaultDisabledEmoji,
			},
			unit: settings.unit ?? "cost",
			padRows: true,
			// No more placeholders than the terminal has rows; the fit below trims the rest.
			padRowsCap: process.stdout.rows || undefined,
		});

		const buf: string[] = [];
		buf.push(`\x1b[90m${sessionPath}\x1b[0m`);
		totalCost = deduped.reduce((sum, i) => sum + i.cost, 0);

		if (lines && lines.length > 0) {
			const daemonStatusStr = daemonStatus
				? renderDaemonStatus(daemonStatus)
				: "  \x1b[90m●\x1b[0m reading...";

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
			buf.push(`\x1b[90m${waitingForDataLine(sessionPath)}\x1b[0m`);
		}

		const restartHint = settings.daemonPath
			? `, using v${WTFT_TAGGER_VERSION}, ` + (daemonDead ? `\x1b[31m'r' to restart\x1b[0m` : `'r' to restart`)
			: "";
		buf.push(`'q' to exit${restartHint}`);

		const cols = width;
		const rows = process.stdout.rows || Infinity;
		const screenLines = () => frameRows(buf.map(l => padStr + l), cols) + 1;
		for (let i = buf.length - 1; i >= 0 && screenLines() > rows; i--) {
			if (isPlaceholderRow(buf[i]!)) buf.splice(i, 1);
		}

		lastBuffer = [...buf];

		const allLines = buf.map(l => padStr + l);
		const painted = repaint(lastFrame, allLines, cols, rows);
		process.stdout.write(painted.out);
		lastFrame = painted.frame;
		needsRedraw = false;
	};

	render();
	resetWatchdog();

	process.on("SIGWINCH", () => {
		render();
		resetWatchdog();
	});

	let watcher: fs.FSWatcher | null = null;
	let watchedIno = 0;
	let watchLost = false;
	let rearmTimer: ReturnType<typeof setInterval> | null = null;

	const startWatching = (ino: number) => {
		watchedIno = ino;
		watchLost = false;
		watcher = fs.watch(tagPath, (eventType) => {
			if (eventType === "rename") { watchLost = true; return; }
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
							const record = parseTagLine(line);
							if (record?.kind !== "turn") continue;
							allInteractions.push(record.interaction);
							newCount++;
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
		process.stdout.write(eraseFrame(lastFrame));
		showCursor();
		cleanupStdin();
	};
	const fileWaitStart = Date.now();
	for (;;) {
		if (fs.existsSync(tagPath)) break;
		const resolved = getCurrentVersionTagPath(sessionPath);
		if (resolved !== tagPath && fs.existsSync(resolved)) { tagPath = resolved; break; }
		const childExited = child ? (child.exitCode !== null || child.signalCode !== null) : false;
		const leaseAlive = health(sessionPath, Date.now(), { tagPath }).alive;
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

	let seededIno = 0;
	try { seededIno = fs.statSync(tagPath).ino; } catch {}
	seed = seedClassifiedTagFile(tagPath);
	allInteractions = seed.interactions;
	lastReadOffset = seed.offset;
	prefixSentinel = readPrefixSentinel(tagPath, lastReadOffset);
	needsRedraw = true;
	render();

	try {
		startWatching(seededIno);
	} catch {
		watchLost = true;
	}
	if (seededIno === 0) watchLost = true;
	rearmTimer = setInterval(() => {
		const next = replacedTagFile(tagPath, watchedIno, sessionPath, watchLost);
		if (!next) return;
		const fresh = seedClassifiedTagFile(next.path);
		if (!fresh.read) return;
		if (watcher) watcher.close();
		watcher = null;
		tagPath = next.path;
		seed = fresh;
		allInteractions = fresh.interactions;
		lastReadOffset = fresh.offset;
		prefixSentinel = readPrefixSentinel(tagPath, lastReadOffset);
		try {
			startWatching(next.ino);
		} catch {
			watchLost = true;
		}
		updateDaemonHealth();
		needsRedraw = true;
		render();
		resetWatchdog();
	}, HEALTHY_BEAT_MS);

	setTimeout(() => { updateDaemonHealth(); needsRedraw = true; render(); resetWatchdog(); }, 500);

	await new Promise(() => {});
}

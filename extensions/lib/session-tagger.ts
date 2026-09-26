/**
 * One session's tagging as a state value and a port. Every read of the
 * filesystem or the clock goes through `World`; every tag line comes back as
 * `records` for the caller to append. Design: docs/spec-270-session-tagger.md.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { createHash, type Hash } from "node:crypto";
import {
	parseEntryToInteraction,
	deduplicateInteractions,
	attributeClaudeSubAgentCosts,
	serializeClassified,
	serializeClassifiedWithOverheadSplit,
	foldRecordLine,
	foldRecordIds,
	generationRecordLine,
	transcriptSourceId,
	fileStamp,
	claudeSpawnWindowClosesAt,
	CLAUDE_SUBAGENT_WINDOW_MS,
	applyControlEntry,
	newParseStreamState,
	resolveLastCwd,
	commandSpawnsAgent,
	discoverClaudeSubAgentFilesForTurn,
	canonicalTranscriptPath,
	discoverSubagentSessionFiles,
	clearSubagentCacheMiss,
	type ParseStreamState,
} from "./wtft-shared.js";
import { tagRecords, isDataRecord } from "./tag-log.js";
import { projectsDir } from "./harness/claude-code/discovery.js";

export type Turn = NonNullable<ReturnType<typeof parseEntryToInteraction>>;
export type PendingItem = { interaction: Turn; prevCtx: number };
export type LogLine = { level: "warn" | "debug"; text: string };

/** Quiet longer than the coarsest mtime tick before a no-change skip is safe. */
export const MTIME_SETTLE_MS = 2000;

interface FoldOwner {
	base: Turn;
	lastLine: string;
	lastCost: number;
}

export interface SubagentFileState {
	lastSize: number;
	mtimeMs: number;
	/** Stamped when new bytes were read. A same-size rewrite can hide inside MTIME_SETTLE_MS. */
	readAtMs: number;
	ino: number;
	contentHash: Hash;
	fragment: Buffer<ArrayBufferLike>;
	stream: ParseStreamState;
	/** The next write opens a generation: a `_gen` record, then every current line. */
	newGeneration: boolean;
	/** Fold ids this generation has recorded. The CLI's spawn walk skips exactly
	 *  the recorded ids, so a fold with no record is billed twice. */
	recordedFolds: Set<string>;
	/** Each nested transcript the last attribution folded, with the stamp it was read at. */
	foldStamps: Map<string, string>;
	/** Until then a spawning turn can still gain a `claude -p` child. */
	spawnWindowClosesAt: number;
	owners: FoldOwner[];
	/** Last ordinary turn not yet written, so a following interrupt can still mark it. */
	pendingTurn: Turn | null;
	/** The source its lines were written under; a session move changes what
	 *  transcriptSourceId would compute for the old path. */
	source: string;
	/** The last turn read, of any kind, and whether a Claude command made it an
	 *  owner: the turn an interrupt at the head of the next read follows. */
	lastTurn: { turn: Turn; owner: boolean } | null;
	/** Which children another holder owned at the last parse — when that set
	 *  changes this transcript's own total does too, so the gate must fire. */
	foldedByAnother: string;
}

export interface TaggerState {
	sessionPath: string;
	/** Fixed for the session's life: a move re-points `sessionPath` only. */
	tagPath: string;
	lastSize: number;
	/** Trailing partial line as bytes; a same-bytes fragment that parses as JSON settles (writer died without newline). */
	pendingFragment: Buffer<ArrayBufferLike>;
	pendingItems: PendingItem[];
	streamState: ParseStreamState;
	stampInterruptOnPending: boolean;
	prevCtxTokens: number;
	sessionIno: number;
	pendingClaudeCommands: PendingItem[];
	discoveredClaudeFiles: Set<string>;
	discoveredSubagentFiles: Map<string, SubagentFileState>;
	/** Each child's source, kept after its state is dropped, so a child that comes back is read under the source its earlier lines carry. */
	knownSources: Map<string, string>;
	/** Starts true: an inherited tag's swept marker is untrusted until this life re-stamps after its own sweep. */
	tagGrewSinceMarker: boolean;
	/** A sweep could not read what it meant to; withholds the swept stamp. */
	pollHadFailure: boolean;
	/** The last read of the session's own transcript failed; only a read clears it. */
	sessionReadFailed: boolean;
	/** After an unswept retraction, stamp on the next clean poll even if the tag did not grow. */
	sweptRetracted: boolean;
	/** Transcripts a cut scan already read in its current pass, so the next slice resumes after them. */
	scanPass: Set<string> | null;
	/** A failure in an earlier slice of this pass still counts when the pass ends. */
	scanPassFailed: boolean;
	/** The resume's reseed could not finish: tried again each scan, and the tag is not stamped swept until it does. */
	reseedPending: boolean;
	warned: { stat: Set<string>; parse: Set<string>; serialize: Set<string>; session: Set<string> };
}

/** The port: every read of the filesystem and the clock. The daemon passes
 *  `fsWorld()`; a test passes the same over a sandbox with its own clock. */
export interface World {
	now(): number;
	stat(file: string): { size: number; mtimeMs: number; ino: number };
	readRange(file: string, start: number, length: number): Buffer;
	hashPrefix(file: string, length: number): string;
	hashBytes(file: string): string;
	exists(file: string): boolean;
	/** One spelling for one file: symlinks resolved. */
	canonical(file: string): string;
	discoverTask(sessionPath: string): { files: string[]; unreadable: Error | null };
	discoverClaude(commands: string[], parentTimestamp: number, ownCwd: string | null): { files: string[]; unreadable: Error | null; searched: number };
	attribute(turns: Turn[], ownCwd: string | null, doNotFold: ReadonlySet<string>): void;
	lastCwd(file: string): string | null;
	stamp(file: string): string;
	spawnWindowClosesAt(turns: Turn[], ownCwd: string | null): number;
	readTag(tagPath: string): string;
	projectDirs(): string[];
	projectsRoot(): string;
}

export function fsWorld(now: () => number = Date.now): World {
	return {
		now,
		stat(file) { const st = fs.statSync(file); return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino }; },
		readRange(file, start, length) {
			const fd = fs.openSync(file, "r");
			const buf = Buffer.alloc(length);
			try { fs.readSync(fd, buf, 0, length, start); } finally { fs.closeSync(fd); }
			return buf;
		},
		hashPrefix(file, length) {
			const hash = createHash("sha1");
			const fd = fs.openSync(file, "r");
			try {
				const buf = Buffer.alloc(64 * 1024);
				let pos = 0;
				while (pos < length) {
					const n = fs.readSync(fd, buf, 0, Math.min(buf.length, length - pos), pos);
					if (n <= 0) break;
					hash.update(buf.subarray(0, n));
					pos += n;
				}
			} finally { fs.closeSync(fd); }
			return hash.digest("hex");
		},
		hashBytes(file) {
			const hash = createHash("sha1");
			const fd = fs.openSync(file, "r");
			try {
				const buf = Buffer.alloc(64 * 1024);
				let pos = 0;
				for (;;) {
					const n = fs.readSync(fd, buf, 0, buf.length, pos);
					if (n <= 0) break;
					hash.update(buf.subarray(0, n));
					pos += n;
				}
			} finally { fs.closeSync(fd); }
			return hash.digest("hex");
		},
		exists: (file) => fs.existsSync(file),
		canonical: (file) => canonicalTranscriptPath(file),
		discoverTask: (sessionPath) => discoverSubagentSessionFiles(sessionPath, { quietSession: true }),
		discoverClaude: (commands, ts, cwd) => discoverClaudeSubAgentFilesForTurn(commands, ts, cwd),
		attribute: (turns, cwd, doNotFold) => attributeClaudeSubAgentCosts(turns, cwd, doNotFold),
		lastCwd: (file) => resolveLastCwd(file),
		stamp: (file) => fileStamp(file),
		spawnWindowClosesAt: (turns, cwd) => claudeSpawnWindowClosesAt(turns, cwd),
		readTag: (tagPath) => fs.readFileSync(tagPath, "utf8"),
		projectDirs: () => fs.readdirSync(projectsDir()),
		projectsRoot: () => projectsDir(),
	};
}

export function newTaggerState(sessionPath: string, tagPath: string): TaggerState {
	return {
		sessionPath,
		tagPath,
		lastSize: 0,
		pendingFragment: Buffer.alloc(0),
		pendingItems: [],
		streamState: newParseStreamState(),
		stampInterruptOnPending: false,
		prevCtxTokens: 0,
		sessionIno: -1,
		pendingClaudeCommands: [],
		discoveredClaudeFiles: new Set(),
		discoveredSubagentFiles: new Map(),
		knownSources: new Map(),
		tagGrewSinceMarker: true,
		pollHadFailure: false,
		sessionReadFailed: false,
		sweptRetracted: false,
		scanPass: null,
		scanPassFailed: false,
		reseedPending: false,
		warned: { stat: new Set(), parse: new Set(), serialize: new Set(), session: new Set() },
	};
}

// ---

/** One call's accumulator: the lines to append, in order, and what to print. */
interface Out {
	records: string;
	log: LogLine[];
}

function debug(out: Out, text: string) { out.log.push({ level: "debug", text: `[wtft-log-parser] ${text}` }); }
function warn(out: Out, text: string) { out.log.push({ level: "warn", text: `[wtft-log-parser] WARNING: ${text}` }); }
function errText(err: unknown): string { return err instanceof Error ? err.message : String(err); }

function hasClaudeCommand(interaction: Turn): boolean {
	return interaction.commands.some(commandSpawnsAgent);
}

function spawnKey(interaction: { messageId?: string; timestamp: number }): string {
	return interaction.messageId ?? String(interaction.timestamp);
}

function foldSetSignature(files: ReadonlySet<string>): string {
	return [...files].sort().join("\u0000");
}

function freshSubagentState(source = ""): SubagentFileState {
	return {
		lastSize: 0,
		mtimeMs: -1,
		readAtMs: 0,
		ino: -1,
		contentHash: createHash("sha1"),
		fragment: Buffer.alloc(0),
		stream: newParseStreamState(),
		newGeneration: true,
		recordedFolds: new Set<string>(),
		foldStamps: new Map<string, string>(),
		spawnWindowClosesAt: 0,
		owners: [],
		pendingTurn: null,
		source,
		lastTurn: null,
		foldedByAnother: "",
	};
}

// ---
// The session transcript
// ---

/** Retract a swept marker stamped before this failure so the tag reads provisional. */
function invalidateStaleSweptMarker(state: TaggerState, world: World, out: Out, now: number) {
	try {
		const records = tagRecords(world.readTag(state.tagPath));
		// The same backward scan as sweepState: markers and heartbeats are passed
		// over, a swept marker is retracted, a data record ends the search.
		for (let i = records.length - 1; i >= 0; i--) {
			const r = records[i];
			if (r.kind === "unswept") return;
			if (r.kind === "swept") {
				out.records += JSON.stringify({ _meta: { unswept: now } }) + "\n";
				state.sweptRetracted = true;
				return;
			}
			if (isDataRecord(r) || r.kind === "unknown") return;
		}
	} catch {
	}
}

function parseNewLines(state: TaggerState, world: World, out: Out, now: number): Turn[] {
	const filePath = state.sessionPath;
	try {
		const stat = world.stat(filePath);
		debug(out, `session stat ${path.basename(filePath)}`);
		const currentSize = stat.size;
		if (state.sessionIno !== -1 && stat.ino !== state.sessionIno) {
			state.lastSize = 0;
			state.pendingFragment = Buffer.alloc(0);
			state.streamState = newParseStreamState();
			state.prevCtxTokens = 0;
			debug(out, `session inode changed, resetting offset ${path.basename(filePath)}`);
		}
		state.sessionIno = stat.ino;
		if (currentSize < state.lastSize) {
			debug(out, "session truncated, resetting offset");
			state.lastSize = 0;
			state.pendingFragment = Buffer.alloc(0);
			state.streamState = newParseStreamState();
			state.prevCtxTokens = 0;
		}
		const grew = currentSize > state.lastSize;
		// With a held fragment, still run: a quiet poll is when a dead-writer fragment can settle.
		if (!grew && state.pendingFragment.length === 0) return [];

		let fresh: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		if (grew) {
			fresh = world.readRange(filePath, state.lastSize, currentSize - state.lastSize);
			debug(out, `session delta ${fresh.length} bytes ${path.basename(filePath)}`);
			state.lastSize = currentSize;
		}
		const buf = state.pendingFragment.length > 0 ? Buffer.concat([state.pendingFragment, fresh]) : fresh;
		const lastNl = buf.lastIndexOf(0x0a);
		const fragment = buf.subarray(lastNl + 1);

		let settledFragment = false;
		if (fragment.length > 0 && fragment.equals(state.pendingFragment)) {
			try { JSON.parse(fragment.toString("utf8")); settledFragment = true; } catch { /* still mid-record */ }
		}

		if (lastNl === -1 && !settledFragment) {
			state.pendingFragment = Buffer.from(buf);
			return [];
		}
		const consumeTo = settledFragment ? buf.length : lastNl + 1;
		state.pendingFragment = consumeTo >= buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(consumeTo));
		const newContent = buf.subarray(0, consumeTo).toString("utf8");
		const interactions: Turn[] = [];
		for (const line of newContent.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				const isControl = applyControlEntry(entry, state.streamState, () => {
					if (interactions.length > 0) interactions[interactions.length - 1].interrupted = true;
					else state.stampInterruptOnPending = true;
				});
				if (isControl) continue;
				const interaction = parseEntryToInteraction(entry, state.streamState.thinkingLevel, state.streamState.compactionTokensBefore, state.streamState.afterCompaction, state.streamState.model);
				if (interaction) {
					interactions.push(interaction);
					state.streamState.compactionTokensBefore = undefined;
					state.streamState.afterCompaction = false;
				}
			} catch {
			}
		}
		return interactions;
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
		if (!state.warned.session.has(filePath)) {
			state.warned.session.add(filePath);
			warn(out, `the session transcript could not be read at discovery, so its cost may be missing from this session's total (${filePath}): ${errText(err)}`);
		}
		state.pollHadFailure = true;
		invalidateStaleSweptMarker(state, world, out, now);
		return [];
	}
}

/** A `claude -p` lookup still open when a daemon stops is resumed from these
 *  markers: `spawnPending` when the turn is queued, `spawnSettled` when its
 *  lookup ends. */
function queueClaudeCommand(state: TaggerState, out: Out, interaction: Turn, prevCtx: number) {
	const key = spawnKey(interaction);
	// Claude Code writes one message as several lines sharing its id, and a
	// later line can carry another spawning command: merge, never drop.
	let item = state.pendingClaudeCommands.find(pending => spawnKey(pending.interaction) === key);
	if (item) {
		const merged = [...new Set([...item.interaction.commands, ...interaction.commands])];
		if (merged.length === item.interaction.commands.length) return;
		item.interaction = { ...item.interaction, commands: merged };
	} else {
		item = { interaction, prevCtx };
		state.pendingClaudeCommands.push(item);
	}
	out.records += JSON.stringify({ _meta: { spawnPending: {
		key, at: item.interaction.timestamp, commands: item.interaction.commands,
	} } }) + "\n";
}

/** Read what the session transcript gained: new turns are queued as pending,
 *  a spawning turn opens a lookup. Clears and re-derives `pollHadFailure`. */
export function readSession(state: TaggerState, world: World): { records: string; log: LogLine[]; activity: boolean } {
	const out: Out = { records: "", log: [] };
	const now = world.now();
	state.pollHadFailure = false;
	const rawInteractions = parseNewLines(state, world, out, now);
	state.sessionReadFailed = state.pollHadFailure;
	if (state.stampInterruptOnPending) {
		if (state.pendingItems.length > 0) state.pendingItems[state.pendingItems.length - 1].interaction.interrupted = true;
		state.stampInterruptOnPending = false;
	}
	const newInteractions = deduplicateInteractions(rawInteractions);
	for (const interaction of newInteractions) {
		state.pendingItems.push({ interaction, prevCtx: state.prevCtxTokens });
		if (!interaction.isSidechain) {
			state.prevCtxTokens = interaction.inputTokens + interaction.cacheReadTokens + interaction.cacheWriteTokens;
		}
		if (hasClaudeCommand(interaction)) queueClaudeCommand(state, out, interaction, state.prevCtxTokens);
	}
	return { records: out.records, log: out.log, activity: newInteractions.length > 0 };
}

/** The pending turns as tag lines, then the offset marker. Empty when nothing is pending. */
export function flushTurns(state: TaggerState): string {
	if (state.pendingItems.length === 0) return "";
	const batch = state.pendingItems.map(it => serializeClassifiedWithOverheadSplit(it.interaction, it.prevCtx)).join("");
	state.tagGrewSinceMarker = true;
	state.pendingItems = [];
	return batch + JSON.stringify({ _meta: { offset: state.lastSize }}) + "\n";
}

// ---
// Child transcripts
// ---

function parseAppendedBytes(
	fileState: SubagentFileState,
	fresh: Buffer,
): { interactions: Turn[]; fragment: Buffer<ArrayBufferLike>; stream: ParseStreamState; stampInterrupt: boolean } {
	const stream = { ...fileState.stream };
	const buf = fileState.fragment.length > 0 ? Buffer.concat([fileState.fragment, fresh]) : fresh;
	const lastNl = buf.lastIndexOf(0x0a);
	const tail = buf.subarray(lastNl + 1);
	let settledFragment = false;
	if (tail.length > 0 && tail.equals(fileState.fragment) && fresh.length === 0) {
		try { JSON.parse(tail.toString("utf8")); settledFragment = true; } catch { /* still mid-record */ }
	}
	if (lastNl === -1 && !settledFragment) {
		return { interactions: [], fragment: Buffer.from(buf), stream, stampInterrupt: false };
	}
	const consumeTo = settledFragment ? buf.length : lastNl + 1;
	const fragment = consumeTo >= buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(consumeTo));
	const newContent = buf.subarray(0, consumeTo).toString("utf8");
	const interactions: Turn[] = [];
	let stampInterrupt = false;
	for (const line of newContent.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			const isControl = applyControlEntry(entry, stream, () => {
				if (interactions.length > 0) interactions[interactions.length - 1].interrupted = true;
				else stampInterrupt = true;
			});
			if (isControl) continue;
			const interaction = parseEntryToInteraction(entry, stream.thinkingLevel, stream.compactionTokensBefore, stream.afterCompaction, stream.model);
			if (interaction) {
				interactions.push(interaction);
				stream.compactionTokensBefore = undefined;
				stream.afterCompaction = false;
			}
		} catch { /* one bad line is not a file failure */ }
	}
	return { interactions, fragment, stream, stampInterrupt };
}

/**
 * Whether another synced transcript already folds this one — in which case
 * syncing it too would write its turns a second time, under its own source.
 * One synced BEFORE the parse that showed who folds it has those lines on disk
 * already, so its source opens a new generation, which retires every one.
 * Returns whether to skip, and whether the skip wrote a record.
 */
function skipAsFoldedElsewhere(state: TaggerState, world: World, out: Out, rawFile: string, foldedElsewhere: Set<string>): { skip: boolean; retired: boolean } {
	const file = world.canonical(rawFile);
	if (!foldedElsewhere.has(file)) return { skip: false, retired: false };
	let retired = false;
	if (state.discoveredSubagentFiles.has(file)) {
		out.records += generationRecordLine(sourceOf(state, file), path.basename(file, ".jsonl"));
		state.discoveredSubagentFiles.delete(file);
		state.tagGrewSinceMarker = true;
		retired = true;
	}
	return { skip: true, retired };
}

/** The source a child's lines carry: decided at its first read and kept for
 *  the life of its state, across a move of the session and its own rotations,
 *  so a later generation retires the earlier lines (#263). */
function sourceOf(state: TaggerState, file: string): string {
	return state.discoveredSubagentFiles.get(file)?.source || state.knownSources.get(file) || transcriptSourceId(file, path.dirname(state.sessionPath));
}

/** The sources a `_gen` record for `file` may carry: relative to the session's
 *  directory, or to its own when the session was there at the first read. */
function sourceCandidates(state: TaggerState, file: string): Set<string> {
	return new Set([transcriptSourceId(file, path.dirname(state.sessionPath)), transcriptSourceId(file, path.dirname(file))]);
}

/** A nested transcript that grew, or no longer stats, since the parse that folded it. */
function foldedTranscriptChanged(world: World, foldStamps: Map<string, string>): boolean {
	for (const [file, stamp] of foldStamps) {
		try {
			if (world.stamp(file) !== stamp) return true;
		} catch {
			return true;
		}
	}
	return false;
}

function warnParse(state: TaggerState, out: Out, stateKey: string, sessionId: string, err: unknown) {
	state.pollHadFailure = true;
	if (state.warned.parse.has(stateKey)) return;
	state.warned.parse.add(stateKey);
	warn(out, `a subagent transcript, or a nested one it folds, could not be read or parsed, so its cost may be missing from this session's total until it succeeds (${sessionId}): ${errText(err)}`);
}

function syncSubagentTranscript(state: TaggerState, world: World, out: Out, now: number, rawFile: string, foldedByAnother: ReadonlySet<string>): boolean {
	let wroteAny = false;
	// One transcript, one state entry and one source, however the path that
	// reached us was spelled — discovery joins paths, a fold records the path it
	// parsed, and a symlink makes those two spellings of one file.
	const file = world.canonical(rawFile);
	const stateKey = file;
	const sessionId = path.basename(file, ".jsonl");
	let fileState = state.discoveredSubagentFiles.get(stateKey);
	if (!fileState) {
		fileState = freshSubagentState(state.knownSources.get(stateKey) ?? "");
		state.discoveredSubagentFiles.set(stateKey, fileState);
	}

	for (let attempt = 0; attempt < 2; attempt++) {
		let size: number;
		let mtimeMs: number;
		let ino: number;
		try {
			const stat = world.stat(file);
			size = stat.size;
			mtimeMs = stat.mtimeMs;
			ino = stat.ino;
		} catch (err) {
			state.pollHadFailure = true;
			if (!state.warned.stat.has(stateKey)) {
				state.warned.stat.add(stateKey);
				warn(out, `a subagent transcript could not be stat'd, so its cost may be missing from this session's total (${sessionId}): ${errText(err)}`);
			}
			debug(out, `subagent stat failed, will retry next poll (${sessionId}): ${errText(err)}`);
			return wroteAny;
		}
		const settled = now - fileState.readAtMs > MTIME_SETTLE_MS;
		let rotate = fileState.mtimeMs !== -1 && (ino !== fileState.ino || size < fileState.lastSize);
		if (!rotate && fileState.mtimeMs !== -1 && size === fileState.lastSize && (mtimeMs !== fileState.mtimeMs || !settled)) {
			try {
				if (world.hashBytes(file) !== fileState.contentHash.copy().digest("hex")) rotate = true;
				else {
					fileState.mtimeMs = mtimeMs;
					fileState.ino = ino;
				}
			} catch (err) {
				warnParse(state, out, stateKey, sessionId, err);
				return wroteAny;
			}
		}
		if (!rotate && fileState.lastSize > 0 && size > fileState.lastSize) {
			try {
				if (world.hashPrefix(file, fileState.lastSize) !== fileState.contentHash.copy().digest("hex")) rotate = true;
			} catch (err) {
				warnParse(state, out, stateKey, sessionId, err);
				return wroteAny;
			}
		}
		if (rotate) {
			debug(out, `subagent transcript rotated, opening a new generation: ${path.basename(file)}`);
			fileState = freshSubagentState(fileState.source);
			state.discoveredSubagentFiles.set(stateKey, fileState);
		}

		const grew = size > fileState.lastSize;
		let fresh: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let parsed: ReturnType<typeof parseAppendedBytes> | null = null;
		if (grew || fileState.fragment.length > 0) {
			try {
				if (grew) {
					fresh = world.readRange(file, fileState.lastSize, size - fileState.lastSize);
					debug(out, `subagent delta ${fresh.length} bytes ${path.basename(file)}`);
				}
				parsed = parseAppendedBytes(fileState, fresh);
			} catch (err) {
				warnParse(state, out, stateKey, sessionId, err);
				debug(out, `subagent read or parse error (${sessionId}), will retry next poll: ${errText(err)}`);
				return wroteAny;
			}
		}

		const deduped = parsed ? clearSubagentCacheMiss(deduplicateInteractions(parsed.interactions)) : [];
		const plain: typeof deduped = [];
		const current = fileState;
		const absorbIntoOwner = (interaction: (typeof deduped)[number]): boolean => {
			if (!interaction.messageId) return false;
			const prior = current.owners.find(owner => owner.base.messageId === interaction.messageId);
			if (!prior) return false;
			// A full parse ORs `interrupted` across the copies of one id.
			if (interaction.interrupted && !prior.base.interrupted) {
				prior.base.interrupted = true;
				prior.lastLine = "";
			}
			if (interaction.cost + 1e-9 >= prior.base.cost) {
				prior.base.timestamp = interaction.timestamp;
				prior.base.cost = interaction.cost;
				prior.base.model = interaction.model ?? prior.base.model;
				prior.base.inputTokens = interaction.inputTokens;
				prior.base.outputTokens = interaction.outputTokens;
				prior.base.cacheReadTokens = interaction.cacheReadTokens;
				prior.base.cacheWriteTokens = interaction.cacheWriteTokens;
				prior.base.reasoningTokens = interaction.reasoningTokens;
				prior.base.serverToolCost = interaction.serverToolCost;
				prior.lastLine = "";
				prior.lastCost = 0;
			}
			return true;
		};
		// An interrupt marks the turn it follows and never a later one. A turn
		// already in the tag gets a second copy with the mark, which a reader ORs
		// across copies of one id; one with no id cannot be matched, so the
		// transcript is written again as a new generation.
		const reinterrupted: typeof deduped = [];
		if (parsed?.stampInterrupt) {
			const last = fileState.lastTurn;
			const ownerOfLast = last?.owner && last.turn.messageId
				? fileState.owners.find(o => o.base.messageId === last.turn.messageId)
				: undefined;
			if (last && !last.owner && fileState.pendingTurn
				&& (!last.turn.messageId || fileState.pendingTurn.messageId === last.turn.messageId)) {
				fileState.pendingTurn.interrupted = true;
			} else if (ownerOfLast) {
				ownerOfLast.base.interrupted = true;
				ownerOfLast.lastLine = "";
			} else if (last && !last.owner && last.turn.messageId) {
				reinterrupted.push(...clearSubagentCacheMiss([{ ...last.turn, interrupted: true }]));
			} else if (last && attempt === 0) {
				fileState = freshSubagentState(fileState.source);
				state.discoveredSubagentFiles.set(stateKey, fileState);
				continue;
			}
			parsed = { ...parsed, stampInterrupt: false };
		}
		if (fileState.pendingTurn && !absorbIntoOwner(fileState.pendingTurn)) plain.push(fileState.pendingTurn);
		const newOwners: FoldOwner[] = [];
		for (const interaction of deduped) {
			if (hasClaudeCommand(interaction)) {
				const prior = interaction.messageId
					? fileState.owners.find(owner => owner.base.messageId === interaction.messageId)
					: undefined;
				if (prior) {
					const interrupted = prior.base.interrupted || interaction.interrupted;
					prior.base = structuredClone(interaction);
					if (interrupted) prior.base.interrupted = true;
					prior.lastLine = "";
				} else {
					newOwners.push({ base: structuredClone(interaction), lastLine: "", lastCost: 0 });
				}
			} else if (!absorbIntoOwner(interaction)) {
				plain.push(interaction);
			}
		}
		const holdBack = size > fileState.lastSize && plain.length > 0;
		// Which turns are held and last is committed with the offset below. A mark
		// set on them before a failure is set again, identically, by the re-read.
		const nextPending = holdBack ? plain.pop() ?? null : null;
		const owners = [...fileState.owners, ...newOwners];
		const lastRead = parsed?.interactions[parsed.interactions.length - 1];
		const nextLastTurn = lastRead
			? {
				turn: lastRead,
				owner: hasClaudeCommand(lastRead)
					|| (!!lastRead.messageId && owners.some(o => o.base.messageId === lastRead.messageId)),
			}
			: fileState.lastTurn;
		const windowOpen = now <= fileState.spawnWindowClosesAt + MTIME_SETTLE_MS;
		const foldSig = foldSetSignature(foldedByAnother);
		const needAttr = owners.length > 0 && (
			newOwners.length > 0 || foldedTranscriptChanged(world, fileState.foldStamps) || windowOpen
			|| fileState.foldedByAnother !== foldSig || owners.some(o => o.lastLine === "")
		);

		let clones: Turn[] = [];
		if (needAttr) {
			try {
				clones = owners.map(o => structuredClone(o.base));
				const doNotFold = new Set([
					world.canonical(state.sessionPath),
					world.canonical(file),
					...foldedByAnother,
				]);
				world.attribute(clones, world.lastCwd(file), doNotFold);
			} catch (err) {
				warnParse(state, out, stateKey, sessionId, err);
				return wroteAny;
			}
			const shrunk = owners.some((o, i) => o.lastCost > 0 && clones[i].cost + 1e-9 < o.lastCost);
			if (shrunk && attempt === 0) {
				fileState = freshSubagentState(fileState.source);
				state.discoveredSubagentFiles.set(stateKey, fileState);
				debug(out, `subagent transcript rotated, opening a new generation: ${path.basename(file)}`);
				continue;
			}
		}

		const source = fileState.source || transcriptSourceId(file, path.dirname(state.sessionPath));
		fileState.source = source;
		state.knownSources.set(stateKey, source);
		let batch = "";
		const nextOwners: FoldOwner[] = owners.map(o => ({ ...o }));
		const consumedQuiet = parsed !== null
			&& parsed.fragment.length === 0
			&& size > 0
			&& nextPending === null;
		const emitGeneration = fileState.newGeneration && (
			plain.length > 0 || clones.length > 0 || rotate || consumedQuiet
		);
		try {
			if (emitGeneration) batch = generationRecordLine(source, sessionId);
			for (const interaction of plain) batch += serializeClassified(interaction, source);
			for (const interaction of reinterrupted) batch += serializeClassified(interaction, source);
			clones.forEach((interaction, i) => {
				const line = serializeClassified(interaction, source);
				if (line === nextOwners[i].lastLine) return;
				batch += line;
				nextOwners[i].lastLine = line;
				nextOwners[i].lastCost = interaction.cost;
			});
		} catch (err) {
			state.pollHadFailure = true;
			if (!state.warned.serialize.has(stateKey)) {
				state.warned.serialize.add(stateKey);
				warn(out, `a subagent's interactions could not be serialized for the tag file, so its cost is missing from this session's total until it succeeds (${sessionId}): ${errText(err)}`);
			}
			return wroteAny;
		}

		const parent = path.basename(state.sessionPath, ".jsonl");
		const freshFolds: string[] = [];
		const foldFrom = clones.length > 0 ? clones : plain;
		if (foldFrom.length > 0) {
			for (const id of foldRecordIds(sessionId, foldFrom)) {
				if (fileState.recordedFolds.has(id)) continue;
				batch += foldRecordLine(parent, id, source);
				freshFolds.push(id);
			}
		}

		if (batch) {
			out.records += batch;
			wroteAny = true;
			state.tagGrewSinceMarker = true;
		}

		if (parsed) {
			fileState.fragment = parsed.fragment;
			fileState.stream = parsed.stream;
			if (fresh.length > 0) fileState.contentHash.update(fresh);
			fileState.lastSize = size;
			fileState.readAtMs = now;
		}
		fileState.mtimeMs = mtimeMs;
		fileState.ino = ino;
		fileState.owners = nextOwners;
		fileState.pendingTurn = nextPending;
		fileState.lastTurn = nextLastTurn;
		for (const id of freshFolds) fileState.recordedFolds.add(id);
		if (emitGeneration) fileState.newGeneration = false;
		if (clones.length > 0) {
			fileState.foldStamps = new Map();
			for (const interaction of clones) {
				for (const fold of interaction.claudeSubAgentFolds ?? []) {
					fileState.foldStamps.set(world.canonical(fold.file), fold.stamp);
				}
			}
			fileState.spawnWindowClosesAt = world.spawnWindowClosesAt(clones, world.lastCwd(file));
		}
		fileState.foldedByAnother = foldSig;
		return wroteAny;
	}
	return wroteAny;
}

/**
 * On resume, the turns that ran `claude -p` are before the offset, so
 * discovery never finds their transcripts again; the tag's generation records
 * name them. Each is registered again and read from its start, as a new
 * generation, so both what it gained while nothing served the session and
 * what it writes from now on are counted. One another transcript currently
 * folds is left to that one. Transcripts discovery does find
 * (`<id>/subagents/`, Pi siblings) are left to it.
 */
function reseedClaudeChildren(state: TaggerState, world: World, out: Out, tagContent: string, quiet: boolean): boolean {
	const children = new Map<string, string>();
	/** Child session id to the source of the transcript folding it, as of the
	 *  last generation of that source: a `_gen` retires its earlier folds. */
	const foldedBy = new Map<string, string>();
	for (const r of tagRecords(tagContent)) {
		if (r.kind === "generation" && r.session !== undefined) {
			children.set(r.source, r.session);
			for (const [child, holder] of [...foldedBy]) if (holder === r.source) foldedBy.delete(child);
		}
		if (r.kind === "fold" && r.source !== undefined) foldedBy.set(r.child, r.source);
	}
	if (children.size === 0) return true;
	let complete = true;
	const failed = (what: string, err: unknown) => {
		complete = false;
		if (!quiet) warn(out, `${what}, so a claude -p transcript read before this daemon started may be missing from this session's total: ${errText(err)}`);
	};
	const found = new Set<string>();
	try {
		for (const file of world.discoverTask(state.sessionPath).files) found.add(world.canonical(file));
	} catch { /* the scan reports it */ }
	let dirs: string[] = [];
	try {
		dirs = world.projectDirs();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") failed("the projects directory could not be read", err);
		return complete;
	}
	const sessionDir = path.dirname(state.sessionPath);
	const root = world.projectsRoot();
	for (const [source, id] of children) {
		const holder = foldedBy.get(id);
		if (holder !== undefined && holder !== source) continue;
		for (const dir of dirs) {
			const file = world.canonical(path.join(root, dir, `${id}.jsonl`));
			try {
				world.stat(file);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR") failed(`${file} could not be stat'd`, err);
				continue;
			}
			if (!sourceCandidates(state, file).has(source)) continue;
			if (!found.has(file)) {
				state.discoveredClaudeFiles.add(file);
				if (!state.discoveredSubagentFiles.has(file)) state.discoveredSubagentFiles.set(file, freshSubagentState(source));
				state.knownSources.set(file, source);
			}
			break;
		}
	}
	return complete;
}

/** Requeue each lookup an earlier life left open. */
function resumeClaudeLookups(state: TaggerState, world: World, tagContent: string) {
	const open = new Map<string, { at: number; commands: string[] }>();
	const settledChildren: string[] = [];
	const readSources = new Set<string>();
	for (const r of tagRecords(tagContent)) {
		if (r.kind === "generation") readSources.add(r.source);
		else if (r.kind === "spawn-pending") open.set(r.key, { at: r.at, commands: r.commands });
		else if (r.kind === "spawn-settled") { settledChildren.push(...r.children); open.delete(r.key); }
	}
	// A child a settled lookup found that no earlier life read.
	for (const file of settledChildren) {
		if ([...sourceCandidates(state, file)].some(source => readSources.has(source))) continue;
		if (world.exists(file)) state.discoveredClaudeFiles.add(file);
	}
	for (const [key, { at, commands }] of open) {
		if (state.pendingClaudeCommands.some(item => spawnKey(item.interaction) === key)) continue;
		const interaction = { messageId: key, timestamp: at, commands } as unknown as Turn;
		state.pendingClaudeCommands.push({ interaction, prevCtx: 0 });
	}
}

/**
 * Resume from the tag an earlier life wrote: the `claude -p` children it
 * read are registered again, its open lookups re-queued, and a swept marker it
 * left is retracted (what changed since is not read yet). `complete` is false
 * when the reseed could not finish; the caller sets `reseedPending`.
 */
export function resumeTagger(state: TaggerState, tagContent: string, world: World): { complete: boolean; records: string; log: LogLine[] } {
	const out: Out = { records: "", log: [] };
	const complete = reseedClaudeChildren(state, world, out, tagContent, false);
	if (!complete) state.reseedPending = true;
	resumeClaudeLookups(state, world, tagContent);
	invalidateStaleSweptMarker(state, world, out, world.now());
	return { complete, records: out.records, log: out.log };
}

export interface ScanOptions {
	/** In a harness: how long one slice may run before the scan yields. The
	 *  clock is read live for this, since it measures the scan's own duration. */
	sliceMs?: number;
}

/**
 * Read every child transcript: open `claude -p` lookups, Task and Pi children,
 * registered `claude -p` children; release the held turn of a transcript no
 * longer found; stamp swept when the tag is settled. `cut` means the slice ran
 * out: the caller appends `records` and calls again to resume the pass.
 */
export function scanChildren(state: TaggerState, world: World, opts: ScanOptions = {}): { records: string; cut: boolean; wrote: boolean; log: LogLine[] } {
	const out: Out = { records: "", log: [] };
	let wroteAny = false;
	const now = world.now();
	// In a harness, one slice at a time, so other sessions' events and requests
	// are served between slices and a reader sees the sum grow. Each slice reads
	// at least one transcript and resumes after the last one it read.
	const deadline = opts.sliceMs === undefined ? Infinity : now + opts.sliceMs;
	let cut = false;
	let readThisSlice = 0;
	const continued = state.scanPass !== null;
	const readThisPass = state.scanPass ?? new Set<string>();
	if (state.scanPassFailed) state.pollHadFailure = true;
	if (state.reseedPending) {
		let content = "";
		try { content = world.readTag(state.tagPath); } catch { /* retried next scan */ }
		if (content && reseedClaudeChildren(state, world, out, content, true)) state.reseedPending = false;
		else state.pollHadFailure = true;
	}
	// pollHadFailure is reset by the caller's read of the session, not here: the flush runs first and can fail.

	if (state.pendingClaudeCommands.length > 0) {
		const stillPending: PendingItem[] = [];
		const registeredBy = new Map<PendingItem, string[]>();
		const sessionBase = path.basename(state.sessionPath, ".jsonl");
		for (const item of state.pendingClaudeCommands) {
			const interaction = item.interaction;
			const ownCwd = world.lastCwd(state.sessionPath);

			let discovered: ReturnType<World["discoverClaude"]>;
			try {
				discovered = world.discoverClaude(interaction.commands, interaction.timestamp, ownCwd);
			} catch (err) {
				state.pollHadFailure = true;
				stillPending.push(item);
				debug(out, `claude -p discovery failed, will retry next poll (${sessionBase}): ${errText(err)}`);
				continue;
			}
			const inWindow = now <= interaction.timestamp + CLAUDE_SUBAGENT_WINDOW_MS + MTIME_SETTLE_MS;
			// Nothing to search. One cause can change — a session cwd not yet
			// readable from the transcript — and the rest (a launcher, an unknowable
			// or bare `cd`) cannot, so the turn waits out its window rather than
			// being dropped at the first look or retried forever.
			if (discovered.searched === 0) {
				if (inWindow) stillPending.push(item);
				continue;
			}
			if (discovered.files.length === 0 && !discovered.unreadable) {
				if (inWindow) stillPending.push(item);
				continue;
			}
			for (const file of discovered.files) {
				// The searched directory holds this session's own transcript, and
				// discovery matches on a time window. A sourced second copy of the
				// session's own turns then competes with the originals in the reader's
				// max-cost collapse, and for a harness whose turns carry no id there is
				// nothing to collapse them with at all.
				if (world.canonical(file) === world.canonical(state.sessionPath)) continue;
				if (!state.discoveredClaudeFiles.has(file)) {
					state.discoveredClaudeFiles.add(file);
					debug(out, `claude -p subagent registered, read from its start (${path.basename(file, ".jsonl")})`);
				}
				registeredBy.set(item, [...(registeredBy.get(item) ?? []), file]);
			}
			if (discovered.unreadable) {
				state.pollHadFailure = true;
				stillPending.push(item);
				debug(out, `claude -p discovery candidate unreadable, will retry next poll (${sessionBase}): ${discovered.unreadable.message}`);
			} else if (inWindow) {
				// A later child in the same window is not on disk yet.
				stillPending.push(item);
			}
		}
		for (const item of state.pendingClaudeCommands) {
			if (!stillPending.includes(item)) {
				// The children it found may not be read before a restart, and only a
				// child already read has a generation record for the resume to find.
				const children = registeredBy.get(item) ?? [];
				out.records += JSON.stringify({ _meta: { spawnSettled: spawnKey(item.interaction), ...(children.length ? { children } : {}) } }) + "\n";
			}
		}
		state.pendingClaudeCommands = stillPending;
	}

	let taskAgentFiles: string[] = [];
	try {
		const discoveredPi = world.discoverTask(state.sessionPath);
		taskAgentFiles = discoveredPi.files;
		if (discoveredPi.unreadable) {
			state.pollHadFailure = true;
			debug(out, `subagent discovery candidate unreadable, will retry next poll (${path.basename(state.sessionPath)}): ${discoveredPi.unreadable.message}`);
		}
	} catch (err) {
		state.pollHadFailure = true;
		debug(out, `subagents dir discovery failed, will retry next poll (${path.basename(state.sessionPath)}): ${errText(err)}`);
	}
	// A transcript some other synced transcript folds must not also be synced
	// under its own source: each one is parsed in its own call, so the fold
	// pass's within-one-call accounting cannot see across them. Derived from
	// the CURRENT fold state every poll, never accumulated, so a parent that
	// rotates and stops folding hands its child straight back.
	// One child, one holder. Two in-window transcripts in a shared project dir
	// each discover the other's children, and each parse bakes what it folds into
	// its own turns, so without an owner the same child's cost lands in both. The
	// owner is the lexicographically first holder, which cannot flip between polls.
	const holderOf = new Map<string, string>();
	for (const [holder, fileState] of state.discoveredSubagentFiles) {
		for (const folded of fileState.foldStamps.keys()) {
			if (folded === holder) continue;
			// Two transcripts that fold each other would each retire the other, and
			// the poll after would find nothing folding either and re-sync both, for
			// a total that alternates between double and none.
			const other = state.discoveredSubagentFiles.get(folded);
			if (other?.foldStamps.has(holder) && holder > folded) continue;
			const holderNow = holderOf.get(folded);
			if (holderNow === undefined || holder < holderNow) holderOf.set(folded, holder);
		}
	}
	const foldedElsewhere = new Set(holderOf.keys());
	/** What one transcript must leave alone: every child another holder owns. */
	const notMine = (file: string): Set<string> => {
		const me = world.canonical(file);
		const result = new Set<string>();
		for (const [folded, holder] of holderOf) if (holder !== me) result.add(folded);
		return result;
	};

	const due = (file: string): boolean => {
		if (readThisPass.has(file)) return false;
		if (readThisSlice > 0 && world.now() > deadline) { cut = true; return false; }
		readThisSlice++;
		readThisPass.add(file);
		return true;
	};

	for (const file of taskAgentFiles) {
		if (cut) break;
		if (!due(file)) continue;
		const skipped = skipAsFoldedElsewhere(state, world, out, file, foldedElsewhere);
		if (skipped.skip) { wroteAny = wroteAny || skipped.retired; continue; }
		wroteAny = syncSubagentTranscript(state, world, out, now, file, notMine(file)) || wroteAny;
	}

	for (const file of state.discoveredClaudeFiles) {
		if (cut) break;
		// Gone from disk is gone, not a failed read: the release below writes
		// the turn it held, and the tag can be stamped swept.
		if (!world.exists(file)) continue;
		if (!due(file)) continue;
		const skipped = skipAsFoldedElsewhere(state, world, out, file, foldedElsewhere);
		if (skipped.skip) { wroteAny = wroteAny || skipped.retired; continue; }
		wroteAny = syncSubagentTranscript(state, world, out, now, file, notMine(file)) || wroteAny;
	}
	// A transcript an earlier slice of this pass read can have grown since; the
	// pass stamps swept only after its growth is read, so it is due again.
	if (!cut && continued) {
		for (const file of readThisPass) {
			const fileState = state.discoveredSubagentFiles.get(world.canonical(file));
			if (!fileState) continue;
			try {
				const st = world.stat(file);
				if (st.size === fileState.lastSize && st.mtimeMs === fileState.mtimeMs && st.ino === fileState.ino) continue;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") state.pollHadFailure = true;
				continue;
			}
			readThisPass.delete(file);
			cut = true;
		}
	}
	if (cut) {
		state.scanPass = readThisPass;
		if (state.pollHadFailure) state.scanPassFailed = true;
		return { records: out.records, cut: true, wrote: wroteAny, log: out.log };
	}
	state.scanPass = null;
	state.scanPassFailed = false;

	// A transcript no longer found (its session moved, so it is read again under
	// its new path) can never release a turn it holds.
	if (!state.pollHadFailure) {
		// A claude -p child stays registered after it moves or is deleted, so it
		// counts as found only while it is on disk.
		const found = new Set([...taskAgentFiles, ...[...state.discoveredClaudeFiles].filter(file => world.exists(file))].map(file => world.canonical(file)));
		// A transcript already read again under the same source this scan has
		// opened its new generation; a pruned line would land after it.
		const liveSources = new Set([...state.discoveredSubagentFiles].filter(([key]) => found.has(key)).map(([, s]) => s.source));
		for (const [key, fileState] of [...state.discoveredSubagentFiles]) {
			if (found.has(key)) continue;
			// Its held turn was read from the file, so it is written; a moved
			// transcript read again under its new path opens a new generation.
			if (fileState.pendingTurn && !liveSources.has(fileState.source)) {
				const source = fileState.source || transcriptSourceId(key, path.dirname(state.sessionPath));
				const childId = path.basename(key, ".jsonl");
				const generation = fileState.newGeneration ? generationRecordLine(source, childId) : "";
				let folds = "";
				for (const id of foldRecordIds(childId, [fileState.pendingTurn])) {
					if (!fileState.recordedFolds.has(id)) folds += foldRecordLine(path.basename(state.sessionPath, ".jsonl"), id, source);
				}
				out.records += generation + serializeClassified(fileState.pendingTurn, source) + folds;
				wroteAny = true;
				state.tagGrewSinceMarker = true;
			}
			state.discoveredSubagentFiles.delete(key);
		}
	}
	// Swept means every subagent turn is written, so a held-back turn defers it
	// to the scan that releases that turn.
	const turnHeldBack = [...state.discoveredSubagentFiles.values()].some(s => s.pendingTurn !== null);
	if (!state.pollHadFailure && !turnHeldBack && (state.tagGrewSinceMarker || state.sweptRetracted)) {
		out.records += JSON.stringify({ _meta: { swept: now } }) + "\n";
		state.tagGrewSinceMarker = false;
		state.sweptRetracted = false;
	}
	return { records: out.records, cut: false, wrote: wroteAny, log: out.log };
}

export interface StepOptions extends ScanOptions {
	/** Whether pending turns may be written this step; the caller owns the cadence. */
	flush: boolean;
}

export interface StepResult {
	/** Whole tag lines to append, in order. */
	records: string;
	/** The child scan's slice ran out; call again to resume the pass. */
	cut: boolean;
	/** A turn, fold, generation or lookup record was produced. */
	wrote: boolean;
	/** The session transcript gained a turn. */
	activity: boolean;
	log: LogLine[];
}

/** One poll: read the session, flush when allowed, scan the children. */
export function stepTagger(state: TaggerState, world: World, opts: StepOptions): StepResult {
	const read = readSession(state, world);
	let records = read.records;
	let wrote = read.records.length > 0;
	if (opts.flush) {
		const flushed = flushTurns(state);
		records += flushed;
		wrote = wrote || flushed.length > 0;
	}
	const scan = scanChildren(state, world, opts);
	return {
		records: records + scan.records,
		cut: scan.cut,
		wrote: wrote || scan.wrote,
		activity: read.activity,
		log: [...read.log, ...scan.log],
	};
}

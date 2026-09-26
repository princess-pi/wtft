/**
 * HarnessRegistry: what a harness knows about each session it serves, has
 * dropped for idling, or is retrying to adopt. One record per session; no
 * filesystem, no timers, no clock. docs/spec-270-harness-registry.md.
 */

import * as path from "node:path";
import { newTaggerState, type TaggerState } from "./session-tagger.ts";

export type FlushTimer = ReturnType<typeof setTimeout>;

export interface SessionRecord {
	/** Everything the tagger decides from: docs/spec-270-session-tagger.md. */
	state: TaggerState;
	pidPath: string;
	rebuildTagOnStartup: boolean;
	lastWriteMs: number;
	lastActivityMs: number;
	startupTime: number;
	idleStartMs: number;
	sessionExisted: boolean;
	displayed: boolean;
	/** When the sweep last checked this transcript on disk. */
	checkedAtMs: number;
	/** A subagent scan ran out of its slice and continues on the next turn of the event loop. */
	scanContinuing: boolean;
	/** The daemon's pending flush, if one is scheduled. */
	flushTimer: FlushTimer | null;
	/** When the session's subagents were last read because a directory of its tree cannot be watched. */
	unwatchedTreeScanAt: number;
}

/** A session dropped for idling: its project directory stays watched and its
 *  next write adopts it again. `sig` is its size, inode and mtime when dropped,
 *  for the sweep to notice a write where the directory cannot be watched;
 *  `since` is when it was dropped, so one not written for the idle time can be
 *  forgotten. */
export interface IdleRecord {
	displayed: boolean;
	since: number;
	sig: string;
}

/** A session that could not be adopted, tried again up to `MAX_ADOPTION_TRIES`
 *  times. `pending` marks the daemon's timer for the next try; it outlives a
 *  cancel, so one retry is pending per session at a time. `tries` is 0 once
 *  cancelled, and the count restarts from 1. */
export interface RetryRecord {
	tries: number;
	displayed: boolean;
	pending: boolean;
}

export const MAX_ADOPTION_TRIES = 5;

export interface Registry {
	served: Map<string, SessionRecord>;
	idle: Map<string, IdleRecord>;
	retrying: Map<string, RetryRecord>;
}

export function newRegistry(): Registry {
	return { served: new Map(), idle: new Map(), retrying: new Map() };
}

export function newSessionRecord(sessionPath: string, displayed: boolean, now: number): SessionRecord {
	return {
		state: newTaggerState(sessionPath, ""),
		pidPath: "",
		rebuildTagOnStartup: false,
		lastWriteMs: 0,
		lastActivityMs: now,
		startupTime: now,
		idleStartMs: 0,
		sessionExisted: false,
		displayed,
		checkedAtMs: now,
		scanContinuing: false,
		flushTimer: null,
		unwatchedTreeScanAt: 0,
	};
}

export function serve(reg: Registry, key: string, record: SessionRecord): void {
	reg.served.set(key, record);
	reg.idle.delete(key);
	cancelRetry(reg, key);
}

export type RetryBegun = { kind: "retry"; tries: number } | { kind: "pending" } | { kind: "gave-up" };

/** Counts one more try. `retry` means the caller starts a timer and reports
 *  the fire with `retryFired`; `pending` means one is already running;
 *  `gave-up` means the tries are spent and the retry is forgotten. */
export function beginRetry(reg: Registry, key: string, displayed: boolean): RetryBegun {
	const cur = reg.retrying.get(key);
	if (cur?.pending) return { kind: "pending" };
	const tries = (cur?.tries ?? 0) + 1;
	if (tries > MAX_ADOPTION_TRIES) {
		reg.retrying.delete(key);
		return { kind: "gave-up" };
	}
	reg.retrying.set(key, { tries, displayed, pending: true });
	return { kind: "retry", tries };
}

/** The daemon's retry timer fired: the retry to act on, or null when it was
 *  cancelled since. */
export function retryFired(reg: Registry, key: string): RetryRecord | null {
	const cur = reg.retrying.get(key);
	if (!cur) return null;
	cur.pending = false;
	if (cur.tries === 0) {
		reg.retrying.delete(key);
		return null;
	}
	return cur;
}

/** Forgets the retry. A pending timer is left to fire into nothing. */
export function cancelRetry(reg: Registry, key: string): void {
	const cur = reg.retrying.get(key);
	if (!cur) return;
	if (cur.pending) cur.tries = 0;
	else reg.retrying.delete(key);
}

export function retryPending(reg: Registry, key: string): boolean {
	return reg.retrying.get(key)?.pending === true;
}

function anyRetryPending(reg: Registry): boolean {
	for (const r of reg.retrying.values()) if (r.pending) return true;
	return false;
}

/** `since` is kept from an earlier mark of the same key. */
export function markIdle(reg: Registry, key: string, displayed: boolean, sig: string, since: number): void {
	reg.idle.set(key, { displayed, since: reg.idle.get(key)?.since ?? since, sig });
}

export function forgetIdle(reg: Registry, key: string): void {
	reg.idle.delete(key);
}

/** Idle-known sessions dropped `idleMs` or more before `now`. */
export function expiredIdle(reg: Registry, now: number, idleMs: number): string[] {
	const out: string[] = [];
	for (const [key, rec] of reg.idle) if (now - rec.since >= idleMs) out.push(key);
	return out;
}

export function get(reg: Registry, key: string): SessionRecord | undefined {
	return reg.served.get(key);
}

/** Nothing served, nothing idle-known, no retry pending: the harness may stop. */
export function isEmpty(reg: Registry): boolean {
	return reg.served.size === 0 && reg.idle.size === 0 && !anyRetryPending(reg);
}

/** The directory a session's subagents live under: its transcript path without `.jsonl`. */
export function sessionDirOf(file: string): string {
	return file.slice(0, -".jsonl".length);
}

function inTree(dir: string, own: string): boolean {
	return dir === own || dir.startsWith(own + path.sep);
}

/** A served session whose directory tree holds `dir`, if any. */
export function servedOver(reg: Registry, dir: string): string | null {
	for (const file of reg.served.keys()) if (inTree(dir, sessionDirOf(file))) return file;
	return null;
}

/** Whether a served or idle-known session still needs `dir` watched: a served
 *  session's project directory or own tree, an idle-known one's project directory. */
export function needsDir(reg: Registry, dir: string): boolean {
	for (const file of reg.served.keys()) {
		if (path.dirname(file) === dir || inTree(dir, sessionDirOf(file))) return true;
	}
	for (const file of reg.idle.keys()) if (path.dirname(file) === dir) return true;
	return false;
}

/** Whether a served session other than `except`, or any idle-known one, lives in `project`. */
export function projectInUse(reg: Registry, project: string, except = ""): boolean {
	for (const file of reg.served.keys()) if (file !== except && path.dirname(file) === project) return true;
	for (const file of reg.idle.keys()) if (path.dirname(file) === project) return true;
	return false;
}

/** Re-keys one served record from `from` to `to`, with everything it holds.
 *  The flush timer is handed back for the caller to clear, since a timer is the
 *  daemon's. Null when `from` is not served, or when `to` is held by another
 *  record: dropping that one is the caller's, before the move. */
export function move(reg: Registry, from: string, to: string): { record: SessionRecord; flushTimer: FlushTimer | null } | null {
	const record = reg.served.get(from);
	if (!record) return null;
	if (from === to) return { record, flushTimer: null };
	const other = reg.served.get(to);
	if (other && other !== record) return null;
	reg.served.delete(from);
	reg.served.set(to, record);
	const flushTimer = record.flushTimer;
	record.flushTimer = null;
	return { record, flushTimer };
}

/** Forgets a served session: the record and its flush timer come back for the
 *  caller to flush and clear. A retry for the key is cancelled; an idle record
 *  stays, since a drop for idling marks the session idle first. */
export function drop(reg: Registry, key: string): { record: SessionRecord | null; flushTimer: FlushTimer | null } {
	cancelRetry(reg, key);
	const record = reg.served.get(key);
	if (!record) return { record: null, flushTimer: null };
	reg.served.delete(key);
	const flushTimer = record.flushTimer;
	record.flushTimer = null;
	return { record, flushTimer };
}

/** One hand-off line: what the next harness on this root takes over. */
export interface HandOffRecord {
	kind: "served" | "idle";
	displayed: boolean;
	path: string;
	since?: number;
	sig?: string;
}

function handOffLine(rec: HandOffRecord): string {
	return JSON.stringify(rec);
}

/** The hand-off, one JSON line per session: served records `keep` accepts (the
 *  registry cannot see a lease), then a session whose adoption is under way,
 *  then retrying ones as served, then idle-known ones with `since` and `sig`. */
export function handOff(reg: Registry, keep: (record: SessionRecord) => boolean, adopting?: { key: string; displayed: boolean }): string[] {
	const lines: string[] = [];
	for (const [key, record] of reg.served) {
		if (keep(record)) lines.push(handOffLine({ kind: "served", displayed: record.displayed, path: key }));
	}
	if (adopting && !reg.served.has(adopting.key)) lines.push(handOffLine({ kind: "served", displayed: adopting.displayed, path: adopting.key }));
	for (const [key, retry] of reg.retrying) {
		if (retry.tries > 0 && !reg.served.has(key) && key !== adopting?.key) lines.push(handOffLine({ kind: "served", displayed: retry.displayed, path: key }));
	}
	for (const [key, idle] of reg.idle) lines.push(handOffLine({ kind: "idle", displayed: idle.displayed, path: key, since: idle.since, sig: idle.sig }));
	return lines;
}

/** Reads a hand-off. A line that is not a JSON object counts as unreadable; a
 *  record whose path is not absolute, does not resolve under `root`, or whose
 *  kind is unknown is skipped. Paths come back resolved. */
export function parseHandOff(text: string, root: string): { records: HandOffRecord[]; unreadable: number } {
	const records: HandOffRecord[] = [];
	let unreadable = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let raw: { kind?: unknown; displayed?: unknown; path?: unknown; since?: unknown; sig?: unknown } | null = null;
		try { raw = JSON.parse(line); } catch { unreadable++; continue; }
		if (!raw || typeof raw !== "object") { unreadable++; continue; }
		if (raw.kind !== "served" && raw.kind !== "idle") continue;
		const file = typeof raw.path === "string" && path.isAbsolute(raw.path) ? path.resolve(raw.path) : "";
		if (!file || !file.startsWith(root + path.sep)) continue;
		const rec: HandOffRecord = { kind: raw.kind, displayed: raw.displayed === true, path: file };
		if (typeof raw.since === "number") rec.since = raw.since;
		if (typeof raw.sig === "string") rec.sig = raw.sig;
		records.push(rec);
	}
	return { records, unreadable };
}

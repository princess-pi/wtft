/**
 * DaemonHealth: is this session's log parser daemon alive, idle, starting or
 * stopped. One pure decision over one set of facts, so every reader (widget,
 * --watch, the startup wait, wtft-daemon --list) gets the same answer.
 * docs/spec-270-daemon-health.md.
 */

import * as fs from "node:fs";
import { leaseHolder } from "./lease.js";
import { tagRecords, type TagRecord } from "./tag-log.js";

/** Threshold for "idle" state: 2m2s — a classic TV commercial break. */
export const IDLE_THRESHOLD_MS = 122_000;

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
	lastHbMs?: number;
	idle?: boolean;
	idleMs?: number;
	idleSinceMs?: number;
	cacheTtlMs?: number | null;
}

/**
 * Fallback: scan the ENTIRE session file backwards for the most recent
 * assistant message's model.
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

/** What decideHealth reads. `sessionModel` is a thunk: the whole session file is
 *  read only when an idle answer needs a cache TTL and the tag tail named no model. */
export interface HealthFacts {
	holderAlive: boolean;
	tag: { size: number; mtimeMs: number; tail: TagRecord[] } | null;
	sessionMtimeMs: number | null;
	sessionModel: () => string | undefined;
}

export interface HealthOptions {
	tagPath?: string;
	/** When the caller last spawned a daemon for this session. */
	spawnedAt?: number | null;
}

const TAIL_BYTES = 8192;
const SPAWN_GRACE_MS = 5000;
const TAG_WRITE_GRACE_MS = 2000;

export function readHealthFacts(sessionPath: string, pidPath: string, tagPath: string): HealthFacts {
	let holderAlive = false;
	const pid = parseInt(leaseHolder(pidPath), 10);
	if (pid > 0) {
		try { process.kill(pid, 0); holderAlive = true; } catch {}
	}
	let tag: HealthFacts["tag"] = null;
	try {
		const stat = fs.statSync(tagPath);
		const readStart = Math.max(0, stat.size - TAIL_BYTES);
		const buf = Buffer.alloc(stat.size - readStart);
		const fd = fs.openSync(tagPath, "r");
		try { fs.readSync(fd, buf, 0, buf.length, readStart); } finally { fs.closeSync(fd); }
		tag = { size: stat.size, mtimeMs: stat.mtimeMs, tail: tagRecords(buf.toString("utf8")) };
	} catch { /* no tag, or unreadable */ }
	let sessionMtimeMs: number | null = null;
	try { sessionMtimeMs = fs.statSync(sessionPath).mtimeMs; } catch { /* no session file */ }
	return { holderAlive, tag, sessionMtimeMs, sessionModel: () => getModelFromSessionFile(sessionPath) };
}

export function decideHealth(facts: HealthFacts, now: number, opts: HealthOptions = {}): DaemonStatus {
	if (facts.holderAlive) {
		if (facts.sessionMtimeMs === null) return { alive: true, reason: "waiting-session" };
		return liveHealth(facts, now);
	}
	if (opts.spawnedAt != null && now - opts.spawnedAt < SPAWN_GRACE_MS) {
		return { alive: false, reason: facts.sessionMtimeMs === null ? "waiting-session" : "starting" };
	}
	const tag = facts.tag;
	if (tag && tag.size > 0 && now - tag.mtimeMs < TAG_WRITE_GRACE_MS) return { alive: false, reason: "starting" };
	let lastHbMs = 0;
	const records = tag?.tail ?? [];
	for (let i = records.length - 1; i >= 0; i--) {
		const r = records[i];
		if (r.kind === "heartbeat" && r.last) { lastHbMs = r.last; break; }
	}
	if (lastHbMs === 0) return { alive: false, reason: "not-found" };
	const d = new Date(lastHbMs);
	const lastHbTime = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	return { alive: false, reason: "idle-timeout", lastHbMs, lastHbTime };
}

function liveHealth(facts: HealthFacts, now: number): DaemonStatus {
	const tag = facts.tag;
	if (!tag || tag.size === 0) return { alive: true };
	const records = tag.tail;
	let lastModel: string | undefined;
	let lastTtl: "1h" | "5m" | undefined;
	let idleSinceMs: number | undefined;
	let sawClassified = false;
	for (let i = records.length - 1; i >= 0; i--) {
		const r = records[i];
		if (r.kind === "heartbeat") {
			if (r.first && idleSinceMs === undefined && !sawClassified) idleSinceMs = r.first;
			continue;
		}
		if (r.kind === "stop") continue;
		if (r.kind === "turn") {
			if (!lastModel && r.interaction.model) lastModel = r.interaction.model;
			if (!lastTtl && r.interaction.cacheTtl) lastTtl = r.interaction.cacheTtl;
		}
		if (!sawClassified) {
			sawClassified = true;
			if (r.kind === "turn" && idleSinceMs !== undefined && r.interaction.timestamp > idleSinceMs) idleSinceMs = r.interaction.timestamp;
		}
		if (lastModel && lastTtl) break;
	}
	const cacheTtl = (): number | null => {
		if (lastTtl) return lastTtl === "1h" ? 3_600_000 : 300_000;
		const model = lastModel ?? facts.sessionModel();
		return model ? getModelCacheTtlMs(model) : null;
	};
	if (idleSinceMs !== undefined && now - idleSinceMs >= IDLE_THRESHOLD_MS) {
		return { alive: true, idle: true, idleMs: now - idleSinceMs, idleSinceMs, cacheTtlMs: cacheTtl() };
	}
	if (facts.sessionMtimeMs !== null && now - facts.sessionMtimeMs >= IDLE_THRESHOLD_MS) {
		return { alive: true, idle: true, idleMs: now - facts.sessionMtimeMs, idleSinceMs: facts.sessionMtimeMs, cacheTtlMs: cacheTtl() };
	}
	return { alive: true };
}

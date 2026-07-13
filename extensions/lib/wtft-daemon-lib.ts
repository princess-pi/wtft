import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import type { Interaction, Category } from "./wtft-parser.js";
import { getVisualLength, getTerminalWidth } from "./wtft-shared.js";
import {
	parseEntryToInteraction,
	deduplicateInteractions,
	classifyInteraction,
	buildWtftLines
} from "./wtft-shared.js";
import { showCursor, hideCursor, enterRawStdin, visualLineCount } from "./tty-helpers.js";
export interface WatchSettings {
	interval: string;
	limit: number;
	mode: "cumulative" | "bucket";
	showTicks: boolean;
	timezone?: string;
	daemonPath?: string; // path to wtft-daemon.mjs (CLI watch mode only)
	/** Padding spaces on each side of output (default 0 = no padding). */
	pad?: number;
	/** True when the user explicitly passed the flag from CLI (overrides file-read settings). */
	hasInterval?: boolean;
	hasLimit?: boolean;
	hasMode?: boolean;
	hasTicks?: boolean;
	hasTimezone?: boolean;
}

export async function watchMode(
	sessionPath: string,
	settings: WatchSettings
): Promise<void> {
	if (!process.stdout.isTTY) {
		console.error("❌ --watch requires a real terminal (TTY). Refusing to start.");
		process.exit(1);
	}

	let totalCost = 0;
	let interactionCount = 0;
	let lastSize = 0;
	let needsRedraw = true;
	let _lastRenderMin = -1;
	// In-place rendering (track visual lines, clear previous render each update).
	hideCursor();

	let lastBuffer: string[] = []; // saved for exit printout
	let lastLineCount = 0;         // visual lines rendered (for in-place overwrite)

	// Shared exit: clears chart output, restores terminal, prints final chart.
	const exitWatch = () => {
		showCursor();
		cleanupStdin();
		// Overwrite in-place chart with same content so only 1 copy in scrollback
		const upRows = lastLineCount > 0
			? visualLineCount(lastBuffer.join("\n") + "\n", getTerminalWidth())
			: 0;
		if (upRows > 0) process.stdout.write(`\x1b[${upRows}A`);
		if (lastBuffer.length > 0) {
			for (const l of lastBuffer) console.log(l);
		}
		console.log(`WTFT watch stopped \u2014 ${interactionCount} interactions, $${totalCost.toFixed(4)} total cost.`);
		process.exit(0);
	};

	process.on("SIGINT", exitWatch);

	// Raw stdin for 'q'/'Q' quit.
	const cleanupStdin = enterRawStdin((key: string) => {
		if (key === "q" || key === "Q" || key === "\u0003") {
			exitWatch();
		}
	});

	const parseInteractions = (filePath: string): { interactions: Interaction[]; disabledEmoji: boolean; sessionInterval?: string; sessionLimit?: number; sessionMode?: "cumulative" | "bucket"; sessionShowTicks?: boolean; sessionTimezone?: string; } => {
		const interactions: Interaction[] = [];
		let disabledEmoji = false;
		let sessionInterval: string | undefined;
		let sessionLimit: number | undefined;
		let sessionMode: "cumulative" | "bucket" | undefined;
		let sessionShowTicks: boolean | undefined;
		let sessionTimezone: string | undefined;

		try {
			const stat = fs.statSync(filePath);
			const currentSize = stat.size;

			if (currentSize < lastSize) {
				// File truncated or rotated — reset
				lastSize = 0;
			}

			if (currentSize <= lastSize) return { interactions, disabledEmoji, sessionInterval, sessionLimit, sessionMode, sessionShowTicks, sessionTimezone };

			const fd = fs.openSync(filePath, "r");
			const buf = Buffer.alloc(currentSize - lastSize);
			fs.readSync(fd, buf, 0, buf.length, lastSize);
			fs.closeSync(fd);
			lastSize = currentSize;

			const newContent = buf.toString("utf8");
			const lines = newContent.split("\n");

			for (const line of lines) {
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
					const interaction = parseEntryToInteraction(entry);
					if (interaction) {
						interactions.push(interaction);
					}
				} catch {
					// Skip unparseable lines (partial writes, non-JSON)
				}
			}
		} catch {
			// File may not exist yet — just return empty
		}

		return { interactions, disabledEmoji, sessionInterval, sessionLimit, sessionMode, sessionShowTicks, sessionTimezone };
	};

	// Accumulator
	let allInteractions: Interaction[] = [];
	let disabledEmoji = false; // read from session file, not settings
	let sessionInterval: string | undefined;
	let sessionLimit: number | undefined;
	let sessionMode: "cumulative" | "bucket" | undefined;
	let sessionShowTicks: boolean | undefined;
	let sessionTimezone: string | undefined;

	// Rewrite in-place: move cursor up to top of previous output,
	// overwrite each line padded with \x1b[K, then \x1b[J below.
	// No DECSC/DECRC — they break on terminal resize.
	const render = () => {
		// Recompute upRows from previous output at current width (handles resize)
		const upRows = lastLineCount > 0
			? visualLineCount(lastBuffer.join("\n") + "\n", getTerminalWidth())
			: 0;
		if (upRows > 0) process.stdout.write(`\x1b[${upRows}A`);

		const width = getTerminalWidth();
		const finalInterval = settings.hasInterval ? settings.interval : (sessionInterval ?? settings.interval);
		const finalLimit = settings.hasLimit ? settings.limit : (sessionLimit ?? settings.limit);
		const finalMode = settings.hasMode ? settings.mode : (sessionMode ?? settings.mode);
		const finalShowTicks = settings.hasTicks ? settings.showTicks : (sessionShowTicks ?? settings.showTicks);
		const finalTimezone = settings.hasTimezone ? settings.timezone : (sessionTimezone ?? settings.timezone);
		const finalWidth = Math.min(width, 1023);

		const defaultSettings = {
			interval: "1h", limit: 100, width: finalWidth,
			showTicks: true, mode: "cumulative" as "cumulative" | "bucket",
			timezone: undefined
		};

		const lines = buildWtftLines(allInteractions, defaultSettings, {
			interval: finalInterval,
			limit: finalLimit,
			width: finalWidth,
			showTicks: finalShowTicks,
			mode: finalMode,
			timezone: finalTimezone,
			disabledEmoji,
		});

		const buf: string[] = [];
		// Session file path first (no interaction count, no cost — just path)
		buf.push(`\x1b[90m${sessionPath}\x1b[0m`);
		totalCost = deduplicateInteractions(allInteractions).reduce((sum, i) => sum + i.cost, 0);

		if (lines && lines.length > 0) {
			for (const l of lines) buf.push(l);
		} else {
			buf.push("\x1b[90mWaiting for session data...\x1b[0m");
		}

		// Footer row (always last line)
		buf.push(`'q' to exit`);

		lastBuffer = [...buf]; // save for exit printout

		// Write each line padded to terminal width with clear-to-EOL.
		// Only pad lines that fit on one display row — padding a wrapped
		// line adds characters that cause MORE wrapping, not less.
		const allLines = [...buf];
		const termW = width;
		for (let i = 0; i < allLines.length; i++) {
			const visLen = getVisualLength(allLines[i]);
			if (visLen < termW) {
				process.stdout.write(allLines[i] + " ".repeat(termW - visLen - 1) + "\x1b[K\n");
			} else {
				process.stdout.write(allLines[i] + "\x1b[K\n");
			}
		}
		// If new output is shorter than previous, pad with blank lines
		// (no \x1b[J — it clears scrollback). upRows already computed from
		// previous buffer at current width, so resize is handled correctly.
		const tempOutput = allLines.join("\n") + "\n";
		const newVisualLines = visualLineCount(tempOutput, termW);
		if (newVisualLines < upRows) {
			for (let i = newVisualLines; i < upRows; i++) {
				process.stdout.write(" ".repeat(Math.max(0, termW - 1)) + "\x1b[K\n");
			}
		}
		lastLineCount = newVisualLines;
		needsRedraw = false;
		_lastRenderMin = new Date().getMinutes();
	};

	// Initial render
	render();

	// SIGWINCH handler — re-render on resize. Terminal re-flows old text
	// to new boundaries; the next render's per-line \x1b[K handles it.
	process.on("SIGWINCH", () => {
		render();
	});

	// Poll loop
	const POLL_MS = 667;
	while (true) {
		await new Promise(resolve => setTimeout(resolve, POLL_MS));

		// Check if file still exists
		if (!fs.existsSync(sessionPath)) {
			lastSize = 0;
			needsRedraw = true;
			render();
			continue;
		}

		const { interactions: newInteractions, disabledEmoji: newDisabledEmoji, sessionInterval: newInterval, sessionLimit: newLimit, sessionMode: newMode, sessionShowTicks: newTicks, sessionTimezone: newTz } = parseInteractions(sessionPath);

		if (newDisabledEmoji !== undefined) disabledEmoji = newDisabledEmoji;
		if (newInterval !== undefined) sessionInterval = newInterval;
		if (newLimit !== undefined) sessionLimit = newLimit;
		if (newMode !== undefined) sessionMode = newMode;
		if (newTicks !== undefined) sessionShowTicks = newTicks;
		if (newTz !== undefined) sessionTimezone = newTz;

		if (newInteractions.length > 0) {
			allInteractions.push(...newInteractions);
			needsRedraw = true;
		}

		// Re-render every minute for timeline diamond/badge live-updates
		const _curMin = new Date().getMinutes();
		if (_curMin !== _lastRenderMin) {
			needsRedraw = true;
		}

		if (needsRedraw) {
			render();
		}
	}
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
		_cat: obj.cat || undefined,
	};
}

/**
 * Read all classified interactions from a tag file, skipping heartbeat lines.
 *
 * @param tagPath - Absolute path to the .wtft-tag.v{N}.jsonl file
 * @returns Array of Interactions (costs already computed by daemon)
 */
export function readClassifiedTagFile(tagPath: string): Interaction[] {
	const interactions: Interaction[] = [];
	try {
		const content = fs.readFileSync(tagPath, "utf8");
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
	} catch {
		// File may not exist yet
	}
	return interactions;
}

// INOTIFY-BASED WATCH MODE (#53)
// Replaces the poll-loop watchMode with fs.watch on the daemon's classified
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

// DAEMON HEALTH CHECK (used by watchTagFile + Pi widget)

/**
/**
 * Compute the tag file path for a given session path.
 * Scans wtft-tags/ subdirectory for the current version's tag file.
 */
export const WTFT_TAGGER_VERSION = "2.3.8";

export function getTagPath(sessionPath: string): string {
	const sessionDir = path.dirname(sessionPath);
	const sessionBase = path.basename(sessionPath);
	const tagsDir = path.join(sessionDir, "wtft-tags");
	const defaultPath = path.join(tagsDir, sessionBase + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	try {
		const prefix = sessionBase + ".wtft-tag.v";
		for (const f of fs.readdirSync(tagsDir)) {
			if (f.startsWith(prefix) && f.endsWith(".jsonl")) {
				return path.join(tagsDir, f);
			}
		}
	} catch {}
	return defaultPath;
}

export function getDaemonPidPath(sessionPath: string): string {
	const sessionHash = createHash("sha256").update(sessionPath).digest("hex").slice(0, 12);
	return path.join(os.tmpdir(), `wtft-daemon-${sessionHash}.pid`);
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

export interface DaemonStatus {
	alive: boolean;
	reason?: string;
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
	if (restarting) {
		return "  \x1b[33m●\x1b[0m restarting...";
	}
	if (!status.alive) {
		const label = status.lastHbTime
			? `stopped ${status.lastHbTime}`
			: (status.reason || "unknown");
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
				let idleMs: number | undefined;
				let idleSinceMs: number | undefined;
				// Scan backwards: heartbeats are after classified entries,
				// so we encounter them first. Scan past ALL heartbeats
				// (including _hb:"stop" from prior daemon instances) to
				// find model info from earlier classified entries (#72, #73).
				for (let i = lines.length - 1; i >= 0; i--) {
					const line = lines[i].trim();
					if (!line) continue;
					try {
						const obj = JSON.parse(line);
						// Track model from most recent classified entry
						if (!lastModel && obj.m) lastModel = obj.m;
						// Heartbeat lines (any form) — keep scanning for model.
						// Range heartbeat: sets idle time + raw timestamp.
						if (obj._hb) {
							if (typeof obj._hb === "object" && obj._hb.first && idleMs === undefined) {
								idleSinceMs = obj._hb.first;
								idleMs = Date.now() - obj._hb.first;
							}
							continue;
						}
						// Classified entry (no _hb) — daemon is active, stop
						break;
					} catch { continue; }
				}
				if (idleMs !== undefined && idleMs >= IDLE_THRESHOLD_MS) {
					// If the tag file had no recent classified entry with model info
					// (only heartbeats), fall back to the session file.
					if (!lastModel) lastModel = getModelFromSessionFile(sessionPath);
					const cacheTtlMs = lastModel ? getModelCacheTtlMs(lastModel) : null;
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
							const cacheTtlMs = lastModel ? getModelCacheTtlMs(lastModel) : null;
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
		return { alive: false, reason: "log parser not found" };
	}

	// Format the heartbeat time as local HH:MM.
	const d = new Date(lastHbMs);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const timeStr = `${hh}:${mm}`;

	return { alive: false, reason: "idle timeout", lastHbTime: timeStr };
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
	tagPath: string,
	settings: WatchSettings
): Promise<void> {
	if (!process.stdout.isTTY) {
		console.error("❌ --watch requires a real terminal (TTY). Refusing to start.");
		process.exit(1);
	}

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

	// In-place rendering (no alt screen): track visual line count,
	// clear previous render on each update, clean up on exit.
	let lastLineCount = 0;
	hideCursor();
	let lastBuffer: string[] = [];

	// Shared exit: clears chart output, restores terminal, prints final chart.
	const exitWatch = () => {
		if (watcher) watcher.close();
		if (daemonWatchdog) clearTimeout(daemonWatchdog);
		showCursor();
		cleanupStdin();
		// Overwrite in-place chart with same content so only 1 copy in scrollback
		const upRows = lastLineCount > 0
			? visualLineCount(lastBuffer.join("\n") + "\n", getTerminalWidth())
			: 0;
		if (upRows > 0) process.stdout.write(`\x1b[${upRows}A`);
		if (lastBuffer.length > 0) {
			for (const l of lastBuffer) console.log(l);
		}
		console.log(`WTFT watch stopped \u2014 ${interactionCount} interactions, $${totalCost.toFixed(4)} total cost.`);
		process.exit(0);
	};

	process.on("SIGINT", exitWatch);

	// DAEMON HEALTH TRACKING
	let daemonDead = false;
	let daemonStopReason = "";
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
				daemonStopReason = "";
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
			daemonStopReason = health.reason || "unknown";
			daemonStopTime = health.lastHbTime || "";
			daemonIdle = false;
		} else if (health.idle) {
			daemonDead = false;
			daemonStopReason = "";
			daemonStopTime = "";
			daemonIdle = true;
			daemonIdleMs = health.idleMs || 0;
			daemonCacheTtlMs = health.cacheTtlMs;
		} else {
			daemonDead = false;
			daemonStopReason = "";
			daemonStopTime = "";
			daemonIdle = false;
		}
	};

	// Raw stdin for 'q'/'Q' quit and 'r' log parser restart.
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
					daemonStopReason = "restart failed";
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

	// Session-level settings from inline wtft-settings entries (same as watchMode).
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
		// Rewrite in-place: move cursor back up to top of previous render,
		// then overwrite each line (padded with \x1b[K clear-to-EOL).
		// Clear below (\x1b[J) after writing to erase any leftover lines.
		// Recompute upRows from previous output at current width (handles resize)
		const upRows = lastLineCount > 0
			? visualLineCount(lastBuffer.join("\n") + "\n", getTerminalWidth())
			: 0;
		if (upRows > 0) process.stdout.write(`\x1b[${upRows}A`);

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

		// Deduplicate by message.id — classified entries from the daemon are already
		// deduped (the daemon uses the same message-ID dedup logic), so this is a no-op
		// in normal operation. Present as cheap insurance against edge cases.
		const deduped = deduplicateInteractions(allInteractions);
		interactionCount = deduped.length;

		const lines = buildWtftLines(deduped, defaultSettings, {
			interval: finalInterval,
			limit: finalLimit,
			width: finalWidth,
			showTicks: finalShowTicks,
			mode: finalMode,
			timezone: finalTimezone,
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
				daemonStatusStr = renderDaemonStatus({ alive: false, reason: daemonStopReason || undefined, lastHbTime: daemonStopTime || undefined }, false);
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
		} else {
			buf.push("\x1b[90mWaiting for session data...\x1b[0m");
		}

		// Footer row
		const restartHint = settings.daemonPath
			? `, using v${WTFT_TAGGER_VERSION}, ` + (daemonDead ? `\x1b[31m'r' to restart\x1b[0m` : `'r' to restart`)
			: "";
		buf.push(`'q' to exit${restartHint}`);

		lastBuffer = [...buf];

		// Write each line padded to terminal width with clear-to-EOL,
		// then count visual lines (accounts for terminal wrapping).
		const termW = width;
		const allLines = buf.map(l => padStr + l);
		for (let i = 0; i < allLines.length; i++) {
			const visLen = getVisualLength(allLines[i]);
			if (visLen < termW) {
				process.stdout.write(allLines[i] + " ".repeat(termW - visLen - 1) + "\x1b[K\n");
			} else {
				process.stdout.write(allLines[i] + "\x1b[K\n");
			}
		}
		// If new output is shorter than previous, pad with blank lines
		// (no \x1b[J — it clears scrollback). upRows already computed from
		// previous buffer at current width, so resize is handled correctly.
		const tempOutput = allLines.join("\n") + "\n";
		const newVisualLines = visualLineCount(tempOutput, termW);
		if (newVisualLines < upRows) {
			for (let i = newVisualLines; i < upRows; i++) {
				process.stdout.write(" ".repeat(Math.max(0, termW - 1)) + "\x1b[K\n");
			}
		}
		lastLineCount = newVisualLines;
		needsRedraw = false;
	};

	// Initial render
	render();
	resetWatchdog();

	// SIGWINCH handler — re-render on resize. Terminal re-flows old text
	// to new boundaries; the next render's per-line \x1b[K handles it.
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

	// Poll for the tag file to appear (daemon creates it on first write).
	const fileWaitStart = Date.now();
	while (!fs.existsSync(tagPath) && Date.now() - fileWaitStart < 5000) {
		await new Promise(r => setTimeout(r, 250));
	}

	if (fs.existsSync(tagPath)) {
		startWatching();
	} else {
		console.error("❌ Log parser did not create tag file within 5s. Is wtft-daemon installed?");
		console.error(`   Expected: ${tagPath}`);
		process.exit(1);
	}

	// Initial daemon health check — run after a short settle (500ms) instead of
	// 10s so the idle/live status updates quickly when the daemon is already idle.
	setTimeout(() => { updateDaemonHealth(); needsRedraw = true; render(); resetWatchdog(); }, 500);

	// Keep the process alive (fs.watch + watchdog are the event sources).
	// This is an intentional infinite await — exitWatch() calls process.exit().
	await new Promise(() => {});
}

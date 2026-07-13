/**
 * @package princess-pi-packages
 * @module session-selector
 * @description Session discovery and interactive TTY selector for Pi and Claude Code session logs.
 *
 * Provides session discovery (walking Pi and Claude Code session directories),
 * session summary extraction (turns + cost from classified wtft-tag files),
 * and an interactive TTY keyboard-navigable session picker.
 *
 * This is a cross-harness module: consumed by both the WTFT CLI (via esbuild bundle)
 * and the Pi WTFT extension (via tsx import).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---
// CONSTANTS (mirrored from wtft-daemon-lib.ts — session-selector is a
// standalone module and should not depend on the daemon's internals)
// ---

const TAGGER_VERSION = "2.3.8";

import { buildDisplayPath, formatRelativeTime } from "./session-path-shortener.ts";
import { formatCost } from "./wtft-shared.ts";
import { enterRawStdin, showCursor, hideCursor, clearPreviousLines, visualLineCount } from "./tty-helpers.ts";

// ---
// TYPES
// ---

export interface SessionCandidate {
	path: string;
	harness: "pi" | "claude-code";
	timestamp: number; // mtime of file
	name: string;      // e.g. "2026-07-02T01-38-34-253Z_019f207a-4e8d-7527-8290-deb8bc53268a.jsonl"
	displayPath: string; // e.g. "~/g-p/princess-pi-packages/2026-07-02...268a"
}

// ---
// SESSION AUTO-DISCOVERY
// ---

/**
 * Discover Pi and/or Claude Code session files by walking the standard directory
 * structures. Returns candidates sorted by modification time descending (newest first).
 *
 * Pi session dir: ~/.pi/agent/sessions/
 * Claude session dir: ~/.claude/projects/<cwd-slug>/sessions/ (and direct parent)
 *
 * @param harness - Target harness: "pi", "claude-code", or "auto" (both)
 * @returns Sorted array of session candidates
 */
export function discoverSessions(
	harness: "pi" | "claude-code" | "auto" = "auto",
	cwdOverride?: string
): SessionCandidate[] {
	const piSessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");

	let claudeSessionsDirs: string[] = [];
	const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
	if (fs.existsSync(claudeProjectsDir)) {
		// Build the CWD slug the same way Claude encodes it: replace / or \ with -
		const resolvedCwd = cwdOverride ? path.resolve(cwdOverride) : process.cwd();
		const cwdSlug = resolvedCwd.replace(/[/\\]/g, "-");
		const sessionsSubdir = path.join(claudeProjectsDir, cwdSlug, "sessions");
		const directDir = path.join(claudeProjectsDir, cwdSlug);
		if (fs.existsSync(sessionsSubdir)) claudeSessionsDirs.push(sessionsSubdir);
		if (fs.existsSync(directDir)) claudeSessionsDirs.push(directDir);
	}

	const candidates: SessionCandidate[] = [];

	const walk = (dir: string, type: "pi" | "claude-code") => {
		const files = fs.readdirSync(dir);
		for (const f of files) {
			const fullPath = path.join(dir, f);
			const stat = fs.statSync(fullPath);
			if (stat.isDirectory()) {
				// Avoid recursing into subagent/tool result/memory/wtft-tags directories
				if (
					f !== "subagents" &&
					f !== "tool-results" &&
					f !== "memory" &&
					f !== "wtft-tags"
				) {
					walk(fullPath, type);
				}
			} else if (f.endsWith(".jsonl")) {
				// Compute the project slug from the parent directory
				let slug: string;
				if (type === "pi") {
					slug = path.basename(dir);
				} else {
					// Claude sessions may be in a 'sessions/' subdir
					const base = path.basename(dir);
					slug = base === "sessions" ? path.basename(path.dirname(dir)) : base;
				}
				candidates.push({
					path: fullPath,
					harness: type,
					timestamp: stat.mtimeMs,
					name: f,
					displayPath: buildDisplayPath(f, slug, type),
				});
			}
		}
	};

	// Pi session directory slug for CWD filtering.
	// Pi directory names look like "--home-princess-pi-git-projects-princess-pi-packages--"
	// which is "--" + cwdSlug + "--". Match by containment.
	const piCwdSlug = cwdOverride ? path.resolve(cwdOverride).replace(/[/\\]/g, "-") : null;

	try {
		if (harness === "auto" || harness === "pi") {
			if (fs.existsSync(piSessionsDir)) {
				// When --dir is specified, only include Pi sessions from the
				// matching project directory, not all Pi sessions globally.
				if (piCwdSlug) {
					const entries = fs.readdirSync(piSessionsDir, { withFileTypes: true });
					for (const entry of entries) {
						if (entry.isDirectory() && entry.name.includes(piCwdSlug)) {
							walk(path.join(piSessionsDir, entry.name), "pi");
						}
					}
				} else {
					walk(piSessionsDir, "pi");
				}
			}
		}
		if (harness === "auto" || harness === "claude-code") {
			for (const dir of claudeSessionsDirs) {
				if (fs.existsSync(dir)) walk(dir, "claude-code");
			}
		}
	} catch {
		// Silently ignore permission errors or missing directories
	}

	return candidates.sort((a, b) => b.timestamp - a.timestamp);
}

// ---
// SESSION SUMMARY (TWO-TIER FALLBACK)
// ---

/**
 * Session summary with fallback metadata.
 */
export interface SessionSummary {
	turns: number;
	cost: number;
	/** Which tagger version was used, or null if no tag exists */
	tagVersion: string | null;
	/** Line count of raw .jsonl file (only set when no tag exists) */
	rawLines: number | null;
}

/** Simple semver comparator for tag file version strings like "2.3.8". */
function compareVersions(a: string, b: string): number {
	const ap = a.split(".").map(Number);
	const bp = b.split(".").map(Number);
	for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
		const d = (ap[i] || 0) - (bp[i] || 0);
		if (d !== 0) return d;
	}
	return 0;
}

/**
 * Read a session summary from classified tag files with two-tier fallback:
 *   1. Try current tagger version (v2.3.8)
 *   2. Scan wtft-tags/ for ANY matching tag file (newest version first)
 *   3. Fall back to raw .jsonl line count if no tag exists at all
 *
 * Only inspects wtft-tag contents — never parses raw .jsonl turn data.
 * All parsing knowledge of internal harness formats is isolated in the
 * log parser daemon, not duplicated in the renderer.
 *
 * @param sessionPath - Path to the raw .jsonl session file
 * @returns SessionSummary with cost, turns, tag version, and optional raw line count
 */
export function getSessionSummary(sessionPath: string): SessionSummary {
	const sessionDir = path.dirname(sessionPath);
	const sessionBase = path.basename(sessionPath);
	const tagsDir = path.join(sessionDir, "wtft-tags");

	// Tier 1: current tagger version
	let tagPath = path.join(tagsDir, sessionBase + `.wtft-tag.v${TAGGER_VERSION}.jsonl`);
	let tagVersion = TAGGER_VERSION;

	if (!fs.existsSync(tagPath)) {
		// Tier 2: scan for any matching tag file (newest version first)
		try {
			const files = fs.readdirSync(tagsDir);
			const prefix = sessionBase + ".wtft-tag.v";
			const matches = files
				.filter(f => f.startsWith(prefix) && f.endsWith(".jsonl"))
				.map(f => {
					const v = f.slice(prefix.length, -".jsonl".length);
					return { path: path.join(tagsDir, f), version: v };
				})
				.sort((a, b) => compareVersions(b.version, a.version)); // newest first
			if (matches.length > 0) {
				tagPath = matches[0].path;
				tagVersion = matches[0].version;
			}
		} catch { /* no tags dir */ }
	}

	if (fs.existsSync(tagPath)) {
		try {
			const content = fs.readFileSync(tagPath, "utf8");
			const lines = content.split("\n");
			let cost = 0;
			let turns = 0;
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const obj = JSON.parse(line);
					if (obj._hb) continue;
					if (typeof obj.c === "number") cost += obj.c;
					turns++;
				} catch { /* skip unparseable lines */ }
			}
			return { turns, cost, tagVersion, rawLines: null };
		} catch { /* tag file unreadable */ }
	}

	// Tier 3: no tag file — count raw .jsonl lines
	let rawLines: number | null = null;
	try {
		const raw = fs.readFileSync(sessionPath, "utf8");
		rawLines = raw.split("\n").filter(l => l.trim()).length;
	} catch { /* session file unreadable */ }

	return { turns: 0, cost: 0, tagVersion: null, rawLines };
}

// ---
// INTERACTIVE SESSION SELECTOR
// ---

/** Format a cost value for the selector display.
 *  Tagged sessions show "$0.15" (green), untagged show "unknown". */
function formatCostOrUnknown(stats: SessionSummary): string {
	if (stats.tagVersion === null) return "unknown".padEnd(7);
	return `\x1b[32m${formatCost(stats.cost).padStart(7)}\x1b[0m`;
}

/** Format turn count or line count for the selector display.
 *  Tagged: "(87t)", untagged: "596 lines". */
function formatTurnsOrLines(stats: SessionSummary): string {
	if (stats.tagVersion !== null) return `(${stats.turns}t)`.padEnd(10);
	return `${stats.rawLines ?? "?"} lines`.padEnd(10);
}

/** Format tag version suffix or "unparsed". */
function formatTagSuffix(stats: SessionSummary): string {
	if (stats.tagVersion === null) return "\x1b[90munparsed\x1b[0m";
	if (stats.tagVersion === TAGGER_VERSION) return ""; // current version — don't show
	return `\x1b[90mv${stats.tagVersion}\x1b[0m`;
}

/**
 * Render an interactive TTY session selector IN-PLACE on the main screen.
 * Uses \\x1b[N A \\x1b[J to overwrite previous output on re-render — no alt
 * screen buffer. When the selector exits, the output is cleared and the chart
 * renders starting where the selector's first line was, preserving scrollback
 * above.
 *
 *   - j/k, arrows: navigate (wraps around)
 *   - Enter: select
 *   - q or Ctrl+C: exit (code 130)
 *
 * @param candidates - Sorted array of session candidates (displayed top 10)
 * @returns Promise resolving to the selected session file path
 */
export async function selectSessionPrompt(
	candidates: SessionCandidate[]
): Promise<string> {
	return new Promise((resolve) => {
		// --- Non-interactive fallback ---
		if (!process.stdout.isTTY) {
			console.log(
				`\x1b[90mNon-interactive environment detected. Defaulting to newest session [1]:\x1b[0m`
			);
			const maxPathLen = Math.max(
				...candidates.slice(0, 5).map((c) => c.displayPath.length),
				10
			);
			for (let i = 0; i < Math.min(candidates.length, 5); i++) {
				const c = candidates[i];
				const stats = getSessionSummary(c.path);
				const relTime = formatRelativeTime(c.timestamp);
				const harnessLabel = c.harness === "claude-code" ? "Claude" : "Pi";
				const costStr = formatCostOrUnknown(stats).replace(/\x1b\[[0-9;]*m/g, "");
				const turnStr = formatTurnsOrLines(stats);
				const tagStr = formatTagSuffix(stats).replace(/\x1b\[[0-9;]*m/g, "");
				console.log(
					`  [${i + 1}] ${c.displayPath.padEnd(maxPathLen)}  ${costStr}  ${turnStr}  [${harnessLabel.padEnd(6)}]  ${relTime.padEnd(6)}  ${tagStr}`
				);
			}
			console.log(
				`\x1b[90mRun 'wtft -s <substring>' to target a specific session by path or basename filter.\x1b[0m\n`
			);
			resolve(candidates[0].path);
			return;
		}

		// --- Interactive TTY selector ---
		let selectedIndex = 0;
		const limit = 10;
		const displayCandidates = candidates.slice(0, limit);
		const statsList = displayCandidates.map((c) => getSessionSummary(c.path));

		hideCursor();

		const maxPathLen = Math.max(
			...displayCandidates.map((c) => c.displayPath.length),
			10
		);

		// Track rendered lines for precise in-place overwrite on arrow keys.
		// logicalLineCount tracks the fixed number of logical lines (title+path+candidates)
		// for the caller to clear when we exit.
		let lastLineCount = 0;
		let logicalLineCount = 0;

		const render = () => {
			const selected = displayCandidates[selectedIndex];
			// Full path (not truncated) — wraps naturally if wider than terminal
			const shortName = selected.name.replace(".jsonl", "").slice(-4);
			let out = `\x1b[1m\x1b[36m\u{1F4B8} WTFT — select session log\x1b[0m \x1b[90m...${shortName}\x1b[0m (j/k or arrows navigate, Enter select, q quit):\n`;
			out += `  \x1b[90m${selected.path}\x1b[0m\n`;
			for (let i = 0; i < displayCandidates.length; i++) {
				const c = displayCandidates[i];
				const stats = statsList[i];
				const relTime = formatRelativeTime(c.timestamp);

				const isSelected = i === selectedIndex;
				const prefix = isSelected
					? "\x1b[36m\x1b[1m > \x1b[0m"
					: "   ";
				const highlight = isSelected ? "\x1b[1m\x1b[36m" : "";
				const reset = isSelected ? "\x1b[0m" : "";

				const harnessLabel = c.harness === "claude-code" ? "Claude" : "Pi";
				const costStr = formatCostOrUnknown(stats);
				const turnStr = formatTurnsOrLines(stats);
				const tagStr = formatTagSuffix(stats);
				out += `${prefix}${highlight}${c.displayPath.padEnd(maxPathLen)}${reset}  ${costStr}  ${turnStr}  [${harnessLabel.padEnd(6)}]  \x1b[90m${relTime.padEnd(6)}\x1b[0m  ${tagStr}\n`;
			}
			// Count visual (wrapped) lines to move cursor exactly that far on re-render
			const cols = process.stdout.columns || 80;
			lastLineCount = visualLineCount(out, cols);
			logicalLineCount = out.replace(/\\n$/, "").split("\\n").length;
			process.stdout.write(out);
		};

		// Initial render
		render();

		const onKey = (key: string) => {
			if (key === "\u0003" || key === "q" || key === "Q") {
				clearPreviousLines(lastLineCount);
				cleanup();
				process.exit(130);
			} else if (key === "\r" || key === "\n") {
				clearPreviousLines(lastLineCount);
				const selectedPath = displayCandidates[selectedIndex].path;
				cleanup();
				resolve(selectedPath);
			} else if (key === "\u001b[A" || key === "k") {
				selectedIndex =
					(selectedIndex - 1 + displayCandidates.length) %
					displayCandidates.length;
				clearPreviousLines(lastLineCount);
				render();
			} else if (key === "\u001b[B" || key === "j") {
				selectedIndex =
					(selectedIndex + 1) % displayCandidates.length;
				clearPreviousLines(lastLineCount);
				render();
			}
		};

		const cleanupStdin = enterRawStdin(onKey);

		const cleanup = () => {
			cleanupStdin();
			showCursor();
		};
	});
}

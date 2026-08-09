/**
 * @package princess-pi-packages
 * @module session-selector
 * @description Cross-harness session discovery fan-out and interactive TTY selector.
 *
 * Provides session discovery (delegated to harness/<id>/discovery.ts, #156),
 * session summary extraction (turns + cost from classified wtft-tag files),
 * and an interactive TTY keyboard-navigable session picker.
 *
 * No harness layout knowledge lives here. Adding a harness must not require
 * editing this file — see docs/adding-a-harness.md.
 *
 * This is a cross-harness module: consumed by both the WTFT CLI (via esbuild bundle)
 * and the Pi WTFT extension (via tsx import).
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---
// CONSTANTS (mirrored from wtft-daemon-lib.ts — session-selector is a
// standalone module and should not depend on the daemon's internals)
// ---

const TAGGER_VERSION = "2.3.8";

import { formatRelativeTime } from "./session-path-shortener.ts";
import { formatCost } from "./wtft-shared.ts";
import { enterRawStdin, showCursor, hideCursor, clearPreviousLines, visualLineCount } from "./tty-helpers.ts";
import { getDiscoveries, getHarness, getHarnesses } from "./harness/registry.ts";
import type { SessionCandidate } from "./harness/types.ts";

// ---
// TYPES
// ---

// SessionCandidate now lives behind the harness seam (#156) — re-exported here
// so existing importers of session-selector are unaffected.
export type { SessionCandidate } from "./harness/types.ts";

// ---
// SESSION AUTO-DISCOVERY
// ---

/**
 * Discover session logs across every enabled harness, newest first.
 *
 * Layout knowledge lives in harness/<id>/discovery.ts (#156); this function
 * only fans out and merges. Each harness applies the union rule internally —
 * a transcript is a candidate when its project-dir slug matches the target cwd
 * OR its own recorded last-cwd does — which is what makes a session that moved
 * (worktree switch, or an ordinary `cd` into a subdir) visible from where it
 * now lives, without dropping any session the old cwd-slug-only scan found.
 *
 * @param harness - Target harness id, or "auto" for all enabled harnesses
 * @param cwdOverride - Directory to scope to; each harness decides what a
 *   missing override means (Claude Code: process.cwd(); Pi: no filter)
 * @returns Candidates sorted by modification time descending (newest first)
 */
export function discoverSessions(
	harness: string = "auto",
	cwdOverride?: string
): SessionCandidate[] {
	const targets = harness === "auto"
		? getDiscoveries()
		: [getHarness(harness)?.discovery].filter((d): d is NonNullable<typeof d> => !!d);

	const candidates: SessionCandidate[] = [];
	for (const discovery of targets) {
		try {
			candidates.push(...discovery.discover(cwdOverride ?? null));
		} catch {
			// A misbehaving harness must not take the selector down with it.
		}
	}

	return candidates.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Display label for a harness id, from the harness itself — never a literal.
 * Falls back to the raw id so an unregistered harness still renders.
 */
export function harnessLabel(id: string): string {
	for (const h of getHarnesses()) {
		if (h.id === id) return h.discovery.label;
	}
	return id;
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
				const label = harnessLabel(c.harness);
				const costStr = formatCostOrUnknown(stats).replace(/\x1b\[[0-9;]*m/g, "");
				const turnStr = formatTurnsOrLines(stats);
				const tagStr = formatTagSuffix(stats).replace(/\x1b\[[0-9;]*m/g, "");
				console.log(
					`  [${i + 1}] ${c.displayPath.padEnd(maxPathLen)}  ${costStr}  ${turnStr}  [${label.padEnd(6)}]  ${relTime.padEnd(6)}  ${tagStr}`
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

				const label = harnessLabel(c.harness);
				const costStr = formatCostOrUnknown(stats);
				const turnStr = formatTurnsOrLines(stats);
				const tagStr = formatTagSuffix(stats);
				out += `${prefix}${highlight}${c.displayPath.padEnd(maxPathLen)}${reset}  ${costStr}  ${turnStr}  [${label.padEnd(6)}]  \x1b[90m${relTime.padEnd(6)}\x1b[0m  ${tagStr}\n`;
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

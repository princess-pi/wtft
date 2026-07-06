/**
 * @package princess-pi-packages
 * @module session-selector
 * @description Session discovery and interactive TTY selector for Pi and Claude Code session logs.
 *
 * Provides session discovery (walking Pi and Claude Code session directories),
 * session summary extraction (turns + cost from .jsonl files), and an interactive
 * TTY keyboard-navigable session picker.
 *
 * This is a cross-harness module: consumed by both the WTFT CLI (via esbuild bundle)
 * and the Pi WTFT extension (via tsx import).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { buildDisplayPath, formatRelativeTime } from "./session-path-shortener.ts";
import { formatCost, parseEntryToInteraction, deduplicateInteractions, type Interaction } from "./wtft-shared.ts";

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

	try {
		if (harness === "auto" || harness === "pi") {
			if (fs.existsSync(piSessionsDir)) walk(piSessionsDir, "pi");
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
// SESSION SUMMARY
// ---

/**
 * Read a session .jsonl file and return a summary of assistant turns and total cost.
 *
 * @param filePath - Path to the .jsonl session file
 * @returns Object with turn count and total cost
 */
export function getSessionSummary(
	filePath: string
): { turns: number; cost: number } {
	let turns = 0;
	const interactions: Interaction[] = [];
	try {
		const content = fs.readFileSync(filePath, "utf8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				// Count assistant turns (per-line count — approximate, one message
				// may span multiple JSONL lines in Claude Code transcripts)
				if (
					entry.type === "assistant" ||
					(entry.message && entry.message.role === "assistant")
				) {
					turns++;
				}
				const interaction = parseEntryToInteraction(entry);
				if (interaction) interactions.push(interaction);
			} catch {
				// Skip unparseable lines
			}
		}
	} catch {
		// File may not exist or be unreadable
	}
	// Dedup by message.id before summing (#54)
	const deduped = deduplicateInteractions(interactions);
	const cost = deduped.reduce((sum, i) => sum + i.cost, 0);
	return { turns, cost };
}

// ---
// INTERACTIVE SESSION SELECTOR
// ---

function formatCostPadded(cost: number): string {
	return formatCost(cost).padStart(7);
}

/**
 * Count visual (wrapped) lines the selector will occupy in the terminal.
 * Each logical line may wrap into ceil(len / termWidth) visual rows.
 * ANSI escape codes are stripped before measuring.
 */
function visualLineCount(text: string, termWidth: number): number {
	const ansiRe = /\x1b\[[0-9;]*[a-zA-Z]/g;
	const lines = text.replace(/\n$/, "").split("\n");
	let count = 0;
	for (const line of lines) {
		const cleanLen = line.replace(ansiRe, "").length;
		count += cleanLen === 0 ? 1 : Math.ceil(cleanLen / Math.max(termWidth, 1));
	}
	return count;
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
				console.log(
					`  [${i + 1}] ${c.displayPath.padEnd(maxPathLen)}  ${formatCostPadded(stats.cost)}  (${stats.turns}t) [${c.harness === "claude-code" ? "CC" : "PI"}]  \x1b[90m${relTime}\x1b[0m`
				);
			}
			console.log(
				`\x1b[90mRun 'wtft -s <number>' to target a specific session index.\x1b[0m\n`
			);
			resolve(candidates[0].path);
			return;
		}

		// --- Interactive TTY selector ---
		let selectedIndex = 0;
		const limit = 10;
		const displayCandidates = candidates.slice(0, limit);
		const statsList = displayCandidates.map((c) => getSessionSummary(c.path));

		const stdin = process.stdin;
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");

		process.stdout.write("\x1b[?25l"); // Hide cursor

		// Save cursor position before first render. On exit / re-render,
		// restore cursor + clear to end — guaranteed exact, no line counting.
		process.stdout.write("\x1b7");

		const maxPathLen = Math.max(
			...displayCandidates.map((c) => c.displayPath.length),
			10
		);

		// Track rendered lines for precise in-place overwrite on arrow keys
		let lastLineCount = 0;

		const render = () => {
			const selected = displayCandidates[selectedIndex];
			// Full path (not truncated) — wraps naturally if wider than terminal
			let out = `\x1b[1m\x1b[36m\u{1F4B8} WTFT Session Selector\x1b[0m (j/k or arrows navigate, Enter select, q quit):\n`;
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

				const harnessLabel = c.harness === "claude-code" ? "CC" : "PI";
				const costStr = `\x1b[32m${formatCostPadded(stats.cost)}\x1b[0m`;
				out += `${prefix}${highlight}${c.displayPath.padEnd(maxPathLen)}${reset}  ${costStr}  (${stats.turns}t) [${harnessLabel}]  \x1b[90m${relTime}\x1b[0m\n`;
			}
			// Count visual (wrapped) lines to move cursor exactly that far on re-render
			const cols = process.stdout.columns || 80;
			lastLineCount = visualLineCount(out, cols);
			process.stdout.write(out);
		};

		// Move cursor up exactly the number of visual lines rendered, then clear
		// to end of screen. This overwrites the previous render in-place.
		const overwritePrevious = () => {
			if (lastLineCount > 0) {
				process.stdout.write(`\x1b[${lastLineCount}A\x1b[J`);
			}
		};

		// Initial render
		render();

		const onKey = (key: string) => {
			if (key === "\u0003" || key === "q" || key === "Q") {
				// Restore saved cursor pos + clear to end — wipes selector cleanly
				process.stdout.write("\x1b8\x1b[J");
				cleanup();
				process.exit(130);
			} else if (key === "\r" || key === "\n") {
				// Restore saved cursor pos + clear to end — chart starts exactly here
				process.stdout.write("\x1b8\x1b[J");
				const selectedPath = displayCandidates[selectedIndex].path;
				cleanup();
				resolve(selectedPath);
			} else if (key === "\u001b[A" || key === "k") {
				selectedIndex =
					(selectedIndex - 1 + displayCandidates.length) %
					displayCandidates.length;
				overwritePrevious();
				render();
			} else if (key === "\u001b[B" || key === "j") {
				selectedIndex =
					(selectedIndex + 1) % displayCandidates.length;
				overwritePrevious();
				render();
			}
		};

		const cleanup = () => {
			stdin.removeListener("data", onKey);
			stdin.setRawMode(false);
			stdin.pause();
			process.stdout.write("\x1b[?25h"); // Show cursor
		};

		stdin.on("data", onKey);
	});
}

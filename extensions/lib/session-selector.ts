/**
 * @package @princess-pi/wtft
 * @module session-selector
 * @description Cross-harness session discovery fan-out and interactive TTY selector.
 *
 * Provides session discovery (delegated to harness/<id>/discovery.ts),
 * session summary extraction (turns + cost from classified wtft-tag files),
 * and an interactive TTY keyboard-navigable session picker.
 *
 * No harness layout knowledge lives here. Adding a harness must not require
 * editing this file — see docs/adding-a-harness.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---
// CONSTANTS — tagger version imported from its leaf module, never mirrored.
// ---

import { WTFT_TAGGER_VERSION as TAGGER_VERSION } from "./wtft-tagger-version.ts";

import { formatRelativeTime } from "@princess-pi/libs/session-path-shortener";
import { formatCost } from "./wtft-shared.ts";
import { enterRawStdin, showCursor, hideCursor, clearPreviousLines, visualLineCount } from "./tty-helpers.ts";
import { getDiscoveries, getHarness, getHarnesses } from "./harness/registry.ts";
import type { DiscoverScopeOptions, SessionCandidate } from "./harness/types.ts";
import {
	initPickerState,
	setRows,
	visibleWindow,
	applyKey,
	windowMsFor,
	type PickerState,
	type PickerRow,
} from "./picker-state.ts";
import { readHarnessOrder, recordHarnessOpened, orderByHarness } from "./harness-order.ts";
import { resolveBranchCheckout } from "./harness/worktrees.ts";

// ---
// TYPES
// ---

// SessionCandidate lives behind the harness seam — re-exported so existing
// importers of session-selector are unaffected.
export type { SessionCandidate } from "./harness/types.ts";

// ---
// SESSION AUTO-DISCOVERY
// ---

/**
 * Discover session logs across every enabled harness, newest first.
 *
 * Layout knowledge lives in harness/<id>/discovery.ts; this function only fans
 * out across harnesses and merges. Each harness applies the union rule
 * internally, and the union is strictly additive: no arm may ever become a
 * replacement. A transcript is a candidate when ANY of these holds —
 *
 *   - its project-dir slug matches the target cwd, under EITHER known slug
 *     encoding rather than one pinned guess;
 *   - its own recorded last-cwd matches, which is what makes a session that
 *     moved (worktree switch, or an ordinary `cd` into a subdir) visible from
 *     where it now lives;
 *   - the "target cwd" is any checkout of the target's git repo, not just the
 *     one directory, so sibling worktrees are in scope in both directions.
 *     No `.git` ancestor means no fan-out, so `~` still means `~`.
 *
 * Which arms apply is each harness's own call. Claude Code wires up all three.
 * Pi wires up the first two — its last-cwd arm is mostly inert because Pi
 * records `cwd` once on session_start. See docs/adding-a-harness.md.
 *
 * @param harness - Target harness id, or "auto" for all enabled harnesses
 * @param cwdOverride - Directory to scope to. Missing means process.cwd(),
 *   except on Pi's unscoped default, where it means no filter.
 * @param scopeOpts - Omitted → every harness's legacy default (fan-out, union
 *   arm, unbounded time) — see `HarnessDiscovery.discover` in `harness/types.ts`.
 *   Only `windowMs` is enforced here too; `scope` is each harness's to honour.
 * @returns Candidates sorted by modification time descending (newest first)
 */
export function discoverSessions(
	harness: string = "auto",
	cwdOverride?: string,
	scopeOpts?: DiscoverScopeOptions
): SessionCandidate[] {
	const targets = harness === "auto"
		? getDiscoveries()
		: [getHarness(harness)?.discovery].filter((d): d is NonNullable<typeof d> => !!d);

	const candidates: SessionCandidate[] = [];
	for (const discovery of targets) {
		try {
			candidates.push(...discovery.discover(cwdOverride ?? null, scopeOpts));
		} catch (err) {
			// A misbehaving harness must not take the selector down — name the
			// failure on stderr so "threw" is not indistinguishable from "found nothing".
			const reason = err instanceof Error ? err.message : String(err);
			process.stderr.write(`\x1b[33mwtft: harness '${discovery.id}' discovery failed: ${reason}\x1b[0m\n`);
		}
	}

	// Defensive time-window: a harness's own `discover` is supposed to honour
	// `scopeOpts.windowMs`, but nothing enforces that. Post-filtering here makes
	// the window a real guarantee of this function's OUTPUT.
	const windowMs = scopeOpts?.windowMs ?? null;
	const withinWindow = windowMs === null
		? candidates
		: candidates.filter(c => Date.now() - c.timestamp <= windowMs);

	return withinWindow.sort((a, b) => b.timestamp - a.timestamp);
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
 *   1. Try the current tagger version (imported from wtft-tagger-version.ts)
 *   2. Scan wtft-tags/ for ANY matching tag file (newest version first)
 *   3. Fall back to raw .jsonl line count if no tag exists at all
 *
 * Only inspects wtft-tag contents — never parses raw .jsonl turn data.
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
		// ONLY the READ may fall through to Tier 3. "Could not be read" and
		// "the collapse threw" are different facts — a defect in the collapse
		// must not disguise itself as a missing artifact.
		let content: string | null = null;
		try {
			content = fs.readFileSync(tagPath, "utf8");
		} catch { /* tag file unreadable — Tier 3 below is the honest answer */ }

		if (content !== null) {
				const lines = content.split("\n");
				// Collapse by message.id (max cost) before summing — same rule as
				// dedupeClassifiedById. This module does not import the daemon lib,
				// so the collapse is local. Pinned by
				// tests/wtft-270-session-summary-dedup.test.ts.
				const maxCostById = new Map<string, number>();
				const idOrder: string[] = [];
				let noIdCost = 0;
				let noIdCount = 0;
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const obj = JSON.parse(line);
						if (obj._hb) continue;
						const lineCost = typeof obj.c === "number" ? obj.c : 0;
						if (typeof obj.id === "string" && obj.id) {
							const prev = maxCostById.get(obj.id);
							if (prev === undefined) idOrder.push(obj.id);
							maxCostById.set(obj.id, prev === undefined ? lineCost : Math.max(prev, lineCost));
						} else {
							noIdCost += lineCost;
							noIdCount++;
						}
					} catch { /* skip unparseable lines */ }
				}
				let cost = noIdCost;
				// `?? 0` rather than a non-null assertion: fallback is unreachable
				// but an assertion that CAN fire would no longer be hidden by the
				// narrowed catch above.
				for (const id of idOrder) cost += maxCostById.get(id) ?? 0;
				const turns = idOrder.length + noIdCount;
				return { turns, cost, tagVersion, rawLines: null };
		}
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

/** Text shown after "scope:" in the picker header, keyed by `PickerState.scope`
 *  — display-only. `applyKey` sets `state.scope` to `"branch"` unconditionally
 *  on Ctrl+B, but the rescope handler corrects it BACK to `"worktree"` when
 *  `resolveBranchCheckout` says the branch can't be resolved, so the label and
 *  the actual candidate population never disagree. */
const SCOPE_LABEL: Record<PickerState["scope"], string> = {
	worktree: "this worktree",
	worktrees: "all worktrees (Ctrl+W)",
	all: "all projects (Ctrl+A)",
	branch: "this branch (Ctrl+B)",
};

/** A `SessionCandidate` reduced to what `picker-state.ts` needs. `c.path` is
 *  the caller's lookup key (`byPath` below). */
function toPickerRow(c: SessionCandidate): PickerRow {
	return { id: c.path, harness: c.harness, timestamp: c.timestamp };
}

export interface SelectSessionPromptOptions {
	/** Passed straight to `discoverSessions` on every rescope (Ctrl+A/W/B/T). */
	harnessOption: string;
	cwdOverride?: string;
	/** Where the picker draws. Defaults to stdout; `bin/wtft.ts` passes stderr
	 *  under `--json` so stdout stays one clean JSON document.
	 *  `bin/wtft.ts`'s `canShowPicker` guard guarantees THIS stream is a TTY
	 *  whenever this function is called. */
	out?: NodeJS.WritableStream;
	/**
	 * The `-s <substring>` the caller already filtered `initialCandidates` by.
	 * Re-applies after every rescope, and seeds state `"worktrees"`/`"all"`.
	 */
	substringFilter?: string;
}

/** The same substring predicate `bin/wtft.ts`'s fuzzy `-s` match uses. */
function matchesSubstring(c: SessionCandidate, filter: string): boolean {
	const needle = filter.toLowerCase();
	return c.path.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle);
}

/**
 * Render the scoped, interactive session picker IN-PLACE on the main screen.
 * Uses `\x1b[N A \x1b[J` to overwrite previous output on re-render — no alt
 * screen buffer. When the picker exits, the output is cleared and the chart
 * renders starting where the picker's first line was.
 *
 * Key handling is delegated ENTIRELY to the pure state machine in
 * `picker-state.ts` — this function turns a `PickerAction` into a terminal
 * write or a re-discovery call:
 *
 *   - j/k, arrows: move (wraps the whole list, sliding the 11-row window)
 *   - Enter: select — also records the sticky harness order
 *   - q or Ctrl+C: exit (code 130)
 *   - Ctrl+A / Tab: scope "all"  ·  Ctrl+W: scope "worktrees"
 *   - Ctrl+B: scope "branch" — falls back to `"worktree"` when the branch
 *     can't be resolved; see `SCOPE_LABEL`.
 *   - Ctrl+T: cycle the time window (20m -> 1h -> 1d -> 1w -> all -> 20m)
 *
 * Requires an interactive terminal — the caller is responsible for the no-TTY
 * decision and must never call this without one.
 *
 * @param initialCandidates - The picker's starting rows. The picker state
 *   starts at `"worktree"`/`"20m"`, except under `substringFilter`.
 * @returns Promise resolving to the selected session file path
 */
export async function selectSessionPrompt(
	initialCandidates: SessionCandidate[],
	opts: SelectSessionPromptOptions
): Promise<string> {
	return new Promise((resolve) => {
		const out = opts.out ?? process.stdout;

		const byPath = new Map<string, SessionCandidate>();
		// One tag-file read per row per picker session, not per keystroke.
		const summaries = new Map<string, ReturnType<typeof getSessionSummary>>();
		const summaryFor = (p: string) => {
			let s = summaries.get(p);
			if (!s) { s = getSessionSummary(p); summaries.set(p, s); }
			return s;
		};
		const remember = (list: SessionCandidate[]) => { for (const c of list) byPath.set(c.path, c); };
		remember(initialCandidates);

		const harnessIds = getHarnesses().map(h => h.id);
		const toRows = (list: SessionCandidate[]): PickerRow[] =>
			orderByHarness(list, readHarnessOrder(opts.cwdOverride), harnessIds).map(toPickerRow);

		let state: PickerState = setRows(initPickerState(), toRows(initialCandidates));

		// Under `-s` the rows come from unscoped, unbounded discovery. Seed
		// `"worktrees"`/`"all"` so Ctrl+T does not narrow to this directory.
		let scopeLabelOverride: string | null = null;
		if (opts.substringFilter) {
			state = { ...state, scope: "worktrees", timeWindow: "all" };
			scopeLabelOverride = "everything -s searches";
		}

		hideCursor(out);

		let lastLineCount = 0;

		const render = () => {
			const view = visibleWindow(state);
			let text = `\x1b[1m\x1b[36m\u{1F4B8} WTFT — select session log\x1b[0m ` +
				`\x1b[90m(j/k navigate, Enter select, q quit · Ctrl+A/Tab all · Ctrl+W worktrees · ` +
				`Ctrl+B branch · Ctrl+T window)\x1b[0m\n`;
			text += opts.substringFilter
				? `  \x1b[90mscope: ${scopeLabelOverride ?? SCOPE_LABEL[state.scope]}  ·  window: ${state.timeWindow}  ·  filtered by -s "${opts.substringFilter}"\x1b[0m\n`
				: `  \x1b[90mscope: ${SCOPE_LABEL[state.scope]}  ·  window: ${state.timeWindow}\x1b[0m\n`;

			if (view.rows.length === 0) {
				text += `  \x1b[33mNo sessions in this window. Press Ctrl+T to widen it.\x1b[0m\n`;
			} else {
				const maxPathLen = Math.max(
					...view.rows.map(r => byPath.get(r.id)?.displayPath.length ?? 0),
					10
				);
				for (let i = 0; i < view.rows.length; i++) {
					const row = view.rows[i];
					const c = byPath.get(row.id);
					if (!c) continue;
					const stats = summaryFor(c.path);
					const relTime = formatRelativeTime(c.timestamp);

					const isSelected = i === view.cursorIndexInView;
					const prefix = isSelected ? "\x1b[36m\x1b[1m > \x1b[0m" : "   ";
					const highlight = isSelected ? "\x1b[1m\x1b[36m" : "";
					const reset = isSelected ? "\x1b[0m" : "";

					const label = harnessLabel(c.harness);
					const costStr = formatCostOrUnknown(stats);
					const turnStr = formatTurnsOrLines(stats);
					const tagStr = formatTagSuffix(stats);
					text += `${prefix}${highlight}${c.displayPath.padEnd(maxPathLen)}${reset}  ${costStr}  ${turnStr}  [${label.padEnd(6)}]  \x1b[90m${relTime.padEnd(6)}\x1b[0m  ${tagStr}\n`;
				}
				// The 12th row: a position line, never selectable.
				if (view.positionLine) {
					text += `  \x1b[90m${view.positionLine}\x1b[0m\n`;
				}
			}

			const cols = (out as NodeJS.WriteStream).columns || 80;
			lastLineCount = visualLineCount(text, cols);
			out.write(text);
		};

		render();

		const cleanupStdin = enterRawStdin((key: string) => {
			const action = applyKey(state, key);

			if (action.type === "quit") {
				clearPreviousLines(lastLineCount, out);
				cleanup();
				process.exit(130);
			} else if (action.type === "select") {
				clearPreviousLines(lastLineCount, out);
				const c = byPath.get(action.row.id);
				if (!c) { render(); return; } // should not happen; stale row id
				recordHarnessOpened(c.harness, opts.cwdOverride ?? process.cwd());
				cleanup();
				resolve(c.path);
			} else if (action.type === "move") {
				state = action.state;
				clearPreviousLines(lastLineCount, out);
				render();
			} else if (action.type === "rescope") {
				state = action.state;
				scopeLabelOverride = null;
				// Ctrl+B population falls back to "worktree"; the LABEL must say so too.
				if (state.scope === "branch" && !resolveBranchCheckout(opts.cwdOverride ?? process.cwd())) {
					state = { ...state, scope: "worktree" };
				}
				// Re-discover for the new scope/window, THEN re-window the fresh rows.
				let fresh = discoverSessions(opts.harnessOption, opts.cwdOverride, {
					scope: state.scope,
					windowMs: windowMsFor(state.timeWindow),
				});
				// Re-apply the caller's `-s` filter.
				if (opts.substringFilter) fresh = fresh.filter(c => matchesSubstring(c, opts.substringFilter!));
				remember(fresh);
				state = setRows(state, toRows(fresh));
				clearPreviousLines(lastLineCount, out);
				render();
			}
			// "noop" — nothing to do.
		});

		const cleanup = () => {
			cleanupStdin();
			showCursor(out);
		};
	});
}

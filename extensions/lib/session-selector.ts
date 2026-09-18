/**
 * @package princess-pi-tools
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
// CONSTANTS — the tagger version is imported from its leaf module, never
// mirrored: a mirrored literal sat four bumps stale here (#499). The leaf
// module keeps this file free of the daemon's tag-file I/O internals.
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
 * only fans out across harnesses and merges. Each harness applies the union
 * rule internally, and the union is strictly additive: no arm may ever become a
 * replacement, because every arm exists to stop dropping sessions the previous
 * rule found. A transcript is a candidate when ANY of these holds —
 *
 *   - its project-dir slug matches the target cwd, under EITHER known slug
 *     encoding rather than one pinned guess (#144);
 *   - its own recorded last-cwd matches, which is what makes a session that
 *     moved (worktree switch, or an ordinary `cd` into a subdir) visible from
 *     where it now lives (#156);
 *   - the "target cwd" is any checkout of the target's git repo, not just the
 *     one directory, so sibling worktrees are in scope in both directions.
 *     No `.git` ancestor means no fan-out, so `~` still means `~` (#145).
 *
 * A fourth arm existed and was deleted (#89): a session whose last cwd had been
 * DELETED used to match against every directory its transcript had ever
 * recorded, at the cost of a whole-file read per stranded transcript. Measured
 * 2026-09-16 it returned 0 candidates the slug arm had not, for 6,952 whole-file
 * reads per launch. The one shape it alone could reach — a session filed under a
 * worktree slug, with the worktree since removed — is conceded on #89.
 *
 * Which arms apply is each harness's own call. Claude Code wires up all three.
 * Pi wires up the first two — its slug arm accepts both encodings, and the
 * last-cwd arm is present but never fires, because Pi records `cwd` once on its
 * session_start entry and a tail scan finds nothing. That is deliberate rather
 * than a gap: the day Pi records per-entry cwd, the arm starts working with no
 * code change. See docs/adding-a-harness.md.
 *
 * @param harness - Target harness id, or "auto" for all enabled harnesses
 * @param cwdOverride - Directory to scope to; each harness decides what a
 *   missing override means (Claude Code: process.cwd(); Pi: no filter)
 * @param scopeOpts - Omitted → every harness's PRE-#89 default (fan-out,
 *   the union arm, unbounded time) — see `HarnessDiscovery.discover`'s own
 *   docstring in `harness/types.ts`. `bin/wtft.ts`'s picker is the one caller
 *   that passes this explicitly.
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
			// A misbehaving harness must not take the selector down with it —
			// but a SILENT catch made "this harness threw" indistinguishable
			// from "this harness genuinely found nothing" (pr-review round 2,
			// Medium): under #89's no-TTY exit-10 path, that ambiguity used to
			// read as "zero sessions" with no hint anything went wrong. Named
			// on stderr now, never thrown, so the caller's candidate LIST is
			// unchanged (still whatever the other harnesses found) but the
			// FAILURE is no longer invisible.
			const reason = err instanceof Error ? err.message : String(err);
			process.stderr.write(`\x1b[33mwtft: harness '${discovery.id}' discovery failed: ${reason}\x1b[0m\n`);
		}
	}

	// Defensive time-window enforcement (pr-review round 2, Medium): a
	// harness's OWN `discover` is supposed to honour `scopeOpts.windowMs`
	// (docs/adding-a-harness.md), but nothing enforces that — an out-of-tree
	// harness that ignores it would otherwise inflate the no-TTY "exactly one
	// candidate" check and make the picker's "window: …" header false for its
	// rows. Post-filtering here makes the window a real guarantee of this
	// function's OUTPUT regardless of whether every harness cooperated,
	// cheaply (one timestamp compare per candidate already in memory).
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
 *   1. Try the current tagger version (imported from wtft-tagger-version.ts)
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
		// ONLY the READ may fall through to Tier 3 (PR review). "The tag file
		// could not be read" and "the collapse below threw" are different facts,
		// and the old single broad catch reported the second as the first —
		// handing back a raw line count with no cost, indistinguishable from a
		// session that was never tagged. A defect in the collapse must not
		// disguise itself as a missing artifact, so the collapse sits OUTSIDE
		// this catch: it is Map arithmetic over lines whose JSON.parse is already
		// guarded per line, so it has no realistic throw path, and if one ever
		// appears it should surface rather than quietly degrade the answer.
		let content: string | null = null;
		try {
			content = fs.readFileSync(tagPath, "utf8");
		} catch { /* tag file unreadable — Tier 3 below is the honest answer */ }

		if (content !== null) {
				const lines = content.split("\n");
				// A subagent's growing-usage message legitimately appears as
				// multiple tag-file lines sharing one message.id (`obj.id`), at
				// different costs, written across different polls — see
				// docs/wtft-incremental-render-spec.md, "The append filter, and
				// what the tag file may contain." Every reader must collapse by
				// id (max cost) before summing. This module deliberately does
				// not import wtft-daemon-lib's dedupeClassifiedById (see the
				// CONSTANTS comment above), so the same collapse is reimplemented
				// locally here rather than summing raw lines. Pinned against
				// dedupeClassifiedById's behavior (PR review round 2, two
				// independent implementations with nothing keeping them in sync is
				// how they drift): tests/wtft-270-session-summary-dedup.test.ts.
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
				// `?? 0` rather than a non-null assertion: idOrder only ever holds
				// keys that were just written into maxCostById, so the fallback is
				// unreachable — but an assertion that CAN fire is exactly the kind of
				// throw the narrowed catch above would no longer hide (PR review).
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
 *  — display-only, no behaviour reads these strings back. `applyKey` sets
 *  `state.scope` to `"branch"` unconditionally on Ctrl+B (it is pure and has
 *  no git awareness), but the rescope handler in `selectSessionPrompt` below
 *  corrects it BACK to `"worktree"` before this label is ever rendered, when
 *  `resolveBranchCheckout` says the branch can't be resolved — so the label
 *  and the actual candidate population never disagree (pr-review round 2,
 *  Medium; round 1 of this fix left the label reading "branch" regardless). */
const SCOPE_LABEL: Record<PickerState["scope"], string> = {
	worktree: "this worktree",
	worktrees: "all worktrees (Ctrl+W)",
	all: "all projects (Ctrl+A)",
	branch: "this branch (Ctrl+B)",
};

/** A `SessionCandidate` reduced to what `picker-state.ts` needs to know about
 *  a row — that module never looks inside `PickerRow.id`, so this can be any
 *  stable key; `c.path` is used because it is already the caller's lookup
 *  key (`byPath` below). */
function toPickerRow(c: SessionCandidate): PickerRow {
	return { id: c.path, harness: c.harness, timestamp: c.timestamp };
}

export interface SelectSessionPromptOptions {
	/** Passed straight to `discoverSessions` on every rescope (Ctrl+A/W/B/T). */
	harnessOption: string;
	cwdOverride?: string;
	/** Where the picker draws. Defaults to stdout; `bin/wtft.ts` passes stderr
	 *  under `--json` so stdout stays one clean JSON document (#89, E1).
	 *  `bin/wtft.ts`'s `canShowPicker` guard (`process.stdin.isTTY &&
	 *  <this stream>.isTTY`) guarantees THIS stream is a TTY whenever this
	 *  function is called at all — it says nothing about the OTHER stream
	 *  (stdout under `--json`, or stderr otherwise), which can be a pipe. */
	out?: NodeJS.WritableStream;
	/**
	 * The `-s <substring>` the caller already filtered `initialCandidates` by
	 * (basename or path, case-insensitive), when there was one. Re-applied
	 * after every rescope's fresh `discoverSessions` call — WITHOUT this, a
	 * Ctrl+A/W/B/T press silently discarded the user's own narrowing and
	 * showed every session in the new scope instead of just the matches
	 * (pr-review, Medium). Also shown in the picker header in place of the
	 * scope/window line, since the row population here is `-s`-filtered on
	 * top of a scope, not the scope alone.
	 */
	substringFilter?: string;
}

/** The same substring predicate `bin/wtft.ts`'s fuzzy `-s` match uses — kept
 *  here too so a rescope re-applies it identically rather than drifting into
 *  a second, subtly different filter. */
function matchesSubstring(c: SessionCandidate, filter: string): boolean {
	const needle = filter.toLowerCase();
	return c.path.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle);
}

/**
 * Render the scoped, interactive session picker IN-PLACE on the main screen
 * (#89). Uses `\x1b[N A \x1b[J` to overwrite previous output on re-render — no
 * alt screen buffer. When the picker exits, the output is cleared and the
 * chart renders starting where the picker's first line was, preserving
 * scrollback above.
 *
 * Key handling is delegated ENTIRELY to the pure state machine in
 * `picker-state.ts` (CLAUDE.md "test key handling through a seam") — this
 * function's only job is turning a `PickerAction` into a terminal write or a
 * re-discovery call:
 *
 *   - j/k, arrows: move (wraps the whole list, sliding the 11-row window)
 *   - Enter: select — also records the sticky harness order (H3)
 *   - q or Ctrl+C: exit (code 130)
 *   - Ctrl+A / Tab: scope "all"  ·  Ctrl+W: scope "worktrees"
 *   - Ctrl+B: scope "branch" — falls back to `"worktree"` (population AND
 *     label) when the current branch or a matching checkout can't be
 *     resolved; see `SCOPE_LABEL`'s own comment above.
 *   - Ctrl+T: cycle the time window (20m -> 1h -> 1d -> 1w -> all -> 20m)
 *
 * Requires an interactive terminal — the caller (`bin/wtft.ts`) is
 * responsible for the no-TTY decision (E2-E4) and must never call this
 * function without one; `enterRawStdin` no-ops on a non-TTY stdin, which
 * would otherwise leave this promise pending forever.
 *
 * @param initialCandidates - The picker's starting rows. Nothing in THIS
 *   function inspects, validates, or threads through whatever scope the
 *   caller used to discover them — `bin/wtft.ts`'s default is
 *   `{ scope: "worktree", windowMs: TIME_WINDOW_MS["20m"] }` (S1/S5), but
 *   that is a convention the caller upholds, not a contract this function
 *   enforces; `initPickerState()`'s own `scope`/`timeWindow` fields (always
 *   `"worktree"`/`"20m"`) are independent of what produced `initialCandidates`
 *   and are only ever DISPLAYED as if they describe it.
 * @returns Promise resolving to the selected session file path
 */
export async function selectSessionPrompt(
	initialCandidates: SessionCandidate[],
	opts: SelectSessionPromptOptions
): Promise<string> {
	return new Promise((resolve) => {
		const out = opts.out ?? process.stdout;

		const byPath = new Map<string, SessionCandidate>();
		const remember = (list: SessionCandidate[]) => { for (const c of list) byPath.set(c.path, c); };
		remember(initialCandidates);

		const harnessIds = getHarnesses().map(h => h.id);
		const toRows = (list: SessionCandidate[]): PickerRow[] =>
			orderByHarness(list, readHarnessOrder(opts.cwdOverride), harnessIds).map(toPickerRow);

		let state: PickerState = setRows(initPickerState(), toRows(initialCandidates));

		// `initPickerState()` always reports `scope: "worktree", timeWindow:
		// "20m"` (picker-state.ts's own hardcoded default) — TRUE of a bare
		// launch, but FALSE of `initialCandidates` here whenever `-s` matched
		// several: those rows come from `bin/wtft.ts`'s LEGACY, unscoped
		// `getCandidates()` (fan-out, the union arm, unbounded time), not from
		// any real scope/window this state names (pr-review round 2, Medium).
		// So the header shows the scope/window line only once it has become
		// TRUE — after the first real rescope, which always re-discovers
		// through `discoverSessions(..., { scope, windowMs })` and so always
		// describes what is actually on screen from then on.
		let hasRescoped = !opts.substringFilter;

		hideCursor(out);

		let lastLineCount = 0;

		const render = () => {
			const view = visibleWindow(state);
			let text = `\x1b[1m\x1b[36m\u{1F4B8} WTFT — select session log\x1b[0m ` +
				`\x1b[90m(j/k navigate, Enter select, q quit · Ctrl+A all · Ctrl+W worktrees · ` +
				`Ctrl+B branch · Ctrl+T window)\x1b[0m\n`;
			if (opts.substringFilter && !hasRescoped) {
				text += `  \x1b[90mfiltered by -s "${opts.substringFilter}" (unscoped, no time window)\x1b[0m\n`;
			} else if (opts.substringFilter) {
				text += `  \x1b[90mscope: ${SCOPE_LABEL[state.scope]}  ·  window: ${state.timeWindow}  ·  filtered by -s "${opts.substringFilter}"\x1b[0m\n`;
			} else {
				text += `  \x1b[90mscope: ${SCOPE_LABEL[state.scope]}  ·  window: ${state.timeWindow}\x1b[0m\n`;
			}

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
					const stats = getSessionSummary(c.path);
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
				// The 12th row: a position line, never selectable (#89, K6).
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
				hasRescoped = true;
				// Ctrl+B's population falls back gracefully to "worktree"'s
				// (bare target directory) when the branch can't be resolved —
				// but the LABEL must say so too (pr-review round 2, Medium: the
				// first cut left `state.scope` as `"branch"` regardless, so the
				// picker's header kept reading "scope: this branch" over rows
				// that were, in fact, just the default worktree population,
				// with no indication anywhere that resolution had failed).
				// `applyKey` is pure and cannot know this in advance; this is
				// the one place with both git access and the state to correct.
				if (state.scope === "branch" && !resolveBranchCheckout(opts.cwdOverride ?? process.cwd())) {
					state = { ...state, scope: "worktree" };
				}
				// Re-discover for the new scope/window, THEN re-window the fresh
				// rows (setRows also clamps the cursor, #89 K7).
				let fresh = discoverSessions(opts.harnessOption, opts.cwdOverride, {
					scope: state.scope,
					windowMs: windowMsFor(state.timeWindow),
				});
				// Re-apply the caller's `-s` filter (pr-review, Medium): without
				// this, widening the scope silently discarded it and showed
				// every session in the new scope instead of just the matches.
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

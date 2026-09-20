/**
 * @package @princess-pi/wtft
 * @module picker-state
 * @description The scoped session picker's pure key-handling state machine (#89).
 *
 *   Rendering and discovery are BOTH kept out of this file on purpose (CLAUDE.md
 *   "Test key handling through a seam"). `applyKey` never touches the filesystem,
 *   the clock, or a terminal — it turns one key string into one action against
 *   one immutable `PickerState`. A `"rescope"` action means "the caller must
 *   re-discover sessions for the new scope/timeWindow and hand them back via
 *   `setRows`" — this module has no opinion on how that discovery happens or how
 *   long it takes.
 *
 *   Row windowing (12 rows: 11 data rows + one position line past that) is a
 *   pure function of `(rows.length, cursor, windowTop)` — see
 *   {@link visibleWindow}. `windowTop` itself is NOT reset the same way on
 *   every path: a cursor move slides it from wherever it already was (scroll
 *   hysteresis), while {@link setRows} always recomputes it from 0, so a
 *   rescope re-anchors the window at the cursor's position in the FRESH list
 *   rather than preserving the old scroll offset. `(rows.length, cursor)`
 *   alone is therefore not enough to predict the visible window — `windowTop`
 *   is a real third input, carried in `PickerState` itself.
 *
 *   Spec: docs/spec-89-scoped-picker.md, K1–K7.
 */

// ---

/** "worktree" is the default (#89): folder-name match on the current directory
 *  alone. "worktrees" widens to every checkout of the repo (Ctrl+W). "all"
 *  ignores cwd entirely (Ctrl+A / Tab). "branch" narrows to the checkout of the
 *  cwd's current git branch (Ctrl+B). See the discovery seam
 *  (extensions/lib/harness/types.ts) for what each scope costs. */
export type PickerScope = "worktree" | "worktrees" | "all" | "branch";

/** Cycles on Ctrl+T: 20m -> 1h -> 1d -> 1w -> all -> 20m. Every launch starts
 *  at "20m" (T1) — hardcoded in {@link initPickerState} below, in this same
 *  file. The one override is the `-s` picker, which `selectSessionPrompt` seeds
 *  `"all"` (spec-89 S5). */
export type TimeWindowLabel = "20m" | "1h" | "1d" | "1w" | "all";

export const TIME_WINDOW_CYCLE: readonly TimeWindowLabel[] = ["20m", "1h", "1d", "1w", "all"];

/** Milliseconds for every window EXCEPT "all", which has none — see {@link windowMsFor}. */
export const TIME_WINDOW_MS: Record<Exclude<TimeWindowLabel, "all">, number> = {
	"20m": 20 * 60_000,
	"1h": 60 * 60_000,
	"1d": 24 * 60 * 60_000,
	"1w": 7 * 24 * 60 * 60_000,
};

/** Milliseconds for a time window label, or `null` for "all" (unbounded —
 *  discovery applies no mtime filter at all). */
export function windowMsFor(label: TimeWindowLabel): number | null {
	return label === "all" ? null : TIME_WINDOW_MS[label];
}

/** Next label in the Ctrl+T cycle, wrapping from "all" back to "20m". */
export function nextTimeWindow(label: TimeWindowLabel): TimeWindowLabel {
	const idx = TIME_WINDOW_CYCLE.indexOf(label);
	return TIME_WINDOW_CYCLE[(idx + 1) % TIME_WINDOW_CYCLE.length];
}

// ---
// ROWS AND WINDOWING (K6, K7) — not E1: E1 is which STREAM the picker draws
// to (stdout vs stderr under --json), pure I/O the caller owns; nothing under
// this banner touches a stream, consistent with this whole module doing none.
// ---

/** One row the picker can select — an opaque id the caller maps back to a
 *  SessionCandidate. This module never looks inside `id`. */
export interface PickerRow {
	id: string;
	harness: string;
	timestamp: number;
}

/** 12 rows show at once: EXACTLY 12 as plain data rows when the list fits;
 *  past that, 11 data rows plus a 12th position line (see {@link visibleWindow}
 *  and K6's own note on the boundary). */
export const ROW_LIMIT = 12;
export const VISIBLE_DATA_ROWS = 11;

/** The picker's whole state: which scope/time-window is active, the current
 *  logical row list (already ordered by the caller — see `harness-order.ts`'s
 *  `orderByHarness`), and where the cursor/window sit within it. Immutable —
 *  every transition in this module returns a new value, never mutates one. */
export interface PickerState {
	readonly scope: PickerScope;
	readonly timeWindow: TimeWindowLabel;
	readonly rows: readonly PickerRow[];
	readonly cursor: number;
	readonly windowTop: number;
}

/** The initial state a fresh picker launch starts from — default scope,
 *  T1 ("20m"), cursor on the top row. */
export function initPickerState(rows: readonly PickerRow[] = []): PickerState {
	return { scope: "worktree", timeWindow: "20m", rows, cursor: 0, windowTop: 0 };
}

/**
 * Slide `windowTop` so `cursor` stays inside the visible 11-row band, without
 * assuming the cursor moved by exactly one row (a rescope can replace `rows`
 * wholesale and land the cursor anywhere in the new list).
 */
function computeWindowTop(cursor: number, total: number, prevWindowTop: number): number {
	if (total <= ROW_LIMIT) return 0;
	let top = prevWindowTop;
	if (cursor < top) top = cursor;
	if (cursor > top + VISIBLE_DATA_ROWS - 1) top = cursor - (VISIBLE_DATA_ROWS - 1);
	const maxTop = total - VISIBLE_DATA_ROWS;
	return Math.max(0, Math.min(top, maxTop));
}

/**
 * The caller's answer to a `"rescope"` action: replace the row list after
 * re-discovering for the new scope/timeWindow. ALWAYS resets the cursor to
 * the top row (0) rather than preserving its old index into a population
 * that no longer means the same thing (pr-review round 2, Low): a rescope
 * changes what the rows ARE, not just how many there are, so a cursor left
 * mid-list after Ctrl+A/W/B/T would point at a session the human never
 * looked at — a quick rescope-then-Enter would open it by accident. Row 1
 * on top after every rescope is also what "cursor on the top row" already
 * promises for the picker's initial state (`initPickerState`); this is the
 * same promise held on every subsequent rescope, not just the first. K7's
 * empty list is the same rule: the cursor is 0 for `[]` too.
 */
export function setRows(state: PickerState, rows: readonly PickerRow[]): PickerState {
	const cursor = 0;
	const windowTop = computeWindowTop(cursor, rows.length, 0);
	return { ...state, rows, cursor, windowTop };
}

export interface PickerView {
	/** The visible data rows: every row when `rows.length <= ROW_LIMIT`,
	 *  else an 11-row slice containing the cursor. */
	rows: readonly PickerRow[];
	/** `"<start>-<end> of <total>"`, 1-based inclusive, or null when every row
	 *  already fits in `ROW_LIMIT`. */
	positionLine: string | null;
	/** Index of the cursor row within the returned `rows` slice. */
	cursorIndexInView: number;
}

/** Pure function of `(rows.length, cursor, windowTop)` — safe to call on every
 *  render, never mutates state. */
export function visibleWindow(state: PickerState): PickerView {
	const total = state.rows.length;
	if (total <= ROW_LIMIT) {
		return { rows: state.rows, positionLine: null, cursorIndexInView: state.cursor };
	}
	const top = state.windowTop;
	const end = Math.min(top + VISIBLE_DATA_ROWS, total);
	return {
		rows: state.rows.slice(top, end),
		positionLine: `${top + 1}-${end} of ${total}`,
		cursorIndexInView: state.cursor - top,
	};
}

// ---

/** What one key press resolves to. `"move"`/`"noop"` carry the new/unchanged
 *  state directly; `"rescope"` carries a state whose `scope`/`timeWindow`
 *  changed and asks the caller to re-discover and call {@link setRows} (K7
 *  lives there, not here); `"select"` hands back the chosen row for the
 *  caller to resolve to a path; `"quit"` carries nothing. */
export type PickerAction =
	| { type: "move"; state: PickerState }
	| { type: "rescope"; state: PickerState }
	| { type: "select"; row: PickerRow }
	| { type: "quit" }
	| { type: "noop"; state: PickerState };

function moveCursor(state: PickerState, delta: 1 | -1): PickerAction {
	if (state.rows.length === 0) return { type: "noop", state };
	// K2: wraps the WHOLE logical list, not just the visible window.
	const cursor = (state.cursor + delta + state.rows.length) % state.rows.length;
	const windowTop = computeWindowTop(cursor, state.rows.length, state.windowTop);
	return { type: "move", state: { ...state, cursor, windowTop } };
}

function rescope(state: PickerState, patch: Partial<Pick<PickerState, "scope" | "timeWindow">>): PickerAction {
	// Cursor/windowTop are left as they are; the caller re-discovers and
	// calls setRows, which resets the cursor to the top row (K7).
	return { type: "rescope", state: { ...state, ...patch } };
}

/**
 * One key in, one action out. Pure: no I/O, no clock, no globals (K1).
 *
 * Recognized control keys, one raw-stdin byte sequence each (Node's raw mode
 * hands these back as single-character strings for Ctrl+<letter>):
 *   Ctrl+A "" / Tab "\t"  -> scope "all"        (K5)
 *   Ctrl+W ""             -> scope "worktrees"  (K5)
 *   Ctrl+B ""             -> scope "branch"     (K5)
 *   Ctrl+T ""             -> next time window   (K5)
 *   q / Q / Ctrl+C ""     -> quit                (K4)
 *   Enter "\r" / "\n"           -> select               (K3)
 *   j / ArrowDown "[B"    -> move down (wraps)  (K2)
 *   k / ArrowUp   "[A"    -> move up (wraps)    (K2)
 * Anything else is a no-op, state unchanged.
 */
export function applyKey(state: PickerState, key: string): PickerAction {
	if (key === "" || key === "q" || key === "Q") return { type: "quit" };

	if (key === "\r" || key === "\n") {
		if (state.rows.length === 0) return { type: "noop", state };
		return { type: "select", row: state.rows[state.cursor] };
	}

	if (key === "[B" || key === "j") return moveCursor(state, 1);
	if (key === "[A" || key === "k") return moveCursor(state, -1);

	if (key === "" || key === "\t") return rescope(state, { scope: "all" });
	if (key === "") return rescope(state, { scope: "worktrees" });
	if (key === "") return rescope(state, { scope: "branch" });
	if (key === "") return rescope(state, { timeWindow: nextTimeWindow(state.timeWindow) });

	return { type: "noop", state };
}

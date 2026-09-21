/** The scoped session picker's pure key-handling state machine. */

// ---

export type PickerScope = "worktree" | "worktrees" | "all" | "branch";

export type TimeWindowLabel = "20m" | "1h" | "1d" | "1w" | "all";

export const TIME_WINDOW_CYCLE: readonly TimeWindowLabel[] = ["20m", "1h", "1d", "1w", "all"];

export const TIME_WINDOW_MS: Record<Exclude<TimeWindowLabel, "all">, number> = {
	"20m": 20 * 60_000,
	"1h": 60 * 60_000,
	"1d": 24 * 60 * 60_000,
	"1w": 7 * 24 * 60 * 60_000,
};

export function windowMsFor(label: TimeWindowLabel): number | null {
	return label === "all" ? null : TIME_WINDOW_MS[label];
}

export function nextTimeWindow(label: TimeWindowLabel): TimeWindowLabel {
	const idx = TIME_WINDOW_CYCLE.indexOf(label);
	return TIME_WINDOW_CYCLE[(idx + 1) % TIME_WINDOW_CYCLE.length];
}

// ---
// ROWS AND WINDOWING (K6, K7) — not E1: E1 is which STREAM the picker draws
// to (stdout vs stderr under --json), pure I/O the caller owns; nothing under
// this banner touches a stream, consistent with this whole module doing none.
// ---

export interface PickerRow {
	id: string;
	harness: string;
	timestamp: number;
}

export const ROW_LIMIT = 12;
export const VISIBLE_DATA_ROWS = 11;

export interface PickerState {
	readonly scope: PickerScope;
	readonly timeWindow: TimeWindowLabel;
	readonly rows: readonly PickerRow[];
	readonly cursor: number;
	readonly windowTop: number;
}

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
 * ALWAYS resets the cursor to
 * the top row (0) rather than preserving its old index into a population
 * that no longer means the same thing.
 */
export function setRows(state: PickerState, rows: readonly PickerRow[]): PickerState {
	const cursor = 0;
	const windowTop = computeWindowTop(cursor, rows.length, 0);
	return { ...state, rows, cursor, windowTop };
}

export interface PickerView {
	rows: readonly PickerRow[];
	/** `"<start>-<end> of <total>"`, 1-based inclusive, or null when every row
	 *  already fits in `ROW_LIMIT`. */
	positionLine: string | null;
	cursorIndexInView: number;
}

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
	return { type: "rescope", state: { ...state, ...patch } };
}

/** One key in, one action out. Pure: no I/O, no clock, no globals (K1). */
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

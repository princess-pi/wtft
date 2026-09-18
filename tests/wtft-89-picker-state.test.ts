#!/usr/bin/env -S bun
/**
 * tests/wtft-89-picker-state.test.ts — the scoped picker's pure key-handling
 * state machine (#89, K1–K7). Spec: docs/spec-89-scoped-picker.md.
 *
 * Every assertion below feeds a key STRING into `applyKey` and reads the
 * returned action/state — no terminal, no discovery, no filesystem, no clock.
 * That is K1 itself: this suite is the proof the seam exists, not merely a
 * description of it.
 *
 * Run: bun tests/wtft-89-picker-state.test.ts
 */

import {
	initPickerState,
	setRows,
	visibleWindow,
	applyKey,
	nextTimeWindow,
	windowMsFor,
	TIME_WINDOW_CYCLE,
	TIME_WINDOW_MS,
	ROW_LIMIT,
	VISIBLE_DATA_ROWS,
	type PickerRow,
	type PickerState,
} from "../bin/wtft.mjs";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

function rows(n: number, harness: string = "claude-code"): PickerRow[] {
	return Array.from({ length: n }, (_, i) => ({ id: `s${i}`, harness, timestamp: 1000 - i }));
}

// ---
// K1 — purity: same input, same output, no side effects observable through
// repeated calls.
// ---
console.log("\n=== K1: purity ===\n");
{
	const state = setRows(initPickerState(), rows(3));
	const a = applyKey(state, "j");
	const b = applyKey(state, "j");
	check(JSON.stringify(a) === JSON.stringify(b), "K1: applyKey(state, key) is deterministic — same input, same output");
	check(state.cursor === 0, "K1: applyKey never mutates the state it was given");
}

// ---
// K2 — navigation wraps the WHOLE logical list.
// ---
console.log("\n=== K2: navigation wraps the whole list ===\n");
{
	let state = setRows(initPickerState(), rows(3));
	check(state.cursor === 0, "K2: starts on the top row");

	let a = applyKey(state, "j");
	check(a.type === "move" && a.state.cursor === 1, "K2: j/down moves forward");
	state = (a as any).state;

	a = applyKey(state, "[B"); // ArrowDown
	check(a.type === "move" && a.state.cursor === 2, "K2: ArrowDown also moves forward");
	state = (a as any).state;

	a = applyKey(state, "j");
	check(a.type === "move" && a.state.cursor === 0, "K2: moving past the last row wraps to the first");
	state = (a as any).state;

	a = applyKey(state, "k");
	check(a.type === "move" && a.state.cursor === 2, "K2: k/up from the top wraps to the last row");
}

// ---
// K3 — Enter selects the row under the cursor; no-op on an empty list.
// ---
console.log("\n=== K3: Enter selects ===\n");
{
	const state = setRows(initPickerState(), rows(3));
	const moved = applyKey(state, "j") as any;
	const selected = applyKey(moved.state, "\r");
	check(selected.type === "select" && selected.row.id === "s1", "K3: Enter selects the row the cursor is on");

	const empty = setRows(initPickerState(), []);
	const noop = applyKey(empty, "\r");
	check(noop.type === "noop", "K3: Enter on an empty list is a no-op");
}

// ---
// K4 — quit keys.
// ---
console.log("\n=== K4: quit ===\n");
{
	const state = setRows(initPickerState(), rows(3));
	check(applyKey(state, "q").type === "quit", "K4: q quits");
	check(applyKey(state, "Q").type === "quit", "K4: Q quits");
	check(applyKey(state, "").type === "quit", "K4: Ctrl+C quits");
}

// ---
// K5 — scope and time-window keys.
// ---
console.log("\n=== K5: scope and time-window keys ===\n");
{
	const state = setRows(initPickerState(), rows(3));
	check(state.scope === "worktree", "K5: initial scope is 'worktree'");
	check(state.timeWindow === "20m", "K5: initial time window is T1 ('20m')");

	let a = applyKey(state, ""); // Ctrl+A
	check(a.type === "rescope" && (a as any).state.scope === "all", "K5: Ctrl+A sets scope 'all'");

	a = applyKey(state, "\t"); // Tab — an alias for Ctrl+A
	check(a.type === "rescope" && (a as any).state.scope === "all", "K5: Tab is an alias for Ctrl+A");

	a = applyKey(state, ""); // Ctrl+W
	check(a.type === "rescope" && (a as any).state.scope === "worktrees", "K5: Ctrl+W sets scope 'worktrees'");

	a = applyKey(state, ""); // Ctrl+B
	check(a.type === "rescope" && (a as any).state.scope === "branch", "K5: Ctrl+B sets scope 'branch'");

	a = applyKey(state, ""); // Ctrl+T
	check(a.type === "rescope" && (a as any).state.timeWindow === "1h", "K5: Ctrl+T cycles the time window forward");

	// The full cycle, and its wrap.
	let label = state.timeWindow;
	for (let i = 0; i < TIME_WINDOW_CYCLE.length; i++) label = nextTimeWindow(label);
	check(label === state.timeWindow, "K5: cycling Ctrl+T through every label returns to the start");
	check(TIME_WINDOW_CYCLE.join(",") === "20m,1h,1d,1w,all", "K5: the cycle order is 20m -> 1h -> 1d -> 1w -> all");
	check(windowMsFor("all") === null, `K5: 'all' has no bound (${windowMsFor("all")})`);
	check(windowMsFor("20m") === TIME_WINDOW_MS["20m"], "K5: '20m' resolves to its millisecond constant");

	// A rescope does not itself touch cursor/windowTop — only setRows does.
	const moved = applyKey(state, "j") as any;
	const rescoped = applyKey(moved.state, "") as any;
	check(rescoped.state.cursor === moved.state.cursor,
		"K5: a rescope action leaves cursor untouched — the caller re-fetches and calls setRows");
}

// ---
// K6 — 12-row windowing is a pure function of (rows.length, cursor).
// ---
console.log("\n=== K6: 12-row windowing ===\n");
{
	// <= 12 rows: everything shows, no position line.
	for (const n of [0, 1, 11, 12]) {
		const state = setRows(initPickerState(), rows(n));
		const view = visibleWindow(state);
		check(view.rows.length === n, `K6: ${n} rows all fit (${view.rows.length} shown)`);
		check(view.positionLine === null, `K6: ${n} rows shows no position line`);
	}

	// 13 rows: the window is 11 rows plus a position line.
	let state = setRows(initPickerState(), rows(13));
	let view = visibleWindow(state);
	check(view.rows.length === VISIBLE_DATA_ROWS, `K6: past ${ROW_LIMIT}, exactly ${VISIBLE_DATA_ROWS} data rows show`);
	check(view.positionLine === "1-11 of 13", `K6: position line reads '1-11 of 13' (${view.positionLine})`);
	check(view.cursorIndexInView === 0, "K6: cursor starts inside the visible window");

	// 40 rows, matching the decision's own worked example ("12–22 of 40").
	state = setRows(initPickerState(), rows(40));
	for (let i = 0; i < 21; i++) state = (applyKey(state, "j") as any).state;
	view = visibleWindow(state);
	check(state.cursor === 21, `K6: cursor is at row 22 (index 21) after 21 downs (${state.cursor})`);
	check(view.positionLine === "12-22 of 40", `K6: window slides to '12-22 of 40' (${view.positionLine})`);
	check(view.cursorIndexInView === state.cursor - state.windowTop, "K6: cursorIndexInView matches cursor - windowTop");

	// The window always contains the cursor, arrow key by arrow key, across a
	// full lap — including the wrap from last back to first.
	state = setRows(initPickerState(), rows(40));
	for (let i = 0; i < 45; i++) {
		state = (applyKey(state, "j") as any).state;
		const v = visibleWindow(state);
		const top = state.windowTop;
		check(
			state.cursor >= top && state.cursor <= top + VISIBLE_DATA_ROWS - 1,
			`K6: step ${i}: cursor ${state.cursor} stays inside the window [${top}, ${top + VISIBLE_DATA_ROWS - 1}]`
		);
	}
	check(state.cursor === (45) % 40, `K6: wrapping past the end continues counting correctly (${state.cursor})`);
}

// ---
// K7 — cursor stays valid after setRows, including a shrinking rescope.
// ---
console.log("\n=== K7: cursor clamps after setRows ===\n");
{
	let state = setRows(initPickerState(), rows(40));
	for (let i = 0; i < 30; i++) state = (applyKey(state, "j") as any).state;
	check(state.cursor === 30, `K7: cursor advanced to 30 (${state.cursor})`);

	const shrunk = setRows(state, rows(5));
	check(shrunk.cursor === 4, `K7: a rescope to 5 rows clamps the cursor to the last row (${shrunk.cursor})`);
	check(visibleWindow(shrunk).positionLine === null, "K7: the shrunk list fits in one page again");

	const toEmpty = setRows(state, []);
	check(toEmpty.cursor === 0, "K7: a rescope to zero rows resets the cursor to 0, not a negative index");
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

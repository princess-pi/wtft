#!/usr/bin/env -S bun
import { repaint, eraseFrame, type RepaintFrame } from "../extensions/lib/watch-repaint.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

/** A minimal terminal: printable text, \r, \n, CSI A/B/J and SGR, with deferred wrap. */
class Term {
	rows: string[][] = [[]];
	r = 0;
	c = 0;
	pendingWrap = false;
	touched = new Set<number>();
	erased = false;
	constructor(readonly cols: number) {}
	private ensure(r: number) { while (this.rows.length <= r) this.rows.push([]); }
	feed(s: string) {
		for (let i = 0; i < s.length; i++) {
			const ch = s[i]!;
			if (ch === "\x1b" && s[i + 1] === "[") {
				const m = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(s.slice(i))!;
				const n = Number(m[1] || "1");
				if (m[2] === "A") { this.r = Math.max(0, this.r - n); this.pendingWrap = false; }
				else if (m[2] === "B") { this.r = Math.min(this.rows.length - 1, this.r + n); this.pendingWrap = false; }
				else if (m[2] === "J" && m[1] === "2") { this.erased = true; this.rows = this.rows.map(() => []); }
				else if (m[2] === "J") { this.erased = true; this.rows[this.r]!.length = this.c; this.rows.length = this.r + 1; }
				else if (m[2] === "H") { this.r = 0; this.c = 0; this.pendingWrap = false; }
				else if (m[2] === "K") { this.erased = true; this.rows[this.r]!.length = this.c; }
				i += m[0].length - 1;
				continue;
			}
			if (ch === "\r") { this.c = 0; this.pendingWrap = false; continue; }
			if (ch === "\n") { this.r++; this.ensure(this.r); this.pendingWrap = false; continue; }
			const wide = ch.codePointAt(0)! >= 0x2600 && ch.codePointAt(0)! <= 0x27bf;
			if (this.pendingWrap || (wide && this.c === this.cols - 1)) { this.r++; this.c = 0; this.ensure(this.r); this.pendingWrap = false; }
			this.rows[this.r]![this.c] = ch;
			this.touched.add(this.r);
			if (wide) { this.c++; this.rows[this.r]![this.c] = ""; }
			if (this.c === this.cols - 1) this.pendingWrap = true;
			else this.c++;
		}
	}
	screen(): string[] { return this.rows.map(r => Array.from(r, ch => ch ?? " ").join("").trimEnd()); }
	cells(row: number): number { return this.rows[row]?.length ?? 0; }
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
function step(term: Term, prev: RepaintFrame | null, lines: string[], termRows = 50) {
	term.touched.clear();
	term.erased = false;
	const { out, frame } = repaint(prev, lines, term.cols, termRows);
	term.feed(out);
	return { frame, out };
}
const screenIs = (term: Term, rows: string[]) =>
	JSON.stringify(term.screen().slice(0, rows.length)) === JSON.stringify(rows) && term.screen().slice(rows.length).every(r => r === "") && term.r === rows.length && term.c === 0;
const screenMatches = (term: Term, lines: string[]) => {
	const want = lines.map(l => strip(l).trimEnd());
	const got = term.screen().slice(0, want.length);
	return JSON.stringify(got) === JSON.stringify(want) && term.r === want.length && term.c === 0;
};

console.log("\nThe first frame is written in full, padded, with no erase");
const term = new Term(20);
const f1 = ["title", "\x1b[90m04:00\x1b[0m $1 ███", "03:00 $1 ██", "'q' to exit"];
let s = step(term, null, f1);
check(screenMatches(term, f1), `the screen is the frame, cursor on the line after it (${JSON.stringify(term.screen())})`);
check(!term.erased, "no erase sequence");
check(term.rows[0]!.length === 19 && term.rows[3]!.length === 19, `a plain line is padded to one cell short of the width (${term.rows[0]!.length}, ${term.rows[3]!.length})`);
check(term.rows[1]!.length === 17, `a line holding a non-ASCII character is padded to three cells short (${term.rows[1]!.length})`);

console.log("\nA refresh that changes one row writes only that row");
const f2 = ["title", "\x1b[90m04:00\x1b[0m $2 ████", "03:00 $1 ██", "'q' to exit"];
s = step(term, s.frame, f2);
check(screenMatches(term, f2), `the screen is the new frame (${JSON.stringify(term.screen())})`);
check(JSON.stringify([...term.touched]) === "[1]", `only row 1 is written (${JSON.stringify([...term.touched])})`);
check(!term.erased, "no erase sequence");

console.log("\nA shorter line fully covers the longer one it replaces");
const f3 = ["title", "04:00 $2 █", "03:00 $1 ██", "'q' to exit"];
s = step(term, s.frame, f3);
check(screenMatches(term, f3), `no trace of the old bar (${JSON.stringify(term.screen())})`);

console.log("\nAn unchanged frame writes nothing");
s = step(term, s.frame, f3);
check(term.touched.size === 0 && s.out === "", `nothing is written (${JSON.stringify(s.out)})`);

console.log("\nA new row grows the frame");
const f4 = ["title", "05:00 $3 ███", "04:00 $2 █", "03:00 $1 ██", "'q' to exit"];
s = step(term, s.frame, f4);
check(screenMatches(term, f4), `the screen is the grown frame (${JSON.stringify(term.screen())})`);
check(!term.touched.has(0), "the unchanged title is not written");
check(!term.erased, "no erase sequence");

console.log("\nA shorter frame blanks the rows below it with spaces");
const f5 = ["title", "'q' to exit"];
s = step(term, s.frame, f5);
check(screenMatches(term, f5), `the screen is the shorter frame (${JSON.stringify(term.screen())})`);
check(term.screen().slice(2).every(r => r === ""), "the rows it left are blank");
check(!term.erased, "no erase sequence");

console.log("\nA line wider than the terminal fills every row it wraps onto");
const wide = ["title", "x".repeat(25), "'q' to exit"];
const t2 = new Term(20);
let w = step(t2, null, wide);
const w2 = ["title", "y".repeat(5), "'q' to exit"];
w = step(t2, w.frame, w2);
check(screenMatches(t2, w2) && t2.screen()[3] === "", `the wrapped rows are covered (${JSON.stringify(t2.screen())})`);
check(!t2.erased, "no erase sequence");

console.log("\nA line as wide as the terminal, replaced by a shorter one, leaves nothing in the last column");
{
	const t6 = new Term(20);
	const full = step(t6, null, ["title", "-".repeat(20), "q"]);
	check(t6.screen()[1] === "-".repeat(20) && screenMatches(t6, ["title", "-".repeat(20), "q"]), `fixture precondition: the full-width line fills the row (${JSON.stringify(t6.screen())})`);
	step(t6, full.frame, ["title", "short", "q"]);
	check(screenMatches(t6, ["title", "short", "q"]) && !t6.erased, `the last column is covered without an erase (${JSON.stringify(t6.screen())})`);
}

console.log("\nA full-width line rewritten as another full-width line stays on its row");
{
	const t7 = new Term(20);
	const a = step(t7, null, ["title", "-".repeat(20), "row below", "q"]);
	const b = step(t7, a.frame, ["title", "=".repeat(20), "row below", "q"]);
	check(screenMatches(t7, ["title", "=".repeat(20), "row below", "q"]), `the row below is untouched and the cursor ends after the frame (${JSON.stringify(t7.screen())}, cursor ${t7.r},${t7.c})`);
	step(t7, b.frame, ["title", "=".repeat(20), "row below!", "q"]);
	check(screenMatches(t7, ["title", "=".repeat(20), "row below!", "q"]), "and the next refresh still lands on the right row");
}

console.log("\nLeaving a frame with a wrapped non-ASCII line redraws from the top");
{
	const t8 = new Term(20);
	const a = step(t8, null, ["title", "☀".repeat(25), "q"]);
	check(screenIs(t8, ["title", "☀".repeat(10), "☀".repeat(10), "☀".repeat(5), "q"]), `fixture precondition: the wrapped line is on screen (${JSON.stringify(t8.screen())})`);
	const b = step(t8, a.frame, ["title", "short", "q"]);
	check(t8.erased && /\x1b\[2?J/.test(b.out) && screenIs(t8, ["title", "short", "q"]), `the refresh after it erases and redraws (${JSON.stringify(t8.screen())})`);
}

console.log("\nA line holding a non-ASCII character keeps two more cells of slack, and a later line covers what it reached");
{
	const t9 = new Term(20);
	const a = step(t9, null, ["☀ title", "x".repeat(19), "q"]);
	check(t9.cells(0) === 17, `the emoji line is padded to three cells short (${t9.cells(0)} cells)`);
	step(t9, a.frame, ["☀ title", "short", "q"]);
	check(screenMatches(t9, ["☀ title", "short", "q"]) && !t9.erased, `a shorter line over a longer one leaves nothing behind (${JSON.stringify(t9.screen())})`);
	const t10 = new Term(20);
	const c = step(t10, null, ["x".repeat(19), "q"]);
	step(t10, c.frame, ["☀ ok", "q"]);
	check(screenMatches(t10, ["☀ ok", "q"]), `an emoji line written over a longer row pads as far as that row reached (${JSON.stringify(t10.screen())})`);
}

console.log("\nExit erases the frame from its top, or clears the screen after a wrapped non-ASCII line");
{
	const t11 = new Term(20);
	t11.feed("above\r\n");
	const a = step(t11, null, ["title", "row", "q"]);
	t11.feed(eraseFrame(a.frame));
	check(t11.screen()[0] === "above" && t11.r === 1 && t11.screen().slice(1).every(r => r === ""), `the frame is erased and the text above it is kept (${JSON.stringify(t11.screen())})`);
	check(eraseFrame({ ...a.frame, wideWrap: true }) === "\x1b[H\x1b[2J", "after a wrapped non-ASCII line exit clears the screen");
}

console.log("\nFallbacks: a width change or a frame taller than the terminal redraw from the top");
{
	const t3 = new Term(20);
	const a = step(t3, null, f1);
	const t4 = new Term(30);
	t4.feed("junk above\r\n");
	const resized = repaint(a.frame, f2, 30, 50);
	t4.feed(resized.out);
	check(t4.erased && JSON.stringify(t4.screen().slice(0, 4)) === JSON.stringify(f2.map(l => strip(l))) && t4.r === 4 && t4.c === 0,
		`a width change clears the screen and writes the frame from the top (${JSON.stringify(t4.screen())})`);
	const tall = step(t3, a.frame, f2, 4);
	check(t3.erased && screenMatches(t3, f2), `a frame that does not fit the terminal's rows erases and redraws (${JSON.stringify(t3.screen())})`);

	const t5 = new Term(20);
	const b = step(t5, null, ["title", "☀".repeat(25), "q"]);
	const after = step(t5, b.frame, ["title", "☀".repeat(24), "q"]);
	check(t5.erased && /\x1b\[2?J/.test(after.out) && screenIs(t5, ["title", "☀".repeat(10), "☀".repeat(10), "☀".repeat(4), "q"]), `a wrapped line holding a non-ASCII character erases and redraws (${JSON.stringify(t5.screen())})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

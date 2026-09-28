/**
 * WatchRepaint: the bytes that turn the `--watch` frame on screen into the next one.
 * docs/spec-364-watch-repaint.md.
 */

import { getVisualLength } from "./wtft-renderer.js";

/** What the last repaint left on screen. The cursor is at column 0 of row `total`. */
export interface RepaintFrame {
	lines: string[];
	/** The screen row each line starts on. */
	tops: number[];
	/** Rows the frame covers. */
	total: number;
	cols: number;
	/** Rows whose last column holds text: a line as wide as the terminal, and every row of a wrapped line but its last. */
	fullRows: Set<number>;
}

const ANSI = /\x1b\[[0-9;]*[a-zA-Z]/g;

function layout(lines: string[], cols: number) {
	const padded: string[] = [];
	const tops: number[] = [];
	const heights: number[] = [];
	let wideWrap = false;
	const fullRows = new Set<number>();
	let row = 0;
	for (const line of lines) {
		const width = getVisualLength(line);
		const height = Math.max(1, Math.ceil(width / cols));
		const reachesLast = width > 0 && width % cols === 0;
		if (height > 1 && /[^\x00-\x7f]/.test(line.replace(ANSI, ""))) wideWrap = true;
		// Padding stops short of the last column, so a line whose width is misjudged by one cell cannot wrap.
		padded.push(line + " ".repeat(reachesLast ? 0 : height * cols - 1 - width));
		tops.push(row);
		heights.push(height);
		for (let r = row; r < row + height - (reachesLast ? 0 : 1); r++) fullRows.add(r);
		row += height;
	}
	return { padded, tops, heights, total: row, wideWrap, fullRows };
}

/** Rows `lines` take at `cols` columns, as `repaint` lays them out. */
export function frameRows(lines: string[], cols: number): number {
	return layout(lines, cols).total;
}

/**
 * Takes the last frame (null before the first), the next frame's lines, and the terminal's
 * columns and rows. Returns the bytes to write and the frame they leave. Only lines whose text or
 * row changed are written, each padded with spaces to one cell short of whole rows (through the last
 * cell over a row whose last column holds text), and rows a shorter frame leaves are written with spaces. A width change clears the screen and writes the
 * frame from the top; a frame that does not fit above the cursor's row, or a wrapped line holding
 * a non-ASCII character, erases from the old frame's top and writes every line.
 */
export function repaint(prev: RepaintFrame | null, lines: string[], cols: number, termRows: number): { out: string; frame: RepaintFrame } {
	const next = layout(lines, cols);
	const frame: RepaintFrame = { lines: [...lines], tops: next.tops, total: next.total, cols, fullRows: next.fullRows };
	const body = `${next.padded.join("\r\n")}\r\n`;
	if (prev && prev.cols !== cols) return { out: `\x1b[H\x1b[2J${body}`, frame };
	const fits = next.total < termRows && (!prev || prev.total < termRows);
	if (prev && (!fits || next.wideWrap)) {
		const up = prev.total > 0 ? `\x1b[${prev.total}A` : "";
		return { out: `${up}\r\x1b[J${body}`, frame };
	}

	const prevTotal = prev?.total ?? 0;
	let cur = prevTotal;
	let bottom = prevTotal;
	let out = "";
	const moveTo = (row: number) => {
		if (row < cur) out += `\x1b[${cur - row}A`;
		else if (row > cur) {
			const within = Math.min(row, bottom) - cur;
			if (within > 0) out += `\x1b[${within}B`;
			out += "\n".repeat(Math.max(0, row - Math.max(cur, bottom)));
		}
		out += "\r";
		cur = row;
		bottom = Math.max(bottom, row);
	};
	const write = (row: number, text: string, height: number) => {
		moveTo(row);
		out += text;
		cur = row + height - 1;
		bottom = Math.max(bottom, cur);
	};

	for (let i = 0; i < lines.length; i++) {
		const same = prev && prev.lines[i] === lines[i] && prev.tops[i] === next.tops[i];
		if (same) continue;
		const lastRow = next.tops[i]! + next.heights[i]! - 1;
		write(next.tops[i]!, next.padded[i]! + (prev?.fullRows.has(lastRow) ? " " : ""), next.heights[i]!);
	}
	for (let row = next.total; row < prevTotal; row++) write(row, " ".repeat(prev?.fullRows.has(row) ? cols : cols - 1), 1);
	if (out === "") return { out, frame };
	moveTo(next.total);
	return { out, frame };
}

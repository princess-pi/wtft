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
	/** How many cells from the left each row's text and padding reach. */
	extents: number[];
	/** A wrapped line holds a non-ASCII character, so `tops` and `total` may not match the screen. */
	wideWrap: boolean;
}

const ANSI = /\x1b\[[0-9;]*[a-zA-Z]/g;

function layout(lines: string[], cols: number) {
	const padded: string[] = [];
	const tops: number[] = [];
	const heights: number[] = [];
	const extents: number[] = [];
	let wideWrap = false;
	let row = 0;
	for (const line of lines) {
		const width = getVisualLength(line);
		const nonAscii = /[^\x00-\x7f]/.test(line.replace(ANSI, ""));
		const height = Math.max(1, Math.ceil(width / cols));
		if (height > 1 && nonAscii) wideWrap = true;
		const last = width - (height - 1) * cols;
		const reach = Math.max(last, cols - (nonAscii ? 3 : 1));
		padded.push(line + " ".repeat(reach - last));
		tops.push(row);
		heights.push(height);
		for (let r = 0; r < height - 1; r++) extents.push(cols);
		extents.push(reach);
		row += height;
	}
	return { padded, tops, heights, extents, total: row, wideWrap };
}

/** Rows `lines` take at `cols` columns, as `repaint` lays them out. */
export function frameRows(lines: string[], cols: number): number {
	return layout(lines, cols).total;
}

/** The bytes that erase `frame` from the screen, leaving the cursor where its top was. */
export function eraseFrame(frame: RepaintFrame | null): string {
	if (!frame) return "";
	if (frame.wideWrap) return "\x1b[H\x1b[2J";
	return `${frame.total > 0 ? `\x1b[${frame.total}A` : ""}\r\x1b[J`;
}

/**
 * Takes the last frame (null before the first), the next frame's lines, and the terminal's
 * columns and rows. Returns the bytes to write and the frame they leave. Only lines whose text or
 * row changed are written, each padded with spaces to one cell short of the width (three for a
 * line holding a non-ASCII character) and at least as far as the text it replaces reached; rows a
 * shorter frame leaves are written with spaces. A width change clears the screen and writes the
 * frame from the top; a frame that does not fit above the cursor's row, or a wrapped line holding
 * a non-ASCII character in either frame, erases from the old frame's top and writes every line.
 */
export function repaint(prev: RepaintFrame | null, lines: string[], cols: number, termRows: number): { out: string; frame: RepaintFrame } {
	const next = layout(lines, cols);
	const frame: RepaintFrame = { lines: [...lines], tops: next.tops, total: next.total, cols, extents: next.extents, wideWrap: next.wideWrap };
	const body = `${next.padded.join("\r\n")}\r\n`;
	if (prev && prev.cols !== cols) return { out: `\x1b[H\x1b[2J${body}`, frame };
	const fits = next.total < termRows && (!prev || prev.total < termRows);
	if (prev && (!fits || next.wideWrap || prev.wideWrap)) return { out: `${eraseFrame(prev)}${body}`, frame };

	const prevTotal = prev?.total ?? 0;
	const before = (row: number) => prev?.extents[row] ?? 0;
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
		if (prev && prev.lines[i] === lines[i] && prev.tops[i] === next.tops[i]) {
			for (let r = next.tops[i]!; r < next.tops[i]! + next.heights[i]!; r++) frame.extents[r] = Math.max(frame.extents[r]!, before(r));
			continue;
		}
		const lastRow = next.tops[i]! + next.heights[i]! - 1;
		const cover = Math.max(0, before(lastRow) - next.extents[lastRow]!);
		frame.extents[lastRow] = next.extents[lastRow]! + cover;
		write(next.tops[i]!, next.padded[i]! + " ".repeat(cover), next.heights[i]!);
	}
	for (let row = next.total; row < prevTotal; row++) write(row, " ".repeat(before(row)), 1);
	if (out === "") return { out, frame };
	moveTo(next.total);
	return { out, frame };
}

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
}

function layout(lines: string[], cols: number): { padded: string[]; tops: number[]; heights: number[]; total: number } {
	const padded: string[] = [];
	const tops: number[] = [];
	const heights: number[] = [];
	let row = 0;
	for (const line of lines) {
		const width = getVisualLength(line);
		const height = Math.max(1, Math.ceil(width / cols));
		padded.push(line + " ".repeat(height * cols - width));
		tops.push(row);
		heights.push(height);
		row += height;
	}
	return { padded, tops, heights, total: row };
}

/**
 * Takes the last frame (null before the first), the next frame's lines, and the terminal's
 * columns and rows. Returns the bytes to write and the frame they leave. Only lines whose text or
 * row changed are written, each padded to whole rows, and rows a shorter frame leaves are written
 * with spaces. A width change, or a frame that does not fit above the cursor's row, erases from
 * the old frame's top and writes every line.
 */
export function repaint(prev: RepaintFrame | null, lines: string[], cols: number, termRows: number): { out: string; frame: RepaintFrame } {
	const next = layout(lines, cols);
	const frame: RepaintFrame = { lines: [...lines], tops: next.tops, total: next.total, cols };
	const fits = next.total < termRows && (!prev || prev.total < termRows);
	if (prev && (prev.cols !== cols || !fits)) {
		const up = prev.total > 0 ? `\x1b[${prev.total}A` : "";
		return { out: `${up}\r\x1b[J${next.padded.join("\n")}\n`, frame };
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
		if (!same) write(next.tops[i]!, next.padded[i]!, next.heights[i]!);
	}
	for (let row = next.total; row < prevTotal; row++) write(row, " ".repeat(cols), 1);
	if (out === "") return { out, frame };
	moveTo(next.total);
	return { out, frame };
}

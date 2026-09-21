/**
 * Shared TTY helpers: raw stdin, cursor show/hide, in-place overwrite,
 * visual line count. Caller sequences cursor visibility — selector and
 * watch mode differ.
 */

// ---

/** Enter raw stdin mode and register a key handler. */
export function enterRawStdin(onKey: (key: string) => void): () => void {
	const stdin = process.stdin;
	if (!stdin.isTTY) return () => {};

	stdin.resume();
	stdin.setEncoding("utf8");
	stdin.setRawMode(true);

	const handler = (data: Buffer) => onKey(data.toString());
	stdin.on("data", handler);

	return () => {
		stdin.removeListener("data", handler);
		stdin.setRawMode(false);
		stdin.pause();
	};
}

// ---

/** Show the terminal cursor (DECTCEM reset).
 *  @param out where to write — stdout by default; the scoped picker
 *    passes stderr under `--json`, so stdout stays a clean JSON document. */
export function showCursor(out: NodeJS.WritableStream = process.stdout): void {
	out.write("\x1b[?25h");
}

export function hideCursor(out: NodeJS.WritableStream = process.stdout): void {
	out.write("\x1b[?25l");
}

// ---

/**
 * Move the cursor up `lineCount` visual (wrapped) lines, then clear from cursor to
 * end of screen. Used before re-rendering to overwrite the previous render in-place.
 * A no-op, writing nothing, when `lineCount <= 0` (nothing rendered yet).
 */
export function clearPreviousLines(lineCount: number, out: NodeJS.WritableStream = process.stdout): void {
	if (lineCount > 0) {
		out.write(`\x1b[${lineCount}A\x1b[J`);
	}
}

// ---

/**
 * Count how many visual (wrapped) lines the given text occupies at `termWidth`.
 * ANSI escape codes are stripped before measuring. Empty lines count as 1.
 */
export function visualLineCount(text: string, termWidth: number): number {
	const ansiRe = /\x1b\[[0-9;]*[a-zA-Z]/g;
	const lines = text.replace(/\n$/, "").split("\n");
	let count = 0;
	for (const line of lines) {
		const cleanLen = line.replace(ansiRe, "").length;
		count += cleanLen === 0 ? 1 : Math.ceil(cleanLen / Math.max(termWidth, 1));
	}
	return count;
}

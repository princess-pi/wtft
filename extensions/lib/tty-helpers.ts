/**
 * @package princess-pi-tools
 * @module tty-helpers
 * @description Shared TTY terminal helpers extracted from session-selector and wtft-shared (#58 DRY).
 *
 * Five patterns were duplicated across selector and watch mode (the fifth
 * added since; "four" was the original count and is a stale claim once
 * {@link showCursor}/{@link hideCursor} are counted):
 *   1. Raw stdin init (resume → setEncoding → setRawMode → listen)
 *   2. Raw stdin cleanup (removeListener → setRawMode(false) → pause)
 *   3. In-place overwrite (move cursor up visual lines → clear to end of screen)
 *   4. Visual line count (count wrapped lines for terminal-width-aware cursor math)
 *   5. Cursor visibility (show/hide) — {@link enterRawStdin}'s own doc still
 *      calls this the CALLER's concern to sequence, since cursor lifecycle
 *      differs between the selector and watch mode; this module is where that
 *      sequencing is actually implemented FROM, not where it happens
 *      automatically.
 *
 * These are cross-harness: consumed by both the WTFT CLI (via esbuild bundle) and
 * the Pi WTFT extension (via tsx import).
 */

// ---
// RAW STDIN HELPERS
// ---

/**
 * Enter raw stdin mode and register a key handler.
 * Performs: resume() → setEncoding("utf8") → setRawMode(true) → on("data", handler)
 *
 * Returns a cleanup function that reverses: removeListener → setRawMode(false) → pause().
 * Caller is responsible for cursor visibility (show/hide) separately, since cursor
 * lifecycle differs between selector (hide on enter, show on exit) and watch mode
 * (managed by alt screen buffer transitions).
 *
 * @param onKey - Callback receiving the raw key string (e.g. "\r", "\x1b[A", "q", "\u0003")
 * @returns Cleanup function to restore stdin (no-op if stdin is not a TTY)
 */
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
// CURSOR HELPERS
// ---

/** Show the terminal cursor (DECTCEM reset).
 *  @param out where to write — stdout by default; the scoped picker (#89)
 *    passes stderr under `--json`, so stdout stays a clean JSON document
 *    (E1). For the picker, `bin/wtft.ts`'s `canShowPicker` guard makes `out`
 *    a TTY (watch mode calls these with plain stdout); it says nothing about the OTHER
 *    stream (stdout, when `out` is stderr, or vice versa) — that one can be
 *    a pipe, same as any ordinary redirect. */
export function showCursor(out: NodeJS.WritableStream = process.stdout): void {
	out.write("\x1b[?25h");
}

/** Hide the terminal cursor (DECTCEM set). See {@link showCursor}'s `out`. */
export function hideCursor(out: NodeJS.WritableStream = process.stdout): void {
	out.write("\x1b[?25l");
}

// ---
// IN-PLACE OVERWRITE
// ---

/**
 * Move the cursor up `lineCount` visual (wrapped) lines, then clear from cursor to
 * end of screen. Used before re-rendering to overwrite the previous render in-place.
 * A no-op, writing nothing, when `lineCount <= 0` (nothing rendered yet).
 *
 * @param lineCount - Number of visual (wrapped) lines to move up
 * @param out where to write — see {@link showCursor}'s `out`.
 */
export function clearPreviousLines(lineCount: number, out: NodeJS.WritableStream = process.stdout): void {
	if (lineCount > 0) {
		out.write(`\x1b[${lineCount}A\x1b[J`);
	}
}

// ---
// VISUAL LINE COUNT
// ---

/**
 * Count how many visual (wrapped) lines the given text occupies at `termWidth`.
 * ANSI escape codes are stripped before measuring. Empty lines count as 1.
 *
 * @param text - The text to measure (may contain ANSI escape codes)
 * @param termWidth - Terminal width in columns
 * @returns Number of visual lines the text occupies
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

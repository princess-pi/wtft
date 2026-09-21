/**
 * A suite that gates on host state and finds none reports PASS.
 */

/** The stable token. Grep for this, never for the prose after it. */
export const SKIP_MARKER = "##SKIP##";

/**
 * Declare that a check did not run, and why.
 *
 * The reason should name the missing host state, not the check — "no
 * ~/.claude/settings.json on this machine" tells a reader on CI what to install
 * to get the coverage back. "skipping" tells them nothing.
 */
export function skip(reason: string): void {
	console.log(`${SKIP_MARKER} ${reason}`);
}

/**
 * Every skip reason in a suite's combined stdout+stderr, in order.
 *
 * Tolerates leading indentation and ANSI colour because suites print however
 * they like; matches on the token alone.
 */
export function collectSkips(output: string): string[] {
	const out: string[] = [];
	for (const raw of output.split("\n")) {
		// Strip colour first, then require the marker at the START of the line.
		// Matching it anywhere counted the literals echoed back inside a FAILING
		// suite's assertion diff — tests/skip-reporting.test.ts asserts on the token
		// itself, so its own failure output was read as four skips.
		// eslint-disable-next-line no-control-regex
		const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
		if (!line.startsWith(SKIP_MARKER)) continue;
		const reason = line.slice(SKIP_MARKER.length).trim();
		if (reason) out.push(reason);
	}
	return out;
}

/**
 * The runner's end-of-run section. Empty string when nothing was skipped, so
 * the caller can print it unconditionally.
 */
export function renderSkipSummary(
	entries: Array<{ suite: string; reasons: string[] }>,
	colors: { dim?: string; bold?: string; reset?: string } = {},
): string {
	const withSkips = entries.filter(e => e.reasons.length > 0);
	if (withSkips.length === 0) return "";

	const dim = colors.dim ?? "";
	const bold = colors.bold ?? "";
	const reset = colors.reset ?? "";
	const total = withSkips.reduce((n, e) => n + e.reasons.length, 0);

	const lines = [
		`${bold}${total} check${total === 1 ? "" : "s"} skipped${reset} ${dim}in ${withSkips.length} suite${withSkips.length === 1 ? "" : "s"} — host state absent, not verified${reset}`,
	];
	for (const e of withSkips) {
		for (const r of e.reasons) lines.push(`  ${dim}${e.suite}:${reset} ${r}`);
	}
	return lines.join("\n");
}

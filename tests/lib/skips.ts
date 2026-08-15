/**
 * @package princess-pi-packages
 * @tool tests/lib/skips.ts — the skip contract shared by every suite and the runner
 * @description A suite that gates on host state and finds none reports PASS. It
 *   checked nothing, and nothing in the output says so once the suite's own
 *   `console.log` scrolls past. On CI that is not an edge case — CI has no
 *   `~/.claude`, no dotfiles-doctor clone, and no status-line logs, so EVERY
 *   host-gated suite goes green while running none of its checks (#256, and the
 *   reason #228 cannot just turn CI on and trust the badge).
 *
 *   `tests/run.ts` already says it, about shell suites: "a skipped suite you
 *   cannot see is a coverage claim you cannot check." This is the same rule one
 *   level down, at the level of individual checks.
 *
 *   The contract is one line of output per skipped check:
 *
 *       ##SKIP## <reason>
 *
 *   Flat, one record per line, a stable prefix token no prose rewording can
 *   break — the machine-readable mode our own Agent-First Output standard
 *   requires. The runner greps for it and reports the total; nothing parses the
 *   reason, so reasons stay free to be written for humans.
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
	for (const line of output.split("\n")) {
		const at = line.indexOf(SKIP_MARKER);
		if (at === -1) continue;
		const reason = line
			.slice(at + SKIP_MARKER.length)
			// eslint-disable-next-line no-control-regex
			.replace(/\x1b\[[0-9;]*m/g, "")
			.trim();
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

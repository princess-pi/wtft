/**
 * @package princess-pi-packages
 * @tool tests/lib/poll.ts — wait on a condition, never on a duration (#387)
 * @description A fixed `sleep(n)` before checking daemon/process state is a bet
 *   on scheduling, not an assertion about behaviour: it passes by luck on a
 *   quiet host and flakes on a loaded one — proven in `wtft-issue-155-daemon-
 *   follow` (four bare sleeps, zero polling) and `wtft-308-lagging-session`
 *   (already polled, but with a few ceilings tight enough to time out under the
 *   full `bun run test` driver while passing standalone).
 *
 *   `pollUntil` retries a synchronous predicate on a short interval up to a
 *   generous ceiling, so a slow host fails *late* rather than *falsely*. It
 *   returns the predicate's own final value — re-checked once more after the
 *   ceiling elapses, not just "did we ever see true" — so a caller reporting
 *   failure detail from the same state the predicate just examined sees the
 *   REAL last state, not a stale snapshot from one interval earlier.
 *
 *   `wtft-308-lagging-session` defined this locally first (#308/#309); moved
 *   here per #387 so `wtft-issue-155-daemon-follow` gets the same primitive
 *   instead of growing a second copy.
 */

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/**
 * Poll `pred` every `stepMs` until it returns true or `ceilingMs` elapses.
 * Never throws and never asserts — the caller decides what a `false` return
 * means and what detail to report about it.
 *
 * A `pred` that throws (e.g. `fs.readFileSync` racing a file that hasn't been
 * created yet) is treated as "not satisfied yet", not as a poll failure — the
 * transient state a predicate is polling FOR is often exactly the state that
 * makes it throw, and a caller that already writes `try { ... } catch { return
 * false; }` inside its own predicate must not be second-guessed by a stricter
 * contract here.
 *
 * Swallowed, but not hidden. "Condition not met yet" and "the predicate itself
 * is broken" (a typo, an undefined access) both surface as a plain timeout,
 * which makes a real bug read as a slow host. So a throw on the FINAL attempt
 * is written to stderr before returning false. Only the final attempt: an
 * exception during the transient window is the expected case and would be pure
 * noise on every run. This needs no cooperation from callers — no out-param, no
 * shared error slot — which is why it is worth doing rather than deferring.
 */
export async function pollUntil(pred: () => boolean, ceilingMs: number, stepMs = 100): Promise<boolean> {
	// Reset on every attempt so this holds the most recent attempt's outcome, not
	// a stale throw from some earlier interval that has since resolved.
	let lastError: unknown;
	const tryPred = (): boolean => {
		try { lastError = undefined; return pred(); } catch (err) { lastError = err; return false; }
	};
	const start = Date.now();
	while (Date.now() - start < ceilingMs) {
		if (tryPred()) return true;
		await sleep(stepMs);
	}
	const settled = tryPred();
	if (!settled && lastError !== undefined) {
		const msg = lastError instanceof Error ? lastError.message : String(lastError);
		console.error(`pollUntil: predicate threw on its final attempt after ${ceilingMs}ms (${msg}) — the timeout below may be a predicate bug, not an unmet condition (#387)`);
	}
	return settled;
}

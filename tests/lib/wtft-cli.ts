/**
 * @package princess-pi-tools
 * @module tests/lib/wtft-cli
 * @description Run the `wtft` CLI from a test and get its stdout, treating a
 *   PROVISIONAL read as success (#513).
 *
 *   WHY THIS EXISTS. #443 gave `wtft` exit **9**: the run SUCCEEDED, and the
 *   number printed may still grow because the daemon has not yet swept this
 *   session's subagent transcripts. Everything renders; only the freshness claim
 *   differs. `execSync` and `execFileSync` throw on ANY nonzero exit, so three
 *   suites that shell out to the CLI began failing on a correct run.
 *
 *   Intermittently, which is the part worth remembering. The CLI spawns the
 *   daemon and reads the tag immediately; on a brand-new session it sometimes
 *   wins that race and sees no `_meta.swept` marker. Standalone, those suites
 *   passed 4 of 4; under `bun run test` on a loaded box, one failed. So it
 *   passed the branch, passed CI, and surfaced only after merge.
 *
 *   ONE helper rather than three try/catches, because the rule is a contract
 *   ("0 and 9 both mean the render happened") and three hand-rolled copies drift
 *   — the same argument that keeps tag appends behind one failure helper.
 *
 *   It deliberately does NOT swallow other codes: exit 1 is still a failure and
 *   still throws, so this cannot quietly hide a broken CLI.
 */

import { execSync, type ExecSyncOptions } from "node:child_process";

/** The run succeeded but the total may still grow (#443). */
export const WTFT_EXIT_PROVISIONAL = 9;

/**
 * Run a `wtft` command and return its stdout.
 *
 * Exit 0 and exit 9 both return normally. Any other nonzero code rethrows the
 * original error, with the captured output attached where the caller can see it.
 *
 * `encoding` and `stdio` are NOT caller options — the signature says so, and the
 * body strips them anyway. Both restrictions came from review, one round apart,
 * and the second is the reason the first was not enough:
 *
 *   `encoding` — a first cut spread `options` AFTER `encoding: "utf8"`, so
 *     `{ encoding: "buffer" }` silently won and an `as unknown as string` cast
 *     handed back a Buffer typed as a string; the caller's next `.split()` or
 *     regex would throw or quietly misbehave. The two paths also disagreed for
 *     the same input, since the catch path coerced with `String()`.
 *
 *   `stdio` — fixing `encoding` alone, I then wrote that the `string` return was
 *     "true by construction". It was not. Node returns **null** from `execSync`
 *     whenever `stdio` is configured so stdout is not piped (`"inherit"`, or any
 *     array whose second slot is not `"pipe"`), regardless of `encoding` — and on
 *     the throw path `err.stdout` is null too, so the provisional branch would
 *     quietly return `""` instead of the real output. A guarantee stated more
 *     broadly than the code enforces it is the exact defect this repo keeps
 *     paying for, and I wrote one into the sentence claiming to have removed one.
 *
 * Stripped at runtime as well as in the type, because `Omit` binds only callers
 * that are type-checked — a cast walks straight past it.
 */
export function runWtftCli(
	command: string,
	options: Omit<ExecSyncOptions, "encoding" | "stdio"> = {},
): string {
	// Drop both even if a caller cast past the signature. Nothing here needs to
	// customise them: this helper exists to CAPTURE stdout.
	const { stdio: _stdio, encoding: _encoding, ...safe } = options as ExecSyncOptions;
	try {
		return execSync(command, { ...safe, encoding: "utf8" });
	} catch (err: unknown) {
		const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
		if (e && e.status === WTFT_EXIT_PROVISIONAL) {
			// Provisional: the render happened and stdout is complete. `wtft` sets
			// process.exitCode and returns rather than calling process.exit(), so
			// the stream is fully drained before exit — the output is not clipped.
			//
			// `String()` even though the success path is already typed `string`:
			// node populates `err.stdout` as a Buffer regardless of the encoding
			// option on some paths, so this one genuinely needs the coercion. The
			// asymmetry is deliberate here, where it was accidental before.
			return String(e.stdout ?? "");
		}
		throw err;
	}
}

/**
 * Run the `wtft` CLI from a test and get its stdout, treating a
 *   PROVISIONAL read as success (#513).
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

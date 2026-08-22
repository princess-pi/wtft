/**
 * Sandbox registry (#394).
 *
 * 53 of this repo's test suites build throwaway directories with `mkdtempSync`,
 * across 114 call sites, and almost none removed them: measured on this VPS,
 * /tmp held 135,065 entries, ~6 GB of it from `guardrail-case-*` alone. (#394's
 * own table lists the twelve worst prefixes, which is where the "~20" in an
 * earlier draft of this comment came from — that was the tail, not the scope.) Disk was not tight — the problem is unbounded
 * growth with no owner, and every suite re-deciding the question.
 *
 * `process.on("exit")` rather than an `afterAll` or a line at the bottom of the
 * file: most suites here are standalone scripts that call `process.exit` on
 * failure, and a sandbox is most worth removing on the run that failed.
 *
 * One registry per process, which is one suite — tests/run.ts gives each suite
 * its own process.
 */

import { mkdtempSync, rmSync } from "node:fs";

const SANDBOXES: string[] = [];

function sweep(): void {
	for (const root of SANDBOXES.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// A sandbox that cannot be removed must not change the suite's exit
			// code — the test result is the answer here, not the cleanup.
		}
	}
}

process.on("exit", sweep);
// `exit` alone does not fire on a signal — Node's default disposition terminates
// the process without emitting it — so Ctrl-C mid-run left every sandbox built
// so far behind. The two pr-open suites carried their own copy of this for that
// reason; it belongs here, where all 53 get it. Re-raise the conventional code
// afterwards so the caller still sees why the run ended.
process.on("SIGINT", () => { sweep(); process.exit(130); });
process.on("SIGTERM", () => { sweep(); process.exit(143); });

/** Register an already-created directory for removal at process exit. */
export function trackSandbox(dir: string): string {
	SANDBOXES.push(dir);
	return dir;
}

/** `mkdtempSync` plus registration — the one-call form. */
export function mkSandbox(prefix: string): string {
	return trackSandbox(mkdtempSync(prefix));
}

/**
 * Sandbox registry (#394).
 *
 * Most of this repo's test suites build throwaway directories with `mkdtempSync`
 * and almost none removed them: measured on this VPS,
 * /tmp held 135,065 entries, ~6 GB of it from `guardrail-case-*` alone. (#394's
 * own table lists the twelve worst prefixes, which is where the "~20" in an
 * earlier draft of this comment came from — that was the tail, not the scope.) Disk was not tight — the problem is unbounded
 * growth with no owner, and every suite re-deciding the question.
 *
 * `process.on("exit")` AND `afterAll`, because the repo runs suites two ways and
 * neither hook covers both (#435). Standalone (`bun <file>`) is where suites call
 * `process.exit` on failure — a sandbox is most worth removing on the run that
 * failed — and only the exit handler fires there. The runner (`bun test <file>`,
 * what tests/run.ts spawns) never emits `exit`, and only `afterAll` fires there.
 * `sweep` splices the list, so whichever fires first leaves the other nothing to
 * do and running both is harmless.
 *
 * One registry per process, which is one suite — tests/run.ts gives each suite
 * its own process, spawning `bun test <file>` per file rather than handing the
 * directory to one runner.
 *
 * That is load-bearing, so here is what breaks without it. Under a single
 * `bun test tests/` the module is cached: this file's top-level block runs for
 * the FIRST importer only, its afterAll fires when that first file finishes,
 * sweep() splices the list, and every sandbox registered by later files in the
 * same process is orphaned with no error — #394's exact bug, reintroduced.
 *
 * The repo already forbids that invocation for an unrelated and older reason:
 * most suites are standalone scripts that call process.exit, so a shared runner
 * dies after a few files and still exits 0 (CLAUDE.md, "never bare `bun test`
 * over the whole tests/ directory"; tests/run.ts's own header records the run
 * where it executed 3 of 42 files and reported success). So the precondition is
 * enforced by the rule that already exists, not by this file — and anyone who
 * breaks that rule loses far more than sandbox cleanup.
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
// ...but ONLY on the standalone path. Bun's test runner never emits `exit`
// (measured on bun 1.3.14), and tests/run.ts spawns every suite as
// `bun test <file>` — so from #394 landing until #435, the registry registered
// every call site and removed nothing on the one path the repo actually uses.
//
// Two populations, easy to conflate and counted here so they are not: 98 suites
// total in tests/, of which 55 import this module (counted 2026-08-22 on the
// #435 branch). tests/run.ts spawns ALL 98 through the runner path, not just the
// 55. #394's header said 53 — the same measurement taken earlier.
//
// A `mkdtempSync` call-site count is deliberately NOT quoted here. It has been
// stated wrong twice (114, then 136) because the obvious greps count imports and
// prose alongside calls, and a number that rots every time a suite is added is
// worse than no number: read it off the tree when you need it.
// Measured on the VPS 2026-08-22, by counting /tmp top-level entries before the
// sweep that followed: 207,748, against the 135,065 recorded in this file's own
// header when #394 was written. Both are point observations on one host, quoted
// as the reason the hook was added, not as a portable benchmark.
//
// `require` rather than a static import, because this module is also loaded by
// suites run as `bun <file>`. Registering at module load — not lazily from
// trackSandbox — puts the hook at the importing file's top level, so it runs
// after that file's whole suite rather than after whichever describe block
// happened to create the first sandbox.
//
// Measured, because the obvious guess is wrong: outside the runner "bun:test"
// still RESOLVES and `afterAll` is still a function. It is the CALL that throws
// ("Cannot use afterAll() outside of the test runner"). So the failure being
// tolerated here is that one specific throw — and nothing else. A bare catch
// would also swallow a real regression (afterAll renamed, removed, or throwing
// for an unrelated reason) and silently drop the runner-path cleanup this file
// exists to provide, which is #394's original silent-failure shape wearing a
// different hat.
{
	// Everything here is best-effort by construction. A cleanup concern must
	// never change a suite's outcome (see sweep's catch above), and an
	// unguarded `require` at module load would do exactly that: under plain
	// node, or any runtime that resolves "bun:test" differently, the throw
	// escapes module evaluation and every suite importing this file dies. That
	// is strictly worse than the silent-cleanup-failure this file exists to fix.
	let runner: { afterAll?: (fn: () => void) => void } | undefined;
	try {
		runner = require("bun:test");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// The expected case: no bun:test to resolve, i.e. standalone under a
		// non-bun runtime. The exit and signal handlers below carry cleanup
		// there. Anything else — a corrupted install, a renamed module, a
		// transitive resolution error — silently disables runner-path cleanup,
		// so it gets the same treatment as a failed registration rather than the
		// bare catch this file argues against one branch below.
		if (!/cannot find module|module not found|failed to resolve/i.test(msg)) {
			console.error(`wtft/sandbox: bun:test could not be loaded (${msg}) — sandboxes will not be removed on the runner path (#435)`);
		}
	}

	if (runner !== undefined) {
		if (typeof runner.afterAll !== "function") {
			// The module resolved but the hook is gone: an API change, not a context.
			console.error("wtft/sandbox: bun:test resolved without afterAll — sandboxes will not be removed on the runner path (#435)");
		} else {
			try {
				runner.afterAll(sweep);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// The one expected case: loaded standalone, not under `bun test`.
				// The case "bun still says 'outside of the test runner' when
				// afterAll is called standalone" in
				// tests/sandbox-cleanup-runs.test.ts pins this wording against the
				// live bun, so a reword is a red test rather than a silently
				// widened suppression.
				if (!/outside of the test runner/i.test(msg)) {
					console.error(`wtft/sandbox: afterAll registration failed (${msg}) — sandboxes will not be removed on the runner path (#435)`);
				}
			}
		}
	}
}

// `exit` alone does not fire on a signal — Node's default disposition terminates
// the process without emitting it — so Ctrl-C mid-run left every sandbox built
// so far behind. The two pr-open suites carried their own copy of this for that
// reason; it belongs here, where all 55 importers get it. Re-raise the conventional code
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

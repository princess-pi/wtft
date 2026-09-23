#!/usr/bin/env -S bun
/**
 * Runs every `tests/*.test.ts` suite in its OWN process, several at a time,
 *   and aggregates the exit codes.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { collectSkips, renderSkipSummary } from "./lib/skips.ts";
import { reapFixtureDaemons } from "./lib/reap-fixture-daemons.ts";

// ---
// Layout
// ---

const TESTS_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(TESTS_DIR, "..");

/** Per-suite wall-clock ceiling. Generous: some suites spawn daemons and wait on them. */
const SUITE_TIMEOUT_MS = 180_000;

/** Suites run at once. `WTFT_TEST_JOBS=1` is the serial runner. Twice the CPU
 *  count: most suites spend their time waiting on a daemon, not computing. */
const JOBS = (() => {
	const raw = process.env.WTFT_TEST_JOBS;
	if (raw === undefined || raw === "") return Math.max(1, os.availableParallelism() * 2);
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1) {
		console.error(`WTFT_TEST_JOBS must be a positive integer, got ${JSON.stringify(raw)}`);
		process.exit(2);
	}
	return n;
})();

/** Run alone, after the pool, in this order, because they reach outside their
 *  own sandbox: two stop daemons host-wide (the unscoped fixture reaper,
 *  `wtft-daemon --cleanup`, `wtft-daemon --restart`), which would kill a
 *  neighbour's daemon mid-test; the last rebuilds `bin/`, which every suite
 *  importing a bundle would see half-written. */
const SOLO = [
	"wtft-96-fixture-daemons.test.ts",
	"wtft-205-one-daemon-per-harness.test.ts",
	"wtft-46-install-wtft.test.ts",
];

/** Last run's per-suite times, so the slowest start first and the pool's tail
 *  is not one long suite started last. Scratch: `tmp/` is gitignored. */
const TIMES_FILE = path.join(REPO_ROOT, "tmp", "test-times.json");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// ---
// Discovery
// ---

const filters = process.argv.slice(2).filter(a => !a.startsWith("-"));

const allSuites = fs.readdirSync(TESTS_DIR)
	.filter(f => f.endsWith(".test.ts"))
	.sort();

const suites = filters.length === 0
	? allSuites
	: allSuites.filter(f => filters.some(needle => f.includes(needle)));

// Shell suites are NOT run by this driver; CI gates each as its own step
// (`.github/workflows/ci.yml`). Named here rather than silently omitted: a
// skipped suite you cannot see is a coverage claim you cannot check.
const shellSuites = fs.readdirSync(TESTS_DIR).filter(f => f.endsWith(".test.sh")).sort();

if (suites.length === 0) {
	console.error(`${RED}No suites matched:${RESET} ${filters.join(", ")}`);
	console.error(`${DIM}${allSuites.length} suites available in ${TESTS_DIR}${RESET}`);
	process.exit(1);
}

// ---
// Run
// ---

interface Result {
	name: string;
	ok: boolean;
	ms: number;
	timedOut: boolean;
	output: string;
	/** Checks the suite declared it did NOT run — see tests/lib/skips.ts. */
	skips: string[];
	/** Fixture daemons still running when the suite ended, stopped by the runner. */
	leaked: number;
}

const nameWidth = Math.max(...suites.map(s => s.replace(/\.test\.ts$/, "").length));

let lastTimes: Record<string, number> = {};
try {
	const parsed = JSON.parse(fs.readFileSync(TIMES_FILE, "utf8"));
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) lastTimes = parsed;
} catch { /* first run: no order to reuse */ }
const pooled = suites.filter(f => !SOLO.includes(f)).sort((a, b) => (lastTimes[b] ?? 0) - (lastTimes[a] ?? 0));
const solo = SOLO.filter(f => suites.includes(f));

console.log(`${BOLD}Running ${suites.length} suite${suites.length === 1 ? "" : "s"}${RESET} ${DIM}(process-per-suite, jobs=${JOBS})${RESET}\n`);

const results: Result[] = [];

function runSuite(file: string): Promise<Result> {
	const name = file.replace(/\.test\.ts$/, "");
	let configHome: string, suiteTmp: string;
	try {
		// Fresh config root per suite — no developer config can reach the code under test.
		configHome = fs.mkdtempSync(path.join(os.tmpdir(), "pp-test-config-"));
		// Its own tmp root, so its fixture daemons can be reaped without touching a
		// neighbour's.
		suiteTmp = fs.mkdtempSync(path.join(os.tmpdir(), `wtft-suite-${name}-`));
	} catch (err) {
		const output = `runner: could not create the suite's directories: ${(err as Error).message}\n`;
		return Promise.resolve({ name, ok: false, ms: 0, timedOut: false, output, skips: [], leaked: 0 });
	}
	// Its own state root too: the spawn ledger and daemon state live there.
	const stateHome = path.join(suiteTmp, "state");
	const started = Date.now();
	return new Promise(resolve => {
		const child = spawn("bun", ["test", path.join("tests", file)], {
			cwd: REPO_ROOT,
			env: { ...process.env, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome, TMPDIR: suiteTmp },
		});
		let output = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", d => { output += d; });
		child.stderr.on("data", d => { output += d; });
		let timedOut = false;
		// A grandchild that inherited the pipes can hold 'close' back forever, so
		// 'exit' settles too, after a grace for the last output; a suite that
		// ignores SIGTERM gets SIGKILL.
		const GRACE_MS = 2_000;
		let kill: NodeJS.Timeout | undefined;
		let grace: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
		}, SUITE_TIMEOUT_MS);
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(kill);
			clearTimeout(grace);
			child.stdout.destroy();
			child.stderr.destroy();
			const ms = Date.now() - started;
			const leaked = reapFixtureDaemons(suiteTmp);
			for (const dir of [configHome, suiteTmp]) {
				try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
			}
			resolve({ name, ok: ok && !timedOut, ms, timedOut, output, skips: collectSkips(output), leaked });
		};
		child.on("error", err => { output += `\nrunner: could not start the suite: ${err.message}\n`; finish(false); });
		child.on("close", code => finish(code === 0));
		child.on("exit", code => { grace = setTimeout(() => finish(code === 0), GRACE_MS); });
	});
}

function report(r: Result): void {
	results.push(r);
	const badge = r.ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
	const note = r.timedOut ? ` ${RED}(timed out after ${SUITE_TIMEOUT_MS / 1000}s)${RESET}` : "";
	const skipNote = r.skips.length > 0 ? ` ${DIM}(${r.skips.length} skipped)${RESET}` : "";
	const leakNote = r.leaked > 0 ? ` ${DIM}(stopped ${r.leaked} daemon(s) it left running)${RESET}` : "";
	console.log(`  ${badge}  ${r.name.padEnd(nameWidth)}  ${DIM}${(r.ms / 1000).toFixed(1)}s${RESET}${note}${skipNote}${leakNote}`);
}

const queue = [...pooled];
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) report(await runSuite(file));
}));
for (const file of solo) report(await runSuite(file));
// Nothing is running now, so the host-wide reaper is safe: it catches a daemon
// a suite started outside its own TMPDIR.
const stray = reapFixtureDaemons();
if (stray > 0) console.log(`${DIM}stopped ${stray} fixture daemon(s) left outside any suite's tmp dir${RESET}`);

try {
	const times = { ...lastTimes };
	for (const r of results) times[`${r.name}.test.ts`] = r.ms;
	fs.mkdirSync(path.dirname(TIMES_FILE), { recursive: true });
	fs.writeFileSync(TIMES_FILE, JSON.stringify(times, null, "\t") + "\n");
} catch { /* the order hint is an optimisation; a run never fails over it */ }

// ---
// Report
// ---

const failed = results.filter(r => !r.ok).sort((a, b) => a.name.localeCompare(b.name));

for (const r of failed) {
	console.log(`\n${RED}${"─".repeat(60)}${RESET}`);
	console.log(`${RED}${BOLD}FAIL${RESET} ${BOLD}${r.name}${RESET}`);
	console.log(`${RED}${"─".repeat(60)}${RESET}`);
	console.log(r.output.trimEnd());
}

const passedCount = results.length - failed.length;
console.log(`\n${BOLD}${results.length} suites${RESET} — ${GREEN}${passedCount} passed${RESET}, ${failed.length > 0 ? RED : DIM}${failed.length} failed${RESET}`);

if (filters.length > 0) {
	console.log(`${DIM}filtered by: ${filters.join(", ")} (${allSuites.length} suites total)${RESET}`);
}
if (shellSuites.length > 0) {
	// Shell suites are not tests/*.test.ts. CI runs each as its own gating step;
	// locally the exact command is printed so it can be pasted, not inferred.
	const local = shellSuites.map(s => `bash tests/${s}`).join("; ");
	console.log(`${DIM}not run by this driver: ${shellSuites.join(", ")} — shell suites; CI gates each as its own step. Locally: ${local}${RESET}`);
}

// Skipped CHECKS, one level below skipped suites. A host-gated check that found
// no host state passes without testing anything. Printed after the pass/fail line so it is the last thing
// on screen, and unconditionally — the renderer returns "" when there is
// nothing to report.
const skipSummary = renderSkipSummary(
	results.map(r => ({ suite: r.name, reasons: r.skips })),
	{ dim: DIM, bold: BOLD, reset: RESET },
);
if (skipSummary) console.log(`\n${skipSummary}`);

process.exit(failed.length > 0 ? 1 : 0);

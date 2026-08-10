#!/usr/bin/env -S bun
/**
 * @package princess-pi-packages
 * @tool tests/run.ts — the declared test runner (`bun run test`)
 * @description Runs every `tests/*.test.ts` suite in its OWN process and
 *   aggregates the exit codes.
 *
 *   Why process-per-suite (#158): 34 of 42 suites are standalone scripts that
 *   end in `process.exit(failed > 0 ? 1 : 0)`. Under any single-process runner
 *   — `bun test <dir>`, vitest, `node --test` — the first suite to finish tears
 *   the shared process down mid-run. On main that meant `bun test` ran 3 of 42
 *   files and exited 0: a green result that never ran the tests. Giving each
 *   suite its own process makes that `process.exit` harmless.
 *
 *   Why `bun test <file>` rather than `bun <file>`: it executes both suite
 *   styles in this repo — plain assertion scripts AND the `describe`/`expect`
 *   suites (`git-guardrails-parity` imports `bun:test` and cannot run any other
 *   way). One command covers both, so converting a suite to `describe`/`expect`
 *   later needs no change here.
 *
 *   Why a fresh XDG_CONFIG_HOME per suite: `wtft --tokens/--cost` is
 *   config-persistable, so a developer's saved `~/.config/princess-pi-packages/
 *   wtft.json` was deciding test outcomes (#158 RC-4a). Isolating config here
 *   is one seam for all suites instead of a rule to remember in each of them.
 *
 *   Serial, not parallel: several suites spawn wtft daemons, bind ports, and
 *   share `/tmp` fixture paths. Serial is the honest default until those are
 *   isolated from each other.
 *
 * @usage
 *   bun run test                 Run every suite.
 *   bun run test wtft-title      Run suites whose filename matches a substring.
 *   bun run test serve wtft-auto Multiple filters are OR'd.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---
// Layout
// ---

const TESTS_DIR = import.meta.dirname;
const REPO_ROOT = path.resolve(TESTS_DIR, "..");

/** Per-suite wall-clock ceiling. Generous: some suites spawn daemons and wait on them. */
const SUITE_TIMEOUT_MS = 180_000;

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

// Shell suites are NOT run by this driver — several need sudo or a live nginx.
// Named here rather than silently omitted: a skipped suite you cannot see is a
// coverage claim you cannot check.
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
}

const nameWidth = Math.max(...suites.map(s => s.replace(/\.test\.ts$/, "").length));

console.log(`${BOLD}Running ${suites.length} suite${suites.length === 1 ? "" : "s"}${RESET} ${DIM}(process-per-suite, serial)${RESET}\n`);

const results: Result[] = [];

for (const file of suites) {
	const name = file.replace(/\.test\.ts$/, "");

	// Fresh config root per suite — no developer config can reach the code under test.
	const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "pp-test-config-"));

	const started = Date.now();
	const proc = spawnSync("bun", ["test", path.join("tests", file)], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: SUITE_TIMEOUT_MS,
		env: { ...process.env, XDG_CONFIG_HOME: configHome },
	});
	const ms = Date.now() - started;

	try { fs.rmSync(configHome, { recursive: true, force: true }); } catch {}

	const timedOut = proc.signal === "SIGTERM" && ms >= SUITE_TIMEOUT_MS;
	const ok = !timedOut && proc.status === 0;
	const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;

	results.push({ name, ok, ms, timedOut, output });

	const badge = ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
	const note = timedOut ? ` ${RED}(timed out after ${SUITE_TIMEOUT_MS / 1000}s)${RESET}` : "";
	console.log(`  ${badge}  ${name.padEnd(nameWidth)}  ${DIM}${(ms / 1000).toFixed(1)}s${RESET}${note}`);
}

// ---
// Report
// ---

const failed = results.filter(r => !r.ok);

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
	console.log(`${DIM}not run by this driver: ${shellSuites.join(", ")} — shell suites, run by hand${RESET}`);
}

process.exit(failed.length > 0 ? 1 : 0);

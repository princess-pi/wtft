#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test config-persistence
 * @description The config-persistence split is a convention, not a lib
 *   (princess-pi/wtft#51 decision 3). Two halves, pinned here:
 *
 *   1. The CLI (`bin/wtft.mjs`) is READ-ONLY. Load-bearing: if it ever gains a
 *      write path, every `wtft` invocation silently persists whatever flags it
 *      was given — which is why running the suite must never mutate a
 *      developer's saved settings, and why `--cost`/`--tokens` are safe ways to
 *      state intent rather than side effects.
 *   2. The Pi extensions (`extensions/wtft.ts`, `extensions/token-budget.ts`)
 *      are the writers — they persist the `/wtft` and `/budget` display
 *      settings. The CLI reads; the extensions write.
 *
 *   `writeConfig` MERGES rather than clobbers is covered by the libs suite
 *   (princess-pi/libs tests/config-persistence.test.ts), not re-derived here.
 *
 *   Every check runs against a temp `XDG_CONFIG_HOME` set by this file, not by
 *   the runner — a test about config writes is the last place to rely on
 *   someone else's isolation.
 */

import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function check(label: string, fn: () => void) {
	try {
		fn();
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} catch (err) {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		console.log(`       ${(err as Error).message.split("\n")[0]}`);
		failed++;
	}
}

// ---
// Isolation: our own XDG root, restored on the way out.
// ---

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_BIN = path.join(REPO_ROOT, "bin", "wtft.mjs");

const xdgRoot = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-config-persistence-")));
const configPath = path.join(xdgRoot, "princess-pi-tools", "wtft.json");
const prevXdg = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = xdgRoot;

/** Seed a config that looks like a real user's — including keys nothing here touches. */
function seedConfig(overrides: Record<string, unknown> = {}): void {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify({
		interval: "6m",
		limit: 10,
		showTicks: true,
		mode: "cumulative",
		timezone: "America/Los_Angeles",
		tokens: true,
		...overrides,
	}, null, 2) + "\n");
}

function readConfigFile(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

/** Run the CLI and report mutation AND exit status. Both matter: a CLI that
 *  fails to start also never writes, so "no mutation" alone would pass
 *  vacuously on a broken build. */
function cliRun(args: string[]): { mutated: boolean; exitCode: number } {
	const before = fs.readFileSync(configPath);
	let exitCode = 0;
	try {
		execFileSync(process.execPath, [CLI_BIN, ...args], {
			cwd: REPO_ROOT,
			env: { ...process.env, XDG_CONFIG_HOME: xdgRoot },
			stdio: "ignore",
			timeout: 30_000,
		});
	} catch (err) {
		exitCode = (err as { status?: number }).status ?? 1;
	}
	return { mutated: !fs.readFileSync(configPath).equals(before), exitCode };
}

console.log("🏃 Running config persistence tests (#51 decision 3)...\n");

// ---
// 1. The CLI is read-only
// ---

console.log("1. CLI (bin/wtft.mjs) never writes config");

seedConfig();

check("--cost runs clean and leaves config byte-identical", () => {
	const r = cliRun(["--cost", "-l", "3"]);
	assert.strictEqual(r.exitCode, 0, `exit ${r.exitCode}`);
	assert.strictEqual(r.mutated, false);
});

check("--tokens runs clean and leaves config byte-identical", () => {
	const r = cliRun(["--tokens", "-l", "3"]);
	assert.strictEqual(r.exitCode, 0, `exit ${r.exitCode}`);
	assert.strictEqual(r.mutated, false);
});

check("--interval/--limit run clean and leave config byte-identical", () => {
	const r = cliRun(["-i", "3h", "-l", "7"]);
	assert.strictEqual(r.exitCode, 0, `exit ${r.exitCode}`);
	assert.strictEqual(r.mutated, false);
});

check("persisted 'tokens: true' survives a --cost CLI run", () => {
	assert.strictEqual(readConfigFile().tokens, true);
});

// ---
// 2. The extensions are the writers
// ---

console.log("\n2. The Pi extensions import writeConfig; the CLI source does not");

const wtftExt = fs.readFileSync(path.join(REPO_ROOT, "extensions", "wtft.ts"), "utf8");
const budgetExt = fs.readFileSync(path.join(REPO_ROOT, "extensions", "token-budget.ts"), "utf8");

// The import statement, not a bare substring — a comment mentioning
// writeConfig must not count as importing it, and a word-boundary match
// must not miss the aliased form.
const IMPORT_WRITE = /import\s*\{[^}]*\bwriteConfig\b[^}]*\}\s*from\s*["']@princess-pi\/libs\/config["']/;

check("extensions/wtft.ts imports writeConfig from @princess-pi/libs/config", () => {
	assert.match(wtftExt, IMPORT_WRITE);
});

check("extensions/token-budget.ts imports writeConfig from @princess-pi/libs/config", () => {
	assert.match(budgetExt, IMPORT_WRITE);
});

// ---
// Cleanup
// ---

if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
else process.env.XDG_CONFIG_HOME = prevXdg;

console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

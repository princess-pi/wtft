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
 *   The `writeConfig` merge contract is owned by the libs suite
 *   (princess-pi/libs tests/config-persistence.test.ts); the
 *   surviving-unrelated-settings assertions here observe that merge as a
 *   data-integrity check, they do not re-derive the contract.
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

async function checkAsync(label: string, fn: () => Promise<void>) {
	try {
		await fn();
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
// 2. The Pi extension DOES persist — the writer half, exercised
//    behaviorally. A permissive mock drives the /wtft handler; the
//    assertion is about what landed on disk, not how far the render got
//    (which needs a live TUI, out of scope here).
// ---

console.log("\n2. The Pi /wtft extension writes config");

function permissiveMock(): any {
	const handler: ProxyHandler<any> = {
		get: (_t, prop) => {
			if (prop === "then") return undefined; // stay await-safe
			return new Proxy(function () { return permissiveMock(); }, handler);
		},
		apply: () => permissiveMock(),
	};
	return new Proxy(function () {}, handler);
}

const registered: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
const flags: Record<string, unknown> = {};
const mockPi: any = {
	on: () => {},
	registerCommand: (name: string, def: any) => { registered[name] = def; },
	registerFlag: (name: string) => { flags[name] = undefined; },
	getFlag: (name: string) => flags[name],
};

const wtftExtension = (await import("../extensions/wtft.ts")).default;
wtftExtension(mockPi);

check("/wtft command is registered", () => {
	assert.ok(registered.wtft, "expected a 'wtft' command");
});

async function runSlashCommand(cmd: string, args: string): Promise<void> {
	try {
		await registered[cmd].handler(args, permissiveMock());
	} catch (err) {
		// The write happens before the render, which needs a live TUI. A throw
		// after the write is expected; log it so a genuine write-path bug is
		// visible rather than silently discarded.
		console.error(`  [headless] /${cmd} handler threw after write (expected render stage): ${(err as Error).message}`);
	}
}

await checkAsync("/wtft --cost persists tokens:false", async () => {
	seedConfig({ tokens: true });
	await runSlashCommand("wtft", "--cost");
	assert.strictEqual(readConfigFile().tokens, false);
	assert.strictEqual(readConfigFile().timezone, "America/Los_Angeles", "unrelated settings must survive");
});

await checkAsync("/wtft --tokens persists tokens:true", async () => {
	seedConfig({ tokens: false });
	await runSlashCommand("wtft", "--tokens");
	assert.strictEqual(readConfigFile().tokens, true);
});

await checkAsync("/wtft --no-emoji persists disabledEmoji:true", async () => {
	seedConfig();
	await runSlashCommand("wtft", "--no-emoji");
	assert.strictEqual(readConfigFile().disabledEmoji, true);
});

await checkAsync("/wtft --emoji persists disabledEmoji:false", async () => {
	seedConfig({ disabledEmoji: true });
	await runSlashCommand("wtft", "--emoji");
	assert.strictEqual(readConfigFile().disabledEmoji, false);
});

// The token-budget extension is the writer for its OWN config file, and it
// is exercised the same way — drive /budget, assert token-budget.json landed.
const tokenBudgetExtension = (await import("../extensions/token-budget.ts")).default;
tokenBudgetExtension(mockPi);

check("/budget command is registered", () => {
	assert.ok(registered.budget, "expected a 'budget' command");
});

const budgetConfigPath = path.join(xdgRoot, "princess-pi-tools", "token-budget.json");
function readBudgetConfig(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(budgetConfigPath, "utf8"));
}

await checkAsync("/budget --widget off persists widget:false to token-budget.json", async () => {
	await runSlashCommand("budget", "--widget off");
	assert.strictEqual(readBudgetConfig().widget, false);
});

// ---
// Cleanup
// ---

if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
else process.env.XDG_CONFIG_HOME = prevXdg;

console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

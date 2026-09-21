#!/usr/bin/env bun
/**
 * The config-persistence split is a convention, not a lib
 *   (princess-pi/wtft#51 decision 3).
 */

import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";
import { WTFT_EXIT_PROVISIONAL } from "./lib/wtft-cli";
import { getDaemonPidPath } from "../extensions/lib/wtft-daemon-lib.ts";

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
// Isolation, part 1: our own XDG root, restored on the way out. Part 2 — our
// own session corpus — is set up below, next to the CLI runner that needs it.
// ---

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_BIN = path.join(REPO_ROOT, "bin", "wtft.mjs");

const xdgRoot = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-config-persistence-")));
const configPath = path.join(xdgRoot, "wtft", "config.json");
const prevXdg = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = xdgRoot;

/** Seed a config that looks like a real user's. Every key here is one the
 *  `/wtft` handler writes (extensions/wtft.ts:465, :522-528), which is what
 *  makes the byte-identical comparison in cliRun meaningful rather than a
 *  comparison of fields nothing could have changed. */
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

// ---
// A session of our own to read (#32).
//
// Explicit two-turn session plus empty roots for both harnesses. Own XDG root
// AND own corpus: without them a clean checkout finds no sessions.
// `-s` naming an existing file short-circuits discovery; the empty roots keep
// a fallen-through `-s` from finding the developer's corpus.
// ---
const SESSION_ID = "c0f16000-1a9b-4c3d-9e8f-000000000051";
const TS = Date.now();
const corpusDir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-config-corpus-")));
const emptyClaude = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-config-empty-c-")));
const emptyPi = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-config-empty-p-")));
const sessionPath = path.join(corpusDir, `${SESSION_ID}.jsonl`);
fs.writeFileSync(sessionPath, [
	JSON.stringify({
		type: "assistant",
		message: {
			role: "assistant", id: "msg_51_001", model: "claude-sonnet-4-20250514",
			timestamp: new Date(TS - 600_000).toISOString(),
			usage: { input_tokens: 2000, output_tokens: 500 },
			content: [{ type: "tool_use", name: "write", input: { file_path: "src/main.ts" } }],
		},
	}),
	JSON.stringify({
		type: "assistant",
		message: {
			role: "assistant", id: "msg_51_002", model: "claude-sonnet-4-20250514",
			timestamp: new Date(TS - 300_000).toISOString(),
			usage: { input_tokens: 500, output_tokens: 200 },
			content: [{ type: "tool_use", name: "bash", input: { command: "git diff --stat" } }],
		},
	}),
].join("\n") + "\n");

// `-s` spawns a daemon for that session; reap it rather than leaving one behind
// per suite run.
process.on("exit", () => {
	try {
		const pid = parseInt(fs.readFileSync(getDaemonPidPath(sessionPath), "utf8").trim(), 10);
		if (pid > 0) process.kill(pid, "SIGTERM");
	} catch { /* no daemon, or already gone */ }
});

/** Run the CLI and report mutation AND a run VERDICT. Both matter: a CLI that
 *  fails to start also never writes, so "no mutation" alone would pass
 *  vacuously on a broken build.
 *
 *  `exitCode` is a verdict, not a status — 9 is folded into 0 before it is
 *  returned, so a caller cannot tell the two apart and must not try. #443
 *  defines 9 as "the run SUCCEEDED and the number printed is not yet final"
 *  (bin/wtft.ts:210-215): the CLI spawns the daemon and reads the tag
 *  immediately, so a brand-new session sometimes wins that race. Both codes
 *  mean the render happened, which is the only thing these three checks ask.
 *
 *  tests/lib/wtft-cli.ts owns the same contract for suites that want stdout;
 *  this one wants the code, and that helper returns text, so the mapping is
 *  repeated here rather than the helper reused. */
function cliRun(args: string[]): { mutated: boolean; exitCode: number } {
	const before = fs.readFileSync(configPath);
	let exitCode = 0;
	try {
		execFileSync(process.execPath, [CLI_BIN, "-s", sessionPath, ...args], {
			cwd: REPO_ROOT,
			env: {
				...process.env,
				XDG_CONFIG_HOME: xdgRoot,
				WTFT_CLAUDE_PROJECTS_DIR: emptyClaude,
				WTFT_PI_SESSIONS_DIR: emptyPi,
			},
			stdio: "ignore",
			timeout: 30_000,
		});
	} catch (err) {
		exitCode = (err as { status?: number }).status ?? 1;
	}
	return {
		mutated: !fs.readFileSync(configPath).equals(before),
		exitCode: exitCode === WTFT_EXIT_PROVISIONAL ? 0 : exitCode,
	};
}

console.log("🏃 Running config persistence tests (#51 decision 3)...\n");

// ---
// 1. The CLI is read-only
// ---

console.log("1. CLI (bin/wtft.mjs) never writes config");

seedConfig();

check("--cost runs clean and leaves config byte-identical", () => {
	const r = cliRun(["--cost", "-l", "3"]);
	assert.strictEqual(r.exitCode, 0, `verdict ${r.exitCode} (9 is folded into 0 by cliRun)`);
	assert.strictEqual(r.mutated, false);
});

check("--tokens runs clean and leaves config byte-identical", () => {
	const r = cliRun(["--tokens", "-l", "3"]);
	assert.strictEqual(r.exitCode, 0, `verdict ${r.exitCode} (9 is folded into 0 by cliRun)`);
	assert.strictEqual(r.mutated, false);
});

check("-i/-l (--interval/--limit) run clean and leave config byte-identical", () => {
	const r = cliRun(["-i", "3h", "-l", "7"]);
	assert.strictEqual(r.exitCode, 0, `verdict ${r.exitCode} (9 is folded into 0 by cliRun)`);
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

await checkAsync("extensions import and register without throwing", async () => {
	const wtftExtension = (await import("../extensions/wtft.ts")).default;
	await wtftExtension(mockPi);
});

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
await checkAsync("extensions/token-budget.ts imports and registers without throwing", async () => {
	const tokenBudgetExtension = (await import("../extensions/token-budget.ts")).default;
	await tokenBudgetExtension(mockPi);
});

check("/budget command is registered", () => {
	assert.ok(registered.budget, "expected a 'budget' command");
});

const budgetConfigPath = path.join(xdgRoot, "wtft", "token-budget.json");
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

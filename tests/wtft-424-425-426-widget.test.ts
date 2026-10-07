#!/usr/bin/env bun
/**
 * The Pi widget's `/wtft`: `--hide` stays hidden until the next `/wtft` that draws it or a new Pi session, a
 * plain `/wtft` saves only the settings it was given, and `--help`, `--why` and `--version` work from any cwd.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const xdgRoot = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-424-")));
process.env.XDG_CONFIG_HOME = xdgRoot;
process.env.PRINCESS_PI_CONFIG_NO_WALKUP = "1";
const configPath = path.join(xdgRoot, "wtft", "config.json");
const readConfigFile = (): Record<string, unknown> | null => fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null;

const events: Record<string, ((event: unknown, ctx: unknown) => Promise<void> | void)[]> = {};
const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
const pi: any = {
	on: (name: string, fn: (event: unknown, ctx: unknown) => void) => { (events[name] ??= []).push(fn); },
	registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands[name] = def; },
	registerFlag: () => {},
	getFlag: () => undefined,
};
const widget: (string[] | undefined)[] = [];
const notes: string[] = [];
const ctx: any = {
	ui: {
		setWidget: (_id: string, lines: string[] | undefined) => { widget.push(lines); },
		notify: (text: string) => { notes.push(text); },
		custom: async () => {},
	},
	sessionManager: { getSessionFile: () => undefined, buildSessionContext: () => ({}) },
};
const shown = () => Array.isArray(widget[widget.length - 1]);
const run = (args: string) => commands.wtft!.handler(args, ctx);
const fire = async (name: string) => { for (const fn of events[name] ?? []) await fn({}, ctx); };

const ticks: (() => void)[] = [];
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((fn: () => void) => ticks.push(fn)) as unknown as typeof setInterval;
const tick = () => { for (const fn of ticks) fn(); };

const wtftExtension = (await import("../extensions/wtft.ts")).default;
wtftExtension(pi);
check(typeof commands.wtft?.handler === "function" && (events.agent_settled?.length ?? 0) > 0 && (events.session_tree?.length ?? 0) > 0,
	"fixture precondition: /wtft, agent_settled and session_tree are registered");

console.log("\na plain /wtft saves only what it was given");
await run("");
const afterPlain = readConfigFile();
check(afterPlain !== null, "a plain /wtft still creates the config, which is what auto-shows the widget next session");
check(afterPlain !== null && ["interval", "limit", "mode", "timezone"].every((key) => !(key in afterPlain)),
	`a plain /wtft writes no interval, limit, mode or timezone (${JSON.stringify(afterPlain)})`);
check(shown(), "a plain /wtft shows the widget");
await run("-l 5 --tz UTC");
await run("");
const afterFlags = readConfigFile();
check(afterFlags?.limit === 5 && afterFlags?.timezone === "UTC", `flags given are saved, and a later plain /wtft keeps them (${JSON.stringify(afterFlags)})`);
check(!("interval" in (afterFlags ?? {})) && !("mode" in (afterFlags ?? {})), "settings not given stay unwritten");

console.log("\n--hide stays hidden until the next /wtft that draws it");
await fire("session_start");
check(ticks.length === 1, "fixture precondition: session_start installs the refresh timer");
await run("--hide");
check(widget[widget.length - 1] === undefined, "--hide clears the widget");
const hiddenAt = widget.length;
await fire("agent_settled");
await fire("session_tree");
tick();
check(widget.slice(hiddenAt).every((lines) => lines === undefined), "a settled turn, a tree move and a timer tick do not redraw a hidden widget");
await run("--no-emoji");
check(widget.slice(hiddenAt).every((lines) => lines === undefined), "an emoji flag does not draw a hidden widget either");
await run("");
check(shown(), "the next /wtft shows it again");
await fire("agent_settled");
check(shown(), "and a settled turn keeps drawing it");
await run("--hide");
await run("--show");
check(shown(), "/wtft --show shows a hidden widget");
await run("--hide");
await fire("session_start");
check(shown(), "a new Pi session shows a widget the last session hid");
check(ticks.length === 1, "fixture precondition: the second session reuses the one refresh timer");
tick();
check(shown(), "and its timer keeps drawing it");
globalThis.setInterval = realSetInterval;

console.log("\n--help, --why and --version from any cwd");
const elsewhere = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-426-cwd-")));
const prevCwd = process.cwd();
process.chdir(elsewhere);
try {
	check(!fs.existsSync(path.join(elsewhere, "docs")), "fixture precondition: the cwd holds no docs/manifests");
	for (const [flag, expect] of [["--help", /--interval/], ["--why", /Why run/], ["--version", /\d+\.\d+\.\d+/]] as const) {
		notes.length = 0;
		await run(flag);
		const text = notes.join("\n");
		check(expect.test(text) && !/Failed to load/.test(text), `/wtft ${flag} prints its text outside a checkout (${text.slice(0, 80).replace(/\n/g, " ")})`);
	}
} finally {
	process.chdir(prevCwd);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

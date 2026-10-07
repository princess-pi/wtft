#!/usr/bin/env bun
/**
 * The Pi extension registers the user's pricing.json at session start, and `--help` / `--version` name the
 * command that was run: `wtft` from the CLI, `/wtft` from Pi.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";
import { lookupModelPricing } from "../extensions/lib/wtft-cost.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const REPO = path.resolve(import.meta.dir, "..");
const MODEL = "wtft-test-only-priced-in-user-config";
const xdgRoot = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-429-")));
process.env.XDG_CONFIG_HOME = xdgRoot;
process.env.PRINCESS_PI_CONFIG_NO_WALKUP = "1";
fs.mkdirSync(path.join(xdgRoot, "wtft"), { recursive: true });
fs.writeFileSync(path.join(xdgRoot, "wtft", "pricing.json"), JSON.stringify({
	[MODEL]: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	"wtft-test-only-bad-rate": { input: "free", output: 2, cacheRead: 0, cacheWrite: 0 },
}));

const events: Record<string, ((event: unknown, ctx: unknown) => Promise<void> | void)[]> = {};
const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
const pi: any = {
	on: (name: string, fn: (event: unknown, ctx: unknown) => void) => { (events[name] ??= []).push(fn); },
	registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands[name] = def; },
	registerFlag: () => {},
	getFlag: () => undefined,
};
const notes: { text: string; level: string }[] = [];
const ctx: any = {
	ui: { setWidget: () => {}, notify: (text: string, level: string) => { notes.push({ text, level }); }, custom: async () => {} },
	sessionManager: { getSessionFile: () => undefined, buildSessionContext: () => ({}) },
};
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
const stderr: string[] = [];
const realError = console.error;

console.log("pricing.json in the Pi extension");
check(lookupModelPricing(MODEL) === null, "fixture precondition: the model has no built-in price");
const wtftExtension = (await import("../extensions/wtft.ts")).default;
wtftExtension(pi);
console.error = (...args: unknown[]) => { stderr.push(args.join(" ")); };
try {
	for (const fn of events.session_start ?? []) await fn({}, ctx);
} finally {
	console.error = realError;
	globalThis.setInterval = realSetInterval;
}
check(lookupModelPricing(MODEL)?.output === 2, "after session_start the user's rates price the model");
check(notes.some((n) => n.level === "warning" && n.text.includes("wtft-test-only-bad-rate")),
	`a rejected entry is reported as a Pi notification (${JSON.stringify(notes)})`);
check(stderr.length === 0, `nothing is written to stderr under the TUI (${JSON.stringify(stderr)})`);

fs.writeFileSync(path.join(xdgRoot, "wtft", "pricing.json"), JSON.stringify({}));
globalThis.setInterval = (() => 1) as unknown as typeof setInterval;
try {
	for (const fn of events.session_start ?? []) await fn({}, ctx);
} finally {
	globalThis.setInterval = realSetInterval;
}
check(lookupModelPricing(MODEL) === null, "an entry deleted from pricing.json no longer prices the model at the next session_start");
check(lookupModelPricing("claude-opus-4-5") !== null, "the built-in rates survive the reload");

console.log("\nthe name --help and --version print");
const bundle = path.join(REPO, "bin", "wtft.mjs");
check(fs.existsSync(bundle), "fixture precondition: the CLI bundle is built");
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cli = (arg: string) => plain(execFileSync(process.execPath, [bundle, arg], { encoding: "utf8", env: { ...process.env } }));
check(/^wtft \d/.test(cli("--version")), `wtft --version starts with wtft (${cli("--version").split("\n")[0]})`);
check(/^wtft - /.test(cli("--help")), `wtft --help starts with wtft (${cli("--help").split("\n")[0]})`);
for (const flag of ["--version", "--help"]) {
	notes.length = 0;
	await commands.wtft!.handler(flag, ctx);
	const first = plain(notes.map((n) => n.text).join("\n")).split("\n")[0];
	check(first.startsWith("/wtft "), `/wtft ${flag} starts with /wtft (${first})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

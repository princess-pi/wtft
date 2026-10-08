#!/usr/bin/env bun
/**
 * The Pi widget's refresh timer ends with its session: `session_shutdown` clears it, so no tick
 * reaches a ctx Pi has retired, and the next `session_start` arms a fresh one.
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

const xdgRoot = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-381-")));
process.env.XDG_CONFIG_HOME = xdgRoot;
process.env.PRINCESS_PI_CONFIG_NO_WALKUP = "1";

const events: Record<string, ((event: unknown, ctx: unknown) => Promise<void> | void)[]> = {};
const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
const pi: any = {
	on: (name: string, fn: (event: unknown, ctx: unknown) => void) => { (events[name] ??= []).push(fn); },
	registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands[name] = def; },
	registerFlag: () => {},
	getFlag: () => undefined,
};

const STALE = "This extension ctx is stale after session replacement or reload.";
function makeCtx() {
	const draws: (string[] | undefined)[] = [];
	let retired = false;
	let touchedRetired = 0;
	const live: any = {
		ui: {
			setWidget: (_id: string, lines: string[] | undefined) => { draws.push(lines); },
			notify: () => {},
			custom: async () => {},
		},
		sessionManager: { getSessionFile: () => undefined, buildSessionContext: () => ({}) },
	};
	const ctx = new Proxy(live, {
		get(target, key) {
			if (retired) { touchedRetired++; throw new Error(STALE); }
			return target[key];
		},
	});
	return { ctx, draws, retire: () => { retired = true; }, touchedRetired: () => touchedRetired };
}

let nextHandle = 1;
const timers = new Map<number, () => void>();
const cleared: number[] = [];
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = ((fn: () => void) => { const h = nextHandle++; timers.set(h, fn); return h; }) as unknown as typeof setInterval;
globalThis.clearInterval = ((h: number) => { cleared.push(h); timers.delete(h); }) as unknown as typeof clearInterval;
const tickAll = () => { for (const fn of [...timers.values()]) fn(); };

const fire = async (name: string, event: unknown, ctx: unknown) => { for (const fn of events[name] ?? []) await fn(event, ctx); };

const wtftExtension = (await import("../extensions/wtft.ts")).default;
wtftExtension(pi);
await commands.wtft!.handler("", makeCtx().ctx);

console.log("\nsession_shutdown ends the refresh timer");
const first = makeCtx();
await fire("session_start", { type: "session_start", reason: "startup" }, first.ctx);
check(timers.size === 1, "V1 fixture precondition: session_start arms one refresh timer");
const firstTick = [...timers.values()][0]!;
const drawsBefore = first.draws.length;
tickAll();
check(first.draws.length > drawsBefore && Array.isArray(first.draws.at(-1)), "V1 fixture precondition: a tick draws the widget on the live ctx");

await fire("session_shutdown", { type: "session_shutdown", reason: "new" }, first.ctx);
check(timers.size === 0 && cleared.length === 1, `V2 session_shutdown clears the refresh timer (armed ${timers.size}, cleared ${cleared.length})`);

first.retire();
let thrown: unknown = null;
try { firstTick(); } catch (err) { thrown = err; }
check(thrown === null && first.touchedRetired() === 0, `V3 the first timer's callback, run after shutdown, does not reach the retired ctx (touched ${first.touchedRetired()}, ${thrown instanceof Error ? thrown.message : "no throw"})`);

thrown = null;
try { await fire("session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx); } catch (err) { thrown = err; }
check(thrown === null && cleared.length === 1, `V4 a second session_shutdown is a no-op (cleared ${cleared.length}, ${thrown instanceof Error ? thrown.message : "no throw"})`);

console.log("\nthe next session arms its own timer");
const second = makeCtx();
await fire("session_start", { type: "session_start", reason: "new" }, second.ctx);
check(timers.size === 1, `V5 the new session arms a fresh refresh timer (armed ${timers.size})`);
const secondBefore = second.draws.length;
thrown = null;
try { tickAll(); } catch (err) { thrown = err; }
check(thrown === null && second.draws.length > secondBefore && Array.isArray(second.draws.at(-1)), `V5 its tick draws with the new ctx (${thrown instanceof Error ? thrown.message : "no throw"})`);

globalThis.setInterval = realSetInterval;
globalThis.clearInterval = realClearInterval;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

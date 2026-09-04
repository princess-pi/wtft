#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test wtft-74-budget-flag-parsing
 * @description `/budget`'s negating flags must SET, not toggle (#74).
 *
 *   THE DEFECT. The handler decided which flag it had with
 *   `trimmed.includes("-w")` on the raw argument string. `"--no-widget"`
 *   contains the substring `-w`, so it entered the `--widget` arm; that arm
 *   then looked for an EXACT `--widget`/`-w` token, found none, took
 *   `parts[-1 + 1]` — the whole `"--no-widget"` string — as its value, matched
 *   neither `on` nor `off`, and fell to the toggle branch. The
 *   `else if (includes("--no-widget"))` arm below it was unreachable. Same
 *   shape for `--no-footer`, which contains `-f`.
 *
 *   WHY "TOGGLE" AND NOT "TURNS IT ON". Measured before the fix, twice from
 *   each starting state — the only way to tell a toggle from a set:
 *
 *     --no-widget from ON:   true -> false -> true
 *     --no-widget from OFF:  false -> true -> false
 *     --widget off from ON:  true -> false -> false   (correct, for contrast)
 *
 *   A single run from ON looks exactly like a correct `off`. That is why this
 *   suite runs every negating flag TWICE and from BOTH starting states: a
 *   one-run, one-direction check passes against the defect.
 *
 *   The assertion is on what lands in token-budget.json, not on the render —
 *   the render needs a live TUI, and the write happens first regardless.
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";

const GREEN = "\x1b[32m", RED = "\x1b[31m", RESET = "\x1b[0m";
let passed = 0, failed = 0;

async function check(label: string, fn: () => Promise<void> | void) {
	try { await fn(); console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	catch (err) {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		console.log(`       ${(err as Error).message.split("\n")[0]}`);
		failed++;
	}
}

const REPO = path.resolve(import.meta.dirname, "..");
const xdgRoot = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-74-")));
process.env.XDG_CONFIG_HOME = xdgRoot;
const configPath = path.join(xdgRoot, "princess-pi-tools", "token-budget.json");

/** Everything the handler touches on ctx is proxied away; only the config write
 *  is observable, which is the half this suite is about. */
function permissiveMock(): any {
	const handler: ProxyHandler<any> = {
		get: (_t, prop) => prop === "then" ? undefined : new Proxy(function () { return permissiveMock(); }, handler),
		apply: () => permissiveMock(),
	};
	return new Proxy(function () {}, handler);
}

const registered: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
const mockPi: any = {
	on: () => {},
	registerCommand: (name: string, def: any) => { registered[name] = def; },
	registerFlag: () => {},
	getFlag: () => undefined,
};

const tokenBudget = (await import(path.join(REPO, "extensions", "token-budget.ts"))).default;
await tokenBudget(mockPi);

function seed(settings: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n");
}
function read(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(configPath, "utf8"));
}
/** The write precedes the render, and the render throws without a live TUI. */
async function budget(args: string): Promise<void> {
	try { await registered.budget.handler(args, permissiveMock()); } catch { /* render stage */ }
}

console.log("🏃 /budget negating flags SET rather than toggle (#74)\n");

console.log("1. --no-widget");
for (const start of [true, false]) {
	await check(`--no-widget from widget:${start} lands on false`, async () => {
		seed({ widget: start, footer: true });
		await budget("--no-widget");
		assert.strictEqual(read().widget, false, `after one run from ${start}`);
	});
	await check(`--no-widget from widget:${start} is idempotent — twice is still false`, async () => {
		seed({ widget: start, footer: true });
		await budget("--no-widget");
		await budget("--no-widget");
		assert.strictEqual(read().widget, false, `after two runs from ${start}`);
	});
}

console.log("\n2. --no-footer — the same substring defect, via `-f`");
for (const start of [true, false]) {
	await check(`--no-footer from footer:${start} is idempotent — twice is still false`, async () => {
		seed({ widget: true, footer: start });
		await budget("--no-footer");
		await budget("--no-footer");
		assert.strictEqual(read().footer, false, `after two runs from ${start}`);
	});
}

console.log("\n3. The flags that already worked keep working");
await check("--widget off is idempotent", async () => {
	seed({ widget: true, footer: true });
	await budget("--widget off");
	await budget("--widget off");
	assert.strictEqual(read().widget, false);
});
await check("--widget on is idempotent", async () => {
	seed({ widget: false, footer: true });
	await budget("--widget on");
	await budget("--widget on");
	assert.strictEqual(read().widget, true);
});
await check("-w off / -f off aliases still resolve", async () => {
	seed({ widget: true, footer: true });
	await budget("-w off -f off");
	assert.strictEqual(read().widget, false, "widget");
	assert.strictEqual(read().footer, false, "footer");
});
await check("bare /budget still toggles the widget, both ways", async () => {
	seed({ widget: true, footer: true });
	await budget("");
	assert.strictEqual(read().widget, false, "on -> off");
	await budget("");
	assert.strictEqual(read().widget, true, "off -> on");
});
await check("a negating flag does not disturb the other setting", async () => {
	seed({ widget: true, footer: true });
	await budget("--no-widget");
	assert.strictEqual(read().footer, true, "footer must survive --no-widget");
});
await check("--widget off --no-footer sets BOTH, rather than toggling footer", async () => {
	seed({ widget: true, footer: false });
	await budget("--widget off --no-footer");
	assert.strictEqual(read().widget, false, "widget");
	assert.strictEqual(read().footer, false, "footer started false and must stay false");
});

// ---
// 4. `/wtft --show` — filed in #74 as a parsed no-op, which was WRONG.
//
//    `showWidget` really is parsed, returned by parseWtftCliArgs, and never
//    read by the handler (extensions/wtft.ts). Reading the code, that looks
//    like half an implemented flag pair. Running it says otherwise: `--hide`
//    short-circuits with setWidget(undefined), and `--show` falls through to
//    the ordinary render, which sets the widget — so it does exactly what its
//    name says, by being the default path rather than a branch.
//
//    So there is nothing to fix and something to PIN. Without an assertion the
//    dead variable invites the same wrong bug report again, and a future early
//    return for `--show` would break it silently. The claim asserted is the one
//    that is actually true: `--show` is indistinguishable from bare `/wtft`,
//    and neither hides.
// ---
console.log("\n4. --show is the default render path, not a no-op and not a hide");
{
	const wtftExt = (await import(path.join(REPO, "extensions", "wtft.ts"))).default;
	const wtftRegistered: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	await wtftExt({
		on: () => {},
		registerCommand: (name: string, def: any) => { wtftRegistered[name] = def; },
		registerFlag: () => {},
		getFlag: () => undefined,
	} as any);

	/** Run `/wtft <args>` and report whether it HID the widget, and whether it
	 *  reached the render (which throws headless — no live TUI). */
	async function outcome(args: string): Promise<{ hid: boolean; reachedRender: boolean }> {
		let hid = false;
		const recordingCtx: any = new Proxy(permissiveMock(), {
			get: (target, prop) => {
				if (prop !== "ui") return Reflect.get(target, prop);
				return new Proxy(permissiveMock(), {
					get: (_t, uiProp) => uiProp === "setWidget"
						? (_name: string, lines: unknown) => { if (lines === undefined) hid = true; }
						: permissiveMock(),
				});
			},
		});
		let reachedRender = false;
		try { await wtftRegistered.wtft.handler(args, recordingCtx); }
		catch { reachedRender = true; }
		return { hid, reachedRender };
	}

	const hide = await outcome("--hide");
	const show = await outcome("--show");
	const shortShow = await outcome("-S");
	const bare = await outcome("");

	await check("--hide hides the widget and returns cleanly", () => {
		assert.strictEqual(hide.hid, true, "expected setWidget(…, undefined)");
		assert.strictEqual(hide.reachedRender, false, "--hide must short-circuit before the render");
	});
	await check("--show does NOT hide the widget", () => {
		assert.strictEqual(show.hid, false);
	});
	await check("--show is indistinguishable from bare /wtft", () => {
		assert.deepStrictEqual(show, bare, "--show must take the ordinary render path");
	});
	await check("-S is indistinguishable from --show", () => {
		assert.deepStrictEqual(shortShow, show);
	});
}

console.log(`\n${failed === 0 ? GREEN : RED}${passed} passed, ${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

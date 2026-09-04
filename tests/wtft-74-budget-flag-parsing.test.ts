#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test wtft-74-budget-flag-parsing
 * @description `/budget`'s negating flags must SET, not toggle (#74) — plus a
 *   pin on `/wtft --show`/`--hide` (§4), which is a different command's widget
 *   and is here because #74 filed a claim about it that turned out to be wrong.
 *
 *   THE DEFECT. The handler chose its branch with
 *   `trimmed.includes("--widget") || trimmed.includes("-w")`. The first
 *   disjunct is innocent — `--widget` is not a substring of `--no-widget`,
 *   which has one dash before `widget`. The second is not: `"--no-widget"`
 *   contains `-w` inside `-widget`. So `--no-widget` entered the `--widget`
 *   arm, which looked for an EXACT `--widget`/`-w` token, found none, and read
 *   `parts[-1 + 1]` — `parts[0]`, the first token, which is the flag itself
 *   only when it is the sole one. Matching neither `on` nor `off`, it fell to
 *   the toggle, leaving the `--no-widget` arm below unreachable.
 *   `--no-footer` contains `-f` inside `-footer`: same defect.
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
 *   The assertion is on what lands in token-budget.json, not on the render.
 *   `updateTokenBudgetWidget` catches its own errors and degrades to an error
 *   widget, so the handler returns normally under a mock — measured, not
 *   assumed. The config write happens first regardless.
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
/** The write precedes the render (`writeConfig` then `updateTokenBudgetWidget`),
 *  so the config is settled whatever the render does.
 *
 *  Measured: this handler returns NORMALLY under the mock — `updateTokenBudget
 *  Widget` wraps its whole body and degrades to an error widget rather than
 *  throwing. An earlier version of this comment said the render throws and
 *  wrapped the call in a silent catch; the catch never fired, so it was
 *  describing a mechanism that does not occur while also hiding any real throw
 *  that might start to. The call is bare now, and a throw fails the check. */
async function budget(args: string): Promise<void> {
	await registered.budget.handler(args, permissiveMock());
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
//    From the source it looked like half an implemented pair: `--hide` had a
//    branch, `--show` set a field nothing read. Running it says otherwise —
//    `--hide` short-circuits with setWidget(undefined), and `--show` falls
//    through to the ordinary render, which sets the widget WITH LINES. It does
//    what its name says by being the default path rather than a branch.
//
//    The dead field is now gone from the parser (the flag stays accepted, so
//    `-S` is never an unknown-flag error), because the field was the false
//    signal that produced the wrong report. `CONTEXT.md` still calls `-S`/`-H`
//    a toggle pair, which is wrong in the other direction — #79.
//
//    THE ASSERTION IS ON A VISIBLE WIDGET, not on "not hidden". An earlier cut
//    of this section could only see that the render THREW — the mock's Proxy
//    reaching node:path — so it compared `--show` to bare `/wtft` and inferred
//    the rest. A review pointed out that proves only "`--show` is not
//    `--hide`": had both early-returned, they would still have matched. Giving
//    the mock a real session to read lets the render finish, so the widget
//    arriving is observed rather than deduced.
// ---
console.log("\n4. --show renders the widget; --hide clears it");
{
	const wtftExt = (await import(path.join(REPO, "extensions", "wtft.ts"))).default;
	const wtftRegistered: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	await wtftExt({
		on: () => {},
		registerCommand: (name: string, def: any) => { wtftRegistered[name] = def; },
		registerFlag: () => {},
		getFlag: () => undefined,
	} as any);

	// One real turn, so the renderer has something to render. Without it the
	// render aborts early and every observation below is of the abort.
	const wtftSession = path.join(trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-74-sess-"))), "session.jsonl");
	fs.writeFileSync(wtftSession, JSON.stringify({
		type: "assistant",
		message: {
			role: "assistant", id: "msg_74_001", model: "claude-sonnet-4-20250514",
			timestamp: new Date().toISOString(),
			usage: { input_tokens: 1000, output_tokens: 250 },
			content: [{ type: "tool_use", name: "bash", input: { command: "ls" } }],
		},
	}) + "\n");

	/** Run `/wtft <args>` and report what it did to the widget: "cleared" for
	 *  setWidget(…, undefined), "rendered" for setWidget(…, lines), "" for
	 *  neither. A thrown error is returned rather than swallowed, so a render
	 *  that breaks shows up as itself instead of as a missing widget. */
	async function widgetEffect(args: string): Promise<{ effect: string; error: string }> {
		let effect = "";
		const recordingCtx: any = new Proxy(permissiveMock(), {
			get: (target, prop) => {
				if (prop === "sessionManager") {
					return { getCurrentSession: () => ({ id: "s74", path: wtftSession, filePath: wtftSession }),
					         getSessionPath: () => wtftSession };
				}
				if (prop !== "ui") return Reflect.get(target, prop);
				return new Proxy(permissiveMock(), {
					get: (_t, uiProp) => uiProp === "setWidget"
						? (_name: string, lines: unknown) => { effect = lines === undefined ? "cleared" : "rendered"; }
						: permissiveMock(),
				});
			},
		});
		let error = "";
		try { await wtftRegistered.wtft.handler(args, recordingCtx); }
		catch (err) { error = (err as Error).message; }
		return { effect, error };
	}

	const hide = await widgetEffect("--hide");
	const show = await widgetEffect("--show");
	const shortShow = await widgetEffect("-S");
	const bare = await widgetEffect("");

	await check("--hide clears the widget", () => {
		assert.strictEqual(hide.error, "", `unexpected throw: ${hide.error}`);
		assert.strictEqual(hide.effect, "cleared");
	});
	await check("--show RENDERS the widget — it is not a no-op", () => {
		assert.strictEqual(show.error, "", `unexpected throw: ${show.error}`);
		assert.strictEqual(show.effect, "rendered", "expected setWidget(…, lines)");
	});
	await check("-S renders it too", () => {
		assert.strictEqual(shortShow.effect, "rendered");
	});
	await check("--show matches bare /wtft — it is the default path, not a branch", () => {
		assert.deepStrictEqual(show, bare);
	});
}

console.log(`\n${failed === 0 ? GREEN : RED}${passed} passed, ${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env -S node --experimental-strip-types
/**
 * All four columns by default. --no-cost and --no-tokens hide a pair and leave the bar.
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigPaths } from "@princess-pi/libs/config";
import { buildWtftLines } from "../extensions/lib/wtft-renderer.ts";
import { parseWtftCliArgs } from "../extensions/lib/wtft-cli-shared.ts";
import { WTFT_CONFIG_DIR, WTFT_CONFIG_TOOL } from "../extensions/lib/wtft-config-dir.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

function mockIx(cost: number, timestamp: number): any {
	return {
		timestamp,
		cost,
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		files: [{ path: "/tmp/spec.md", action: "read" as const }],
		commands: [],
		texts: [],
		unrecognizedTool: false,
		serverToolCost: 0,
	};
}

const hour = 60 * 60 * 1000;
const t0 = Date.parse("2026-09-26T10:00:00Z");
const ix = [mockIx(1, t0), mockIx(2, t0 + hour)];
const settings = { interval: "1h", limit: 10, width: 80, mode: "cumulative" as const, disabledEmoji: true };

function row(lines: string[] | null): string {
	const found = (lines ?? []).map(l => l.replace(/\x1b\[[0-9;]*m/g, "")).find(l => /^\d\d:\d\d/.test(l.trim()));
	if (!found) throw new Error(`no bin row in:\n${(lines ?? []).join("\n")}`);
	return found;
}

console.log("--- default columns, four presets ---");
for (const [unit, mode] of [["cost", "cumulative"], ["cost", "bucket"], ["tokens", "cumulative"], ["tokens", "bucket"]] as const) {
	const line = row(buildWtftLines(ix, settings, { unit, mode }));
	check(line.includes("+$2.00"), `${unit} ${mode} prints incremental cost`);
	check(line.includes("$3.00"), `${unit} ${mode} prints total cost`);
	check(line.includes("+1.5k"), `${unit} ${mode} prints incremental tokens`);
	check(line.includes("3.0k tok"), `${unit} ${mode} prints total tokens`);
	if (unit === "tokens" && mode === "cumulative") {
		check(line.includes("▇") || line.includes("▃"), `${unit} ${mode} keeps the recency glyph`);
	} else if (unit === "cost" && mode === "bucket") {
		check(/\s{2,}█/.test(line), `${unit} ${mode} keeps a scatter mark`);
	} else {
		check(line.includes("█"), `${unit} ${mode} keeps a full-block bar`);
	}
}

console.log("--- --no-cost leaves the cost bar and the token columns ---");
const noCost = row(buildWtftLines(ix, settings, { unit: "cost", mode: "cumulative", showCostColumns: false }));
check(!noCost.includes("+$") && !noCost.includes("$3.00"), "--no-cost drops both cost columns");
check(noCost.includes("+1.5k"), "--no-cost keeps incremental tokens");
check(noCost.includes("3.0k tok"), "--no-cost keeps total tokens");
check(noCost.includes("█"), "--no-cost keeps the bar");

console.log("--- --no-tokens on the same cost bar ---");
const noTok = row(buildWtftLines(ix, settings, { unit: "cost", mode: "cumulative", showTokenColumns: false }));
check(!noTok.includes("tok"), "--no-tokens drops the token columns");
check(noTok.includes("+$2.00"), "--no-tokens keeps incremental cost");
check(noTok.includes("$3.00"), "--no-tokens keeps total cost");
check(noTok.includes("█"), "--no-tokens keeps the cost bar");

console.log("--- both flags leave the bar and no numbers ---");
const neither = row(buildWtftLines(ix, settings, { unit: "cost", showCostColumns: false, showTokenColumns: false }));
check(!neither.includes("$"), "both flags drop the cost numbers");
check(!neither.includes("tok"), "both flags drop the token numbers");
check(neither.includes("█"), "both flags keep the bar");

console.log("--- the flags do not flip the bar ---");
const parsed = parseWtftCliArgs(["--cost", "--no-cost", "--no-tokens"]);
check(parsed.hasCost && parsed.cost, "--cost still selects a cost bar beside --no-cost");
check(parsed.hideCostColumns, "--no-cost is its own switch");
check(parsed.hideTokenColumns, "--no-tokens is its own switch");
const bothOrders = parseWtftCliArgs(["--no-tokens", "--tokens"]);
check(bothOrders.hasTokens && bothOrders.tokens, "--tokens still selects a token bar beside --no-tokens");
check(bothOrders.hideTokenColumns, "--no-tokens stays set when --tokens is also passed");

console.log("--- a 40-column chart keeps the bar ---");
const narrow = { ...settings, width: 40 };
const narrowCost = row(buildWtftLines(ix, narrow, { unit: "cost", mode: "cumulative" }));
check(!narrowCost.includes("tok"), "width 40 drops the token columns before the bar");
check(narrowCost.includes("+$2.00") && narrowCost.includes("$3.00"), "width 40 keeps the cost columns when they fit");
check(narrowCost.includes("█"), "width 40 keeps the cost bar");
const narrowPlain = (buildWtftLines(ix, narrow, { unit: "cost", mode: "cumulative" }) ?? [])
	.map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));
check(narrowPlain.some(l => l.includes("$0")), "width 40 keeps the scale line");
const narrowTok = row(buildWtftLines(ix, narrow, { unit: "tokens", mode: "cumulative" }));
check(narrowTok.includes("▇") || narrowTok.includes("▃"), "width 40 keeps the recency glyph");
const big = [mockIx(100000, t0), mockIx(100000, t0 + hour)];
const squeezed = row(buildWtftLines(big, narrow, { unit: "cost", mode: "cumulative" }));
check(!squeezed.includes("$"), "width 40 drops every number column when they do not fit");
check(squeezed.includes("█"), "width 40 still draws the bar after dropping every column");

console.log("--- the Pi widget hides for the process and does not write it ---");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-284-"));
const prevCwd = process.cwd();
const prevXdg = process.env.XDG_CONFIG_HOME;
const prevState = process.env.XDG_STATE_HOME;
process.chdir(sandbox);
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.XDG_STATE_HOME = path.join(sandbox, "state");
fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
const configPath = getConfigPaths(WTFT_CONFIG_TOOL, WTFT_CONFIG_DIR).global;
const { WTFT_TAGGER_VERSION } = await import("../extensions/lib/wtft-tagger-version.ts");
const registered: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
const handlers: Record<string, (event: unknown, ctx: any) => Promise<void> | void> = {};
const wtftExtension = (await import("../extensions/wtft.ts")).default;
await wtftExtension({
	on: (name: string, fn: any) => { handlers[name] = fn; },
	registerCommand: (name: string, def: any) => { registered[name] = def; },
	registerFlag: () => {},
	getFlag: () => undefined,
});
const bare = path.join(sandbox, "bare", "session.jsonl");
fs.mkdirSync(path.dirname(bare), { recursive: true });
fs.writeFileSync(bare, "{}\n");
function box() { return { widget: [] as Array<string | undefined> }; }
function ctxFor(session: string, drawn: ReturnType<typeof box>) {
	return {
		sessionManager: { getSessionFile: () => session },
		ui: {
			setWidget: (_id: string, lines: string[] | undefined) => {
				drawn.widget.push(lines === undefined ? undefined : lines.join("\n"));
			},
			notify: () => {},
			custom: async () => {},
		},
	};
}
await registered.wtft.handler("--hide", ctxFor(bare, box()));
check(!fs.existsSync(configPath), "/wtft --hide does not create a config");
await registered.wtft.handler("-p", ctxFor(bare, box()));
check(!fs.existsSync(configPath), "/wtft -p does not create a config");

const sessionDir = path.join(sandbox, "sess");
fs.mkdirSync(path.join(sessionDir, "wtft-tags"), { recursive: true });
const session = path.join(sessionDir, "session.jsonl");
fs.writeFileSync(session, "{}\n");
const tag = path.join(sessionDir, "wtft-tags", `session.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
const tagLine = (t: number, c: number) => JSON.stringify({
	t, c, cat: "code", f: [], cmd: [], id: `m-${t}`, m: "claude-sonnet-4-5",
	in: 1000, out: 500, cr: 0, cw: 0, rs: 0,
});
fs.writeFileSync(tag, `${tagLine(t0, 1)}\n${tagLine(t0 + hour, 2)}\n`);
function binText(parts: Array<string | undefined>): string {
	return parts.filter((part): part is string => typeof part === "string")
		.join("\n")
		.replace(/\x1b\[[0-9;]*m/g, "")
		.split("\n")
		.filter(l => /^\d\d:\d\d/.test(l.trim()))
		.join("\n");
}
async function render(args: string): Promise<string> {
	const drawn = box();
	await registered.wtft.handler(args, ctxFor(session, drawn));
	return binText(drawn.widget);
}
const shown = await render("-w 80");
check(shown.includes("+$2.00") && shown.includes("3.0k tok"), "a plain /wtft shows cost and token columns");
check(fs.existsSync(configPath), "a plain /wtft writes the config the hide checks read");
const withEmoji = await render("--no-emoji --no-cost -w 80");
check(!withEmoji.includes("$") && withEmoji.includes("tok") && withEmoji.includes("█"), "--no-emoji --no-cost still hides the cost columns");
const hidden = await render("--no-cost -w 80");
check(!hidden.includes("$") && hidden.includes("tok") && hidden.includes("█"), "--no-cost hides the cost columns on the widget");
const again = await render("--no-cost -w 80");
check(!again.includes("$") && again.includes("tok"), "passing --no-cost again keeps the cost columns hidden");
const settled = box();
await handlers.agent_settled(undefined, ctxFor(session, settled));
const settledRows = binText(settled.widget);
check(!settledRows.includes("$") && settledRows.includes("tok"), "a later refresh keeps the cost columns hidden");
const noTokWidget = await render("--no-tokens -w 80");
check(!noTokWidget.includes("$") && !noTokWidget.includes("tok") && noTokWidget.includes("█"), "--no-tokens hides the token columns and leaves the bar");
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
check(cfg.hideCostColumns === undefined && cfg.hideTokenColumns === undefined, "the hide is not written into the config");
process.chdir(prevCwd);
if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
else process.env.XDG_CONFIG_HOME = prevXdg;
if (prevState === undefined) delete process.env.XDG_STATE_HOME;
else process.env.XDG_STATE_HOME = prevState;
fs.rmSync(sandbox, { recursive: true, force: true });

assert.strictEqual(failed, 0, `${failed} failed`);
console.log(`\n${passed} passed`);

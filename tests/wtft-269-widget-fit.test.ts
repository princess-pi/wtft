#!/usr/bin/env -S node --experimental-strip-types
/**
 * The Pi widget never hands Pi more lines than Pi shows. docs/spec-269-widget-fit.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildWtftLines } from "../extensions/lib/wtft-renderer.ts";
import { PI_WIDGET_MAX_LINES, fitWidget, keepTail, widgetLines } from "../extensions/lib/widget-fit.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

function mockIx(cost: number, timestamp: number): any {
	return {
		timestamp, cost, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
		reasoningTokens: 0, files: [{ path: "/tmp/spec.md", action: "read" as const }], commands: [], texts: [],
		unrecognizedTool: false, serverToolCost: 0,
	};
}

const hour = 60 * 60 * 1000;
// 20 hourly intervals across midnight, so the chart carries a date divider.
const t0 = Date.parse("2026-09-26T09:00:00Z");
const ix = Array.from({ length: 20 }, (_, i) => mockIx(1, t0 + i * hour));
const settings = { interval: "1h", limit: 10, width: 60, mode: "cumulative" as const, disabledEmoji: true, timezone: "UTC" };
const plain = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");
// Wider than the widget, so it cannot sit on the title line.
const status = "  ● " + "status ".repeat(20);
const provisional = ["⚠ PROVISIONAL: a subagent is still being read"];

check(PI_WIDGET_MAX_LINES === 10, "Pi's cap on a string-array widget is 10 lines");

// The widget's own call: no isWidget, the widget's width from its settings.
const renderChart = (limit: number) => buildWtftLines(ix, settings, { limit, timezone: "UTC" });
const unfitted = widgetLines(renderChart(10)!, status, 60, provisional);
check(unfitted.length > PI_WIDGET_MAX_LINES, `fixture precondition: the unfitted widget overflows (${unfitted.length} lines)`);
check(unfitted.slice(4).some(l => /^── \w{3}-\d\d/.test(plain(l))), "fixture precondition: a date divider is in the chart");

const fitted = fitWidget(renderChart, status, 60, provisional, 10)!;
check(fitted.length <= PI_WIDGET_MAX_LINES, `the fitted widget has at most 10 lines (got ${fitted.length})`);
check(plain(fitted[0]!).includes("WTF Tokens?"), "line 1 is the title");
check(plain(fitted[1]!).includes("Plan") && plain(fitted[1]!).includes("Code"), "line 2 is the legend");
check(fitted.some(l => l === status.trim()), "the status line that does not fit the title is kept");
check(fitted[fitted.length - 1] === provisional[0], "the provisional line is kept");
const rows = fitted.map(plain).filter(l => /^\d\d:\d\d/.test(l));
const allRows = unfitted.map(plain).filter(l => /^\d\d:\d\d/.test(l));
check(rows.length > 0 && rows.every((r, i) => r === allRows[i]), "rows are dropped oldest-first: the newest rows stay, in order");

console.log("--- status that fits the title ---");
{
	const chart = buildWtftLines(ix.slice(0, 2), settings, { limit: 10 })!;
	const lines = widgetLines(chart, " ●", 60, []);
	check(lines.length === chart.length && plain(lines[0]!).endsWith(" ●"), "a short status joins the title line");
}

console.log("--- nothing fits ---");
{
	const huge = () => Array.from({ length: 30 }, (_, i) => `line ${i}`);
	const lines = fitWidget(huge, "", 60, provisional, 10)!;
	check(lines.length === 10 && lines[0] === "line 0" && lines[9] === provisional[0],
		"when even one row overflows, the top lines and the provisional line are kept");
	check(fitWidget(() => null, "", 60, [], 10) === null, "no chart stays no chart");
	let calls = 0;
	const nan = fitWidget(() => { calls++; return huge(); }, "", 60, [], Number.NaN);
	check(nan !== null && nan.length === 10 && calls <= 10, `a NaN limit ends (${calls} renders)`);
	check(keepTail(["a", "b", "c", "t"], 1, 3).join() === "a,b,t", "keepTail cuts from the middle");
}

console.log("--- the array the widget hands setWidget ---");
{
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-269-"));
	process.chdir(sandbox);
	process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
	process.env.XDG_STATE_HOME = path.join(sandbox, "state");
	fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
	const { WTFT_TAGGER_VERSION } = await import("../extensions/lib/wtft-tagger-version.ts");
	const registered: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
	const wtftExtension = (await import("../extensions/wtft.ts")).default;
	await wtftExtension({
		on: () => {}, registerCommand: (name: string, def: any) => { registered[name] = def; },
		registerFlag: () => {}, getFlag: () => undefined,
	} as any);
	const sessionDir = path.join(sandbox, "sess");
	fs.mkdirSync(path.join(sessionDir, "wtft-tags"), { recursive: true });
	const session = path.join(sessionDir, "session.jsonl");
	fs.writeFileSync(session, "{}\n");
	const tag = path.join(sessionDir, "wtft-tags", `session.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const tagLine = (tt: number) => JSON.stringify({ t: tt, c: 1, cat: "code", f: [], cmd: [], id: `m-${tt}`, m: "claude-sonnet-4-5", in: 1000, out: 500, cr: 0, cw: 0, rs: 0 });
	fs.writeFileSync(tag, ix.map(i => tagLine(i.timestamp)).join("\n") + "\n");
	const calls: Array<string[] | undefined> = [];
	await registered.wtft.handler("-w 80 -l 20 -i 1h", {
		sessionManager: { getSessionFile: () => session },
		ui: { setWidget: (_id: string, lines: string[] | undefined) => { calls.push(lines); }, notify: () => {}, custom: async () => {} },
	});
	const handed = calls.filter((c): c is string[] => Array.isArray(c)).at(-1) ?? [];
	check(handed.map(plain).some(l => /^\d\d:\d\d/.test(l)), "fixture precondition: the widget drew interval rows");
	check(handed.length <= PI_WIDGET_MAX_LINES, `setWidget got at most 10 lines with -l 20 over 20 intervals (got ${handed.length})`);
	check(plain(handed[0] ?? "").includes("WTF Tokens?") && plain(handed[1] ?? "").includes("Code"), "setWidget's first two lines are the title and legend");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

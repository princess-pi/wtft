#!/usr/bin/env -S bun
/**
 * tests/wtft-90-total-includes-server-tool-cost.test.ts — TOTAL means total (#90)
 *
 * Three surfaces reported a session's cost and two of them were short by the
 * session's server-side tool spend: `buildWtftLines` added `serverToolCost` to
 * the chart's `web` bin, while `computeSessionSummary` — which both
 * `renderTokenSummary` and `buildSessionJson` consume — summed `i.cost` alone.
 *
 * THE REASON IT SURVIVED is that no test compared the chart's total to either of
 * the other two, so this suite drives all three through the CLI exactly as the
 * issue's Repro does, and holds them to each other. A unit test over
 * `computeSessionSummary` would have re-passed on the day the bug was written.
 *
 * Direction A, decided 2026-09-15: the summary ADDS the cost, so all three
 * agree. The accepted consequence is that the `--tokens` TOTAL a reader sees
 * rises by that amount — which the deltas below pin to the cent.
 *
 * Run: bun tests/wtft-90-total-includes-server-tool-cost.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("90-server-tool-total");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_BIN = path.join(REPO_ROOT, "bin", "wtft.mjs");
const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-90-")));

/** $0.03 per request, Anthropic server-side tools (#73). */
const PER_REQUEST = 0.03;
const WEB_REQUESTS = 5;
const EXPECTED_WEB_COST = WEB_REQUESTS * PER_REQUEST; // $0.15

function usageLine(opts: { id: string; ts: string; cr?: number; cw?: number; web?: number }): string {
	const usage: Record<string, unknown> = {
		input_tokens: 100,
		output_tokens: 300,
		cache_read_input_tokens: opts.cr ?? 0,
		cache_creation_input_tokens: opts.cw ?? 0,
	};
	if (opts.web) usage.server_tool_use = { web_search_requests: opts.web };
	return JSON.stringify({
		type: "assistant",
		timestamp: opts.ts,
		cwd: "/tmp",
		message: {
			role: "assistant", id: opts.id, model: "claude-opus-5",
			content: [{ type: "text", text: "x" }],
			usage,
		},
	});
}

/** Two fixtures identical but for the server-tool requests on the middle turn.
 *  The PAIR is what makes the assertions non-vacuous: a difference of exactly
 *  $0.15 can only come from the meter this issue is about. */
function fixture(name: string, web: number): string {
	const at = path.join(dir, name);
	fs.writeFileSync(at, [
		usageLine({ id: "a", ts: "2026-07-01T12:00:00Z", cw: 10000 }),
		usageLine({ id: "b", ts: "2026-07-01T13:00:00Z", cr: 10000, web }),
		usageLine({ id: "c", ts: "2026-07-01T14:00:00Z", cr: 11000 }),
	].join("\n") + "\n");
	return at;
}

const withWeb = fixture("with-web.jsonl", WEB_REQUESTS);
const noWeb = fixture("no-web.jsonl", 0);

function cli(args: string[]): string {
	const r = spawnSync("node", [CLI_BIN, ...args], { encoding: "utf8", env: { ...process.env } });
	// Exit 9 is PROVISIONAL (a tag read at a superseded version), not a failure.
	if (r.status !== 0 && r.status !== 9) {
		throw new Error(`wtft ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
	}
	return (r.stdout || "").replace(/\x1b\[[0-9;]*m/g, "");
}

/** The chart's running total: the newest cumulative bin row, which is the
 *  rightmost number a reader's eye lands on. Rows are newest-first. */
function chartTotal(session: string): number {
	const out = cli(["-s", session, "-i", "1h", "-m", "cumulative"]);
	const row = out.split("\n").find(l => /^\s*\d\d:\d\d\s+\+\$/.test(l));
	if (!row) throw new Error(`no cumulative bin row in:\n${out}`);
	// "07:00  +$0.01  $0.25   ████" — the SECOND figure is the running total.
	const figures = [...row.matchAll(/\$([0-9.]+)/g)].map(m => Number(m[1]));
	if (figures.length < 2) throw new Error(`no running total in row: ${row}`);
	return figures[1];
}

/** The TOTAL row of `--tokens`, last column. */
function tokensTotal(session: string): number {
	const out = cli(["-s", session, "--tokens"]);
	const row = out.split("\n").find(l => /^\s*TOTAL\s/.test(l));
	if (!row) throw new Error(`no TOTAL row in:\n${out}`);
	const m = row.match(/\$([0-9.]+)\s*$/);
	if (!m) throw new Error(`no cost cell in TOTAL row: ${row}`);
	return Number(m[1]);
}

function json(session: string): any {
	return JSON.parse(cli(["-s", session, "--json"]));
}

console.log("--- TEST 1: the fixture really exercises the meter ---");
const docWeb = json(withWeb);
const docNone = json(noWeb);
const webCat = (d: any) => d.categories.find((c: any) => c.category === "web");
check(
	Math.abs(docWeb.total.costUsd - docNone.total.costUsd - EXPECTED_WEB_COST) < 1e-9,
	`${WEB_REQUESTS} web-search requests are worth exactly $${EXPECTED_WEB_COST.toFixed(2)} of difference`
);
check(
	Math.abs(webCat(docWeb).costUsd - webCat(docNone).costUsd - EXPECTED_WEB_COST) < 1e-9,
	"…and it lands in the `web` category, where the chart puts it"
);

console.log("--- TEST 2: the closer — all three surfaces agree ---");
for (const [name, session] of [["with server-tool spend", withWeb], ["without", noWeb]] as const) {
	const chart = chartTotal(session);
	const tokens = tokensTotal(session);
	const doc = json(session);
	// The chart and the table both round to cents; the document does not.
	check(
		Math.abs(chart - tokens) < 1e-9,
		`${name}: chart total $${chart.toFixed(2)} === --tokens TOTAL $${tokens.toFixed(2)}`
	);
	check(
		Math.abs(doc.total.costUsd - chart) < 0.005,
		`${name}: …and --json total.costUsd ${doc.total.costUsd} agrees to the cent they print`
	);
}

console.log("--- TEST 3: the one guarantee still holds ---");
// sum(models) === sum(categories) === total, with the cost-only addition in it.
for (const [name, doc] of [["with", docWeb], ["without", docNone]] as const) {
	const models = doc.models.reduce((s: number, m: any) => s + m.costUsd, 0);
	const cats = doc.categories.reduce((s: number, c: any) => s + c.costUsd, 0);
	check(Math.abs(models - doc.total.costUsd) < 1e-9, `${name}: sum(models.costUsd) === total.costUsd`);
	check(Math.abs(cats - doc.total.costUsd) < 1e-9, `${name}: sum(categories.costUsd) === total.costUsd`);
}

console.log("--- TEST 4: no token field moved ---");
// Server-side tool calls are billed per REQUEST, on a meter with no tokens on
// it (#73). A fix that touched a token field would be a different change.
for (const field of ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
	check(
		docWeb.total[field] === docNone.total[field],
		`${field} is identical with and without the web requests (${docWeb.total[field]})`
	);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

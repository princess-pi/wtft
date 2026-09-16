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
 * rises by the session's MODEL-TAGGED server-tool spend — tagged, because an
 * interaction with no model id is excluded from this summary before the addition
 * is reached, exactly as it is excluded from every other total here.
 *
 * Run: bun tests/wtft-90-total-includes-server-tool-cost.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { calculateServerToolCost } from "../bin/wtft.mjs";
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

const WEB_REQUESTS = 5;
/** ASKED, never re-typed (#495). A literal here would fail this suite the day the
 *  server-tool card moves, and the message would blame the meter rather than the
 *  stale constant — the exact duplication #495 removed from the renderer. */
const EXPECTED_WEB_COST = calculateServerToolCost("claude-opus-5", WEB_REQUESTS, 0);

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

/** Each invocation gets its OWN copy of the fixture (PR review).
 *
 *  Three surfaces read by three separate processes is a snapshot comparison, not
 *  a single-state one: a provisional read is defined as one whose total MAY STILL
 *  GROW under the daemon, and the first run's tag repair would legitimately move
 *  the second run's number — which a 1e-9 equality forbids. A fresh file per run
 *  means every surface reads the same state, from nothing. (The sibling #26 suite
 *  hit this and fixed it the same way.) */
let runSeq = 0;
function cli(source: string, args: string[]): string {
	const copy = path.join(dir, `run-${runSeq++}-${path.basename(source)}`);
	fs.copyFileSync(source, copy);
	const r = spawnSync("node", [CLI_BIN, "-s", copy, ...args], { encoding: "utf8", env: { ...process.env } });
	// Exit 9 is PROVISIONAL — a report in full, whose total may still grow. It is
	// not a failure, and a fresh fixture is what keeps it from being a moving one.
	if (r.status !== 0 && r.status !== 9) {
		throw new Error(`wtft -s <copy> ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
	}
	return (r.stdout || "").replace(/\x1b\[[0-9;]*m/g, "");
}

/** The chart's running total: the newest cumulative bin row, which is the
 *  rightmost number a reader's eye lands on. Rows are newest-first. */
function chartTotal(session: string): number {
	// DOCUMENTED SPELLINGS ONLY (PR review). `-m cumulative` is not a flag:
	// `--cumulative`/`-c` and `--bucket`/`-b` are, and `parseWtftCliArgs` ignores
	// an unknown flag silently (#91) — so the first cut of this passed without
	// the mode ever having been honoured, on a default that happened to match.
	const out = cli(session, ["--interval", "1h", "--cumulative"]);
	const row = out.split("\n").find(l => /^\s*\d\d:\d\d\s+\+\$/.test(l));
	if (!row) throw new Error(`no cumulative bin row in:\n${out}`);
	// "07:00  +$0.01  $0.25   ████" — the SECOND figure is the running total.
	const figures = [...row.matchAll(/\$([0-9.]+)/g)].map(m => Number(m[1]));
	if (figures.length < 2) throw new Error(`no running total in row: ${row}`);
	return figures[1];
}

/** The TOTAL row of `--tokens`, last column. */
function tokensTotal(session: string): number {
	const out = cli(session, ["--tokens"]);
	const row = out.split("\n").find(l => /^\s*TOTAL\s/.test(l));
	if (!row) throw new Error(`no TOTAL row in:\n${out}`);
	// The cell carries a trailing `?` when any model in the session has no rate
	// card, so the anchor accepts it — otherwise this helper THROWS and aborts the
	// suite the day the fixture's model ages out of the registry (PR review).
	const m = row.match(/\$([0-9.]+)\??\s*$/);
	if (!m) throw new Error(`no cost cell in TOTAL row: ${row}`);
	return Number(m[1]);
}

function json(session: string): any {
	return JSON.parse(cli(session, ["--json"]));
}

console.log("--- TEST 0: the gate is not vacuous ---");
// Every assertion below is a DIFFERENCE. If the meter prices this fixture at $0
// — the model ages out of the server-tool card, the argument order changes, the
// parser stops populating serverToolCost — every one of them holds trivially
// with the divergence fully restored, and the suite exits 0 reporting success.
check(EXPECTED_WEB_COST > 0, `the meter prices ${WEB_REQUESTS} web-search requests above zero ($${EXPECTED_WEB_COST})`);

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
	// BOTH scraped figures carry CENT precision — `formatCost` gives two decimals
	// — so every comparison here resolves to half a cent, and saying `1e-9` would
	// have read as exactness the strings cannot carry (PR review). The exact
	// arithmetic is pinned by TEST 1 and TEST 3, on the document.
	check(
		Math.abs(chart - tokens) < 0.005,
		`${name}: chart total $${chart.toFixed(2)} === --tokens TOTAL $${tokens.toFixed(2)}, to the cent both print`
	);
	check(
		Math.abs(doc.total.costUsd - chart) < 0.005,
		`${name}: …and --json total.costUsd ${doc.total.costUsd} agrees with them`
	);
}

console.log("--- TEST 2b: the rise lands on the surface the decision was about ---");
// Asserted directly rather than inferred. TEST 2 bounds the --tokens delta only
// transitively, at ±0.01 — two cents of slack for a claim stated in cents.
check(
	Math.abs(tokensTotal(withWeb) - tokensTotal(noWeb) - EXPECTED_WEB_COST) < 0.005,
	`--tokens TOTAL itself rose by $${EXPECTED_WEB_COST.toFixed(2)}`
);

console.log("--- TEST 3: the one guarantee still holds ---");
// sum(models) === sum(categories) === total, with the cost-only addition in it.
for (const [name, doc] of [["with", docWeb], ["without", docNone]] as const) {
	const models = doc.models.reduce((s: number, m: any) => s + m.costUsd, 0);
	const cats = doc.categories.reduce((s: number, c: any) => s + c.costUsd, 0);
	check(Math.abs(models - doc.total.costUsd) < 1e-9, `${name}: sum(models.costUsd) === total.costUsd`);
	check(Math.abs(cats - doc.total.costUsd) < 1e-9, `${name}: sum(categories.costUsd) === total.costUsd`);
}

console.log("--- TEST 3b: the WARM path, which is what a user actually hits ---");
// Every run above copies the fixture first, so all of them read a session with
// no tag file — the cold, freshly-parsed path. The steady state is the other
// one: `readClassifiedTagFile` rebuilds an Interaction field by field from what
// the tag writer chose to persist, so a `serverToolCost` that did not survive
// that projection would revert to the pre-#90 numbers on every run after the
// first, and a suite that always starts from nothing could never see it (PR
// review). It does survive — written as `sc`, read back as `serverToolCost` —
// and this is what holds it to that.
const warmFixture = path.join(dir, "warm.jsonl");
fs.copyFileSync(withWeb, warmFixture);
const warmRuns = [1, 2, 3].map(() => {
	const r = spawnSync("node", [CLI_BIN, "-s", warmFixture, "--json"], { encoding: "utf8" });
	if (r.status !== 0 && r.status !== 9) throw new Error(`warm run exited ${r.status}: ${r.stderr}`);
	return JSON.parse((r.stdout || "").replace(/\x1b\[[0-9;]*m/g, ""));
});
check(
	warmRuns.every(d => Math.abs(d.total.costUsd - docWeb.total.costUsd) < 1e-9),
	`three runs against the SAME fixture agree with the cold one ($${warmRuns.map(d => d.total.costUsd).join(", $")})`
);
check(
	warmRuns.every(d => {
		const w = d.categories.find((c: any) => c.category === "web");
		return Math.abs(w.costUsd - EXPECTED_WEB_COST) < 1e-9;
	}),
	"…and the web category still carries the server-tool cost after the round-trip"
);

console.log("--- TEST 4: no token field moved ---");
// Server-side tool calls are billed per REQUEST, on a meter with no tokens on
// it (#73). A fix that touched a token field would be a different change.
for (const field of ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
	check(
		docWeb.total[field] === docNone.total[field],
		`${field} is identical with and without the web requests (${docWeb.total[field]})`
	);
}

console.log("--- TEST 5: an untagged turn, and a harness-native cost ---");
// F5 — every fixture above tags each turn, so the chart's population and the
// summary's are identical and the documented remaining divergence (untagged
// spend) is exercised at zero. This one has a `<synthetic>` turn, so the two
// populations differ and the scope of "all three agree" becomes real.
const withUntagged = path.join(dir, "untagged.jsonl");
fs.writeFileSync(withUntagged, [
	usageLine({ id: "u_a", ts: "2026-07-01T12:00:00Z", cw: 10000 }),
	usageLine({ id: "u_b", ts: "2026-07-01T13:00:00Z", cr: 10000, web: WEB_REQUESTS }),
	// No model id — counted in untaggedInteractions and in no total here.
	JSON.stringify({
		type: "assistant", timestamp: "2026-07-01T14:00:00Z", cwd: "/tmp",
		message: {
			role: "assistant", id: "u_untagged", model: "<synthetic>",
			content: [{ type: "text", text: "x" }],
			usage: { input_tokens: 100, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000 },
		},
	}),
].join("\n") + "\n");
const docUntagged = json(withUntagged);
check(docUntagged.untaggedInteractions >= 1, `the untagged turn is counted as such (${docUntagged.untaggedInteractions})`);
check(
	Math.abs(webCat(docUntagged).costUsd - EXPECTED_WEB_COST) < 1e-9,
	"…the tagged turn's server-tool cost still lands in `web`"
);
check(
	docUntagged.total.costUsd < docWeb.total.costUsd + 0.05,
	"…and the untagged turn's own spend stays OUT of total.costUsd, as documented"
);

// F2 — the one assumption this change makes: `i.cost` does not already contain
// the server-tool charge. A harness-native per-turn cost is used UNCHANGED, so a
// harness that bills web search inside it would be summed twice. What this pins
// is how far away that is: `nativeCost` comes from Pi's adapter alone, Claude
// Code's pins it `null`, and `calculateServerToolCost` bills only identifiable
// Anthropic model ids — so a Claude Code transcript carrying a Pi-shaped cost
// block ignores it entirely, as asserted below. Reaching the double-count needs
// a real Pi transcript with an Anthropic model AND a server_tool_use block; 0 of
// 400 Pi transcripts on this host carry either field. Filed as #118.
const nativeFixture = path.join(dir, "native.jsonl");
fs.writeFileSync(nativeFixture, [JSON.stringify({
	type: "assistant", timestamp: "2026-07-01T12:00:00Z", cwd: "/tmp",
	message: {
		role: "assistant", id: "n_a", model: "claude-opus-5",
		content: [{ type: "text", text: "x" }],
		usage: {
			input_tokens: 100, output_tokens: 300,
			cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
			cost: { total: 1.0 },                       // Pi's harness-native figure
			server_tool_use: { web_search_requests: WEB_REQUESTS },
		},
	},
})].join("\n") + "\n");
const docNative = json(nativeFixture);
check(
	docNative.total.costUsd > 0,
	`a native-cost turn is still priced ($${docNative.total.costUsd})`
);
check(
	docNative.total.costUsd < 1.0,
	`…and the Pi-shaped cost block is IGNORED on a Claude Code transcript ($${docNative.total.costUsd}, not $${(1.0 + EXPECTED_WEB_COST).toFixed(3)}) — nativeCost is pinned null there`
);
check(
	Math.abs(webCat(docNative).costUsd - EXPECTED_WEB_COST) < 1e-9,
	`…while the server-tool charge is still added once ($${EXPECTED_WEB_COST}); #118 owns the Pi case, which needs a Pi transcript to reach`
);

// TEARDOWN — stop the daemons before removing the tree they write into.
//
// Exit 9 means "a report in full, whose total may still grow under the daemon",
// so by definition a background process is still parsing and writing tag files
// beside every fixture copy when the CLI returns. Removing `dir` under them is a
// race: orphaned processes, stray files, and on an unlucky interleaving a
// directory-removal error (PR review). `isolateTmpdir` already gives this suite
// its own daemon lease, so stopping by session path reaps only ours.
for (const session of fs.readdirSync(dir).filter(n => n.endsWith(".jsonl"))) {
	spawnSync("node", [CLI_BIN, "--stop", path.join(dir, session)], { encoding: "utf8", timeout: 10_000 });
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

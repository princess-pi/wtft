/**
 * @package @princess-pi/wtft
 * @test wtft-26-json
 * @description #26 — `wtft --json`, the machine-readable session summary.
 *   Spec: docs/spec-26-json.md.
 *
 *   The issue's Closer, at the CLI:
 *     `node bin/wtft.mjs -s <fixture> --json | jq -e '.schema == "wtft/session@1"
 *      and (.total.outputTokens|type) == "number"'` exits 0, "and the value equals
 *     what the rendered table shows once un-abbreviated. A test asserts the two
 *     agree on a fixture, so the prose and the JSON cannot drift."
 *
 *   So this suite runs the SAME fixture twice — once with `--tokens`, once with
 *   `--json` — and holds the two outputs to each other. That is the whole point:
 *   a second aggregation written for the JSON path would pass a schema check and
 *   fail this one.
 *
 *   The rendered table abbreviates (`3.6k`), which is lossy, so the comparison
 *   runs the other way: the JSON's exact integer is abbreviated with the same
 *   rule and matched against the printed cell. A cell that agrees after
 *   abbreviation is the strongest claim the prose can support.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { WTFT_TAGGER_VERSION } from "../bin/wtft.mjs";
import { CATEGORY_ORDER } from "../bin/wtft.mjs";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("26-json");

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_BIN = path.join(REPO_ROOT, "bin", "wtft.mjs");
const EXIT_PROVISIONAL = 9;
const SCHEMA = "wtft/session@1";

const RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function assert(label: string, ok: boolean, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else {
		console.log(`  ${RED}FAIL${RESET} ${label}`); failed++;
		if (detail) console.log(detail.split("\n").map(l => `      │ ${l}`).join("\n"));
	}
}

// ---
// Fixture — a session plus an already-populated tag file, no daemon needed.
// Same shape as tests/wtft-443-cli-exit-9.test.ts, which is where it is
// explained: `t`/`c`/`in`/`out` are what serializeClassified writes, and a
// longhand key yields a tag that parses to nothing.
// ---

const MODEL = "claude-sonnet-4-6";
/** Per-turn token counts, chosen so the totals cross the table's 1k abbreviation
 *  boundary in both directions — an all-small fixture would never exercise it. */
const TURNS = [
	{ cat: "code",  input: 1200, output: 90,  cr: 4000, cw: 700, cost: 0.0123 },
	{ cat: "spec",  input: 900,  output: 310, cr: 0,    cw: 250, cost: 0.0410 },
	{ cat: "other", input: 1500, output: 640, cr: 9000, cw: 0,   cost: 0.0072 },
];

function turnLine(id: string, tsMs: number, t: typeof TURNS[number]): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant", id, model: MODEL,
			timestamp: new Date(tsMs).toISOString(),
			usage: {
				input_tokens: t.input, output_tokens: t.output,
				cache_read_input_tokens: t.cr, cache_creation_input_tokens: t.cw,
			},
			content: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

function classifiedLine(id: string, tsMs: number, t: typeof TURNS[number]): string {
	return JSON.stringify({
		t: tsMs, c: t.cost, cat: t.cat, f: [], cmd: [],
		id, m: MODEL, in: t.input, out: t.output, cr: t.cr, cw: t.cw,
	}) + "\n";
}

function makeFixture(slug: string, swept: boolean) {
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), `wtft-26-${slug}-`)));
	const sessionPath = path.join(dir, "session.jsonl");
	const T0 = Date.now() - 120_000;
	let s = JSON.stringify({ type: "session", version: 3, id: `parent-26-${slug}`, timestamp: new Date(T0).toISOString(), cwd: dir }) + "\n";
	TURNS.forEach((t, i) => { s += turnLine(`msg_26_${slug}_${i}`, T0 + i * 1000, t); });
	fs.writeFileSync(sessionPath, s);

	const tagsDir = path.join(dir, "wtft-tags");
	fs.mkdirSync(tagsDir, { recursive: true });
	let tag = "";
	TURNS.forEach((t, i) => { tag += classifiedLine(`msg_26_${slug}_${i}`, T0 + i * 1000, t); });
	tag += JSON.stringify({ _meta: swept ? { offset: Buffer.byteLength(s), swept: T0 } : { offset: Buffer.byteLength(s) } }) + "\n";
	const tagPath = path.join(tagsDir, path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	fs.writeFileSync(tagPath, tag);
	return { dir, sessionPath, tagPath };
}

/** Run the CLI once. stdout and stderr are captured SEPARATELY — the whole
 *  contract is about which stream the prose lands on, so merging them would
 *  make the suite unable to see the thing it is testing. */
function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync(process.execPath, [CLI_BIN, ...args], {
			cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, WTFT_DAEMON_DEBUG: "" },
		});
		return { code: 0, stdout, stderr: "" };
	} catch (err: any) {
		return {
			code: typeof err.status === "number" ? err.status : -1,
			stdout: err.stdout ?? "", stderr: err.stderr ?? "",
		};
	}
}

console.log("wtft --json (#26)");
console.log("──────────────────────────────");

// ---
// 1. The Closer, verbatim: one JSON object, right schema, numeric totals.
// ---
console.log("\n1. One JSON object on stdout");
{
	const { sessionPath } = makeFixture("closer", true);
	const r = runCli(["-s", sessionPath, "--json"]);
	assert(`exits 0 (got ${r.code})`, r.code === 0, r.stderr);
	let doc: any = null;
	try { doc = JSON.parse(r.stdout); } catch { /* reported below */ }
	assert("stdout parses as exactly one JSON object", doc !== null && typeof doc === "object" && !Array.isArray(doc), r.stdout.slice(0, 800));
	assert(`schema is "${SCHEMA}"`, doc?.schema === SCHEMA, String(doc?.schema));
	assert("total.outputTokens is a number", typeof doc?.total?.outputTokens === "number");
	// No ANSI anywhere: a colour code inside a JSON string still parses, so
	// parseability alone does not carry this half of the contract.
	assert("stdout carries no ANSI escape", !/\x1b\[/.test(r.stdout));
	// "nothing else on stdout" — the session path line the human path prints
	// above the chart is the specific thing that must not be here.
	assert("stdout carries nothing but the object", r.stdout.trim().startsWith("{") && r.stdout.trim().endsWith("}"), r.stdout.slice(0, 400));
}

// ---
// 2. The prose and the JSON agree — the Closer's second half.
// ---
// Compared in the abbreviating direction: the table prints `3.6k`, which cannot
// be inverted to 3600, so the JSON's exact integer is abbreviated by the SAME
// documented rule and matched against the printed cell. These two literals are
// the rendered table's own display rules (`formatTokenCount`, `formatCost` in
// wtft-renderer.ts) restated as an INDEPENDENT expectation — the test does not
// import them, or a renderer change would silently move both sides at once.
function abbreviate(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}
function money(n: number): string {
	return `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
}
/** The cells of one row of the rendered token table, by label. */
function tableRow(rendered: string, label: string): string[] | null {
	const line = rendered.split("\n").find(l => l.trim().startsWith(label));
	return line ? line.trim().split(/\s+/).slice(1) : null;
}

console.log("\n2. The rendered table and the JSON report the same numbers");
{
	const { sessionPath } = makeFixture("parity", true);
	const rendered = runCli(["-s", sessionPath, "--tokens", "--pad", "0"]);
	const asJson = runCli(["-s", sessionPath, "--json"]);
	assert("both runs exit 0", rendered.code === 0 && asJson.code === 0, `${rendered.code}/${asJson.code}\n${rendered.stderr}${asJson.stderr}`);
	const doc = JSON.parse(asJson.stdout);

	// Column order is the table's header: Input Output Reasoning Cache-Read Cache-Write Cost
	const t = doc.total;
	const expected = [
		abbreviate(t.inputTokens), abbreviate(t.outputTokens), abbreviate(t.reasoningTokens),
		abbreviate(t.cacheReadTokens), abbreviate(t.cacheWriteTokens), money(t.costUsd),
	];
	const cells = tableRow(rendered.stdout, "TOTAL");
	assert("the rendered table has a TOTAL row", cells !== null, rendered.stdout);
	assert("every TOTAL cell equals the JSON total, abbreviated",
		JSON.stringify(cells) === JSON.stringify(expected),
		`table: ${JSON.stringify(cells)}\njson:  ${JSON.stringify(expected)}`);

	// And the per-model row, so `models[]` is held to the same standard as `total`.
	const m = doc.models[0];
	assert("the JSON names the full model id, not the shortened display form",
		m.model === MODEL, String(m.model));
	const modelCells = tableRow(rendered.stdout, "sonnet-4-6");
	assert("every per-model cell equals the JSON model row, abbreviated",
		JSON.stringify(modelCells) === JSON.stringify([
			abbreviate(m.inputTokens), abbreviate(m.outputTokens), abbreviate(m.reasoningTokens),
			abbreviate(m.cacheReadTokens), abbreviate(m.cacheWriteTokens), money(m.costUsd),
		]),
		`table: ${JSON.stringify(modelCells)}\njson:  ${JSON.stringify(doc.models[0])}`);
	assert("a registry model reports priced: true", m.priced === true, JSON.stringify(m));
}

// ---
// 3. The arithmetic guarantee: models and categories both sum to total.
// ---
// This is what the single-aggregation seam BUYS. A JSON path with its own
// aggregation could pass §1 and §2 and still fail here, because §2 only checks
// the rows the table happens to print.
console.log("\n3. models[] and categories[] each sum to total");
{
	const { sessionPath } = makeFixture("sums", true);
	const r = runCli(["-s", sessionPath, "--json"]);
	const doc = JSON.parse(r.stdout);
	const FIELDS = ["costUsd", "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"];
	const sum = (rows: any[], f: string) => rows.reduce((a, x) => a + x[f], 0);
	for (const f of FIELDS) {
		// Token fields are exact integers; costUsd is a float sum, so it is
		// compared with the tolerance a float sum actually earns.
		const ok = f === "costUsd"
			? Math.abs(sum(doc.models, f) - doc.total[f]) < 1e-12 && Math.abs(sum(doc.categories, f) - doc.total[f]) < 1e-12
			: sum(doc.models, f) === doc.total[f] && sum(doc.categories, f) === doc.total[f];
		assert(`sum(models.${f}) === sum(categories.${f}) === total.${f}`, ok,
			`models ${sum(doc.models, f)} · categories ${sum(doc.categories, f)} · total ${doc.total[f]}`);
	}
	// Positional addressability is part of the contract: a consumer indexes
	// categories[] rather than searching it, so the array is always complete
	// and always in CATEGORY_ORDER.
	assert("categories[] carries every CATEGORY_ORDER entry, in order",
		JSON.stringify(doc.categories.map((c: any) => c.category)) === JSON.stringify(CATEGORY_ORDER),
		JSON.stringify(doc.categories.map((c: any) => c.category)));
	// The fixture puts one turn in each of three categories, so a JSON path
	// that lost the per-category split would still sum correctly above.
	const nonZero = doc.categories.filter((c: any) => c.costUsd > 0).map((c: any) => c.category).sort();
	assert("the three fixture categories are the three non-zero rows",
		JSON.stringify(nonZero) === JSON.stringify(["code", "other", "spec"]), JSON.stringify(nonZero));
}

// ---
// 4. The provisional path still yields one JSON object — and still exits 9.
// ---
// #443 spent an exit code on this bit for want of a structured surface, and the
// issue is explicit that `--json` must not preempt it: the code KEEPS its
// meaning and the field is added beside it. So both must be true at once, and a
// consumer choosing either one gets the same answer.
console.log("\n4. Provisional: exit 9 AND a parseable object");
{
	const { sessionPath } = makeFixture("prov", false);
	const r = runCli(["-s", sessionPath, "--json"]);
	assert(`exits ${EXIT_PROVISIONAL} (got ${r.code})`, r.code === EXIT_PROVISIONAL, r.stderr);
	let doc: any = null;
	try { doc = JSON.parse(r.stdout); } catch { /* reported below */ }
	assert("stdout is STILL exactly one JSON object on the provisional path", doc !== null, r.stdout.slice(0, 600));
	assert("provisional.provisional is true", doc?.provisional?.provisional === true, JSON.stringify(doc?.provisional));
	assert("provisional.reason names the condition", doc?.provisional?.reason === "unswept", JSON.stringify(doc?.provisional));
	assert("the totals are reported in full anyway, not withheld",
		doc?.total?.outputTokens > 0, JSON.stringify(doc?.total));
	// The prose is in the object as well as on stderr, so a consumer relaying to
	// a human never has to correlate two streams — and it branches on `code`.
	const notice = (doc?.notices ?? []).find((n: any) => n.code === "provisional");
	assert("notices[] carries a provisional entry with a typed code", !!notice, JSON.stringify(doc?.notices));
	assert("  ...and the sentence, so stderr is not load-bearing",
		typeof notice?.text === "string" && notice.text.length > 0, JSON.stringify(notice));
	// The #443 rule the rendered path is held to, held here too: the remedy
	// never advises -F, because -F falls through to this same read path.
	assert("the provisional notice never advises -F", !/-F/.test(notice?.text ?? ""), notice?.text);
}

// ---
// 5. The session identity, and the blind spot, are fields rather than prose.
// ---
console.log("\n5. session identity and the #149 blind spot");
{
	const { sessionPath, tagPath } = makeFixture("ident", true);
	const r = runCli(["-s", sessionPath, "--json"]);
	const doc = JSON.parse(r.stdout);
	assert("session.path is the transcript this run read", doc.session.path === sessionPath, doc.session.path);
	assert("session.tagPath is the tag file this run read", doc.session.tagPath === tagPath, doc.session.tagPath);
	assert("session.taggerVersion is the running binary's", doc.session.taggerVersion === String(WTFT_TAGGER_VERSION), doc.session.taggerVersion);
	// Asked, not assumed: `-s <path>` never went through discovery, so this can
	// only come from the parse adapters themselves. The fixture's turns are
	// `{type:"message", message:{role:"assistant"}}` — Pi's shape, not Claude
	// Code's `{type:"assistant"}` — so "pi" is the correct answer here, and an
	// answer of "claude-code" would mean the field was guessed from a default
	// rather than derived from the adapter that would actually parse the file.
	assert("session.harness is the adapter that claims the transcript",
		doc.session.harness === "pi", String(doc.session.harness));
	// #149: present and zeroed rather than absent. A consumer indexing
	// `.uncounted.compaction` must never get `undefined` because a caller
	// skipped a scan — an absent blind spot reads as "no blind spot".
	assert("uncounted is always present, with both classes",
		typeof doc.uncounted?.compaction === "number" && typeof doc.uncounted?.recap === "number",
		JSON.stringify(doc.uncounted));
	assert("compaction is always present, with both fields",
		typeof doc.compaction?.events === "number" && typeof doc.compaction?.tokensFreed === "number",
		JSON.stringify(doc.compaction));
	assert("untaggedInteractions is a number", typeof doc.untaggedInteractions === "number");
}

// ---
// 6. Contradictory flags must not crash, and must not break the contract.
// ---
// Which flag "wins" is deliberately NOT pinned — that is the human's call, and
// pinning it would make a future decision a test failure. What IS pinned: the
// run does not crash, and stdout stays parseable.
console.log("\n6. --json alongside rendering flags");
{
	const { sessionPath } = makeFixture("combo", true);
	for (const extra of [["--tokens"], ["--other"], ["--pad", "4"], ["--no-emoji"]]) {
		const r = runCli(["-s", sessionPath, "--json", ...extra]);
		let ok = false;
		try { ok = JSON.parse(r.stdout).schema === SCHEMA; } catch { /* reported */ }
		assert(`--json ${extra.join(" ")} still yields one object (exit ${r.code})`, ok && r.code === 0, r.stdout.slice(0, 300));
	}
}

// ---
// 7. The exit-code table is documented, and `--help` renders it.
// ---
// Agent-First Output: an exit code nobody wrote down is an observation, not a
// contract. The manifest is the single source — `--help` renders from it, so a
// code added to one is added to both.
console.log("\n7. the exit-code table is a contract");
{
	const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "docs/manifests/wtft-cmd.json"), "utf8"));
	const documented = new Set((manifest.exitCodes ?? []).map((c: any) => c.code));
	assert("the manifest carries an exitCodes table", documented.size > 0, JSON.stringify(manifest.exitCodes));
	// Read from the CLI source, so a new `process.exit(N)` fails this rather
	// than quietly becoming an undocumented code.
	const cli = fs.readFileSync(path.join(REPO_ROOT, "bin/wtft.ts"), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	const used = new Set<number>();
	for (const m of cli.matchAll(/process\.exit\((\d+)\)/g)) used.add(Number(m[1]));
	for (const m of cli.matchAll(/process\.exitCode = (\d+)/g)) used.add(Number(m[1]));
	if (/EXIT_PROVISIONAL/.test(cli)) used.add(EXIT_PROVISIONAL);
	used.add(0); // every `return` from main() is an exit 0
	const undocumented = [...used].filter(c => !documented.has(c));
	assert("every exit code bin/wtft.ts can return is in the manifest table",
		undocumented.length === 0, `undocumented: ${undocumented.join(", ")}`);

	const help = runCli(["--help"]);
	assert("--help renders an Exit codes section", /Exit codes:/.test(help.stdout), help.stdout.slice(-400));
	for (const c of documented) {
		assert(`  ...naming exit ${c}`, new RegExp(`^\\s*${c}\\s`, "m").test(help.stdout.replace(/\x1b\[[0-9;]*m/g, "")));
	}
	assert("--help names --json", /--json/.test(help.stdout));
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

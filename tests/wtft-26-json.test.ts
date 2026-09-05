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
import { spawnSync } from "node:child_process";
import { WTFT_TAGGER_VERSION, EXIT_PROVISIONAL, WTFT_JSON_SCHEMA } from "../bin/wtft.mjs";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("26-json");

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_BIN = path.join(REPO_ROOT, "bin", "wtft.mjs");
/** The fourteen category names, in CATEGORY_ORDER, written out INDEPENDENTLY.
 *  Importing CATEGORY_ORDER and asserting the JSON matches it is tautological —
 *  `computeSessionSummary` builds `categories[]` by mapping over that same
 *  array, so a rename or a reorder moves both sides together and the assertion
 *  can never fail. The contract is that a consumer indexes by POSITION, and only
 *  a literal written out here can pin that. */
const CATEGORY_NAMES = [
	"overhead", "interrupted", "plan", "spec", "research", "web", "grep", "code",
	"tests", "git", "agents", "prompt", "compaction", "other",
];
/** The schema string, likewise written out rather than compared to its own
 *  import. `WTFT_JSON_SCHEMA` is imported so §1 can prove the CLI emits the
 *  value the module exports, and this literal pins what that value must be. */
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
/** A second model, deliberately one no pricing registry knows, so `priced:false`
 *  and the table's `?` marker are exercised rather than assumed. Two models also
 *  stop `models[0]` from being numerically identical to `total`, which would let
 *  a JSON path that emitted the grand total in every model row pass §2. */
const MODEL_UNPRICED = "acme-frobnicator-1";
/** Per-turn counts, chosen so the totals cross the table's 1k abbreviation
 *  boundary in every column INCLUDING Reasoning — an all-zero reasoning fixture
 *  compares "0" against "0" and proves nothing about that column. */
const TURNS = [
	{ cat: "code",  model: MODEL,          input: 1200, output: 90,  cr: 4000, cw: 1700, rs: 0,    cost: 0.0123 },
	{ cat: "spec",  model: MODEL,          input: 900,  output: 310, cr: 0,    cw: 250, rs: 2400, cost: 0.0410 },
	{ cat: "other", model: MODEL,          input: 1500, output: 640, cr: 9000, cw: 0,   rs: 0,    cost: 0.0072 },
	{ cat: "git",   model: MODEL_UNPRICED, input: 300,  output: 45,  cr: 0,    cw: 0,   rs: 0,    cost: 0.0009 },
];

function turnLine(id: string, tsMs: number, t: typeof TURNS[number]): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant", id, model: t.model,
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
		id, m: t.model, in: t.input, out: t.output, cr: t.cr, cw: t.cw, rs: t.rs,
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

/** Run the CLI once, capturing stdout and stderr SEPARATELY on every exit code.
 *
 *  `spawnSync`, not `execFileSync`, and that is the point: execFileSync returns
 *  stdout alone on success and only concatenates stderr into the thrown error on
 *  failure, so a suite using it can assert "the prose is not on stdout" against
 *  a run where the prose was on neither stream and call that a pass. The whole
 *  #26 contract is about WHICH STREAM each sentence lands on; §1 and §4 read
 *  both fields, so the split has to survive a zero exit.
 *  (tests/wtft-443-cli-exit-9.test.ts has the execFileSync shape and one
 *  assertion that is vacuous for exactly this reason; it is fixed there too.) */
function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
	const r = spawnSync(process.execPath, [CLI_BIN, ...args], {
		cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, WTFT_DAEMON_DEBUG: "" },
	});
	return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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
	// No ANSI anywhere. A colour code inside a JSON string still parses, so
	// parseability alone would not carry this half. Weak on THIS fixture — the
	// `--json` path writes only the document to stdout, so nothing can put an
	// escape there — and kept as the regression guard for the next `console.log`
	// someone adds above the return. §4 is where it does real work, on the run
	// that has ANSI prose to misplace.
	assert("stdout carries no ANSI escape", !/\x1b\[/.test(r.stdout));
	assert("  ...while the run's prose really does exist, on stderr",
		r.stderr.length > 0 || r.stdout.length > 0);
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
/** The cost cell, including the `?` the table appends when the row's cost came
 *  from a fallback rather than a rate card (#140). Omitting the marker made this
 *  helper a restatement of `formatCost` rather than of the CELL, which is what
 *  the parity claim is about. */
function money(n: number, priced: boolean): string {
	return `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}${priced ? "" : "?"}`;
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
	// The TOTAL row's `?` is the OR over the model rows, not a property of the
	// total — the table marks the grand total as a guess if any row was one.
	const allPriced = doc.models.every((m: any) => m.priced);
	const expected = [
		abbreviate(t.inputTokens), abbreviate(t.outputTokens), abbreviate(t.reasoningTokens),
		abbreviate(t.cacheReadTokens), abbreviate(t.cacheWriteTokens), money(t.costUsd, allPriced),
	];
	const cells = tableRow(rendered.stdout, "TOTAL");
	assert("the rendered table has a TOTAL row", cells !== null, rendered.stdout);
	assert("every TOTAL cell equals the JSON total, abbreviated",
		JSON.stringify(cells) === JSON.stringify(expected),
		`table: ${JSON.stringify(cells)}\njson:  ${JSON.stringify(expected)}`);

	// EVERY per-model row, not just the first: with two models a JSON path that
	// emitted the grand total in each row would still match `total` above.
	assert("models[] has one row per model in the fixture", doc.models.length === 2, JSON.stringify(doc.models.map((m: any) => m.model)));
	assert("the JSON names full model ids, not the shortened display form",
		doc.models.map((m: any) => m.model).sort().join(",") === [MODEL, MODEL_UNPRICED].sort().join(","),
		JSON.stringify(doc.models.map((m: any) => m.model)));
	for (const m of doc.models) {
		// The table shortens the id for display; the JSON must not.
		const shown = m.model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
		const modelCells = tableRow(rendered.stdout, shown);
		assert(`every cell of the ${m.model} row equals its JSON row, abbreviated`,
			JSON.stringify(modelCells) === JSON.stringify([
				abbreviate(m.inputTokens), abbreviate(m.outputTokens), abbreviate(m.reasoningTokens),
				abbreviate(m.cacheReadTokens), abbreviate(m.cacheWriteTokens), money(m.costUsd, m.priced),
			]),
			`table: ${JSON.stringify(modelCells)}\njson:  ${JSON.stringify(m)}`);
	}
	// Both sides of `priced`, so the field is pinned rather than merely present.
	const byId = Object.fromEntries(doc.models.map((m: any) => [m.model, m]));
	assert("a registry model reports priced: true", byId[MODEL].priced === true, JSON.stringify(byId[MODEL]));
	assert("a model no registry knows reports priced: false", byId[MODEL_UNPRICED].priced === false, JSON.stringify(byId[MODEL_UNPRICED]));
	assert("  ...and the table marks that row with the matching `?`",
		/acme-frobnicator-1\s.*\?$/m.test(rendered.stdout), rendered.stdout);
	// models[] is cost-descending, which is the table's row order (#26 contract).
	assert("models[] is sorted by costUsd descending",
		doc.models.every((m: any, i: number) => i === 0 || doc.models[i - 1].costUsd >= m.costUsd),
		JSON.stringify(doc.models.map((m: any) => m.costUsd)));
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
	assert("categories[] carries all fourteen names, in the documented order",
		JSON.stringify(doc.categories.map((c: any) => c.category)) === JSON.stringify(CATEGORY_NAMES),
		JSON.stringify(doc.categories.map((c: any) => c.category)));
	// The fixture puts one turn in each of four categories, so a JSON path that
	// lost the per-category split would still sum correctly above.
	const nonZero = doc.categories.filter((c: any) => c.costUsd > 0).map((c: any) => c.category).sort();
	assert("the four fixture categories are the four non-zero rows",
		JSON.stringify(nonZero) === JSON.stringify(["code", "git", "other", "spec"]), JSON.stringify(nonZero));
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
	// The provisional sentence is in the object AND on stderr, so a consumer
	// relaying to a human need not correlate two streams, and it branches on
	// `code` rather than on the sentence. Not every stderr line has a notice —
	// the reap-warning block and the `--force` line are diagnostics with no
	// document counterpart — so the claim is about THIS sentence, not about the
	// stream as a whole.
	const notice = (doc?.notices ?? []).find((n: any) => n.code === "provisional");
	assert("notices[] carries a provisional entry with a typed code", !!notice, JSON.stringify(doc?.notices));
	assert("  ...and the sentence, so stderr is not load-bearing",
		typeof notice?.text === "string" && notice.text.length > 0, JSON.stringify(notice));
	assert("  ...and the same sentence is on stderr, ANSI-wrapped, for the human",
		r.stderr.includes(notice?.text ?? "\u0000"), r.stderr);
	assert("  ...and none of it reached stdout", !r.stdout.includes("PROVISIONAL"), r.stdout);
	// The #443 rule the rendered path is held to, held here too: the remedy
	// never advises -F, because -F falls through to this same read path. Weak by
	// construction — neither arm of describeProvisionalRemedy can emit `-F` — and
	// kept because that is precisely the property a reword could destroy.
	assert("the provisional notice never advises -F", !/-F/.test(notice?.text ?? ""), notice?.text);
}
{
	// A SECOND reason, so `reason` is pinned as a vocabulary rather than as one
	// string. A tag whose filename carries a version this build did not write is
	// stale-version, which readTagProvisional decides before it reads a byte.
	const { dir, sessionPath, tagPath } = makeFixture("stale", true);
	fs.renameSync(tagPath, path.join(path.dirname(tagPath), path.basename(sessionPath) + ".wtft-tag.v0.0.1-ancient.jsonl"));
	const r = runCli(["-s", sessionPath, "--json"]);
	let doc: any = null;
	try { doc = JSON.parse(r.stdout); } catch { /* reported below */ }
	assert("a stale-version tag also yields one object", doc !== null, r.stdout.slice(0, 400));
	assert(`  ...and exits ${EXIT_PROVISIONAL} (got ${r.code})`, r.code === EXIT_PROVISIONAL, r.stderr);
	assert("  ...naming stale-version as the reason", doc?.provisional?.reason === "stale-version", JSON.stringify(doc?.provisional));
	void dir;
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
// pinning it would turn a future decision into a test failure. What IS pinned:
// the run does not crash, and stdout stays parseable. The exit code is left
// free for the same reason: a provisional fixture would legitimately exit 9
// here, so requiring 0 would be pinning a second thing by accident.
//
// Scoped to the RENDERING flags. `--help`, `--why`, `--version`, `--watch` and
// the daemon-management commands are not contradictory flags, they are separate
// commands that run instead of the report; §7 covers what the manifest says
// about them.
console.log("\n6. --json alongside rendering flags");
{
	const { sessionPath } = makeFixture("combo", true);
	for (const extra of [["--tokens"], ["--other"], ["--pad", "4"], ["--no-emoji"], ["--bucket"], ["--interval", "5m"]]) {
		const r = runCli(["-s", sessionPath, "--json", ...extra]);
		let ok = false;
		try { ok = JSON.parse(r.stdout).schema === SCHEMA; } catch { /* reported */ }
		assert(`--json ${extra.join(" ")} still yields one object (exit ${r.code})`, ok, r.stdout.slice(0, 300));
		assert(`  ...without crashing (exit ${r.code} is 0 or ${EXIT_PROVISIONAL})`,
			r.code === 0 || r.code === EXIT_PROVISIONAL, r.stderr.slice(0, 300));
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
	// Read from source, so a new `process.exit(N)` fails this rather than quietly
	// becoming an undocumented code.
	//
	// TWO files, not one: `bin/wtft.ts` calls `selectSessionPrompt`, which exits
	// 130 on `q`/Ctrl-C from inside `session-selector.ts`. A scan of the entry
	// point alone reported "every exit code" while missing one the tool really
	// returns — the exact class of false green this section exists to prevent.
	const sources = ["bin/wtft.ts", "extensions/lib/session-selector.ts"]
		.map(rel => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"))
		.join("\n")
		.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	const used = new Set<number>();
	for (const m of sources.matchAll(/process\.exit\((\d+)\)/g)) used.add(Number(m[1]));
	// Both the literal and the ternary form. `process.exitCode = cond ? A : 0`
	// is what the provisional branch actually writes, and a `= (\d+)` pattern
	// does not see it.
	for (const m of sources.matchAll(/process\.exitCode = ([^;]+);/g)) {
		for (const n of m[1].matchAll(/\b(\d+)\b/g)) used.add(Number(n[1]));
		// EXIT_PROVISIONAL by name, read from the CONSTANT rather than hardcoded:
		// re-typing 9 here means changing the constant leaves this green.
		if (/EXIT_PROVISIONAL/.test(m[1])) used.add(EXIT_PROVISIONAL);
	}
	// main() returning normally is an exit 0, and so is `process.exitCode = 0`.
	used.add(0);
	const undocumented = [...used].filter(c => !documented.has(c));
	assert(`every exit code the CLI can return is in the manifest table (found ${[...used].sort((a, b) => a - b).join(", ")})`,
		undocumented.length === 0, `undocumented: ${undocumented.join(", ")}`);
	assert("  ...including 130, which only the session selector can return",
		used.has(130) && documented.has(130), `used=${used.has(130)} documented=${documented.has(130)}`);

	const help = runCli(["--help"]);
	assert("--help renders an Exit codes section", /Exit codes:/.test(help.stdout), help.stdout.slice(-400));
	// Scoped to the section, not to the whole help text: `^\s*0\s` matches any
	// line starting with a digit anywhere in the output, which would pass on a
	// help page that had no exit-code block at all.
	const plain = help.stdout.replace(/\x1b\[[0-9;]*m/g, "");
	const section = plain.slice(plain.indexOf("Exit codes:"));
	for (const c of documented) {
		assert(`  ...naming exit ${c} inside that section`, new RegExp(`^\\s*${c}\\s`, "m").test(section), section);
	}
	assert("--help names --json", /--json/.test(help.stdout));
	// The schema string the CLI emits is the one the module exports, so a
	// consumer pinning `wtft/session@1` and the code cannot drift apart.
	assert("the exported schema constant is the string the CLI emits",
		WTFT_JSON_SCHEMA === SCHEMA, String(WTFT_JSON_SCHEMA));
}

// ---
// 8. The empty paths obey the exit-code contract too.
// ---
// PR review, High/reasoning. The `pending-session` and `no-data` arms used to
// emit the object and `return` without touching `process.exitCode`, so a tag
// that is provisional BUT yields no classified lines printed
// `"provisional": true` and exited 0. That breaks the single promise the
// contract makes about the pair — that `$?` and `.provisional.provisional`
// always agree — and it breaks it on the path a consumer is least likely to
// have a fixture for.
console.log("\n8. an empty report still agrees with its exit code");
{
	// A tag whose filename carries a version this build did not write is
	// stale-version — decided before a byte is read — and this one has NO
	// classified lines, so the run takes the no-data arm rather than the main one.
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-26-empty-")));
	const sessionPath = path.join(dir, "session.jsonl");
	fs.writeFileSync(sessionPath, JSON.stringify({ type: "session", version: 3, id: "empty-26", timestamp: new Date().toISOString(), cwd: dir }) + "\n");
	const tagsDir = path.join(dir, "wtft-tags");
	fs.mkdirSync(tagsDir, { recursive: true });
	fs.writeFileSync(path.join(tagsDir, "session.jsonl.wtft-tag.v0.0.1-ancient.jsonl"),
		JSON.stringify({ _meta: { offset: 0 } }) + "\n");

	const r = runCli(["-s", sessionPath, "--json"]);
	let doc: any = null;
	try { doc = JSON.parse(r.stdout); } catch { /* reported below */ }
	assert("an empty report is still exactly one JSON object", doc !== null, r.stdout.slice(0, 400));
	assert("  ...with the full shape, so a consumer branches on values not shape",
		doc?.models?.length === 0 && doc?.categories?.length === 14 && doc?.total?.costUsd === 0,
		JSON.stringify({ models: doc?.models?.length, categories: doc?.categories?.length, total: doc?.total }));
	assert("  ...and a notice saying why it is empty",
		(doc?.notices ?? []).some((n: any) => n.code === "no-data" || n.code === "pending-session"),
		JSON.stringify(doc?.notices));
	// The claim under test.
	assert(`$? agrees with the field on the empty path (field=${doc?.provisional?.provisional}, exit=${r.code})`,
		(doc?.provisional?.provisional === true) === (r.code === EXIT_PROVISIONAL),
		`${JSON.stringify(doc?.provisional)} exit=${r.code}\n${r.stderr}`);
}
{
	// The other direction, so the assertion above cannot pass by both sides being
	// false: a SETTLED empty report exits 0 and says provisional:false.
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-26-empty0-")));
	const sessionPath = path.join(dir, "session.jsonl");
	fs.writeFileSync(sessionPath, JSON.stringify({ type: "session", version: 3, id: "empty0-26", timestamp: new Date().toISOString(), cwd: dir }) + "\n");
	const tagsDir = path.join(dir, "wtft-tags");
	fs.mkdirSync(tagsDir, { recursive: true });
	fs.writeFileSync(path.join(tagsDir, `session.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`),
		JSON.stringify({ _meta: { offset: 0, swept: Date.now() } }) + "\n");

	const r = runCli(["-s", sessionPath, "--json"]);
	let doc: any = null;
	try { doc = JSON.parse(r.stdout); } catch { /* reported below */ }
	assert("a settled empty report exits 0", r.code === 0, `exit=${r.code}\n${r.stderr}`);
	assert("  ...and says provisional: false", doc?.provisional?.provisional === false, JSON.stringify(doc?.provisional));
}

// ---
// 9. The RENDERED empty paths obey the same exit-code rule.
// ---
// PR review round 2, High/correctness. §8 taught the `--json` arms to honour
// `provisional`; the rendered arms still fell through to an unconditional
// `process.exit(0)`, so the SAME session exited 0 under `wtft` and 9 under
// `wtft --json`. The exit-code table says nothing about mode — 9 means "the
// total may still grow", which is as true of an empty report from a stale tag
// as of a full one — so the two modes have to agree.
console.log("\n9. rendered and --json agree on the exit code, empty or not");
{
	const mk = (slug: string, stale: boolean) => {
		const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), `wtft-26-${slug}-`)));
		const sessionPath = path.join(dir, "session.jsonl");
		fs.writeFileSync(sessionPath, JSON.stringify({ type: "session", version: 3, id: slug, timestamp: new Date().toISOString(), cwd: dir }) + "\n");
		const tagsDir = path.join(dir, "wtft-tags");
		fs.mkdirSync(tagsDir, { recursive: true });
		const name = stale ? "session.jsonl.wtft-tag.v0.0.1-ancient.jsonl" : `session.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`;
		fs.writeFileSync(path.join(tagsDir, name), JSON.stringify({ _meta: stale ? { offset: 0 } : { offset: 0, swept: Date.now() } }) + "\n");
		return sessionPath;
	};
	// A FRESH fixture per mode, never one session run twice. The first run spawns
	// the log parser daemon, which repairs the tag and writes a current-version
	// one — so a second run against the same directory reads a settled tag and
	// legitimately exits 0. Comparing the two modes across that repair compares
	// two different states and fails an entirely correct build, which is what the
	// first cut of this section did.
	for (const [slug, stale, want] of [["renderprov", true, EXIT_PROVISIONAL], ["rendersettled", false, 0]] as const) {
		const rendered = runCli(["-s", mk(`${slug}-r`, stale), "--pad", "0"]);
		const asJson = runCli(["-s", mk(`${slug}-j`, stale), "--json"]);
		assert(`an empty ${stale ? "provisional" : "settled"} session exits ${want} rendered (got ${rendered.code})`,
			rendered.code === want, rendered.stdout + rendered.stderr);
		assert(`  ...and ${want} under --json too (got ${asJson.code})`, asJson.code === want, asJson.stderr);
		assert("  ...so the two modes never disagree", rendered.code === asJson.code,
			`rendered=${rendered.code} json=${asJson.code}`);
	}
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

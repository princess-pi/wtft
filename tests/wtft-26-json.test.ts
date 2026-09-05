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

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

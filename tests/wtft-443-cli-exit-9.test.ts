/**
 * @package princess-pi-tools
 * @test wtft-443-cli-exit-9
 * @description #443 slice 3 — the issue's own Closer, at the CLI.
 *
 *   "With every daemon for the session killed and a known-stale tag in place,
 *   one `wtft --tokens` invocation reports the same total as `wtft --tokens -F`
 *   — or reports a machine-readable flag saying it did not. Today the first
 *   invocation reports neither."
 *
 *   Duppy chose the flag over blocking the read. Blocking a one-shot CLI on a
 *   repair whose length is proportional to the session's subagent volume is the
 *   cost that read-then-render exists to avoid.
 *
 *   WHY AN EXIT CODE AND NOT A JSON FIELD. The issue asks for "a `provisional:
 *   true` in the structured output". When this suite was written there was no
 *   structured output at all: `wtft` shipped no `--json`, no `--porcelain`, and
 *   no documented exit-code table, so every number it produced was prose.
 *   Building that surface was filed separately and has since shipped as #26 —
 *   `wtft --json` now carries `provisional` as a field, and the exit code
 *   asserted below was NOT retired by it. Both report the same verdict, which
 *   is what tests/wtft-26-json.test.ts §4 pins. An exit code remains the
 *   minimal faithful reading of Agent-First Output: machine-readable in zero
 *   reasoning steps, costs a consumer no tokens at all, and matches the idiom
 *   this repo already uses in `pr-review` (7/8/9).
 *
 *   SAFE TO ADD — and the check that said so was WRONG, which is the part worth
 *   keeping. #511 justified the new code with "nothing in this repo invokes the
 *   `wtft` CLI and inspects `$?`", grepping `bin/`, `hooks/`, `statusline/` and
 *   `skills/`. Three of those four directories do not exist in this repo, and
 *   the one place that did inspect `$?` — `tests/` — was not grepped.
 *   `tests/wtft-auto-fit.test.ts` then failed on exit 9, on `main`,
 *   intermittently; `tests/wtft-513-exit9-caller-guard.test.ts` is the guard
 *   that came out of it. The CLI returns 0, 1, 9 and 130 (the selector's
 *   Ctrl-C), all four documented in `docs/manifests/wtft-cmd.json` since #26.
 *
 *   A HUMAN LINE TOO, because the exit code is invisible to the person reading
 *   the widget, and they are the one who can decide to re-run.
 *
 *   Closer: a populated tag with no `_meta.swept` exits 9; the same tag carrying
 *   the marker exits 0.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { WTFT_TAGGER_VERSION, EXIT_PROVISIONAL } from "../bin/wtft.mjs";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("443-cli");

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_BIN = path.join(REPO_ROOT, "bin", "wtft.mjs");

const RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function assert(label: string, ok: boolean, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else {
		console.log(`  ${RED}FAIL${RESET} ${label}`); failed++;
		// A CLI exit code alone says nothing about WHY. Echo what it printed, or
		// the next reader re-runs this by hand to find out.
		if (detail) console.log(detail.split("\n").map(l => `      │ ${l}`).join("\n"));
	}
}

function turnLine(id: string, tsMs: number): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6",
			timestamp: new Date(tsMs).toISOString(),
			usage: { input_tokens: 1200, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

/** A classified tag line, in the shape serializeClassified writes: `t`/`c` for
 *  timestamp and cost, `in`/`out` for tokens — NOT the longhand names. Getting
 *  these wrong yields a tag the reader silently parses to nothing, which reads
 *  as an empty session rather than as a bad fixture. */
function classified(id: string, tsMs: number): string {
	return JSON.stringify({
		t: tsMs, c: 0.0123, cat: "code", f: [], cmd: [],
		id, m: "claude-sonnet-4-6", in: 1200, out: 90,
	}) + "\n";
}

/** Build a session whose tag is already populated, with or without the marker.
 *  No daemon has ever run here — which is the state the Closer describes. */
function makeFixture(slug: string, swept: boolean) {
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), `wtft-443-cli-${slug}-`)));
	const sessionPath = path.join(dir, "session.jsonl");
	const T0 = Date.now() - 120_000;
	let s = JSON.stringify({ type: "session", version: 3, id: `parent-443-cli-${slug}`, timestamp: new Date(T0).toISOString(), cwd: dir }) + "\n";
	for (let i = 0; i < 3; i++) s += turnLine(`msg_443_cli_${slug}_${i}`, T0 + i * 1000);
	fs.writeFileSync(sessionPath, s);

	const tagsDir = path.join(dir, "wtft-tags");
	fs.mkdirSync(tagsDir, { recursive: true });
	let tag = "";
	for (let i = 0; i < 3; i++) tag += classified(`msg_443_cli_${slug}_${i}`, T0 + i * 1000);
	if (swept) tag += JSON.stringify({ _meta: { offset: Buffer.byteLength(s), swept: T0 } }) + "\n";
	else tag += JSON.stringify({ _meta: { offset: Buffer.byteLength(s) } }) + "\n";
	fs.writeFileSync(path.join(tagsDir, path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`), tag);
	return { dir, sessionPath };
}

/** Run the CLI once; return its exit status, the two streams, and their
 *  concatenation.
 *
 *  `spawnSync`, not `execFileSync`, because the streams have to be separable on
 *  a ZERO exit too. execFileSync returns stdout alone on success and folds
 *  stderr in only on the thrown error, so the settled-run assertion below —
 *  "says nothing about being provisional" — was searching stdout for a sentence
 *  the code only ever writes to stderr. It could not have failed in any
 *  outcome, including a broken one. (#26 review.) */
function runCli(sessionPath: string): { code: number; out: string; stdout: string; stderr: string } {
	const r = spawnSync(process.execPath, [CLI_BIN, "-s", sessionPath, "--tokens", "--pad", "0"], {
		cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, WTFT_DAEMON_DEBUG: "" },
	});
	const stdout = r.stdout ?? "", stderr = r.stderr ?? "";
	return { code: r.status ?? -1, out: `${stdout}${stderr}`, stdout, stderr };
}

console.log("wtft CLI reports a provisional read (#443)");
console.log("──────────────────────────────");

{
	const { sessionPath } = makeFixture("stale", false);
	const r = runCli(sessionPath);
	assert(`a populated tag with no _meta.swept exits ${EXIT_PROVISIONAL} (got ${r.code})`, r.code === EXIT_PROVISIONAL, r.out);
	// On STDERR specifically: the exit code is for the machine and the sentence
	// is for the human, but neither may contaminate the report on stdout, which
	// is the thing this branch exists to keep printing in full.
	assert("  ...and says so in prose on stderr, for the human who can re-run it",
		/provisional/i.test(r.stderr), r.stderr);
	// Deliberately NOT /TOTAL/i: the crash this fixture first produced printed
	// "bin.tokens[category].total", which matched and passed a broken run.
	assert("  ...still printing the summary table rather than withholding it",
		/sonnet-4-6/.test(r.out) && /TOTAL/.test(r.out) && !/System Error/i.test(r.out));
}
{
	const { sessionPath } = makeFixture("settled", true);
	const r = runCli(sessionPath);
	assert(`the same tag carrying _meta.swept exits 0 (got ${r.code})`, r.code === 0, r.out);
	// Against BOTH streams. Asserted against stdout alone this could never fail:
	// the sentence is only ever written to stderr, so it searched for a string on
	// a stream that could not carry it in any outcome.
	assert("  ...and says nothing about being provisional, on either stream",
		!/provisional/i.test(r.out), r.out);
}

// --- The remedy must never advise -F ---------------------------------------
// PR review, Medium/contract. `-F` does NOT return early: it deletes the tag,
// kills the daemon, and falls through to this same read path, so a forced run
// can reach the provisional branch too — and "use -F to force a full re-parse"
// is then a loop, told to the person who just did it, about the run that is
// supposed to be the authoritative reference.
//
// Asserted on the ONE message rather than on a forced run, deliberately. The
// forced arm is reachable only inside a race between `flushPending` and the
// first `scanForSubAgents` — a real window, but not one a test can hit
// reliably. A first attempt branched on that and skipped on every run, which is
// not coverage. Since the remedy is now a single sentence true in both cases,
// "it never advises -F" is decidable from an ordinary provisional run, with no
// race and no skip.
{
	const { sessionPath } = makeFixture("staleremedy", false);
	const r = runCli(sessionPath);
	// Scoped to the remedy LINE, not the whole output. Testing `!/-F/` against
	// everything printed matched the mkdtemp path `/tmp/wtft-tmp-443-cli-F6hjmi/`
	// — the CLI echoes the session path, and a random suffix beginning with `F`
	// failed a correct run. It passed standalone and failed under `bun run test`
	// purely on which suffix mkdtemp handed out, which is the worse direction:
	// most orderings would have made it a false PASS.
	// Found by the CONSTANT, not a hardcoded 9: `Exit ${EXIT_PROVISIONAL}.` is
	// what the code interpolates, so re-typing the number here would leave this
	// green after the constant changed.
	const remedy = r.out.split("\n").find(l => l.includes(`Exit ${EXIT_PROVISIONAL}.`)) ?? "";
	assert("  (the remedy line was actually printed)", remedy !== "", r.out);
	assert("the provisional remedy never advises -F", !/-F/.test(remedy), remedy);
	assert("  ...it advises re-running, which is correct after -F too", /run wtft again/i.test(remedy), remedy);
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

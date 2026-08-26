/**
 * @package princess-pi-packages
 * @test wtft-513-exit9-caller-guard
 * @description #513 — a test that shells out to `wtft` must not fail because the
 *   read was PROVISIONAL.
 *
 *   #443 gave `wtft` exit **9**: the run SUCCEEDED and everything rendered, but
 *   the total may still grow because the daemon has not yet swept this session's
 *   subagent transcripts. `execSync` throws on any nonzero exit, so
 *   `tests/wtft-auto-fit.test.ts` began failing on a correct run.
 *
 *   INTERMITTENTLY, which is the part that made it expensive. The CLI spawns the
 *   daemon and reads the tag immediately, so on a brand-new session it sometimes
 *   wins that race and finds no `_meta.swept` marker. Standalone the suite passed
 *   4 of 4; under `bun run test` on a loaded box it failed. So it passed the
 *   branch, passed CI, and surfaced only on `main` after the merge.
 *
 *   PR #511 justified the new exit code with "nothing in this repo invokes the
 *   `wtft` CLI and inspects `$?`". That grep covered `bin/`, `hooks/`,
 *   `statusline/` and `skills/` — and not `tests/`. The claim was written into a
 *   commit message and a test header as though it were exhaustive.
 *
 *   This suite pins the guard itself, deterministically, rather than waiting for
 *   the race to reappear: it builds a tag that is provisional BY CONSTRUCTION
 *   (classified lines, no `_meta.swept`), so the CLI must exit 9 every run.
 *
 *   Closer: against a tag with no marker, `execSync` throws and `runWtftCli`
 *   returns the rendered stdout; and `runWtftCli` still rethrows a real failure.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { WTFT_TAGGER_VERSION } from "../bin/wtft.mjs";
import { runWtftCli, WTFT_EXIT_PROVISIONAL } from "./lib/wtft-cli";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("513-exit9");

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_BIN = path.join(REPO_ROOT, "bin", "wtft.mjs");

const RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function assert(label: string, ok: boolean, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else {
		console.log(`  ${RED}FAIL${RESET} ${label}`); failed++;
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

/** A tag line in the shape serializeClassified writes: `t`/`c`/`in`/`out`. */
function classified(id: string, tsMs: number): string {
	return JSON.stringify({
		t: tsMs, c: 0.0123, cat: "code", f: [], cmd: [],
		id, m: "claude-sonnet-4-6", in: 1200, out: 90,
	}) + "\n";
}

/** A session whose tag holds classified data and NO `_meta.swept` — provisional
 *  by construction, so the CLI exits 9 on every run rather than on a race. */
function makeProvisionalFixture() {
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-513-")));
	const sessionPath = path.join(dir, "session.jsonl");
	const T0 = Date.now() - 120_000;
	let s = JSON.stringify({ type: "session", version: 3, id: "parent-513", timestamp: new Date(T0).toISOString(), cwd: dir }) + "\n";
	for (let i = 0; i < 3; i++) s += turnLine(`msg_513_${i}`, T0 + i * 1000);
	fs.writeFileSync(sessionPath, s);

	const tagsDir = path.join(dir, "wtft-tags");
	fs.mkdirSync(tagsDir, { recursive: true });
	let tag = "";
	for (let i = 0; i < 3; i++) tag += classified(`msg_513_${i}`, T0 + i * 1000);
	tag += JSON.stringify({ _meta: { offset: Buffer.byteLength(s) } }) + "\n";
	fs.writeFileSync(path.join(tagsDir, path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`), tag);
	return sessionPath;
}

console.log("wtft CLI callers survive a provisional read (#513)");
console.log("──────────────────────────────");

const sessionPath = makeProvisionalFixture();
const cmd = `${process.execPath} '${CLI_BIN}' --cost -s '${sessionPath}' --pad 0`;

// The regression itself: raw execSync throws on a correct provisional run.
{
	let threw = false, status: number | undefined;
	try {
		execSync(cmd, { encoding: "utf8", timeout: 60_000 });
	} catch (err: unknown) {
		threw = true;
		status = (err as { status?: number }).status;
	}
	assert(`raw execSync throws on a provisional run (this IS the bug), status ${status}`,
		threw && status === WTFT_EXIT_PROVISIONAL);
}

// The guard: same command, output returned instead of an exception.
{
	let out = "";
	let threw = false;
	try {
		out = runWtftCli(cmd, { timeout: 60_000 });
	} catch { threw = true; }
	assert("runWtftCli does not throw on the same command", !threw);
	assert("  ...and returns the rendered output, not an empty string",
		/TOTAL|\$/.test(out), out.slice(0, 400));
}

// It must not swallow a REAL failure — otherwise it hides a broken CLI.
// Probed against a bare exit code rather than a malformed wtft invocation: the
// helper's contract is "0 and 9 return, everything else throws", and pinning it
// to wtft's own exit taxonomy would couple this to a table that is still growing
// (#510). A first draft used `-s /nonexistent/...` and proved nothing, because
// `-s` treats a non-file argument as a fuzzy session FILTER rather than a path,
// so it does not exit nonzero at all.
for (const code of [1, 2, 8]) {
	let threw = false;
	try {
		runWtftCli(`${process.execPath} -e 'process.exit(${code})'`, { timeout: 30_000 });
	} catch { threw = true; }
	assert(`runWtftCli still rethrows exit ${code}`, threw);
}
// ...and returns for the two that mean "the render happened".
for (const code of [0, WTFT_EXIT_PROVISIONAL]) {
	let threw = false;
	try {
		runWtftCli(`${process.execPath} -e 'process.stdout.write("ok"); process.exit(${code})'`, { timeout: 30_000 });
	} catch { threw = true; }
	assert(`runWtftCli returns for exit ${code}`, !threw);
}

// The return type must be a real string on BOTH paths (PR review). A first cut
// spread caller options after `encoding: "utf8"`, so a caller could override it
// and get a Buffer typed as a string; the success and provisional paths then
// disagreed for the same input. `encoding` is now pinned and off the signature,
// so this asserts the property the type claims.
{
	const provisional = runWtftCli(cmd, { timeout: 60_000 });
	const clean = runWtftCli(`${process.execPath} -e 'process.stdout.write("plain")'`, { timeout: 30_000 });
	assert("the provisional path returns a real string", typeof provisional === "string");
	assert("the success path returns a real string", typeof clean === "string" && clean === "plain");
}
{
	// A caller casting past the signature must not be able to defeat it either
	// (PR review, round 2). Node returns null from execSync whenever stdio leaves
	// stdout unpiped — regardless of encoding — and err.stdout is null on the
	// throw path too, so the provisional branch would return "" instead of the
	// real output. Omit binds type-checked callers only; the body strips both.
	const hostile = { stdio: "inherit", encoding: "buffer" } as unknown as Parameters<typeof runWtftCli>[1];
	const out = runWtftCli(`${process.execPath} -e 'process.stdout.write("still-captured")'`,
		{ ...hostile, timeout: 30_000 });
	assert("a cast-past stdio/encoding cannot defeat the capture",
		typeof out === "string" && out === "still-captured", String(out));
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

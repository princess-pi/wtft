/**
 * @package princess-pi-packages
 * @test wtft-270-single-subagent-reader
 * @description #270 — ONE reader for sub-agent transcripts, not two.
 *
 *   #270's bug is "we matched this file once, so we are done reading it." The
 *   daemon had that shape in TWO places, because it discovers sub-agent
 *   transcripts two ways: Task/agent/workflow spawns (#82) and `claude -p` bash
 *   commands (#138). Round after round fixed the Task/agent path — size/mtime
 *   change detection, whole-file re-parse, hash-based append filter — while the
 *   `claude -p` path kept parsing once at discovery via `writeSessionToTagFile`
 *   and dropping everything the transcript wrote afterwards.
 *
 *   That gap outlived several review rounds, and the response to it at one point
 *   was an ungated stderr warning ANNOUNCING that this path silently undercounts.
 *   A warning is a note about a defect, not a fix for one — and #436 is the
 *   standing evidence that the daemon's stderr reaches nobody in production
 *   anyway, since both spawn sites use `stdio: "ignore"`.
 *
 *   The fix is structural: `syncSubagentTranscript(file)` is the single reader,
 *   and both discovery paths call it every poll. Discovery stays one-shot — a
 *   bash command resolves to its transcript once, and that match cannot
 *   un-happen — but READING is per-poll for both kinds. This suite pins the
 *   structure, because the property is "there is no second reader," which no
 *   behavioural test of one path can express.
 *
 *   WHAT THIS DOES NOT ENFORCE (PR review). The check is a regex over
 *   comment-stripped source, so it catches the regression that actually
 *   happened — a second reader written out longhand, which is how the `claude -p`
 *   path kept its own copy for several rounds — and it is defeated by any
 *   equivalent-but-differently-shaped violation: aliasing
 *   (`const f = syncSubagentTranscript; f(x)`), `.call()`/`.apply()`, or a
 *   wrapper helper that itself calls it once per batch. Enforcing "one reader"
 *   at the type or runtime level is not something TypeScript expresses, so this
 *   is a tripwire on the known shape rather than a proof. Treat a green run as
 *   "the literal regression did not recur," not as "the invariant holds."
 *
 *   Closer: `bin/wtft-daemon.ts` defines `syncSubagentTranscript` exactly once,
 *   both discovery paths call it, `writeSessionToTagFile` is gone, and nothing
 *   uses the `claude -p` registry to SKIP a read — a `.has()`-guarded `continue`
 *   over `discoveredClaudeFiles` is the original bug returning by another name.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const DAEMON = join(REPO_ROOT, "bin", "wtft-daemon.ts");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean, detail = ""): void {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.error(`  ${RED}FAIL${RESET} ${label}${detail ? `\n       ${detail}` : ""}`); failed++; }
}

console.log("wtft: one reader for sub-agent transcripts (#270)");

const src = readFileSync(DAEMON, "utf8");

// Strip comments so a prose mention of a retired symbol is not read as code.
// Block comments first, then line comments — and only `//` that starts a line
// (after whitespace), so a `//` inside a string or URL is left alone.
const code = src
	.replace(/\/\*[\s\S]*?\*\//g, "")
	.split("\n")
	.filter(l => !/^\s*\/\//.test(l))
	.join("\n");

const defs = code.match(/function\s+syncSubagentTranscript\s*\(/g) || [];
assert(
	`syncSubagentTranscript is defined exactly once (found ${defs.length})`,
	defs.length === 1,
);

const calls = code.match(/syncSubagentTranscript\s*\(\s*file\s*\)/g) || [];
assert(
	`both discovery paths call it — at least 2 call sites (found ${calls.length})`,
	calls.length >= 2,
);

// The retired second reader. Matched WITH a paren so the docstring that explains
// the retirement does not count as a use.
const retired = code.match(/writeSessionToTagFile\s*\(/g) || [];
assert(
	`writeSessionToTagFile is gone — no second reader (found ${retired.length})`,
	retired.length === 0,
);

// The suppressing seen-set that WAS the bug on the claude -p path.
assert(
	"discoveredClaudeSessions (the suppress-by-id seen-set) is gone",
	!/discoveredClaudeSessions/.test(code),
);

// The registry must gate DISCOVERY, never the read. A `has()` test on it that
// guards a continue/return is #270 reintroduced under a new identifier.
const skipGuard = /discoveredClaudeFiles\s*\.\s*has\s*\([^)]*\)\s*\)?\s*(continue|return)/.test(code);
assert(
	"nothing uses discoveredClaudeFiles.has(...) to skip a read",
	!skipGuard,
);

// Both loops must iterate for reading; the claude -p one reads the registry.
assert(
	"the claude -p registry is iterated for reading every poll",
	/for\s*\(\s*const\s+file\s+of\s+discoveredClaudeFiles\s*\)/.test(code),
);

assert(
	"the Task/agent path still iterates its own discovery result",
	/for\s*\(\s*const\s+file\s+of\s+taskAgentFiles\s*\)/.test(code),
);

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

/**
 * @package princess-pi-tools
 * @test wtft-270-single-subagent-reader
 * @description #270 — ONE reader for sub-agent transcripts, not two.
 *
 *   The daemon discovers sub-agent transcripts two ways: Task/agent/workflow
 *   spawns (#82) and `claude -p` bash commands (#138). `syncSubagentTranscript(file)`
 *   is the single reader; both discovery paths call it every poll. Discovery
 *   stays one-shot; READING is per-poll for both kinds. This suite pins
 *   "there is no second reader."
 *
 *   Limit: the check is a regex over comment-stripped source — a tripwire on
 *   the known shape, not a proof against aliasing or wrappers.
 *
 *   Closer: `bin/wtft-daemon.ts` defines `syncSubagentTranscript` exactly once,
 *   both discovery paths call it, `writeSessionToTagFile` is gone, and nothing
 *   uses the `claude -p` registry to SKIP a read.
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

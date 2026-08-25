#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-420-subagent-call-site
 * @description #420 review (Medium/contract, bin/wtft-daemon.ts) — the
 *   "never call `attributeClaudeSubAgentCosts` over anything less than the
 *   whole file" rule (docs/wtft-incremental-render-spec.md, "Per-Call, Not
 *   Global") was enforced by a comment only:
 *   "do NOT add a second call here, that is the round-3 High"
 *   (bin/wtft-daemon.ts, the subagent re-parse loop). `seenSessionIds` (extensions/lib/wtft-parser.ts, inside attributeClaudeSubAgentCosts)
 *   is a `Set` scoped to one call, so a second production call site over a
 *   partial slice — e.g. a byte-offset reader added for the still-one-shot
 *   `claude -p` bash sub-agent path (bin/wtft-daemon.ts, #420 review)
 *   — reintroduces exactly the silent double-attribution three review rounds
 *   spent fixing (tests/wtft-270-subagent-nested-claude-attribution.test.ts),
 *   and nothing but a maintainer re-reading the comment would catch it.
 *
 *   This pins the invariant as a fact about the source tree, not a promise in
 *   prose: `attributeClaudeSubAgentCosts(` appears in tracked, non-generated,
 *   non-test TypeScript exactly twice — once as the function's own
 *   `export function` definition, and once as the single call site inside
 *   `parseSessionFile`, which always hands it the WHOLE parsed file. A second
 *   call site anywhere else fails this test immediately, by name and line.
 *
 * @usage bun run test wtft-420-subagent-call-site
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const PARSER_FILE = join(REPO_ROOT, "extensions", "lib", "wtft-parser.ts");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} else {
		console.error(`  ${RED}FAIL${RESET} ${label}${detail ? `\n       ${detail}` : ""}`);
		failed++;
	}
}

// Every tracked .ts source file under extensions/ and bin/, skipping node_modules,
// dist/build output, and this repo's own worktree/scratch directories. tests/ is
// NOT walked at all — that is the whole reason a test exercising the function
// directly (none does today) cannot trip this guard. An earlier version of this
// comment claimed tests were "walked separately below", which sent a reader
// looking for handling that was never written (PR review, #420).
function walkTsFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === ".git" || entry.startsWith(".claude")) continue;
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			walkTsFiles(full, out);
		} else if (extname(entry) === ".ts") {
			out.push(full);
		}
	}
	return out;
}

console.log("wtft #420: attributeClaudeSubAgentCosts has exactly one production call site\n");

const sourceFiles = [
	...walkTsFiles(join(REPO_ROOT, "extensions")),
	...walkTsFiles(join(REPO_ROOT, "bin")),
];

const MENTIONS_CALL = /attributeClaudeSubAgentCosts\s*\(/;
const IS_DEFINITION = /^\s*export\s+function\s+attributeClaudeSubAgentCosts\s*\(/;
const callSites: { file: string; line: number; isDefinition: boolean }[] = [];

for (const file of sourceFiles) {
	const content = readFileSync(file, "utf8");
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (!MENTIONS_CALL.test(lines[i])) continue;
		callSites.push({
			file: relative(REPO_ROOT, file),
			line: i + 1,
			isDefinition: IS_DEFINITION.test(lines[i]),
		});
	}
}

const definitions = callSites.filter((c) => c.isDefinition);
const calls = callSites.filter((c) => !c.isDefinition);

assert(
	"exactly one definition, in extensions/lib/wtft-parser.ts",
	definitions.length === 1 && definitions[0].file === "extensions/lib/wtft-parser.ts",
	`found: ${JSON.stringify(definitions)}`,
);

assert(
	"exactly one production call site",
	calls.length === 1,
	calls.length === 0
		? "no call site found at all — attributeClaudeSubAgentCosts is now dead code, or this test's file walk is broken"
		: `found ${calls.length}: ${JSON.stringify(calls)}\n` +
			"A second call site means something is handing attributeClaudeSubAgentCosts a\n" +
			"slice of a file rather than the whole thing — seenSessionIds only guards\n" +
			"double-counting WITHIN one call. Fold the new call into parseSessionFile's\n" +
			"existing whole-file call, or update this test with the reviewed reason the\n" +
			"invariant no longer holds.",
);

if (calls.length === 1) {
	assert(
		"the one call site is inside parseSessionFile, in wtft-parser.ts",
		calls[0].file === "extensions/lib/wtft-parser.ts",
		`call site is in ${calls[0].file}:${calls[0].line} instead`,
	);

	// Confirm the call is textually inside parseSessionFile's body — between its
	// `export function` line and the next top-level `export function` after it —
	// rather than merely in the same file.
	const content = readFileSync(PARSER_FILE, "utf8");
	const lines = content.split("\n");
	const startIdx = lines.findIndex((l) => /^export function parseSessionFile\(/.test(l));
	let endIdx = lines.length;
	for (let i = startIdx + 1; i < lines.length; i++) {
		if (/^export function /.test(lines[i])) { endIdx = i; break; }
	}
	const callLineIdx = calls[0].line - 1;
	assert(
		"the call site sits inside parseSessionFile's body (whole-file scope)",
		startIdx !== -1 && callLineIdx > startIdx && callLineIdx < endIdx,
		`parseSessionFile spans lines ${startIdx + 1}-${endIdx}, call site is line ${calls[0].line}`,
	);
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

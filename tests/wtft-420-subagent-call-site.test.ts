#!/usr/bin/env bun
/**
 * #420 / #97 — attributeClaudeSubAgentCosts runs on a whole transcript's
 * fold-capable turns in one call, never on a poll-sized slice.
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
// looking for handling that was never written

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

const parserCalls = calls.filter((c) => c.file === "extensions/lib/wtft-parser.ts");
const daemonCalls = calls.filter((c) => c.file === "bin/wtft-daemon.ts");
const elsewhere = calls.filter((c) => c.file !== "extensions/lib/wtft-parser.ts" && c.file !== "bin/wtft-daemon.ts");

assert(
	"parseSessionFile is the only parser call site",
	parserCalls.length === 1,
	`found ${parserCalls.length}: ${JSON.stringify(parserCalls)}`,
);
assert(
	"the daemon calls it once, on every fold-capable turn of that transcript together (#97)",
	daemonCalls.length === 1,
	`found ${daemonCalls.length}: ${JSON.stringify(daemonCalls)}\n` +
		"A poll-sized slice double-counts a nested session. The daemon call has to pass every\n" +
		"retained fold-capable turn of one transcript, cloned from its pre-fold base.",
);
assert(
	"no other production call site",
	elsewhere.length === 0,
	`found: ${JSON.stringify(elsewhere)}`,
);

if (parserCalls.length === 1) {
	const content = readFileSync(PARSER_FILE, "utf8");
	const lines = content.split("\n");
	const startIdx = lines.findIndex((l) => /^export function parseSessionFile\(/.test(l));
	let endIdx = lines.length;
	for (let i = startIdx + 1; i < lines.length; i++) {
		if (/^export function /.test(lines[i])) { endIdx = i; break; }
	}
	const callLineIdx = parserCalls[0].line - 1;
	assert(
		"the parser call site sits inside parseSessionFile's body (whole-file scope)",
		startIdx !== -1 && callLineIdx > startIdx && callLineIdx < endIdx,
		`parseSessionFile spans lines ${startIdx + 1}-${endIdx}, call site is line ${parserCalls[0].line}`,
	);
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

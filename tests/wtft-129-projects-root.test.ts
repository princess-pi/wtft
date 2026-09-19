#!/usr/bin/env -S bun
/**
 * tests/wtft-129-projects-root.test.ts — one definition of the projects root (#129)
 *
 * `claude -p` sub-agent discovery, session lookup and the Token Budget scan
 * get the Claude projects root from `projectsDir()`, so
 * `WTFT_CLAUDE_PROJECTS_DIR` redirects all three. Part A folds a `claude -p`
 * child through the override; Part B fails on a second production file that
 * contains the literal `".claude", "projects"` pair.
 *
 * Run:  bun tests/wtft-129-projects-root.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionFile, discoverClaudeSubAgentSessionFiles } from "../extensions/lib/wtft-parser.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("129-projects-root");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-129-")));
const projects = path.join(dir, "projects");
process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;

// ---
// PART A — the Closer: the parse folds a child in through the seam
// ---
console.log("\nPART A — a parent's parse folds a claude -p child found under the seam's root");

const T0 = Date.UTC(2026, 8, 18, 5, 0, 0);
const CHILD = "d38296d6-1111-4222-8333-444455556666";

function turnLine(id: string, tsMs: number, outputTokens: number, command?: string): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso,
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6", timestamp: iso,
			usage: { input_tokens: 1000, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: command
				? [{ type: "toolCall", name: "bash", arguments: { command } }]
				: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

const childCwd = path.join(dir, "child-project");
const childProjectDir = path.join(projects, childCwd.replace(/\//g, "-"));
fs.mkdirSync(childProjectDir, { recursive: true });
fs.writeFileSync(path.join(childProjectDir, `${CHILD}.jsonl`), turnLine("child-turn", T0 + 2_000, 700));

const parent = path.join(dir, "parent.jsonl");
fs.writeFileSync(parent,
	JSON.stringify({ type: "session", version: 3, id: "parent-129", timestamp: new Date(T0).toISOString(), cwd: dir }) + "\n"
	+ turnLine("parent-turn", T0, 100, `cd ${childCwd} && claude -p "go"`));

const found = discoverClaudeSubAgentSessionFiles(childCwd, T0);
check(found.unreadable === null && found.files.map(f => path.basename(f, ".jsonl")).join() === CHILD,
	`A1 discovery reads the seam's root, not the home directory (got ${JSON.stringify(found.files.map(f => path.basename(f)))})`);

const outputOf = (file: string) => parseSessionFile(file).reduce((sum, i) => sum + i.outputTokens, 0);
check(outputOf(parent) === 800,
	`A2 the parent's parse carries its own 100 output tokens plus the child's 700 (got ${outputOf(parent)})`);

// ---
// PART B — no second reader re-derives the root
// ---
console.log("\nPART B — the projects root is derived in one place");

function sourcesUnder(root: string): string[] {
	return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) return sourcesUnder(full);
		return entry.name.endsWith(".ts") ? [full] : [];
	});
}
const repo = path.resolve(import.meta.dirname, "..");
const rederivers = [...sourcesUnder(path.join(repo, "extensions")), ...sourcesUnder(path.join(repo, "bin"))]
	.filter(file => /["']\.claude["']\s*,\s*["']projects["']/.test(fs.readFileSync(file, "utf8")))
	.map(file => path.relative(repo, file));
check(rederivers.join() === "extensions/lib/harness/claude-code/discovery.ts",
	`B1 in extensions/ and bin/, only the harness seam contains the literal ".claude", "projects" pair (got ${JSON.stringify(rederivers)})`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

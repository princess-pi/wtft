#!/usr/bin/env -S node --experimental-strip-types
/**
 * Claude Code discovery across a repo's checkouts when git cannot list them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { trackSandbox } from "./lib/sandbox";
import { discoverSessions, resetCwdCache, resetHarnessRegistry, cwdToStrictSlug } from "../bin/wtft.mjs";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const sandbox = fs.realpathSync(trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-174-"))));
const app = path.join(sandbox, "app");
const other = path.join(sandbox, "app-other");
const inTree = path.join(app, ".claude", "worktrees", "b");
fs.mkdirSync(path.join(app, ".git"), { recursive: true });
fs.mkdirSync(path.join(app, "src"), { recursive: true });
fs.mkdirSync(path.join(other, ".git"), { recursive: true });

const projects = path.join(sandbox, "projects");
function transcript(slugOf: string, name: string, cwd: string): void {
	const file = path.join(projects, cwdToStrictSlug(slugOf), name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ type: "user", cwd, message: { role: "user", content: "hi" } }) + "\n");
}
transcript(app, "root.jsonl", app);
transcript(other, "other.jsonl", other);
transcript(inTree, "in-tree.jsonl", inTree);

process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
process.env.WTFT_NO_GIT = "1";
for (const [label, opts] of [["worktrees scope", { scope: "worktrees", windowMs: null }], ["unscoped default", undefined]] as const) {
	resetHarnessRegistry();
	resetCwdCache();
	const found = discoverSessions("claude-code", path.join(app, "src"), opts).map((c: any) => c.name);
	check(found.includes("root.jsonl"), `${label}: from a subdirectory, the repo root's session is found (got ${found.join(", ")})`);
	check(found.includes("in-tree.jsonl"), `${label}: an in-tree worktree's session is found`);
	check(!found.includes("other.jsonl"), `${label}: from a subdirectory, a sibling repo whose name extends this one's is not`);

	resetCwdCache();
	const fromRoot = discoverSessions("claude-code", app, opts).map((c: any) => c.name);
	check(fromRoot.includes("root.jsonl") && fromRoot.includes("in-tree.jsonl"), `${label}: from the root, its own and the in-tree worktree's sessions are found (got ${fromRoot.join(", ")})`);
	check(!fromRoot.includes("other.jsonl"), `${label}: a sibling repo whose name extends this one's is not`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

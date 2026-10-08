#!/usr/bin/env -S bun

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { discoverClaudeSubAgentSessionFiles, discoverSubagentSessionFiles } from "../extensions/lib/wtft-parser.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { cliWithoutDaemon, tagForCli } from "./lib/cli-harness.ts";
import { skip } from "./lib/skips";

isolateTmpdir("369-skip-unreadable");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detail?: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.log(`  ❌ FAIL: ${msg}${detail ? `\n     ${detail}` : ""}`); }
}

function captureStderr<T>(fn: () => T): { result: T; stderr: string } {
	const original = process.stderr.write.bind(process.stderr);
	let stderr = "";
	process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
	try { return { result: fn(), stderr }; } finally { process.stderr.write = original; }
}

function cannotOpen(file: string): boolean {
	try { fs.closeSync(fs.openSync(file, "r")); return false; } catch { return true; }
}

const T0 = Date.now() - 60_000;

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

if (process.getuid?.() === 0) {
	skip("root reads a mode-000 file, so no fixture here can be unreadable");
	process.exit(0);
}

const dir = fs.realpathSync(trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-369-"))));
const projects = path.join(dir, "projects");
process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;

const CHILD = "36900000-0000-4000-8000-000000000001";
const STRAY = "36900000-0000-4000-8000-000000000002";
const childCwd = path.join(dir, "child-project");
const projectDir = path.join(projects, childCwd.replace(/[/.]/g, "-"));
fs.mkdirSync(projectDir, { recursive: true });
const childFile = path.join(projectDir, `${CHILD}.jsonl`);
const strayFile = path.join(projectDir, `${STRAY}.jsonl`);
fs.writeFileSync(childFile, turnLine("child-turn", T0 + 2_000, 700));
fs.writeFileSync(strayFile, turnLine("stray-turn", T0 - 3_600_000, 50));
fs.chmodSync(strayFile, 0o000);

console.log("\n=== claude -p discovery: the seam ===\n");
{
	check(cannotOpen(strayFile), "precondition: the mode-000 transcript cannot be opened");
	const { result, stderr } = captureStderr(() => discoverClaudeSubAgentSessionFiles(childCwd, T0));
	check(Array.isArray(result) && result.length === 1 && result[0] === childFile,
		"discovery returns exactly the readable in-window child", JSON.stringify(result));
	check(stderr === "", "discovery writes nothing to stderr", stderr);
}

console.log("\n=== claude -p discovery: the report ===\n");
{
	const parent = path.join(dir, "parent.jsonl");
	fs.writeFileSync(parent,
		JSON.stringify({ type: "session", version: 3, id: "parent-369", timestamp: new Date(T0).toISOString(), cwd: dir }) + "\n"
		+ turnLine("parent-turn", T0, 100, `cd ${childCwd} && claude -p "go"`));
	const { result: tagLog, stderr: tagStderr } = captureStderr(() => {
		try { return JSON.stringify(tagForCli(parent).log); } catch { return null; }
	});
	check(tagLog !== null, "the tagger sweeps the parent: the unreadable transcript does not hold its tag provisional");
	const r = spawnSync(process.execPath, [cliWithoutDaemon(), "-s", parent, "--json"], {
		cwd: dir, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, WTFT_CLAUDE_PROJECTS_DIR: projects, COLUMNS: "250" },
	});
	let doc: any = null;
	try { doc = JSON.parse(r.stdout); } catch { /* asserted below */ }
	check(r.status === 0, `wtft -s <parent> --json exits 0 (got ${r.status})`, r.stderr);
	check(doc?.total?.outputTokens === 800,
		`the report folds the child: 100 output tokens of its own plus the child's 700 (got ${doc?.total?.outputTokens})`);
	const said = [tagLog ?? "", tagStderr, r.stdout, r.stderr].join("\n");
	check(!said.includes(STRAY), "neither the tagger's log or stderr nor the report's stdout or stderr names the unreadable transcript", said.slice(0, 400));
}

console.log("\n=== Pi sibling scan ===\n");
{
	const piDir = path.join(dir, "pi-sessions");
	fs.mkdirSync(piDir);
	const header = (id: string, parentSession?: string) =>
		JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(T0).toISOString(), cwd: dir, ...(parentSession ? { parentSession } : {}) }) + "\n";
	const main = path.join(piDir, "main.jsonl");
	const piChild = path.join(piDir, "child.jsonl");
	const piStray = path.join(piDir, "stray.jsonl");
	fs.writeFileSync(main, header("pi-main-369"));
	fs.writeFileSync(piChild, header("pi-child-369", "pi-main-369"));
	fs.writeFileSync(piStray, header("pi-stray-369", "pi-main-369"));
	fs.chmodSync(piStray, 0o000);
	check(cannotOpen(piStray), "precondition: the mode-000 sibling cannot be opened");
	const { result, stderr } = captureStderr(() => discoverSubagentSessionFiles(main));
	check(result.unreadable === null && result.files.length === 1 && result.files[0] === piChild,
		"the scan returns exactly the readable child, with unreadable null", JSON.stringify({ files: result.files, unreadable: result.unreadable?.message }));
	check(stderr === "", "the scan writes nothing to stderr", stderr);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

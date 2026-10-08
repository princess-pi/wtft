#!/usr/bin/env bun
/**
 * wtft run from a deleted working directory. Spec: docs/spec-9-deleted-cwd.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { mkSandbox, isolateTmpdir } from "./lib/sandbox";
import { reapFixtureDaemons } from "./lib/reap-fixture-daemons";

const TMP = isolateTmpdir("9-deleted-cwd");
const CLI = path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const root = mkSandbox(path.join(TMP, "root-"));
const home = path.join(root, "home");
const projects = path.join(root, "projects");
fs.mkdirSync(home);
fs.mkdirSync(projects);
const env = {
	...process.env,
	HOME: home,
	WTFT_CLAUDE_PROJECTS_DIR: projects,
	WTFT_PI_SESSIONS_DIR: path.join(root, "no-pi"),
};

/** Runs the CLI from a shell whose working directory was removed; exit 97 means node could still read it. */
function inDeletedDir(args: string[]) {
	const script = [
		`d=$(mktemp -d -p "${root}")`,
		`cd "$d" && rmdir "$d" || exit 98`,
		`node -e 'try { process.cwd(); process.exit(97) } catch { process.exit(0) }' || exit 97`,
		`exec node "$0" "$@"`,
	].join("\n");
	return spawnSync("bash", ["-c", script, CLI, ...args], { encoding: "utf8", env, timeout: 30_000 });
}

try {
	console.log("V1 --version from a deleted working directory");
	{
		const r = inDeletedDir(["--version"]);
		check(r.status !== 97 && r.status !== 98, `fixture precondition: node cannot read the working directory (exit ${r.status})`);
		check(r.status === 0 && /\d+\.\d+\.\d+/.test(r.stdout), `exits 0 and prints the version (exit ${r.status}: ${r.stderr.trim().slice(0, 200)})`);
	}

	console.log("\nV2 --json with no --dir");
	{
		const r = inDeletedDir(["--json"]);
		check(!r.stderr.includes("uv_cwd"), `no uv_cwd error (${r.stderr.trim().slice(0, 200)})`);
		check(r.stderr.includes(home) && r.stderr.includes("--dir"), `stderr names the home directory and --dir (${r.stderr.trim().slice(0, 300)})`);
	}

	console.log("\nV3 --json --dir <project>");
	{
		const project = path.join(root, "project");
		fs.mkdirSync(project);
		const dir = path.join(projects, project.replace(/[^A-Za-z0-9]/g, "-"));
		fs.mkdirSync(dir);
		const session = path.join(dir, "11111111-2222-4333-8444-555555555555.jsonl");
		fs.writeFileSync(session, JSON.stringify({
			type: "assistant", timestamp: new Date().toISOString(), cwd: project, sessionId: "11111111-2222-4333-8444-555555555555",
			message: { role: "assistant", id: "msg_9", model: "claude-sonnet-4-6", usage: { input_tokens: 1000, output_tokens: 10 }, content: [{ type: "text", text: "t" }] },
		}) + "\n");
		const r = inDeletedDir(["--json", "--dir", project]);
		check(!r.stderr.includes("uv_cwd"), `no uv_cwd error (${r.stderr.trim().slice(0, 200)})`);
		check((r.stdout + r.stderr).includes(session), `discovery anchored at --dir finds the project's session (exit ${r.status}: ${r.stderr.trim().slice(0, 300)})`);
		check(!r.stderr.includes(home), `stderr carries no notice naming the home directory (${r.stderr.trim().slice(0, 200)})`);
	}

	console.log("\nV4 --dir that cannot be entered");
	{
		const r = inDeletedDir(["--json", "--dir", path.join(root, "no-such-dir")]);
		check(!r.stderr.includes("uv_cwd"), `no uv_cwd error (${r.stderr.trim().slice(0, 200)})`);
		check(r.stderr.includes(`runs from ${home}`), `stderr names the home directory it moved to (${r.stderr.trim().slice(0, 300)})`);
		const dot = inDeletedDir(["--json", "--dir", "."]);
		check(!dot.stderr.includes("uv_cwd") && dot.stderr.includes(`runs from ${home}`), `--dir . (the deleted directory itself) falls back to home (${dot.stderr.trim().slice(0, 300)})`);
	}

	console.log("\nV5 spawn-record prints nothing");
	{
		const ids = ["--parent", "9f29d624-531c-47b0-abf6-0790bb65180d", "--child", "d38296d6-aaaa-4bbb-8ccc-ddddeeeeffff", "--mechanism", "test"];
		const bare = inDeletedDir(["spawn-record", ...ids]);
		check(bare.status === 0 && bare.stdout === "" && bare.stderr === "", `exits 0 and prints nothing (exit ${bare.status}: ${JSON.stringify(bare.stderr.slice(0, 200))})`);
		const withCwd = inDeletedDir(["spawn-record", ...ids, "--cwd", path.join(root, "project")]);
		check(withCwd.status === 0 && withCwd.stdout === "" && withCwd.stderr === "", `with --cwd, exits 0 and prints nothing (exit ${withCwd.status}: ${JSON.stringify(withCwd.stderr.slice(0, 200))})`);
	}
} finally {
	reapFixtureDaemons(root);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

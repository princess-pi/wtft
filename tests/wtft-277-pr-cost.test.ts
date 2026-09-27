/**
 * `pr-cost.ts`: the per-PR cost record. docs/spec-277-pr-cost.md § 6.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";

import { classifyFiles, collectSessionCost, listTranscripts, macroscopeRounds, readPrReview, readTestRuns, withPrCostBlock } from "../pr-cost.ts";
import { appendTestRun } from "./lib/test-run-log.ts";
import { parseSessionFile } from "../extensions/lib/wtft-parser.ts";
import { cwdToStrictSlug } from "../extensions/lib/harness/session-cwd.ts";

const tmp = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-277-")));

describe("files", () => {
	it("counts source, tests and docs; bun.lock is none of them", () => {
		assert.deepStrictEqual(
			classifyFiles([
				"bin/wtft.ts", "extensions/lib/lease.ts", "pr-cost.ts",
				"tests/wtft-1.test.ts", "tests/lib/sandbox.ts",
				"docs/spec-1.md", "docs/manifests/wtft-cmd.json", "README.md", "CONTEXT.md",
				"bun.lock",
			]),
			{ source: 3, tests: 2, docs: 4 },
		);
	});
});

// ---
// Transcripts
// ---

const T0 = Date.UTC(2026, 8, 20, 10, 0, 0);
const clone = path.join(tmp, "repo");
const worktree = path.join(clone, ".claude", "worktrees", "7-thing");
const otherWorktree = path.join(clone, ".claude", "worktrees", "8-other");
const projects = path.join(tmp, "projects");
process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;

function user(tsMs: number, cwd: string): string {
	return JSON.stringify({ type: "user", timestamp: new Date(tsMs).toISOString(), cwd,
		message: { role: "user", content: "go" } }) + "\n";
}
function turn(id: string, tsMs: number, cwd: string, output: number, blocks?: unknown[]): string {
	return JSON.stringify({
		type: "assistant", timestamp: new Date(tsMs).toISOString(), cwd,
		message: { role: "assistant", id, model: "claude-sonnet-4-6",
			content: blocks ?? [{ type: "text", text: id }],
			usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
	}) + "\n";
}
function write(dir: string, name: string, lines: string[], mtimeMs = T0 + 3_600_000): string {
	fs.mkdirSync(dir, { recursive: true });
	const p = path.join(dir, name);
	fs.writeFileSync(p, lines.join(""));
	fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
	return p;
}

const cloneDir = path.join(projects, cwdToStrictSlug(clone));
const wtDir = path.join(projects, cwdToStrictSlug(worktree));
const a = write(cloneDir, "a.jsonl", [
	user(T0, clone), turn("m1", T0 + 1000, clone, 1),
	user(T0 + 2000, worktree), turn("m2", T0 + 3000, worktree, 2),
	turn("m3", T0 + 4000, path.join(worktree, "docs"), 4),
	turn("m9", T0 + 6000, clone, 256, [{ type: "tool_use", name: "Bash", input: { command: `cd ${worktree} && bun run test` } }]),
	turn("m10", T0 + 7000, clone, 512, [{ type: "tool_use", name: "Edit", input: { file_path: path.join(worktree, "pr-cost.ts"), old_string: "a", new_string: "b" } }]),
	turn("m11", T0 + 8000, clone, 1024, [{ type: "tool_use", name: "Bash", input: { command: `cd ${worktree}-else && ls; cd ${worktree}+other` } }]),
	turn("m12", T0 + 9000, clone, 2048, [{ type: "tool_use", name: "Bash", input: { command: `cd ~${worktree.slice(tmp.length)}; ls` } }]),
]);
const sub = write(path.join(cloneDir, "a", "subagents"), "agent-1.jsonl", [turn("m4", T0 + 5000, worktree, 8)]);
// A resumed session's new transcript repeats m2: one message, counted once.
write(cloneDir, "a-resumed.jsonl", [user(T0 + 2000, worktree), turn("m2", T0 + 3000, worktree, 2)]);
const nested = write(path.join(cloneDir, "a", "subagents", "workflows", "wf_1"), "agent-2.jsonl", [turn("m13", T0 + 10_000, worktree, 4096)]);
const legacy = write(path.join(cloneDir, "sessions"), "e.jsonl", [user(T0 + 11_000, worktree), turn("m14", T0 + 12_000, worktree, 8192)]);
const bTs = T0 + 60_000;
const b = write(wtDir, "b.jsonl", [
	user(bTs, worktree),
	turn("m5", bTs + 1000, worktree, 16, [{ type: "tool_use", name: "Bash", input: { command: "claude -p hi" } }]),
]);
const d = write(wtDir, "d.jsonl", [user(bTs + 2000, worktree), turn("m7", bTs + 3000, worktree, 32)]);
write(path.join(projects, cwdToStrictSlug(otherWorktree)), "c.jsonl", [user(T0, otherWorktree), turn("m6", T0 + 1000, otherWorktree, 64)]);
write(wtDir, "old.jsonl", [user(T0, worktree), turn("m8", T0 + 1000, worktree, 128)], T0 - 3_600_000);

function costOf(file: string, ids: string[]): number {
	return parseSessionFile(file).filter(i => ids.includes(i.messageId!)).reduce((s, i) => s + i.cost, 0);
}

describe("sessions", () => {
	const got = collectSessionCost({ cloneDir: clone, worktree, sinceMs: T0 - 60_000, home: tmp });

	it("precondition: b's spawning turn folds d", () => {
		const m5 = parseSessionFile(b).find(i => i.messageId === "m5")!;
		assert.ok(m5.claudeSubAgentFolds?.some(f => f.file === d), "m5 folds d.jsonl");
	});
	it("counts turns run in the worktree or reaching into it, subagent transcripts included, folded transcripts once", () => {
		assert.strictEqual(got!.turns, 9, "m2, m3, m9, m10, m12 (~ for home), m4, m13 (nested), m14 (sessions/), m5");
		assert.strictEqual(got!.transcripts, 5, "a, agent-1, agent-2, e, b");
		assert.strictEqual(got!.outputTokens, 2 + 4 + 256 + 512 + 2048 + 8 + 4096 + 8192 + 16 + 32, "m7 inside m5's fold; not m11, a sibling path");
		const expected = costOf(a, ["m2", "m3", "m9", "m10", "m12"]) + costOf(sub, ["m4"]) + costOf(nested, ["m13"]) + costOf(legacy, ["m14"]) + costOf(b, ["m5"]);
		assert.ok(Math.abs(got!.costUsd - expected) < 1e-12, `${got!.costUsd} vs ${expected}`);
		assert.ok(got!.costUsd > costOf(a, ["m2", "m3", "m9", "m10", "m12"]) + costOf(sub, ["m4"]), "fold priced in");
	});
	it("a worktree outside the clone has its own transcripts read", () => {
		const outside = path.join(tmp, "elsewhere", "7-thing");
		write(path.join(projects, cwdToStrictSlug(outside)), "f.jsonl", [user(T0, outside), turn("m15", T0 + 1000, outside, 3)]);
		assert.strictEqual(collectSessionCost({ cloneDir: clone, worktree: outside, sinceMs: 0 })?.outputTokens, 3);
	});
	it("a sessions symlink back to its own project directory is not followed", () => {
		const loopRoot = path.join(tmp, "loop-projects");
		const dir = path.join(loopRoot, cwdToStrictSlug(clone));
		write(dir, "g.jsonl", [turn("m16", T0, worktree, 1)]);
		fs.symlinkSync(".", path.join(dir, "sessions"));
		assert.strictEqual(listTranscripts(clone, 0, loopRoot).length, 1);
	});
	it("a missing projects directory lists nothing rather than throwing", () => {
		assert.deepStrictEqual(listTranscripts(clone, 0, path.join(tmp, "no-projects")), []);
	});
	it("a worktree no turn reached is null, not zero", () => {
		assert.strictEqual(collectSessionCost({ cloneDir: clone, worktree: path.join(clone, ".claude", "worktrees", "9-none"), sinceMs: 0 }), null);
	});
});

// ---
// pr-review logs and test runs
// ---

describe("pr-review", () => {
	const dir = path.join(tmp, "pr-review", "wtft");
	const log = (name: string, body: object) => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, name), JSON.stringify({ schema: "pr-review/run@1", ...body }));
	};
	log("7-thing-2026-09-20T10-05-00Z-2.json", { branch: "7-thing", utc: "2026-09-20T10-05-00Z", status: "reviewed", findings: [{}, {}] });
	log("7-thing-2026-09-20T10-00-00Z-1.json", { branch: "7-thing", utc: "2026-09-20T10-00-00Z", status: "reviewed", findings: [{}, {}, {}] });
	log("7-thing-2026-09-20T10-09-00Z-3.json", { branch: "7-thing", utc: "2026-09-20T10-09-00Z", status: "failed", findings: [] });
	log("7-thing-else-2026-09-20T10-00-00Z-4.json", { branch: "7-thing-else", utc: "2026-09-20T10-00-00Z", status: "reviewed", findings: [{}] });
	fs.writeFileSync(path.join(dir, "7-thing-else-2026-09-20T10-11-00Z-6.json"), "{ truncated, and not this branch's");
	log("7-thing-2026-09-20T10-12-00Z-7.json", { branch: "7-thing", utc: "2026-09-20T10-12-00Z", status: "reviewed", findings: "three" });
	fs.writeFileSync(path.join(dir, "7-thing@abc.ledger.jsonl"), "{}\n");
	fs.writeFileSync(path.join(dir, "7-thing-2026-09-20T10-10-00Z-5.json"), "{ truncated");

	it("one findings count per reviewed run on this branch, oldest first; an unparseable log is counted, not dropped", () => {
		assert.deepStrictEqual(readPrReview(dir, "7-thing"), { rounds: 2, findings: [3, 2], unreadableLogs: 2 });
	});
	it("a missing log directory is null, not zero", () => {
		assert.strictEqual(readPrReview(path.join(tmp, "nowhere"), "7-thing"), null);
	});
});

describe("test runs", () => {
	const log = path.join(tmp, "wt", "tmp", "test-runs.jsonl");
	appendTestRun(log, "7-thing", [{ name: "a", ok: true }, { name: "b", ok: false }]);
	appendTestRun(log, "7-thing", [{ name: "b", ok: true }]);
	appendTestRun(log, "6-earlier", [{ name: "a", ok: true }]);
	fs.appendFileSync(log, "{ torn\n");
	fs.appendFileSync(log, JSON.stringify({ utc: "x", branch: "7-thing", suites: [null] }) + "\n");

	it("appends one line per run", () => {
		assert.strictEqual(fs.readFileSync(log, "utf8").trim().split("\n").length, 5, "four runs and the torn line");
	});
	it("derives runs, suite runs, failures and reruns", () => {
		assert.deepStrictEqual(readTestRuns(log, "7-thing"), { runs: 2, suiteRuns: 3, failedSuiteRuns: 1, reruns: 1, unreadableLines: 2 },
			"another branch's run is not this branch's; a torn line and a malformed suite are unreadable");
	});
	it("no log is null, not zero", () => {
		assert.strictEqual(readTestRuns(path.join(tmp, "none.jsonl"), "7-thing"), null);
	});
});

// ---
// Macroscope and the PR body
// ---

describe("macroscope", () => {
	it("one round per commit with a Macroscope run that concluded", () => {
		assert.strictEqual(macroscopeRounds([
			[{ name: "Macroscope - Correctness Check", conclusion: "success" }, { name: "ci", conclusion: "success" }],
			[{ name: "Macroscope - Correctness Check", conclusion: "skipped" }],
			[{ name: "Macroscope - Correctness Check", conclusion: null }],
			[{ name: "Macroscope - Correctness Check", conclusion: "failure" }, { name: "Macroscope - Other", conclusion: "success" }],
			[{ name: "ci", conclusion: "success" }],
		]), 2);
	});
});

describe("PR body block", () => {
	const record = { schema: "wtft-pr-cost@1", branch: "7-thing" };
	it("appends the block when the body has none", () => {
		const out = withPrCostBlock("Part of #7.\n", record);
		assert.ok(out.startsWith("Part of #7.\n"));
		assert.match(out, /<!-- pr-cost:begin -->\n```json\n\{"schema":"wtft-pr-cost@1","branch":"7-thing"\}\n```\n<!-- pr-cost:end -->\n$/);
	});
	it("an end marker before the begin marker is not taken as the block's end", () => {
		const body = "<!-- pr-cost:end -->\n" + withPrCostBlock("Top.\n", { old: true });
		const out = withPrCostBlock(body, record);
		assert.strictEqual((out.match(/pr-cost:begin/g) ?? []).length, 1);
		assert.ok(!out.includes('"old"'));
	});
	it("replaces an existing block and keeps the text around it", () => {
		const once = withPrCostBlock("Top.\n", { old: true }) + "Tail.\n";
		const twice = withPrCostBlock(once, record);
		assert.strictEqual((twice.match(/pr-cost:begin/g) ?? []).length, 1);
		assert.ok(!twice.includes('"old"'));
		assert.ok(twice.startsWith("Top.\n") && twice.endsWith("Tail.\n"));
	});
});

#!/usr/bin/env -S bun
/**
 * The per-PR cost record, `wtft-pr-cost@1`. docs/spec-277-pr-cost.md.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalTranscriptPath, deduplicateInteractions, parseSessionFile, type Interaction } from "./extensions/lib/wtft-parser.ts";
import { cwdSlugVariants } from "./extensions/lib/harness/session-cwd.ts";
import { projectsDir } from "./extensions/lib/harness/claude-code/discovery.ts";

export interface FileCounts { source: number; tests: number; docs: number }

export function classifyFiles(paths: string[]): FileCounts {
	const counts: FileCounts = { source: 0, tests: 0, docs: 0 };
	for (const p of paths) {
		if (p === "bun.lock") continue;
		if (p.startsWith("tests/")) counts.tests++;
		else if (p.startsWith("docs/") || (!p.includes("/") && p.endsWith(".md"))) counts.docs++;
		else counts.source++;
	}
	return counts;
}

export interface SessionCost {
	transcripts: number;
	turns: number;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

/** Transcripts in every projects directory named for the clone or one of its
 *  worktrees, subagent transcripts included, modified at or after `sinceMs`. */
export function listTranscripts(cloneDir: string, sinceMs: number, root = projectsDir()): string[] {
	if (!fs.existsSync(root)) return [];
	const prefixes = cwdSlugVariants(cloneDir);
	const out: string[] = [];
	const jsonl = (dir: string) => fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).map(f => path.join(dir, f));
	const walk = (dir: string) => {
		out.push(...jsonl(dir));
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(dir, e.name));
	};
	// Older installs keep sessions in `<project>/sessions/`.
	const project = (dir: string) => {
		out.push(...jsonl(dir));
		for (const entry of fs.readdirSync(dir)) {
			if (entry === "sessions" && fs.statSync(path.join(dir, entry)).isDirectory()) project(path.join(dir, entry));
			const subagents = path.join(dir, entry, "subagents");
			if (fs.existsSync(subagents)) walk(subagents);
		}
	};
	for (const name of fs.readdirSync(root)) {
		if (!prefixes.some(p => name === p || name.startsWith(p + "-"))) continue;
		const dir = path.join(root, name);
		if (fs.statSync(dir).isDirectory()) project(dir);
	}
	return [...new Set(out)].filter(f => {
		try { return fs.statSync(f).mtimeMs >= sinceMs; } catch { return false; }
	});
}

function cwdByMessageId(file: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.includes('"assistant"')) continue;
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }
		const id = entry?.message?.id;
		if (entry?.type === "assistant" && typeof id === "string" && typeof entry.cwd === "string") map.set(id, entry.cwd);
	}
	return map;
}

/** docs/spec-277-pr-cost.md § 3: null when no turn reached the worktree. */
export function collectSessionCost(opts: { cloneDir: string; worktree: string; sinceMs: number; home?: string }): SessionCost | null {
	const parsed = listTranscripts(opts.cloneDir, opts.sinceMs).map(file => ({
		file, interactions: deduplicateInteractions(parseSessionFile(file)),
	}));
	const folded = new Set(parsed.flatMap(p => p.interactions.flatMap(
		i => (i.claudeSubAgentFolds ?? []).map(f => canonicalTranscriptPath(f.file)))));
	const under = (cwd: string | undefined) => cwd !== undefined && (cwd === opts.worktree || cwd.startsWith(opts.worktree + path.sep));
	const home = opts.home ?? os.homedir();
	const spellings = [opts.worktree];
	if (opts.worktree.startsWith(home + path.sep)) spellings.push("~" + opts.worktree.slice(home.length));
	const mentions = new RegExp(`(?:${spellings.map(escapeRegExp).join("|")})(?![A-Za-z0-9._-])`);
	const reaches = (i: Interaction) => i.files.some(f => under(f.path)) || i.commands.some(c => mentions.test(c));
	const total: SessionCost = { transcripts: 0, turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
	// A resumed session's new transcript repeats earlier messages.
	const seen = new Set<string>();
	for (const { file, interactions } of parsed) {
		if (folded.has(canonicalTranscriptPath(file))) continue;
		const cwds = cwdByMessageId(file);
		const counted = interactions.filter(i => {
			if (!((i.messageId !== undefined && under(cwds.get(i.messageId))) || reaches(i))) return false;
			if (i.messageId === undefined) return true;
			if (seen.has(i.messageId)) return false;
			seen.add(i.messageId);
			return true;
		});
		if (counted.length === 0) continue;
		total.transcripts++;
		for (const i of counted) {
			total.turns++;
			total.costUsd += i.cost;
			total.inputTokens += i.inputTokens;
			total.outputTokens += i.outputTokens;
			total.cacheReadTokens += i.cacheReadTokens;
			total.cacheWriteTokens += i.cacheWriteTokens;
		}
	}
	return total.turns === 0 ? null : total;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface PrReview { rounds: number; findings: number[]; unreadableLogs: number }


export function readPrReview(dir: string, branch: string): PrReview | null {
	if (!fs.existsSync(dir)) return null;
	const runs: { utc: string; findings: number }[] = [];
	let unreadableLogs = 0;
	const ours = new RegExp(`^${escapeRegExp(branch)}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z-\\d+\\.json$`);
	for (const name of fs.readdirSync(dir)) {
		if (!ours.test(name)) continue;
		let log: any;
		try { log = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { unreadableLogs++; continue; }
		if (log?.branch !== branch || log.status !== "reviewed") continue;
		if (!Array.isArray(log.findings) || typeof log.utc !== "string") { unreadableLogs++; continue; }
		runs.push({ utc: String(log.utc), findings: log.findings.length });
	}
	runs.sort((x, y) => x.utc.localeCompare(y.utc));
	return { rounds: runs.length, findings: runs.map(r => r.findings), unreadableLogs };
}

export interface TestRuns { runs: number; suiteRuns: number; failedSuiteRuns: number; reruns: number; unreadableLines: number }

export function readTestRuns(file: string, branch: string): TestRuns | null {
	if (!fs.existsSync(file)) return null;
	const out: TestRuns = { runs: 0, suiteRuns: 0, failedSuiteRuns: 0, reruns: 0, unreadableLines: 0 };
	const seen = new Set<string>();
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let run: any;
		try { run = JSON.parse(line); } catch { out.unreadableLines++; continue; }
		if (typeof run?.branch !== "string" || !Array.isArray(run.suites)
			|| !run.suites.every((s: any) => typeof s?.name === "string" && typeof s.ok === "boolean")) { out.unreadableLines++; continue; }
		if (run.branch !== branch) continue;
		out.runs++;
		for (const s of run.suites) {
			out.suiteRuns++;
			if (s.ok === false) out.failedSuiteRuns++;
			if (seen.has(s.name)) out.reruns++;
			seen.add(s.name);
		}
	}
	return out;
}

export interface CheckRun { name: string; conclusion: string | null }

export function macroscopeRounds(commits: CheckRun[][]): number {
	return commits.filter(runs => runs.some(r =>
		r.name.startsWith("Macroscope") && r.conclusion !== null && r.conclusion !== "skipped" && r.conclusion !== "cancelled",
	)).length;
}

const BEGIN = "<!-- pr-cost:begin -->";
const END = "<!-- pr-cost:end -->";

export function withPrCostBlock(body: string, record: object): string {
	const block = `${BEGIN}\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\`\n${END}\n`;
	const start = body.indexOf(BEGIN);
	const end = start >= 0 ? body.indexOf(END, start) : -1;
	if (start >= 0 && end > start) {
		let after = end + END.length;
		if (body[after] === "\n") after++;
		return body.slice(0, start) + block + body.slice(after);
	}
	return (body === "" || body.endsWith("\n") ? body : body + "\n") + "\n" + block;
}

// ---
// CLI
// ---

const USAGE = "usage: bun run pr-cost [--branch <name>] [--pr <n>] [--write-pr]";

function sh(cmd: string, args: string[], cwd?: string): string {
	return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env }).trim();
}

function parseArgs(argv: string[]): { branch?: string; pr?: number; writePr: boolean } {
	const out: { branch?: string; pr?: number; writePr: boolean } = { writePr: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--write-pr") out.writePr = true;
		else if (a === "--branch" && argv[i + 1] && !argv[i + 1].startsWith("-")) out.branch = argv[++i];
		else if (a === "--pr" && /^[1-9]\d*$/.test(argv[i + 1] ?? "")) out.pr = Number(argv[++i]);
		else throw new UsageError(`unknown or incomplete argument: ${a}`);
	}
	return out;
}

class UsageError extends Error {}

function firstLine(err: unknown): string {
	return err instanceof Error ? err.message.split("\n")[0] : String(err);
}

function resolveHead(clone: string, branch: string, pr: number | undefined): string {
	if (pr !== undefined) {
		sh("git", ["-C", clone, "fetch", "--quiet", "origin", `pull/${pr}/head`]);
		return sh("git", ["-C", clone, "rev-parse", "FETCH_HEAD"]);
	}
	try {
		return sh("git", ["-C", clone, "rev-parse", "--verify", "--quiet", `${branch}^{commit}`]);
	} catch {
		throw new Error(`no branch ${branch} here; pass --pr for a merged one`);
	}
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	const clone = sh("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"]).replace(/\/\.git$/, "");
	const branch = args.branch
		?? (args.pr !== undefined ? sh("gh", ["pr", "view", String(args.pr), "--json", "headRefName", "--jq", ".headRefName"]) : null)
		?? sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch === "HEAD") throw new UsageError("detached HEAD: pass --branch or --pr");
	const here = sh("git", ["rev-parse", "--show-toplevel"]);
	const worktree = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]) === branch ? here : path.join(clone, ".claude", "worktrees", branch);
	if (worktree === clone) throw new Error(`${branch} is checked out in the main clone, whose turns cannot be told apart from its worktrees'`);
	const head = resolveHead(clone, branch, args.pr);
	const base = sh("git", ["-C", clone, "merge-base", "origin/main", head]);
	if (base === head) throw new Error(`${branch} (${head.slice(0, 7)}) is already in origin/main, so it has no changes of its own to measure`);
	const own = sh("git", ["-C", clone, "rev-list", "--reverse", "--first-parent", `${base}..${head}`]).split("\n").filter(Boolean);
	const cutMs = Number(sh("git", ["-C", clone, "show", "-s", "--format=%ct", `${own[0]}^`])) * 1000;
	const authoredMs = Math.min(...sh("git", ["-C", clone, "log", "--format=%at", `${base}..${head}`]).split("\n").filter(Boolean).map(t => Number(t) * 1000));
	const sinceMs = Math.min(cutMs, authoredMs);
	const changed = sh("git", ["-C", clone, "diff", "--name-only", `${base}..${head}`]).split("\n").filter(Boolean);
	const gaps: { field: string; reason: string }[] = [];

	const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
	const prReview = readPrReview(path.join(stateHome, "pr-review", path.basename(clone)), branch);
	if (prReview === null) gaps.push({ field: "prReview", reason: "no pr-review log directory for this repo" });
	else if (prReview.unreadableLogs > 0) gaps.push({ field: "prReview", reason: `${prReview.unreadableLogs} run log(s) did not parse; rounds is a floor` });
	gaps.push({ field: "prReview.costUsd", reason: "pr-review run logs do not name their lens sessions" });

	const tests = readTestRuns(path.join(worktree, "tmp", "test-runs.jsonl"), branch);
	if (tests === null) gaps.push({ field: "tests", reason: "no tmp/test-runs.jsonl in the worktree" });
	else if (tests.unreadableLines > 0) gaps.push({ field: "tests", reason: `${tests.unreadableLines} line(s) did not parse; counts are a floor` });

	let pr = args.pr ?? null;
	let macroscope: { rounds: number } | null = null;
	if (pr === null) {
		try {
			const found = sh("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "number", "--jq", ".[0].number // empty"]);
			pr = found ? Number(found) : null;
		} catch (err) {
			gaps.push({ field: "pr", reason: `gh failed: ${firstLine(err)}` });
			if (args.writePr) throw new Error(`--write-pr: could not look up the PR: ${firstLine(err)}`);
		}
	}
	if (args.writePr && pr === null) throw new Error("--write-pr: no PR for this branch");
	try {
		if (pr !== null) {
			const shas = sh("gh", ["pr", "view", String(pr), "--json", "commits", "--jq", ".commits[].oid"]).split("\n").filter(Boolean);
			macroscope = { rounds: macroscopeRounds(shas.map(sha => sh("gh", ["api", "--paginate", `repos/{owner}/{repo}/commits/${sha}/check-runs`,
				"--jq", ".check_runs[] | {name, conclusion}"]).split("\n").filter(Boolean).map(l => JSON.parse(l) as CheckRun))) };
		} else gaps.push({ field: "macroscope", reason: gaps.some(g => g.field === "pr") ? "the PR lookup failed" : "no PR for this branch" });
	} catch (err) {
		gaps.push({ field: "macroscope", reason: `gh failed: ${firstLine(err)}` });
	}
	gaps.push({ field: "reconcile", reason: "spec-reconcile writes no record of its findings" });

	const sessions = collectSessionCost({ cloneDir: clone, worktree, sinceMs });
	if (sessions === null) gaps.push({ field: "sessions", reason: "no Claude Code turn on this host ran in or reached the worktree" });

	const record = {
		schema: "wtft-pr-cost@1",
		branch, base, head, pr,
		files: classifyFiles(changed),
		sessions,
		tests,
		prReview: prReview && { ...prReview, costUsd: null },
		macroscope,
		reconcile: null,
		gaps,
	};
	console.log(JSON.stringify(record));

	if (args.writePr && pr !== null) {
		const body = sh("gh", ["pr", "view", String(pr), "--json", "body", "--jq", ".body"]);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-cost-"));
		try {
			const file = path.join(dir, "body.md");
			fs.writeFileSync(file, withPrCostBlock(body + "\n", record));
			sh("gh", ["pr", "edit", String(pr), "--body-file", file]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
}

if (import.meta.main) {
	try {
		main();
	} catch (err) {
		console.error(err instanceof UsageError ? `${err.message}\n${USAGE}` : `pr-cost: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(err instanceof UsageError ? 2 : 1);
	}
}

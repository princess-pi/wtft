#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/wtft-issue-156-harness-seam.test.ts — cwd-aware discovery + hard harness seam (#156)
 *
 * Two things under test:
 *   A–C  Discovery can see a session whose project dir no longer matches its cwd,
 *        by the UNION rule — physical slug match OR resolved last-cwd match — so
 *        nothing the old cwd-slug-only scan found is lost.
 *   D–F  Harness code sits behind a seam: parse output is unchanged, control
 *        entries still take effect, and a third harness registers, discovers and
 *        parses with no shared file edited.
 *
 * Run: node --experimental-strip-types tests/wtft-issue-156-harness-seam.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { skip } from "./lib/skips.ts";
import { trackSandbox } from "./lib/sandbox";

import {
	resolveLastCwd,
	cwdToSlug,
	resetCwdCache,
	getCwdReadCount,
	discoverSessions,
	harnessLabel,
	getHarnesses,
	getHarness,
	registerHarness,
	resetHarnessRegistry,
	loadHarnessConfig,
	loadExternalHarnesses,
	parseEntryToInteraction,
	parseSessionFile,
	classifyInteraction,
} from "../bin/wtft.mjs";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const tmpRoots: string[] = [];
function mktmp(prefix: string): string {
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tmpRoots.push(dir);
	return dir;
}
function cleanup() {
	for (const dir of tmpRoots) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	}
}

/** Write a Claude-shaped transcript whose entries record `cwd`. */
function writeClaudeTranscript(file: string, cwd: string, extraPadding = 0): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lines: string[] = [];
	lines.push(JSON.stringify({ type: "user", cwd, message: { role: "user", content: "hi" } }));
	if (extraPadding > 0) {
		// Attachment-heavy tail: entries with NO cwd, pushing the last cwd back.
		lines.push(JSON.stringify({ type: "attachment", blob: "x".repeat(extraPadding) }));
	}
	lines.push(JSON.stringify({
		type: "assistant",
		cwd,
		message: {
			role: "assistant", id: "msg_" + path.basename(file, ".jsonl"),
			model: "claude-sonnet-4-5",
			usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: [{ type: "text", text: "ok" }],
		},
	}));
	fs.writeFileSync(file, lines.join("\n") + "\n");
}

console.log("\n=== PART A: resolveLastCwd — the tail scan ===\n");
{
	const root = mktmp("wtft-156-a-");
	const target = "/home/tester/git-projects/demo";
	const file = path.join(root, "sess-a.jsonl");
	writeClaudeTranscript(file, target);

	resetCwdCache();
	check(resolveLastCwd(file) === target, "resolves the cwd recorded on transcript entries");

	// A transcript with no cwd anywhere (Pi's shape) resolves to null.
	const piFile = path.join(root, "sess-pi.jsonl");
	fs.writeFileSync(piFile, JSON.stringify({ type: "message", message: { role: "assistant", id: "m1", usage: {} } }) + "\n");
	check(resolveLastCwd(piFile) === null, "returns null when the log records no cwd (Pi shape)");

	// Widening: the only cwd sits far behind the 8 KB starting window.
	const wide = path.join(root, "sess-wide.jsonl");
	writeClaudeTranscript(wide, target, 40_000);
	// Overwrite the tail entry with one that carries no cwd, so only the head has it.
	const wideLines = fs.readFileSync(wide, "utf8").trim().split("\n");
	wideLines[wideLines.length - 1] = JSON.stringify({ type: "system", note: "no cwd here" });
	fs.writeFileSync(wide, wideLines.join("\n") + "\n");
	resetCwdCache();
	check(resolveLastCwd(wide) === target, "widens past the 8KB window to find a cwd further back");

	// Truncated first line of a non-zero-offset read must be dropped, not parsed.
	// A 40KB pad guarantees the 8KB window starts mid-line.
	const trunc = path.join(root, "sess-trunc.jsonl");
	writeClaudeTranscript(trunc, target, 40_000);
	resetCwdCache();
	check(resolveLastCwd(trunc) === target, "drops the truncated first line of a windowed read");

	// Memoisation: an unchanged file is never re-read.
	resetCwdCache();
	resolveLastCwd(file);
	const readsAfterFirst = getCwdReadCount();
	resolveLastCwd(file);
	check(getCwdReadCount() === readsAfterFirst, "memoised on (path, mtime, size) — no second read");
	check(readsAfterFirst > 0, "the first resolve did read the file");
}

console.log("\n=== PART B: discovery union — a moved session is visible from both ends ===\n");
{
	const projects = mktmp("wtft-156-b-");
	process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;

	const dirA = "/home/tester/git-projects/demo";              // where the session began
	const dirB = "/home/tester/worktrees/demo/99-branch";        // where it lives now
	const slugA = cwdToSlug(dirA);

	// Filed under A's slug, but its entries record cwd B — the worktree case.
	const moved = path.join(projects, slugA, "moved-session.jsonl");
	writeClaudeTranscript(moved, dirB);

	// A second session that never moved, filed and recorded under A.
	const stayed = path.join(projects, slugA, "stayed-session.jsonl");
	writeClaudeTranscript(stayed, dirA);

	resetCwdCache();
	resetHarnessRegistry();

	const fromB = discoverSessions("claude-code", dirB).map((c: any) => c.name);
	check(fromB.includes("moved-session.jsonl"), "moved session is found from its NEW directory");

	const fromA = discoverSessions("claude-code", dirA).map((c: any) => c.name);
	check(fromA.includes("moved-session.jsonl"), "moved session is STILL found from its old directory (union, not replacement)");
	check(fromA.includes("stayed-session.jsonl"), "unmoved session is unaffected");

	// The subdirectory case that already misfires today, without any worktree.
	const sub = "/home/tester/git-projects/demo/frontend";
	const subSession = path.join(projects, slugA, "subdir-session.jsonl");
	writeClaudeTranscript(subSession, sub);
	resetCwdCache();
	check(
		discoverSessions("claude-code", sub).map((c: any) => c.name).includes("subdir-session.jsonl"),
		"session filed under the repo-root slug is reachable from its subdirectory"
	);
	check(
		discoverSessions("claude-code", dirA).map((c: any) => c.name).includes("subdir-session.jsonl"),
		"…and is still reachable from the repo root (the union property)"
	);

	// Same session id in two project dirs → one candidate, the newest.
	const dupOld = path.join(projects, cwdToSlug("/home/tester/old"), "dup.jsonl");
	const dupNew = path.join(projects, cwdToSlug(dirA), "dup.jsonl");
	writeClaudeTranscript(dupOld, dirA);
	writeClaudeTranscript(dupNew, dirA);
	fs.utimesSync(dupOld, new Date(1_000_000), new Date(1_000_000));
	fs.utimesSync(dupNew, new Date(2_000_000), new Date(2_000_000));
	resetCwdCache();
	const dups = discoverSessions("claude-code", dirA).filter((c: any) => c.name === "dup.jsonl");
	check(dups.length === 1, "same session id in two project dirs yields one candidate");
	check(dups[0]?.path === dupNew, "…and it is the newest copy");

	// resolveSessionById reaches a transcript in an unrelated project dir.
	const stray = path.join(projects, cwdToSlug("/somewhere/else"), "stray-id.jsonl");
	writeClaudeTranscript(stray, "/somewhere/else");
	const claude = getHarness("claude-code");
	check(
		claude?.discovery.resolveSessionById("stray-id") === stray,
		"resolveSessionById finds a session in a project dir unrelated to cwd"
	);
	check(
		claude?.discovery.resolveSessionById("no-such-session") === null,
		"resolveSessionById returns null for a session that does not exist"
	);

	delete process.env.WTFT_CLAUDE_PROJECTS_DIR;
	resetCwdCache();
}

console.log("\n=== PART C: no regression against the real session history ===\n");
{
	resetCwdCache();
	resetHarnessRegistry();
	const realProjects = path.join(os.homedir(), ".claude", "projects");
	if (!fs.existsSync(realProjects)) {
		skip("no ~/.claude/projects on this machine — the real-transcript arm did not run");
	} else {
		const here = process.cwd();
		const found = discoverSessions("claude-code", here).map((c: any) => c.path);

		// The pre-change rule: everything physically filed under the cwd slug.
		const slug = cwdToSlug(path.resolve(here));
		const oldRule: string[] = [];
		for (const dir of [path.join(realProjects, slug), path.join(realProjects, slug, "sessions")]) {
			try {
				for (const f of fs.readdirSync(dir)) {
					if (f.endsWith(".jsonl")) oldRule.push(path.join(dir, f));
				}
			} catch {}
		}
		const missing = oldRule.filter(p => !found.includes(p));
		check(missing.length === 0, `every session the old cwd-slug rule found is still found (${oldRule.length} checked)`);

		// WHAT REPLACED THE 500ms CEILING, AND WHY NOT A RATIO (#18).
		//
		// This was `elapsed < 500` against the live ~/.claude/projects tree: a
		// fixed bound on an input the test does not own, drifting toward
		// always-failing as this host's history grows — and failing BECAUSE it
		// ran, not because anything regressed.
		//
		// #18 proposed closing it "the way #477 closed V11", with a ratio against
		// a second call. #39 retired that shape, and the argument needs no
		// measurement to check — it is visible in the code this file imports. The
		// second call is served from the `(path, mtimeMs, size)` memo while the
		// first is not, so the divisor shrinks as the memo IMPROVES while the
		// numerator still walks the whole tree: a constant multiple of a memoised
		// call cannot bound an unmemoised one, and the better the cache the
		// tighter the test. (#39 carries the corpus figures behind that; they are
		// its evidence, not this file's, and nothing here recomputes them.)
		//
		// So this asserts what PART A already asserts about a single file, one
		// level up and against the real tree: the memo holds. An integer instead
		// of a clock, and it cannot drift with the corpus — the bigger this host's
		// history grows, the MORE reads the guard below covers.
		//
		// WHAT THAT TRADE ACTUALLY BUYS AND COSTS — it is not a strict superset,
		// and an earlier draft of this comment claimed it was (PR review).
		//
		//   Gained: memo collapse is caught deterministically, at any corpus size,
		//   on any host. Measured by hand — set `const cached = undefined` in
		//   session-cwd.ts's resolveLastCwd, `bun run build` (this suite imports
		//   ../bin/wtft.mjs, so a source-only edit changes nothing), then re-run:
		//   the check below failed at 2,835 re-reads while the same broken build
		//   ran the timed call in 137ms and would have passed `elapsed < 500`.
		//
		//   Given up: wall-clock blowups that cost no extra READS — an O(n^2) bug
		//   in `collect()`, say. Walk time counted toward `elapsed`, so a large
		//   enough one could have crossed 500ms; a read counter cannot see it at
		//   all. What was given up is a probabilistic signal on a class the
		//   ceiling never reliably held, since whether it fired depended on the
		//   host and the corpus — and on this host it had begun firing without any
		//   regression behind it, which is why it is gone.
		//
		// The walk therefore has no guard HERE, and deliberately keeps none.
		// #39 (merged) covers it exactly — `getDirWalkCount` counts directory
		// reads, and V11e in
		// wtft-issue-144-145-164-session-discovery.test.ts asserts a flat corpus
		// of 7 project dirs plus one nested `sessions/` costs exactly 8, with
		// `wtft-tags/` skipped, and that a second call costs 8 more.
		//
		// An earlier draft of this comment promised to adopt that here "against
		// the real tree" once both landed. It should not, and saying so is the
		// point: the exact form needs the directory count to hold still between
		// the two calls, and ~/.claude/projects does not — this host runs several
		// sessions at once, including the one running this suite, so a directory
		// can appear mid-test. An assertion that flakes because the corpus moved
		// under it is precisely the defect #18 exists to remove, and importing a
		// tolerance to absorb that would put a threshold back. The walk is
		// counted where the corpus is owned; here it is not counted at all.
		const readsBeforeSecond = getCwdReadCount();
		discoverSessions("claude-code", here);
		check(getCwdReadCount() === readsBeforeSecond,
			`a second discovery over the real history re-reads nothing (${getCwdReadCount() - readsBeforeSecond} new read(s))`);
		check(readsBeforeSecond > 0,
			`…and the first one really did read it, so that is not vacuous (${readsBeforeSecond} read(s))`);
	}
}

console.log("\n=== PART D: parse parity across the seam ===\n");
{
	resetHarnessRegistry();

	const claudeEntry = {
		type: "assistant",
		requestId: "req_1",
		message: {
			role: "assistant", id: "msg_claude_1", model: "claude-sonnet-4-5",
			timestamp: "2026-08-01T00:00:00Z",
			usage: {
				input_tokens: 100, output_tokens: 50,
				cache_read_input_tokens: 0, cache_creation_input_tokens: 2000,
			},
			content: [
				{ type: "text", text: "writing the spec" },
				{ type: "tool_use", name: "Edit", input: { file_path: "/repo/docs/spec.md" } },
				{ type: "tool_use", name: "Bash", input: { command: "git status" } },
				{ type: "tool_use", name: "WebSearch", input: { query: "x" } },
			],
		},
	};
	const c = parseEntryToInteraction(claudeEntry);
	check(c !== null, "Claude Code assistant entry parses");
	check(c.messageId === "msg_claude_1" && c.requestId === "req_1", "message id and request id survive the seam");
	check(c.inputTokens === 100 && c.outputTokens === 50, "token fields survive the seam");
	check(c.cacheWriteTokens === 2000 && c.cacheReadTokens === 0, "cache fields survive the seam");
	check(c.cacheMiss === true, "observed cache miss (#152) still decided at parse time");
	check(c.cost > 0, "cost is computed from tokens when the harness records none");
	check(c.files.some((f: any) => f.path === "/repo/docs/spec.md" && f.action === "write"), "Edit maps to a file write");
	check(c.commands.includes("git status"), "Bash command is captured");
	check((c.toolCats || []).length > 0, "an unbranched tool still reaches shared category mapping");
	check(classifyInteraction(c) === "spec", "classification is unchanged (docs/spec.md write → spec)");

	const piEntry = {
		type: "message",
		message: {
			role: "assistant", id: "msg_pi_1",
			timestamp: "2026-08-01T00:00:00Z",
			usage: {
				input: 100, output: 50, cacheRead: 7000, cacheWrite: 0, reasoning: 12,
				cost: { total: 0.25 },
			},
			content: [
				{ type: "text", text: "hello" },
				{ type: "toolCall", name: "write", arguments: { path: "/repo/src/index.ts" } },
			],
		},
	};
	const p = parseEntryToInteraction(piEntry, undefined, undefined, false, "claude-opus-4-1");
	check(p !== null, "Pi assistant entry parses");
	check(p.cost === 0.25, "Pi's native per-turn cost is preferred over recomputation");
	check(p.inputTokens === 100 && p.cacheReadTokens === 7000, "Pi's short usage field names normalize");
	check(p.reasoningTokens === 12, "Pi reasoning tokens survive the seam");
	check(p.model === "claude-opus-4-1", "tracked model fills in when the harness stamps none");
	check(p.files.some((f: any) => f.path === "/repo/src/index.ts" && f.action === "write"), "Pi toolCall maps to a file write");

	// A known tool called with no path argument is still a KNOWN tool.
	const noArg = parseEntryToInteraction({
		type: "assistant",
		message: {
			role: "assistant", id: "m", model: "claude-sonnet-4-5",
			usage: { input_tokens: 1, output_tokens: 1 },
			content: [{ type: "tool_use", name: "Read", input: {} }],
		},
	});
	check(noArg.unrecognizedTool === undefined, "a branched tool with no arguments is not marked unrecognized");
}

console.log("\n=== PART E: control entries still take effect ===\n");
{
	const root = mktmp("wtft-156-e-");
	const file = path.join(root, "control.jsonl");
	const lines = [
		{ type: "model_change", modelId: "claude-opus-4-1" },
		{ type: "thinking_level_change", thinkingLevel: "high" },
		{ type: "message", message: { role: "assistant", id: "m1", timestamp: "2026-08-01T00:00:00Z",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, content: [] } },
		{ type: "compaction", tokensBefore: 12345 },
		{ type: "message", message: { role: "assistant", id: "m2", timestamp: "2026-08-01T00:01:00Z",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, content: [] } },
		{ type: "user", message: { role: "user", content: "[Request interrupted by user]" } },
	];
	fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join("\n") + "\n");

	const interactions = parseSessionFile(file);
	check(interactions.length === 2, "control entries are consumed, not parsed as turns");
	check(interactions[0].model === "claude-opus-4-1", "model_change (#128) still tracks");
	check(interactions[0].thinkingLevel === "high", "thinking_level_change (#77) still tracks");
	check(interactions[1].compactionTokensBefore === 12345, "compaction tokensBefore (#90) stamps the next turn");
	check(interactions[1].afterCompaction === true, "…and flags it for the meter-split (#52 Phase 3)");
	check(interactions[1].interrupted === true, "interrupt marker stamps the PRECEDING turn");

	// Claude's compact summary marker.
	const cfile = path.join(root, "compact.jsonl");
	fs.writeFileSync(cfile, [
		JSON.stringify({ isCompactSummary: true }),
		JSON.stringify({ type: "assistant", message: { role: "assistant", id: "c1", model: "claude-sonnet-4-5",
			timestamp: "2026-08-01T00:00:00Z", usage: { input_tokens: 1, output_tokens: 1 }, content: [] } }),
	].join("\n") + "\n");
	const ci = parseSessionFile(cfile);
	check(ci.length === 1 && ci[0].afterCompaction === true, "isCompactSummary flags the next turn");
}

console.log("\n=== PART F: a third harness needs no shared file edited ===\n");
{
	resetHarnessRegistry();

	const codexRoot = mktmp("wtft-156-codex-");
	process.env.CODEX_SESSIONS_DIR = codexRoot;

	const cwd = "/home/tester/git-projects/demo";
	const codexFile = path.join(codexRoot, cwdToSlug(cwd), "codex-1.jsonl");
	fs.mkdirSync(path.dirname(codexFile), { recursive: true });
	fs.writeFileSync(codexFile, JSON.stringify({ kind: "turn", role: "assistant" }) + "\n");

	// The out-of-tree channel: config points at .mjs modules, loaded at startup.
	const cfgDir = mktmp("wtft-156-cfg-");
	const sketch = path.join(process.cwd(), "research", "156-codex-harness-sketch");
	fs.mkdirSync(path.join(cfgDir, "princess-pi-packages"), { recursive: true });
	fs.writeFileSync(
		path.join(cfgDir, "princess-pi-packages", "wtft-harnesses.json"),
		JSON.stringify({
			codex: {
				label: "Codex",
				discovery: path.join(sketch, "discovery.mjs"),
				parse: path.join(sketch, "parse.mjs"),
			},
		})
	);
	const loaded = await loadExternalHarnesses(path.join(cfgDir, "princess-pi-packages", "wtft-harnesses.json"));
	check(loaded.includes("codex"), "out-of-tree harness loads from config with no rebuild");
	check(getHarnesses().some((h: any) => h.id === "codex"), "…and appears in the registry");
	check(harnessLabel("codex") === "Codex", "…with its own selector label");

	const codexFound = discoverSessions("codex", cwd).map((c: any) => c.name);
	check(codexFound.includes("codex-1.jsonl"), "the third harness discovers its own sessions");

	// A schema unlike either built-in, parsed and priced through shared code.
	const codexTurn = {
		kind: "turn", role: "assistant", turn_id: "cdx_1", request_id: "r1",
		model: "claude-sonnet-4-5", ts: "2026-08-01T00:00:00Z",
		tokens: { prompt: 200, completion: 40, cache_written: 5000, cache_hit: 0, thinking: 7 },
		parts: [
			{ op: "say", text: "patching" },
			{ op: "call", tool: "patch_file", args: { file: "/repo/src/main.ts" } },
			{ op: "call", tool: "shell", args: { cmd: "bun test" } },
		],
	};
	const ci = parseEntryToInteraction(codexTurn);
	check(ci !== null, "the third harness's assistant schema parses");
	check(ci.inputTokens === 200 && ci.cacheWriteTokens === 5000, "its usage field names normalize");
	check(ci.cost > 0, "it inherits cost calculation unchanged");
	check(ci.cacheMiss === true, "it inherits observed cache-miss detection (#152)");
	check(ci.reasoningTokens === 7, "it inherits reasoning-token accounting");
	check(ci.files.some((f: any) => f.path === "/repo/src/main.ts"), "its tool argument names map to files");
	check(ci.commands.includes("bun test"), "its shell tool maps to commands");
	check(classifyInteraction(ci) === "code", "it inherits classification (src write → code)");

	// Its own control entries.
	const cfile = path.join(codexRoot, "ctl.jsonl");
	fs.writeFileSync(cfile, [
		JSON.stringify({ kind: "model_switch", model: "claude-opus-4-1" }),
		JSON.stringify({ kind: "turn", role: "assistant", turn_id: "cdx_2", ts: "2026-08-01T00:00:00Z",
			tokens: { prompt: 10, completion: 2 }, parts: [] }),
	].join("\n") + "\n");
	const cint = parseSessionFile(cfile);
	check(cint.length === 1 && cint[0].model === "claude-opus-4-1", "its model_switch control entry takes effect");

	delete process.env.CODEX_SESSIONS_DIR;
	resetHarnessRegistry();
}

console.log("\n=== PART G: registry config handling ===\n");
{
	const cfgDir = mktmp("wtft-156-cfg2-");
	const cfgPath = path.join(cfgDir, "wtft-harnesses.json");

	fs.writeFileSync(cfgPath, JSON.stringify({ pi: { enabled: false } }));
	await loadExternalHarnesses(cfgPath);
	check(!getHarnesses().some((h: any) => h.id === "pi"), "a disabled built-in disappears from the registry");
	check(getHarnesses().some((h: any) => h.id === "claude-code"), "…and the others are untouched");

	fs.writeFileSync(cfgPath, "{ not json ");
	check(Object.keys(loadHarnessConfig(cfgPath)).length === 0, "malformed config is ignored, not fatal");

	fs.writeFileSync(cfgPath, JSON.stringify({ ghost: { enabled: true } }));
	const loaded = await loadExternalHarnesses(cfgPath);
	check(loaded.length === 0, "a config entry with no module paths is skipped");
	check(getHarnesses().length >= 2, "…and the built-ins still register");

	fs.writeFileSync(cfgPath, JSON.stringify({ broken: { discovery: "/nope/a.mjs", parse: "/nope/b.mjs" } }));
	const loaded2 = await loadExternalHarnesses(cfgPath);
	check(loaded2.length === 0, "an unloadable harness module is skipped, not fatal");

	resetHarnessRegistry();
	check(getHarness("claude-code") !== null && getHarness("nope") === null, "getHarness resolves known ids only");

	// Direct registration — the in-process path an out-of-tree harness's tests use.
	registerHarness({
		id: "fake",
		discovery: { id: "fake", label: "Fake", discover: () => [], resolveSessionById: () => null },
		parse: { id: "fake", matchAssistant: () => null, readBlock: () => null, readControlEntry: () => null },
	} as any);
	check(getHarness("fake") !== null, "registerHarness adds a harness in-process");
	resetHarnessRegistry();
	check(getHarness("fake") === null, "resetHarnessRegistry drops it again");
}

cleanup();
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env -S bun
/**
 * The subagent read path's prose, pinned to the code it describes (#15).
 *
 * Each claim is quoted from docs/wtft-incremental-render-spec.md and then
 * driven against the real function. Rewording a sentence fails the quote;
 * changing the behaviour fails the drive. Either way the two cannot drift
 * apart silently.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	attributeClaudeSubAgentCosts,
	deduplicateInteractions,
	discoverSubagentSessionFiles,
	parseSessionFile,
	type Interaction,
} from "../extensions/lib/wtft-parser.ts";
import { getDiscoveries } from "../extensions/lib/harness/registry.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("15-read-path-doc-claims");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const SPEC = fs.readFileSync(path.resolve(import.meta.dirname, "..", "docs", "wtft-incremental-render-spec.md"), "utf8");
/** Whitespace-insensitive, so a reflowed paragraph still matches. */
const flat = (s: string) => s.replace(/\s+/g, " ");
function quoted(sentence: string): boolean {
	return flat(SPEC).includes(flat(sentence));
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-15-")));
const projects = path.join(dir, "projects");
const piSessions = path.join(dir, "pi-sessions");
process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
process.env.WTFT_PI_SESSIONS_DIR = piSessions;
process.env.XDG_CONFIG_HOME = path.join(dir, "config");

const T0 = Date.UTC(2026, 8, 23, 6, 0, 0);
const slugOf = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

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
const sessionLine = (id: string, tsMs: number, cwd: string) =>
	JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(tsMs).toISOString(), cwd }) + "\n";

// ---
// A — attributeClaudeSubAgentCosts is per call
// ---
console.log("\nA — attributeClaudeSubAgentCosts: per call, not global");
{
	const A1 = "within the array of interactions handed to it in one call, no nested `claude -p` session's cost is attributed twice.";
	const A2 = "A partial slice does not error; it silently produces a partial, non-global, `seenSessionIds`.";
	check(quoted(A1), "A1 the spec states the per-call invariant");
	check(quoted(A2), "A2 the spec states what a partial slice does");

	const childCwd = path.join(dir, "child-cwd");
	const parent = path.join(dir, "parent.jsonl");
	const spawn = `cd ${childCwd} && claude -p 'go'`;
	fs.writeFileSync(parent,
		sessionLine("parent-15", T0, dir)
		+ turnLine("p-1", T0, 10, spawn)
		+ turnLine("p-2", T0 + 1_000, 10, spawn));
	// Parsed before the child exists, so neither turn is attributed yet.
	const base = parseSessionFile(parent);
	check(base.length === 2 && base.every(i => !i.claudeSubAgentFolds),
		`A0 fixture precondition: two spawning turns, neither attributed (got ${base.length}, folds ${base.map(i => !!i.claudeSubAgentFolds)})`);

	const childDir = path.join(projects, slugOf(childCwd));
	fs.mkdirSync(childDir, { recursive: true });
	fs.writeFileSync(path.join(childDir, "cccccccc-0000-4000-8000-000000000015.jsonl"),
		sessionLine("child-15", T0 + 500, childCwd) + turnLine("c-1", T0 + 500, 700));

	const clone = (xs: Interaction[]) => xs.map(i => structuredClone(i));
	const outputOf = (xs: Interaction[]) => xs.reduce((sum, i) => sum + i.outputTokens, 0);

	const whole = clone(base);
	attributeClaudeSubAgentCosts(whole, dir);
	check(outputOf(whole) === 20 + 700,
		`A3 one call over both turns attributes the child once (output ${outputOf(whole)}, want 720)`);

	const first = clone(base).slice(0, 1), second = clone(base).slice(1);
	attributeClaudeSubAgentCosts(first, dir);
	attributeClaudeSubAgentCosts(second, dir);
	check(outputOf([...first, ...second]) === 20 + 700 + 700,
		`A4 two calls over the halves attribute it twice, without an error (output ${outputOf([...first, ...second])}, want 1420)`);
}

// ---
// D — deduplicateInteractions does not return chronological order
// ---
console.log("\nD — deduplicateInteractions: return order is not chronological");
{
	const D1 = "**`deduped[deduped.length - 1]` is never guaranteed to be the chronologically last interaction.**";
	check(quoted(D1), "D1 the spec states the order trap");

	const withId = { messageId: "msg_1", timestamp: T0, cost: 1 } as unknown as Interaction;
	const laterWithoutId = { timestamp: T0 + 60_000, cost: 1 } as unknown as Interaction;
	const deduped = deduplicateInteractions([withId, laterWithoutId]);
	check(deduped.length === 2, `D2 fixture precondition: nothing collapsed (got ${deduped.length})`);
	check(deduped[deduped.length - 1].timestamp === T0,
		`D3 the last element is the EARLIER turn: id-less turns come first (last timestamp ${deduped[deduped.length - 1].timestamp - T0} ms after T0)`);
}

// ---
// L — where the transcripts are
// ---
console.log("\nL — on-disk layout");
{
	const L1 = "`discoverSubagentSessionFiles` walks that directory and every directory under it (the `workflows/wf_<id>/` children are one level down), and lists only files named `agent-*.jsonl`.";
	const L2 = "**Session discovery skips a directory named `subagents` in both harnesses**";
	check(quoted(L1), "L1 the spec states what subagent discovery lists");
	check(quoted(L2), "L2 the spec states that session discovery skips `subagents`");

	const cwd = path.join(dir, "layout-cwd");
	const projectDir = path.join(projects, slugOf(cwd));
	const sessionId = "dddddddd-0000-4000-8000-000000000015";
	const session = path.join(projectDir, `${sessionId}.jsonl`);
	const subagents = path.join(projectDir, sessionId, "subagents");
	fs.mkdirSync(path.join(subagents, "workflows", "wf_1"), { recursive: true });
	fs.writeFileSync(session, turnLine("s-1", T0, 10));
	for (const f of ["agent-aaaa.jsonl", "agent-aaaa.meta.json", "notes.jsonl", path.join("workflows", "wf_1", "agent-bbbb.jsonl")]) {
		fs.writeFileSync(path.join(subagents, f), turnLine(`x-${path.basename(f)}`, T0, 5));
	}

	const found = discoverSubagentSessionFiles(session).files.map(f => path.relative(subagents, f)).sort();
	check(JSON.stringify(found) === JSON.stringify(["agent-aaaa.jsonl", path.join("workflows", "wf_1", "agent-bbbb.jsonl")]),
		`L3 subagent discovery lists agent-*.jsonl at every depth and nothing else (got ${JSON.stringify(found)})`);

	// A Pi session tree with a `subagents` directory in it.
	const piDir = path.join(piSessions, "--pi-cwd--");
	fs.mkdirSync(path.join(piDir, "subagents"), { recursive: true });
	fs.writeFileSync(path.join(piDir, "pi-top.jsonl"), sessionLine("pi-top-15", T0, "/pi-cwd") + turnLine("pt-1", T0, 10));
	fs.writeFileSync(path.join(piDir, "subagents", "pi-nested.jsonl"), sessionLine("pi-nested-15", T0, "/pi-cwd") + turnLine("pn-1", T0, 10));

	for (const discovery of getDiscoveries()) {
		if (!discovery.indexSessionsById) continue;
		const paths = [...discovery.indexSessionsById().values()];
		const listedTop = discovery.id === "claude-code" ? paths.includes(session) : paths.some(p => p.endsWith("pi-top.jsonl"));
		check(listedTop, `L4 [${discovery.id}] fixture precondition: the top-level session is indexed`);
		const underSubagents = paths.filter(p => p.split(path.sep).includes("subagents"));
		check(underSubagents.length === 0,
			`L5 [${discovery.id}] session discovery lists nothing under a subagents directory (got ${JSON.stringify(underSubagents)})`);
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

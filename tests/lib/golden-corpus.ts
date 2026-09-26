/**
 * The golden corpus: four sessions written whole before any daemon starts,
 * so a run is decided by content, not by timing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { cwdToStrictSlug } from "../../extensions/lib/harness/session-cwd.ts";

export const T0 = Date.UTC(2026, 8, 20, 10, 0, 0);

export interface CorpusSession {
	name: string;
	/** The root transcript. */
	session: string;
	/** Every child transcript the daemon should fold, keyed by a stable label. */
	children: Record<string, string>;
	/** The cwd the root ran in. */
	cwd: string;
}

export interface Corpus {
	root: string;
	projects: string;
	sessions: CorpusSession[];
}

// ---
// Claude Code shapes
// ---

export function ccUser(tsMs: number, cwd: string, text = "go"): string {
	return JSON.stringify({ type: "user", timestamp: new Date(tsMs).toISOString(), cwd,
		message: { role: "user", content: text } }) + "\n";
}

interface CcTurn {
	id: string;
	tsMs: number;
	model?: string;
	input?: number;
	output: number;
	cr?: number;
	cw?: number;
	cw1h?: number;
	sidechain?: boolean;
	blocks?: unknown[];
	webSearch?: number;
}

export function ccAssistant(t: CcTurn): string {
	const usage: Record<string, unknown> = {
		input_tokens: t.input ?? 2,
		output_tokens: t.output,
		cache_read_input_tokens: t.cr ?? 0,
		cache_creation_input_tokens: t.cw ?? 0,
	};
	if (t.cw1h) usage.cache_creation = { ephemeral_5m_input_tokens: (t.cw ?? 0) - t.cw1h, ephemeral_1h_input_tokens: t.cw1h };
	if (t.webSearch) usage.server_tool_use = { web_search_requests: t.webSearch };
	return JSON.stringify({
		type: "assistant",
		timestamp: new Date(t.tsMs).toISOString(),
		...(t.sidechain ? { isSidechain: true } : {}),
		message: {
			role: "assistant", id: t.id, model: t.model ?? "claude-sonnet-4-6",
			content: t.blocks ?? [{ type: "text", text: `turn ${t.id}` }],
			usage,
		},
	}) + "\n";
}

export const bash = (command: string) => ({ type: "tool_use", name: "Bash", input: { command } });
const read = (file_path: string) => ({ type: "tool_use", name: "Read", input: { file_path } });
const edit = (file_path: string) => ({ type: "tool_use", name: "Edit", input: { file_path } });

function ccInterrupt(tsMs: number): string {
	return JSON.stringify({ type: "user", timestamp: new Date(tsMs).toISOString(),
		message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }) + "\n";
}

function ccCompaction(tsMs: number): string {
	return JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: new Date(tsMs).toISOString() }) + "\n"
		+ JSON.stringify({ type: "user", isCompactSummary: true, timestamp: new Date(tsMs).toISOString(),
			message: { role: "user", content: "summary" } }) + "\n";
}

// ---
// Pi shapes
// ---

export function piHeader(id: string, tsMs: number, cwd: string, parentSession?: string): string {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(tsMs).toISOString(), cwd,
		...(parentSession ? { parentSession } : {}) }) + "\n";
}

export function piTurn(id: string, tsMs: number, output: number, commands: string[] = []): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message", timestamp: iso,
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6", timestamp: iso,
			usage: { input: 1000, output, cacheRead: 500, cacheWrite: 100, cost: { total: output / 100_000 } },
			content: commands.length > 0
				? commands.map(command => ({ type: "toolCall", name: "bash", arguments: { command } }))
				: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

// ---

/** A Claude Code child transcript filed where the harness files it. */
export function ccProjectFile(projects: string, cwd: string, sessionId: string): string {
	const dir = path.join(projects, cwdToStrictSlug(cwd));
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `${sessionId}.jsonl`);
}

export const UUID = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Writes the corpus under `root` and returns where everything is. */
export function writeCorpus(root: string): Corpus {
	const projects = path.join(root, "projects");
	fs.mkdirSync(projects, { recursive: true });
	const sessions: CorpusSession[] = [];

	// cc-plain: one session, no children. Interrupt, compaction split, recache
	// split, a streaming duplicate, a server tool, a cache-miss first turn.
	{
		const cwd = path.join(root, "plain-project");
		const session = ccProjectFile(projects, cwd, UUID(1));
		const t = (k: number) => T0 + k * 60_000;
		fs.writeFileSync(session,
			ccUser(t(0), cwd)
			+ ccAssistant({ id: "p1", tsMs: t(1), output: 300, cr: 0, cw: 48_278, cw1h: 48_278, blocks: [read(path.join(cwd, "README.md"))] })
			+ ccAssistant({ id: "p2", tsMs: t(2), output: 200, cr: 50_000, cw: 1_200, blocks: [bash("git status"), edit(path.join(cwd, "src", "a.ts"))] })
			+ ccInterrupt(t(2) + 1_000)
			+ ccAssistant({ id: "p3", tsMs: t(3), output: 40, cr: 51_000, cw: 500, blocks: [bash("npm test")] })
			+ ccAssistant({ id: "p3", tsMs: t(3), output: 100, cr: 51_000, cw: 500, blocks: [bash("npm test")] })
			+ ccCompaction(t(4))
			+ ccAssistant({ id: "p4", tsMs: t(5), output: 50, cr: 0, cw: 40_000, cw1h: 40_000 })
			+ ccAssistant({ id: "p5", tsMs: t(6), output: 10, cr: 0, cw: 45_000, cw1h: 45_000 })
			+ ccAssistant({ id: "p6", tsMs: t(7), output: 20, cr: 45_000, cw: 100, webSearch: 2, blocks: [{ type: "tool_use", name: "WebSearch", input: { query: "x" } }] }));
		sessions.push({ name: "cc-plain", session, children: {}, cwd });
	}

	// cc-task: two Task subagents under <id>/subagents/, one with a .meta.json.
	{
		const cwd = path.join(root, "task-project");
		const session = ccProjectFile(projects, cwd, UUID(2));
		const subagents = path.join(path.dirname(session), UUID(2), "subagents");
		fs.mkdirSync(subagents, { recursive: true });
		const t = (k: number) => T0 + k * 60_000;
		fs.writeFileSync(session,
			ccUser(t(0), cwd)
			+ ccAssistant({ id: "r1", tsMs: t(1), output: 100, cr: 0, cw: 20_000, blocks: [{ type: "tool_use", name: "Task", input: { description: "look" } }] })
			+ ccAssistant({ id: "r2", tsMs: t(9), output: 60, cr: 20_000, cw: 300 }));
		const a = path.join(subagents, "agent-a0001.jsonl");
		fs.writeFileSync(a,
			ccAssistant({ id: "a1", tsMs: t(2), output: 400, cr: 0, cw: 30_000, sidechain: true, blocks: [bash("rg TODO")] })
			+ ccAssistant({ id: "a2", tsMs: t(3), output: 150, cr: 30_000, cw: 200, sidechain: true }));
		fs.writeFileSync(a.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "Explore", spawnDepth: 1, description: "look", model: "haiku" }));
		const b = path.join(subagents, "agent-b0002.jsonl");
		fs.writeFileSync(b,
			ccAssistant({ id: "b1", tsMs: t(4), output: 70, cr: 0, cw: 10_000, sidechain: true }));
		sessions.push({ name: "cc-task", session, children: { "task-a": a, "task-b": b }, cwd });
	}

	// pi-sibling: a Pi root and one sibling child naming it as parentSession.
	{
		const cwd = path.join(root, "pi-project");
		const dir = path.join(root, "pi-sessions", "pi-project");
		fs.mkdirSync(dir, { recursive: true });
		const session = path.join(dir, "pi-root-0003.jsonl");
		const t = (k: number) => T0 + k * 60_000;
		fs.writeFileSync(session,
			piHeader("pi-root-0003", t(0), cwd)
			+ piTurn("q1", t(1), 250, ["ls"])
			+ piTurn("q2", t(2), 120));
		const child = path.join(dir, "pi-child-0004.jsonl");
		fs.writeFileSync(child,
			piHeader("pi-child-0004", t(1) + 5_000, cwd, "pi-root-0003")
			+ piTurn("c1", t(1) + 6_000, 90)
			+ piTurn("c2", t(1) + 7_000, 30));
		sessions.push({ name: "pi-sibling", session, children: { "pi-child": child }, cwd });
	}

	// cc-claudep: the root spawns `claude -p` in another project; that child
	// spawns one more, bare, in its own cwd.
	{
		const cwd = path.join(root, "spawner-project");
		const childCwd = path.join(root, "target-project");
		const session = ccProjectFile(projects, cwd, UUID(5));
		fs.writeFileSync(session,
			ccUser(T0, cwd)
			+ ccAssistant({ id: "s1", tsMs: T0 + 1_000, output: 80, cr: 0, cw: 5_000, blocks: [bash(`cd ${childCwd} && claude -p 'go'`)] })
			+ ccAssistant({ id: "s2", tsMs: T0 + 60_000, output: 30, cr: 5_000, cw: 100 }));
		const child = ccProjectFile(projects, childCwd, UUID(6));
		fs.writeFileSync(child,
			ccUser(T0 + 2_000, childCwd)
			+ ccAssistant({ id: "k1", tsMs: T0 + 3_000, output: 500, cr: 0, cw: 8_000, blocks: [bash("claude -p 'deeper'")] })
			+ ccAssistant({ id: "k2", tsMs: T0 + 30_000, output: 20, cr: 8_000, cw: 50 }));
		const grandchild = ccProjectFile(projects, childCwd, UUID(7));
		fs.writeFileSync(grandchild,
			ccUser(T0 + 4_000, childCwd)
			+ ccAssistant({ id: "g1", tsMs: T0 + 5_000, output: 700, cr: 0, cw: 2_000 }));
		sessions.push({ name: "cc-claudep", session, children: { "claudep-child": child, "claudep-grandchild": grandchild }, cwd });
	}

	return { root, projects, sessions };
}

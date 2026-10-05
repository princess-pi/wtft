/**
 * The parser playground's examples: real Claude Code and Pi transcript shapes,
 * each picked to walk one interesting path through the parser. A test parses
 * every one and checks the category it names.
 */

import type { Category } from "../../extensions/lib/wtft-parser.ts";

export interface ParserPreset {
	label: string;
	/** What the example teaches, one sentence. */
	note: string;
	/** The category of each deduplicated turn, in order. */
	expect: Category[];
	/** One transcript line per entry; a string is written as is (a bad or partial line). */
	entries: unknown[];
}

const MODEL = "claude-sonnet-4-5";
const usage = (cacheRead: number, cacheWrite: number, output = 200, input = 3, extra: object = {}) => ({
	input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, ...extra,
});

/** A Claude Code assistant line. Claude Code writes one line per content block, all under one message id. */
function cc(id: string, at: string, content: unknown[], use: object = usage(50_000, 1_000)) {
	return { type: "assistant", timestamp: `2026-09-24T${at}Z`, requestId: `req_${id}`, message: { id: `msg_${id}`, role: "assistant", model: MODEL, content, usage: use } };
}
const bash = (command: string) => ({ type: "tool_use", id: "toolu_1", name: "Bash", input: { command } });
const userText = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

export const PARSER_PRESETS: Record<string, ParserPreset> = {
	"bash-tests": {
		label: "Bash wrappers → tests",
		note: "`cd`, `FOO=1`, `timeout -k 5 200` and the pipe to `tail` are stripped; the real command left is `bun test …`, a test runner.",
		expect: ["tests"],
		entries: [cc("01", "15:00:00", [bash("cd ~/proj && FOO=1 timeout -k 5 200 bun test tests/foo.test.ts 2>&1 | tail -20")])],
	},
	"gh-spec": {
		label: "git + gh issue view → spec",
		note: "Both commands are repo workflow, but `gh issue view` is carved out as reading a spec, and spec outranks git.",
		expect: ["spec"],
		entries: [cc("02", "15:01:00", [bash("git status && gh issue view 42")])],
	},
	"read-edit-tests": {
		label: "Read + Edit tests → tests",
		note: "Three lines, one message id: the dedupe merges them. README.md is a spec read, tests/x.test.ts a tests write, and a write beats a read.",
		expect: ["tests"],
		entries: [
			cc("03", "15:02:00", [{ type: "text", text: "Let me read the README, then fix the test." }]),
			cc("03", "15:02:00", [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "README.md" } }]),
			cc("03", "15:02:01", [{ type: "tool_use", id: "toolu_3", name: "Edit", input: { file_path: "tests/x.test.ts", old_string: "a", new_string: "b" } }]),
		],
	},
	"cache-miss": {
		label: "Cache miss after a gap",
		note: "The second turn reads nothing from cache and rewrites the whole context: a cache miss. Its context matches the turn before, so the daemon also splits the rewrite off as overhead.",
		expect: ["prompt", "prompt"],
		entries: [
			cc("04", "15:03:00", [{ type: "text", text: "Done. Want me to open a PR?" }], usage(39_000, 1_000, 40)),
			userText("yes, but first explain the change"),
			cc("05", "16:20:00", [{ type: "text", text: "Sure! Here is what changed…" }], usage(0, 40_500, 300, 3, { cache_creation: { ephemeral_1h_input_tokens: 40_500, ephemeral_5m_input_tokens: 0 } })),
		],
	},
	interrupt: {
		label: "Interrupt after a turn",
		note: "The user line carrying “[Request interrupted by user…” is a control entry: it stamps the turn before it, which is then all waste. The last line is cut off mid-write, so it is skipped without counting as bad.",
		expect: ["interrupted"],
		entries: [
			cc("06", "15:05:00", [bash("bun test tests/slow.test.ts")]),
			userText("[Request interrupted by user for tool use]"),
			'{"type":"assistant","timestamp":"2026-09-24T15:05:09Z","message":{"id":"msg_07","role":"assist',
		],
	},
	"pi-grep": {
		label: "Pi: grep with native cost",
		note: "Pi names the model in a model_change entry, not on the message, and records its own cost, which wins over pricing the tokens.",
		expect: ["grep"],
		entries: [
			{ type: "session", version: 3, id: "pi-session-1", timestamp: "2026-09-24T15:06:00.000Z", cwd: "/home/dupp/proj" },
			{ type: "model_change", id: "c1", timestamp: "2026-09-24T15:06:00.000Z", provider: "anthropic", modelId: "claude-opus-4-1" },
			{ type: "thinking_level_change", id: "c2", timestamp: "2026-09-24T15:06:00.000Z", thinkingLevel: "high" },
			{ type: "message", id: "e1", timestamp: "2026-09-24T15:06:05.000Z", message: { id: "p1", role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "rg -n parseEntry extensions/" } }], usage: { input: 100, output: 20, cacheRead: 12_000, cacheWrite: 0, cost: { total: 0.0123 } } } },
		],
	},
	"pi-compaction": {
		label: "Pi: turn after compaction",
		note: "A compaction entry marks the next turn: its cache write is the compaction bill, and splitOverheadCost carves that share off as Cmpct.",
		expect: ["code"],
		entries: [
			{ type: "model_change", id: "c1", timestamp: "2026-09-24T15:07:00.000Z", provider: "anthropic", modelId: MODEL },
			{ type: "compaction", id: "c3", timestamp: "2026-09-24T15:07:00.000Z", summary: "…", tokensBefore: 150_000 },
			{ type: "message", id: "e2", timestamp: "2026-09-24T15:07:30.000Z", message: { id: "p2", role: "assistant", content: [{ type: "toolCall", id: "call_2", name: "edit", arguments: { path: "extensions/lib/wtft-parser.ts" } }], usage: { input: 5, output: 400, cacheRead: 0, cacheWrite: 22_000 } } },
		],
	},
	"claude-spawn": {
		label: "claude -p spawn → agents",
		note: "A Bash call that runs `claude -p` is agent work. The daemon would find the child's transcript and fold its cost into this turn; this page has no filesystem, so it only flags the spawn.",
		expect: ["agents"],
		entries: [cc("08", "15:08:00", [bash("cd /repo/sub && claude -p 'summarize the diff' | tee /tmp/out.txt")])],
	},
};

/** A preset as the text the playground's editor holds. */
export function presetText(preset: ParserPreset): string {
	return preset.entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n");
}

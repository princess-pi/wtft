#!/usr/bin/env -S npx tsx
/**
 * @package princess-pi-packages
 * @test wtft-issue-52-tool-categories
 * @description Validates #52 Phase 2: tool → category recognition.
 *   Task/Agent → agents, WebSearch/WebFetch → web, Grep tool → grep,
 *   TodoWrite/AskUserQuestion/Skill/Task* → plan, NotebookEdit → file write,
 *   and prompt purification (unrecognized tool never classifies "prompt").
 */

import { parseEntryToInteraction, classifyInteraction, deduplicateInteractions } from "../bin/wtft.mjs";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function assert(label: string, ok: boolean) {
	if (ok) {
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} else {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		failed++;
	}
}

// --- Helpers: synthetic Claude Code / Pi entries ---

let idCounter = 0;
function claudeEntry(content: any[], id?: string) {
	return {
		type: "assistant",
		timestamp: "2026-07-13T12:00:00Z",
		message: {
			role: "assistant",
			id: id || `msg_${++idCounter}`,
			model: "claude-sonnet-5",
			usage: { input_tokens: 100, output_tokens: 50 },
			content
		}
	};
}

function piEntry(content: any[]) {
	return {
		type: "message",
		timestamp: "2026-07-13T12:00:00Z",
		message: {
			role: "assistant",
			id: `msg_${++idCounter}`,
			model: "claude-sonnet-5",
			usage: { input: 100, output: 50 },
			content
		}
	};
}

function classify(entry: any): string {
	const i = parseEntryToInteraction(entry);
	return i ? classifyInteraction(i) : "PARSE_FAIL";
}

// --- Claude Code schema: tool → category map ---
console.log("\nClaude Code tool recognition:");

assert("Task spawn → agents",
	classify(claudeEntry([{ type: "tool_use", name: "Task", input: { prompt: "go" } }])) === "agents");

assert("Agent spawn → agents",
	classify(claudeEntry([{ type: "tool_use", name: "Agent", input: { prompt: "go" } }])) === "agents");

assert("WebSearch → web",
	classify(claudeEntry([{ type: "tool_use", name: "WebSearch", input: { query: "q" } }])) === "web");

assert("WebFetch → web",
	classify(claudeEntry([{ type: "tool_use", name: "WebFetch", input: { url: "https://x" } }])) === "web");

assert("standalone Grep tool → grep",
	classify(claudeEntry([{ type: "tool_use", name: "Grep", input: { pattern: "foo" } }])) === "grep");

assert("TodoWrite → plan",
	classify(claudeEntry([{ type: "tool_use", name: "TodoWrite", input: { todos: [] } }])) === "plan");

assert("TaskCreate → plan",
	classify(claudeEntry([{ type: "tool_use", name: "TaskCreate", input: {} }])) === "plan");

assert("AskUserQuestion → plan",
	classify(claudeEntry([{ type: "tool_use", name: "AskUserQuestion", input: {} }])) === "plan");

assert("Skill → plan",
	classify(claudeEntry([{ type: "tool_use", name: "Skill", input: { skill: "tdd" } }])) === "plan");

assert("ToolSearch → plan",
	classify(claudeEntry([{ type: "tool_use", name: "ToolSearch", input: { query: "x" } }])) === "plan");

assert("NotebookEdit → file write → code (src/ path)",
	classify(claudeEntry([{ type: "tool_use", name: "NotebookEdit", input: { notebook_path: "src/analysis.ipynb" } }])) === "code");

// --- Prompt purification ---
console.log("\nPrompt purification:");

assert("unknown tool (Monitor) alone → other, not prompt",
	classify(claudeEntry([{ type: "tool_use", name: "Monitor", input: {} }])) === "other");

assert("unknown tool + narration text → other, not prompt",
	classify(claudeEntry([
		{ type: "text", text: "Watching the deploy now." },
		{ type: "tool_use", name: "Monitor", input: {} }
	])) === "other");

assert("pure text reply → prompt",
	classify(claudeEntry([{ type: "text", text: "Here is the answer." }])) === "prompt");

assert("thinking + text reply → prompt",
	classify(claudeEntry([
		{ type: "thinking", thinking: "hmm" },
		{ type: "text", text: "Answer." }
	])) === "prompt");

// --- Precedence ---
console.log("\nPrecedence:");

assert("file write beats Task spawn (edit + Task → code)",
	classify(claudeEntry([
		{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } },
		{ type: "tool_use", name: "Task", input: { prompt: "go" } }
	])) === "code");

assert("file read beats WebSearch (read spec + search → spec)",
	classify(claudeEntry([
		{ type: "tool_use", name: "Read", input: { file_path: "docs/spec.md" } },
		{ type: "tool_use", name: "WebSearch", input: { query: "q" } }
	])) === "spec");

assert("agents beats web in same message",
	classify(claudeEntry([
		{ type: "tool_use", name: "Task", input: { prompt: "go" } },
		{ type: "tool_use", name: "WebSearch", input: { query: "q" } }
	])) === "agents");

assert("toolCats (plan) beats bash command (git)",
	classify(claudeEntry([
		{ type: "tool_use", name: "TodoWrite", input: { todos: [] } },
		{ type: "tool_use", name: "Bash", input: { command: "git status" } }
	])) === "plan");

assert("bash git alone still → git",
	classify(claudeEntry([{ type: "tool_use", name: "Bash", input: { command: "git status" } }])) === "git");

// --- Pi schema ---
console.log("\nPi toolCall schema:");

assert("Pi toolCall websearch → web",
	classify(piEntry([{ type: "toolCall", name: "websearch", arguments: { query: "q" } }])) === "web");

assert("Pi toolCall read → spec (docs path)",
	classify(piEntry([{ type: "toolCall", name: "read", arguments: { path: "docs/spec.md" } }])) === "spec");

assert("Pi unknown toolCall → other",
	classify(piEntry([{ type: "toolCall", name: "mystery_tool", arguments: {} }])) === "other");

// --- Dedup merge carries toolCats ---
console.log("\nDedup merge:");

{
	const a = parseEntryToInteraction(claudeEntry([{ type: "text", text: "Spawning." }], "msg_dup"));
	const b = parseEntryToInteraction(claudeEntry([{ type: "tool_use", name: "Task", input: { prompt: "go" } }], "msg_dup"));
	const merged = deduplicateInteractions([a!, b!]);
	assert("two lines, same message id → one interaction", merged.length === 1);
	assert("merged interaction classifies agents (toolCats survive merge)",
		classifyInteraction(merged[0]) === "agents");
}

// --- Summary ---
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

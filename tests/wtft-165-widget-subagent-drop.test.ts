#!/usr/bin/env -S bun
/**
 * tests/wtft-165-widget-subagent-drop.test.ts — #165.
 *
 * Discovery lists a subagent transcript by stat, so a file whose READ then
 * fails (mode 000, vanished) passes discovery and is dropped later by
 * loadSubagentInteractions. The widget must mark that total provisional, the
 * same as a discovery-level unreadable file.
 *
 * Drives the built Pi widget (pi/wtft.js) through a fake `pi`/`ctx`: fire
 * `agent_settled`, capture what `setWidget` receives.
 *
 * Run: bun tests/wtft-165-widget-subagent-drop.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { skip } from "./lib/skips";

isolateTmpdir("165-widget-subagent-drop");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.log(`  ❌ FAIL: ${msg}`); }
}

const PROVISIONAL = "total is provisional";

if (typeof process.getuid === "function" && process.getuid() === 0) {
	skip("root reads a mode-000 file, so the unreadable case cannot be built");
	process.exit(0);
}

const sandbox = fs.realpathSync(trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-165-"))));
// Any config at all makes the widget visible (getSettings: hasConfig).
process.env.HOME = sandbox;
process.env.XDG_CONFIG_HOME = path.join(sandbox, "xdg-config");
fs.mkdirSync(path.join(sandbox, "xdg-config", "wtft"), { recursive: true });
fs.writeFileSync(path.join(sandbox, "xdg-config", "wtft", "config.json"), "{}\n");
process.chdir(sandbox);

function usageLine(id: string, ts: string): string {
	return JSON.stringify({
		type: "assistant", timestamp: ts, cwd: sandbox, isSidechain: true,
		message: {
			role: "assistant", id, model: "claude-sonnet-4-5",
			content: [{ type: "text", text: "x" }],
			usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	});
}

const sessionFile = path.join(sandbox, "session.jsonl");
fs.writeFileSync(sessionFile, "");
const subDir = path.join(sandbox, "session", "subagents");
fs.mkdirSync(subDir, { recursive: true });
fs.writeFileSync(path.join(subDir, "agent-a.jsonl"), usageLine("a", "2026-09-18T12:00:00Z") + "\n");
const dropped = path.join(subDir, "agent-b.jsonl");
fs.writeFileSync(dropped, usageLine("b", "2026-09-18T12:01:00Z") + "\n");

const { discoverSubagentSessionFiles } = await import("../bin/wtft.mjs");
const mod = await import("../pi/wtft.js");

const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void> | void> = {};
const fakePi = { on: (name: string, fn: any) => { handlers[name] = fn; }, registerCommand: () => {} };
mod.default(fakePi);

async function render(): Promise<string[]> {
	let captured: string[] = [];
	const ctx = {
		sessionManager: { getSessionFile: () => sessionFile },
		ui: { setWidget: (_id: string, lines: string[] | undefined) => { captured = lines ?? []; } },
		model: undefined,
	};
	await handlers["agent_settled"](undefined, ctx);
	return captured;
}

console.log("\n=== #165: a subagent file dropped at READ marks the widget total provisional ===\n");

const clean = await render();
check(clean.length > 0, "setup: the widget renders");
check(!clean.some(l => l.includes(PROVISIONAL)), "control: both subagent files readable -> no provisional line");

fs.chmodSync(dropped, 0o000);
try {
	const found = discoverSubagentSessionFiles(sessionFile);
	check(found.files.includes(dropped) && found.unreadable === null,
		"precondition: discovery still lists the mode-000 file and reports nothing unreadable");

	const lines = await render();
	check(lines.some(l => l.includes(PROVISIONAL)),
		"closer: the file dropped by loadSubagentInteractions marks the total provisional");
} finally {
	fs.chmodSync(dropped, 0o644);
}

const again = await render();
check(!again.some(l => l.includes(PROVISIONAL)), "the flag is per-render: readable again -> no provisional line");

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

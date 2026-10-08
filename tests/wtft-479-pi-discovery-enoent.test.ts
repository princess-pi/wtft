#!/usr/bin/env -S bun

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSubagentSessionFiles } from "../extensions/lib/wtft-parser.ts";
import { newTaggerState, stepTagger, fsWorld } from "../extensions/lib/session-tagger.ts";
import { getCurrentVersionTagPath } from "../extensions/lib/wtft-daemon-lib.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { widgetWithoutDaemon } from "./lib/cli-harness.ts";
import { skip } from "./lib/skips";

isolateTmpdir("479-pi-discovery-enoent");

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

const dir = fs.realpathSync(trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-479-"))));
const sessionDir = path.join(dir, "sessions", "--proj--");
fs.mkdirSync(sessionDir, { recursive: true });

console.log("\n=== discovery: a session transcript not written yet ===\n");
{
	const absent = path.join(sessionDir, "2026-10-08T00-00-00-000Z_47900000-0000-4000-8000-000000000001.jsonl");
	check(!fs.existsSync(absent), "precondition: the session transcript does not exist");
	const { result, stderr } = captureStderr(() => discoverSubagentSessionFiles(absent));
	check(result.files.length === 0, "no files are listed", JSON.stringify(result.files));
	check(result.unreadable === null, "discovery is not unreadable", String(result.unreadable));
	check(result.sessionUnreadable === null, "the session transcript is not unreadable", String(result.sessionUnreadable));
	check(stderr === "", "discovery writes nothing to stderr", stderr);
}
{
	const absent = path.join(sessionDir, "2026-10-08T00-00-03-000Z_47900000-0000-4000-8000-000000000004.jsonl");
	const task = path.join(sessionDir, path.basename(absent, ".jsonl"), "subagents", "agent-a1.jsonl");
	fs.mkdirSync(path.dirname(task), { recursive: true });
	fs.writeFileSync(task, "{}\n");
	check(!fs.existsSync(absent), "precondition: the session transcript does not exist, its subagents/ does");
	const { result, stderr } = captureStderr(() => discoverSubagentSessionFiles(absent));
	check(result.files.length === 1 && result.files[0] === task && result.unreadable === null && stderr === "",
		"the session's own subagents/ is still walked, silently", JSON.stringify({ files: result.files, unreadable: String(result.unreadable), stderr }));
}

console.log("\n=== the log parser daemon's tagger: a session transcript not written yet ===\n");
{
	const absent = path.join(sessionDir, "2026-10-08T00-00-04-000Z_47900000-0000-4000-8000-000000000005.jsonl");
	check(!fs.existsSync(absent), "precondition: the session transcript does not exist");
	const state = newTaggerState(absent, getCurrentVersionTagPath(absent));
	const step = stepTagger(state, fsWorld(), { flush: true });
	const warns = step.log.filter(l => l.level === "warn").map(l => l.text);
	check(warns.length === 0, "the tagger warns nothing", JSON.stringify(warns));
	check(!state.pollHadFailure, "and does not fail the poll");
}

console.log("\n=== control: a session transcript that exists and cannot be read ===\n");
if (process.getuid?.() === 0) {
	skip("root reads a mode-000 file, so the control cannot be unreadable");
} else {
	const locked = path.join(sessionDir, "2026-10-08T00-00-02-000Z_47900000-0000-4000-8000-000000000003.jsonl");
	fs.writeFileSync(locked, JSON.stringify({ type: "session", id: "47900000-0000-4000-8000-000000000003" }) + "\n");
	fs.chmodSync(locked, 0o000);
	let cannotOpen = false;
	try { fs.closeSync(fs.openSync(locked, "r")); } catch { cannotOpen = true; }
	check(cannotOpen, "precondition: the mode-000 transcript cannot be opened");
	try {
		const { result, stderr } = captureStderr(() => discoverSubagentSessionFiles(locked));
		check(result.sessionUnreadable !== null && result.unreadable !== null, "it is reported unreadable",
			JSON.stringify({ sessionUnreadable: String(result.sessionUnreadable), unreadable: String(result.unreadable) }));
		check(stderr.includes("could not be read at discovery") && stderr.includes(locked), "and warned, naming it", stderr);
	} finally {
		fs.chmodSync(locked, 0o644);
	}
}

console.log("\n=== the Pi widget: session_start before pi writes the transcript ===\n");
{
	process.env.HOME = dir;
	process.env.XDG_CONFIG_HOME = path.join(dir, "xdg-config");
	process.env.XDG_STATE_HOME = path.join(dir, "xdg-state");
	process.env.PRINCESS_PI_CONFIG_NO_WALKUP = "1";
	fs.mkdirSync(path.join(dir, "xdg-config", "wtft"), { recursive: true });
	fs.writeFileSync(path.join(dir, "xdg-config", "wtft", "config.json"), "{}\n");

	const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void> | void> = {};
	const mod = await import(widgetWithoutDaemon());
	mod.default({ on: (name: string, fn: any) => { handlers[name] = fn; }, registerCommand: () => {} });

	const session = path.join(sessionDir, "2026-10-08T00-00-01-000Z_47900000-0000-4000-8000-000000000002.jsonl");
	const widget: string[] = [];
	const ctx = {
		sessionManager: { getSessionFile: () => session },
		ui: {
			setWidget: (_id: string, lines: string[] | undefined) => { widget.push(...(lines ?? [])); },
			notify: () => {},
			custom: async () => {},
		},
		model: undefined,
	};
	check(!fs.existsSync(session), "precondition: the session transcript does not exist");
	const original = process.stderr.write.bind(process.stderr);
	let stderr = "";
	process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
	try {
		await handlers["session_start"]({ type: "session_start", reason: "startup" }, ctx);
		await handlers["session_shutdown"]({ type: "session_shutdown" }, ctx);
	} finally {
		process.stderr.write = original;
	}
	check(widget.length > 0, "precondition: session_start drew the widget", JSON.stringify(widget));
	check(!/could not be read at discovery/.test(stderr), "stderr holds no discovery warning", stderr);
	check(!widget.some(l => l.includes("total is provisional")), "the widget shows no provisional line", JSON.stringify(widget));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

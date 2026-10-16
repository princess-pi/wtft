#!/usr/bin/env -S bun

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { readTagFileWithVerdict } from "../extensions/lib/wtft-daemon-lib.ts";
import { discoverSubagentSessionFiles, loadSubagentInteractionsChecked } from "../extensions/lib/wtft-parser.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { cliWithoutDaemon, widgetWithoutDaemon, tagForCli } from "./lib/cli-harness.ts";

isolateTmpdir("237-shared-claude-child");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detail?: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.log(`  ❌ FAIL: ${msg}${detail ? `\n     ${detail}` : ""}`); }
}

const S_OUT = 1_000, A_OUT = 10_000, F_OUT = 5_000;
const EXPECTED = S_OUT + A_OUT + F_OUT;

function turnLine(id: string, tsMs: number, outputTokens: number, spawnCwd?: string): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso,
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6", timestamp: iso,
			usage: { input_tokens: 0, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: spawnCwd
				? [{ type: "toolCall", name: "bash", arguments: { command: `cd ${spawnCwd} && claude -p "go"` } }]
				: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

const dir = fs.realpathSync(trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-237-"))));
process.env.HOME = dir;
process.env.XDG_CONFIG_HOME = path.join(dir, "xdg-config");
process.env.XDG_STATE_HOME = path.join(dir, "xdg-state");
process.env.PRINCESS_PI_CONFIG_NO_WALKUP = "1";
process.env.WTFT_CLAUDE_PROJECTS_DIR = path.join(dir, "projects");
fs.mkdirSync(path.join(dir, "xdg-config", "wtft"), { recursive: true });
fs.writeFileSync(path.join(dir, "xdg-config", "wtft", "config.json"), "{}\n");

const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void> | void> = {};
let command: ((args: string, ctx: unknown) => Promise<void>) | null = null;
const mod = await import(widgetWithoutDaemon());
mod.default({ on: (name: string, fn: any) => { handlers[name] = fn; }, registerCommand: (_n: string, def: any) => { command = def.handler; } });
const kilo = (n: number) => new RegExp(`\\s${n / 1000}(\\.0)?k\\s`);

/** `lateMs` writes the subagent transcript only after S and F are tagged and the clock has moved on by that much. */
async function scenario(n: number, name: string, sAt: number, aAt: number, lateMs: number | null): Promise<void> {
	console.log(`\n=== #237 [${name}]: S and its Task subagent both run claude -p, matching the same child F ===\n`);
	const childCwd = path.join(dir, `child-cwd-${n}`);
	fs.mkdirSync(childCwd);
	const childProject = path.join(process.env.WTFT_CLAUDE_PROJECTS_DIR!, childCwd.replace(/\//g, "-"));
	fs.mkdirSync(childProject, { recursive: true });

	const T0 = Date.now() - 60_000;
	const F = `23700000-0000-4000-8000-0000000000f${n}`;
	fs.writeFileSync(path.join(childProject, `${F}.jsonl`), turnLine(`msg-237-f${n}`, T0 + 2_000, F_OUT));

	const session = path.join(dir, `23700000-0000-4000-8000-00000000000${n}.jsonl`);
	fs.writeFileSync(session,
		JSON.stringify({ type: "session", version: 3, id: path.basename(session, ".jsonl"), timestamp: new Date(T0).toISOString(), cwd: dir }) + "\n"
		+ turnLine(`msg-237-s${n}`, T0 + sAt, S_OUT, childCwd));
	const subagentId = `msg-237-a${n}`;
	const subagent = path.join(dir, path.basename(session, ".jsonl"), "subagents", "agent-x.jsonl");
	const writeSubagent = () => {
		fs.mkdirSync(path.dirname(subagent), { recursive: true });
		fs.writeFileSync(subagent, turnLine(subagentId, T0 + aAt, A_OUT, childCwd));
	};

	if (lateMs === null) writeSubagent();
	const tagger = tagForCli(session);
	if (lateMs !== null) {
		check(readTagFileWithVerdict(tagger.tagPath).folded.has(F), "fixture precondition: before the subagent transcript exists, F is tagged as S's child");
		tagger.advance(lateMs);
		writeSubagent();
	}
	for (let i = 0; i < 6; i++) tagger.poll();
	const tag = readTagFileWithVerdict(tagger.tagPath);
	const lines = JSON.stringify(tag.interactions.map(i => [i.messageId, i.outputTokens]));
	check(tag.folded.has(F), "fixture precondition: the daemon folded F into the tag", JSON.stringify([...tag.folded]));
	check(tag.interactions.find(i => i.messageId === subagentId)?.outputTokens === A_OUT + F_OUT,
		"fixture precondition: in the tag, F sits inside the subagent's turn", lines);
	const parsed = loadSubagentInteractionsChecked(discoverSubagentSessionFiles(session).files, undefined, undefined, undefined, session).interactions;
	check(parsed.find(i => i.messageId === subagentId)?.outputTokens === A_OUT + F_OUT,
		"fixture precondition: the widget's own parse of the subagent transcript folds F into that same turn",
		JSON.stringify(parsed.map(i => [i.messageId, i.outputTokens])));
	const tagged = tag.interactions.reduce((sum, i) => sum + i.outputTokens, 0);
	check(tagged === EXPECTED, `the tag bills F once: ${S_OUT} + ${A_OUT} + ${F_OUT} (got ${tagged})`, lines);

	const json = spawnSync(process.execPath, [cliWithoutDaemon(), "--json", "-s", session], {
		encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WTFT_DAEMON_DEBUG: "" },
	});
	let jsonOut: number | null = null;
	try { jsonOut = JSON.parse(json.stdout).total.outputTokens; } catch {}
	check(json.status === 0 && jsonOut === EXPECTED, `wtft --json -s S: total.outputTokens counts F once (got ${jsonOut}, exit ${json.status})`, json.stderr.slice(0, 400));

	const notify: string[] = [];
	await command!("--tokens", {
		sessionManager: { getSessionFile: () => session },
		ui: { setWidget: () => {}, notify: (text: string) => { notify.push(text); }, custom: async () => {} },
		model: undefined,
	});
	const totalRow = notify.join("\n").split("\n").find(l => /^\s*TOTAL\b/.test(l)) ?? "";
	check(kilo(EXPECTED).test(totalRow), `the widget's /wtft --tokens TOTAL counts F once: ${EXPECTED}`, totalRow);
}

await scenario(1, "S's turn first", 0, 4_000, null);
await scenario(2, "subagent's turn first", 3_000, 0, null);
await scenario(3, "subagent transcript appears 60 s after F is tagged", 0, 4_000, 60_000);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

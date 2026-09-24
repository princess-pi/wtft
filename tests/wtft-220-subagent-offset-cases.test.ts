#!/usr/bin/env bun
/**
 * The subagent offset reader agrees with a full parse of the finished
 * transcript when an interrupt follows a turn already written, when the file
 * is replaced in place by a longer body, and when an ordinary turn is
 * re-emitted at a lower cost.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
	readClassifiedTagFile,
	parseSessionFile,
	deduplicateInteractions,
	WTFT_TAGGER_VERSION,
} from "../bin/wtft.mjs";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("220-subagent-offset-cases");

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";
let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean, detail = "") {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n       ${detail}` : ""}`); failed++; }
}

function turn(id: string, tsMs: number, outputTokens: number): string {
	return JSON.stringify({
		type: "assistant",
		timestamp: new Date(tsMs).toISOString(),
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6",
			usage: { input_tokens: 1000, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}
const INTERRUPT = JSON.stringify({ type: "user", message: { content: "[Request interrupted by user]" } }) + "\n";

const rows = (list: any[]) => JSON.stringify(list
	.filter(i => i.messageId)
	.map(i => ({ id: i.messageId, cost: Number(i.cost.toFixed(9)), interrupted: !!i.interrupted }))
	.sort((a, b) => a.id.localeCompare(b.id)));

/** Starts a daemon on a fresh session whose one subagent transcript holds
 *  `initial`, waits until `ready` holds for the tag, runs `mutate`, then waits
 *  for the tag to match a full parse of the transcript. Returns both, as rows. */
async function runCase(
	name: string,
	initial: string,
	mutate: (file: string) => Promise<void>,
	ready: (tagged: any[]) => boolean = tagged => tagged.length > 0,
): Promise<{ tag: string; full: string; initialTagged: boolean }> {
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), `wtft-220-${name}-`)));
	const session = path.join(dir, "session.jsonl");
	fs.writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: `parent-220-${name}`, timestamp: new Date().toISOString(), cwd: dir }) + "\n");
	fs.mkdirSync(path.join(dir, "wtft-tags"), { recursive: true });
	const subDir = path.join(dir, "session", "subagents");
	fs.mkdirSync(subDir, { recursive: true });
	const sub = path.join(subDir, "agent-case.jsonl");
	fs.writeFileSync(sub, initial);
	const tag = path.join(dir, "wtft-tags", `session.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", session], { detached: true, stdio: "ignore" });
	child.unref();
	try {
		let initialTagged = false;
		for (let i = 0; i < 200 && !initialTagged; i++) {
			await sleep(50);
			initialTagged = ready(readClassifiedTagFile(tag));
		}
		await mutate(sub);
		const full = rows(deduplicateInteractions(parseSessionFile(sub)));
		let got = rows(readClassifiedTagFile(tag));
		for (let i = 0; i < 40 && got !== full; i++) {
			await sleep(250);
			got = rows(readClassifiedTagFile(tag));
		}
		return { tag: got, full, initialTagged };
	} finally {
		try { process.kill(child.pid!, "SIGTERM"); } catch { /* gone */ }
		await sleep(200);
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

console.log("wtft subagent offset reader cases (#220)");

const T0 = Date.now() - 60_000;

{
	const r = await runCase("interrupt", turn("msg_a", T0, 100), async file => {
		fs.appendFileSync(file, INTERRUPT);
		await sleep(1500);
		fs.appendFileSync(file, turn("msg_b", T0 + 1000, 200));
		await sleep(300);
		fs.appendFileSync(file, turn("msg_c", T0 + 2000, 300));
	});
	assert("fixture: the turn before the interrupt was tagged before the interrupt was written", r.initialTagged);
	assert("an interrupt after a turn already written marks that turn, and no later one", r.tag === r.full, `tag:  ${r.tag}\n       full: ${r.full}`);
}

{
	const owner = JSON.stringify({
		type: "assistant",
		timestamp: new Date(T0 + 500).toISOString(),
		message: {
			role: "assistant", id: "msg_owner", model: "claude-sonnet-4-6",
			usage: { input_tokens: 1000, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "claude -p 'go'" } }],
		},
	}) + "\n";
	// Appended the moment the owner turn is tagged, while the ordinary turn
	// before it is most likely still held back.
	const r = await runCase("interrupt-after-owner", turn("msg_plain", T0, 100) + owner, async file => {
		fs.appendFileSync(file, INTERRUPT);
	}, tagged => tagged.some((i: any) => i.messageId === "msg_owner"));
	assert("fixture: the turn a Claude command started was tagged before the interrupt", r.initialTagged);
	assert("an interrupt after a command turn marks that turn, not the ordinary turn before it", r.tag === r.full, `tag:  ${r.tag}\n       full: ${r.full}`);
}

{
	const r = await runCase("rewrite", turn("msg_a", T0, 100), async file => {
		const body = turn("msg_b", T0 + 1000, 200) + turn("msg_c", T0 + 2000, 300);
		const fd = fs.openSync(file, "r+");
		try { fs.writeSync(fd, body, 0); } finally { fs.closeSync(fd); }
	});
	assert("fixture: the first body was tagged before the rewrite", r.initialTagged);
	assert("a longer in-place rewrite that is not an append matches a full parse", r.tag === r.full, `tag:  ${r.tag}\n       full: ${r.full}`);
}

{
	const r = await runCase("lower-cost", turn("msg_a", T0, 5000), async file => {
		fs.appendFileSync(file, turn("msg_a", T0, 100));
	});
	assert("fixture: the first copy was tagged before the lower one", r.initialTagged);
	assert("an ordinary turn re-emitted at a lower cost matches a full parse", r.tag === r.full, `tag:  ${r.tag}\n       full: ${r.full}`);
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : ""}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env bun
/**
 * #97 — a later wake of a subagent transcript reads the new bytes, not the file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCurrentVersionTagPath, readClassifiedTagFile, transcriptSourceId } from "../extensions/lib/wtft-daemon-lib.ts";
import { parseSessionFile, deduplicateInteractions } from "../extensions/lib/wtft-parser.ts";
import { trackSandbox } from "./lib/sandbox";
import { tagSession } from "./lib/tagger-harness.ts";

const DAEMON_SRC = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.ts");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}`); failed++; }
}


function turnLine(id: string, tsMs: number, inputTokens: number, outputTokens: number): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			id,
			model: "claude-sonnet-4-6",
			timestamp: new Date(tsMs).toISOString(),
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			content: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

function deltaBytes(log: { text: string }[]): number[] {
	return log.flatMap(l => [...l.text.matchAll(/subagent delta (\d+) bytes/g)].map(m => Number(m[1])));
}

console.log("wtft subagent offset read (#97)");

const src = fs.readFileSync(DAEMON_SRC, "utf8");
assert("the daemon does not retain a per-line writtenLines map", !src.includes("writtenLines"));

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-97-offset-")));
const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-97-offset", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");

const subagentDir = path.join(dir, "session", "subagents");
fs.mkdirSync(subagentDir, { recursive: true });
const subagentPath = path.join(subagentDir, "agent-offset1.jsonl");

const T0 = Date.now() - 60_000;
const FIRST = "msg_97_first";
const SECOND = "msg_97_second";
const initial = turnLine(FIRST, T0, 5000, 10);
fs.writeFileSync(subagentPath, initial);

{
	const tagger = tagSession(sessionPath);
	const tagPath = tagger.tagPath;

	const sawFirst = tagger.until(() => readClassifiedTagFile(tagPath).some((int: { messageId?: string }) => int.messageId === FIRST));
	assert("the tagger classifies the subagent transcript already on disk", sawFirst);

	const appended = turnLine(SECOND, T0 + 5_000, 8000, 20);
	fs.appendFileSync(subagentPath, appended);

	const sawSecond = tagger.until(() => readClassifiedTagFile(tagPath).some((int: { messageId?: string }) => int.messageId === SECOND));
	assert("the tagger classifies an appended turn", sawSecond);

	const deltas = deltaBytes(tagger.log);
	const initialBytes = Buffer.byteLength(initial);
	const appendedBytes = Buffer.byteLength(appended);
	assert(
		`the first read is the bytes already on disk (${deltas[0]} === ${initialBytes})`,
		deltas[0] === initialBytes,
	);
	assert(
		`the growth read is the appended bytes only (${deltas.join(",")} includes ${appendedBytes})`,
		deltas.includes(appendedBytes),
	);
	assert(
		"no later read is the whole file again",
		!deltas.slice(1).includes(initialBytes + appendedBytes) && !deltas.slice(1).includes(initialBytes),
	);

	const ids = new Set([FIRST, SECOND]);
	const seen = readClassifiedTagFile(tagPath).filter((int: { messageId?: string }) => int.messageId && ids.has(int.messageId));
	const reference = deduplicateInteractions(parseSessionFile(subagentPath)).filter((int: { messageId?: string }) => int.messageId && ids.has(int.messageId));
	const cost = (rows: { cost: number }[]) => rows.reduce((s, i) => s + i.cost, 0);
	assert(
		`classified cost matches a straight parse (${cost(seen).toFixed(6)} === ${cost(reference).toFixed(6)})`,
		Math.abs(cost(seen) - cost(reference)) < 0.000001,
	);
}

{
	const junkDir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-97-junk-")));
	const junkSession = path.join(junkDir, "session.jsonl");
	fs.writeFileSync(junkSession, JSON.stringify({
		type: "session", version: 3, id: "parent-97-junk", timestamp: new Date().toISOString(), cwd: junkDir,
	}) + "\n");
	const junkSubDir = path.join(junkDir, "session", "subagents");
	fs.mkdirSync(junkSubDir, { recursive: true });
	const junkSub = path.join(junkSubDir, "agent-junk.jsonl");
	fs.writeFileSync(junkSub, "not-json\n");
	const junkTag = getCurrentVersionTagPath(junkSession);
	fs.mkdirSync(path.dirname(junkTag), { recursive: true });
	const source = transcriptSourceId(junkSub, path.dirname(junkSession));
	const staleId = "msg_97_stale";
	fs.writeFileSync(junkTag, JSON.stringify({
		t: Date.now(), c: 1, cat: "code", f: [], cmd: [], id: staleId, m: "claude-sonnet-4-6", out: 10, s: source,
	}) + "\n");
	assert(
		"fixture: the stale line counts before the junk read",
		readClassifiedTagFile(junkTag).some((int: { messageId?: string }) => int.messageId === staleId),
	);
	{
		const tagger = tagSession(junkSession);
		const retired = tagger.until(() => fs.readFileSync(junkTag, "utf8").includes('"_gen"')
			&& !readClassifiedTagFile(junkTag).some((int: { messageId?: string }) => int.messageId === staleId));
		assert("a junk transcript still opens a generation, so the stale line is gone", retired);
	}
}

{
	const reDir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-97-reemit-")));
	const reSession = path.join(reDir, "session.jsonl");
	fs.writeFileSync(reSession, JSON.stringify({
		type: "session", version: 3, id: "parent-97-reemit", timestamp: new Date().toISOString(), cwd: reDir,
	}) + "\n");
	const reSubDir = path.join(reDir, "session", "subagents");
	fs.mkdirSync(reSubDir, { recursive: true });
	const reSub = path.join(reSubDir, "agent-reemit.jsonl");
	const reId = "msg_97_reemit";
	const reTs = Date.now() - 60_000;
	const withCommand = (out: number) => {
		const iso = new Date(reTs).toISOString();
		return JSON.stringify({
			type: "message",
			timestamp: iso,
			message: {
				role: "assistant", id: reId, model: "claude-sonnet-4-6", timestamp: iso,
				usage: { input_tokens: 1000, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				content: [{ type: "toolCall", name: "bash", arguments: { command: "claude -p 'go'" } }],
			},
		}) + "\n";
	};
	const withoutCommand = (out: number) => {
		const iso = new Date(reTs).toISOString();
		return JSON.stringify({
			type: "message",
			timestamp: iso,
			message: {
				role: "assistant", id: reId, model: "claude-sonnet-4-6", timestamp: iso,
				usage: { input_tokens: 1000, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				content: [{ type: "text", text: "later" }],
			},
		}) + "\n";
	};
	fs.writeFileSync(reSub, withCommand(10));
	const tagger = tagSession(reSession);
	const reTag = tagger.tagPath;
	const linesForId = () => {
		if (!fs.existsSync(reTag)) return [] as { id?: string; cmd?: string[]; out?: number }[];
		return fs.readFileSync(reTag, "utf8").split("\n").filter(Boolean).flatMap(line => {
			try {
				const obj = JSON.parse(line);
				return obj.id === reId ? [obj] : [];
			} catch { return []; }
		});
	};
	{
		const sawCommand = tagger.until(() => linesForId().some(obj => Array.isArray(obj.cmd) && obj.cmd.length > 0 && obj.out === 10));
		assert("fixture: the command-bearing copy is tagged", sawCommand);
		fs.appendFileSync(reSub, withoutCommand(50));
		const sawGrown = tagger.until(() => linesForId().some(obj => obj.out === 50));
		const tagged = linesForId();
		assert(
			"a higher re-emit that omits the command keeps the command on that id",
			sawGrown && tagged.every(obj => Array.isArray(obj.cmd) && obj.cmd.length > 0),
		);
	}
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

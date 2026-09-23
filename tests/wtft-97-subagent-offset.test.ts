#!/usr/bin/env bun
/**
 * #97 — a later wake of a subagent transcript reads the new bytes, not the file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
	getDaemonPidPath,
	readClassifiedTagFile,
	parseSessionFile,
	deduplicateInteractions,
	WTFT_TAGGER_VERSION,
} from "../bin/wtft.mjs";
import { transcriptSourceId } from "../extensions/lib/wtft-daemon-lib.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("subagent-offset");

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const cleanupPids: number[] = [];
const cleanupPidFiles: string[] = [];
const fixtureDirs: string[] = [];

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

function deltaBytes(log: string): number[] {
	return [...log.matchAll(/subagent delta (\d+) bytes/g)].map(m => Number(m[1]));
}

console.log("wtft subagent offset read (#97)");

const src = fs.readFileSync(DAEMON_SRC, "utf8");
assert("the daemon does not retain a per-line writtenLines map", !src.includes("writtenLines"));

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-97-offset-")));
fixtureDirs.push(dir);
const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-97-offset", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");
fs.mkdirSync(path.join(dir, "wtft-tags"), { recursive: true });
cleanupPidFiles.push(getDaemonPidPath(sessionPath));

const subagentDir = path.join(dir, "session", "subagents");
fs.mkdirSync(subagentDir, { recursive: true });
const subagentPath = path.join(subagentDir, "agent-offset1.jsonl");
const tagPath = path.join(dir, "wtft-tags", path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
const stderrPath = path.join(dir, "daemon-stderr.log");
const stderrFd = fs.openSync(stderrPath, "a");

const T0 = Date.now() - 60_000;
const FIRST = "msg_97_first";
const SECOND = "msg_97_second";
const initial = turnLine(FIRST, T0, 5000, 10);
fs.writeFileSync(subagentPath, initial);

try {
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", sessionPath], {
		detached: true,
		stdio: ["ignore", "ignore", stderrFd],
		env: { ...process.env, WTFT_DAEMON_DEBUG: "1" },
	});
	child.unref();
	if (child.pid) cleanupPids.push(child.pid);

	let sawFirst = false;
	for (let i = 0; i < 24 && !sawFirst; i++) {
		await sleep(250);
		sawFirst = readClassifiedTagFile(tagPath).some((int: { messageId?: string }) => int.messageId === FIRST);
	}
	assert("daemon classifies the subagent transcript already on disk", sawFirst);

	const appended = turnLine(SECOND, T0 + 5_000, 8000, 20);
	fs.appendFileSync(subagentPath, appended);

	let sawSecond = false;
	for (let i = 0; i < 24 && !sawSecond; i++) {
		await sleep(250);
		sawSecond = readClassifiedTagFile(tagPath).some((int: { messageId?: string }) => int.messageId === SECOND);
	}
	assert("daemon classifies an appended turn", sawSecond);

	const deltas = deltaBytes(fs.readFileSync(stderrPath, "utf8"));
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
} finally {
	try { fs.closeSync(stderrFd); } catch { /* already closed */ }
	for (const pid of cleanupPids) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
	for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch { /* gone */ } }
	await sleep(200);
	for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
}

{
	const junkDir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-97-junk-")));
	fixtureDirs.push(junkDir);
	const junkSession = path.join(junkDir, "session.jsonl");
	fs.writeFileSync(junkSession, JSON.stringify({
		type: "session", version: 3, id: "parent-97-junk", timestamp: new Date().toISOString(), cwd: junkDir,
	}) + "\n");
	fs.mkdirSync(path.join(junkDir, "wtft-tags"), { recursive: true });
	const junkPid = getDaemonPidPath(junkSession);
	cleanupPidFiles.push(junkPid);
	const junkSubDir = path.join(junkDir, "session", "subagents");
	fs.mkdirSync(junkSubDir, { recursive: true });
	const junkSub = path.join(junkSubDir, "agent-junk.jsonl");
	fs.writeFileSync(junkSub, "not-json\n");
	const junkTag = path.join(junkDir, "wtft-tags", path.basename(junkSession) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const source = transcriptSourceId(junkSub, path.dirname(junkSession));
	const staleId = "msg_97_stale";
	fs.writeFileSync(junkTag, JSON.stringify({
		t: Date.now(), c: 1, cat: "code", f: [], cmd: [], id: staleId, m: "claude-sonnet-4-6", out: 10, s: source,
	}) + "\n");
	assert(
		"fixture: the stale line counts before the junk read",
		readClassifiedTagFile(junkTag).some((int: { messageId?: string }) => int.messageId === staleId),
	);
	const junkErr = fs.openSync(path.join(junkDir, "daemon-stderr.log"), "a");
	try {
		const child = spawn(process.execPath, [DAEMON_BIN, "--session", junkSession], {
			detached: true,
			stdio: ["ignore", "ignore", junkErr],
			env: { ...process.env, WTFT_DAEMON_DEBUG: "1" },
		});
		child.unref();
		if (child.pid) cleanupPids.push(child.pid);
		let retired = false;
		for (let i = 0; i < 24 && !retired; i++) {
			await sleep(250);
			const raw = fs.existsSync(junkTag) ? fs.readFileSync(junkTag, "utf8") : "";
			retired = raw.includes('"_gen"')
				&& !readClassifiedTagFile(junkTag).some((int: { messageId?: string }) => int.messageId === staleId);
		}
		assert("a junk transcript still opens a generation, so the stale line is gone", retired);
	} finally {
		try { fs.closeSync(junkErr); } catch { /* already closed */ }
		for (const pid of cleanupPids) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
		for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch { /* gone */ } }
		await sleep(200);
		for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
	}
}

{
	const reDir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-97-reemit-")));
	fixtureDirs.push(reDir);
	const reSession = path.join(reDir, "session.jsonl");
	fs.writeFileSync(reSession, JSON.stringify({
		type: "session", version: 3, id: "parent-97-reemit", timestamp: new Date().toISOString(), cwd: reDir,
	}) + "\n");
	fs.mkdirSync(path.join(reDir, "wtft-tags"), { recursive: true });
	cleanupPidFiles.push(getDaemonPidPath(reSession));
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
	const reTag = path.join(reDir, "wtft-tags", path.basename(reSession) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const reErr = fs.openSync(path.join(reDir, "daemon-stderr.log"), "a");
	const linesForId = () => {
		if (!fs.existsSync(reTag)) return [] as { id?: string; cmd?: string[]; out?: number }[];
		return fs.readFileSync(reTag, "utf8").split("\n").filter(Boolean).flatMap(line => {
			try {
				const obj = JSON.parse(line);
				return obj.id === reId ? [obj] : [];
			} catch { return []; }
		});
	};
	try {
		const child = spawn(process.execPath, [DAEMON_BIN, "--session", reSession], {
			detached: true,
			stdio: ["ignore", "ignore", reErr],
			env: { ...process.env, WTFT_DAEMON_DEBUG: "1" },
		});
		child.unref();
		if (child.pid) cleanupPids.push(child.pid);
		let sawCommand = false;
		for (let i = 0; i < 24 && !sawCommand; i++) {
			await sleep(250);
			sawCommand = linesForId().some(obj => Array.isArray(obj.cmd) && obj.cmd.length > 0 && obj.out === 10);
		}
		assert("fixture: the command-bearing copy is tagged", sawCommand);
		fs.appendFileSync(reSub, withoutCommand(50));
		let sawGrown = false;
		for (let i = 0; i < 24 && !sawGrown; i++) {
			await sleep(250);
			sawGrown = linesForId().some(obj => obj.out === 50);
		}
		const tagged = linesForId();
		assert(
			"a higher re-emit that omits the command keeps the command on that id",
			sawGrown && tagged.every(obj => Array.isArray(obj.cmd) && obj.cmd.length > 0),
		);
	} finally {
		try { fs.closeSync(reErr); } catch { /* already closed */ }
		for (const pid of cleanupPids) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
		for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch { /* gone */ } }
		await sleep(200);
		for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
	}
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

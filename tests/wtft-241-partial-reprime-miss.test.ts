#!/usr/bin/env bun
/**
 * A re-prime that keeps a small cached prefix is a Cache Miss, by the same
 * rule that attributes its cost to Ovrhd; a turn whose context grows by a large
 * tool result is not.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { parseEntryToInteraction } from "../extensions/lib/wtft-parser.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { serializeClassifiedWithOverheadSplit, classifiedInteractionsFromContent } from "../extensions/lib/wtft-daemon-lib.ts";

isolateTmpdir("241-partial-reprime-miss");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const T0 = Date.UTC(2026, 8, 24, 3, 14, 42);

function turn(id: string, inputTokens: number, cacheRead: number, cacheWrite: number) {
	const interaction = parseEntryToInteraction({
		type: "assistant",
		timestamp: new Date(T0).toISOString(),
		message: {
			role: "assistant", id, model: "claude-opus-5-5",
			usage: {
				input_tokens: inputTokens, output_tokens: 300,
				cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
				cache_creation: { ephemeral_1h_input_tokens: cacheWrite, ephemeral_5m_input_tokens: 0 },
			},
			content: [{ type: "text", text: "t" }],
		},
	});
	if (!interaction) throw new Error("fixture turn did not parse");
	return interaction;
}

/** The tag lines for one turn, read back, and whether any carries the miss. */
function missAfterTag(interaction: ReturnType<typeof turn>, prevCtx: number) {
	const lines = classifiedInteractionsFromContent(serializeClassifiedWithOverheadSplit(interaction, prevCtx));
	return { lines, miss: lines.some(l => l.cacheMiss === true), overhead: lines.some(l => l._cat === "overhead") };
}

const PREV_CTX = 2 + 456_145 + 809;

console.log("\nA re-prime with a small cached prefix");
{
	const reprime = turn("msg_reprime", 4, 9_487, 448_641);
	check(reprime.cacheMiss !== true, "fixture: the zero-read rule alone does not flag it (cache read 9,487)");
	const r = missAfterTag(reprime, PREV_CTX);
	check(r.overhead, "fixture: the overhead split classifies it as a recache");
	check(r.miss, "its tag carries the Cache Miss flag");
	check(r.lines.filter(l => l.cacheMiss).length === 1 && r.lines.find(l => l.cacheMiss)?._cat !== "overhead",
		"the flag is on the remainder line only, not on the Ovrhd line");
}

console.log("\nA full miss still counts");
{
	const full = turn("msg_full", 4, 0, 457_000);
	check(missAfterTag(full, PREV_CTX).miss, "cache read 0 is a miss, as before");
}

console.log("\nNot a miss");
{
	check(!missAfterTag(turn("msg_tool", 2, 10_000, 50_000), 10_500).miss,
		"a context that grows by a large tool result (10k read, 50k written) is not a miss");
	check(!missAfterTag(turn("msg_steady", 2, 456_145, 809), PREV_CTX).miss,
		"an ordinary turn reading its cache is not a miss");
	check(!missAfterTag(turn("msg_first", 4, 9_487, 448_641), 0).miss,
		"with no previous context to compare against, a partial prefix is not called a miss");
}

console.log("\nThrough the daemon: the session's own re-prime is flagged, a subagent's is not");
{
	const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
	const { WTFT_TAGGER_VERSION } = await import("../extensions/lib/wtft-tagger-version.ts");
	const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-241-daemon-")));
	const line = (id: string, t: number, cr: number, cw: number) => JSON.stringify({
		type: "message",
		message: {
			role: "assistant", id, model: "claude-opus-5-5", timestamp: new Date(T0 + t).toISOString(),
			usage: { input_tokens: 4, output_tokens: 300, cache_read_input_tokens: cr, cache_creation_input_tokens: cw },
			content: [{ type: "text", text: "t" }],
		},
	}) + "\n";
	// The same shape in both: a warm turn, then 9,487 read / 448,641 written.
	const body = line("warm", 0, 456_145, 809) + line("reprime", 5_400_000, 9_487, 448_641);
	const session = path.join(dir, "session.jsonl");
	fs.writeFileSync(session, JSON.stringify({ type: "session", version: 3, id: "p241", timestamp: new Date(T0).toISOString(), cwd: dir }) + "\n"
		+ body.replace(/"id":"warm"/, '"id":"own-warm"').replace(/"id":"reprime"/, '"id":"own-reprime"'));
	fs.mkdirSync(path.join(dir, "session", "subagents"), { recursive: true });
	fs.writeFileSync(path.join(dir, "session", "subagents", "agent-241.jsonl"),
		body.replace(/"id":"warm"/, '"id":"sub-warm"').replace(/"id":"reprime"/, '"id":"sub-reprime"'));
	fs.mkdirSync(path.join(dir, "wtft-tags"), { recursive: true });
	const tag = path.join(dir, "wtft-tags", `session.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", session], { detached: true, stdio: "ignore" });
	child.unref();
	const lines = () => (fs.existsSync(tag) ? fs.readFileSync(tag, "utf8") : "").split("\n").filter(Boolean).map(l => JSON.parse(l));
	try {
		for (let i = 0; i < 60 && !(lines().some(l => l.id === "own-reprime") && lines().some(l => l.id === "sub-reprime")); i++) await sleep(250);
		const all = lines();
		check(all.some(l => l.id === "own-reprime") && all.some(l => l.id === "sub-reprime"),
			"fixture: the daemon tagged both the session's and the subagent's re-prime turn");
		check(all.some(l => l.id === "own-reprime" && l.miss === 1), "the session's own re-prime carries miss: 1");
		check(!all.some(l => typeof l.id === "string" && l.id.startsWith("sub-") && l.miss === 1),
			"no subagent line carries miss: 1, although the same shape re-primes");
	} finally {
		try { process.kill(child.pid!, "SIGTERM"); } catch { /* gone */ }
		await sleep(200);
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

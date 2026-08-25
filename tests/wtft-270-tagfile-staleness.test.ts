/**
 * @package princess-pi-packages
 * @test wtft-270-tagfile-staleness
 * @description #270's second half — "the tag-file staleness needs its own
 *   answer ... a fix that only corrects live behaviour leaves every
 *   already-written tag file wrong, including the ones a future audit will
 *   read."
 *
 *   MEASURED ANSWER, and it is not the one #270's "Directions" section reaches
 *   for first: no WTFT_TAGGER_VERSION bump is required, because a stale tag file
 *   is already repaired by the NEXT DAEMON START. A fresh daemon process begins
 *   with no memory of any transcript, re-parses every subagent transcript WHOLE,
 *   and appends what it finds; the reader's dedupeClassifiedById
 *   (extensions/lib/wtft-daemon-lib.ts) then collapses the stale low-cost line
 *   against the fresh full-cost line sharing one `message.id`, keeping the max.
 *   Convergence is a property of the READER's collapse, not of the writer having
 *   been careful. #270's own text already names `--restart` as a recovery path;
 *   this is that path, measured.
 *
 *   Measured on the issue's own specimen — session 7c0c2b7e (15 Task subagents,
 *   finished 2026-08-13), starting from its genuine pre-#270 v2.7.1 tag file
 *   (1,132,374 bytes) restored byte-identical before each trial, with every
 *   daemon for that session killed first:
 *
 *     run 1   $79.74   reads the stale tag; the daemon repairs it afterwards
 *     run 2+  $84.59   tag now 1,537,246 bytes — equals `wtft -F` to the cent
 *
 *   IDENTICAL on `main` @ 5fd5570 and on this branch, down to the repaired tag's
 *   byte count. That is the point of this test, and the reason it is a CONTRACT
 *   test rather than a bug-fix regression test: restart-repair is PRE-EXISTING
 *   behaviour that #270 must not break, and #270 put it at real risk. The
 *   rewrite added a per-transcript `writtenLines` hash filter deciding what gets
 *   appended, which could have failed in two opposite directions — suppressing
 *   the repair (treating already-on-disk lines as nothing to write) or
 *   double-counting it (appending a second full copy the reader fails to
 *   collapse). Nothing pinned either direction. This does.
 *
 *   The soundness condition for re-appending, also checked below: every
 *   COST-BEARING tag line must carry a `message.id`. A line without one passes
 *   through dedupeClassifiedById uncollapsed and would double-count on repair.
 *   On the specimen tag, 3,339 of 3,409 rows carried an id, and all 70 without
 *   one were zero-cost `_meta` rows, none of them duplicated.
 *
 *   NOT covered here, because tests/wtft-270-subagent-reparse.test.ts already
 *   covers it: the live path, where ONE daemon stays alive across a subagent's
 *   growth. That is the case #270 actually fixes, and the only case a daemon
 *   restart cannot rescue.
 *
 *   Closer: leave a tag file holding a stale one-shot parse, let the subagent
 *   transcript finish unobserved, start a NEW daemon, and read the tag — the
 *   totals must equal deduplicateInteractions(parseSessionFile(...)) over the
 *   finished transcript, with no `-F` anywhere, and nothing double-counted.
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
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";


// Private pid namespace for this suite (#486). Must precede the first
// getDaemonPidPath() and the first daemon spawn — the daemon keys its lease on
// os.tmpdir() and sweeps every wtft-daemon-*.pid there at startup.
isolateTmpdir("tagfile-staleness");

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");

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

function spawnDaemon(sessionPath: string): number {
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", sessionPath], {
		detached: true, stdio: "ignore",
	});
	child.unref();
	if (child.pid) cleanupPids.push(child.pid);
	return child.pid || 0;
}

/** Stop a daemon and clear its lease, so the next spawn starts genuinely fresh. */
async function stopDaemon(pid: number, sessionPath: string) {
	try { process.kill(pid, "SIGTERM"); } catch {}
	const pidPath = getDaemonPidPath(sessionPath);
	for (let i = 0; i < 20; i++) {
		await sleep(100);
		try { process.kill(pid, 0); } catch { break; }
	}
	try { fs.unlinkSync(pidPath); } catch {}
}

/** One assistant turn, Claude Code schema. Re-emitting the same `id` at higher
 *  usage is the growing-usage shape a live subagent actually writes. */
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

console.log("wtft tag-file staleness repair (#270)");

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-stale-")));

const sessionPath = path.join(dir, "session.jsonl");
fs.writeFileSync(sessionPath, JSON.stringify({
	type: "session", version: 3, id: "parent-270-stale", timestamp: new Date().toISOString(), cwd: dir,
}) + "\n");
const tagsDir = path.join(dir, "wtft-tags");
fs.mkdirSync(tagsDir, { recursive: true });
cleanupPidFiles.push(getDaemonPidPath(sessionPath));

const subagentDir = path.join(dir, "session", "subagents");
fs.mkdirSync(subagentDir, { recursive: true });
const subagentPath = path.join(subagentDir, "agent-stale1.jsonl");

const T0 = Date.now() - 120_000;
const TURN1_ID = "msg_270_stale_turn1";
const TURN2_ID = "msg_270_stale_turn2";

const tagPath = path.join(tagsDir, path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);

try {
	// --- Phase 1: produce a genuinely stale tag file. ---
	// The subagent has written only its first turn, at its FIRST (low) usage.
	// A daemon discovers it, parses it once, persists that, and then dies —
	// which is precisely the state every pre-#270 tag file on disk is in.
	fs.writeFileSync(subagentPath, turnLine(TURN1_ID, T0, 5_000, 200));

	const pid1 = spawnDaemon(sessionPath);
	let sawTurn1 = false;
	for (let i = 0; i < 40 && !sawTurn1; i++) {
		await sleep(250);
		sawTurn1 = readClassifiedTagFile(tagPath).some(int => int.messageId === TURN1_ID);
	}
	assert("a first daemon persists the subagent's first turn into the tag file", sawTurn1);

	await stopDaemon(pid1, sessionPath);

	const staleRows = readClassifiedTagFile(tagPath);
	const staleCost = staleRows.reduce((s, i) => s + i.cost, 0);
	const staleBytes = fs.statSync(tagPath).size;

	// --- Phase 2: the subagent finishes while nothing is watching. ---
	// It re-emits turn 1 at grown usage and adds a second turn. Neither reaches
	// the tag file, because the daemon that would have seen them is gone. This
	// is the persisted undercount the issue is about.
	fs.writeFileSync(
		subagentPath,
		turnLine(TURN1_ID, T0, 5_000, 200) +
		turnLine(TURN1_ID, T0 + 1_000, 5_000, 900) +
		turnLine(TURN2_ID, T0 + 5_000, 8_000, 300),
	);

	// The reference: what `wtft -F` would compute over the finished transcript.
	const reference = deduplicateInteractions(parseSessionFile(subagentPath));
	const referenceCost = reference.reduce((s, i) => s + i.cost, 0);
	const referenceOutput = reference.reduce((s, i) => s + i.outputTokens, 0);

	assert(
		`the stale tag really does undercount the finished transcript ($${staleCost.toFixed(6)} < $${referenceCost.toFixed(6)})`,
		staleCost < referenceCost,
	);

	// --- Phase 3: a NEW daemon runs over the finished transcript. ---
	// No -F, no version bump, no deletion of the stale tag. Fresh process, so
	// its writtenLines is empty and it re-states lines already on disk.
	const pid2 = spawnDaemon(sessionPath);

	let repaired = false;
	for (let i = 0; i < 40 && !repaired; i++) {
		await sleep(250);
		repaired = readClassifiedTagFile(tagPath).some(int => int.messageId === TURN2_ID);
	}
	assert("a later daemon re-reads the finished transcript and adds the missed turn", repaired);

	const healed = readClassifiedTagFile(tagPath).filter(
		int => int.messageId === TURN1_ID || int.messageId === TURN2_ID
	);
	const healedCost = healed.reduce((s, i) => s + i.cost, 0);
	const healedOutput = healed.reduce((s, i) => s + i.outputTokens, 0);

	// The headline: cached == -F, with no -F.
	assert(
		`repaired tag matches a full re-parse, interaction count (${healed.length} === ${reference.length})`,
		healed.length === reference.length,
	);
	assert(
		`repaired tag matches a full re-parse, output tokens (${healedOutput} === ${referenceOutput})`,
		healedOutput === referenceOutput,
	);
	assert(
		`repaired tag matches a full re-parse, cost within $0.000001 (healed=$${healedCost.toFixed(6)} ref=$${referenceCost.toFixed(6)})`,
		Math.abs(healedCost - referenceCost) < 0.000001,
	);

	// Not merely "went up": the collapse must take the max, not the sum. Summing
	// the stale line and the fresh one would also raise the total, and would be
	// the overcount #270's review rounds kept re-introducing.
	assert(
		`turn 1 collapses to ONE interaction, not one per tag line (${healed.filter(i => i.messageId === TURN1_ID).length} === 1)`,
		healed.filter(i => i.messageId === TURN1_ID).length === 1,
	);
	assert(
		`repaired total is not inflated past the full re-parse ($${healedCost.toFixed(6)} <= $${referenceCost.toFixed(6)})`,
		healedCost <= referenceCost + 0.000001,
	);

	// The soundness condition for re-appending: no cost-bearing line may lack an
	// id, or the collapse above cannot reach it.
	const rawRows: Record<string, unknown>[] = [];
	for (const line of fs.readFileSync(tagPath, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const o = JSON.parse(line);
			if (o._hb) continue;
			rawRows.push(o);
		} catch { /* reader skips these too */ }
	}
	const costBearingWithoutId = rawRows.filter(o => {
		const cost = ["in", "out", "cr", "cw"].reduce(
			(s, k) => s + (typeof o[k] === "number" ? (o[k] as number) : 0), 0);
		return cost > 0 && !o.id;
	});
	assert(
		`every cost-bearing tag line carries a message.id, so the collapse can reach it (${costBearingWithoutId.length} === 0)`,
		costBearingWithoutId.length === 0,
	);

	// The tag file was appended to, never rewritten — this is repair-in-place,
	// which is what makes a version bump unnecessary.
	assert(
		`the stale tag was repaired in place by appending, not replaced (${staleBytes} -> ${fs.statSync(tagPath).size})`,
		fs.statSync(tagPath).size > staleBytes,
	);

	await stopDaemon(pid2, sessionPath);
} finally {
	for (const pid of cleanupPids) { try { process.kill(pid, "SIGTERM"); } catch {} }
	for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch {} }
	await sleep(200);
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

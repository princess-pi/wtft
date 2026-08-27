#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-457-unreadable-transcript
 * @description #457 — parseSessionFile's bare catch returned [] on any read
 *   failure (EACCES, EISDIR, ENOMEM, a mid-read I/O error), byte-identical to
 *   a legitimately empty transcript, and syncSubagentTranscript then advanced
 *   its change detector (fileState.size/mtimeMs) as if the file had been read.
 *   If readability was restored without the file also changing size or mtime —
 *   a permissions fix, a remount, a transient FS error clearing — the
 *   transcript was never re-read and everything in it was dropped for the life
 *   of that daemon (#270's own bug class via the error path).
 *
 *   Closer: (a) parseSessionFile throws on read failure while still swallowing
 *   per-line JSON errors, (b) the daemon does not mark an unreadable subagent
 *   transcript processed — the warning fires, nothing lands in the tag file,
 *   and the transcript is picked up in full once readability returns with size
 *   and mtime unchanged — and (c) the nested attribution read is a read too:
 *   an unreadable nested transcript makes the parent parse throw and is never
 *   recorded as attributed, so a retried pass recovers it in full.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import {
	getDaemonPidPath,
	readClassifiedTagFile,
	readTagProvisional,
	parseSessionFile,
	WTFT_TAGGER_VERSION,
} from "../bin/wtft.mjs";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { skip } from "./lib/skips";

// Private pid namespace for this suite (#486). Must precede the first
// getDaemonPidPath() and the first daemon spawn — the daemon keys its lease on
// os.tmpdir() and sweeps every wtft-daemon-*.pid there at startup.
isolateTmpdir("subagent-unreadable");

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const WTFT_LIB = path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs");
const BEAT_MS = 667;

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

// EACCES-based checks need an unprivileged reader: root bypasses file mode
// bits entirely, so chmod 000 still reads fine. Run the checks that depend on
// permission denial only when we actually are unprivileged.
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function currentTagFileName(sessionPath: string): string {
	return path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`;
}

function spawnDaemon(sessionPath: string, env?: Record<string, string>): { pid: number; stderr: string[] } {
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", sessionPath], {
		detached: true, stdio: ["ignore", "ignore", "pipe"],
		env: { ...process.env, ...env },
	});
	const stderr: string[] = [];
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
	// A failed spawn fires 'error' (unhandled, it would crash the suite before
	// the assertions could report it) — record it where the wait loops can see
	// it, and never let a 0 pid reach cleanupPids: process.kill(0, "SIGTERM")
	// would signal THIS suite's process group, not a daemon.
	child.on("error", (err: Error) => stderr.push(`daemon spawn error: ${err.message}\n`));
	child.unref();
	if (child.pid) cleanupPids.push(child.pid);
	return { pid: child.pid || 0, stderr };
}

/**
 * Raw sweep-marker check. readClassifiedTagFile filters `_meta` rows out, so
 * the swept marker is invisible to it — read the tag file raw instead. A
 * missing tag file trivially has no marker.
 */
function rawTagHasSwept(tagPath: string): boolean {
	let content = "";
	try {
		content = fs.readFileSync(tagPath, "utf8");
	} catch {
		return false;
	}
	return content.includes('"_meta"') && content.includes('"swept"');
}

/** One assistant turn, Claude Code schema, distinct message.id per turn. */
function turnLine(id: string, tsMs: number, inputTokens: number, outputTokens: number): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso, // entry-level ts: what discoverClaudeSubAgentSessionFiles matches on
		message: {
			role: "assistant",
			id,
			model: "claude-sonnet-4-6",
			timestamp: iso,
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

/** An assistant turn whose bash tool call spawns `claude -p` in `cwd` — the
 *  shape attributeClaudeSubAgentCosts looks for (#138). */
function claudeBashTurnLine(id: string, tsMs: number, inputTokens: number, outputTokens: number, cwd: string): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso,
		message: {
			role: "assistant",
			id,
			model: "claude-sonnet-4-6",
			timestamp: iso,
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			content: [{
				type: "toolCall",
				name: "bash",
				arguments: { command: `cd ${cwd} && claude -p "do the thing"` },
			}],
		},
	}) + "\n";
}

console.log("wtft unreadable-transcript handling (#457)");

// ---
// PART A — parseSessionFile read failures are loud, per-line JSON errors stay
// swallowed, and a genuinely empty file still reads as empty.
// ---
const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-457-")));
fixtureDirs.push(dir);

const readablePath = path.join(dir, "readable.jsonl");
fs.writeFileSync(readablePath, turnLine("msg_a1", Date.now() - 60_000, 1000, 100));

{
	// 1. Missing file: the old bare catch returned []; the fix throws, so the
	//    caller can tell "nothing in it" from "could not read it".
	let threw = false;
	try { parseSessionFile(path.join(dir, "never-exists.jsonl")); } catch { threw = true; }
	assert("missing transcript throws rather than returning []", threw);

	// 2. Directory path: EISDIR is a read failure, not an empty session.
	let threwDir = false;
	try { parseSessionFile(dir); } catch { threwDir = true; }
	assert("directory path throws rather than returning []", threwDir);

	// 3. Permission-denied read (unprivileged hosts only).
	if (isRoot) {
		skip("root bypasses file mode bits — chmod-000 read checks cannot run");
	} else {
		fs.chmodSync(readablePath, 0o000);
		let threwEacces = false;
		try { parseSessionFile(readablePath); } catch { threwEacces = true; }
		assert("chmod-000 transcript throws rather than returning []", threwEacces);
		fs.chmodSync(readablePath, 0o644);
	}

	// 4. Per-line JSON errors are STILL swallowed — a mid-write garbage line
	//    must not poison the whole file, that contract is unchanged.
	const mixedPath = path.join(dir, "mixed.jsonl");
	fs.writeFileSync(mixedPath, "this is not json\n" + turnLine("msg_a2", Date.now() - 50_000, 500, 50));
	const mixed = parseSessionFile(mixedPath);
	assert("garbage line is skipped, valid line still parsed", mixed.length === 1 && mixed[0].messageId === "msg_a2");

	// 5. A genuinely empty transcript still reads as empty — no throw, zero
	//    interactions. This is the byte-identity the old catch was faking.
	const emptyPath = path.join(dir, "empty.jsonl");
	fs.writeFileSync(emptyPath, "");
	const empty = parseSessionFile(emptyPath);
	assert("genuinely empty transcript reads as [] without throwing", empty.length === 0);
}

// ---
// PART B — the daemon does not mark an unreadable subagent transcript
// processed, and recovers when readability returns with size/mtime unchanged.
// ---
try {
	if (isRoot) {
		skip("root bypasses file mode bits — the daemon unreadable-transcript scenario cannot run");
	} else {
		const daemonDir = path.join(dir, "daemon");
		fs.mkdirSync(daemonDir, { recursive: true });
		const sessionPath = path.join(daemonDir, "session.jsonl");
		fs.writeFileSync(sessionPath, JSON.stringify({
			type: "session", version: 3, id: "parent-457", timestamp: new Date().toISOString(), cwd: daemonDir,
		}) + "\n");
		const tagsDir = path.join(daemonDir, "wtft-tags");
		fs.mkdirSync(tagsDir, { recursive: true });
		cleanupPidFiles.push(getDaemonPidPath(sessionPath));

		// Claude Code convention: <sessionDir>/<sessionBase>/subagents/agent-*.jsonl
		const subagentDir = path.join(daemonDir, "session", "subagents");
		fs.mkdirSync(subagentDir, { recursive: true });
		const subagentPath = path.join(subagentDir, "agent-unreadable.jsonl");

		const T0 = Date.now() - 60_000;
		const TURN_ID = "msg_457_turn1";

		// The transcript exists with content, but is UNREADABLE from the start —
		// "discovered while still running", EACCES on the read.
		fs.writeFileSync(subagentPath, turnLine(TURN_ID, T0, 5000, 200));
		const statBefore = fs.statSync(subagentPath);
		fs.chmodSync(subagentPath, 0o000);

		const tagPath = path.join(tagsDir, currentTagFileName(sessionPath));

		try {
			const daemon = spawnDaemon(sessionPath);

			// Wait for the daemon to discover the subagent AND fail its read: the
			// #457 warning is the proof the read was attempted (and refused).
			// The daemon's failure surface is prose-only today (#436 owns the
			// transport), so the assertion anchors on the two stable pieces: the
			// parse-failure class phrase (deliberately load-bearing — a reword
			// of it must update this assertion) and the session id that says
			// WHICH transcript failed.
			let warned = false;
			for (let i = 0; i < 30 && !warned; i++) {
				await sleep(250);
				const stderr = daemon.stderr.join("");
				warned = stderr.includes("could not be read or parsed") && stderr.includes("agent-unreadable");
			}
			assert("daemon warns that the unreadable transcript could not be read", warned);

			// The failure must not have been recorded as a completed read: nothing
			// from the transcript lands in the tag file while it is unreadable.
			let sawTurnWhileUnreadable = false;
			for (let i = 0; i < 8; i++) {
				await sleep(250);
				sawTurnWhileUnreadable = readClassifiedTagFile(tagPath).some(int => int.messageId === TURN_ID);
			}
			assert("no content from the unreadable transcript reaches the tag file", !sawTurnWhileUnreadable);

			// #443: the sweep marker must be WITHHELD too — pollHadFailure is set on
			// every poll while the read fails, so the tag must not claim swept.
			assert("swept marker is withheld while the transcript is unreadable", !rawTagHasSwept(tagPath));

			// Still polling, not crashed. pid > 0 guard: on a failed spawn
			// daemon.pid is 0, and kill(0, 0) would signal THIS suite's own
			// process group (which exists) — so treat 0 as not alive, or the
			// assert below passes misleadingly on a broken spawn.
			let stillAlive = daemon.pid > 0;
			if (stillAlive) { try { process.kill(daemon.pid, 0); } catch { stillAlive = false; } }
			assert("daemon keeps polling after the read failure", stillAlive);

			// Readability returns WITHOUT the file changing size or mtime — chmod
			// touches only ctime — the exact scenario the old code dropped forever.
			fs.chmodSync(subagentPath, 0o644);
			const statAfter = fs.statSync(subagentPath);
			assert(
				"permission restore leaves size and mtime unchanged (the #457 scenario)",
				statAfter.size === statBefore.size && statAfter.mtimeMs === statBefore.mtimeMs
			);

			// The change detector was never advanced, so the next poll re-reads the
			// file and the turn lands in the tag file in full.
			let sawTurnAfterRestore = false;
			for (let i = 0; i < 20 && !sawTurnAfterRestore; i++) {
				await sleep(250);
				sawTurnAfterRestore = readClassifiedTagFile(tagPath).some(int => int.messageId === TURN_ID);
			}
			assert("transcript is re-read after readability returns and its turn is counted", sawTurnAfterRestore);

			// Once the recovered content has landed and the failure is gone, the
			// next clean sweep re-stamps the marker (tagGrewSinceMarker && no
			// pollHadFailure) — the tag graduates from provisional to swept.
			let sawSwept = false;
			for (let i = 0; i < 20 && !sawSwept; i++) {
				await sleep(250);
				sawSwept = rawTagHasSwept(tagPath);
			}
			assert("tag is swept only after the recovered transcript is counted", sawSwept);

			// Convergence with a direct parse of the now-readable file.
			const tagInteractions = readClassifiedTagFile(tagPath).filter(int => int.messageId === TURN_ID);
			const reference = parseSessionFile(subagentPath);
			const referenceCost = reference.reduce((s, i) => s + i.cost, 0);
			const tagCost = tagInteractions.reduce((s, i) => s + i.cost, 0);
			assert(
				`tag-file cost for the recovered turn matches a direct parse ($${tagCost.toFixed(6)} === $${referenceCost.toFixed(6)})`,
				tagInteractions.length === reference.length && Math.abs(tagCost - referenceCost) < 0.000001
			);
		} finally {
			// pid > 0 guard: kill(0, ...) would signal this suite's own process
			// group, so a spawn failure must never put a 0 in the list.
			for (const pid of cleanupPids) { if (pid > 0) { try { process.kill(pid, "SIGTERM"); } catch {} } }
			for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch {} }
			await sleep(200);
			for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
		}
	}
} finally {
	// Cleanup is unconditional: the root skip above takes the other branch,
	// and the fixture must not leak there either. Re-runs are no-ops.
	for (const pid of cleanupPids) { if (pid > 0) { try { process.kill(pid, "SIGTERM"); } catch {} } }
	for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch {} }
	await sleep(200);
	for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

// ---
// PART B2 — the DISCOVERY boundary in the live daemon: a claude -p candidate
// that is unreadable at discovery (EACCES, the COMMON #457 case) must warn,
// withhold the swept marker, and recover when readability returns — and the
// parent row must still land that poll (flushPending runs before
// scanForSubAgents, so the discovery throw does NOT hold the whole parent
// transcript hostage; the blast radius is the pending claude command's
// registration, which retries).
// ---
try {
	if (isRoot) {
		skip("root bypasses file mode bits — the daemon discovery-unreadable scenario cannot run");
	} else {
		// Part B's cleanup removed the Part A fixture dir, so B2 uses fresh
		// fixture dirs of its own. The HOME override points the daemon's
		// ~/.claude/projects/<slug>/ discovery at the fixture.
		const b2Dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-457b2-")));
		fixtureDirs.push(b2Dir);
		const b2Home = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-457b2-home-")));
		fixtureDirs.push(b2Home);

		const sessionPath = path.join(b2Dir, "session.jsonl");
		fs.writeFileSync(sessionPath, JSON.stringify({
			type: "session", version: 3, id: "parent-457b2", timestamp: new Date().toISOString(), cwd: b2Dir,
		}) + "\n");
		const tagsDir = path.join(b2Dir, "wtft-tags");
		fs.mkdirSync(tagsDir, { recursive: true });
		cleanupPidFiles.push(getDaemonPidPath(sessionPath));

		// The cwd of the parent's `cd <cwd> && claude -p` command; discovery
		// scans $HOME/.claude/projects/<slug-of-cwd>/.
		const slug = b2Dir.replace(/\//g, "-");
		const projectDir = path.join(b2Home, ".claude", "projects", slug);
		fs.mkdirSync(projectDir, { recursive: true });

		const T0 = Date.now() - 60_000;
		const PARENT_ID = "msg_457_b2_parent";
		const CANDIDATE_ID = "msg_457_b2";
		fs.appendFileSync(sessionPath, claudeBashTurnLine(PARENT_ID, T0, 1000, 50, b2Dir));
		const candidatePath = path.join(projectDir, "candidate.jsonl");
		// Timestamp inside the ±15s discovery window of the parent turn — the
		// match discovery would have made if the read had succeeded.
		fs.writeFileSync(candidatePath, turnLine(CANDIDATE_ID, T0, 3000, 150));
		fs.chmodSync(candidatePath, 0o000);

		const tagPath = path.join(tagsDir, currentTagFileName(sessionPath));

		try {
			const daemon = spawnDaemon(sessionPath, { HOME: b2Home });

			// The parser's discovery warning names the unreadable CANDIDATE
			// (round 4), never the healthy outer transcript.
			let warned = false;
			for (let i = 0; i < 30 && !warned; i++) {
				await sleep(250);
				const stderr = daemon.stderr.join("");
				warned = stderr.includes("could not be read at discovery") && stderr.includes("candidate.jsonl");
			}
			assert("daemon warns that the unreadable discovery candidate could not be read", warned);

			// Daemon-half blast-radius pin: the parent row STILL lands while
			// discovery fails — flushPending runs before scanForSubAgents, so
			// the throw only stalls the claude command's registration.
			let sawParent = false;
			for (let i = 0; i < 12 && !sawParent; i++) {
				await sleep(250);
				sawParent = readClassifiedTagFile(tagPath).some(int => int.messageId === PARENT_ID);
			}
			assert("parent row still lands while the discovery candidate is unreadable", sawParent);

			// No nested rows and no swept marker while the candidate is unreadable.
			let sawCandidate = false;
			for (let i = 0; i < 8; i++) {
				await sleep(250);
				sawCandidate = readClassifiedTagFile(tagPath).some(int => int.messageId === CANDIDATE_ID);
			}
			assert("no content from the unreadable candidate reaches the tag file", !sawCandidate);
			assert("swept marker is withheld while the discovery candidate is unreadable", !rawTagHasSwept(tagPath));

			// Recovery: readability returns, the command is still pending, so
			// the next poll's discovery registers and syncs the candidate.
			fs.chmodSync(candidatePath, 0o644);
			let sawCandidateAfterRestore = false;
			for (let i = 0; i < 20 && !sawCandidateAfterRestore; i++) {
				await sleep(250);
				sawCandidateAfterRestore = readClassifiedTagFile(tagPath).some(int => int.messageId === CANDIDATE_ID);
			}
			assert("candidate is registered and counted once readability returns", sawCandidateAfterRestore);

			let sawSwept = false;
			for (let i = 0; i < 20 && !sawSwept; i++) {
				await sleep(250);
				sawSwept = rawTagHasSwept(tagPath);
			}
			assert("tag is swept only after the recovered candidate is counted", sawSwept);

			// Convergence with a direct parse of the now-readable candidate.
			const tagInteractions = readClassifiedTagFile(tagPath).filter(int => int.messageId === CANDIDATE_ID);
			const reference = parseSessionFile(candidatePath);
			const referenceCost = reference.reduce((s, i) => s + i.cost, 0);
			const tagCost = tagInteractions.reduce((s, i) => s + i.cost, 0);
			assert(
				`tag-file cost for the recovered candidate matches a direct parse ($${tagCost.toFixed(6)} === $${referenceCost.toFixed(6)})`,
				tagInteractions.length === reference.length && Math.abs(tagCost - referenceCost) < 0.000001
			);
		} finally {
			for (const pid of cleanupPids) { if (pid > 0) { try { process.kill(pid, "SIGTERM"); } catch {} } }
			for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch {} }
			await sleep(200);
			for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
		}
	}
} finally {
	for (const pid of cleanupPids) { if (pid > 0) { try { process.kill(pid, "SIGTERM"); } catch {} } }
	for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch {} }
	await sleep(200);
	for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

// ---
// PART B3 — the NESTED unreadable subagents dir in the live daemon (round 5,
// High fix): the recursion in walkSubagentDir used to sit inside the per-entry
// stat try, so a nested directory's readdirSync throw was swallowed as a stat
// failure — the walk returned a partial file list normally, discovery
// succeeded, scanForSubAgents never saw a failure, pollHadFailure stayed false,
// and the swept marker stamped over the missing subtree. The fixture is the
// walk's own documented nested layout:
// <session>/subagents/agent-<hash>/subagents/agent-*.jsonl, with the INNER
// subagents dir chmod 000. Exactly ONE warning must fire (the innermost frame
// warns; the outer frames rethrow raw without re-warning), the parent row must
// still land, the marker must withhold, and recovery must come back with the
// nested cost counted.
// ---
try {
	if (isRoot) {
		skip("root bypasses file mode bits — the daemon nested-dir-unreadable scenario cannot run");
	} else {
		// Part B2's cleanup removed its fixture dirs, so B3 uses fresh ones.
		// Pattern 1 only (no claude -p commands), so no HOME override needed.
		const b3Dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-457b3-")));
		fixtureDirs.push(b3Dir);

		const sessionPath = path.join(b3Dir, "session.jsonl");
		fs.writeFileSync(sessionPath, JSON.stringify({
			type: "session", version: 3, id: "parent-457b3", timestamp: new Date().toISOString(), cwd: b3Dir,
		}) + "\n");
		const tagsDir = path.join(b3Dir, "wtft-tags");
		fs.mkdirSync(tagsDir, { recursive: true });
		cleanupPidFiles.push(getDaemonPidPath(sessionPath));

		// walkSubagentDir's nested layout: <session>/subagents/agent-<hash>/subagents/.
		const nestedDir = path.join(b3Dir, "session", "subagents", "agent-457b3", "subagents");
		fs.mkdirSync(nestedDir, { recursive: true });
		const T0 = Date.now() - 60_000;
		const PARENT_ID = "msg_457_b3_parent";
		const NESTED_ID = "msg_457_b3_nested";
		fs.appendFileSync(sessionPath, turnLine(PARENT_ID, T0, 1000, 50));
		const nestedPath = path.join(nestedDir, "agent-nested.jsonl");
		fs.writeFileSync(nestedPath, turnLine(NESTED_ID, T0, 3000, 150));
		// The inner subagents dir becomes unreadable AFTER the file is written —
		// a nested readdirSync EACCES, the class the round-4 code swallowed.
		fs.chmodSync(nestedDir, 0o000);

		const tagPath = path.join(tagsDir, currentTagFileName(sessionPath));

		try {
			const daemon = spawnDaemon(sessionPath);

			// The warning names the NESTED dir — the innermost failing frame —
			// and fires exactly once (the latch, and the outer frames rethrow
			// raw instead of warning again).
			let warned = false;
			for (let i = 0; i < 30 && !warned; i++) {
				await sleep(250);
				const stderr = daemon.stderr.join("");
				warned = stderr.includes("a subagent transcripts directory could not be read") && stderr.includes(nestedDir);
			}
			assert("daemon warns that the nested unreadable subagents dir could not be read", warned);
			assert("the nested-dir warning names the innermost failing dir and fires once",
				(daemon.stderr.join("").match(/a subagent transcripts directory could not be read/g) ?? []).length === 1);

			// Parent row still lands (flushPending runs before scanForSubAgents).
			let sawParent = false;
			for (let i = 0; i < 12 && !sawParent; i++) {
				await sleep(250);
				sawParent = readClassifiedTagFile(tagPath).some(int => int.messageId === PARENT_ID);
			}
			assert("parent row still lands while the nested subagents dir is unreadable", sawParent);

			// No nested rows and no swept marker while the dir is unreadable.
			let sawNested = false;
			for (let i = 0; i < 8; i++) {
				await sleep(250);
				sawNested = readClassifiedTagFile(tagPath).some(int => int.messageId === NESTED_ID);
			}
			assert("no content from under the unreadable nested dir reaches the tag file", !sawNested);
			assert("swept marker is withheld while the nested subagents dir is unreadable", !rawTagHasSwept(tagPath));

			// Recovery: readability returns, discovery succeeds again, and the
			// nested transcript is synced with its cost counted.
			fs.chmodSync(nestedDir, 0o755);
			let sawNestedAfterRestore = false;
			for (let i = 0; i < 20 && !sawNestedAfterRestore; i++) {
				await sleep(250);
				sawNestedAfterRestore = readClassifiedTagFile(tagPath).some(int => int.messageId === NESTED_ID);
			}
			assert("nested transcript is registered and counted once readability returns", sawNestedAfterRestore);

			let sawSwept = false;
			for (let i = 0; i < 20 && !sawSwept; i++) {
				await sleep(250);
				sawSwept = rawTagHasSwept(tagPath);
			}
			assert("tag is swept only after the recovered nested transcript is counted", sawSwept);

			// Convergence with a direct parse of the now-readable transcript.
			const tagInteractions = readClassifiedTagFile(tagPath).filter(int => int.messageId === NESTED_ID);
			const reference = parseSessionFile(nestedPath);
			const referenceCost = reference.reduce((s, i) => s + i.cost, 0);
			const tagCost = tagInteractions.reduce((s, i) => s + i.cost, 0);
			assert(
				`tag-file cost for the recovered nested transcript matches a direct parse ($${tagCost.toFixed(6)} === $${referenceCost.toFixed(6)})`,
				tagInteractions.length === reference.length && Math.abs(tagCost - referenceCost) < 0.000001
			);
		} finally {
			for (const pid of cleanupPids) { if (pid > 0) { try { process.kill(pid, "SIGTERM"); } catch {} } }
			for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch {} }
			await sleep(200);
			for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
		}
	}
} finally {
	for (const pid of cleanupPids) { if (pid > 0) { try { process.kill(pid, "SIGTERM"); } catch {} } }
	for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch {} }
	await sleep(200);
	for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

// ---
// PART C — the nested attribution read is a read too: discovery's read (a
// whole-file read whose first 10 lines are scanned) succeeds, the nested parse
// read fails (the discovery→parse race — a file that became unreadable, or
// vanished, between the two reads), and that failure must be loud AND never
// recorded as attributed, so a retried pass recovers the nested cost in full.
// Round 4 added the discovery boundary itself; round 5 reshaped it: an
// unreadable candidate is warned once per file per process (latched) and
// REPORTED in the discovery result instead of thrown, so a statically
// unreadable nested transcript reaches the same loud path — the attribution
// pass throws on the report — instead of silently skipping with the swept
// marker stamped. The readable in-window matches are returned alongside the
// report (partial progress, round 5), and the DIR-level failure still throws.
// ---
{
	// Part B's cleanup above removed the Part A fixture dir, so Part C uses
	// fresh fixture dirs of its own.
	const partCDir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-457c-")));
	fixtureDirs.push(partCDir);
	const tempHomeC = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-457c-home-")));
	fixtureDirs.push(tempHomeC);

	const nestedCwd = path.join(partCDir, "nested-project");
	fs.mkdirSync(nestedCwd, { recursive: true });
	const slug = nestedCwd.replace(/\//g, "-");
	const projectDir = path.join(tempHomeC, ".claude", "projects", slug);
	fs.mkdirSync(projectDir, { recursive: true });

	const TC0 = Date.now() - 60_000;
	const nestedPath = path.join(projectDir, "nested-session-457.jsonl");
	fs.writeFileSync(nestedPath, turnLine("msg_457_nested_inner", TC0 + 2_000, 1000, 100));
	// Round 4: the discovery-warning latch is per FILE per process, so the
	// discovery phases need candidate files whose warnings have not yet fired —
	// nestedPath's "or parsed" warning (Phase 4) suppresses its later "at
	// discovery" warning. secondPath carries the discovery warning-names pin;
	// cPath (unnamed in assertions) stands between the two so the latch test
	// still has an unlatched file to observe the FIRST call warning about.
	// Both timestamps sit OUTSIDE the ±15s discovery window: the readable
	// passes (Phases 1-3) must not attribute them, while the failing passes
	// (Phases 5-6) hit them by read failure before any timestamp scan.
	const secondPath = path.join(projectDir, "nested-session-457b.jsonl");
	fs.writeFileSync(secondPath, turnLine("msg_457_nested_b", TC0 + 60_000, 800, 80));
	const cPath = path.join(projectDir, "nested-session-457c.jsonl");
	fs.writeFileSync(cPath, turnLine("msg_457_nested_c", TC0 + 60_000, 600, 60));
	const parentPath = path.join(partCDir, "parent-with-claude-bash.jsonl");
	fs.writeFileSync(parentPath, claudeBashTurnLine("msg_457_parent", TC0, 2000, 100, nestedCwd));

	// Pi-pattern fixtures (round 6): discoverSubagentSessionFiles's Pattern 2
	// scans <sessionDir> for .jsonl siblings whose header declares
	// parentSession. The good sibling declares it (must be discovered), the
	// bad-read sibling declares it but fails its discovery READ under
	// failPiSibling (warn once + report, never a throw — the round-5 contract
	// the claude half established, now applied to this half), and the bad-json
	// sibling holds garbage (header cannot parse, so it can never declare
	// parentSession and is skipped silently — the mirror of the claude half's
	// per-line JSON swallow).
	const piDir = path.join(partCDir, "pi-sessions-457");
	fs.mkdirSync(piDir, { recursive: true });
	const piParentPath = path.join(piDir, "parent-457pi.jsonl");
	fs.writeFileSync(piParentPath, JSON.stringify({ type: "session", id: "parent-457pi" }) + "\n" + turnLine("msg_457_pi_parent", TC0 + 90_000, 500, 50));
	const piSiblingGoodPath = path.join(piDir, "sibling-good-457.jsonl");
	fs.writeFileSync(piSiblingGoodPath, JSON.stringify({ type: "session", id: "sibling-good-457", parentSession: "parent-457pi" }) + "\n" + turnLine("msg_457_sibling_good", TC0 + 90_000, 300, 30));
	const piSiblingBadReadPath = path.join(piDir, "sibling-bad-read-457.jsonl");
	fs.writeFileSync(piSiblingBadReadPath, JSON.stringify({ type: "session", id: "sibling-bad-read-457", parentSession: "parent-457pi" }) + "\n" + turnLine("msg_457_sibling_bad_read", TC0 + 90_000, 300, 30));
	const piSiblingBadJsonPath = path.join(piDir, "sibling-bad-json-457.jsonl");
	fs.writeFileSync(piSiblingBadJsonPath, "this is not json\n");
	const piBaseDir = path.join(piDir, "parent-457pi", "subagents");

	// Round 7 fixtures — a claude-pattern session with three walkable
	// entries: discovery must keep walking past a stat-failing entry
	// (Phase 13) and must report a main-session header READ failure
	// (Phase 14).
	const walkDir = path.join(partCDir, "walk-parent-457");
	fs.mkdirSync(path.join(walkDir, "subagents"), { recursive: true });
	const walkParentPath = path.join(partCDir, "walk-parent-457.jsonl");
	fs.writeFileSync(walkParentPath, JSON.stringify({ type: "session", id: "walk-parent-457" }) + "\n" + turnLine("msg_457_walk_parent", TC0 + 120_000, 100, 10));
	const walkGoodPath = path.join(walkDir, "subagents", "agent-good-457.jsonl");
	fs.writeFileSync(walkGoodPath, turnLine("msg_457_walk_good", TC0 + 120_000, 200, 20));
	const walkBadStatPath = path.join(walkDir, "subagents", "agent-badstat-457.jsonl");
	fs.writeFileSync(walkBadStatPath, turnLine("msg_457_walk_badstat", TC0 + 120_000, 200, 20));
	const walkOtherPath = path.join(walkDir, "subagents", "agent-other-457.jsonl");
	fs.writeFileSync(walkOtherPath, turnLine("msg_457_walk_other", TC0 + 120_000, 200, 20));

	// The nested read's failure modes cannot be exercised by chmod:
	// discoverClaudeSubAgentSessionFiles reads each candidate file IN FULL for
	// its head scan, so a statically unreadable nested transcript used to be
	// silently skipped at discovery and never reached the nested parse in
	// either code. The only path to it was the race — readable at discovery,
	// unreadable at parse — which is deterministic only with an in-process fs
	// patch. Round 4 changed the discovery boundary itself; round 5 reshaped
	// it: an unreadable candidate now warns (once per file per process,
	// latched) and REPORTS in the result (Phases 5-7 — the parse-throw pin,
	// the warning latch, and the partial-progress contract), while an
	// unreadable project DIR still throws (Phase 8, via the readdirSync
	// patch). Bun snapshots the node:fs ESM namespace at the importing
	// module's evaluation, so the child patches readFileSync AND readdirSync
	// BEFORE importing the wtft library, and the patches then fail
	// (a) only the SECOND read of the nested path (the parse, after discovery's
	// head scan succeeded — the race, Phases 1-3), (b) every read (the CLI/TUI
	// skip, Phase 4), (c) only the discovery candidate reads (Phases 5-6), or
	// (d) only one candidate (the partial-progress report, Phase 7), or the
	// project dir itself (the dir-level throw, Phase 8). No chmod, no file
	// mode bits — this part runs as root too.
	const childScript = path.join(partCDir, "nested-race-457.mjs");
	fs.writeFileSync(childScript, `
		import { createRequire } from "node:module";
		const req = createRequire(import.meta.url);
		const cjs = req("node:fs");
		const ppath = req("node:path");
		const originalRead = cjs.readFileSync;
		const originalReaddir = cjs.readdirSync;
		const originalStat = cjs.statSync;
		const [parentPath, nestedPath, secondPath, cPath, nestedCwd, TC0, libPath, projectDir, piParentPath, piSiblingGoodPath, piSiblingBadReadPath, piSiblingBadJsonPath, piBaseDir, walkParentPath, walkGoodPath, walkOtherPath, walkBadStatPath] = process.argv.slice(2);

		let failNested = true;           // fail only nestedPath's SECOND read (the race)
		let failAll = false;             // fail every read (the CLI/TUI skip)
		let failDiscovery = false;       // fail only the discovery candidate reads
		let failDiscoveryPartial = false;// fail only secondPath (the partial report, round 5)
		let failDiscoveryDir = false;    // fail readdirSync on the project dir (the dir-level throw)
		let failPiSibling = false;       // fail only piSiblingBadReadPath's discovery read (round 6)
		let failStatProjectDir = false;  // fail statSync on the claude projects dir (round 6)
		let failStatPiBase = false;      // fail statSync on the Pi <session>/<base>/subagents dir (round 6)
		let failStatWalkEntry = false;   // fail statSync on one walk entry (the per-entry report, round 7)
		let failMainHeaderRead = false;  // fail readFileSync on the session path itself (round 7)
		let nestedReadCount = 0;
		const candidates = new Set([nestedPath, secondPath, cPath]);
		const makeEacces = (sp) => {
			const err = new Error("EACCES: permission denied, open '" + sp + "'");
			err.code = "EACCES";
			return err;
		};
		const fail = (sp) => {
			if (failAll) return true;
			if (failDiscovery && candidates.has(sp)) return true;
			if (failDiscoveryPartial && sp === secondPath) return true;
			if (sp === nestedPath && failNested && ++nestedReadCount > 1) return true;
			if (failPiSibling && sp === piSiblingBadReadPath) return true;
			if (failMainHeaderRead && sp === walkParentPath) return true;
			return false;
		};
		cjs.readFileSync = function (p, ...rest) {
			const sp = String(p);
			if (fail(sp)) throw makeEacces(sp);
			return originalRead.call(cjs, p, ...rest);
		};
		cjs.readdirSync = function (p, ...rest) {
			const sp = String(p);
			if (failDiscoveryDir && sp === projectDir) throw makeEacces(sp);
			return originalReaddir.call(cjs, p, ...rest);
		};
		cjs.statSync = function (p, ...rest) {
			const sp = String(p);
			// Round 6: statSync is now the existsSync replacement gate on both
			// discovery halves — ENOENT is the absent case (silent), any other
			// error is a read failure (warn once + throw). These two flags pin
			// the throw halves; the warning for projectDir is already latched
			// by Phase 8's readdirSync failure on the same dir, so Phase 11 can
			// only assert the throw.
			if (failStatProjectDir && sp === projectDir) throw makeEacces(sp);
			if (failStatPiBase && sp === piBaseDir) throw makeEacces(sp);
			if (failStatWalkEntry && sp === walkBadStatPath) throw makeEacces(sp);
			return originalStat.call(cjs, p, ...rest);
		};

		// Patch BEFORE the import: wtft.mjs's node:fs namespace snapshot is
		// taken when it evaluates, so it sees the patched readFileSync.
		const lib = await import(libPath);

		// The parent transcript parsed WITHOUT attribution — parseSessionFile
		// attributes internally, so build the raw interactions ourselves, the
		// array a retried attribution pass will run over.
		const interactions = [];
		for (const line of originalRead.call(cjs, parentPath, "utf8").split("\\n")) {
			if (line.trim() === "") continue;
			try { interactions.push(lib.parseEntryToInteraction(JSON.parse(line))); } catch {}
		}

		// Phase 1 — the production path: parsing the parent transcript reaches
		// the nested read. #457: the nested read is a read, so the parent parse
		// throws rather than attributing a silent zero.
		nestedReadCount = 0;
		let firstThrew = false;
		try { lib.parseSessionFile(parentPath); } catch { firstThrew = true; }

		// Phase 2 — a direct attribution pass over the same interactions is
		// loud too.
		nestedReadCount = 0;
		let firstPassThrew = false;
		try { lib.attributeClaudeSubAgentCosts(interactions); } catch { firstPassThrew = true; }

		// Phase 3 — readability returns; the retried pass succeeds and recovers
		// the nested cost in full. (Old code: the failed pass had already
		// stamped claudeSubAgentSessionIds, so this pass skips the interaction
		// and the nested cost is lost forever.)
		failNested = false;
		let secondPassThrew = false;
		try { lib.attributeClaudeSubAgentCosts(interactions); } catch { secondPassThrew = true; }
		const cost = interactions.reduce((s, i) => s + i.cost, 0);

		// Capture stderr from here on — the round-4 warnings are the subject of
		// Phases 4-6.
		let capturedStderr = "";
		const origWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = (s) => { capturedStderr += s; return origWrite(s); };

		// Phase 4 — the CLI/TUI path (loadSubagentInteractions) is loud too:
		// a nested parse throw drops the WHOLE file's cost there, so the skip
		// must name itself on stderr, not vanish silently (round 3 contract
		// finding). failAll makes even the first read fail, so the skip fires
		// without any discovery pairing. Latches nestedPath with "or parsed".
		failAll = true;
		const skipped = lib.loadSubagentInteractions([nestedPath]).length;

		// Phase 5 — the discovery read is a read (round 4, M2): an unreadable
		// candidate must not be silently skipped. failDiscovery fails only the
		// candidate reads, so parsing the parent transcript reaches the
		// discovery boundary and must THROW (it was silent before round 4), and
		// the discovery warning must name the candidate — nestedPath is already
		// latched by Phase 4, so secondPath carries the naming pin.
		failAll = false;
		failDiscovery = true;
		let discoveryPhaseThrew = false;
		try { lib.parseSessionFile(parentPath); } catch { discoveryPhaseThrew = true; }

		// Phase 6 — the warning is latched per file per process: a second
		// discovery pass over the same unreadable candidates adds zero new
		// warnings (the daemon re-polls, the TUI re-reads on every widget
		// refresh — an unlatched warning is its own noise floor). Since round
		// 5 the per-file failure no longer THROWS: it is reported in the
		// result, and every call reports it — the latch silences the WARNING,
		// never the report.
		const atDiscovery = () => capturedStderr.split("could not be read at discovery").length - 1;
		const warnedBefore = atDiscovery();
		let discoveryReported1 = false;
		let discoveryThrew1 = false;
		try {
			const r6 = lib.discoverClaudeSubAgentSessionFiles(nestedCwd, Number(TC0));
			discoveryReported1 = r6.unreadable !== null;
		} catch { discoveryThrew1 = true; }
		const warnedAfterFirst = atDiscovery();
		let discoveryReported2 = false;
		let discoveryThrew2 = false;
		try {
			const r6b = lib.discoverClaudeSubAgentSessionFiles(nestedCwd, Number(TC0));
			discoveryReported2 = r6b.unreadable !== null;
		} catch { discoveryThrew2 = true; }
		const warnedAfterSecond = atDiscovery();

		// Phase 7 — round 5 partial progress: with only secondPath unreadable,
		// discovery returns the readable in-window match (nestedPath) alongside
		// the report instead of discarding it, and the parent parse STILL
		// throws via the attribution pass (this transcript's own command must
		// not report a silently incomplete cost).
		failDiscovery = false;
		failDiscoveryPartial = true;
		let partialKeptMatch = false;
		let partialReportedUnreadable = false;
		let partialParseThrew = false;
		try {
			const r7 = lib.discoverClaudeSubAgentSessionFiles(nestedCwd, Number(TC0));
			partialKeptMatch = r7.files.length === 1 && r7.files[0] === nestedPath;
			partialReportedUnreadable = r7.unreadable !== null && String(r7.unreadable.message).includes(secondPath);
		} catch {}
		try { lib.parseSessionFile(parentPath); } catch { partialParseThrew = true; }

		// Phase 8 — the DIR-level failure still throws: an unreadable
		// ~/.claude/projects/<slug>/ itself (readdirSync EACCES) warns once
		// per dir and throws, the rule walkSubagentDir and the Pi sibling scan
		// share. Only the per-FILE failure became a report; a dir that cannot
		// even be listed has no matches to return.
		failDiscoveryPartial = false;
		failDiscoveryDir = true;
		let dirLevelThrew = false;
		let dirLevelWarned = false;
		try { lib.discoverClaudeSubAgentSessionFiles(nestedCwd, Number(TC0)); } catch (e) {
			dirLevelThrew = e instanceof Error && e.message.includes("claude subagent projects directory could not be read");
		}
		dirLevelWarned = capturedStderr.includes("a subagent transcripts directory could not be read");

		// Phase 9 — the Pi half of discovery (round 6): an unreadable sibling
		// is warned once and REPORTED (never thrown — the round-5 contract the
		// claude half established), and the readable sibling that declares
		// parentSession is still discovered alongside it (partial progress,
		// the same guarantee as Phase 7).
		failDiscoveryDir = false;
		failPiSibling = true;
		let piReported = false;
		let piKeptSibling = false;
		let piThrew = false;
		let piWarnedNamesBadRead = false;
		try {
			const r9 = lib.discoverSubagentSessionFiles(piParentPath);
			piReported = r9.unreadable !== null && String(r9.unreadable.message).includes(piSiblingBadReadPath);
			piKeptSibling = r9.files.length === 1 && r9.files[0] === piSiblingGoodPath;
		} catch { piThrew = true; }
		piWarnedNamesBadRead = capturedStderr.includes(piSiblingBadReadPath);

		// Phase 10 — round 6: a sibling whose header cannot PARSE (bad JSON,
		// empty file, partial crash) is skipped silently — it can never
		// declare parentSession, so it can never contribute cost to this
		// session. Warning would brand a harmless sibling "unreadable" and
		// withhold the swept marker forever over nothing; the per-file report
		// is for READ failures only, where cost may genuinely be missing. With
		// every sibling readable, BOTH matching siblings (good and bad-read)
		// are discovered — the bad-read name refers to its Phase-9 role — and
		// the report is null.
		failPiSibling = false;
		let piCleanReportNull = false;
		let piCleanKeptGood = false;
		let piCleanThrew = false;
		try {
			const r10 = lib.discoverSubagentSessionFiles(piParentPath);
			piCleanReportNull = r10.unreadable === null;
			piCleanKeptGood = r10.files.length === 2 && r10.files.includes(piSiblingGoodPath) && r10.files.includes(piSiblingBadReadPath);
		} catch { piCleanThrew = true; }
		const piBadJsonSilent = !capturedStderr.includes(piSiblingBadJsonPath);

		// Phase 10b — round 11 (macroscope, Medium): a sibling whose header is
		// the literal JSON null parses fine (null is valid JSON) but is not an
		// object; the cast does not change runtime null, so pre-round-11 the
		// .type access threw and the outer catch branded the harmless sibling
		// "unreadable", sending callers through the provisional failure path.
		// It must be skipped on the same silent path as bad JSON, with the
		// report untouched and every matching sibling kept.
		const piNullPath = ppath.join(ppath.dirname(piParentPath), "sibling-null-header-457.jsonl");
		cjs.writeFileSync(piNullPath, "null\\n");
		let piNullSilent = false;
		let piNullKeptTwo = false;
		let piNullThrew = false;
		try {
			const r10b = lib.discoverSubagentSessionFiles(piParentPath);
			piNullSilent = !capturedStderr.includes(piNullPath) && r10b.unreadable === null;
			piNullKeptTwo = r10b.files.length === 2;
		} catch { piNullThrew = true; }
		cjs.rmSync(piNullPath, { force: true });

		// Phase 11 — the claude half's stat gate (round 6): existsSync
		// swallowed every stat error, so an unreadable projects tree was
		// indistinguishable from an absent one; statSync distinguishes ENOENT
		// (absent, silent) from every other error (a read failure: warn once
		// per dir per process and throw). The warning is already latched by
		// Phase 8's readdirSync failure on the same projectDir, so only the
		// throw is assertable here.
		failStatProjectDir = true;
		let statProjectThrew = false;
		try { lib.discoverClaudeSubAgentSessionFiles(nestedCwd, Number(TC0)); } catch (e) {
			statProjectThrew = e instanceof Error && e.message.includes("claude subagent projects directory could not be read");
		}
		failStatProjectDir = false;

		// Phase 12 — the Pi half's pattern-1 stat gate, same rule: an
		// unreadable <session>/<base>/subagents/ (chmod-000 base, ELOOP on
		// the path) warns once naming the dir and throws. ENOTDIR was in this
		// class until round 10 (macroscope, Medium): it means an ancestor of
		// <base>/subagents is a REGULAR FILE, so no subagent can exist below
		// it — absent, like ENOENT, never a read failure (Phase 15).
		failStatPiBase = true;
		let statPiBaseThrew = false;
		let statPiBaseWarned = false;
		try { lib.discoverSubagentSessionFiles(piParentPath); } catch (e) {
			statPiBaseThrew = e instanceof Error && e.message.includes("subagents directory could not be read") && e.message.includes(piBaseDir);
		}
		statPiBaseWarned = capturedStderr.includes("a subagent transcripts directory could not be read") && capturedStderr.includes(piBaseDir);
		failStatPiBase = false;

		// Phase 13 — the walk's per-entry stat failure (round 7): an entry
		// inside an otherwise-readable subagents dir that cannot be stat'ed
		// (EACCES/EIO) is warned once, kept OUT of files, and REPORTED in the
		// result — never thrown, and never silent. Round 6's warn-only left the
		// caller's fail-safe blind (the daemon stamped the swept marker, the
		// CLI stayed exit 0 with that entry's billables missing from the token
		// table); the report closes it. The readable siblings still land
		// alongside (partial progress, the Phase 7/9 contract).
		failStatWalkEntry = true;
		let walkEntryReported = false;
		let walkEntryKeptSiblings = false;
		let walkEntryThrew = false;
		let walkEntryWarned = false;
		try {
			const r13 = lib.discoverSubagentSessionFiles(walkParentPath);
			walkEntryReported = r13.unreadable !== null && String(r13.unreadable.message).includes(walkBadStatPath);
			walkEntryKeptSiblings = r13.files.length === 2 && r13.files.includes(walkGoodPath) && r13.files.includes(walkOtherPath);
		} catch { walkEntryThrew = true; }
		walkEntryWarned = capturedStderr.includes(walkBadStatPath);
		failStatWalkEntry = false;

		// Phase 14 — the main-session header READ failure (round 7): the
		// round-4 comment claimed the caller's own read of the main file is
		// loud about the same failure; it is not — the daemon's parseNewLines
		// used to catch silently (round 9 fixed it: warn once + pollHadFailure;
		// the daemon-side boundary is pinned by PART D below) and the CLI never
		// reads the main file. A read failure here also means Pattern-2
		// discovery cannot run, so every Pi sibling's cost is silently missing
		// — the #457 class. Warn once and report, never throw. (The walk still
		// runs and collects its entries.)
		failMainHeaderRead = true;
		let mainHeaderReported = false;
		let mainHeaderWarned = false;
		let mainHeaderThrew = false;
		try {
			const r14 = lib.discoverSubagentSessionFiles(walkParentPath);
			mainHeaderReported = r14.unreadable !== null
				&& String(r14.unreadable.message).includes("session transcript could not be read at discovery")
				&& String(r14.unreadable.message).includes(walkParentPath);
		} catch { mainHeaderThrew = true; }
		mainHeaderWarned = capturedStderr.includes(walkParentPath);
		process.stderr.write = origWrite;

		// Phase 15 — ENOTDIR is the ABSENT case (round 10, macroscope,
		// Medium): when <sessionDir>/<sessionBase> is a REGULAR FILE, the
		// statSync gate on <sessionDir>/<sessionBase>/subagents fails with
		// ENOTDIR — an ancestor is not a directory, so no subagent can exist
		// below it, exactly like ENOENT. Pre-round-10 that code path warned
		// and threw, so the daemon withheld the swept marker and the CLI went
		// provisional over a plain file name collision, every scan. The gate
		// must stay silent for both codes, and Pattern 2 must still run.
		const enotdirDir = ppath.join(ppath.dirname(parentPath), "wtft-457f-enotdir");
		cjs.mkdirSync(enotdirDir, { recursive: true });
		const enotdirSessionPath = ppath.join(enotdirDir, "session.jsonl");
		cjs.writeFileSync(enotdirSessionPath, JSON.stringify({ type: "session", id: "parent-457f" }) + "\\n");
		cjs.writeFileSync(ppath.join(enotdirDir, "session"), "a regular file where the subagent base would be\\n");
		let enotdirSilent = false;
		let enotdirThrew = false;
		try {
			const r15 = lib.discoverSubagentSessionFiles(enotdirSessionPath);
			enotdirSilent = r15.unreadable === null && r15.files.length === 0;
		} catch { enotdirThrew = true; }
		cjs.rmSync(enotdirDir, { recursive: true, force: true });

		process.stdout.write(JSON.stringify({
			firstThrew, firstPassThrew, secondPassThrew, cost, skipped,
			warned: capturedStderr.includes("could not be read or parsed"),
			warnedNamesFile: capturedStderr.includes(nestedPath),
			discoveryPhaseThrew,
			discoveryWarned: capturedStderr.includes("could not be read at discovery"),
			discoveryWarnedNamesSecond: capturedStderr.includes(secondPath),
			discoveryReported1, discoveryReported2, discoveryThrew1, discoveryThrew2,
			discoveryLatchHolds: warnedAfterFirst === warnedBefore && warnedAfterSecond === warnedAfterFirst,
			partialKeptMatch, partialReportedUnreadable, partialParseThrew,
			dirLevelThrew, dirLevelWarned,
			piReported, piKeptSibling, piThrew, piWarnedNamesBadRead,
			piCleanReportNull, piCleanKeptGood, piCleanThrew, piBadJsonSilent,
			piNullSilent, piNullKeptTwo, piNullThrew,
			statProjectThrew, statPiBaseThrew, statPiBaseWarned,
			walkEntryReported, walkEntryKeptSiblings, walkEntryThrew, walkEntryWarned,
			mainHeaderReported, mainHeaderWarned, mainHeaderThrew,
			enotdirSilent, enotdirThrew,
		}));
	`);

	const childOut = JSON.parse(execFileSync(process.execPath, [childScript, parentPath, nestedPath, secondPath, cPath, nestedCwd, String(TC0), WTFT_LIB, projectDir, piParentPath, piSiblingGoodPath, piSiblingBadReadPath, piSiblingBadJsonPath, piBaseDir, walkParentPath, walkGoodPath, walkOtherPath, walkBadStatPath], {
		env: { ...process.env, HOME: tempHomeC },
		encoding: "utf8",
		timeout: 30_000,
	}));

	assert("unreadable nested transcript makes the parent parse throw (#457)", childOut.firstThrew);
	assert("a direct attribution pass is loud too, not a silent zero", childOut.firstPassThrew);
	assert("the retried pass succeeds once readability returns", !childOut.secondPassThrew);
	assert("CLI/TUI path warns that the skipped transcript could not be read", childOut.warned);
	assert("CLI/TUI path names the skipped file in the warning", childOut.warnedNamesFile);
	assert("CLI/TUI path skips the unreadable file, returning []", childOut.skipped === 0);

	// Round 4 — the discovery boundary is loud too (M2): an unreadable
	// candidate is warned once per file per process, so the parent parse fails
	// (via the round-5 attribution-pass throw) and the daemon withholds the
	// swept marker instead of stamping it with the parent turn's attribution
	// silently missing.
	assert("unreadable discovery candidate makes the parent parse throw (round 4)", childOut.discoveryPhaseThrew);
	assert("discovery warning uses the unreadable-candidate class phrase", childOut.discoveryWarned);
	assert("discovery warning names the unreadable candidate file", childOut.discoveryWarnedNamesSecond);
	assert("discovery warning is latched per file per process", childOut.discoveryLatchHolds);

	// Round 5 — the per-file discovery failure is a REPORT, not a throw: the
	// readable in-window matches are returned alongside it (partial progress —
	// the daemon registers them so their costs land), the report names the
	// candidate, and the attribution pass keeps the loud throw for this
	// transcript's own command.
	assert("a direct discovery call reports the unreadable candidate, every call", childOut.discoveryReported1 && childOut.discoveryReported2 && !childOut.discoveryThrew1 && !childOut.discoveryThrew2);
	assert("discovery returns the readable in-window match alongside the failure", childOut.partialKeptMatch);
	assert("discovery names the unreadable candidate in its report", childOut.partialReportedUnreadable);
	assert("the parent parse still throws while any candidate is unreadable", childOut.partialParseThrew);

	// Round 5 — the DIR-level failure still throws: an unreadable project dir
	// has no matches to return, so the rule stays the round-4 one.
	assert("an unreadable project dir still throws from a direct discovery call", childOut.dirLevelThrew);
	assert("the dir-level throw warns once, naming the unreadable dir class", childOut.dirLevelWarned);

	// Round 6 — the Pi half of discovery now matches the claude half's
	// round-5 contract: an unreadable sibling warns once and is REPORTED, not
	// thrown (the round-6 report keeps the readable siblings — the round-5
	// throw starved the whole subtree every poll), the readable sibling that
	// declares parentSession is still discovered alongside it, and the
	// report is null when every sibling reads.
	assert("Pi half reports the unreadable sibling, not a throw", childOut.piReported && !childOut.piThrew);
	assert("Pi half keeps the readable sibling alongside the failure", childOut.piKeptSibling);
	assert("Pi half's discovery warning names the unreadable sibling", childOut.piWarnedNamesBadRead);
	assert("Pi half reports nothing when every sibling reads", childOut.piCleanReportNull && !childOut.piCleanThrew && childOut.piCleanKeptGood);
	assert("Pi half skips a bad-JSON sibling silently", childOut.piBadJsonSilent);
	assert("Pi half skips a null-header sibling silently, report untouched (round 11)", childOut.piNullSilent && childOut.piNullKeptTwo && !childOut.piNullThrew);

	// Round 6 — existsSync was the last silent boundary of the
	// unreadable-transcript class: it swallowed every stat error, so an
	// unreadable projects tree / subagents dir was indistinguishable from an
	// absent one. statSync now separates ENOENT (absent, silent) from any
	// other error (a read failure: warn once per dir per process and throw)
	// on both discovery halves.
	assert("claude half stat gate throws on an unreadable projects dir", childOut.statProjectThrew);
	assert("Pi half stat gate throws on an unreadable subagents dir, warning it by name", childOut.statPiBaseThrew && childOut.statPiBaseWarned);

	// Round 7 — the walk's per-entry stat failure was the one boundary where
	// this diff's invariant ("the marker must not stamp while its cost could
	// be missing") was enforced only by a warning: round 6 warned and kept
	// walking, but nothing reported, so the daemon stamped the swept marker
	// and the CLI stayed exit 0 with the entry's billables missing from the
	// token table. The walk now returns its first such failure and discovery
	// reports it — readable siblings still land (partial progress), no throw.
	assert("walk reports an entry whose stat fails, keeping the readable siblings (round 7)", childOut.walkEntryReported && childOut.walkEntryKeptSiblings && !childOut.walkEntryThrew);
	assert("walk entry stat failure warns once, naming the entry", childOut.walkEntryWarned);

	// Round 7 — the main-session header READ failure: the round-4 comment
	// claimed the caller's own read is loud about the same failure; it is not
	// (the daemon's parseNewLines used to catch silently — fixed in round 9,
	// PART D — and the CLI never reads the main file). A read failure here
	// also means Pattern-2 discovery cannot run, so Pi siblings' cost is
	// silently missing — the #457 class. Warn and report, never throw.
	assert("main-session header read failure reports and warns, never throws (round 7)", childOut.mainHeaderReported && childOut.mainHeaderWarned && !childOut.mainHeaderThrew);

	// Round 10 — ENOTDIR is the absent case (macroscope, Medium): a regular
	// file where <sessionDir>/<sessionBase> sits makes the subagents stat
	// gate fail with ENOTDIR, not ENOENT — but no subagent can exist below a
	// non-directory ancestor either way, so both codes must be silent.
	// Treating ENOTDIR as a read failure had the daemon withholding the
	// swept marker and the CLI going provisional over a name collision.
	assert("ENOTDIR gate stays silent and never throws (round 10)", childOut.enotdirSilent && !childOut.enotdirThrew);

	// Parent turn: 2000 in / 100 out = $0.007500.  Nested session: 1000 in /
	// 100 out = $0.004500.  A swallowed failure (old code) leaves $0.004500 on
	// the table forever.
	const PARENT_OWN = 0.0075;
	const NESTED_COST = 0.0045;
	const EXPECTED_RECOVERED = PARENT_OWN + NESTED_COST; // $0.012000
	assert(
		`retried pass recovers the nested cost in full ($${childOut.cost.toFixed(6)} === $${EXPECTED_RECOVERED.toFixed(6)})`,
		Math.abs(childOut.cost - EXPECTED_RECOVERED) < 0.000001
	);
}

// ---
// PART D — the MAIN session file's own read in the live daemon (round 9, PR
// review, Medium): parseNewLines used to swallow EVERY read failure — EACCES,
// EIO, a failed mid-read — into an empty batch with the comment "File may not
// exist yet", the daemon's last silent read boundary, and the same
// silent-empty lie the discovery read was fixed to report (rounds 4/5/8).
// The scenario: the main session file becomes unreadable AFTER a healthy
// baseline (content had landed and the marker had stamped), while a READABLE
// subagent transcript keeps growing the tag. The tag must keep taking the
// subagent rows, the main turn must not reach the tag, the warning must name
// the session transcript, and NO new swept marker may stamp over the missing
// cost — then, once readability returns, the main turn lands and the marker
// stamps again.
//
// Honest caveat, verified against the code: the pattern-2 discovery read of
// the same main file (unconditional, rounds 5/8) independently fails, warns
// and withholds the marker, so this integration scenario would mostly pass on
// the pre-round-9 daemon too. PART D pins the OBSERVABLE contract — loud
// warning, marker withheld while the main file's cost is missing, full
// recovery — and the parseNewLines fix makes the boundary self-sufficient
// instead of dependent on the discovery read running first in the poll.
// ---
try {
	if (isRoot) {
		skip("root bypasses file mode bits — the daemon main-file-unreadable scenario cannot run");
	} else {
		// Part C's fixtures are cleaned up by this part's finally (same pattern
		// as B/B2/B3: each part's cleanup covers the earlier parts' leftovers).
		const dDir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-457d-")));
		fixtureDirs.push(dDir);

		const sessionPath = path.join(dDir, "session.jsonl");
		fs.writeFileSync(sessionPath, JSON.stringify({
			type: "session", version: 3, id: "parent-457d", timestamp: new Date().toISOString(), cwd: dDir,
		}) + "\n");
		const tagsDir = path.join(dDir, "wtft-tags");
		fs.mkdirSync(tagsDir, { recursive: true });
		cleanupPidFiles.push(getDaemonPidPath(sessionPath));

		const subagentDir = path.join(dDir, "session", "subagents");
		fs.mkdirSync(subagentDir, { recursive: true });
		const subagentPath = path.join(subagentDir, "agent-457d.jsonl");

		const T0 = Date.now() - 60_000;
		const C1 = "msg_457d_c1";
		const C2 = "msg_457d_c2";
		const SUB1 = "msg_457d_sub1";
		const SUB2 = "msg_457d_sub2";

		// Healthy baseline: a main turn and one subagent turn, both readable.
		fs.appendFileSync(sessionPath, turnLine(C1, T0, 1000, 50));
		fs.writeFileSync(subagentPath, turnLine(SUB1, T0 + 1_000, 2000, 100));

		const tagPath = path.join(tagsDir, currentTagFileName(sessionPath));
		const countSweptMarkers = () => {
			let content = "";
			try { content = fs.readFileSync(tagPath, "utf8"); } catch { return 0; }
			return content.split("\n").filter(l => l.includes('"_meta"') && l.includes('"swept"')).length;
		};

		try {
			const daemon = spawnDaemon(sessionPath);

			// Baseline: the subagent turn lands (proves the daemon reads the
			// subagent path and the tag grows) and the marker stamps over the
			// healthy content.
			let sawSub1 = false;
			for (let i = 0; i < 20 && !sawSub1; i++) {
				await sleep(250);
				sawSub1 = readClassifiedTagFile(tagPath).some(int => int.messageId === SUB1);
			}
			assert("baseline: subagent turn lands in the tag while the main file is readable", sawSub1);
			let sawBaselineSwept = false;
			for (let i = 0; i < 12 && !sawBaselineSwept; i++) {
				await sleep(250);
				sawBaselineSwept = countSweptMarkers() > 0;
			}
			assert("baseline: swept marker stamps over the healthy content", sawBaselineSwept);

			// The failure: a new main turn is appended, THEN the main file becomes
			// unreadable — the turn exists but cannot be read. The SUB2 subagent
			// turn is NOT appended until the round-10 assertions below: in this
			// window nothing but heartbeats lands after the baseline marker, so
			// the retraction record is the ONLY thing that keeps the tag
			// provisional (a classified line after the marker would invalidate it
			// positionally anyway, which would test the pre-existing reader rule
			// instead of round 10's mechanism).
			fs.appendFileSync(sessionPath, turnLine(C2, T0 + 2_000, 1500, 75));
			fs.chmodSync(sessionPath, 0o000);

			// The #457 warning names the SESSION TRANSCRIPT (the round-7 noun for
			// the main file) at discovery. The latch is shared with the pattern-2
			// discovery read of the same file, so exactly one warning fires; both
			// paths emit the identical phrase, so the anchor holds either way.
			let warned = false;
			for (let i = 0; i < 30 && !warned; i++) {
				await sleep(250);
				const stderr = daemon.stderr.join("");
				warned = stderr.includes("the session transcript could not be read at discovery") && stderr.includes(sessionPath);
			}
			assert("daemon warns that the unreadable main session transcript could not be read", warned);

			// The unreadable main turn does not reach the tag...
			let sawC2WhileUnreadable = false;
			for (let i = 0; i < 8; i++) {
				await sleep(250);
				sawC2WhileUnreadable = readClassifiedTagFile(tagPath).some(int => int.messageId === C2);
			}
			assert("no main-session content reaches the tag while the main file is unreadable", !sawC2WhileUnreadable);


			// Marker withholding: count the markers once the failure is live, then
			// wait past several polls and require no new stamp. Every poll during
			// this window has real tag growth (idle heartbeats at minimum, often
			// the subagent rows), so any poll that did not see the failure would
			// stamp — and the count must not move.
			const markersAtFailure = countSweptMarkers();

			// NOW the readable subagent turn lands, so the tag grows while the
			// main file is still unreadable: the sweep gate has real growth to
			// consider stamping over, and must withhold because of the failure.
			fs.appendFileSync(subagentPath, turnLine(SUB2, T0 + 3_000, 2500, 125));
			let sawSub2 = false;
			for (let i = 0; i < 8 && !sawSub2; i++) {
				await sleep(250);
				sawSub2 = readClassifiedTagFile(tagPath).some(int => int.messageId === SUB2);
			}
			assert("readable subagent turn still lands (tag grows) while the main file is unreadable", sawSub2);

			// Marker withholding: count the markers once the failure is live, then
			// wait past several polls and require no new stamp. Every poll during
			// this window has real tag growth (idle heartbeats at minimum, often
			// the subagent rows), so any poll that did not see the failure would
			// stamp — and the count must not move.
			await sleep(2_000);
			const markersAfter = countSweptMarkers();
			assert(
				`swept marker is withheld while the main file is unreadable (${markersAfter} === ${markersAtFailure})`,
				markersAfter === markersAtFailure
			);

			// Round 10 (macroscope, Medium): withholding FUTURE stamps is not
			// enough — readTagProvisional cannot see pollHadFailure, and the
			// baseline marker stamped BEFORE the failure began would still
			// certify the undercounted tag as settled (the positional limit the
			// sweep comment names). The failure path retracts it: one
			// {"_meta":{"unswept":ts}} record per episode, appended only while a
			// swept marker is the last significant record — heartbeats are
			// passed over exactly like the reader's scan passes them. The tag
			// must read provisional ("unswept") for as long as the failure
			// lasts, and because SUB2 has not landed yet, this window is the
			// retraction record's OWN proof, not the classified-line rule's.
			let rawHasUnswept = false;
			for (let i = 0; i < 8 && !rawHasUnswept; i++) {
				await sleep(250);
				let rawTagContent = "";
				try { rawTagContent = fs.readFileSync(tagPath, "utf8"); } catch {}
				rawHasUnswept = rawTagContent.includes('"unswept"');
			}
			assert("failure episode appends the _meta.unswept retraction record", rawHasUnswept);
			let provisionalWhileUnreadable = false;
			for (let i = 0; i < 8 && !provisionalWhileUnreadable; i++) {
				await sleep(250);
				provisionalWhileUnreadable =
					readTagProvisional(tagPath).provisional === true &&
					readTagProvisional(tagPath).reason === "unswept";
			}
			assert("tag reads provisional (stale marker retracted) while the main file is unreadable", provisionalWhileUnreadable);

			// Still polling, not crashed.
			let stillAlive = daemon.pid > 0;
			if (stillAlive) { try { process.kill(daemon.pid, 0); } catch { stillAlive = false; } }
			assert("daemon keeps polling while the main file is unreadable", stillAlive);

			// Recovery: readability returns (chmod touches only ctime, so size and
			// mtime are unchanged — the exact #457 scenario), the main turn lands
			// in the tag, and the next clean sweep stamps the marker again.
			fs.chmodSync(sessionPath, 0o644);
			let sawC2AfterRestore = false;
			for (let i = 0; i < 20 && !sawC2AfterRestore; i++) {
				await sleep(250);
				sawC2AfterRestore = readClassifiedTagFile(tagPath).some(int => int.messageId === C2);
			}
			assert("main turn is read once readability returns and is counted in the tag", sawC2AfterRestore);

			let sawSweptAfterRecovery = false;
			for (let i = 0; i < 20 && !sawSweptAfterRecovery; i++) {
				await sleep(250);
				sawSweptAfterRecovery = countSweptMarkers() > markersAtFailure;
			}
			assert("tag is swept again only after the recovered main turn is counted", sawSweptAfterRecovery);

			// Round 10: the fresh marker is now the last significant record —
			// the retraction record is BELOW it, so the tag reads settled again.
			let settledAfterRecovery = false;
			for (let i = 0; i < 20 && !settledAfterRecovery; i++) {
				await sleep(250);
				settledAfterRecovery = readTagProvisional(tagPath).provisional === false;
			}
			assert("tag reads settled again once a fresh marker covers the recovered lines", settledAfterRecovery);
		} finally {
			for (const pid of cleanupPids) { if (pid > 0) { try { process.kill(pid, "SIGTERM"); } catch {} } }
			for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch {} }
			await sleep(200);
			for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
		}
	}
} finally {
	for (const pid of cleanupPids) { if (pid > 0) { try { process.kill(pid, "SIGTERM"); } catch {} } }
	for (const pf of cleanupPidFiles) { try { fs.unlinkSync(pf); } catch {} }
	await sleep(200);
	for (const d of fixtureDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

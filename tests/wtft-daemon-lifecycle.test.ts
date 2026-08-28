#!/usr/bin/env bun
/**
 * @package princess-pi-tools
 * @test wtft-daemon-lifecycle
 * @description Validates #95 daemon lifecycle fixes against the BUILT bins:
 *   1. Idle clamped by classified freshness (dual-daemon heartbeat fixture)
 *   2. Takeover protocol — lost PID lease → exit within 2 beats, no unlink
 *   3. Spawn-twice — exactly one surviving daemon, and it owns the PID file
 *   4. Session deleted → daemon exits (#129 Bug A)
 *   5. Reap on spawn kills orphans + writes warnings (#130)
 *   6. Version hygiene — old-version tag files removed at startup
 *   7. getTagPath — exact version preferred, else newest mtime
 *   8. Cache TTL derived from usage.cache_creation, not the model name
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { pollUntil } from "./lib/poll";

import {
	checkDaemonHealth,
	getTagPath,
	getDaemonPidPath,
	IDLE_THRESHOLD_MS,
	WTFT_TAGGER_VERSION,
	parseEntryToInteraction,
	serializeClassified,
	classifiedToInteraction,
} from "../bin/wtft.mjs";


// Private pid namespace for this suite (#486). Must precede the first
// getDaemonPidPath() and the first daemon spawn: every daemon's startup
// reapAndWarn() sweeps `os.tmpdir()` and unlinks any wtft-daemon-*.pid whose
// process is dead, so on a shared /tmp this suite is racing every other daemon
// on the host — and its own daemons are reaching theirs.
isolateTmpdir("lifecycle");

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

// --- Fixture helpers ---

const fixtureDirs: string[] = [];
const cleanupPids: number[] = [];
const cleanupPidFiles: string[] = [];

/** Fresh session fixture dir with one minimal assistant entry. */
function makeSessionFixture(name: string): { dir: string; sessionPath: string; tagsDir: string } {
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), `wtft-lifecycle-${name}-`)));
	fixtureDirs.push(dir);
	const sessionPath = path.join(dir, "session.jsonl");
	fs.writeFileSync(sessionPath, JSON.stringify({
		type: "assistant",
		message: {
			role: "assistant", id: "msg_fixture_1", model: "claude-sonnet-5",
			timestamp: new Date(Date.now() - 60_000).toISOString(),
			usage: { input_tokens: 100, output_tokens: 50 },
			content: [{ type: "text", text: "hello" }],
		},
	}) + "\n");
	const tagsDir = path.join(dir, "wtft-tags");
	fs.mkdirSync(tagsDir, { recursive: true });
	cleanupPidFiles.push(getDaemonPidPath(sessionPath));
	return { dir, sessionPath, tagsDir };
}

function currentTagFileName(sessionPath: string): string {
	return path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`;
}

function spawnDaemon(sessionPath: string): number {
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", sessionPath], {
		detached: true, stdio: "ignore",
	});
	child.unref();
	if (child.pid) cleanupPids.push(child.pid);
	return child.pid || 0;
}

/** Serialized classified line with an explicit timestamp/model/ttl. */
function classifiedLine(t: number, model = "claude-sonnet-5", ttl?: "1h" | "5m"): string {
	const obj: any = { t, c: 0.01, cat: "prompt", f: [], cmd: [], m: model };
	if (ttl) obj.ttl = ttl;
	return JSON.stringify(obj) + "\n";
}

function hbLine(first: number, last: number): string {
	return JSON.stringify({ _hb: { first, last } }) + "\n";
}

// ---
// 1. Idle clamp: dual-daemon interleaved heartbeats + fresh classified data
// ---
console.log("1. Idle clamped by classified freshness (checkDaemonHealth)");
{
	const { sessionPath, tagsDir } = makeSessionFixture("idleclamp");
	const tagPath = path.join(tagsDir, currentTagFileName(sessionPath));
	const now = Date.now();

	// Own PID file → "alive" path (this test process is the daemon stand-in).
	fs.writeFileSync(getDaemonPidPath(sessionPath), String(process.pid));
	// Session file freshly written (mtime ≈ now) — session-mtime branch stays quiet.

	// Fresh classified entry, then two stale heartbeats with DIVERGENT idle
	// windows (the dual-daemon interleave observed live in #95).
	fs.writeFileSync(tagPath,
		classifiedLine(now - 30_000) +
		hbLine(now - 10 * 60_000, now) +   // daemon A: idle 10min → "cache emptied"
		hbLine(now - 8 * 60_000, now)      // daemon B: idle 8min  → "expires soon"
	);

	const results = Array.from({ length: 5 }, () => checkDaemonHealth(sessionPath, tagPath));
	assert("status is live (not idle) despite stale heartbeats", results.every(r => r.alive && !r.idle));
	assert("stable across 5 repeated calls", new Set(results.map(r => JSON.stringify({ a: r.alive, i: !!r.idle }))).size === 1);

	// Control: heartbeats only (no fresh classified line) + old session mtime → idle.
	fs.writeFileSync(tagPath,
		classifiedLine(now - 10 * 60_000) +
		hbLine(now - 10 * 60_000, now)
	);
	fs.utimesSync(sessionPath, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));
	const idleResult = checkDaemonHealth(sessionPath, tagPath);
	assert("control: genuinely stale data → idle", idleResult.alive === true && idleResult.idle === true);
	assert(`control: idleMs ≥ IDLE_THRESHOLD_MS (${IDLE_THRESHOLD_MS})`, (idleResult.idleMs || 0) >= IDLE_THRESHOLD_MS);

	fs.unlinkSync(getDaemonPidPath(sessionPath));
}

// ---
// 2. Takeover protocol: lost PID lease → exit within 2 beats, no unlink
// ---
console.log("\n2. Takeover protocol (real daemon process)");
{
	const { sessionPath } = makeSessionFixture("takeover");
	const pidPath = getDaemonPidPath(sessionPath);
	const spawnedPid = spawnDaemon(sessionPath);

	// Wait for the daemon to claim the PID file.
	const readClaim = (): number => {
		try { return parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10); } catch { return 0; }
	};
	await pollUntil(() => readClaim() > 0, 15_000, 250);
	const claimed = readClaim();
	assert("daemon claimed PID file", claimed > 0 && isAlive(claimed));

	// Steal the lease: overwrite with a foreign PID.
	fs.writeFileSync(pidPath, "424242");
	// Poll, don't sleep (#387). The claim under test is "a daemon that loses the
	// lease exits" — "within 2 beats" was a constant, and a constant asserted
	// against a shared host is a bet on scheduling. The ceiling is generous so a
	// loaded host fails LATE (a real regression) rather than FALSELY.
	const exited = await pollUntil(() => !isAlive(claimed), 15_000);
	assert("daemon exited after losing the lease", exited);
	let content = "";
	try { content = fs.readFileSync(pidPath, "utf8").trim(); } catch {}
	assert("exiting daemon did NOT unlink the new owner's PID file", content === "424242");
	try { fs.unlinkSync(pidPath); } catch {}
	void spawnedPid;
}

// ---
// 3. Spawn twice: exactly one survivor, and it owns the PID file
// ---
console.log("\n3. Spawn-twice singleton");
{
	const { sessionPath } = makeSessionFixture("spawntwice");
	const pidPath = getDaemonPidPath(sessionPath);
	spawnDaemon(sessionPath);
	spawnDaemon(sessionPath);
	const readOwner = (): number => {
		try { return parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10); } catch { return 0; }
	};
	await pollUntil(() => readOwner() > 0 && isAlive(readOwner()), 15_000);

	const owner = readOwner();
	assert("PID file has an owner", owner > 0);
	assert("owner is alive", isAlive(owner));

	// Exactly one wtft-daemon survives for this session.
	const survivors = cleanupPids.filter(p => isAlive(p) && p !== 0);
	// (cleanupPids may contain daemons from other tests already dead)
	const thisTestAlive = survivors.filter(p => {
		try {
			const cmdline = fs.readFileSync(`/proc/${p}/cmdline`, "utf8");
			return cmdline.includes(sessionPath);
		} catch { return false; }
	});
	assert("exactly one daemon process for the session", thisTestAlive.length === 1);
	assert("the survivor is the PID-file owner", thisTestAlive.length === 1 && thisTestAlive[0] === owner);

	try { process.kill(owner, "SIGTERM"); } catch {}
}

// ---
// 4. Session deleted → daemon exits (#129 Bug A)
// ---
console.log("\n4. Session deleted → daemon exits");
{
	const { sessionPath, tagsDir: tagsDir4 } = makeSessionFixture("sessiongone");
	const pidPath = getDaemonPidPath(sessionPath);
	const spawnedPid = spawnDaemon(sessionPath);

	// Wait for daemon to claim PID file and process the session data
	// (so sessionExisted becomes true).
	const readClaim4 = (): number => {
		try { return parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10); } catch { return 0; }
	};
	await pollUntil(() => readClaim4() > 0, 15_000, 250);
	const claimed = readClaim4();
	assert("daemon claimed PID file", claimed > 0 && isAlive(claimed));
	// Let the daemon get a tag file on disk before the session is removed —
	// polled, because "has it processed the fixture yet" is a condition, not a
	// duration (#387). Asserted, not just awaited: if this precondition times
	// out, the scenario below is VOID rather than failed, and a silent timeout
	// would surface as a confusing result on a later assertion instead of
	// naming the setup step that did not happen.
	assert("daemon wrote a tag file before the session is removed", await pollUntil(() => {
		try { return fs.readdirSync(tagsDir4).some(f => f.includes(".wtft-tag.v")); } catch { return false; }
	}, 15_000));

	// Delete the session file — daemon should exit, not idle forever.
	fs.unlinkSync(sessionPath);
	assert("daemon exited after session file deleted", await pollUntil(() => !isAlive(claimed), 15_000));
	try { fs.unlinkSync(pidPath); } catch {}
	void spawnedPid;
}

// ---
// 5. Reap on spawn: kills orphans with gone session (#130)
// ---
console.log("\n5. Reap on spawn kills orphan daemons");
{
	const WARN_LOG = path.join(os.homedir(), ".local", "state", "wtft", "reap.log");
	const { sessionPath: sessA } = makeSessionFixture("reap-orphan");
	const { sessionPath: sessB } = makeSessionFixture("reap-new");

	// Start daemon A (will become orphan). Wait for its LEASE, not a duration:
	// the reap under test keys on the pid file, so a daemon that has not written
	// one yet is invisible to B and the whole scenario is void (#387).
	const pidA = spawnDaemon(sessA);
	const pidPathA = getDaemonPidPath(sessA);
	const leaseA = await pollUntil(() => {
		try { return parseInt(fs.readFileSync(pidPathA, "utf8").trim(), 10) === pidA; } catch { return false; }
	}, 15_000);
	assert("daemon A started and holds its lease", leaseA && isAlive(pidA));

	// Delete session A's file
	fs.unlinkSync(sessA);

	// Start daemon B — its startup reap should kill A. Wait for B's own lease
	// first: the reap runs during startup, so "B has claimed" is the earliest
	// point at which its sweep is known to have happened.
	const pidB = spawnDaemon(sessB);
	const pidPathB = getDaemonPidPath(sessB);
	const leaseB = await pollUntil(() => {
		try { return parseInt(fs.readFileSync(pidPathB, "utf8").trim(), 10) === pidB; } catch { return false; }
	}, 15_000);
	assert("daemon B started and holds its lease", leaseB);

	assert("orphan daemon A killed by reap on B's spawn", await pollUntil(() => !isAlive(pidA), 15_000));
	assert("daemon B still alive", isAlive(pidB));

	// PID file A should be cleaned up
	assert("orphan pidfile cleaned up", await pollUntil(() => !fs.existsSync(pidPathA), 15_000));

	// Cleanup
	try { process.kill(pidB, "SIGTERM"); } catch {}
	try { fs.unlinkSync(WARN_LOG); } catch {}
}

// ---
// 6. Version hygiene: old-version tag files removed at startup
// ---
console.log("\n6. Version hygiene at startup");
{
	const { sessionPath, tagsDir } = makeSessionFixture("hygiene");
	const pidPath = getDaemonPidPath(sessionPath);
	const oldTag = path.join(tagsDir, path.basename(sessionPath) + ".wtft-tag.v2.4.2.jsonl");
	fs.writeFileSync(oldTag, hbLine(Date.now() - 60_000, Date.now() - 60_000));

	spawnDaemon(sessionPath);
	await pollUntil(() => !fs.existsSync(oldTag), 15_000);

	assert("old-version tag file removed", !fs.existsSync(oldTag));
	const currentTag = path.join(tagsDir, currentTagFileName(sessionPath));
	assert("current-version tag file exists", fs.existsSync(currentTag));
	const remaining = fs.readdirSync(tagsDir).filter(f => f.includes(".wtft-tag.v"));
	assert("exactly one tag file remains", remaining.length === 1);

	try { process.kill(parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10), "SIGTERM"); } catch {}
}

// ---
// 7. getTagPath: exact version preferred, else newest mtime
// ---
console.log("\n7. getTagPath determinism");
{
	const { sessionPath, tagsDir } = makeSessionFixture("tagpath");
	const base = path.basename(sessionPath);
	const current = path.join(tagsDir, base + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const oldA = path.join(tagsDir, base + ".wtft-tag.v2.3.8.jsonl");
	const oldB = path.join(tagsDir, base + ".wtft-tag.v2.4.2.jsonl");

	// Empty dir → default (current-version) path.
	assert("empty dir → default current-version path", getTagPath(sessionPath) === current);

	// Only old versions → newest mtime wins, not readdir order.
	fs.writeFileSync(oldA, "");
	fs.writeFileSync(oldB, "");
	const now = Date.now();
	fs.utimesSync(oldA, new Date(now - 1000), new Date(now - 1000)); // newer
	fs.utimesSync(oldB, new Date(now - 60_000), new Date(now - 60_000)); // older
	assert("old versions only → newest mtime", getTagPath(sessionPath) === oldA);

	// Exact current version present → always preferred.
	fs.writeFileSync(current, "");
	fs.utimesSync(current, new Date(now - 120_000), new Date(now - 120_000)); // oldest mtime!
	assert("current version preferred even with older mtime", getTagPath(sessionPath) === current);
}

// ---
// 8. Cache TTL derived from data, not model name
// ---
console.log("\n8. Cache TTL from usage.cache_creation");
{
	// 6a. Parse → serialize → deserialize round-trip.
	const entry1h = {
		type: "assistant",
		message: {
			role: "assistant", id: "msg_ttl_1", model: "claude-fable-5",
			timestamp: new Date().toISOString(),
			usage: {
				input_tokens: 10, output_tokens: 5,
				cache_creation_input_tokens: 74,
				cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 74 },
			},
			content: [{ type: "text", text: "x" }],
		},
	};
	const parsed1h = parseEntryToInteraction(entry1h);
	assert("ephemeral_1h > 0 → cacheTtl '1h'", parsed1h?.cacheTtl === "1h");
	const wire = serializeClassified(parsed1h!);
	assert("serializeClassified writes ttl", wire.includes('"ttl":"1h"'));
	const roundTrip = classifiedToInteraction(JSON.parse(wire));
	assert("classifiedToInteraction reads ttl back", roundTrip?.cacheTtl === "1h");

	const entry5m = JSON.parse(JSON.stringify(entry1h));
	entry5m.message.id = "msg_ttl_2";
	entry5m.message.usage.cache_creation = { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 };
	assert("ephemeral_5m > 0 → cacheTtl '5m'", parseEntryToInteraction(entry5m)?.cacheTtl === "5m");

	const entryNone = JSON.parse(JSON.stringify(entry1h));
	entryNone.message.id = "msg_ttl_3";
	delete entryNone.message.usage.cache_creation;
	assert("no cache_creation breakdown → cacheTtl unset", parseEntryToInteraction(entryNone)?.cacheTtl === undefined);

	// 6b. checkDaemonHealth uses observed TTL over the claude 5-min guess.
	const { sessionPath, tagsDir } = makeSessionFixture("ttl");
	const tagPath = path.join(tagsDir, currentTagFileName(sessionPath));
	const now = Date.now();
	fs.writeFileSync(getDaemonPidPath(sessionPath), String(process.pid));
	fs.utimesSync(sessionPath, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));

	fs.writeFileSync(tagPath,
		classifiedLine(now - 10 * 60_000, "claude-fable-5", "1h") +
		hbLine(now - 10 * 60_000, now)
	);
	const status1h = checkDaemonHealth(sessionPath, tagPath);
	assert("idle with observed 1h TTL → cacheTtlMs 3600000", status1h.idle === true && status1h.cacheTtlMs === 3_600_000);

	// Without ttl in the window → model-name heuristic (claude → 5min).
	fs.writeFileSync(tagPath,
		classifiedLine(now - 10 * 60_000, "claude-fable-5") +
		hbLine(now - 10 * 60_000, now)
	);
	const statusGuess = checkDaemonHealth(sessionPath, tagPath);
	assert("no observed TTL → falls back to model heuristic (5min)", statusGuess.idle === true && statusGuess.cacheTtlMs === 300_000);

	fs.unlinkSync(getDaemonPidPath(sessionPath));
}

// ---
// Cleanup
// ---
for (const pid of cleanupPids) {
	try { process.kill(pid, "SIGTERM"); } catch {}
}
for (const pf of cleanupPidFiles) {
	try { fs.unlinkSync(pf); } catch {}
}
await sleep(200);
for (const dir of fixtureDirs) {
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ---
// Results
// ---
console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

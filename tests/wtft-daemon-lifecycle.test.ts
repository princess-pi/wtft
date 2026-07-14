#!/usr/bin/env -S npx tsx
/**
 * @package princess-pi-packages
 * @test wtft-daemon-lifecycle
 * @description Validates #95 daemon lifecycle fixes against the BUILT bins:
 *   1. Idle clamped by classified freshness (dual-daemon heartbeat fixture)
 *   2. Takeover protocol — lost PID lease → exit within 2 beats, no unlink
 *   3. Spawn-twice — exactly one surviving daemon, and it owns the PID file
 *   4. Version hygiene — old-version tag files removed at startup
 *   5. getTagPath — exact version preferred, else newest mtime
 *   6. Cache TTL derived from usage.cache_creation, not the model name
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
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

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const BEAT_MS = 667;

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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wtft-lifecycle-${name}-`));
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
	let claimed = 0;
	for (let i = 0; i < 20 && !claimed; i++) {
		await sleep(250);
		try { claimed = parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10); } catch {}
	}
	assert("daemon claimed PID file", claimed > 0 && isAlive(claimed));

	// Steal the lease: overwrite with a foreign PID.
	fs.writeFileSync(pidPath, "424242");
	await sleep(2 * BEAT_MS + 500);

	assert("daemon exited within 2 beats of losing the lease", !isAlive(claimed));
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
	await sleep(2 * BEAT_MS + 500);

	let owner = 0;
	try { owner = parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10); } catch {}
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
// 4. Version hygiene: old-version tag files removed at startup
// ---
console.log("\n4. Version hygiene at startup");
{
	const { sessionPath, tagsDir } = makeSessionFixture("hygiene");
	const pidPath = getDaemonPidPath(sessionPath);
	const oldTag = path.join(tagsDir, path.basename(sessionPath) + ".wtft-tag.v2.4.2.jsonl");
	fs.writeFileSync(oldTag, hbLine(Date.now() - 60_000, Date.now() - 60_000));

	spawnDaemon(sessionPath);
	await sleep(2 * BEAT_MS + 500);

	assert("old-version tag file removed", !fs.existsSync(oldTag));
	const currentTag = path.join(tagsDir, currentTagFileName(sessionPath));
	assert("current-version tag file exists", fs.existsSync(currentTag));
	const remaining = fs.readdirSync(tagsDir).filter(f => f.includes(".wtft-tag.v"));
	assert("exactly one tag file remains", remaining.length === 1);

	try { process.kill(parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10), "SIGTERM"); } catch {}
}

// ---
// 5. getTagPath: exact version preferred, else newest mtime
// ---
console.log("\n5. getTagPath determinism");
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
// 6. Cache TTL derived from data, not model name
// ---
console.log("\n6. Cache TTL from usage.cache_creation");
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

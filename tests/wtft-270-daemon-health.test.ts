#!/usr/bin/env -S bun
/**
 * DaemonHealth: {lease} × {tag tail} × {age} × {session file} → one answer, with no
 * process spawned. docs/spec-270-daemon-health.md § 2, § 3.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tagRecords } from "../extensions/lib/tag-log.ts";
import { decideHealth, readHealthFacts, IDLE_THRESHOLD_MS, type HealthFacts } from "../extensions/lib/daemon-health.ts";
import { health, getDaemonPidPath, getTagPath } from "../extensions/lib/wtft-daemon-lib.ts";
import { isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("daemon-health-270");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const NOW = 1_700_000_000_000;
const MIN = 60_000;

const turn = (t: number, extra: Record<string, unknown> = {}) =>
	JSON.stringify({ t, c: 0.01, cat: "prompt", f: [], cmd: [], m: "claude-sonnet-5", ...extra }) + "\n";
const hb = (first: number, last: number) => JSON.stringify({ _hb: { first, last } }) + "\n";
const stop = () => JSON.stringify({ _hb: "stop", reason: "exit" }) + "\n";

interface Fx {
	alive?: boolean;
	tag?: string | null;
	tagMtimeMs?: number;
	sessionMtimeMs?: number | null;
	model?: string;
}
function facts(fx: Fx): HealthFacts & { modelReads: number } {
	const content = fx.tag === undefined ? null : fx.tag;
	const out = {
		holderAlive: fx.alive ?? true,
		tag: content === null ? null : { size: Buffer.byteLength(content), mtimeMs: fx.tagMtimeMs ?? NOW - 10 * MIN, tail: tagRecords(content) },
		sessionMtimeMs: fx.sessionMtimeMs === undefined ? NOW - 10_000 : fx.sessionMtimeMs,
		modelReads: 0,
		sessionModel: () => { out.modelReads++; return fx.model; },
	};
	return out;
}

console.log("A. lease alive");
{
	const f = facts({ tag: turn(NOW - 30_000, { m: undefined }) });
	const s = decideHealth(f, NOW);
	check(s.alive && !s.idle && s.reason === undefined, "A1 no heartbeat and a session written 10 s ago → live");
	check(f.modelReads === 0, "A2 a live answer never reads the session file for a model, even with none in the tail");
}
{
	const s = decideHealth(facts({ tag: turn(NOW - 12 * MIN, { ttl: "1h" }) + hb(NOW - 10 * MIN, NOW) }), NOW);
	check(s.alive && s.idle === true, "A3 a heartbeat idle for 10 min → idle");
	check(s.idleSinceMs === NOW - 10 * MIN && s.idleMs === 10 * MIN, "A4 idle since the heartbeat's first");
	check(s.cacheTtlMs === 3_600_000, "A5 the turn's 1h TTL gives the cache window");
}
{
	const s = decideHealth(facts({ tag: turn(NOW - 30_000) + hb(NOW - 10 * MIN, NOW) + hb(NOW - 8 * MIN, NOW) }), NOW);
	check(s.alive && !s.idle, "A6 heartbeats after a fresh turn: live (the #95 clamp)");
}
{
	const s = decideHealth(facts({ tag: turn(NOW - 5 * MIN) + hb(NOW - 10 * MIN, NOW) }), NOW);
	check(s.idle === true && s.idleSinceMs === NOW - 5 * MIN, "A7 a turn later than the heartbeat's first moves idle-since to the turn");
}
{
	const f = facts({ tag: hb(NOW - 10 * MIN, NOW), model: "claude-opus-5-5" });
	const s = decideHealth(f, NOW);
	check(s.idle === true && s.cacheTtlMs === 300_000 && f.modelReads === 1, "A8 no turn in the tail: the session file's model gives the TTL, read once");
}
{
	const f = facts({ tag: hb(NOW - 10 * MIN, NOW), model: undefined });
	check(decideHealth(f, NOW).cacheTtlMs === null, "A9 no model anywhere → TTL unknown (null)");
}
{
	const s = decideHealth(facts({ tag: turn(NOW - 15 * MIN), sessionMtimeMs: NOW - 10 * MIN }), NOW);
	check(s.idle === true && s.idleSinceMs === NOW - 10 * MIN, "A10 no heartbeat, session file quiet 10 min → idle since its mtime");
}
{
	const s = decideHealth(facts({ tag: turn(NOW - 10 * MIN), sessionMtimeMs: NOW - IDLE_THRESHOLD_MS + 1 }), NOW);
	check(s.alive && !s.idle, "A11 session mtime just inside the threshold → live");
}
{
	check(decideHealth(facts({ tag: null }), NOW).alive && !decideHealth(facts({ tag: null }), NOW).idle, "A12 no tag file → live");
	const s = decideHealth(facts({ tag: "", sessionMtimeMs: NOW - 10 * MIN }), NOW);
	check(s.alive && !s.idle, "A13 an empty tag → live, the session mtime is not consulted");
}
{
	const s = decideHealth(facts({ tag: turn(NOW - 30_000), sessionMtimeMs: null }), NOW);
	check(s.alive && s.reason === "waiting-session", "A14 no session file → alive, waiting-session");
}

console.log("\nD. lease dead");
{
	const s = decideHealth(facts({ alive: false, tag: null }), NOW);
	check(!s.alive && s.reason === "not-found", "D1 no tag → not-found");
	const e = decideHealth(facts({ alive: false, tag: turn(NOW - 10 * MIN) }), NOW);
	check(!e.alive && e.reason === "not-found", "D2 a tag with no heartbeat → not-found");
}
{
	const s = decideHealth(facts({ alive: false, tag: hb(NOW - 30 * MIN, NOW - 20 * MIN) + stop() }), NOW);
	check(!s.alive && s.reason === "idle-timeout", "D3 a heartbeat carrying last → idle-timeout; the stop after it is passed over");
	check(s.lastHbMs === NOW - 20 * MIN, "D4 lastHbMs is the heartbeat's last");
	const d = new Date(NOW - 20 * MIN);
	const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	check(s.lastHbTime === hhmm, "D5 lastHbTime is that time as local HH:MM");
}
{
	const s = decideHealth(facts({ alive: false, tag: hb(NOW - 30 * MIN, NOW - 20 * MIN), tagMtimeMs: NOW - 1_000 }), NOW);
	check(!s.alive && s.reason === "starting", "D6 tag written under 2 s ago → starting, never alive");
	const e = decideHealth(facts({ alive: false, tag: "", tagMtimeMs: NOW - 1_000 }), NOW);
	check(!e.alive && e.reason === "not-found", "D7 an empty tag gets no mtime grace");
	const o = decideHealth(facts({ alive: false, tag: hb(NOW - 30 * MIN, NOW - 20 * MIN), tagMtimeMs: NOW - 2_000 }), NOW);
	check(o.reason === "idle-timeout", "D8 at 2 s the mtime grace is over");
}

console.log("\nG. spawn grace");
{
	const f = facts({ alive: false, tag: hb(NOW - 30 * MIN, NOW - 20 * MIN) });
	check(decideHealth(f, NOW, { spawnedAt: NOW - 1_000 }).reason === "starting", "G1 dead lease 1 s after the caller's spawn → starting, even over an old heartbeat");
	check(decideHealth(f, NOW, { spawnedAt: NOW - 5_000 }).reason === "idle-timeout", "G2 at 5 s the spawn grace is over");
	check(decideHealth(f, NOW, { spawnedAt: null }).reason === "idle-timeout", "G3 no spawn → no grace");
	const w = decideHealth(facts({ alive: false, tag: null, sessionMtimeMs: null }), NOW, { spawnedAt: NOW - 1_000 });
	check(!w.alive && w.reason === "waiting-session", "G4 inside the spawn grace with no session file → waiting-session");
	const a = decideHealth(facts({ tag: turn(NOW - 30_000) }), NOW, { spawnedAt: NOW - 1_000 });
	check(a.alive && a.reason === undefined, "G5 a live lease ignores the spawn grace");
}

console.log("\nX. edges of the matrix");
{
	const lastOnly = JSON.stringify({ _hb: { last: NOW - 20 * MIN } }) + "\n";
	const firstOnly = JSON.stringify({ _hb: { first: NOW - 20 * MIN } }) + "\n";
	const dead = decideHealth(facts({ alive: false, tag: lastOnly }), NOW);
	check(dead.reason === "idle-timeout" && dead.lastHbMs === NOW - 20 * MIN, "X1 dead, a heartbeat with last only → idle-timeout at that last");
	const live = decideHealth(facts({ tag: lastOnly }), NOW);
	check(live.alive && !live.idle, "X2 alive, a heartbeat with no first sets no idle-since → live");
	check(decideHealth(facts({ alive: false, tag: firstOnly }), NOW).reason === "not-found", "X3 dead, a heartbeat with no last → not-found");
	const stopped = decideHealth(facts({ tag: hb(NOW - 10 * MIN, NOW) + stop() }), NOW);
	check(stopped.alive && stopped.idle === true && stopped.idleSinceMs === NOW - 10 * MIN, "X4 alive, a stop after an idle heartbeat is passed over → idle");
	const fresh = decideHealth(facts({ tag: hb(NOW - 10 * MIN, NOW), tagMtimeMs: NOW - 500 }), NOW);
	check(fresh.alive && fresh.idle === true, "X5 alive, a tag written 0.5 s ago → still idle (the write grace is for a dead lease only)");
	const clamp = decideHealth(facts({ alive: false, tag: hb(NOW - 30 * MIN, NOW - 20 * MIN) + turn(NOW - 15 * MIN) }), NOW);
	check(clamp.reason === "idle-timeout" && clamp.lastHbMs === NOW - 20 * MIN, "X6 dead, a turn after the heartbeat does not move lastHbMs");
	const gone = decideHealth(facts({ alive: false, tag: hb(NOW - 30 * MIN, NOW - 20 * MIN), sessionMtimeMs: null }), NOW);
	const old = decideHealth(facts({ alive: false, tag: hb(NOW - 30 * MIN, NOW - 20 * MIN), sessionMtimeMs: NOW - 60 * MIN }), NOW);
	check(gone.reason === "idle-timeout" && old.reason === "idle-timeout", "X7 dead outside the spawn grace: the session file, absent or old, does not change the answer");
	const waiting = decideHealth(facts({ tag: hb(NOW - 10 * MIN, NOW), sessionMtimeMs: null }), NOW);
	check(waiting.alive && waiting.reason === "waiting-session" && !waiting.idle, "X8 alive, no session file, an idle heartbeat → waiting-session wins");
	const noTag = decideHealth(facts({ tag: null, sessionMtimeMs: NOW - 60 * MIN }), NOW);
	check(noTag.alive && !noTag.idle, "X9 alive, no tag, an old session file → live (the session mtime is read only beside a non-empty tag)");
}

console.log("\nF. health() over files");
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-"));
	const sessionPath = path.join(dir, "sess.jsonl");
	const tagsDir = path.join(dir, "wtft-tags");
	fs.mkdirSync(tagsDir);
	fs.writeFileSync(sessionPath, "{}\n");
	const tagPath = path.join(tagsDir, "sess.jsonl.wtft-tag.v0.jsonl");
	const now = Date.now();
	fs.writeFileSync(tagPath, turn(now - 10 * MIN, { ttl: "1h" }) + hb(now - 10 * MIN, now));
	fs.utimesSync(tagPath, new Date(now - 10_000), new Date(now - 10_000));
	const none = health(sessionPath, now, { tagPath });
	check(!none.alive && none.reason === "idle-timeout" && none.lastHbMs === now, "F1 no lease file → dead, stopped at the tag's last heartbeat");
	fs.writeFileSync(getDaemonPidPath(sessionPath), String(process.pid));
	const s = health(sessionPath, now, { tagPath });
	check(s.alive && s.idle === true && s.cacheTtlMs === 3_600_000, "F2 this process holds the lease → alive, idle, TTL from the tail's turn");
	const f = readHealthFacts(sessionPath, getDaemonPidPath(sessionPath), tagPath);
	check(f.holderAlive && f.tag !== null && f.tag.tail.length === 2 && f.sessionMtimeMs !== null, "F3 readHealthFacts reads lease, tag tail and session mtime");
	fs.writeFileSync(getDaemonPidPath(sessionPath), "999999999");
	check(!health(sessionPath, now, { tagPath }).alive, "F4 a lease naming no live pid → not alive");
	fs.rmSync(sessionPath);
	check(readHealthFacts(sessionPath, getDaemonPidPath(sessionPath), tagPath).sessionMtimeMs === null, "F5 no session file → sessionMtimeMs null");
	const big = turn(now - 30_000).repeat(200);
	fs.writeFileSync(tagPath, big + hb(now - 10 * MIN, now));
	const tail = readHealthFacts(sessionPath, getDaemonPidPath(sessionPath), tagPath).tag!;
	check(big.length > 8192 && tail.size === Buffer.byteLength(big) + hb(now - 10 * MIN, now).length && tail.tail.at(-1)?.kind === "heartbeat" && tail.tail.length < 200, "F6 a tag over 8 KiB: size is the whole file, the tail is its last 8 KiB and ends at its last record");
	fs.writeFileSync(sessionPath, "{}\n");
	const defaultTag = getTagPath(sessionPath);
	fs.writeFileSync(defaultTag, turn(now - 30_000) + hb(now - 10 * MIN, now));
	fs.writeFileSync(getDaemonPidPath(sessionPath), String(process.pid));
	const dflt = health(sessionPath, now);
	check(defaultTag.startsWith(tagsDir) && dflt.alive && !dflt.idle, "F7 with no tagPath, health reads getTagPath's tag (a fresh turn there clamps the heartbeat → live)");
	fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

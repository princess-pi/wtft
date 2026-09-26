#!/usr/bin/env -S bun
/**
 * HarnessRegistry in memory, no daemon process: serve → move → drop → hand-off
 * round trip. docs/spec-270-harness-registry.md § 3.
 */

import * as path from "node:path";
import {
	newRegistry, newSessionRecord, serve, get, move, isEmpty, servedOver, needsDir, projectInUse, sessionDirOf,
	markIdle, forgetIdle, expiredIdle, beginRetry, retryFired, cancelRetry, retryPending, drop, handOff, parseHandOff,
} from "../extensions/lib/harness-registry.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const ROOT = "/srv/projects/-home-me-app";
const A = path.join(ROOT, "aaaa.jsonl");
const B = path.join(ROOT, "bbbb.jsonl");
const OTHER = path.join("/srv/projects/-home-me-other", "cccc.jsonl");
const T0 = 1_700_000_000_000;

console.log("S. serve");
{
	const reg = newRegistry();
	check(isEmpty(reg), "S1 a new registry is empty");
	check(get(reg, A) === undefined, "S2 an unknown key has no record");
	const rec = newSessionRecord(A, true, T0);
	check(rec.state.sessionPath === A && rec.displayed && rec.startupTime === T0 && rec.checkedAtMs === T0, "S3 a new record carries its path, display flag and the clock");
	check(!rec.scanContinuing && rec.flushTimer === null && rec.unwatchedTreeScanAt === 0, "S4 a new record has no scan cut, no flush timer, no tree scan yet");
	serve(reg, A, rec);
	check(get(reg, A) === rec, "S5 serve → get returns the same record");
	check(!isEmpty(reg), "S6 the registry is not empty while a session is served");
	check(sessionDirOf(A) === path.join(ROOT, "aaaa"), "S7 sessionDirOf strips .jsonl");
	check(servedOver(reg, path.join(ROOT, "aaaa", "subagents")) === A, "S8 servedOver finds the session whose tree holds a directory");
	check(servedOver(reg, path.join(ROOT, "bbbb")) === null, "S9 servedOver is null for a directory in no served tree");
	check(needsDir(reg, ROOT) && needsDir(reg, path.join(ROOT, "aaaa")) && needsDir(reg, path.join(ROOT, "aaaa", "subagents", "x")), "S10 the project directory and the session's own tree are needed");
	check(!needsDir(reg, path.dirname(OTHER)), "S11 another project directory is not needed");
	check(projectInUse(reg, ROOT) && !projectInUse(reg, ROOT, A), "S12 projectInUse can except the session asking");
}

console.log("\nM. move");
{
	const reg = newRegistry();
	const rec = newSessionRecord(A, false, T0);
	serve(reg, A, rec);
	rec.scanContinuing = true;
	rec.unwatchedTreeScanAt = T0 + 5;
	const timer = setTimeout(() => {}, 1_000_000);
	timer.unref();
	rec.flushTimer = timer;
	const moved = move(reg, A, B);
	check(moved !== null && moved.record === rec, "M1 move returns the record");
	check(get(reg, B) === rec && get(reg, A) === undefined, "M2 the record is under the new key and not the old");
	check(rec.scanContinuing, "M3 a scan cut before the move carries on under the new key (#267 F)");
	check(rec.unwatchedTreeScanAt === T0 + 5, "M4 the unwatched-tree stamp travels with the record");
	check(moved !== null && moved.flushTimer === timer && rec.flushTimer === null, "M5 the flush timer is handed back to the caller and cleared from the record");
	clearTimeout(timer);
	check(servedOver(reg, path.join(ROOT, "bbbb", "subagents")) === B && servedOver(reg, path.join(ROOT, "aaaa", "subagents")) === null, "M6 the served tree follows the move");
	check(move(reg, A, B) === null, "M7 moving an unknown key returns null");
	const other = newSessionRecord(A, true, T0);
	serve(reg, A, other);
	check(move(reg, A, B) === null && get(reg, A) === other && get(reg, B) === rec, "M8 a key already held by another record refuses the move and leaves both records where they are");
	const same = move(reg, B, B);
	check(same !== null && same.record === rec && get(reg, B) === rec, "M9 moving a key onto itself is a no-op that returns the record");
}

console.log("\nI. idle");
{
	const reg = newRegistry();
	markIdle(reg, A, true, "10:1:5", T0);
	check(!isEmpty(reg), "I1 an idle-known session keeps the registry non-empty");
	check(reg.idle.get(A)?.since === T0 && reg.idle.get(A)?.sig === "10:1:5" && reg.idle.get(A)?.displayed === true, "I2 the idle record holds displayed, since and the signature");
	check(needsDir(reg, ROOT) && !needsDir(reg, path.join(ROOT, "aaaa")), "I3 an idle-known session needs its project directory watched, not its own tree");
	check(projectInUse(reg, ROOT, A), "I4 an idle-known session keeps its project in use even as the one asking");
	markIdle(reg, A, false, "11:1:6", T0 + 1000);
	check(reg.idle.get(A)?.since === T0 && reg.idle.get(A)?.sig === "11:1:6", "I5 marking again refreshes the signature and keeps the first since");
	markIdle(reg, B, true, "1:1:1", T0 + 500);
	check(expiredIdle(reg, T0 + 1000, 1000).join() === A, "I6 expiredIdle returns the keys idle for at least idleMs");
	check(expiredIdle(reg, T0 + 1000, 1001).length === 0, "I7 and none younger than that");
	forgetIdle(reg, A);
	check(reg.idle.get(A) === undefined && needsDir(reg, ROOT), "I8 forgetIdle removes the record; B still needs the project directory");
	forgetIdle(reg, B);
	check(isEmpty(reg) && !needsDir(reg, ROOT), "I9 with both forgotten the registry is empty and the directory unneeded");
	markIdle(reg, A, true, "1:1:1", T0);
	serve(reg, A, newSessionRecord(A, true, T0));
	check(reg.idle.get(A) === undefined, "I10 serving a session forgets its idle record");
}

console.log("\nR. adoption retries");
{
	const reg = newRegistry();
	const first = beginRetry(reg, A, true);
	check(first.kind === "retry" && first.tries === 1, "R1 the first retry is try 1");
	check(!isEmpty(reg) && retryPending(reg, A), "R2 a pending retry keeps the registry non-empty");
	check(beginRetry(reg, A, true).kind === "pending", "R3 a second begin while one is pending starts nothing");
	const fired = retryFired(reg, A);
	check(fired !== null && fired.displayed && fired.tries === 1 && !retryPending(reg, A), "R4 firing hands back the retry and clears pending");
	const second = beginRetry(reg, A, false);
	check(second.kind === "retry" && second.tries === 2, "R5 the next begin counts 2");
	retryFired(reg, A);
	cancelRetry(reg, A);
	check(isEmpty(reg) && retryFired(reg, A) === null, "R6 a cancelled retry is gone: empty, and a late fire returns null");
	beginRetry(reg, A, true);
	cancelRetry(reg, A);
	check(retryPending(reg, A) && !isEmpty(reg), "R7 cancelling while pending keeps the pending mark until the timer fires");
	check(retryFired(reg, A) === null && isEmpty(reg), "R8 that fire returns null and leaves nothing behind");
	const restarted = beginRetry(reg, A, true);
	check(restarted.kind === "retry" && restarted.tries === 1 && beginRetry(reg, A, true).kind === "pending", "R9 after a cancel the count restarts at 1");
	retryFired(reg, A);
	for (let i = 2; i <= 5; i++) { check((beginRetry(reg, A, true) as { tries?: number }).tries === i, `R10.${i} try ${i}`); retryFired(reg, A); }
	check(beginRetry(reg, A, true).kind === "gave-up" && isEmpty(reg) && retryFired(reg, A) === null, "R11 the sixth begin gives up and forgets the retry");
	beginRetry(reg, A, true);
	serve(reg, A, newSessionRecord(A, true, T0));
	check(retryPending(reg, A) && retryFired(reg, A) === null, "R12 serving the session cancels its retry; the pending timer still fires to nothing");
}

console.log("\nD. drop");
{
	const reg = newRegistry();
	const rec = newSessionRecord(A, true, T0);
	serve(reg, A, rec);
	const timer = setTimeout(() => {}, 1_000_000);
	timer.unref();
	rec.flushTimer = timer;
	markIdle(reg, A, true, "1:1:1", T0);
	check(get(reg, A) === rec && reg.idle.get(A) !== undefined, "D0 a session can be idle-known and served at once, as a drop for idling marks it before dropping");
	const dropped = drop(reg, A);
	check(dropped.record === rec && dropped.flushTimer === timer, "D1 drop hands back the record and its flush timer");
	clearTimeout(timer);
	check(get(reg, A) === undefined, "D2 the record is gone");
	check(reg.idle.get(A)?.since === T0, "D3 the idle record stays after the drop");
	const none = drop(reg, B);
	check(none.record === null && none.flushTimer === null, "D4 dropping an unknown key returns nulls");
	beginRetry(reg, B, true);
	drop(reg, B);
	check(retryPending(reg, B) && retryFired(reg, B) === null, "D5 drop cancels a retry for the key");
}

console.log("\nH. hand-off");
{
	const reg = newRegistry();
	const a = newSessionRecord(A, true, T0);
	const b = newSessionRecord(B, false, T0);
	serve(reg, A, a);
	serve(reg, B, b);
	markIdle(reg, OTHER, true, "9:9:9", T0 - 5);
	beginRetry(reg, path.join(ROOT, "dddd.jsonl"), false);
	const lines = handOff(reg, (r) => r !== b);
	check(lines.length === 3, "H1 one line per served-and-kept, retrying and idle session");
	check(lines[0] === JSON.stringify({ kind: "served", displayed: true, path: A }), "H2 a served line");
	check(lines[1] === JSON.stringify({ kind: "served", displayed: false, path: path.join(ROOT, "dddd.jsonl") }), "H3 a retrying session is handed on as served");
	check(lines[2] === JSON.stringify({ kind: "idle", displayed: true, path: OTHER, since: T0 - 5, sig: "9:9:9" }), "H4 an idle line carries since and sig");
	const withAdopting = handOff(reg, () => true, { key: path.join(ROOT, "eeee.jsonl"), displayed: true });
	check(withAdopting.length === 5 && withAdopting[2] === JSON.stringify({ kind: "served", displayed: true, path: path.join(ROOT, "eeee.jsonl") }), "H5 a session being adopted is handed on as served, after the served ones");
	check(handOff(reg, () => true, { key: A, displayed: false }).length === 4, "H6 an adopting key already served is not listed twice");
	const parsed = parseHandOff(withAdopting.join("\n") + "\nnot json\n" + JSON.stringify({ kind: "served", displayed: true, path: "relative.jsonl" }) + "\n" + JSON.stringify({ kind: "served", displayed: true, path: "/elsewhere/x.jsonl" }) + "\n", "/srv/projects");
	check(parsed.unreadable === 1 && parsed.records.length === 5, "H7 parseHandOff counts the line that does not parse and skips a relative or out-of-root path");
	const again = newRegistry();
	for (const r of parsed.records) {
		if (r.kind === "served") serve(again, r.path, newSessionRecord(r.path, r.displayed, T0));
		else markIdle(again, r.path, r.displayed, r.sig ?? "", r.since ?? T0);
	}
	check(handOff(again, () => true).join("\n") === withAdopting.join("\n"), "H8 round trip: the parsed lines served into a fresh registry hand off the same text");
	const blank = parseHandOff("\n\n", "/srv");
	check(blank.records.length === 0 && blank.unreadable === 0, "H9 blank lines are neither records nor unreadable");
	const nul = parseHandOff("null\n42\n", "/srv");
	check(nul.records.length === 0 && nul.unreadable === 2, "H10 a JSON line that is not an object is unreadable, not a throw");
	const dots = parseHandOff(JSON.stringify({ kind: "served", displayed: true, path: "/srv/a/../../etc/x.jsonl" }) + "\n" + JSON.stringify({ kind: "served", displayed: true, path: "/srv/a/../b/y.jsonl" }), "/srv");
	check(dots.records.length === 1 && dots.records[0].path === "/srv/b/y.jsonl", "H11 a path that resolves outside the root is skipped; one that resolves inside comes back resolved");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

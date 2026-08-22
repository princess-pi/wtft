#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/wtft-issue-155-daemon-follow.test.ts — daemon follows a moved session (#155)
 *
 * A worktree switch MOVES a transcript between project dirs. The daemon polled by
 * path and exited ("session removed"); the singleton key was derived from that
 * path, so a run from the new directory would have spawned a second daemon; and
 * the reaper SIGTERMs any daemon whose cmdline session path no longer exists.
 *
 * PART C spawns a real daemon, moves its transcript out from under it, and
 * asserts it keeps parsing into the SAME tag file — one daemon, moving input,
 * fixed output.
 *
 * Run: node --experimental-strip-types tests/wtft-issue-155-daemon-follow.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { trackSandbox } from "./lib/sandbox";

import {
	getDaemonPidPath,
	getTagPath,
	getCurrentVersionTagPath,
	isSessionIdBasename,
	resolveMovedSession,
	resetCwdCache,
	resetHarnessRegistry,
	cwdToSlug,
	WTFT_TAGGER_VERSION,
} from "../bin/wtft.mjs";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DAEMON = path.join(REPO, "bin", "wtft-daemon.mjs");

const tmpRoots: string[] = [];
const children: ChildProcess[] = [];
const pidFiles: string[] = [];
function mktmp(prefix: string): string {
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	tmpRoots.push(dir);
	return dir;
}
function cleanup() {
	for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
	for (const p of pidFiles) { try { fs.unlinkSync(p); } catch {} }
	for (const dir of tmpRoots) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** One Claude-shaped assistant turn recording `cwd`. */
function turnLine(id: string, cwd: string, ts: string): string {
	return JSON.stringify({
		type: "assistant", cwd,
		message: {
			role: "assistant", id, model: "claude-sonnet-4-5", timestamp: ts,
			usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
			content: [{ type: "text", text: "work" }],
		},
	});
}

console.log("\n=== PART A: the singleton key survives a move ===\n");
{
	// Real session basenames carry a UUID — that is what makes them a usable
	// identity across project dirs (#157).
	const ID1 = "b1f54c2f-5140-4934-8075-c21e2339f4e2.jsonl";
	const ID2 = "9890440e-05ad-421c-bc03-cd0b845aea42.jsonl";
	const a = `/home/tester/.claude/projects/-home-tester-demo/${ID1}`;
	const b = `/home/tester/.claude/projects/-home-tester-worktrees-demo-9/${ID1}`;
	check(getDaemonPidPath(a) === getDaemonPidPath(b), "same session in two project dirs → one PID file");

	const other = `/home/tester/.claude/projects/-home-tester-demo/${ID2}`;
	check(getDaemonPidPath(a) !== getDaemonPidPath(other), "two distinct sessions → distinct PID files");

	// Pi's shape also carries a UUID.
	const pi1 = `/home/tester/.pi/agent/sessions/--home-tester-demo--/2026-08-06T23-19-38-943Z_019fd960-0ebf-7fb2-85ed-798b50f61b8e.jsonl`;
	const pi2 = `/home/tester/.pi/agent/sessions/--elsewhere--/2026-08-06T23-19-38-943Z_019fd960-0ebf-7fb2-85ed-798b50f61b8e.jsonl`;
	check(getDaemonPidPath(pi1) === getDaemonPidPath(pi2), "Pi session basenames are identities too");

	// The #157 gate: a basename that is NOT a session id is not an identity, so
	// it keeps the pre-#155 full-path key. Two fixtures both named session.jsonl
	// in different directories must NOT share a daemon lease.
	const plainA = "/tmp/wtft-fixture-a/session.jsonl";
	const plainB = "/tmp/wtft-fixture-b/session.jsonl";
	check(getDaemonPidPath(plainA) !== getDaemonPidPath(plainB),
		"non-UUID basenames stay path-keyed — same-named files do not collide (#157)");
	check(isSessionIdBasename(a) && !isSessionIdBasename(plainA),
		"isSessionIdBasename distinguishes a session id from an arbitrary filename");
	check(
		path.basename(getDaemonPidPath(a)).startsWith("wtft-daemon-") &&
		getDaemonPidPath(a).endsWith(".pid"),
		"PID file naming is unchanged (--list/--cleanup still find it)"
	);
}

console.log("\n=== PART B: tag path resolution across project dirs ===\n");
{
	const projects = mktmp("wtft-155-b-");
	const ownSlug = cwdToSlug("/home/tester/demo");
	const sibSlug = cwdToSlug("/home/tester/worktrees/demo/9");
	const base = "3f2b7c11-9d4e-4a6b-8c25-77aa1e93b0d4.jsonl";

	const ownSession = path.join(projects, ownSlug, base);
	fs.mkdirSync(path.dirname(ownSession), { recursive: true });
	fs.writeFileSync(ownSession, "");

	const current = `${base}.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`;
	const sibTag = path.join(projects, sibSlug, "wtft-tags", current);
	fs.mkdirSync(path.dirname(sibTag), { recursive: true });
	fs.writeFileSync(sibTag, "");

	// Own dir holds only a STALE-version tag; the sibling holds the current one.
	const staleTag = path.join(projects, ownSlug, "wtft-tags", `${base}.wtft-tag.v0.0.1.jsonl`);
	fs.mkdirSync(path.dirname(staleTag), { recursive: true });
	fs.writeFileSync(staleTag, "");

	check(getTagPath(ownSession) === sibTag, "sibling current-version tag outranks a stale own-dir tag");
	check(getCurrentVersionTagPath(ownSession) === sibTag, "a writer adopts the sibling current-version tag");

	// Now the own dir gets the current version too — it wins.
	const ownTag = path.join(projects, ownSlug, "wtft-tags", current);
	fs.writeFileSync(ownTag, "");
	check(getTagPath(ownSession) === ownTag, "own-dir current-version tag outranks a sibling");
	check(getCurrentVersionTagPath(ownSession) === ownTag, "…for writers too");

	// No tag anywhere → the own-dir default, never a stale-version filename.
	const fresh = path.join(projects, ownSlug, "sess-fresh.jsonl");
	fs.writeFileSync(fresh, "");
	check(
		getCurrentVersionTagPath(fresh) ===
			path.join(projects, ownSlug, "wtft-tags", `sess-fresh.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`),
		"a fresh session gets the own-dir current-version default"
	);

	// The #157 gate on the other cross-dir behaviour: a non-session path must
	// never trigger a sibling scan, or getTagPath walks the grandparent of an
	// arbitrary directory (for /tmp/<fixture>/session.jsonl, that is /tmp).
	const plain = path.join(projects, ownSlug, "session.jsonl");
	fs.writeFileSync(plain, "");
	const plainSibTag = path.join(projects, sibSlug, "wtft-tags", `session.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	fs.writeFileSync(plainSibTag, "");
	check(
		getTagPath(plain) === path.join(projects, ownSlug, "wtft-tags", `session.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`),
		"a non-UUID basename does not reach into sibling dirs (#157)"
	);
}

console.log("\n=== PART C: a live daemon follows its transcript ===\n");
{
	const projects = mktmp("wtft-155-c-");
	process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
	resetCwdCache();
	resetHarnessRegistry();

	const cwdA = "/home/tester/git-projects/demo";
	const cwdB = "/home/tester/worktrees/demo/155-branch";
	const base = "7c9e1a44-2f80-4d3e-9b17-5ac6de210f38.jsonl";
	const dirA = path.join(projects, cwdToSlug(cwdA));
	const dirB = path.join(projects, cwdToSlug(cwdB));
	fs.mkdirSync(dirA, { recursive: true });
	fs.mkdirSync(dirB, { recursive: true });

	const pathA = path.join(dirA, base);
	const pathB = path.join(dirB, base);
	fs.writeFileSync(pathA, turnLine("m1", cwdA, "2026-08-01T00:00:00Z") + "\n");

	const pidPath = getDaemonPidPath(pathA);
	pidFiles.push(pidPath);
	try { fs.unlinkSync(pidPath); } catch {}

	const child = spawn(process.execPath, [DAEMON, "--session", pathA], {
		stdio: ["ignore", "ignore", "pipe"],
		env: { ...process.env, WTFT_DAEMON_DEBUG: "1", WTFT_CLAUDE_PROJECTS_DIR: projects },
	});
	children.push(child);
	let stderr = "";
	child.stderr?.on("data", (d) => { stderr += d.toString(); });

	// Let it claim the lease and write the first tag lines.
	await sleep(1500);
	const tagPath = getCurrentVersionTagPath(pathA);
	check(fs.existsSync(tagPath), "daemon started and created its tag file");
	const linesBefore = fs.readFileSync(tagPath, "utf8").split("\n").filter(l => l.trim() && !l.includes('"_hb"')).length;

	// The worktree switch: the transcript MOVES (one file, same inode, new dir).
	fs.renameSync(pathA, pathB);
	await sleep(1500);
	check(child.exitCode === null, "daemon is still alive after its path vanished");
	check(stderr.includes("session moved"), "daemon logged the move rather than shutting down");
	check(!stderr.includes("shutdown: session removed"), "daemon did NOT shut down reporting the session as removed");

	// New work arrives at the new location — the daemon must still parse it.
	fs.appendFileSync(pathB, turnLine("m2", cwdB, "2026-08-01T00:05:00Z") + "\n");
	await sleep(2000);
	check(fs.existsSync(tagPath), "the tag path is unchanged — an attached --watch survives");
	const linesAfter = fs.readFileSync(tagPath, "utf8").split("\n").filter(l => l.trim() && !l.includes('"_hb"')).length;
	check(linesAfter > linesBefore, `daemon kept parsing after the move (${linesBefore} → ${linesAfter} tagged lines)`);

	// Exactly one daemon: the PID file is keyed on the basename, so a lookup
	// from the NEW path finds the SAME lease.
	check(getDaemonPidPath(pathB) === pidPath, "a run from the new directory resolves the same PID file");
	check(fs.readFileSync(pidPath, "utf8").trim() === String(child.pid), "…still held by the original daemon (no second one)");

	// resolveMovedSession is the primitive under all of this.
	check(resolveMovedSession(pathA) === pathB, "resolveMovedSession finds the transcript's new home");

	// Genuine deletion still shuts the daemon down.
	fs.unlinkSync(pathB);
	resetCwdCache();
	check(resolveMovedSession(pathB) === null, "a deleted session resolves to null");
	await sleep(2500);
	check(child.exitCode === 0, "daemon exits cleanly when the session is genuinely gone");
	check(stderr.includes("shutdown: session removed"), "…reporting 'session removed' as the reason");

	delete process.env.WTFT_CLAUDE_PROJECTS_DIR;
	resetCwdCache();
	resetHarnessRegistry();
}

console.log("\n=== PART D: the reaper does not shoot a moved daemon ===\n");
{
	const projects = mktmp("wtft-155-d-");
	process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
	resetCwdCache();
	resetHarnessRegistry();

	const base = "d41c8b60-3a52-4f19-8e77-90bb2cd541aa.jsonl";
	const oldPath = path.join(projects, cwdToSlug("/home/tester/demo"), base);
	const newPath = path.join(projects, cwdToSlug("/home/tester/worktrees/demo/1"), base);
	fs.mkdirSync(path.dirname(newPath), { recursive: true });
	fs.mkdirSync(path.dirname(oldPath), { recursive: true });
	fs.writeFileSync(newPath, turnLine("r1", "/home/tester/worktrees/demo/1", "2026-08-01T00:00:00Z") + "\n");

	// The reaper's kill predicate is "path missing AND not resolvable elsewhere".
	check(!fs.existsSync(oldPath), "the old cmdline path is indeed gone");
	check(resolveMovedSession(oldPath) === newPath, "…but the session resolves to its new home, so it must not be reaped");

	const goner = path.join(projects, cwdToSlug("/home/tester/demo"), "0f9a7c23-6b41-4d88-a5e2-31cc70de9b14.jsonl");
	check(
		!fs.existsSync(goner) && resolveMovedSession(goner) === null,
		"a genuinely deleted session stays reapable"
	);

	delete process.env.WTFT_CLAUDE_PROJECTS_DIR;
	resetCwdCache();
	resetHarnessRegistry();
}

cleanup();
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

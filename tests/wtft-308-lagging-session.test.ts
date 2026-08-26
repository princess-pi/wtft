#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-308-lagging-session
 * @description A session .jsonl that does not exist YET is not "not found" (#308).
 *
 *   Claude Code knows the session id — and therefore the transcript path — at
 *   launch, but writes the first line only after the first real prompt (not a
 *   /command) completes. The daemon has waited for that file since #124/#129;
 *   the CLI still hard-failed with "does not exist" / exit 1. This suite pins
 *   the CLI's new contract on a path that is absent at the first call and
 *   appears later:
 *
 *   1. non-watch: exit 0, states the fact (log not written yet), no "not
 *      found" / "does not exist" copy, and the daemon it spawned is alive and
 *      waiting on the lease.
 *   2. once the session is written, a second non-watch run renders the chart.
 *   3. --watch on the absent path renders a waiting line (no 5 s clock-out),
 *      then renders the chart when the file appears; 'q' exits 0.
 *
 *   4. the startup reaper (#130) no longer treats "not written yet" as "gone":
 *      a daemon parked on an absent session survives another daemon's startup
 *      pass — before #308 it was SIGTERMed (and SIGTERMed itself), so the
 *      #124 "waiting for session .jsonl" state was unreachable by a live daemon.
 *      A session that once existed and was removed is still reaped.
 *
 *   PR #309 review added two more, both about waiting on daemon STATE without
 *   ever asking whether that state can arrive:
 *
 *   5. the reader must RESOLVE its tag path, not assume the own dir. A session
 *      that moved project dirs (#155) leaves its daemon writing to a sibling
 *      dir's tag file, and the daemon that replaces it adopts the same sibling
 *      path (getCurrentVersionTagPath). The own-dir path the CLI hand-built can
 *      therefore never appear, and (3)'s wait loop has no exit for "lease alive,
 *      own file never arrives" — `--watch` hung forever.
 *   6. "the daemon is running and waiting on it" must be a checked fact. The
 *      pending-session branch printed it and exited 0 straight after spawn; a
 *      daemon that dies during startup made that a false success.
 *
 *   Every wait in here is a poll on a real predicate with a generous ceiling —
 *   never a bare sleep standing in for a state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawn } from "node:child_process";
import { getDaemonPidPath, WTFT_TAGGER_VERSION, awaitDaemonUp } from "../extensions/lib/wtft-daemon-lib.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { pollUntil } from "./lib/poll";

// Private pid namespace for this suite (#486). Must precede the first
// getDaemonPidPath() and the first daemon spawn. Beyond the lease race this
// also isolates the CLI's reap-warning banner: on a shared /tmp it reports
// abandoned fixture dirs left by every OTHER suite (wtft-watch-test-*,
// wtft-title-layout-*, wtft-155-c-*), which is what broke "non-watch exits 0"
// in part 5 — the assertion was reading another suite's litter.
isolateTmpdir("lagging-session");

// Bun 1.3.14 does NOT give a child the runtime mutation isolateTmpdir just made
// to process.env — and it is inconsistent about it: async `spawn` inherits it,
// `execSync` and `spawnSync` inherit the env this process STARTED with. Node
// propagates in every case. Passing `env` explicitly is the only portable form,
// so every sync child below takes CHILD_ENV. Without it this suite fails worse
// than the flake it fixes: the CLI's daemon lands in the real /tmp while the
// suite looks for its lease in the sandbox, so "daemon spawned and holds the
// lease while waiting" fails 4 of 4 rather than 4 of 10.
// Pinned against the live runtime by tests/bun-env-propagation.test.ts.
const CHILD_ENV = process.env;

const SCRIPT = path.resolve(import.meta.dirname, "..", "wtft");
const RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function assert(label: string, ok: boolean, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n       ${detail}` : ""}`); failed++; }
}
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}
function readPid(pidPath: string): number {
	try { return parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10) || 0; } catch { return 0; }
}
/** Copy that must never appear for a path that is merely late. */
const FORBIDDEN = [/not found/i, /does not exist/i, /invalid/i];
const hasForbidden = (s: string) => FORBIDDEN.some(re => re.test(stripAnsi(s)));

// A Claude-style UUID basename — the daemon keys its lease on it (#155).
const SESSION_ID = "308c0de0-1a9b-4c3d-9e8f-000000000308";
const TS = Date.now();
function sessionLines(): string {
	return [
		JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant", id: "msg_308_001", model: "claude-sonnet-4-20250514",
				timestamp: new Date(TS - 600_000).toISOString(),
				usage: { input_tokens: 2000, output_tokens: 500 },
				content: [{ type: "tool_use", name: "write", input: { file_path: "src/main.ts" } }],
			},
		}),
		JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant", id: "msg_308_002", model: "claude-sonnet-4-20250514",
				timestamp: new Date(TS - 300_000).toISOString(),
				usage: { input_tokens: 500, output_tokens: 200 },
				content: [{ type: "tool_use", name: "bash", input: { command: "git diff --stat" } }],
			},
		}),
	].join("\n") + "\n";
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-308-")));
const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);
const pidPath = getDaemonPidPath(sessionPath);
try { fs.unlinkSync(pidPath); } catch {}
const spawnedPids = new Set<number>();
const cleanup = () => {
	for (const pid of spawnedPids) { try { process.kill(pid, "SIGTERM"); } catch {} }
	const pid = readPid(pidPath);
	if (pid > 0) { try { process.kill(pid, "SIGTERM"); } catch {} }
	try { fs.unlinkSync(pidPath); } catch {}
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
};
process.on("exit", cleanup);

// ---
// 1. Non-watch on an absent path: a fact, exit 0, daemon waiting.
// ---
console.log("1. Non-watch, session .jsonl not written yet");
{
	let out = "", code = 0;
	try {
		out = execSync(`${SCRIPT} -s '${sessionPath}' -l 5 --no-emoji 2>&1`, { encoding: "utf8", env: CHILD_ENV, timeout: 15_000 });
	} catch (err: any) {
		out = `${err.stdout || ""}${err.stderr || ""}`;
		code = err.status ?? 1;
	}
	assert("exit 0", code === 0, `exit ${code}: ${stripAnsi(out).trim()}`);
	assert("no 'not found' / 'does not exist' / 'invalid' copy", !hasForbidden(out), stripAnsi(out).trim());
	assert("states the fact: log not written yet", /not written yet/i.test(stripAnsi(out)), stripAnsi(out).trim());
	assert("names the path it is waiting on", out.includes(sessionPath));

	const claimed = await pollUntil(() => readPid(pidPath) > 0 && isAlive(readPid(pidPath)), 15_000);
	const pid = readPid(pidPath);
	if (pid > 0) spawnedPids.add(pid);
	assert("daemon spawned and holds the lease while waiting", claimed, `pidPath=${pidPath} pid=${pid}`);
	assert("session file still absent (the CLI did not create it)", !fs.existsSync(sessionPath));
}

// ---
// 2. Session appears → the SAME waiting daemon parses it → chart renders.
// ---
console.log("\n2. Session written after the fact → chart");
{
	const pidBefore = readPid(pidPath);
	fs.writeFileSync(sessionPath, sessionLines());
	const tagsDir = path.join(dir, "wtft-tags");
	const gotData = await pollUntil(() => {
		try {
			return fs.readdirSync(tagsDir).some(f => {
				if (!f.startsWith(SESSION_ID)) return false;
				const c = fs.readFileSync(path.join(tagsDir, f), "utf8");
				return c.split("\n").some(l => l.trim() && !l.includes('"_hb"') && !l.includes('"_meta"'));
			});
		} catch { return false; }
	}, 10_000, 250);
	assert("waiting daemon classified the late-written session", gotData);
	assert("still the same daemon (no second spawn)", readPid(pidPath) === pidBefore, `before=${pidBefore} after=${readPid(pidPath)}`);

	let out = "", code = 0;
	try {
		out = execSync(`${SCRIPT} -s '${sessionPath}' -l 5 --no-emoji 2>&1`, { encoding: "utf8", env: CHILD_ENV, timeout: 15_000 });
	} catch (err: any) {
		out = `${err.stdout || ""}${err.stderr || ""}`;
		code = err.status ?? 1;
	}
	assert("second run exits 0", code === 0, stripAnsi(out).trim());
	assert("second run renders bars", /[█░▒▓]/.test(out) || /\$\d/.test(stripAnsi(out)), stripAnsi(out).trim());
}

// ---
// 3. --watch on an absent path: waits on state, renders when the file appears.
// ---
console.log("\n3. --watch, session .jsonl not written yet");
{
	const dir2 = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-308w-")));
	const SESSION_ID_2 = "308c0de0-1a9b-4c3d-9e8f-000000000309";
	const sessionPath2 = path.join(dir2, `${SESSION_ID_2}.jsonl`);
	const pidPath2 = getDaemonPidPath(sessionPath2);
	try { fs.unlinkSync(pidPath2); } catch {}

	let output = "";
	let exitCode: number | null = null;
	const s = spawn("script", ["-q", "-c", `${SCRIPT} --watch -s '${sessionPath2}' -l 5 --no-emoji 2>&1`, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
	s.stdout.on("data", (d: Buffer) => { output += d.toString(); });
	s.stderr.on("data", (d: Buffer) => { output += d.toString(); });
	s.on("exit", (code) => { exitCode = code; });

	// Past the old 5 s clock: still running, still waiting, no failure copy.
	const waiting = await pollUntil(() => /waiting for session/i.test(stripAnsi(output)), 15_000);
	assert("renders a waiting line while the session is absent", waiting, stripAnsi(output).slice(-400));
	await pollUntil(() => exitCode !== null, 6_500); // deliberately outlast the retired 5 s ceiling
	assert("still running after 6.5 s (no clock-out)", exitCode === null, `exit=${exitCode} ${stripAnsi(output).slice(-400)}`);
	assert("no 'not found' / 'did not create' failure copy", !hasForbidden(output) && !/did not create/i.test(output), stripAnsi(output).slice(-400));

	fs.writeFileSync(sessionPath2, sessionLines());
	const charted = await pollUntil(() => /[█░▒▓]/.test(output), 15_000, 250);
	assert("chart renders once the session is written", charted, stripAnsi(output).slice(-600));

	s.stdin.write("q");
	const exited = await pollUntil(() => exitCode !== null, 10_000);
	if (!exited) s.kill();
	assert("'q' exits 0", exitCode === 0, `exit=${exitCode}`);

	const pid2 = readPid(pidPath2);
	if (pid2 > 0) { try { process.kill(pid2, "SIGTERM"); } catch {} }
	try { fs.unlinkSync(pidPath2); } catch {}
	try { fs.rmSync(dir2, { recursive: true, force: true }); } catch {}
}

// ---
// 4. Reaper: "not written yet" is not "gone"; "was written, now removed" still is.
// ---
console.log("\n4. Startup reaper distinguishes never-written from removed");
{
	const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
	const dirA = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-308r-")));
	const pathA = path.join(dirA, "308c0de0-1a9b-4c3d-9e8f-00000000030a.jsonl"); // never written
	const pathB = path.join(dirA, "308c0de0-1a9b-4c3d-9e8f-00000000030b.jsonl"); // written, then removed
	const pathC = path.join(dirA, "308c0de0-1a9b-4c3d-9e8f-00000000030c.jsonl"); // the newcomer whose startup reaps
	const pids: number[] = [];
	const spawnDaemon = (p: string) => {
		const c = spawn(process.execPath, [DAEMON, "--session", p], { detached: true, stdio: "ignore" });
		c.unref();
		if (c.pid) pids.push(c.pid);
		return c;
	};
	const leaseOf = (p: string) => readPid(getDaemonPidPath(p));

	const a = spawnDaemon(pathA);
	fs.writeFileSync(pathB, sessionLines());
	const b = spawnDaemon(pathB);
	assert("A (never-written) claims its lease", await pollUntil(() => leaseOf(pathA) > 0 && isAlive(leaseOf(pathA)), 15_000));
	assert("B (written) claims its lease", await pollUntil(() => leaseOf(pathB) > 0 && isAlive(leaseOf(pathB)), 15_000));
	// B must have parsed something — that is the "session existed" evidence the reaper reads.
	const tagsDir = path.join(dirA, "wtft-tags");
	assert("B classified its session", await pollUntil(() => {
		try {
			return fs.readdirSync(tagsDir).some(f => f.startsWith(path.basename(pathB)) &&
				fs.readFileSync(path.join(tagsDir, f), "utf8").split("\n").some(l => l.trim() && !l.includes('"_hb"') && !l.includes('"_meta"')));
		} catch { return false; }
	}, 10_000, 250));
	fs.unlinkSync(pathB); // B's session is now genuinely gone
	const pidA = leaseOf(pathA), pidB = leaseOf(pathB);

	// Newcomer C: its startup reapAndWarn() sweeps every lease.
	fs.writeFileSync(pathC, sessionLines());
	spawnDaemon(pathC);
	assert("C claims its lease (its startup reap ran)", await pollUntil(() => leaseOf(pathC) > 0 && isAlive(leaseOf(pathC)), 15_000));
	const bGone = await pollUntil(() => !isAlive(pidB), 10_000);
	assert("B (session removed) was reaped", bGone, `pidB=${pidB}`);
	assert("A (session never written) survived the reap", isAlive(pidA) && leaseOf(pathA) === pidA, `pidA=${pidA} lease=${leaseOf(pathA)}`);
	assert("A's own exit code is still open (it did not SIGTERM itself)", a.exitCode === null && a.signalCode === null, `exit=${a.exitCode} sig=${a.signalCode}`);
	void b;

	for (const p of [pathA, pathB, pathC]) { const pid = leaseOf(p); if (pid > 0) { try { process.kill(pid, "SIGTERM"); } catch {} } try { fs.unlinkSync(getDaemonPidPath(p)); } catch {} }
	for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
	try { fs.rmSync(dirA, { recursive: true, force: true }); } catch {}
}

// ---
// 5. The reader resolves its tag path — a sibling-dir tag (#155) is not a hang.
//
// Built as the real move: a daemon classifies the session in proj-a, the
// transcript is then moved to proj-b and the daemon stopped. The tag file stays
// in proj-a, which is exactly where the NEXT daemon writes too
// (getCurrentVersionTagPath adopts it), so proj-b/wtft-tags/ never appears.
// A reader that hand-builds the own-dir path waits on a file nobody will write.
// ---
console.log("\n5. Tag file in a sibling project dir (#155 move)");
{
	const DAEMON5 = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
	const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-308s-")));
	const slugA = path.join(root, "proj-a");   // where the tag file was, and stays
	const slugB = path.join(root, "proj-b");   // where the transcript lives now
	fs.mkdirSync(slugA); fs.mkdirSync(slugB);
	const SESSION_ID_5 = "308c0de0-1a9b-4c3d-9e8f-00000000030d";
	const pathA = path.join(slugA, `${SESSION_ID_5}.jsonl`);
	const pathB = path.join(slugB, `${SESSION_ID_5}.jsonl`);
	// One lease for both paths: it is keyed on the session-UUID basename (#155).
	const pidPath5 = getDaemonPidPath(pathB);
	try { fs.unlinkSync(pidPath5); } catch {}
	const sibTag = path.join(slugA, "wtft-tags", `${SESSION_ID_5}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const ownTag = path.join(slugB, "wtft-tags", `${SESSION_ID_5}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const hasClassified = (f: string) => {
		try {
			return fs.readFileSync(f, "utf8").split("\n")
				.some(l => l.trim() && !l.includes('"_hb"') && !l.includes('"_meta"'));
		} catch { return false; }
	};

	fs.writeFileSync(pathA, sessionLines());
	const d5 = spawn(process.execPath, [DAEMON5, "--session", pathA], { detached: true, stdio: "ignore" });
	d5.unref();
	if (d5.pid) spawnedPids.add(d5.pid);
	assert("a daemon classified the session in proj-a", await pollUntil(() => hasClassified(sibTag), 10_000, 250), sibTag);

	// The move: transcript to proj-b, tag file left behind, daemon stopped.
	const pid5 = readPid(pidPath5);
	if (pid5 > 0) { try { process.kill(pid5, "SIGTERM"); } catch {} }
	await pollUntil(() => !isAlive(pid5), 10_000);
	try { fs.unlinkSync(pidPath5); } catch {}
	fs.renameSync(pathA, pathB);
	assert("proj-b holds no tag file of its own", !fs.existsSync(ownTag), ownTag);

	// Non-watch: the chart is in the sibling file; "no data yet" would be a lie.
	{
		let out = "", code = 0;
		try {
			out = execSync(`${SCRIPT} -s '${pathB}' -l 5 --no-emoji 2>&1`, { encoding: "utf8", env: CHILD_ENV, timeout: 20_000 });
		} catch (err: any) {
			out = `${err.stdout || ""}${err.stderr || ""}`;
			code = err.status ?? 1;
		}
		const pidNow = readPid(pidPath5);
		if (pidNow > 0) spawnedPids.add(pidNow);
		assert("non-watch exits 0", code === 0, stripAnsi(out).trim());
		assert("non-watch renders the sibling dir's data", /[█░▒▓]/.test(out) || /\$\d/.test(stripAnsi(out)), stripAnsi(out).trim());
		assert("non-watch does not claim 'no data yet'", !/no data yet/i.test(stripAnsi(out)), stripAnsi(out).trim());
	}

	// --watch: the hang. Before the fix nothing ever renders and 'q' is the only exit.
	{
		let output = "";
		let exitCode: number | null = null;
		const s = spawn("script", ["-q", "-c", `${SCRIPT} --watch -s '${pathB}' -l 5 --no-emoji 2>&1`, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
		s.stdout.on("data", (d: Buffer) => { output += d.toString(); });
		s.stderr.on("data", (d: Buffer) => { output += d.toString(); });
		s.on("exit", (code) => { exitCode = code; });

		const charted = await pollUntil(() => /[█░▒▓]/.test(output), 20_000, 250);
		assert("--watch renders instead of hanging on a file nobody writes", charted, stripAnsi(output).slice(-600));
		assert("--watch is still running (it did not error out)", exitCode === null, `exit=${exitCode}`);

		s.stdin.write("q");
		const exited = await pollUntil(() => exitCode !== null, 10_000);
		if (!exited) s.kill();
		assert("'q' exits 0", exitCode === 0, `exit=${exitCode}`);
	}

	const pidEnd = readPid(pidPath5);
	if (pidEnd > 0) { try { process.kill(pidEnd, "SIGTERM"); } catch {} }
	try { fs.unlinkSync(pidPath5); } catch {}
	try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

// ---
// 6. "The daemon is running and waiting on it" is a claim, so it must be checked.
//
// Failure is injected structurally, not by timing: run a copy of wtft.mjs from a
// directory with no wtft-daemon.mjs beside it. spawn() still succeeds (nothing
// throws), so the CLI holds a live child handle that dies moments later — the
// exact shape of a daemon that fails during startup.
// ---
console.log("\n6. Pending session + a daemon that dies during startup");
{
	const fakeBin = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-308d-")));
	fs.copyFileSync(path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs"), path.join(fakeBin, "wtft.mjs"));
	const dir6 = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-308p-")));
	const SESSION_ID_6 = "308c0de0-1a9b-4c3d-9e8f-00000000030e";
	const path6 = path.join(dir6, `${SESSION_ID_6}.jsonl`); // never written
	const pidPath6 = getDaemonPidPath(path6);
	try { fs.unlinkSync(pidPath6); } catch {}

	let out = "", code = 0;
	try {
		out = execSync(`${process.execPath} '${path.join(fakeBin, "wtft.mjs")}' -s '${path6}' -l 5 --no-emoji 2>&1`, { encoding: "utf8", env: CHILD_ENV, timeout: 20_000 });
	} catch (err: any) {
		out = `${err.stdout || ""}${err.stderr || ""}`;
		code = err.status ?? 1;
	}
	const clean = stripAnsi(out).trim();
	// Exit 1 specifically, not merely nonzero (#513). #443 added exit 9 for a
	// PROVISIONAL read — a successful render whose total may still grow — and a
	// `code !== 0` assertion accepts that as though it were the daemon-death
	// failure this case is about. It cannot happen on this path today, because
	// the death branch returns before the provisional check, but an assertion
	// that would pass for the wrong reason is one refactor away from doing so.
	assert("exits 1 when the daemon it spawned died", code === 1, `exit ${code}: ${clean}`);
	assert("names the daemon as the failure", /daemon/i.test(clean), clean);
	assert("does not claim the daemon is running and waiting", !/running and waiting/i.test(clean), clean);
	assert("left no lease behind", readPid(pidPath6) === 0 || !isAlive(readPid(pidPath6)));

	try { fs.unlinkSync(pidPath6); } catch {}
	try { fs.rmSync(fakeBin, { recursive: true, force: true }); } catch {}
	try { fs.rmSync(dir6, { recursive: true, force: true }); } catch {}
}

// ---
// 7. awaitDaemonUp: the lease is the proof; a tag file is not (#309 review, round 2).
//
// Three unit cases with the child stood in by a bare node process, so exit
// codes and signals are chosen, not raced:
//   a. leftover current-version tag file + child that exits 1 + no lease → dead
//      (a stale tag from a previous run must not read as "up")
//   b. child killed by SIGKILL, no lease, no tag → dead, with the signal named
//   c. child exits 0 while another process holds the lease → up (singleton)
// ---
console.log("\n7. awaitDaemonUp proof rules");
{
	const mk = (id: string) => {
		const d = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-308u-")));
		const sp = path.join(d, `${id}.jsonl`);
		const pp = getDaemonPidPath(sp);
		try { fs.unlinkSync(pp); } catch {}
		return { d, sp, pp };
	};
	const waitExit = (c: ReturnType<typeof spawn>) => new Promise<void>(res => { if (c.exitCode !== null || c.signalCode !== null) res(); else c.once("exit", () => res()); });

	// a. leftover tag file, child dies with code 1, nobody holds the lease
	{
		const { d, sp, pp } = mk("308c0de0-1a9b-4c3d-9e8f-000000000311");
		const tagsDir = path.join(d, "wtft-tags"); fs.mkdirSync(tagsDir);
		fs.writeFileSync(path.join(tagsDir, `${path.basename(sp)}.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`), JSON.stringify({ _hb: "stop" }) + "\n");
		const c = spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: "ignore" });
		await waitExit(c);
		const r = await awaitDaemonUp(sp, c, 1_000);
		assert("a. leftover tag + dead child + no lease → dead, not up", r.state === "dead", JSON.stringify(r));
		assert("a. …carrying the exit code", r.exitCode === 1, JSON.stringify(r));
		try { fs.unlinkSync(pp); } catch {} try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
	}
	// b. child killed by signal
	{
		const { d, sp, pp } = mk("308c0de0-1a9b-4c3d-9e8f-000000000312");
		const c = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
		c.kill("SIGKILL");
		await waitExit(c);
		const r = await awaitDaemonUp(sp, c, 1_000);
		assert("b. signal-killed child, no lease → dead", r.state === "dead", JSON.stringify(r));
		assert("b. …naming the signal", r.signalCode === "SIGKILL", JSON.stringify(r));
		try { fs.unlinkSync(pp); } catch {} try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
	}
	// c. child exits 0 because another daemon (stood in by this test process) owns the lease
	{
		const { d, sp, pp } = mk("308c0de0-1a9b-4c3d-9e8f-000000000313");
		fs.writeFileSync(pp, String(process.pid));
		const c = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		await waitExit(c);
		const r = await awaitDaemonUp(sp, c, 1_000);
		assert("c. child exit 0 + live lease held elsewhere → up", r.state === "up", JSON.stringify(r));
		try { fs.unlinkSync(pp); } catch {} try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
	}
}

// ---
// 8. Non-watch, existing session, daemon killed by a signal before any data → exit 1.
// Same structural injection as §6 (a wtft.mjs with no daemon beside it), but the
// session EXISTS, so this exercises the "no data yet" branch — which used to test
// exitCode only and let a signal-killed or missing daemon read as success.
// ---
console.log("\n8. Existing session, daemon dead before data → not 'no data yet'");
{
	const fakeBin = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-308d2-")));
	fs.copyFileSync(path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs"), path.join(fakeBin, "wtft.mjs"));
	const dir8 = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-308e-")));
	const path8 = path.join(dir8, "308c0de0-1a9b-4c3d-9e8f-000000000314.jsonl");
	fs.writeFileSync(path8, sessionLines());
	const pidPath8 = getDaemonPidPath(path8);
	try { fs.unlinkSync(pidPath8); } catch {}
	let out = "", code = 0;
	try {
		out = execSync(`${process.execPath} '${path.join(fakeBin, "wtft.mjs")}' -s '${path8}' -l 5 --no-emoji 2>&1`, { encoding: "utf8", env: CHILD_ENV, timeout: 20_000 });
	} catch (err: any) {
		out = `${err.stdout || ""}${err.stderr || ""}`;
		code = err.status ?? 1;
	}
	const clean = stripAnsi(out).trim();
	// Exit 1 specifically — see the note on the sibling case above (#513).
	assert("exits 1 when the daemon died before writing data", code === 1, `exit ${code}: ${clean}`);
	assert("does not say 'no data yet. Try again'", !/no data yet/i.test(clean), clean);
	try { fs.unlinkSync(pidPath8); } catch {}
	try { fs.rmSync(fakeBin, { recursive: true, force: true }); } catch {}
	try { fs.rmSync(dir8, { recursive: true, force: true }); } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

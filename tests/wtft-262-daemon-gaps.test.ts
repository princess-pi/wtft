#!/usr/bin/env bun
/**
 * Daemon behaviours spec-259 listed without a check of its own: the hand-off,
 * adoption from a per-session daemon, stop reasons, `wtft -F` edge cases and
 * the hand-off's idle signature. Spec: docs/spec-259-daemon-correctness.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { getCurrentVersionTagPath, getDaemonPidPath, readClassifiedTagFile, WTFT_TAGGER_VERSION } from "../extensions/lib/wtft-daemon-lib.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

const TMP = isolateTmpdir("262-gaps");

const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const CLI = path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

function turnLine(id: string, ts: number): string {
	return JSON.stringify({
		type: "assistant", timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6",
			usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: [{ type: "text", text: "t" }],
		},
	}) + "\n";
}

function makeRoot(label: string): string {
	return trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), `wtft-262-${label}-`)));
}

/** A session file under `root`, holding one turn. */
function session(root: string, name: string): string {
	const dir = path.join(root, "proj");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.jsonl`);
	fs.writeFileSync(file, turnLine(name, Date.now()));
	return file;
}

const envFor = (root: string) => ({
	...process.env,
	WTFT_DAEMON_DEBUG: "1",
	WTFT_CLAUDE_PROJECTS_DIR: root,
	WTFT_PI_SESSIONS_DIR: path.join(root, "no-pi"),
});

const pids: number[] = [];
function start(root: string, args: string[], errName: string, extraEnv: Record<string, string> = {}): { pid: number; err: string } {
	const err = path.join(root, errName);
	const fd = fs.openSync(err, "a");
	const child = spawn("node", [DAEMON, ...args], { detached: true, stdio: ["ignore", "ignore", fd], env: { ...envFor(root), ...extraEnv } });
	child.unref();
	fs.closeSync(fd);
	if (child.pid) pids.push(child.pid);
	return { pid: child.pid ?? 0, err };
}

function run(root: string, args: string[]) {
	return spawnSync("node", [DAEMON, ...args], { encoding: "utf8", env: envFor(root), timeout: 30_000 });
}

const cliRun = (root: string, args: string[]) => spawnSync("node", [CLI, ...args], { encoding: "utf8", env: envFor(root), timeout: 30_000 });

const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
/** A child this suite spawned stays a zombie until reaped, and signal 0 still reaches it. */
const alive = (pid: number) => {
	try { process.kill(pid, 0); } catch { return false; }
	const stat = read(`/proc/${pid}/stat`);
	return stat !== "" && stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
};
const harnessPidFile = (root: string) =>
	path.join(TMP, `wtft-harness-claude-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12)}.pid`);
const classified = (file: string, id: string) => {
	try { return readClassifiedTagFile(getCurrentVersionTagPath(file)).some((r: { messageId?: string }) => r.messageId === id); }
	catch { return false; }
};

async function until(pred: () => boolean, limitMs: number): Promise<number> {
	const t = Date.now();
	while (Date.now() - t < limitMs) {
		if (pred()) return Date.now() - t;
		await sleep(50);
	}
	return Infinity;
}

/** Daemons a CLI run spawned for `root`, found by their environment. */
function stopDaemonsOf(root: string) {
	for (const pid of fs.readdirSync("/proc").filter(p => /^\d+$/.test(p)).map(Number)) {
		if (read(`/proc/${pid}/environ`).split("\0").includes(`WTFT_CLAUDE_PROJECTS_DIR=${root}`)) {
			try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
		}
	}
}

/** A process the daemon code takes for a wtft-daemon, ignoring SIGTERM. */
function stubDaemon(root: string, args: string[] = []): number {
	const dir = path.join(root, `stub-${pids.length}`);
	fs.mkdirSync(dir, { recursive: true });
	const stub = path.join(dir, "wtft-daemon.mjs");
	fs.writeFileSync(stub, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");
	const child = spawn("node", [stub, ...args], { detached: true, stdio: "ignore" });
	child.unref();
	pids.push(child.pid!);
	return child.pid!;
}

try {
	console.log("\nA session waiting on an adoption retry is handed on with its displayed flag");
	{
		const root = makeRoot("retry");
		const served = session(root, "retry-served");
		const target = session(root, "retry-target");
		const hidden = session(root, "retry-hidden");
		const other = stubDaemon(root, ["--harness", "claude"]);
		await sleep(300);
		for (const file of [target, hidden]) fs.writeFileSync(getDaemonPidPath(file), String(other));
		const handOff = `${harnessPidFile(root)}.served`;
		// A predecessor's hand-off is the one way to ask for a session not displayed.
		fs.writeFileSync(handOff, JSON.stringify({ kind: "served", displayed: false, path: hidden }) + "\n");
		const h = start(root, ["--harness", "claude", "--session", served], "retry.err");
		check(await until(() => classified(served, "retry-served"), 15_000) !== Infinity, "fixture: a harness serves a session");
		run(root, ["--harness", "claude", "--session", target]);
		// Retrying means the lease still names the other holder and the harness
		// has not given up; the line exists only in that window.
		const retrying = (file: string) => read(getDaemonPidPath(file)).trim() === String(other) && !read(h.err).includes(`could not adopt ${file}`);
		const listed = (file: string, displayed: boolean) => read(handOff).includes(JSON.stringify({ kind: "served", displayed, path: file }));
		check(await until(() => retrying(target) && listed(target, true), 10_000) !== Infinity,
			"while its adoption retries, the hand-off lists a displayed session as served and displayed");
		check(await until(() => retrying(hidden) && listed(hidden, false), 10_000) !== Infinity,
			"while its adoption retries, the hand-off lists a session not displayed as served and not displayed");
		check(await until(() => [target, hidden].every(f => read(h.err).includes(`could not adopt ${f}: its lease names ${other}`)), 15_000) !== Infinity,
			"fixture: both adoptions retried until they gave up on the other holder");
		process.kill(h.pid, "SIGTERM");
		await until(() => !alive(h.pid), 5_000);
	}

	console.log("\nThe hand-off is removed when nothing is served or idle");
	{
		const root = makeRoot("empty-handoff");
		const file = session(root, "eh-main");
		const h = start(root, ["--harness", "claude", "--session", file], "eh.err");
		const handOff = `${harnessPidFile(root)}.served`;
		check(await until(() => read(handOff).includes(JSON.stringify(file)), 15_000) !== Infinity, "fixture: the hand-off names the served session");
		run(root, ["--stop", file]);
		check(await until(() => !fs.existsSync(handOff), 3_000) !== Infinity && alive(h.pid), "once its only session is stopped, the live harness removes the hand-off");
		process.kill(h.pid, "SIGTERM");
		await until(() => !alive(h.pid), 5_000);
	}

	console.log("\nAdoption still stops a per-session daemon holding the lease");
	{
		const root = makeRoot("per-session");
		const file = session(root, "ps-main");
		const other = session(root, "ps-other");
		const per = start(root, ["--session", file], "ps-per.err");
		check(await until(() => classified(file, "ps-main") && read(getDaemonPidPath(file)).trim() === String(per.pid), 15_000) !== Infinity,
			"fixture: a per-session daemon holds the lease");
		const h = start(root, ["--harness", "claude", "--session", other], "ps-h.err");
		check(await until(() => classified(other, "ps-other"), 15_000) !== Infinity, "fixture: a harness serves another session");
		run(root, ["--harness", "claude", "--session", file]);
		check(await until(() => !alive(per.pid) && read(getDaemonPidPath(file)).trim() === String(h.pid), 10_000) !== Infinity,
			"the harness stops the per-session daemon and takes the lease");
		process.kill(h.pid, "SIGTERM");
		await until(() => !alive(h.pid), 5_000);
	}

	console.log("\nA harness writes the stop line for a removed session");
	{
		const root = makeRoot("removed");
		const file = session(root, "rm-main");
		const tag = getCurrentVersionTagPath(file);
		const h = start(root, ["--harness", "claude", "--session", file], "rm.err");
		check(await until(() => classified(file, "rm-main"), 15_000) !== Infinity, "fixture: a harness serves the session");
		fs.unlinkSync(file);
		check(await until(() => read(tag).includes('{"_hb":"stop","reason":"session removed"}'), 5_000) !== Infinity,
			"its tag gets the stop line with the reason session removed");
		process.kill(h.pid, "SIGTERM");
		await until(() => !alive(h.pid), 5_000);
	}

	console.log("\nwtft -F deletes a sibling project's tag while a local one exists");
	{
		const root = makeRoot("sibling");
		const id = "c1c1c1c1-9999-4999-8999-999999999999";
		const file = path.join(root, "proj-a", `${id}.jsonl`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, turnLine("sib-main", Date.now()));
		const name = `${id}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`;
		const local = path.join(root, "proj-a", "wtft-tags", name);
		const sibling = path.join(root, "proj-b", "wtft-tags", name);
		for (const tag of [local, sibling]) {
			fs.mkdirSync(path.dirname(tag), { recursive: true });
			fs.writeFileSync(tag, JSON.stringify({ _meta: { offset: 0 } }) + "\n");
		}
		const later = new Date(Date.now() + 60_000);
		fs.utimesSync(sibling, later, later);
		const forced = cliRun(root, ["-F", "--json", "-s", file]);
		check(!fs.existsSync(sibling), `the sibling project's tag is deleted too (exit ${forced.status})`);
		stopDaemonsOf(root);
	}

	console.log("\nwtft -F on Linux does not signal a lease pid it cannot identify");
	{
		const root = makeRoot("kthread");
		const outside = makeRoot("kthread-out");
		const file = path.join(outside, "kt-main.jsonl");
		fs.writeFileSync(file, turnLine("kt-main", Date.now()));
		const kthread = read("/proc/2/cmdline") === "" && read("/proc/2/stat") !== "";
		check(kthread, "fixture: pid 2 is a live process with no command line");
		// In a PID namespace pid 2 may be another suite's daemon; -F would stop it.
		if (kthread) {
			fs.writeFileSync(getDaemonPidPath(file), "2");
			const forced = cliRun(root, ["-F", "--json", "-s", file]);
			check((forced.status === 0 || forced.status === 9) && fs.existsSync(getCurrentVersionTagPath(file)) && !forced.stderr.includes("could not be signalled"),
				`-F treats it as no daemon, rebuilds and reports (exit ${forced.status})`);
			stopDaemonsOf(root);
		}
	}

	console.log("\nAn idle session rewritten at the same length is adopted by the next harness");
	{
		const root = makeRoot("same-length");
		const file = session(root, "same-a");
		const other = session(root, "same-other");
		const quick = { WTFT_DAEMON_IDLE_MS: "2500", WTFT_DAEMON_STARTUP_GRACE_MS: "0" };
		const h = start(root, ["--harness", "claude", "--session", file], "same.err", quick);
		const handOff = `${harnessPidFile(root)}.served`;
		check(await until(() => read(handOff).includes('"kind":"idle"'), 15_000) !== Infinity, "fixture: the session was dropped for idling");
		process.kill(h.pid, "SIGTERM");
		await until(() => !alive(h.pid), 5_000);
		const before = fs.statSync(file).size;
		fs.writeFileSync(file, turnLine("same-b", Date.now() + 1_000));
		check(fs.statSync(file).size === before, "fixture: the rewrite has the same length");
		const h2 = start(root, ["--harness", "claude", "--session", other], "same-2.err");
		check(await until(() => read(getDaemonPidPath(file)).trim() === String(h2.pid), 10_000) !== Infinity,
			"the next harness adopts it again");
		process.kill(h2.pid, "SIGTERM");
		await until(() => !alive(h2.pid), 5_000);
	}
	console.log("\nwtft -F reports a rebuild lease it cannot write");
	{
		const root = makeRoot("unwritable");
		const file = session(root, "uw-main");
		const h = start(root, ["--harness", "claude", "--session", file], "uw.err");
		check(await until(() => classified(file, "uw-main") && read(getDaemonPidPath(file)).trim() === String(h.pid), 15_000) !== Infinity,
			"fixture: a harness serves the session and holds its lease");
		fs.chmodSync(TMP, 0o555);
		let forced: ReturnType<typeof cliRun>;
		try { forced = cliRun(root, ["-F", "--json", "-s", file]); } finally { fs.chmodSync(TMP, 0o755); }
		check(forced.status === 1 && forced.stderr.includes("the rebuild lease could not be written") && forced.stdout === "",
			`-F exits 1 naming the lease it could not write (exit ${forced.status})`);
		check(read(getDaemonPidPath(file)).trim() === String(h.pid), "and the harness keeps its lease");
		process.kill(h.pid, "SIGTERM");
		await until(() => !alive(h.pid), 5_000);
	}

	console.log("\nA tag of a newer build is reported with the remedy for a newer build");
	{
		const root = makeRoot("newer-remedy");
		const outside = makeRoot("newer-remedy-out");
		const file = path.join(outside, "nr-main.jsonl");
		fs.writeFileSync(file, turnLine("nr-main", Date.now()));
		const d = start(root, ["--session", file], "nr.err");
		check(await until(() => classified(file, "nr-main"), 15_000) !== Infinity, "fixture: a daemon wrote a current tag");
		process.kill(d.pid, "SIGTERM");
		await until(() => !alive(d.pid), 5_000);
		const current = getCurrentVersionTagPath(file);
		fs.renameSync(current, current.replace(`.v${WTFT_TAGGER_VERSION}.jsonl`, ".v99.0.0.jsonl"));
		// A live newer build holds the lease, so this build's daemon leaves the session alone.
		fs.writeFileSync(getDaemonPidPath(file), String(stubDaemon(root)));
		await sleep(300);
		const report = cliRun(root, ["-s", file]);
		check(report.stderr.includes("written by a newer wtft build"),
			`the remedy names a newer build, not a rebuild in a moment (exit ${report.status})`);
	}

} finally {
	for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

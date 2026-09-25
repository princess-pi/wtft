#!/usr/bin/env bun
/**
 * Daemon correctness items split out of #256: arguments, swept, resume,
 * leases, adoption, focus requests, the hand-off, sweep liveness, harness
 * exit and the stop reason. Spec: docs/spec-259-daemon-correctness.md.
 * --cleanup is not run here: it stops every fixture daemon under /tmp,
 * including other suites'.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { getCurrentVersionTagPath, getDaemonPidPath, readClassifiedTagFile } from "../extensions/lib/wtft-daemon-lib.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

const TMP = isolateTmpdir("259-correctness");

const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

function turnLine(id: string, ts: number, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "assistant", timestamp: new Date(ts).toISOString(),
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6",
			usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: [{ type: "text", text: "t" }],
		},
		...extra,
	}) + "\n";
}

function makeRoot(label: string): string {
	return trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), `wtft-259-${label}-`)));
}

/** A session file under `root`, holding one turn. */
function session(root: string, name: string, id = name): string {
	const dir = path.join(root, "proj");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.jsonl`);
	fs.writeFileSync(file, turnLine(id, Date.now()));
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

function run(root: string, args: string[], extraEnv: Record<string, string> = {}, cwd?: string) {
	return spawnSync("node", [DAEMON, ...args], { encoding: "utf8", env: { ...envFor(root), ...extraEnv }, cwd, timeout: 30_000 });
}

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

try {
	console.log("\nArguments");
	{
		const root = makeRoot("args");
		const unknown = run(root, ["--bogus"]);
		check(unknown.status === 2 && unknown.stderr.includes("Usage:"), `an unknown argument exits 2 with the usage line (exit ${unknown.status})`);
		const reparse = run(root, ["--reparse", path.join(root, "x.jsonl")]);
		check(reparse.status === 2, `--reparse is an unknown argument (exit ${reparse.status})`);
		const range = run(root, ["--reparse-range", "2026-09-01", "2026-09-02"]);
		check(range.status === 2, `--reparse-range is an unknown argument (exit ${range.status})`);
		const noValue = run(root, ["--stop"]);
		check(noValue.status === 2 && noValue.stderr.includes("Usage:"), `a flag missing its value exits 2 (exit ${noValue.status})`);

		const file = session(root, "alias");
		const h = start(root, ["--harness", "claude-code", "--session", file], "alias.err");
		const served = await until(() => classified(file, "alias"), 15_000);
		check(served < Infinity && read(harnessPidFile(root)).trim() === String(h.pid),
			"--harness claude-code serves the claude root under its pid file");
	}

	console.log("\nSwept means every subagent turn is written");
	{
		const root = makeRoot("swept");
		const file = session(root, "swept-main");
		const sub = path.join(file.slice(0, -".jsonl".length), "subagents");
		fs.mkdirSync(sub, { recursive: true });
		fs.writeFileSync(path.join(sub, "agent-a.jsonl"), turnLine("sw-sub-1", Date.now()) + turnLine("sw-sub-2", Date.now()));
		const tag = getCurrentVersionTagPath(file);
		const d = start(root, ["--session", file], "swept.err");
		check(await until(() => classified(file, "sw-sub-2") && read(tag).includes('"swept"'), 15_000) !== Infinity,
			"fixture: the daemon wrote the subagent's last turn and stamped the tag swept");
		const lines = read(tag).split("\n");
		const firstSwept = lines.findIndex(l => l.includes('"swept"'));
		const lastTurn = lines.findIndex(l => l.includes('"sw-sub-2"'));
		check(lastTurn >= 0 && lastTurn < firstSwept,
			`the tag is stamped swept only after the held-back turn is written (turn line ${lastTurn}, swept line ${firstSwept})`);
		process.kill(d.pid, "SIGTERM");
	}

	console.log("\nA resumed session reads again the claude -p transcripts it read before");
	{
		const root = makeRoot("resume");
		const cwd = path.join(root, "work");
		const projectDir = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
		fs.mkdirSync(projectDir, { recursive: true });
		const parentId = "aaaa1111-1111-4111-8111-111111111111";
		const childId = "bbbb2222-2222-4222-8222-222222222222";
		const parent = path.join(projectDir, `${parentId}.jsonl`);
		const child = path.join(projectDir, `${childId}.jsonl`);
		const t = Date.now() - 60_000;
		const sessionLine = (id: string, ts: number) => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(ts).toISOString(), cwd }) + "\n";
		const spawnTurn = JSON.stringify({
			type: "message", timestamp: new Date(t + 1_000).toISOString(),
			message: {
				role: "assistant", id: "rs-parent", model: "claude-sonnet-4-6", timestamp: new Date(t + 1_000).toISOString(),
				usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				content: [{ type: "toolCall", name: "bash", arguments: { command: "claude -p 'go'" } }],
			},
		}) + "\n";
		fs.writeFileSync(parent, sessionLine(parentId, t) + spawnTurn);
		fs.writeFileSync(child, sessionLine(childId, t + 2_000) + turnLine("rs-child-1", t + 3_000));
		const tag = getCurrentVersionTagPath(parent);
		const first = start(root, ["--session", parent], "resume-1.err");
		check(await until(() => classified(parent, "rs-child-1") && read(tag).includes('"swept"'), 15_000) !== Infinity,
			"fixture: the first daemon read the claude -p transcript");
		process.kill(first.pid, "SIGTERM");
		await until(() => !alive(first.pid), 5_000);
		fs.appendFileSync(child, turnLine("rs-child-2", Date.now()));
		const second = start(root, ["--session", parent], "resume-2.err");
		check(await until(() => classified(parent, "rs-child-2"), 10_000) !== Infinity,
			"a turn the claude -p transcript gained while nothing served the session is read after resume");
		process.kill(second.pid, "SIGTERM");
	}

	console.log("\nAdoption never signals a harness");
	{
		// A session id shared by two roots shares one lease.
		const id = "cccc3333-3333-4333-8333-333333333333";
		const rootA = makeRoot("sig-a");
		const rootB = makeRoot("sig-b");
		const fileA = session(rootA, id, "sig-a");
		const fileB = session(rootB, id, "sig-b");
		const a = start(rootA, ["--harness", "claude", "--session", fileA], "sig-a.err");
		check(await until(() => classified(fileA, "sig-a") && read(getDaemonPidPath(fileA)).trim() === String(a.pid), 15_000) !== Infinity,
			"fixture: harness A serves the session and holds its lease");
		const b = start(rootB, ["--harness", "claude", "--session", fileB], "sig-b.err");
		await until(() => read(b.err).includes("could not adopt") || !alive(a.pid), 10_000);
		check(alive(a.pid), "harness B asked for a session whose lease names harness A leaves A running");
		check(read(getDaemonPidPath(fileA)).trim() === String(a.pid), "and A keeps the lease");
		for (const pid of [a.pid, b.pid]) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
	}

	console.log("\nA failed adoption gives up loudly and lets go of the lease");
	{
		const root = makeRoot("giveup");
		const file = session(root, "giveup-main");
		const h = start(root, ["--harness", "claude", "--session", file], "giveup.err");
		check(await until(() => classified(file, "giveup-main"), 15_000) !== Infinity, "fixture: a harness is serving a session");
		// A tag path is never adopted, so every try fails.
		const tagLike = path.join(root, "proj", "x.jsonl.wtft-tag.v1.jsonl");
		fs.writeFileSync(tagLike, "");
		run(root, ["--harness", "claude", "--session", tagLike]);
		const lease = getDaemonPidPath(tagLike);
		check(read(lease).trim() === String(h.pid), "fixture: the request pointed the lease at the harness");
		const gaveUp = await until(() => read(h.err).includes(`could not adopt ${tagLike}`), 10_000);
		check(gaveUp !== Infinity, "the harness reports the session it gave up on");
		check(!fs.existsSync(lease) && !fs.existsSync(`${lease}.display`), "and removes the lease and .display marker naming it");
		process.kill(h.pid, "SIGTERM");
	}

	console.log("\nwtft -F on a session a harness serves rebuilds that one session");
	{
		const root = makeRoot("force");
		const target = session(root, "force-target");
		const other = session(root, "force-other");
		const h = start(root, ["--harness", "claude", "--session", target], "force.err");
		check(await until(() => classified(target, "force-target"), 15_000) !== Infinity, "fixture: the harness serves the target");
		run(root, ["--harness", "claude", "--session", other]);
		check(await until(() => classified(other, "force-other"), 15_000) !== Infinity, "fixture: and another session");
		const tag = getCurrentVersionTagPath(target);
		const row = read(tag).split("\n").find(l => l.includes('"force-target"')) ?? "";
		fs.appendFileSync(tag, row.replace('"force-target"', '"force-bogus"') + "\n" + JSON.stringify({ _meta: { offset: fs.statSync(target).size } }) + "\n");
		check(classified(target, "force-bogus"), "fixture: the target's tag carries a row its transcript does not");
		const cli = path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs");
		spawnSync("node", [cli, "--json", "-F", "-s", target], { encoding: "utf8", env: envFor(root), timeout: 30_000 });
		const rebuilt = await until(() => classified(target, "force-target") && !classified(target, "force-bogus"), 10_000);
		check(rebuilt !== Infinity, "the target's tag is rebuilt from its transcript");
		check(alive(h.pid), "the harness keeps running");
		check(read(getDaemonPidPath(other)).trim() === String(h.pid), "and keeps serving the other session");
		check(read(h.err).includes(`lease for ${target} now held by rebuild`), "a daemon that gives up a lease logs who holds it now");
		process.kill(h.pid, "SIGTERM");
	}

	console.log("\nAn older per-session build never takes over from a newer one");
	{
		const root = makeRoot("older");
		const file = session(root, "older-main");
		const newerTag = path.join(path.dirname(file), "wtft-tags", `${path.basename(file)}.wtft-tag.v999.0.0.jsonl`);
		fs.mkdirSync(path.dirname(newerTag), { recursive: true });
		fs.writeFileSync(newerTag, "{\"note\":\"NEWER\"}\n");
		// A stand-in for a newer build's daemon holding the lease.
		const newer = spawn("node", ["-e", "setTimeout(() => {}, 60000)", path.join(root, "wtft-daemon.mjs")], { stdio: "ignore" });
		pids.push(newer.pid!);
		fs.writeFileSync(getDaemonPidPath(file), String(newer.pid));
		const d = start(root, ["--session", file], "older-1.err");
		check(await until(() => !alive(d.pid), 10_000) !== Infinity, "it exits while a newer build's daemon holds the lease");
		check(read(getDaemonPidPath(file)).trim() === String(newer.pid), "and leaves that lease alone");
		process.kill(newer.pid!, "SIGTERM");
		await until(() => !alive(newer.pid!), 5_000);
		const d2 = start(root, ["--session", file], "older-2.err");
		check(await until(() => classified(file, "older-main"), 15_000) !== Infinity, "with no newer daemon running, it serves the session");
		check(read(newerTag).includes("NEWER"), "and never deletes the newer build's tag");
		process.kill(d2.pid, "SIGTERM");
	}

	console.log("\nFocus requests reach the harness that holds the root");
	{
		const root = makeRoot("focus");
		const first = session(root, "focus-first");
		const other = session(root, "focus-other");
		const late = session(root, "focus-late");
		const h = start(root, ["--harness", "claude", "--session", first], "focus.err");
		check(await until(() => classified(first, "focus-first"), 15_000) !== Infinity, "fixture: a harness serves a session");
		const dir = `${harnessPidFile(root)}.focus.d`;
		fs.writeFileSync(path.join(dir, "1.request"), JSON.stringify({ pid: 1, path: other }));
		check(await until(() => classified(other, "focus-other"), 10_000) !== Infinity,
			"a request addressed to another harness pid is served by the one holding the root");

		process.kill(h.pid, "SIGSTOP");
		fs.writeFileSync(path.join(dir, `${h.pid}.request`), JSON.stringify({ pid: h.pid, path: late }));
		process.kill(h.pid, "SIGTERM");
		process.kill(h.pid, "SIGCONT");
		await until(() => !alive(h.pid), 5_000);
		const h2 = start(root, ["--harness", "claude", "--session", first], "focus-2.err");
		check(await until(() => classified(late, "focus-late"), 10_000) !== Infinity,
			"a request posted to a harness that then stops is served by the next harness");
		process.kill(h2.pid, "SIGTERM");
	}

	console.log("\nThe hand-off survives a harness killed without warning");
	{
		const root = makeRoot("killed");
		const served = session(root, "killed-served");
		const next = session(root, "killed-next");
		const h = start(root, ["--harness", "claude", "--session", served], "killed.err");
		check(await until(() => classified(served, "killed-served"), 15_000) !== Infinity, "fixture: a harness serves a session");
		await sleep(600);
		process.kill(h.pid, "SIGKILL");
		await until(() => !alive(h.pid), 5_000);
		const h2 = start(root, ["--harness", "claude", "--session", next], "killed-2.err");
		check(await until(() => classified(next, "killed-next"), 15_000) !== Infinity, "fixture: the next harness is up");
		fs.appendFileSync(served, turnLine("killed-later", Date.now()));
		check(await until(() => classified(served, "killed-later"), 10_000) !== Infinity,
			"the next harness serves what a SIGKILLed harness served, with no new request");
		process.kill(h2.pid, "SIGTERM");
		await until(() => !alive(h2.pid), 5_000);
	}

	console.log("\nA hand-off that cannot be read is kept and reported");
	{
		const root = makeRoot("handoff");
		const file = session(root, "handoff-main");
		const handOff = `${harnessPidFile(root)}.served`;
		fs.mkdirSync(handOff);
		const h = start(root, ["--harness", "claude", "--session", file], "handoff.err");
		check(await until(() => classified(file, "handoff-main"), 15_000) !== Infinity, "fixture: the harness is up");
		check(fs.existsSync(handOff) && read(h.err).includes("could not read the previous harness's hand-off"),
			"a hand-off that cannot be read stays in place and is reported");
		process.kill(h.pid, "SIGTERM");
		await until(() => !alive(h.pid), 5_000);
		fs.rmSync(handOff, { recursive: true, force: true });
		fs.writeFileSync(handOff, "not json\n");
		const h2 = start(root, ["--harness", "claude", "--session", file], "handoff-2.err");
		check(await until(() => read(h2.err).includes("hand-off line"), 10_000) !== Infinity, "a hand-off line that does not parse is reported");
		process.kill(h2.pid, "SIGTERM");
	}

	console.log("\nThe sweep reads a session whose directory cannot be watched");
	{
		const root = makeRoot("unwatched");
		const file = session(root, "unwatched-main");
		const dir = path.dirname(file);
		// Search and write, but no read: the files stay reachable, a watch fails.
		fs.chmodSync(dir, 0o311);
		try {
			let watchFailed = false;
			try { fs.watch(dir).close(); } catch { watchFailed = true; }
			check(watchFailed, "fixture: the session's directory cannot be watched");
			const h = start(root, ["--harness", "claude", "--session", file], "unwatched.err");
			check(await until(() => classified(file, "unwatched-main"), 15_000) !== Infinity, "fixture: the harness adopts the session");
			fs.appendFileSync(file, turnLine("unwatched-later", Date.now()));
			check(await until(() => classified(file, "unwatched-later"), 10_000) !== Infinity, "a write to it is read");
			fs.unlinkSync(file);
			check(await until(() => read(h.err).includes("session drop unwatched-main.jsonl"), 10_000) !== Infinity, "and its deletion drops it");
			process.kill(h.pid, "SIGTERM");
		} finally {
			fs.chmodSync(dir, 0o755);
		}
	}

	console.log("\nA harness stops on its own");
	{
		const root = makeRoot("empty");
		const file = session(root, "empty-main");
		const tag = getCurrentVersionTagPath(file);
		const quick = { WTFT_DAEMON_IDLE_MS: "1500", WTFT_DAEMON_STARTUP_GRACE_MS: "0" };
		const h = start(root, ["--harness", "claude", "--session", file], "empty.err", quick);
		check(await until(() => read(h.err).includes("session drop empty-main.jsonl"), 15_000) !== Infinity, "fixture: the session is dropped for idling");
		check(read(tag).includes('{"_hb":"stop","reason":"idle timeout"}'), "a harness dropping a session writes the stop line with its reason");
		check(await until(() => !alive(h.pid), 10_000) !== Infinity, "a harness serving no session stops after WTFT_DAEMON_IDLE_MS");
		check(read(`${harnessPidFile(root)}.served`).includes(`"kind":"idle","displayed":true,"path":${JSON.stringify(file)}`),
			"and hands on the session it dropped for idling");
		fs.rmSync(`${harnessPidFile(root)}.served`, { force: true });

		const per = start(root, ["--session", file], "per.err");
		check(await until(() => read(tag).split("\n").filter(l => l.includes('"_hb":{')).length > 0 && read(per.err).includes("started"), 10_000) !== Infinity,
			"fixture: a per-session daemon serves the session");
		process.kill(per.pid, "SIGTERM");
		await until(() => !alive(per.pid), 5_000);
		check(read(tag).trimEnd().endsWith('{"_hb":"stop","reason":"SIGTERM"}'), "a per-session daemon's stop line carries its reason");

		const gone = makeRoot("gone");
		const inner = path.join(gone, "projects");
		const goneFile = path.join(inner, "proj", "gone-main.jsonl");
		fs.mkdirSync(path.dirname(goneFile), { recursive: true });
		fs.writeFileSync(goneFile, turnLine("gone-main", Date.now()));
		const g = start(gone, ["--harness", "claude", "--session", goneFile], "gone.err", { WTFT_CLAUDE_PROJECTS_DIR: inner });
		check(await until(() => classified(goneFile, "gone-main"), 15_000) !== Infinity, "fixture: a harness serves a root");
		fs.rmSync(inner, { recursive: true, force: true });
		check(await until(() => !alive(g.pid), 10_000) !== Infinity, "a harness whose root is removed stops");

		const bad = makeRoot("badpid");
		const badFile = session(bad, "badpid-main");
		const b = start(bad, ["--harness", "claude", "--session", badFile], "badpid.err");
		check(await until(() => classified(badFile, "badpid-main"), 15_000) !== Infinity, "fixture: a harness is up");
		fs.unlinkSync(harnessPidFile(bad));
		fs.mkdirSync(harnessPidFile(bad));
		check(await until(() => !alive(b.pid), 10_000) !== Infinity && read(b.err).includes("cannot read its pid file"),
			"a harness that cannot read its pid file exits, saying why");
		fs.rmSync(harnessPidFile(bad), { recursive: true, force: true });
	}

	console.log("\nA spawn waiting on a harness sleeps");
	{
		const root = makeRoot("spin");
		const file = session(root, "spin-main");
		const other = session(root, "spin-other");
		const h = start(root, ["--harness", "claude", "--session", file], "spin.err");
		check(await until(() => classified(file, "spin-main"), 15_000) !== Infinity, "fixture: a harness is up");
		const dir = `${harnessPidFile(root)}.focus.d`;
		fs.chmodSync(dir, 0o500);
		try {
			const timed = spawnSync("bash", ["-c", `TIMEFORMAT=%U; time node ${JSON.stringify(DAEMON)} --harness claude --session ${JSON.stringify(other)}`],
				{ encoding: "utf8", env: envFor(root), timeout: 60_000 });
			const cpu = Number(timed.stderr.trim().split("\n").pop());
			check(timed.status === 1 && cpu < 2, `a spawn whose request cannot be posted exits 1 without spinning (${cpu} s of CPU, exit ${timed.status})`);
		} finally {
			fs.chmodSync(dir, 0o700);
		}
		process.kill(h.pid, "SIGTERM");
	}

	console.log("\n--stop resolves its path");
	{
		const root = makeRoot("stop");
		const outside = path.join(root, "elsewhere");
		fs.mkdirSync(outside, { recursive: true });
		const rel = path.join(outside, "stop-rel.jsonl");
		const home = path.join(outside, "stop-home.jsonl");
		fs.writeFileSync(rel, turnLine("stop-rel", Date.now()));
		fs.writeFileSync(home, turnLine("stop-home", Date.now()));
		const a = start(root, ["--session", rel], "stop-rel.err");
		const b = start(root, ["--session", home], "stop-home.err");
		check(await until(() => classified(rel, "stop-rel") && classified(home, "stop-home"), 15_000) !== Infinity, "fixture: two per-session daemons are up");
		const byRelative = run(root, ["--stop", "stop-rel.jsonl"], {}, outside);
		check(await until(() => !alive(a.pid), 5_000) !== Infinity, `a relative path stops its daemon (exit ${byRelative.status}: ${byRelative.stdout.trim()})`);
		const byHome = run(root, ["--stop", "~/stop-home.jsonl"], { HOME: outside });
		check(await until(() => !alive(b.pid), 5_000) !== Infinity, `a ~ path stops its daemon (exit ${byHome.status}: ${byHome.stdout.trim()})`);
	}

	console.log("\nA session moved while its subagent scan is cut finishes that scan");
	{
		const root = makeRoot("moved");
		const id = "dddd4444-4444-4444-8444-444444444444";
		const from = path.join(root, "proj-a");
		const to = path.join(root, "proj-b");
		fs.mkdirSync(to, { recursive: true });
		const file = session(root, id, "moved-main");
		fs.renameSync(path.dirname(file), from);
		const original = path.join(from, `${id}.jsonl`);
		const sub = path.join(from, id, "subagents");
		fs.mkdirSync(sub, { recursive: true });
		for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(sub, `agent-${i}.jsonl`), turnLine(`moved-sub-${i}`, Date.now()));
		const tag = getCurrentVersionTagPath(original);
		const subIds = () => readClassifiedTagFile(tag).filter((r: { messageId?: string }) => r.messageId?.startsWith("moved-sub-")).length;
		const h = start(root, ["--harness", "claude", "--session", original], "moved.err",
			{ WTFT_HARNESS_SCAN_SLICE_MS: "0", WTFT_HARNESS_SCAN_YIELD_MS: "300" });
		await until(() => subIds() > 0, 15_000);
		const before = subIds();
		check(before > 0 && before < 20, `fixture: the scan is cut part way (${before} of 20 subagent turns)`);
		fs.renameSync(path.join(from, id), path.join(to, id));
		fs.renameSync(original, path.join(to, `${id}.jsonl`));
		check(await until(() => subIds() === 20 && !read(tag).trimEnd().split("\n").slice(-3).some(l => l.includes('"unswept"')) && read(tag).includes('"swept"'), 30_000) !== Infinity,
			"after the move the scan reads every subagent transcript and stamps the tag swept");
		process.kill(h.pid, "SIGTERM");
	}
} finally {
	for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

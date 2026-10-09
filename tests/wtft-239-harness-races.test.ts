#!/usr/bin/env bun
/**
 * The harness daemon under --restart races: one harness per root when a CLI spawn or a
 * new harness lands mid-restart, and the startup reaper never acts on a harness for its
 * start-up --session.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { getDaemonPidPath } from "../extensions/lib/wtft-daemon-lib.ts";
import { trackSandbox } from "./lib/sandbox";
import { TMP, DAEMON, sleep, check, turnLine, makeRoot, envFor, pids, start, alive, read, harnessPidFile, leasesNaming, classified, harnessesFor, until, finish } from "./lib/harness-lifecycle-suite.ts";

try {
	console.log("\n--restart followed at once by a CLI spawn leaves one harness");
	{
		const { root, files } = makeRoot("r", 2000);
		const h = start(root, ["--harness", "claude", "--session", files[0]], "r.err");
		check(await until(() => read(h.err).includes("harness settled claude"), 30_000) !== Infinity, "fixture: the first harness settled");
		// Leases as many as a busy host's, so --restart is still walking them
		// after the harness it started has claimed the root.
		for (let i = 0; i < 40_000; i++) fs.writeFileSync(path.join(TMP, `wtft-daemon-fake${i}.pid`), String(h.pid));
		const restart = spawnSync("node", [DAEMON, "--restart"], { encoding: "utf8", env: envFor(root) });
		check(restart.status === 0, `fixture: --restart exited 0 (${restart.status})`);
		check((restart.stdout.match(/^(Restarted|Stopped): PID/gm) ?? []).length >= 1, "fixture: --restart stopped the harness (respawned for its own --session, or stopped)");
		start(root, ["--harness", "claude", "--session", files[1]], "r-cli.err");
		await sleep(5_000);
		const living = harnessesFor(root);
		for (const pid of living) if (!pids.includes(pid)) pids.push(pid);
		check(living.length === 1, `exactly one harness serves the root 5 s later (saw ${living.length}: ${living.join(",")})`);
		check(living.length === 1 && read(harnessPidFile(root)).trim() === String(living[0]), "and it holds the harness pid file");
		const focus = living.length === 1 ? read(`/proc/${living[0]}/cmdline`).split("\0") : [];
		check(focus[focus.indexOf("--session") + 1] === files[0], "it is the one --restart started, which the CLI spawn handed its session");
		for (const pid of living) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
		await until(() => living.every(p => !alive(p)), 5_000);
	}

	console.log("\nA harness that claims the root while --restart is walking is left running");
	{
		const { root, files } = makeRoot("w", 20);
		const h = start(root, ["--harness", "claude"], "w.err");
		check(await until(() => read(harnessPidFile(root)).trim() === String(h.pid), 30_000) !== Infinity, "fixture: the first harness holds the root");
		for (let i = 0; i < 40_000; i++) fs.writeFileSync(path.join(TMP, `wtft-daemon-fakew${i}.pid`), String(h.pid));
		const restart = spawn("node", [DAEMON, "--restart"], { stdio: "ignore", env: envFor(root) });
		const restartDone = new Promise<void>(resolve => restart.on("exit", () => resolve()));
		await until(() => !alive(h.pid), 10_000);
		start(root, ["--harness", "claude", "--session", files[1]], "w-cli.err");
		const rootHolder = () => Number(read(harnessPidFile(root)).trim());
		const claimed = await until(() => rootHolder() > 0 && rootHolder() !== h.pid && alive(rootHolder()), 10_000);
		check(claimed !== Infinity && alive(restart.pid!), "fixture: a new harness claimed the root while --restart was still walking");
		await restartDone;
		await sleep(2_000);
		const living = harnessesFor(root);
		for (const pid of living) if (!pids.includes(pid)) pids.push(pid);
		check(living.length === 1, `exactly one harness serves the root after --restart (saw ${living.length}: ${living.join(",")})`);
		check(living.length === 1 && rootHolder() === living[0], "the root pid file still names it");
		for (const pid of living) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
		await until(() => living.every(p => !alive(p)), 5_000);
	}

	console.log("\nThe startup reaper leaves a harness whose --session is gone");
	{
		const { root, files } = makeRoot("g", 3);
		for (const f of files) fs.utimesSync(f, new Date(), new Date());
		const gone = files[0];
		const h = start(root, ["--harness", "claude", "--session", gone], "g.err");
		await until(() => read(h.err).includes("harness settled claude"), 10_000);
		start(root, ["--harness", "claude", "--session", files[1]], "g-ask.err");
		check(await until(() => classified(gone, "g-0") && classified(files[1], "g-1"), 15_000) !== Infinity, "fixture: the harness classified its sessions");
		fs.unlinkSync(gone);
		const other = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-239-outside-")));
		const outside = path.join(other, "outside.jsonl");
		fs.writeFileSync(outside, turnLine("outside", Date.now()));
		const leasesBefore = leasesNaming(h.pid);
		check(leasesBefore >= 1, `fixture: the harness holds a lease for a live session (${leasesBefore})`);
		const per = start(root, ["--session", outside], "per.err");
		check(await until(() => classified(outside, "outside"), 15_000) !== Infinity, "fixture: the per-session daemon started and classified its session");
		await sleep(500);
		check(alive(h.pid), "the harness is still running");
		check(read(getDaemonPidPath(files[1])).trim() === String(h.pid), "and still holds its live session's lease");
		for (const pid of [h.pid, per.pid]) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
	}
} finally {
	await finish();
}

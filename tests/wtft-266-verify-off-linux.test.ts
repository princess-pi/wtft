#!/usr/bin/env bun
import * as assert from "node:assert";
import { spawn } from "node:child_process";
import { after, describe, it } from "node:test";

import { isDaemonCmdline, psCmdline } from "../extensions/lib/holder.ts";
import { standInDaemonArgs, awaitStandIn } from "./lib/stand-in-daemon.ts";

const kids: number[] = [];
after(() => { for (const pid of kids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });

describe("psCmdline, the cmdline source on a host with no /proc", () => {
	it("reads a non-wtft process as that process, so it is never a daemon", () => {
		const sleeper = spawn("sleep", ["600"], { stdio: "ignore" });
		kids.push(sleeper.pid!);
		let args: string[] | null = null;
		for (let i = 0; i < 100 && !(args && args[0] === "sleep"); i++) {
			args = psCmdline(sleeper.pid!);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
		assert.deepStrictEqual(args, ["sleep", "600"]);
		assert.strictEqual(isDaemonCmdline(args!), false);
	});

	it("reads a wtft-daemon as one", () => {
		const [script] = standInDaemonArgs("setInterval(() => {}, 1000);");
		const fake = spawn("node", [script, "--session", "/s.jsonl"], { stdio: "ignore" });
		kids.push(fake.pid!);
		assert.ok(awaitStandIn(fake.pid!), "fixture precondition: /proc reads it as a daemon");
		const args = psCmdline(fake.pid!);
		assert.ok(args && isDaemonCmdline(args), `it reads as a daemon: ${JSON.stringify(args)}`);
	});

	it("answers null for a pid that is gone", () => {
		assert.strictEqual(psCmdline(2 ** 22 + 7), null);
	});
});

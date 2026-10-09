/**
 * docs/spec-holder.md § 4: the daemon's own decisions go
 * through the holder module. Process-level, because `bin/wtft-daemon.ts` runs
 * at import. The in-memory cases are in wtft-297-holder.test.ts.
 */

import * as assert from "node:assert";
import { after, describe, it } from "node:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isolateTmpdir } from "./lib/sandbox";
import { pollUntil } from "./lib/poll";
import { getDaemonPidPath } from "../extensions/lib/wtft-daemon-lib.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DAEMON_BIN = path.join(ROOT, "bin", "wtft-daemon.mjs");
const tmp = isolateTmpdir("297");
const started: ChildProcess[] = [];
after(() => { for (const c of started) try { c.kill("SIGKILL"); } catch { /* gone */ } });

function notADaemon(): ChildProcess {
	const c = spawn("sleep", ["30"], { stdio: "ignore" });
	started.push(c);
	return c;
}

function session(name: string): string {
	const file = path.join(tmp, "sessions", `${name}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "");
	return file;
}

describe("C5 the per-session child's claim", () => {
	it("takes a lease naming a live process that is not a daemon", { timeout: 60_000 }, async () => {
		const file = session("c5");
		const lease = getDaemonPidPath(file);
		const squatter = notADaemon();
		fs.writeFileSync(lease, String(squatter.pid));
		const d = spawn(process.execPath, [DAEMON_BIN, "--session", file], { stdio: "ignore", env: process.env });
		started.push(d);
		const took = await pollUntil(() => fs.readFileSync(lease, "utf8").trim() === String(d.pid), 20_000);
		assert.ok(took, `the lease names the daemon (${fs.readFileSync(lease, "utf8")}), not the squatter ${squatter.pid}`);
		assert.strictEqual(squatter.exitCode, null, "the squatter was not signalled");
		d.kill("SIGTERM");
		assert.ok(await pollUntil(() => d.exitCode !== null || d.signalCode !== null, 30_000), `the daemon ${d.pid} exited before the next case`);
	});
});

describe("C8 --list", () => {
	it("says DEAD for a lease naming a live process that is not a daemon", () => {
		const file = session("c8");
		const squatter = notADaemon();
		fs.writeFileSync(getDaemonPidPath(file), String(squatter.pid));
		const out = execFileSync(process.execPath, [DAEMON_BIN, "--list"], { encoding: "utf8", env: process.env });
		const row = out.split("\n").find(l => l.startsWith(`PID ${squatter.pid} `));
		assert.ok(row, `a row for ${squatter.pid} in:\n${out}`);
		assert.match(row!, /DEAD/);
	});
});

describe("closer", () => {
	it("no process.kill( outside the production port", () => {
		const hits: string[] = [];
		const walk = (dir: string) => {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, e.name);
				if (e.isDirectory()) walk(p);
				else if (p.endsWith(".ts") && !p.endsWith(path.join("lib", "holder.ts")) && fs.readFileSync(p, "utf8").includes("process.kill(")) hits.push(path.relative(ROOT, p));
			}
		};
		walk(path.join(ROOT, "extensions"));
		for (const f of fs.readdirSync(path.join(ROOT, "bin"))) if (f.endsWith(".ts") && fs.readFileSync(path.join(ROOT, "bin", f), "utf8").includes("process.kill(")) hits.push(`bin/${f}`);
		assert.deepStrictEqual(hits, []);
	});
});

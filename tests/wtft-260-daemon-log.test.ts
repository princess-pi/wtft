/**
 * A detached daemon's stderr goes to one shared, rotated log. docs/spec-daemon-log.md.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";
import { daemonLogPath, rotateDaemonLog } from "../extensions/lib/daemon-log.ts";
import { spawnWtftDaemon } from "../extensions/lib/wtft-cli-shared.ts";
import { restartDaemon } from "../extensions/lib/wtft-daemon-lib.ts";
import { standInDaemonArgs } from "./lib/stand-in-daemon.ts";

const sandbox = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-260-")));
process.env.XDG_STATE_HOME = path.join(sandbox, "state");
const LOG = path.join(sandbox, "state", "wtft", "daemon.log");

async function logGets(text: string, ms = 3000): Promise<boolean> {
	for (const until = Date.now() + ms; Date.now() < until;) {
		try { if (fs.readFileSync(LOG, "utf8").includes(text)) return true; } catch { /* not yet */ }
		await new Promise(r => setTimeout(r, 25));
	}
	return false;
}

function session(): string {
	const f = path.join(sandbox, "sessions", `${Math.random().toString(36).slice(2)}.jsonl`);
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, "");
	return f;
}

describe("rotateDaemonLog", () => {
	it("leaves a file under the cap alone", () => {
		const f = path.join(sandbox, "under.log");
		fs.writeFileSync(f, "x".repeat(9));
		rotateDaemonLog(f, 10);
		assert.strictEqual(fs.readFileSync(f, "utf8"), "x".repeat(9));
		assert.ok(!fs.existsSync(`${f}.1`));
	});

	it("at the cap: the content moves to .1 and the file is emptied", () => {
		const f = path.join(sandbox, "at.log");
		fs.writeFileSync(f, "a".repeat(10));
		rotateDaemonLog(f, 10);
		assert.strictEqual(fs.readFileSync(`${f}.1`, "utf8"), "a".repeat(10));
		assert.strictEqual(fs.statSync(f).size, 0);
	});

	it("a second rotation replaces .1, and an appending writer lands in the file", () => {
		const f = path.join(sandbox, "twice.log");
		fs.writeFileSync(f, "a".repeat(12));
		const fd = fs.openSync(f, "a");
		rotateDaemonLog(f, 10);
		fs.writeSync(fd, "b".repeat(11));
		rotateDaemonLog(f, 10);
		fs.writeSync(fd, "c");
		fs.closeSync(fd);
		assert.strictEqual(fs.readFileSync(`${f}.1`, "utf8"), "b".repeat(11));
		assert.strictEqual(fs.readFileSync(f, "utf8"), "c");
	});

	it("a missing file is not an error", () => {
		assert.doesNotThrow(() => rotateDaemonLog(path.join(sandbox, "absent", "none.log"), 10));
	});
});

describe("daemonLogPath", () => {
	it("is under XDG_STATE_HOME, else ~/.local/state", () => {
		assert.strictEqual(daemonLogPath({ XDG_STATE_HOME: "/s" }), path.join("/s", "wtft", "daemon.log"));
		assert.strictEqual(daemonLogPath({}), path.join(os.homedir(), ".local", "state", "wtft", "daemon.log"));
	});
});

describe("a spawned daemon's stderr reaches the log", () => {
	it("spawnWtftDaemon", async () => {
		const [script] = standInDaemonArgs('process.stderr.write("from spawnWtftDaemon\\n");');
		assert.ok(spawnWtftDaemon(session(), path.dirname(script)));
		assert.ok(await logGets("from spawnWtftDaemon"), "the stand-in's stderr is not in the log");
	});

	it("restartDaemon", async () => {
		const [script] = standInDaemonArgs('process.stderr.write("from restartDaemon\\n");');
		assert.strictEqual(await restartDaemon(session(), script), true);
		assert.ok(await logGets("from restartDaemon"), "the stand-in's stderr is not in the log");
	});
});

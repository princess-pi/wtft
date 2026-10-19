/**
 * The host-wide test-run log and its per-day count. docs/spec-555-test-failure-log.md.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { trackSandbox } from "./lib/sandbox";

import { appendFailureRecord, countFailures, failureLogPath, firstFailingLine } from "./lib/test-failure-log.ts";

const tmp = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-555-")));

describe("two worktrees, both since deleted", () => {
	const log = path.join(tmp, "state", "wtft-tests", "failures.jsonl");
	const day = "2026-10-19";
	for (const name of ["551-a", "553-b"]) {
		const checkout = path.join(tmp, "clone", ".claude", "worktrees", name);
		fs.mkdirSync(checkout, { recursive: true });
		appendFailureRecord(log, {
			utc: `${day}T12:00:00.000Z`, branch: name, checkout, suites: 183,
			failures: [{ suite: "wtft-239-harness-lifecycle", timedOut: false, line: "❌ FAIL: it reports $0" }],
		});
		fs.rmSync(checkout, { recursive: true, force: true });
	}
	assert.ok(!fs.existsSync(path.join(tmp, "clone", ".claude", "worktrees", "551-a")), "fixture: the worktrees are gone");

	it("counts both runs and both failures on their day", () => {
		const count = countFailures(log, 7, Date.parse(`${day}T20:00:00Z`));
		assert.deepStrictEqual(count?.days, [{ day, runs: 2, failures: { "wtft-239-harness-lifecycle": 2 } }]);
	});
});

describe("the failing line", () => {
	it("takes the first ❌ line, uncoloured", () => {
		assert.strictEqual(firstFailingLine("  ✅ fine\n  \x1b[31m❌ FAIL: the sum is $0\x1b[0m\n  ❌ FAIL: later\n"), "❌ FAIL: the sum is $0");
	});
	it("skips bun's echo of the test's source, which can hold ❌ mid-line", () => {
		assert.strictEqual(firstFailingLine('3 | it("x", () => { console.log("❌ FAIL: y"); });\n(fail) x [1ms]\n'), "(fail) x [1ms]");
	});
	it("takes a line opening FAIL or (fail)", () => {
		assert.strictEqual(firstFailingLine("  PASS a\n  FAIL the harness is not cleaned\n"), "FAIL the harness is not cleaned");
		assert.strictEqual(firstFailingLine("(pass) a\n(fail) b > c [12ms]\n"), "(fail) b > c [12ms]");
	});
	it("falls back to the last non-empty line, cut to 300 characters", () => {
		assert.strictEqual(firstFailingLine("starting\nerror: boom\n\n"), "error: boom");
		assert.strictEqual(firstFailingLine("x".repeat(400)).length, 300);
	});
});

describe("the count", () => {
	const log = path.join(tmp, "count", "failures.jsonl");
	const run = (utc: string, suites: string[]) => appendFailureRecord(log, {
		utc, branch: "b", checkout: "/c", suites: 10,
		failures: suites.map(suite => ({ suite, timedOut: false, line: "" })),
	});
	run("2026-10-10T23:59:59.000Z", ["old"]);
	run("2026-10-17T00:00:00.000Z", []);
	run("2026-10-19T01:00:00.000Z", ["a", "b"]);
	run("2026-10-19T02:00:00.000Z", ["a"]);
	fs.appendFileSync(log, "{ torn\n" + JSON.stringify({ utc: "2026-10-19T03:00:00Z", failures: [null] }) + "\n");
	const now = Date.parse("2026-10-19T20:00:00Z");

	it("holds the last n UTC days with a run, newest first, a day with no failure included", () => {
		assert.deepStrictEqual(countFailures(log, 7, now), {
			days: [
				{ day: "2026-10-19", runs: 2, failures: { a: 2, b: 1 } },
				{ day: "2026-10-17", runs: 1, failures: {} },
			],
			unreadableLines: 2,
		});
	});
	it("one day is today only", () => {
		assert.deepStrictEqual(countFailures(log, 1, now)?.days.map(d => d.day), ["2026-10-19"]);
	});
	it("no log is null, not zero", () => {
		assert.strictEqual(countFailures(path.join(tmp, "none.jsonl"), 7, now), null);
	});
	it("the log is under XDG_STATE_HOME, else ~/.local/state", () => {
		assert.strictEqual(failureLogPath({ XDG_STATE_HOME: "/s" }), "/s/wtft-tests/failures.jsonl");
		assert.strictEqual(failureLogPath({}), path.join(os.homedir(), ".local", "state", "wtft-tests", "failures.jsonl"));
	});
});

describe("bun run test-failures", () => {
	const state = path.join(tmp, "cli-state");
	const log = failureLogPath({ XDG_STATE_HOME: state });
	const today = new Date().toISOString().slice(0, 10);
	appendFailureRecord(log, { utc: new Date().toISOString(), branch: "b", checkout: "/c", suites: 3,
		failures: [{ suite: "wtft-387-private-tmpdir", timedOut: false, line: "FAIL x" }] });
	appendFailureRecord(log, { utc: new Date().toISOString(), branch: "b", checkout: "/c", suites: 3, failures: [] });
	const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(import.meta.dirname, "failures.ts"), ...args], {
		encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: state },
	});

	it("--json is the count under its schema", () => {
		const r = cli("--json");
		assert.strictEqual(r.status, 0, r.stderr);
		assert.deepStrictEqual(JSON.parse(r.stdout), {
			schema: "wtft-test-failures@1", log,
			days: [{ day: today, runs: 2, failures: { "wtft-387-private-tmpdir": 1 } }], unreadableLines: 0,
		});
	});
	it("prints the day, its runs and each failing suite's count", () => {
		const r = cli("--days", "1");
		assert.strictEqual(r.status, 0, r.stderr);
		assert.match(r.stdout, new RegExp(`${today} \\(UTC\\): 2 runs`));
		assert.match(r.stdout, /1 × wtft-387-private-tmpdir/);
	});
	it("no log yet is an empty count, exit 0", () => {
		const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "failures.ts"), "--json"], {
			encoding: "utf8", env: { ...process.env, XDG_STATE_HOME: path.join(tmp, "empty-state") },
		});
		assert.strictEqual(r.status, 0, r.stderr);
		assert.deepStrictEqual(JSON.parse(r.stdout).days, []);
	});
	for (const args of [["--days", "0"], ["--days", "x"], ["--days"], ["--nope"]]) {
		it(`${args.join(" ")} is a bad call, exit 2`, () => {
			assert.strictEqual(cli(...args).status, 2);
		});
	}
});

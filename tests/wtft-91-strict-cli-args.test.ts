/**
 * A wtft call the parser cannot read is refused, in the parser, the CLI and the Pi command.
 */

import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseWtftCliArgs } from "../extensions/lib/wtft-cli-shared.ts";
import { trackSandbox } from "./lib/sandbox.ts";

const CLI_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs");

const refusal = (argv: string[]) => parseWtftCliArgs(argv).usageError;

describe("P parseWtftCliArgs refuses what it cannot read", () => {
	it("P1 an unknown flag, named", () => {
		assert.equal(refusal(["--json"]), undefined);
		assert.match(refusal(["--jsonn"]) ?? "", /--jsonn/);
	});

	it("P2 a bare word, named", () => {
		assert.match(refusal(["foo"]) ?? "", /foo/);
		assert.match(refusal(["--json", "spawn-record"]) ?? "", /spawn-record/);
	});

	it("P3 a valued flag with no value, named, and the flag after it still read", () => {
		const stopped = parseWtftCliArgs(["--stop", "/s.jsonl"]);
		assert.equal(stopped.usageError, undefined);
		assert.equal(stopped.daemonStop, "/s.jsonl", "fixture precondition: --stop takes its value");
		assert.match(refusal(["--stop"]) ?? "", /--stop/);
		const swallowed = parseWtftCliArgs(["--stop", "--json"]);
		assert.match(swallowed.usageError ?? "", /--stop/);
		assert.equal(swallowed.daemonStop, undefined);
		assert.equal(swallowed.json, true);
		for (const flag of ["-s", "--session", "--dir", "--cwd", "--harness", "--pad", "--thinking-budget", "-i", "--interval", "-l", "--limit", "-w", "--width", "--tz", "--timezone"]) {
			assert.match(refusal([flag]) ?? "", new RegExp(`${flag}\\b`), `${flag} last`);
			assert.match(refusal([flag, "--tokens"]) ?? "", new RegExp(`${flag}\\b`), `${flag} before --tokens`);
		}
	});

	it("P4 a value the flag cannot use, naming the flag and the value", () => {
		const bad: string[][] = [
			["--limit", "abc"], ["-l", "3.5"], ["-l", "5x"], ["-l", "0"], ["--limit=abc"], ["--limit="],
			["-i", "9x"], ["--interval", "h"], ["--interval=9x"],
			["--harness", "bogus"],
			["-w", "0"], ["--width", "abc"], ["--width=-3"],
			["--pad", "x"], ["--pad", "1.5"],
			["--thinking-budget", "0"], ["--thinking-budget", "lots"],
			["--tz", "Not/AZone"], ["--timezone=Not/AZone"], ["--tz="],
		];
		for (const argv of bad) {
			const why = refusal(argv) ?? "";
			const flag = argv[0].replace(/=.*$/, "");
			assert.ok(why.includes(flag), `${argv.join(" ")}: names ${flag} in ${JSON.stringify(why)}`);
			const val = argv.length > 1 ? argv[1] : argv[0].slice(argv[0].indexOf("=") + 1);
			if (val) assert.ok(why.includes(val), `${argv.join(" ")}: names ${val} in ${JSON.stringify(why)}`);
		}
	});

	it("P5 every accepted spelling reads clean", () => {
		const good: string[][] = [
			["-h"], ["--help"], ["--version"], ["--why"], ["-o"], ["--other"], ["--tokens"], ["--by-model"],
			["--cost"], ["-C"], ["--no-cost"], ["--no-tokens"], ["--force"], ["-F"], ["--cumulative"], ["-c"],
			["--bucket"], ["-b"], ["--hide"], ["-H"], ["--show"], ["-S"], ["--no-emoji"], ["--no-emojii"],
			["--emoji"], ["--emojii"], ["--pager"], ["-p"], ["-W"], ["--watch"], ["--json"], ["--list"],
			["--cleanup"], ["--restart"],
			["-s", "b04c"], ["--session", "/x/a.jsonl"], ["--dir", "/tmp"], ["--cwd", "."],
			["--harness", "pi"], ["--harness", "claude-code"], ["--harness", "auto"],
			["--pad", "0"], ["--pad", "3"], ["--stop", "~/s.jsonl"], ["--thinking-budget", "800"],
			["-i", "7m"], ["--interval", "4h"], ["-i", "1d"], ["-i", "1w"], ["-i", "5t"], ["-i", "2turns"], ["-i", "1turn"],
			["-l", "3"], ["--limit", "08"], ["-w", "120"], ["--width", "80"], ["--tz", "UTC"], ["--timezone", "America/New_York"],
			["--interval=5m"], ["--limit=3"], ["--width=90"], ["--tz=Europe/London"], ["--timezone=Asia/Tokyo"],
		];
		for (const argv of good) assert.equal(refusal(argv), undefined, argv.join(" "));
		const read = parseWtftCliArgs(["--limit", "08", "--pad", "0", "--tz=Europe/London", "-i", "2turns"]);
		assert.deepEqual([read.limit, read.pad, read.timezone, read.interval], [8, 0, "Europe/London", "2turns"]);
	});
});

describe("C the CLI exits 2 on a refused call and runs nothing else", () => {
	const run = (args: string[]) => {
		const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-91-")));
		const state = path.join(root, "state");
		const tmp = path.join(root, "tmp");
		fs.mkdirSync(state);
		fs.mkdirSync(tmp);
		const r = spawnSync(process.execPath, [CLI_BIN, ...args], {
			cwd: root, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, XDG_STATE_HOME: state, TMPDIR: tmp },
		});
		return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", left: [...fs.readdirSync(state), ...fs.readdirSync(tmp)] };
	};

	for (const [args, named] of [
		[["--jsonn"], "--jsonn"],
		[["--limit", "abc"], "abc"],
		[["--harness", "bogus"], "bogus"],
		[["-i", "9x"], "9x"],
		[["--stop"], "--stop"],
		[["--stop", "--json"], "--stop"],
		[["foo"], "foo"],
		[["--help", "--bogus"], "--bogus"],
	] as [string[], string][]) {
		it(`C wtft ${args.join(" ")}`, () => {
			const r = run(args);
			assert.equal(r.code, 2, r.stderr);
			assert.equal(r.stdout, "");
			assert.ok(r.stderr.includes(named), `stderr names ${named}: ${r.stderr}`);
			assert.deepEqual(r.left, [], "no daemon log, lease or pid file written");
		});
	}

	it("C fixture precondition: a call the parser reads is not refused", () => {
		const r = run(["--version"]);
		assert.equal(r.code, 0, r.stderr);
		assert.ok(r.stdout.length > 0);
	});
});

describe("X the Pi /wtft command shows a refused call as an error and does nothing else", () => {
	function permissive(): any {
		const handler: ProxyHandler<any> = {
			get: (_t, prop) => prop === "then" ? undefined : new Proxy(function () { return permissive(); }, handler),
			apply: () => permissive(),
		};
		return new Proxy(function () {}, handler);
	}

	it("X1 /wtft --jsonn", async () => {
		const xdg = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-91-pi-")));
		process.env.XDG_CONFIG_HOME = xdg;
		const registered: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
		const pi: any = { on: () => {}, registerCommand: (name: string, def: any) => { registered[name] = def; }, registerFlag: () => {}, getFlag: () => undefined };
		await (await import("../extensions/wtft.ts")).default(pi);

		const notes: [string, string][] = [];
		const widgets: unknown[] = [];
		const ui = new Proxy({}, {
			get: (_t, prop) => {
				if (prop === "notify") return (text: string, level: string) => { notes.push([text, level]); };
				if (prop === "setWidget") return (...a: unknown[]) => { widgets.push(a); };
				return permissive();
			},
		});
		const ctx = new Proxy({}, { get: (_t, prop) => prop === "ui" ? ui : prop === "then" ? undefined : permissive() });

		await registered.wtft.handler("--jsonn", ctx);
		assert.equal(notes.length, 1, JSON.stringify(notes));
		assert.equal(notes[0][1], "error");
		assert.match(notes[0][0], /--jsonn/);
		assert.deepEqual(widgets, []);
		assert.deepEqual(fs.readdirSync(xdg), [], "no config written");
	});
});

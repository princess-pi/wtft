/**
 * Token Budget state files: docs/spec-51-token-budget.md § State files.
 */

import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getOrUpdateStats, removeCooldownFile, writeCooldownFile } from "../extensions/token-budget.ts";
import { trackSandbox } from "./lib/sandbox.ts";

let tmp = "";
let saved: string | undefined;

beforeEach(() => {
	tmp = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-433-")));
	saved = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = path.join(tmp, "state");
});

afterEach(() => {
	if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
});

describe("the stats cache", () => {
	it("is read from the wtft state directory", () => {
		const file = path.join(tmp, "state", "wtft", "token-budget-stats.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ timestamp: Date.now(), stats: { zz: { tpm: 4321, lastActiveAge: 7 } } }));

		const stats = getOrUpdateStats([], null, 1000);

		assert.deepStrictEqual(stats.zz, { tpm: 4321, lastActiveAge: 7, sessionTpm: 0 });
	});

	it("is not read through a symlink", () => {
		const real = path.join(tmp, "elsewhere.json");
		fs.writeFileSync(real, JSON.stringify({ timestamp: Date.now(), stats: { zz: { tpm: 4321, lastActiveAge: 7 } } }));
		const file = path.join(tmp, "state", "wtft", "token-budget-stats.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.symlinkSync(real, file);
		assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).stats.zz.tpm, 4321);

		const stats = getOrUpdateStats([], null, 1000);

		assert.strictEqual(stats.zz, undefined);
		assert.strictEqual(JSON.parse(fs.readFileSync(real, "utf8")).stats.zz.tpm, 4321);
		assert.ok(fs.lstatSync(file).isFile());
	});

	it("is skipped, without blocking, when a FIFO sits at its path", () => {
		const file = path.join(tmp, "state", "wtft", "token-budget-stats.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		execFileSync("mkfifo", [file]);
		assert.ok(fs.lstatSync(file).isFIFO());

		const stats = getOrUpdateStats([], null, 1000);

		assert.deepStrictEqual(stats, {});
	});

	it("is not read when its timestamp is in the future", () => {
		const file = path.join(tmp, "state", "wtft", "token-budget-stats.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ timestamp: Date.now() + 3_600_000, stats: { zz: { tpm: 4321, lastActiveAge: 7 } } }));

		const stats = getOrUpdateStats([], null, 1000);

		assert.strictEqual(stats.zz, undefined);
	});

	it("is written there, creating the directory", () => {
		const file = path.join(tmp, "state", "wtft", "token-budget-stats.json");
		assert.strictEqual(fs.existsSync(path.join(tmp, "state")), false);
		const before = Date.now();

		getOrUpdateStats([], null, 1000);

		const written = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.deepStrictEqual(written.stats, {});
		assert.ok(written.timestamp >= before && written.timestamp <= Date.now());
	});
});

describe("the cooldown file", () => {
	it("is written to and removed from the wtft state directory", () => {
		const file = path.join(tmp, "state", "wtft", "token-budget-cooldown.json");
		assert.strictEqual(fs.existsSync(path.join(tmp, "state")), false);

		writeCooldownFile(1_750_000_000_000);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), { startTime: 1_750_000_000_000, endTime: 1_750_000_040_000 });

		removeCooldownFile();
		assert.strictEqual(fs.existsSync(file), false);
	});
});

/**
 * Token Budget state files: docs/spec-51-token-budget.md § State files.
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getOrUpdateStats, removeCooldownLockfile, writeCooldownLockfile } from "../extensions/token-budget.ts";
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

describe("the cooldown lockfile", () => {
	it("is written in the wtft state directory for the cooldown's span, and removed at its end", () => {
		const file = path.join(tmp, "state", "wtft", "token-budget-cooldown.json");
		assert.strictEqual(fs.existsSync(path.join(tmp, "state")), false);

		writeCooldownLockfile(1_750_000_000_000);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")), { startTime: 1_750_000_000_000, endTime: 1_750_000_040_000 });

		removeCooldownLockfile();
		assert.strictEqual(fs.existsSync(file), false);
	});
});

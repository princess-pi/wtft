/**
 * The host-wide test-run log and its per-day count. docs/spec-555-test-failure-log.md.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";

import { appendFailureRecord, countFailures } from "./lib/test-failure-log.ts";

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

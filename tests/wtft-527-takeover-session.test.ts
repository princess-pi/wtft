/**
 * `takeOverLease` signals a per-session daemon only when it serves the lease being taken.
 * docs/spec-270-daemon-ownership.md § 1b.
 */

import * as assert from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import { useProcessTable } from "../extensions/lib/holder.ts";
import { leaseHolder, takeOverLease } from "../extensions/lib/lease.ts";
import { getDaemonPidPath, isSessionIdBasename, servesLease } from "../extensions/lib/wtft-daemon-lib.ts";
import { fakeProcessTable } from "./lib/fake-process-table.ts";

const MINE = "/p/mine.jsonl";
const HOLDER = 4242;

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

function leaseNaming(pid: number): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-527-"));
	const file = path.join(dir, "wtft-daemon-x.pid");
	fs.writeFileSync(file, String(pid));
	return file;
}

const servesMine = (session: string) => session === MINE;
const noWait = () => {};

describe("takeOverLease", () => {
	it("takes a lease from a daemon serving another session without signalling it", () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		t.daemon(HOLDER, ["--session", "/p/other.jsonl"]);
		const file = leaseNaming(HOLDER);
		assert.strictEqual(leaseHolder(file), String(HOLDER), "precondition: the lease names the other daemon");
		assert.ok(t.alive(HOLDER), "precondition: the other daemon is alive");
		assert.strictEqual(takeOverLease(file, "100", servesMine, noWait), true);
		assert.deepStrictEqual(t.signals, []);
		assert.strictEqual(leaseHolder(file), "100");
		assert.ok(t.alive(HOLDER));
	});

	it("reads -s as --session", () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		t.daemon(HOLDER, ["-s", "/p/other.jsonl"]);
		const file = leaseNaming(HOLDER);
		assert.strictEqual(takeOverLease(file, "100", servesMine, noWait), true);
		assert.deepStrictEqual(t.signals, []);
	});

	it("stops a daemon serving this lease, then claims", () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		t.daemon(HOLDER, ["--session", MINE]);
		const file = leaseNaming(HOLDER);
		assert.strictEqual(takeOverLease(file, "100", servesMine, noWait), true);
		assert.deepStrictEqual(t.signals, [{ pid: HOLDER, sig: "SIGTERM" }]);
		assert.strictEqual(leaseHolder(file), "100");
	});

	it("leaves a harness holder alone and answers false", () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		t.daemon(HOLDER, ["--harness", "claude", "--session", MINE]);
		const file = leaseNaming(HOLDER);
		assert.strictEqual(takeOverLease(file, "100", servesMine, noWait), false);
		assert.deepStrictEqual(t.signals, []);
		assert.strictEqual(leaseHolder(file), String(HOLDER));
	});

	it("gives up after 20 signals to a daemon serving this lease that will not stop", () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		t.daemon(HOLDER, ["--session", MINE], "ignores-term");
		const file = leaseNaming(HOLDER);
		assert.strictEqual(takeOverLease(file, "100", servesMine, noWait), false);
		assert.strictEqual(t.signals.length, 20);
		assert.strictEqual(leaseHolder(file), String(HOLDER));
	});
});

describe("servesLease, the predicate adoption passes", () => {
	const id = crypto.randomUUID();
	const notes = `notes-${id.replaceAll("-", "")}.jsonl`;
	const cases: { name: string; lease: string; holder: string; signalled: boolean }[] = [
		{ name: "a session-id transcript, moved to another project", lease: `/a/${id}.jsonl`, holder: `/b/${id}.jsonl`, signalled: true },
		{ name: "another session-id transcript", lease: `/a/${id}.jsonl`, holder: `/a/${crypto.randomUUID()}.jsonl`, signalled: false },
		{ name: "the same non-id path", lease: `/p/${notes}`, holder: `/p/${notes}`, signalled: true },
		{ name: "a non-id file of the same name elsewhere", lease: `/p/${notes}`, holder: `/q/${notes}`, signalled: false },
	];
	for (const c of cases) {
		it(`${c.name}: ${c.signalled ? "signalled" : "left running"}`, () => {
			assert.strictEqual(isSessionIdBasename(c.lease), !c.lease.includes("notes-"), "precondition: the fixture names the lease kind it means");
			const t = fakeProcessTable();
			restore = useProcessTable(t);
			t.daemon(HOLDER, ["--session", c.holder]);
			const file = getDaemonPidPath(c.lease);
			fs.writeFileSync(file, String(HOLDER));
			try {
				assert.strictEqual(takeOverLease(file, "100", servesLease(file), noWait), true);
				assert.deepStrictEqual(t.signals.length > 0, c.signalled);
				assert.strictEqual(leaseHolder(file), "100");
			} finally {
				fs.rmSync(file, { force: true });
			}
		});
	}
});

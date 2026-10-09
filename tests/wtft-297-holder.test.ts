/**
 * The holder module against an in-memory process table. docs/spec-holder.md § 4.
 */

import * as assert from "node:assert";
import { afterEach, describe, it } from "node:test";

import { classifyPid, holdsLease, mayStop, stopHolder, stopHolderSync, useProcessTable } from "../extensions/lib/holder.ts";
import { fakeProcessTable } from "./lib/fake-process-table.ts";

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

describe("classifyPid", () => {
	it("names every kind on Linux", () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		t.daemon(101, ["--session", "/s.jsonl"]);
		t.daemon(102, ["--harness", "claude"]);
		t.add(103, ["sleep", "30"]);
		t.daemon(104, [], "zombie");
		t.signal(104, "SIGTERM");
		t.add(105, ["node", "/other/user/wtft-daemon.ts"], "denied");
		assert.strictEqual(classifyPid(101), "daemon");
		assert.strictEqual(classifyPid(102), "harness");
		assert.strictEqual(classifyPid(103), "other", "a recycled pid");
		assert.strictEqual(classifyPid(104), "gone", "a zombie");
		assert.strictEqual(classifyPid(105), "daemon", "EPERM is alive, and its cmdline still reads");
		assert.strictEqual(classifyPid(999), "gone");
		t.daemon(106, [], "denied");
		t.hide(106);
		assert.strictEqual(classifyPid(106), "unverified", "hidepid: alive by signal 0, /proc unreadable");
		for (const bad of [0, -1, 1.5, Number.NaN]) assert.strictEqual(classifyPid(bad), "gone");
	});

	it("reads a daemon path only as the program or the script a node or bun runs", () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		const cases: [string[], string][] = [
			[["node", "app.js", "--input", "/tmp/wtft-daemon.js"], "other"],
			[["node", "-e", "0", "/tmp/wtft-daemon.mjs"], "other"],
			[["vim", "/tmp/wtft-daemon.ts"], "other"],
			[["/home/u/bin/wtft-daemon", "--session", "/s.jsonl"], "daemon"],
			[["node", "--heapsnapshot-signal=SIGUSR2", "/b/wtft-daemon.mjs", "--harness", "claude"], "harness"],
			[["/n/bun/bin/bun.exe", "--preload", "/t/inject.ts", "/b/wtft-daemon.mjs", "--session", "/s.jsonl"], "daemon"],
			[["node", "--eval=0", "/tmp/wtft-daemon.js"], "other"],
			[["node", "-pe", "1", "/tmp/wtft-daemon.mjs"], "other"],
			[["node", "-e=0", "/tmp/wtft-daemon.mjs"], "other"],
			[["bun", "run", "/b/wtft-daemon.mjs", "--session", "/s.jsonl"], "daemon"],
			[["node20", "/b/wtft-daemon.mjs"], "daemon"],
			[["node", "/usr/local/bin/prettier", "--write", "/x/wtft-daemon.js"], "other"],
		];
		cases.forEach(([cmdline], i) => t.add(200 + i, cmdline));
		for (const [i, [cmdline, kind]] of cases.entries()) assert.strictEqual(classifyPid(200 + i), kind, cmdline.join(" "));
	});

	it("cannot verify anything off Linux", () => {
		const t = fakeProcessTable({ linux: false });
		restore = useProcessTable(t);
		t.add(103, ["sleep", "30"]);
		assert.strictEqual(classifyPid(103), "unverified");
		assert.strictEqual(classifyPid(999), "gone");
	});

	it("holdsLease and mayStop split the kinds as the spec says; an unverified pid is never stopped, on any host", () => {
		restore = useProcessTable(fakeProcessTable());
		assert.deepStrictEqual(
			(["gone", "daemon", "harness", "other", "unverified"] as const).map(k => [k, holdsLease(k), mayStop(k)]),
			[["gone", false, false], ["daemon", true, true], ["harness", true, false], ["other", false, false], ["unverified", true, false]],
		);
		restore();
		restore = useProcessTable(fakeProcessTable({ linux: false }));
		assert.strictEqual(mayStop("unverified"), false);
	});
});

describe("stopping", () => {
	const fast = { termMs: 30, killMs: 30, pollMs: 1 };
	it("stopped, survived, denied; SIGKILL only after SIGTERM failed", async () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		t.daemon(201);
		t.daemon(202, [], "ignores-term");
		t.daemon(203, [], "survives");
		t.daemon(204, [], "denied");
		t.daemon(205, [], "zombie");
		assert.strictEqual(await stopHolder(201, fast), "stopped");
		assert.strictEqual(await stopHolder(202, fast), "stopped");
		assert.strictEqual(await stopHolder(203, fast), "survived");
		assert.strictEqual(await stopHolder(204, fast), "denied");
		assert.strictEqual(stopHolderSync(205, fast), "stopped", "a zombie is gone");
		assert.deepStrictEqual(t.signals.filter(s => s.pid === 201).map(s => s.sig), ["SIGTERM"]);
		assert.deepStrictEqual(t.signals.filter(s => s.pid === 202).map(s => s.sig), ["SIGTERM", "SIGKILL"]);
	});

	it("no SIGKILL for a pid recycled into another process during the SIGTERM wait", async () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		t.daemon(401, [], "ignores-term");
		t.afterTerm(401, () => { t.add(401, ["sleep", "30"]); });
		assert.strictEqual(await stopHolder(401, fast), "stopped", "the daemon it was asked to stop is gone");
		assert.deepStrictEqual(t.signals.map(s => s.sig), ["SIGTERM"]);
		assert.ok(t.alive(401), "the new process was not signalled");
	});

	it("no SIGKILL for a pid recycled into another daemon during the SIGTERM wait", async () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		t.daemon(402, [], "ignores-term");
		t.afterTerm(402, () => { t.daemon(402); });
		assert.strictEqual(await stopHolder(402, fast), "stopped");
		assert.deepStrictEqual(t.signals.map(s => s.sig), ["SIGTERM"]);
	});

	it("killMs 0 sends no SIGKILL", () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		t.daemon(301, [], "ignores-term");
		assert.strictEqual(stopHolderSync(301, { ...fast, killMs: 0 }), "survived");
		assert.deepStrictEqual(t.signals.map(s => s.sig), ["SIGTERM"]);
	});
});

// ---
// The slice 1 callers, with the fake table swapped in (spec § 4, C1 to C4)
// ---

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";
import { readHealthFacts } from "../extensions/lib/daemon-health.ts";
import { claimLeaseForChild, leaseHolder } from "../extensions/lib/lease.ts";
import { forceRebuildSession, getDaemonPidPath, restartDaemon } from "../extensions/lib/wtft-daemon-lib.ts";

const sandbox = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-297-")));
process.env.TMPDIR = sandbox;
let sessionSeq = 0;
function session(): { file: string; lease: string } {
	const file = path.join(sandbox, "sessions", `s${sessionSeq++}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "");
	const lease = getDaemonPidPath(file);
	assert.ok(lease.startsWith(sandbox), "precondition: leases live in the sandbox");
	return { file, lease };
}

describe("C1 health", () => {
	it("a lease naming a recycled pid is not alive; a daemon or an unverifiable pid is", () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		const { file, lease } = session();
		t.add(401, ["sleep", "30"]);
		t.daemon(402, ["--session", file]);
		fs.writeFileSync(lease, "401");
		assert.strictEqual(readHealthFacts(file, lease, lease + ".tag").holderAlive, false);
		fs.writeFileSync(lease, "402");
		assert.strictEqual(readHealthFacts(file, lease, lease + ".tag").holderAlive, true);
		restore();
		const off = fakeProcessTable({ linux: false });
		restore = useProcessTable(off);
		off.add(401, ["sleep", "30"]);
		fs.writeFileSync(lease, "401");
		assert.strictEqual(readHealthFacts(file, lease, lease + ".tag").holderAlive, true, "off Linux it cannot be told apart");
	});
});

describe("C2 the spawner's claim", () => {
	it("displaces a non-daemon holder and keeps a daemon's", () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		const { lease } = session();
		t.add(501, ["sleep", "30"]);
		t.daemon(502);
		t.daemon(503);
		fs.writeFileSync(lease, "501");
		assert.strictEqual(claimLeaseForChild(lease, 502), "claimed");
		assert.strictEqual(leaseHolder(lease), "502");
		assert.strictEqual(claimLeaseForChild(lease, 503), "busy");
	});
});

describe("C3 restartDaemon", () => {
	it("never signals a non-daemon holder, and the new child takes the lease", async () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		const { file, lease } = session();
		t.add(601, ["sleep", "30"]);
		fs.writeFileSync(lease, "601");
		assert.strictEqual(await restartDaemon(file, "/x/bin/wtft-daemon.mjs"), true);
		assert.deepStrictEqual(t.signals, []);
		assert.ok(t.alive(601));
		assert.strictEqual(t.spawned.length, 1);
		assert.strictEqual(leaseHolder(lease), String(t.spawned[0].pid));
	});
	it("stops a daemon holder before spawning", async () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		const { file, lease } = session();
		t.daemon(602, ["--session", file]);
		fs.writeFileSync(lease, "602");
		assert.strictEqual(await restartDaemon(file, "/x/bin/wtft-daemon.mjs"), true);
		assert.deepStrictEqual(t.signals, [{ pid: 602, sig: "SIGTERM" }]);
		assert.strictEqual(leaseHolder(lease), String(t.spawned[0].pid));
	});
	it("an EPERM holder is not stopped, and nothing is spawned", async () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		const { file, lease } = session();
		t.daemon(603, ["--session", file], "denied");
		fs.writeFileSync(lease, "603");
		assert.strictEqual(await restartDaemon(file, "/x/bin/wtft-daemon.mjs"), false);
		assert.strictEqual(t.spawned.length, 0);
		assert.strictEqual(leaseHolder(lease), "603");
	});
	it("a spawn that throws resolves false, so --watch shows restart failed", async () => {
		const t = fakeProcessTable();
		restore = useProcessTable({ ...t, spawn: () => { throw new Error("EAGAIN"); } });
		const { file } = session();
		assert.strictEqual(await restartDaemon(file, "/x/bin/wtft-daemon.mjs"), false);
	});
});

describe("C4 -F", () => {
	it("a lease a harness took while -F stopped its per-session holder gets the rebuild token", () => {
		const t = fakeProcessTable();
		const f = session();
		t.daemon(704, ["--session", f.file]);
		t.daemon(703, ["--harness", "claude"]);
		fs.writeFileSync(f.lease, "704");
		restore = useProcessTable({ ...t, signal(pid, sig) {
			const sent = t.signal(pid, sig);
			if (pid === 704 && sig === "SIGTERM") fs.writeFileSync(f.lease, "703");
			return sent;
		} });
		assert.strictEqual(forceRebuildSession(f.file, { termMs: 30, pollMs: 1 }), "rebuild");
		assert.strictEqual(leaseHolder(f.lease), "rebuild");
	});
	it("a harness gets the rebuild token; a daemon is stopped; a non-daemon is not signalled", () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		const a = session();
		t.daemon(701, ["--harness", "claude"]);
		fs.writeFileSync(a.lease, "701");
		assert.strictEqual(forceRebuildSession(a.file), "rebuild");
		assert.strictEqual(leaseHolder(a.lease), "rebuild");
		const b = session();
		t.daemon(702, ["--session", b.file]);
		fs.writeFileSync(b.lease, "702");
		assert.strictEqual(forceRebuildSession(b.file), "stopped");
		const c = session();
		t.add(703, ["sleep", "30"]);
		fs.writeFileSync(c.lease, "703");
		assert.strictEqual(forceRebuildSession(c.file), "deleted");
		assert.ok(t.alive(703));
		assert.deepStrictEqual(t.signals, [{ pid: 702, sig: "SIGTERM" }]);
	});
	it("a daemon that outlives SIGTERM keeps its lease and tag, and gets no SIGKILL", () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		const { file, lease } = session();
		t.daemon(704, ["--session", file], "ignores-term");
		fs.writeFileSync(lease, "704");
		assert.strictEqual(forceRebuildSession(file, { termMs: 30, pollMs: 1 }), "busy");
		assert.deepStrictEqual(t.signals.map(s => s.sig), ["SIGTERM"]);
	});
	it("on Linux an unverifiable holder (hidepid) is not signalled", () => {
		const t = fakeProcessTable();
		restore = useProcessTable(t);
		const { file, lease } = session();
		t.daemon(706, ["--session", file]);
		t.hide(706);
		fs.writeFileSync(lease, "706");
		assert.strictEqual(forceRebuildSession(file, { termMs: 30, pollMs: 1 }), "busy");
		assert.deepStrictEqual(t.signals, []);
	});
	it("off Linux a holder the ps read names as something else is not signalled, and its lease is stale (#266)", () => {
		const t = fakeProcessTable({ linux: false });
		restore = useProcessTable(t);
		const { file, lease } = session();
		t.add(705, ["sleep", "600"]);
		fs.writeFileSync(lease, "705");
		assert.strictEqual(forceRebuildSession(file), "deleted");
		assert.deepStrictEqual(t.signals, []);
		assert.ok(t.alive(705));
	});
	it("off Linux a daemon the ps read verifies is stopped", () => {
		const t = fakeProcessTable({ linux: false });
		restore = useProcessTable(t);
		const { file, lease } = session();
		t.daemon(707, ["--session", file]);
		fs.writeFileSync(lease, "707");
		assert.strictEqual(forceRebuildSession(file, { termMs: 30, pollMs: 1 }), "stopped");
		assert.deepStrictEqual(t.signals.map(s => s.sig), ["SIGTERM"]);
	});
	it("off Linux a daemon whose runtime path the ps read split at a space is still stopped", () => {
		const t = fakeProcessTable({ linux: false });
		restore = useProcessTable(t);
		const { file, lease } = session();
		t.add(708, ["/Users/Jane", "Doe/.nvm/bin/node", "/Users/Jane", "Doe/bin/wtft-daemon.mjs", "--session", file]);
		fs.writeFileSync(lease, "708");
		assert.strictEqual(forceRebuildSession(file, { termMs: 30, pollMs: 1 }), "stopped");
		assert.deepStrictEqual(t.signals.map(s => s.sig), ["SIGTERM"]);
	});
	it("off Linux a holder no read can verify is not signalled, and -F is busy", () => {
		const t = fakeProcessTable({ linux: false, ps: false });
		restore = useProcessTable(t);
		const { file, lease } = session();
		t.daemon(708, ["--session", file]);
		fs.writeFileSync(lease, "708");
		assert.strictEqual(forceRebuildSession(file), "busy");
		assert.deepStrictEqual(t.signals, []);
	});
});

describe("restartDaemon off Linux (#266)", () => {
	it("does not signal or replace a holder no read can verify", async () => {
		const t = fakeProcessTable({ linux: false, ps: false });
		restore = useProcessTable(t);
		const { file, lease } = session();
		t.daemon(709, ["--session", file]);
		fs.writeFileSync(lease, "709");
		assert.strictEqual(await restartDaemon(file, "/x/bin/wtft-daemon.mjs"), false);
		assert.deepStrictEqual(t.signals, []);
		assert.deepStrictEqual(t.spawned, []);
	});
	it("sends a verified daemon SIGTERM only, never SIGKILL", async () => {
		const t = fakeProcessTable({ linux: false });
		restore = useProcessTable(t);
		const { file, lease } = session();
		t.daemon(710, ["--session", file], "ignores-term");
		fs.writeFileSync(lease, "710");
		assert.strictEqual(await restartDaemon(file, "/x/bin/wtft-daemon.mjs"), false);
		assert.deepStrictEqual(t.signals.map(s => s.sig), ["SIGTERM"]);
	});
	it("removes the lease of a holder the ps read names as something else, and spawns", async () => {
		const t = fakeProcessTable({ linux: false });
		restore = useProcessTable(t);
		const { file, lease } = session();
		t.add(711, ["sleep", "600"]);
		fs.writeFileSync(lease, "711");
		assert.strictEqual(await restartDaemon(file, "/x/bin/wtft-daemon.mjs"), true);
		assert.deepStrictEqual(t.signals, []);
		assert.strictEqual(t.spawned.length, 1);
		assert.notStrictEqual(fs.readFileSync(lease, "utf8").trim(), "711");
	});
	it("-F stops a verified harness, since a harness start cannot hand it the session", () => {
		const t = fakeProcessTable({ linux: false });
		restore = useProcessTable(t);
		const { file, lease } = session();
		t.daemon(712, ["--harness", "claude"]);
		fs.writeFileSync(lease, "712");
		assert.strictEqual(forceRebuildSession(file, { termMs: 30, pollMs: 1 }), "stopped");
		assert.deepStrictEqual(t.signals.map(s => s.sig), ["SIGTERM"]);
	});
});

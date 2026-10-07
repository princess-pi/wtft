/**
 * The daemon roster: docs/spec-442-daemon-roster.md § 5.
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { activeTagFiles, decideActive, publishRoster, rosterDir, type RosterEntry } from "../extensions/lib/daemon-roster.ts";
import { useProcessTable } from "../extensions/lib/holder.ts";
import { spawn } from "node:child_process";
import { getCurrentVersionTagPath } from "../extensions/lib/wtft-daemon-lib.ts";
import { tagForCli } from "./lib/cli-harness.ts";
import { fakeProcessTable } from "./lib/fake-process-table.ts";
import { piHeader, piTurn } from "./lib/golden-corpus.ts";
import { pollUntil } from "./lib/poll.ts";
import { isolateTmpdir, trackSandbox } from "./lib/sandbox.ts";
import { skip } from "./lib/skips.ts";

const NOW = 1_800_000_000_000;

function roster(file: string, holder: RosterEntry["holder"], tags: [string, number | null][]): RosterEntry {
	return { file, holder, tags: tags.map(([p, ago]) => ({ path: p, mtimeMs: ago === null ? null : NOW - ago })) };
}

describe("decideActive", () => {
	it("returns a live daemon's tag written within the window", () => {
		const { active, prune } = decideActive([roster("/r/101.json", "daemon", [["/t/a.jsonl", 5_000]])], NOW);
		assert.deepStrictEqual(active, [{ path: "/t/a.jsonl", mtime: NOW - 5_000 }]);
		assert.deepStrictEqual(prune, []);
	});

	it("keeps a stopped daemon's roster while one of its tags is in the window, then prunes it", () => {
		const { active, prune } = decideActive([
			roster("/r/201.json", "gone", [["/t/recent.jsonl", 119_999], ["/t/older.jsonl", 500_000]]),
			roster("/r/202.json", "gone", [["/t/old.jsonl", 120_000]]),
			roster("/r/203.json", "other", [["/t/recycled.jsonl", 900_000], ["/t/vanished.jsonl", null]]),
			roster("/r/204.json", "gone", []),
			roster("/r/205.json", "daemon", [["/t/live-but-quiet.jsonl", 900_000]]),
			roster("/r/206.json", "other", [["/t/recycled-but-recent.jsonl", 1_000]]),
		], NOW);
		assert.deepStrictEqual(active, [
			{ path: "/t/recent.jsonl", mtime: NOW - 119_999 },
			{ path: "/t/recycled-but-recent.jsonl", mtime: NOW - 1_000 },
		]);
		assert.deepStrictEqual(prune, ["/r/202.json", "/r/203.json", "/r/204.json"]);
	});

	it("skips a tag it could not stat or one outside the window, and returns a hand-over's path once", () => {
		const { active, prune } = decideActive([
			roster("/r/301.json", "harness", [["/t/shared.jsonl", 2_000], ["/t/vanished.jsonl", null], ["/t/quiet.jsonl", 120_000]]),
			roster("/r/302.json", "unverified", [["/t/shared.jsonl", 2_000], ["/t/own.jsonl", 119_999]]),
		], NOW);
		assert.deepStrictEqual(active, [
			{ path: "/t/shared.jsonl", mtime: NOW - 2_000 },
			{ path: "/t/own.jsonl", mtime: NOW - 119_999 },
		]);
		assert.deepStrictEqual(prune, []);
	});
});

describe("the roster on disk", () => {
	let tmp = "";
	let savedState: string | undefined;
	let restore: (() => void) | null = null;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-442-"));
		savedState = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = path.join(tmp, "state");
	});
	afterEach(() => {
		restore?.();
		restore = null;
		if (savedState === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = savedState;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	function tag(name: string, agoMs: number): string {
		const p = path.join(tmp, "tags", name);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, "{}\n");
		const t = new Date(Date.now() - agoMs);
		fs.utimesSync(p, t, t);
		return p;
	}

	it("publishes on change only, re-creates a roster someone deleted, and removes it when empty", () => {
		const own = path.join(rosterDir(), `${process.pid}.json`);
		const a = tag("a.jsonl", 1_000);
		const b = tag("b.jsonl", 1_000);
		publishRoster([a]);
		const old = new Date(Date.now() - 600_000);
		fs.utimesSync(own, old, old);
		publishRoster([a]);
		assert.strictEqual(fs.statSync(own).mtimeMs, old.getTime(), "unchanged input does not rewrite");
		publishRoster([b, a, a]);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(own, "utf8")).tags, [a, b]);
		fs.rmSync(own);
		publishRoster([b, a]);
		assert.ok(fs.existsSync(own), "a roster deleted under a live daemon comes back on its next publish");
		publishRoster([]);
		assert.ok(!fs.existsSync(own), "an empty list removes the roster");
	});

	it("finds this daemon's published tags and prunes a dead daemon's old roster", () => {
		const table = fakeProcessTable();
		restore = useProcessTable(table);
		table.daemon(process.pid, ["--session", "/s.jsonl"]);
		const live = tag("live.jsonl", 1_000);
		const quiet = tag("quiet.jsonl", 600_000);
		publishRoster([quiet, live]);
		assert.strictEqual(rosterDir(), path.join(tmp, "state", "wtft", "roster"));
		const own = path.join(rosterDir(), `${process.pid}.json`);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(own, "utf8")), { v: 1, pid: process.pid, tags: [live, quiet].sort() });

		const writeRosterText = (pid: number, doc: unknown): string => {
			const file = path.join(rosterDir(), `${pid}.json`);
			fs.writeFileSync(file, JSON.stringify(doc));
			return file;
		};
		const writeRoster = (pid: number, tags: string[]): string => {
			const file = path.join(rosterDir(), `${pid}.json`);
			fs.writeFileSync(file, JSON.stringify({ v: 1, pid, tags }));
			return file;
		};
		const justStopped = writeRoster(4_000_001, [tag("last-minute.jsonl", 30_000)]);
		const longStopped = writeRoster(4_000_002, [tag("dead.jsonl", 600_000)]);
		const garbage = path.join(rosterDir(), "4000003.json");
		fs.writeFileSync(garbage, "not json");
		const malformed = [
			writeRosterText(4_000_004, { v: 2, pid: 4_000_004, tags: [] }),
			writeRosterText(4_000_005, { v: 1, pid: 4_000_099, tags: [] }),
			writeRosterText(4_000_006, { v: 1, pid: 4_000_006, tags: "not a list" }),
		];
		const deadTmp = path.join(rosterDir(), "4000007.json.tmp");
		fs.writeFileSync(deadTmp, "{");
		const liveTmp = path.join(rosterDir(), `${process.pid}.json.tmp`);
		fs.writeFileSync(liveTmp, "{");
		const stray = path.join(rosterDir(), "notes.txt");
		fs.writeFileSync(stray, "kept");

		const found = activeTagFiles(Date.now()).files;
		assert.deepStrictEqual(found.map(f => f.path).sort(), [live, path.join(tmp, "tags", "last-minute.jsonl")].sort());
		assert.ok(fs.existsSync(own), "a live daemon's roster stays");
		assert.ok(fs.existsSync(justStopped), "a stopped daemon's roster stays while its last turns are in the window");
		assert.ok(!fs.existsSync(longStopped), "a stopped daemon's quiet roster is deleted");
		assert.ok(!fs.existsSync(garbage), "a stopped daemon's unreadable roster is deleted");
		for (const f of malformed) assert.ok(!fs.existsSync(f), `a stopped daemon's roster with the wrong version, pid or tags is deleted: ${path.basename(f)}`);
		assert.ok(!fs.existsSync(deadTmp), "a stopped daemon's half-written roster is deleted");
		assert.ok(fs.existsSync(liveTmp), "a live daemon's half-written roster stays");
		assert.ok(fs.existsSync(stray), "a file that is not a roster is left alone");
		assert.strictEqual(fs.statSync(rosterDir()).mode & 0o777, 0o700, "the roster directory is private");
	});
});

describe("a roster that cannot be deleted", () => {
	it("still returns the active tags", () => {
		const tmp = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-442-ro-")));
		const saved = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = path.join(tmp, "state");
		const table = fakeProcessTable();
		const restore = useProcessTable(table);
		const dir = rosterDir();
		try {
			const live = path.join(tmp, "live.jsonl");
			fs.writeFileSync(live, "{}\n");
			fs.mkdirSync(dir, { recursive: true });
			table.daemon(4_100_001, ["--session", "/s.jsonl"]);
			fs.writeFileSync(path.join(dir, "4100001.json"), JSON.stringify({ v: 1, pid: 4_100_001, tags: [live] }));
			fs.writeFileSync(path.join(dir, "4100002.json"), "not json");
			fs.chmodSync(dir, 0o500);
			let unlinkRefused = false;
			try { fs.unlinkSync(path.join(dir, "4100002.json")); } catch { unlinkRefused = true; }
			if (!unlinkRefused) {
				skip("this process can unlink inside a read-only directory (root), so a refused delete cannot be staged");
				return;
			}
			assert.deepStrictEqual(activeTagFiles(Date.now()).files.map(f => f.path), [live]);
		} finally {
			fs.chmodSync(dir, 0o700);
			restore();
			if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
		}
	});
});

describe("daemons publish their roster", () => {
	const DAEMON = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
	const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-442-daemons-")));
	const projects = path.join(root, "claude");
	const state = path.join(root, "state");
	const env = { ...process.env, TMPDIR: isolateTmpdir("442-roster"), XDG_STATE_HOME: state, WTFT_CLAUDE_PROJECTS_DIR: projects, WTFT_PI_SESSIONS_DIR: path.join(root, "pi") };
	const started: number[] = [];
	afterEach(() => {
		for (const pid of started.splice(0)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
	});

	function session(name: string): string {
		const file = path.join(projects, "proj", `${name}.jsonl`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const iso = new Date().toISOString();
		fs.writeFileSync(file, JSON.stringify({
			type: "message", timestamp: iso,
			message: { role: "assistant", id: `m-${name}`, model: "claude-sonnet-4-6", timestamp: iso, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] },
		}) + "\n");
		return file;
	}

	function start(args: string[]): number {
		const child = spawn("node", [DAEMON, ...args], { detached: true, stdio: "ignore", env });
		child.unref();
		started.push(child.pid!);
		return child.pid!;
	}

	async function rosterOf(pid: number): Promise<string[] | null> {
		const file = path.join(state, "wtft", "roster", `${pid}.json`);
		await pollUntil(() => fs.existsSync(file), 10_000);
		if (!fs.existsSync(file)) return null;
		return JSON.parse(fs.readFileSync(file, "utf8")).tags;
	}

	it("a per-session daemon lists its tag file", { timeout: 30_000 }, async () => {
		const s = session("per-session");
		const pid = start(["--session", s]);
		assert.deepStrictEqual(await rosterOf(pid), [getCurrentVersionTagPath(s)]);
	});

	it("a harness daemon lists every session it serves", { timeout: 30_000 }, async () => {
		const a = session("harness-a");
		const pid = start(["--harness", "claude", "--session", a]);
		assert.deepStrictEqual(await rosterOf(pid), [getCurrentVersionTagPath(a)]);
		const b = session("harness-b");
		start(["--harness", "claude", "--session", b]);
		const both = [getCurrentVersionTagPath(a), getCurrentVersionTagPath(b)].sort();
		const file = path.join(state, "wtft", "roster", `${pid}.json`);
		await pollUntil(() => {
			try { return JSON.parse(fs.readFileSync(file, "utf8")).tags.length === 2; } catch { return false; }
		}, 15_000);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).tags, both, "a session asked of the live harness joins its roster");
	});
});

describe("Token Budget reads the roster", () => {
	it("counts a session's TPM from a tag reachable only through the roster", { timeout: 30_000 }, async () => {
		const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-442-budget-")));
		const saved = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, WTFT_CLAUDE_PROJECTS_DIR: process.env.WTFT_CLAUDE_PROJECTS_DIR, HOME: process.env.HOME };
		process.env.XDG_STATE_HOME = path.join(root, "state");
		process.env.XDG_CONFIG_HOME = path.join(root, "config");
		process.env.WTFT_CLAUDE_PROJECTS_DIR = path.join(root, "empty-projects");
		process.env.HOME = path.join(root, "empty-home");
		const table = fakeProcessTable();
		const restore = useProcessTable(table);
		try {
			const id = "01aa0000-0000-4000-8000-000000000442";
			const sessionFile = path.join(root, "elsewhere", `2026-10-06T00-00-00-000Z_${id}.jsonl`);
			fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
			const now = Date.now();
			fs.writeFileSync(sessionFile, piHeader(id, now - 50_000, root) + piTurn("t1", now - 40_000, 10) + piTurn("t2", now - 20_000, 10));
			const tagPath = tagForCli(sessionFile).tagPath;

			const daemonPid = 4_000_442;
			table.daemon(daemonPid, ["--session", sessionFile]);
			const dir = path.join(root, "state", "wtft", "roster");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, `${daemonPid}.json`), JSON.stringify({ v: 1, pid: daemonPid, tags: [tagPath] }));

			const { default: tokenBudgetExtension, aggregateActiveTpm } = await import("../extensions/token-budget.ts");
			const direct = aggregateActiveTpm([{ path: tagPath, mtime: now }], id);
			assert.strictEqual(direct["c3.5son"]?.sessionTpm, 3000, "precondition: the tag holds both turns for this session");
			const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
			tokenBudgetExtension({
				on: (event: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => { handlers[event] = fn; },
				registerFlag: () => {}, registerCommand: () => {}, getFlag: () => undefined,
			} as never);
			let widget: string[] = [];
			await handlers.turn_start({}, {
				ui: { setWidget: (_k: string, lines?: string[]) => { if (lines) widget = lines; }, setStatus: () => {}, notify: () => {} },
				sessionManager: { getSessionId: () => id, buildSessionContext: () => ({ model: { modelId: "claude-sonnet-4-6" } }) },
			});
			const session = widget.map(l => l.replace(/\x1b\[[0-9;]*m/g, "")).find(l => l.includes("(Session)"));
			assert.ok(session?.includes("(Session): 3K ses"), `two turns of 1,000 input + 500 cache read in the last minute: ${session}`);
		} finally {
			restore();
			for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
		}
	});
});

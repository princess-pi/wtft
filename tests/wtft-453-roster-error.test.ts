/**
 * Roster errors: docs/spec-442-daemon-roster.md § 2e, V8.
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { activeTagFiles, rosterDir } from "../extensions/lib/daemon-roster.ts";
import { useProcessTable } from "../extensions/lib/holder.ts";
import { fakeProcessTable, type FakeProcessTable } from "./lib/fake-process-table.ts";
import { trackSandbox } from "./lib/sandbox.ts";
import { skip } from "./lib/skips.ts";
import { tagForCli } from "./lib/cli-harness.ts";
import { piHeader, piTurn } from "./lib/golden-corpus.ts";

let tmp = "";
let saved: string | undefined;
let restore: () => void = () => {};
let table: FakeProcessTable;

beforeEach(() => {
	tmp = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-453-")));
	saved = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = path.join(tmp, "state");
	table = fakeProcessTable();
	restore = useProcessTable(table);
});

afterEach(() => {
	try { fs.chmodSync(rosterDir(), 0o700); } catch { /* not created */ }
	try { fs.chmodSync(path.join(tmp, "locked"), 0o700); } catch { /* not created */ }
	restore();
	if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
});

function tag(name: string): string {
	const file = path.join(tmp, "tags", name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "{}\n");
	return file;
}

function writeRoster(pid: number, text: string): string {
	fs.mkdirSync(rosterDir(), { recursive: true });
	const file = path.join(rosterDir(), `${pid}.json`);
	fs.writeFileSync(file, text);
	return file;
}

describe("roster errors", () => {
	it("a missing roster directory is no daemons, not an error", () => {
		assert.ok(!fs.existsSync(rosterDir()), "precondition: no roster directory");
		assert.deepStrictEqual(activeTagFiles(Date.now()), { files: [], errors: [] });
	});

	it("a roster directory that cannot be listed is an error naming the path and the code", () => {
		fs.mkdirSync(rosterDir(), { recursive: true });
		fs.chmodSync(rosterDir(), 0o000);
		let listable = true;
		try { fs.readdirSync(rosterDir()); } catch { listable = false; }
		if (listable) { skip("this process can list a mode-000 directory (root), so the failure cannot be staged"); return; }
		const { files, errors } = activeTagFiles(Date.now());
		assert.deepStrictEqual(files, []);
		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0].includes(rosterDir()) && errors[0].includes("EACCES"), `names the directory and the code: ${errors[0]}`);
	});

	it("a daemon's unreadable roster is an error, and every other daemon's spend still counts and stale rosters are still pruned", () => {
		table.daemon(4_530_001, ["--session", "/a.jsonl"]);
		table.daemon(4_530_002, ["--session", "/b.jsonl"]);
		const bad = writeRoster(4_530_001, JSON.stringify({ v: 2, pid: 4_530_001, tags: [] }));
		const live = tag("b.jsonl");
		writeRoster(4_530_002, JSON.stringify({ v: 1, pid: 4_530_002, tags: [live] }));
		const stale = writeRoster(4_530_003, JSON.stringify({ v: 1, pid: 4_530_003, tags: [] }));
		const { files, errors } = activeTagFiles(Date.now());
		assert.deepStrictEqual(files.map(f => f.path), [live], "the readable daemon's tag still counts");
		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0].includes(bad) && errors[0].includes("4530001") && errors[0].includes("not a v1 roster"), `names the file, the pid and why: ${errors[0]}`);
		assert.ok(fs.existsSync(bad), "a live daemon's roster is never deleted");
		assert.ok(!fs.existsSync(stale), "a stopped daemon's roster is still pruned");
	});

	it("an unverified pid's unreadable roster raises no error", () => {
		table.add(4_530_004, ["node", "/x/bin/wtft-daemon.mjs"]);
		table.hide(4_530_004);
		writeRoster(4_530_004, "{");
		assert.deepStrictEqual(activeTagFiles(Date.now()).errors, []);
	});

	it("a stopped daemon's unreadable roster is pruned without an error", () => {
		const file = writeRoster(4_530_005, "not json");
		assert.deepStrictEqual(activeTagFiles(Date.now()), { files: [], errors: [] });
		assert.ok(!fs.existsSync(file));
	});

	it("a daemon's tag that cannot be read is an error", () => {
		const unreadable = tag("u.jsonl");
		fs.chmodSync(unreadable, 0o000);
		let readable = true;
		try { fs.readFileSync(unreadable); } catch { readable = false; }
		if (readable) { skip("this process can read a mode-000 file (root), so the failure cannot be staged"); return; }
		table.daemon(4_530_008, ["--session", "/u.jsonl"]);
		writeRoster(4_530_008, JSON.stringify({ v: 1, pid: 4_530_008, tags: [unreadable] }));
		const { errors } = activeTagFiles(Date.now());
		assert.strictEqual(errors.length, 1, JSON.stringify(errors));
		assert.ok(errors[0].includes(unreadable) && errors[0].includes("EACCES"), `names the tag and the code: ${errors[0]}`);
		const old = (Date.now() - 600_000) / 1000;
		fs.utimesSync(unreadable, old, old);
		assert.deepStrictEqual(activeTagFiles(Date.now()).errors, [], "a quiet tag that could not count anyway raises none");
	});

	it("a daemon's tag that cannot be stat'd is an error; a vanished one is not", () => {
		const locked = path.join(tmp, "locked");
		fs.mkdirSync(locked);
		const hidden = path.join(locked, "h.jsonl");
		fs.writeFileSync(hidden, "{}\n");
		fs.chmodSync(locked, 0o000);
		let statable = true;
		try { fs.statSync(hidden); } catch { statable = false; }
		if (statable) { skip("this process can stat inside a mode-000 directory (root), so the failure cannot be staged"); return; }
		table.daemon(4_530_006, ["--session", "/h.jsonl"]);
		writeRoster(4_530_006, JSON.stringify({ v: 1, pid: 4_530_006, tags: [hidden, path.join(tmp, "gone.jsonl")] }));
		const { errors } = activeTagFiles(Date.now());
		assert.strictEqual(errors.length, 1, JSON.stringify(errors));
		assert.ok(errors[0].includes(hidden) && errors[0].includes("EACCES") && errors[0].includes("4530006"), `names the tag, the code and the pid: ${errors[0]}`);
	});

	it("Token Budget shows the error in its widget and footer and on a provider request, beside the spend it read", async () => {
		const savedConfig = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
		fs.mkdirSync(path.join(tmp, "config", "wtft"), { recursive: true });
		fs.writeFileSync(path.join(tmp, "config", "wtft", "token-budget.json"), JSON.stringify({ widget: true, footer: true }));
		try {
			table.daemon(4_530_007, ["--session", "/s.jsonl"]);
			const file = writeRoster(4_530_007, "{");
			const id = "01aa0000-0000-4000-8000-000000000453";
			const sessionFile = path.join(tmp, "elsewhere", `2026-10-07T00-00-00-000Z_${id}.jsonl`);
			fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
			const now = Date.now();
			fs.writeFileSync(sessionFile, piHeader(id, now - 50_000, tmp) + piTurn("t1", now - 40_000, 10) + piTurn("t2", now - 20_000, 10));
			const tagPath = tagForCli(sessionFile).tagPath;
			table.daemon(4_530_009, ["--session", sessionFile]);
			writeRoster(4_530_009, JSON.stringify({ v: 1, pid: 4_530_009, tags: [tagPath] }));
			const { default: tokenBudgetExtension } = await import("../extensions/token-budget.ts");
			const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
			tokenBudgetExtension({
				on: (event: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => { handlers[event] = fn; },
				registerFlag: () => {}, registerCommand: () => {}, getFlag: () => undefined,
			} as never);
			let widget: string[] = [];
			let footer = "";
			const notices: [string, string][] = [];
			const ctx = {
				ui: {
					setWidget: (_k: string, lines?: string[]) => { if (lines) widget = lines; },
					setStatus: (_k: string, text?: string) => { footer = text ?? ""; },
					notify: (m: string, kind: string) => { notices.push([m, kind]); },
				},
				sessionManager: { getSessionId: () => id, buildSessionContext: () => ({ model: { modelId: "claude-sonnet-4-6" } }) },
			};
			await handlers.turn_start({}, ctx);
			const plain = widget.map(l => l.replace(/\x1b\[[0-9;]*m/g, ""));
			assert.ok(plain.some(l => l.includes(file)), `the widget names the roster file: ${plain.join(" / ")}`);
			assert.ok(plain.some(l => l.includes("(Session): 3K ses")), `the readable daemon's spend still shows: ${plain.join(" / ")}`);
			assert.ok(footer.includes("roster"), `the footer marks it: ${footer}`);
			await handlers.before_provider_request({}, ctx);
			assert.ok(notices.some(([m, kind]) => kind === "error" && m.includes(file)), `a provider request raises an error notice: ${JSON.stringify(notices)}`);
		} finally {
			if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedConfig;
		}
	});
});

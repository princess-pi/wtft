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
import { fakeProcessTable } from "./lib/fake-process-table.ts";
import { trackSandbox } from "./lib/sandbox.ts";
import { skip } from "./lib/skips.ts";

let tmp = "";
let saved: string | undefined;
let restore: () => void = () => {};

beforeEach(() => {
	tmp = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-453-")));
	saved = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = path.join(tmp, "state");
});

afterEach(() => {
	try { fs.chmodSync(rosterDir(), 0o700); } catch { /* not created */ }
	restore();
	restore = () => {};
	if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
});

function unlistable(): boolean {
	fs.mkdirSync(rosterDir(), { recursive: true });
	fs.chmodSync(rosterDir(), 0o000);
	try { fs.readdirSync(rosterDir()); return false; } catch { return true; }
}

describe("roster errors", () => {
	it("a missing roster directory is no daemons, not an error", () => {
		assert.ok(!fs.existsSync(rosterDir()), "precondition: no roster directory");
		assert.deepStrictEqual(activeTagFiles(Date.now()), []);
	});

	it("a roster directory that cannot be listed is an error naming the path and the code", () => {
		if (!unlistable()) { skip("this process can list a mode-000 directory (root), so the failure cannot be staged"); return; }
		assert.throws(() => activeTagFiles(Date.now()), (err: Error) => {
			assert.ok(err.message.includes(rosterDir()), `names the directory: ${err.message}`);
			assert.ok(err.message.includes("EACCES"), `names the code: ${err.message}`);
			return true;
		});
	});

	it("a live daemon's roster that cannot be read is an error naming the file, the pid and why", () => {
		const table = fakeProcessTable();
		restore = useProcessTable(table);
		table.daemon(4_530_001, ["--session", "/s.jsonl"]);
		fs.mkdirSync(rosterDir(), { recursive: true });
		const file = path.join(rosterDir(), "4530001.json");
		fs.writeFileSync(file, JSON.stringify({ v: 2, pid: 4_530_001, tags: [] }));
		assert.throws(() => activeTagFiles(Date.now()), (err: Error) => {
			assert.ok(err.message.includes(file), `names the file: ${err.message}`);
			assert.ok(err.message.includes("4530001"), `names the pid: ${err.message}`);
			assert.ok(/not a v1 roster/.test(err.message), `says why: ${err.message}`);
			return true;
		});
		assert.ok(fs.existsSync(file), "a live daemon's roster is never deleted");
	});

	it("a stopped daemon's unreadable roster is pruned without an error", () => {
		const table = fakeProcessTable();
		restore = useProcessTable(table);
		fs.mkdirSync(rosterDir(), { recursive: true });
		const file = path.join(rosterDir(), "4530002.json");
		fs.writeFileSync(file, "not json");
		assert.deepStrictEqual(activeTagFiles(Date.now()), []);
		assert.ok(!fs.existsSync(file));
	});

	it("Token Budget shows the error in its widget and on a provider request", async () => {
		const saved2 = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
		process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
		const table = fakeProcessTable();
		restore = useProcessTable(table);
		try {
			table.daemon(4_530_003, ["--session", "/s.jsonl"]);
			fs.mkdirSync(rosterDir(), { recursive: true });
			const file = path.join(rosterDir(), "4530003.json");
			fs.writeFileSync(file, "{");
			const { default: tokenBudgetExtension } = await import("../extensions/token-budget.ts");
			const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
			tokenBudgetExtension({
				on: (event: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => { handlers[event] = fn; },
				registerFlag: () => {}, registerCommand: () => {}, getFlag: () => undefined,
			} as never);
			let widget: string[] = [];
			const notices: [string, string][] = [];
			const ctx = {
				ui: { setWidget: (_k: string, lines?: string[]) => { if (lines) widget = lines; }, setStatus: () => {}, notify: (m: string, kind: string) => { notices.push([m, kind]); } },
				sessionManager: { getSessionId: () => "s", buildSessionContext: () => ({ model: { modelId: "claude-sonnet-4-6" } }) },
			};
			await handlers.turn_start({}, ctx);
			assert.ok(widget.some(l => l.includes("daemon roster") && l.includes(file)), `the widget names the roster file: ${widget.join(" / ")}`);
			await handlers.before_provider_request({}, ctx);
			assert.ok(notices.some(([m, kind]) => kind === "error" && m.includes(file)), `a provider request raises an error notice: ${JSON.stringify(notices)}`);
		} finally {
			if (saved2.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved2.XDG_CONFIG_HOME;
		}
	});
});

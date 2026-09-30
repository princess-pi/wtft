/**
 * The chart pages run the production chart. docs/spec-386-chart-artifacts.md.
 */

import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { committedSourcesHash, RENDERER_BUNDLE, rendererSourcesHash } from "../build-artifacts.ts";
import { parseWtftCliArgs } from "../extensions/lib/wtft-cli-shared.ts";
import { buildWtftLines } from "../extensions/lib/wtft-renderer.ts";
import { ansiToHtml, stripAnsi } from "../artifacts/renderer/ansi.ts";
import { FAIR_DEFAULTS, renderFair, type FairState } from "../artifacts/renderer/fair.ts";
import { fairBooth } from "../artifacts/renderer/fair-session.ts";
import { wtftSession } from "../artifacts/renderer/fake-session.ts";
import { PRESETS, SPEC_PIN } from "../artifacts/renderer/presets.ts";
import { renderReport } from "../artifacts/renderer/report.ts";

const NOW = Date.UTC(2026, 8, 26, 15, 30);
const MODEL = "claude-sonnet-5-5";
const art = (file: string) => new URL(`../artifacts/${file}`, import.meta.url);
const read = (file: string) => fs.readFileSync(art(file), "utf8");

/** `buildWtftLines` called the way the CLI report arm calls it, with the terminal and the clock pinned. */
function direct(columns: number, args: Parameters<typeof buildWtftLines>[2], pad = 1) {
	const stdout = process.stdout as { columns?: number };
	const realColumns = stdout.columns;
	const realNow = Date.now;
	stdout.columns = columns;
	Date.now = () => NOW;
	try {
		const width = Math.min(columns - 2 * pad, 1023);
		return buildWtftLines(wtftSession(MODEL), { interval: "1h", limit: 100, width, mode: "cumulative", timezone: undefined }, { width, ...args });
	} finally {
		Date.now = realNow;
		stdout.columns = realColumns;
	}
}

describe("renderReport copies the CLI report arm's option-to-chart step", () => {
	it("prints the session path, then the chart lines buildWtftLines returns for the parsed flags", () => {
		const env = { columns: 100, sessionFile: "/tmp/sessions/abcd1234.jsonl", interactions: wtftSession(MODEL), now: NOW };
		const report = renderReport(["-c", "-i", "1h", "-l", "17", "--tz", "UTC"], env);
		const expected = direct(100, {
			interval: "1h", limit: 17, padRowsTo: 17, mode: "cumulative", timezone: "UTC", disabledEmoji: false,
			sessionNameSuffix: "abcd1234.jsonl", unit: "cost", showCostColumns: true, showTokenColumns: true,
		});
		assert.ok(expected);
		assert.equal(report.lines[0], " \x1b[90m/tmp/sessions/abcd1234.jsonl\x1b[0m");
		assert.deepEqual(report.lines.slice(1), expected.map((line) => ` ${line}`));
		assert.ok(report.lines.length > 5);
	});

	it("reads every chart flag and the terminal width", () => {
		const env = (columns: number) => ({ columns, sessionFile: "/x/a.jsonl", interactions: wtftSession(MODEL), now: NOW });
		const plain = (argv: string[], columns = 160) => renderReport(argv, env(columns)).lines.map(stripAnsi).join("\n");
		const rows = (argv: string[]) => plain(argv).split("\n").filter((line) => /^ \d\d:00 /.test(line)).join("\n");
		assert.match(rows(["-c", "--tokens", "--tz", "UTC"]), /▃/);
		assert.doesNotMatch(rows(["-b", "--tokens", "--tz", "UTC"]), /▃/);
		assert.match(plain(["-i", "5t", "-l", "40", "--tz", "UTC"]), /\b10t\b/);
		assert.match(plain(["--no-emoji"]), /\[\$\] WTF Tokens\?/);
		assert.doesNotMatch(rows(["--no-cost"]), /\$\d/);
		assert.match(rows(["--no-cost"]), / tok/);
		assert.doesNotMatch(rows(["--no-tokens"]), / tok/);
		assert.match(rows(["--no-tokens"]), /\$\d/);
		assert.ok(renderReport(["--pad", "5", "--tz", "UTC"], env(160)).lines.every((l) => l.startsWith("     ")));
		assert.notEqual(plain(["--tz", "UTC"]), plain(["--tz", "Asia/Tokyo"]));
		assert.equal(renderReport(["-l", "3", "--tz", "UTC"], env(160)).lines.filter((l) => /^ \d\d:00 /.test(stripAnsi(l))).length, 3);
		const narrow = renderReport(["--tz", "UTC"], env(100)).lines;
		const wide = renderReport(["--tz", "UTC"], env(200)).lines;
		assert.ok(Math.max(...narrow.map((l) => stripAnsi(l).length)) < Math.max(...wide.map((l) => stripAnsi(l).length)));
	});

	it("leaves the process's terminal width and clock as it found them", () => {
		const stdout = process.stdout as { columns?: number };
		const before = { columns: stdout.columns, now: Date.now };
		renderReport(["-c"], { columns: 77, sessionFile: "/x/a.jsonl", interactions: wtftSession(MODEL), now: NOW });
		assert.equal(stdout.columns, before.columns);
		assert.equal(Date.now, before.now);
	});
});

describe("the committed bundle is the browser build", () => {
	it("was built from the sources as they stand", async () => {
		assert.equal(committedSourcesHash(), await rendererSourcesHash(), "run: bun run artifacts");
	});

	it("draws the same lines as the source, and parses flags as the source does", async () => {
		const bundle = await import(pathToFileURL(RENDERER_BUNDLE).href);
		const argv = ["-b", "--tokens", "-i", "2h", "-l", "8", "--tz", "Asia/Tokyo", "--no-cost"];
		const env = { columns: 140, sessionFile: "/x/a.jsonl", interactions: wtftSession(MODEL), now: NOW };
		assert.deepEqual(bundle.renderReport(argv, env).lines, renderReport(argv, env).lines);
		assert.deepEqual(bundle.parseWtftCliArgs(argv), parseWtftCliArgs(argv));
		assert.deepEqual(bundle.wtftSession(MODEL), wtftSession(MODEL));
	});

	it("draws in a page with no process at every width, and leaves no process behind", () => {
		const script = `
			const { renderReport, wtftSession } = await import(${JSON.stringify(pathToFileURL(RENDERER_BUNDLE).href)});
			const interactions = wtftSession("${MODEL}");
			delete globalThis.process;
			const counts = [79, 80, 81].map((columns) => renderReport(["-c"], { columns, sessionFile: "/x/a.jsonl", interactions }).lines.length);
			console.log(JSON.stringify({ counts, left: "process" in globalThis }));
		`;
		const out = JSON.parse(execFileSync("node", ["--input-type=module", "-e", script], { encoding: "utf8", env: process.env }));
		assert.ok(out.counts.every((count: number) => count > 5), JSON.stringify(out.counts));
		assert.equal(out.left, false);
	});
});

describe("the wtft pages", () => {
	it("spec.mdx prints each preset as the chart draws it under the pinned clock", () => {
		const spec = read("chart-spec/spec.mdx");
		for (const preset of Object.values(PRESETS)) {
			const report = renderReport(preset.argv, { columns: SPEC_PIN.columns, sessionFile: SPEC_PIN.sessionFile, interactions: wtftSession(SPEC_PIN.model), now: SPEC_PIN.now });
			const block = ["$ wtft " + preset.argv.join(" "), ...report.lines.slice(1).map((line) => stripAnsi(line).trimEnd())].join("\n");
			assert.ok(spec.includes("```\n" + block + "\n```"), preset.label);
		}
	});

	it("the picker imports the bundle, and no second painter is left", () => {
		const page = read("chart-spec/picker.html");
		assert.match(page, /from "\.\.\/renderer\/wtft-chart\.mjs"/);
		assert.match(page, /import \{[^}]*\bparseWtftCliArgs\b[^}]*\} from "\.\.\/renderer\/wtft-chart\.mjs"/);
		assert.match(page, /parseWtftCliArgs\(words\(\)\)/);
		assert.equal(fs.existsSync(art("chart-spec/paint.mjs")), false);
		for (const text of [page, read("chart-spec/spec.mdx")]) assert.doesNotMatch(text, /paint\.mjs/);
	});

	it("the fake session is tag-file shaped and spans a date, a cache miss and a hundred turns", () => {
		const session = wtftSession(MODEL);
		assert.ok(session.length > 100);
		assert.ok(session.every((turn) => turn._cat));
		assert.ok(session.some((turn) => turn.cacheMiss));
		assert.ok(new Set(session.map((turn) => new Date(turn.timestamp).toISOString().slice(0, 10))).size >= 3);
		assert.ok(session.some((turn) => turn.serverToolCost > 0 && turn._cat !== "web"));
		assert.ok(wtftSession("deepseek-v4-pro").some((turn) => turn.surgePriced));
	});
});

describe("the library page", () => {
	const at = (state: Partial<FairState> = {}) => renderFair({ ...FAIR_DEFAULTS, ...state, now: Date.UTC(2026, 8, 13, 20, 30) });

	it("draws the booth through buildWtftLines, unchanged in the first view", () => {
		const picture = at();
		const stdout = process.stdout as { columns?: number };
		const realColumns = stdout.columns;
		const realNow = Date.now;
		stdout.columns = FAIR_DEFAULTS.columns;
		Date.now = () => Date.UTC(2026, 8, 13, 20, 30);
		try {
			const width = FAIR_DEFAULTS.columns - 2;
			const expected = buildWtftLines(fairBooth({ souvenirs: false }), { interval: "1h", limit: 100, width, mode: "cumulative", timezone: undefined }, {
				interval: "1h", limit: 24, padRowsTo: 24, width, mode: "cumulative", unit: "cost", timezone: FAIR_DEFAULTS.timezone,
				sessionNameSuffix: "booth-0042.jsonl", showCostColumns: true, showTokenColumns: true,
			});
			assert.deepEqual(picture.today, expected);
		} finally {
			Date.now = realNow;
			stdout.columns = realColumns;
		}
	});

	it("feeds the chart interactions carrying only a cost and whole units sold as inputTokens", () => {
		const sales = fairBooth({ souvenirs: false });
		assert.ok(sales.length > 1000);
		assert.ok(sales.every((sale) => sale.cost > 0 && Number.isInteger(sale.inputTokens) && sale.inputTokens >= 1 && sale.inputTokens <= 3
			&& sale.outputTokens === 0 && sale.cacheReadTokens === 0 && sale.cacheWriteTokens === 0 && sale.reasoningTokens === 0));
		assert.ok(sales.every((sale, i) => i === 0 || sales[i - 1].timestamp <= sale.timestamp));
		assert.equal(sales.filter((sale) => sale.cacheMiss).length, 1);
	});

	it("every substitution fires somewhere, and each one is a finding row on the spec page", () => {
		const fired = new Set<string>();
		for (const state of [{}, { unit: "tokens" as const }, { souvenirs: true }]) {
			for (const sub of at(state).substitutions) if (sub.count > 0) fired.add(sub.id);
		}
		const ids = at().substitutions.map((sub) => sub.id);
		assert.deepEqual([...fired].sort(), [...ids].sort());
		const spec = read("chart-lib/spec.mdx");
		const findings = spec.slice(spec.indexOf("## Findings"), spec.indexOf("\n## ", spec.indexOf("## Findings") + 1));
		for (const id of ids) assert.match(findings, new RegExp(`^\\| F\\d+ \\|.*\\| ${id} \\|$`, "m"), id);
	});

	it("the second view drops every wtft word the first view carries", () => {
		const picture = at({ unit: "tokens", souvenirs: true });
		assert.notDeepEqual(picture.generic, picture.today);
		const words = /WTF Tokens|Ovrhd|cached\/carryover|CH: |Cache Miss|Other" category| tok\b/;
		assert.ok(picture.today.some((line) => words.test(stripAnsi(line))));
		assert.ok(!picture.generic.some((line) => words.test(stripAnsi(line))));
	});

	it("the pages are listed and import the bundle", () => {
		const index = JSON.parse(read("docs.json"));
		const paths = index.docs.map((doc: { path: string }) => doc.path);
		for (const file of ["chart-lib/spec.mdx", "chart-lib/fair.html"]) {
			assert.ok(paths.includes(file), file);
			assert.ok(fs.existsSync(art(file)), file);
		}
		assert.match(read("chart-lib/fair.html"), /from "\.\.\/renderer\/wtft-chart\.mjs"/);
		assert.match(read("chart-lib/spec.mdx"), /src="fair\.html"/);
	});
});

describe("ansiToHtml", () => {
	it("colours a 256-colour cell, keeps bold, escapes text and drops what it does not know", () => {
		assert.equal(ansiToHtml("\x1b[38;5;196m█\x1b[0m<b>"), '<span style="color:rgb(255,0,0)">█</span>&lt;b&gt;');
		assert.equal(ansiToHtml("\x1b[1;37mA\x1b[0m"), '<span style="font-weight:700;color:rgb(229,229,229)">A</span>');
		assert.equal(ansiToHtml("\x1b[5;90mA\x1b[0mB"), '<span style="color:rgb(136,136,136)">A</span>B');
		assert.equal(stripAnsi("\x1b[1;38;5;208mx\x1b[0m"), "x");
		assert.equal(ansiToHtml("\x1b[7mA\x1b[27mB"), '<span style="color:#0e0e0e;background:rgb(229,229,229)">A</span>B');
		assert.equal(ansiToHtml("\x1b[38;2;1;31;7mA"), "A");
		assert.equal(ansiToHtml("\x1b[38;5;196;7mA"), '<span style="color:#0e0e0e;background:rgb(255,0,0)">A</span>');
	});
});

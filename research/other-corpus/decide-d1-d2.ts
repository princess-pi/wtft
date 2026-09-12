/**
 * @package wtft
 * @module research/other-corpus/decide-d1-d2
 * @description Size the two open design questions on #106 so they can be
 *   decided against numbers instead of taste.
 *
 * D1 — `gh` routes wholly to `git` today. `gh pr`/`repo`/`release` are
 *      unambiguously version control; `gh issue`/`gh api` are arguably
 *      "talking about the work". How much money is actually on that line?
 *
 * D2 — MCP tools arrive as `mcp__<server>__<tool>` and are categorised by a
 *      suffix heuristic (search/fetch/browse/crawl → web). What is actually
 *      installed, what does the heuristic catch, and what does it miss?
 *
 * Usage: bun research/other-corpus/decide-d1-d2.ts [--sessions N]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSessionFile, deduplicateInteractions, classifyInteraction } from "../../extensions/lib/wtft-parser.ts";
import { extractRealCommands } from "../../extensions/lib/wtft-command-shapes.ts";

const argv = process.argv.slice(2);
const N = Number(argv[argv.indexOf("--sessions") + 1]) || 250;

const files = execSync(`find ${process.env.HOME}/.claude/projects -name '*.jsonl' -size +40k -newermt '-60 days'`,
	{ encoding: "utf8", maxBuffer: 1e9 }).trim().split("\n").filter(Boolean).sort().slice(0, N);

// --- D1 -------------------------------------------------------------------
const ghSub = new Map<string, { cost: number; n: number }>();
let ghTotal = 0, gitTotal = 0, corpus = 0;

// --- D2 -------------------------------------------------------------------
const mcpTools = new Map<string, { cost: number; n: number }>();

const WEBBY = /(?:^|_)(?:web_)?(?:search|fetch|browse|crawl)(?:_|$)/;

for (const f of files) {
	let ints;
	try { ints = deduplicateInteractions(parseSessionFile(f)); } catch { continue; }
	for (const i of ints) {
		corpus += i.cost;
		if (classifyInteraction(i) === "git") gitTotal += i.cost;

		// D1: the gh subcommand this turn actually ran.
		const subs = new Set<string>();
		for (const raw of i.commands) {
			for (const real of extractRealCommands(raw)) {
				const m = /^gh\s+([a-z-]+)/.exec(real.split("\n", 1)[0]!.toLowerCase());
				if (m) subs.add(m[1]!);
			}
		}
		if (subs.size > 0) {
			ghTotal += i.cost;
			// Attribute the whole turn to each subcommand it used; turns using
			// several are counted in each, so these columns overlap by design.
			for (const s of subs) {
				const e = ghSub.get(s) || { cost: 0, n: 0 };
				e.cost += i.cost; e.n++; ghSub.set(s, e);
			}
		}
	}

	// D2: raw tool names, read straight from the transcript — a tool the parser
	// does not model leaves no trace on the Interaction.
	let txt; try { txt = fs.readFileSync(f, "utf8"); } catch { continue; }
	for (const line of txt.split("\n")) {
		if (!line.includes("mcp__")) continue;
		let e; try { e = JSON.parse(line); } catch { continue; }
		for (const b of e?.message?.content ?? []) {
			if (b?.type !== "tool_use") continue;
			const name = String(b.name || "").toLowerCase();
			if (!name.startsWith("mcp__")) continue;
			const rec = mcpTools.get(name) || { cost: 0, n: 0 };
			rec.n++; mcpTools.set(name, rec);
		}
	}
}

console.log(`corpus $${corpus.toFixed(2)} over ${files.length} sessions\n`);

console.log("=== D1 — where `gh` spend actually sits ===");
console.log(`all turns running gh: $${ghTotal.toFixed(2)}  (${(ghTotal / corpus * 100).toFixed(1)}% of corpus)`);
console.log(`current 'git' category total: $${gitTotal.toFixed(2)}\n`);
const REPO_SIDE = new Set(["pr", "repo", "release", "browse", "clone", "fork", "run", "workflow", "cache"]);
const TALK_SIDE = new Set(["issue", "api", "search", "label", "project", "gist", "comment"]);
let repoCost = 0, talkCost = 0;
for (const [sub, v] of [...ghSub.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
	const side = REPO_SIDE.has(sub) ? "repo-side" : TALK_SIDE.has(sub) ? "TALK-side" : "unclassified";
	console.log(`  gh ${sub.padEnd(12)} $${v.cost.toFixed(2).padStart(9)}  ${String(v.n).padStart(4)} turns  ${side}`);
	if (REPO_SIDE.has(sub)) repoCost += v.cost;
	if (TALK_SIDE.has(sub)) talkCost += v.cost;
}
console.log(`\n  repo-side subtotal : $${repoCost.toFixed(2)}`);
console.log(`  TALK-side subtotal : $${talkCost.toFixed(2)}   <-- this is what D1 would move out of 'git'`);
console.log(`  (turns using both are counted in each, so these overlap)`);

console.log("\n=== D2 — MCP tools actually present ===");
if (mcpTools.size === 0) console.log("  none in this corpus");
for (const [name, v] of [...mcpTools.entries()].sort((a, b) => b[1].n - a[1].n)) {
	const tool = name.slice(name.indexOf("__", 5) + 2);
	console.log(`  ${String(v.n).padStart(4)} calls  ${WEBBY.test(tool) ? "-> web   " : "unmapped "} ${name}`);
}

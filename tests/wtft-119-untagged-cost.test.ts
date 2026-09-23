#!/usr/bin/env -S bun
/**
 * total.untaggedCostUsd (#119, U1–U4).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("119-untagged-cost");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_BIN = path.join(REPO_ROOT, "bin", "wtft.mjs");
const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-119-")));

function usageLine(opts: { id: string; ts: string; model?: string; web?: number }): string {
	const usage: Record<string, unknown> = {
		input_tokens: 100, output_tokens: 300,
		cache_read_input_tokens: 0, cache_creation_input_tokens: 10000,
	};
	if (opts.web) usage.server_tool_use = { web_search_requests: opts.web };
	return JSON.stringify({
		type: "assistant", timestamp: opts.ts, cwd: "/tmp",
		message: { role: "assistant", id: opts.id, model: opts.model ?? "claude-opus-5", content: [{ type: "text", text: "x" }], usage },
	});
}

let runSeq = 0;
function cli(source: string, args: string[]): string {
	const copy = path.join(dir, `run-${runSeq++}-${path.basename(source)}`);
	fs.copyFileSync(source, copy);
	const r = spawnSync("node", [CLI_BIN, "-s", copy, ...args], { encoding: "utf8", env: { ...process.env } });
	if (r.status !== 0 && r.status !== 9) throw new Error(`wtft -s <copy> ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
	return (r.stdout || "").replace(/\x1b\[[0-9;]*m/g, "");
}

/** Same helper shape as tests/wtft-90…: the chart's newest cumulative running total. */
function chartTotal(session: string): number {
	const out = cli(session, ["--interval", "1h", "--cumulative"]);
	const row = out.split("\n").find(l => /^\s*\d\d:\d\d\s+\+\$/.test(l));
	if (!row) throw new Error(`no cumulative bin row in:\n${out}`);
	const figures = [...row.matchAll(/\$([0-9.]+)/g)].map(m => Number(m[1]));
	if (figures.length < 2) throw new Error(`no running total in row: ${row}`);
	return figures[1];
}

function json(session: string): any {
	return JSON.parse(cli(session, ["--json"]));
}

// ---
// U1/U4 — schema and field shape.
// ---
console.log("\n=== U1/U4: schema bump, field shape ===\n");
{
	const allTagged = path.join(dir, "all-tagged.jsonl");
	fs.writeFileSync(allTagged, [usageLine({ id: "a", ts: "2026-07-01T12:00:00Z" })].join("\n") + "\n");
	const doc = json(allTagged);
	check(doc.schema === "wtft/session@7", `U4: schema is wtft/session@7 (${doc.schema})`);
	check(typeof doc.total.untaggedCostUsd === "number", "U1: total.untaggedCostUsd is a number");
	check(doc.total.untaggedCostUsd === 0, "U1: an all-tagged session has zero untagged cost");
	check(!doc.notices.some((n: any) => n.code === "auto-selected-session"),
		"U4: the retired auto-selected-session notice code never appears");

	// U1 — the field belongs to `total` alone, never to a models[]/categories[]
	// row, which have no untagged population to speak of.
	check(doc.models.every((m: any) => !("untaggedCostUsd" in m)), "U1: no models[] row carries untaggedCostUsd");
	check(doc.categories.every((c: any) => !("untaggedCostUsd" in c)), "U1: no categories[] row carries untaggedCostUsd");
	check(!("untaggedCostUsd" in doc.tree), "U1: tree does not carry untaggedCostUsd either");
}

// ---
// U2/U3 — the closer: chart total === total.costUsd + total.untaggedCostUsd.
// ---
console.log("\n=== U2/U3: chart total === total.costUsd + total.untaggedCostUsd ===\n");
{
	const withUntagged = path.join(dir, "with-untagged.jsonl");
	fs.writeFileSync(withUntagged, [
		usageLine({ id: "a", ts: "2026-07-01T12:00:00Z" }),
		usageLine({ id: "b", ts: "2026-07-01T13:00:00Z", web: 5 }),
		// No model id at all — untagged. This one carries no server_tool_use:
		// calculateServerToolCost only bills a model id containing "claude" or
		// "anthropic" (extensions/lib/wtft-cost.ts), and untagged is by
		// definition "(unknown)" or "<synthetic>" — neither ever matches, so a
		// real untagged interaction's serverToolCost is structurally always 0.
		// U2's "plus serverToolCost when present" is a robustness addition for
		// exactly that reason (the field must not silently drift if that ever
		// changes), not a behaviour this fixture can exercise as non-zero.
		JSON.stringify({
			type: "assistant", timestamp: "2026-07-01T14:00:00Z", cwd: "/tmp",
			message: {
				role: "assistant", id: "u_untagged", model: "<synthetic>",
				content: [{ type: "text", text: "x" }],
				usage: { input_tokens: 100, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000 },
			},
		}),
	].join("\n") + "\n");

	const doc = json(withUntagged);
	check(doc.untaggedInteractions >= 1, `U3 setup: the untagged turn is counted (${doc.untaggedInteractions})`);
	check(doc.total.untaggedCostUsd > 0, `U3: an untagged turn contributes a NON-ZERO untaggedCostUsd ($${doc.total.untaggedCostUsd})`);

	const chart = chartTotal(withUntagged);
	const sum = doc.total.costUsd + doc.total.untaggedCostUsd;
	// Half a cent, not 1e-9 — chartTotal() SCRAPES formatCost's two-decimal
	// display (same convention tests/wtft-90-…'s own chartTotal/tokensTotal
	// comparisons use), so the observable precision is bounded by that
	// rendering, not by the internal float arithmetic itself.
	check(
		Math.abs(chart - sum) < 0.005,
		`U3: chart total ($${chart.toFixed(6)}) === total.costUsd + total.untaggedCostUsd ($${sum.toFixed(6)}), to half a cent`
	);
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

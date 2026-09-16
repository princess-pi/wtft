#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/wtft-115-cache-miss-sidechain.test.ts — Cache Miss is parent-only (#115)
 *
 * A subagent starts with an empty context, so its first turn always reads 0 and
 * writes everything: the raw shape of a cache miss, with nothing lost. Flagging
 * it turns the divider — an actionable "your cached prefix was thrown away" —
 * into noise that grows with fan-out.
 *
 * So `cacheMiss` is decided at parse time against `isSidechain`, alongside the
 * same exclusion `splitOverheadCost` already applies to recache detection. The
 * renderer is untouched: it still just follows the flag.
 *
 * Run: node --experimental-strip-types tests/wtft-115-cache-miss-sidechain.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { trackSandbox } from "./lib/sandbox";

import { buildWtftLines, parseSessionFile } from "../bin/wtft.mjs";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const DEFAULTS = {
	interval: "1h", limit: 100, width: 80, showTicks: false,
	mode: "bucket" as const, timezone: undefined, disabledEmoji: false,
};

function usageLine(opts: {
	id: string; ts: string; cr: number; cw: number; isSidechain?: boolean;
}) {
	return JSON.stringify({
		type: "assistant",
		timestamp: opts.ts,
		isSidechain: opts.isSidechain || undefined,
		message: {
			role: "assistant", id: opts.id, model: "claude-opus-5",
			content: [{ type: "text", text: "x" }],
			usage: {
				input_tokens: 2, output_tokens: 300,
				cache_read_input_tokens: opts.cr,
				cache_creation_input_tokens: opts.cw,
				cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: opts.cw },
			},
		},
	});
}

function dividerCount(ix: any[]): number {
	const lines = buildWtftLines(ix, DEFAULTS, { interval: "1h", mode: "bucket", width: 80 });
	return (lines as string[]).filter((l: string) => l.includes("Cache Miss")).length;
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-115-")));

// The closer's fixture: a parent transcript with ONE genuine re-prime, and a
// subagent transcript whose first turn has the same raw shape by construction.
const parentPath = path.join(dir, "parent.jsonl");
fs.writeFileSync(parentPath, [
	usageLine({ id: "p_start", ts: "2026-07-01T12:00:00Z", cr: 0, cw: 48278 }),
	usageLine({ id: "p_hit", ts: "2026-07-01T12:10:00Z", cr: 50000, cw: 1200 }),
	// Genuine parent re-prime, two bins later: the one divider that must survive.
	usageLine({ id: "p_reprime", ts: "2026-07-01T14:00:00Z", cr: 0, cw: 91000 }),
].join("\n") + "\n");

// Same layout Claude Code writes: <session>/subagents/agent-*.jsonl, every turn
// carrying isSidechain (verified against a real transcript, 2026-09-15).
const subDir = path.join(dir, "parent", "subagents");
fs.mkdirSync(subDir, { recursive: true });
const subPath = path.join(subDir, "agent-abc123.jsonl");
fs.writeFileSync(subPath, [
	usageLine({ id: "s_start", ts: "2026-07-01T13:10:00Z", cr: 0, cw: 61000, isSidechain: true }),
	usageLine({ id: "s_hit", ts: "2026-07-01T13:15:00Z", cr: 61000, cw: 900, isSidechain: true }),
].join("\n") + "\n");

const parent = parseSessionFile(parentPath);
const sub = parseSessionFile(subPath);
const byId = new Map<string, any>([...parent, ...sub].map((i: any) => [i.messageId, i]));

console.log("--- TEST 1: the flag is parent-only ---");
check(byId.get("p_start")?.cacheMiss === true, "parent's first turn → still a miss");
check(byId.get("p_reprime")?.cacheMiss === true, "parent's re-prime → still a miss");
check(!byId.get("s_start")?.cacheMiss, "subagent's first turn → NOT a miss");
check(!byId.get("s_hit")?.cacheMiss, "subagent's cache hit → not a miss");

console.log("--- TEST 2: the closer — one divider, not two ---");
check(dividerCount([...parent, ...sub]) === 2, "parent start + re-prime → 2 dividers");
// The subagent sits in its OWN bin, between the two parent misses, so a leaked
// flag would show up as a third divider rather than hiding inside an existing one.
check(
	dividerCount(sub) === 0,
	"a subagent transcript alone → 0 dividers (was 1 before #115)"
);

console.log("--- TEST 3: cost is untouched ---");
// cacheMiss is a label on the interaction, never a term in the price. A fix that
// moved a cost would be a different bug wearing this one's clothes.
const parentCost = parent.reduce((s: number, i: any) => s + i.cost, 0);
const subCost = sub.reduce((s: number, i: any) => s + i.cost, 0);
check(parentCost > 0 && sub.length === 2, "both fixtures priced and parsed");
check(
	Math.abs(parentCost - parseSessionFile(parentPath).reduce((s: number, i: any) => s + i.cost, 0)) < 1e-12,
	"parent cost is stable across parses"
);
check(subCost > 0, "the subagent still reports its own cost — dropped flag, not dropped spend");

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

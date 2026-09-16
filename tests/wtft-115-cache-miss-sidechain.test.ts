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
 * same exclusion `splitOverheadCost` already applies to recache detection, and
 * again from PROVENANCE in `loadSubagentInteractions` for the harnesses that
 * mark a subagent by file rather than by entry. The renderer is untouched: it
 * still just follows the flag.
 *
 * ONE NUMBER DIFFERS FROM THE ISSUE, deliberately. #115 asks for "zero Cache
 * Miss dividers" from a session that spawns N subagents and never idles. It
 * renders ONE: the session's own first turn is a real cold start, and #152
 * decided that case stays flagged (see that spec, "Why removal, not
 * augmentation"). The rule #115 actually asks for is "no divider that a SUBAGENT
 * caused", which is what the fixture below pins — parent misses counted
 * exactly, subagent misses zero.
 *
 * Imports come from the BUILT bundle `bin/wtft.mjs`, as every suite here does.
 * That is only trustworthy because the build is a hard gate, not a habit: the
 * repo's CLAUDE.md forbids editing `bin/*.mjs` and requires `bun run build`
 * after any `.ts` edit, `package.json`'s `prepare` runs it, and CI builds before
 * testing. A stale bundle would let a reverted parse-time gate pass green, so
 * rebuild before trusting a green run from this file alone (PR review round 2).
 *
 * Run: node --experimental-strip-types tests/wtft-115-cache-miss-sidechain.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { trackSandbox } from "./lib/sandbox";

import {
	buildWtftLines,
	parseSessionFile,
	deduplicateInteractions,
	loadSubagentInteractions,
	clearSubagentCacheMiss,
	serializeClassified,
} from "../bin/wtft.mjs";

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

function writeFixture(at: string, lines: string[]): string {
	fs.writeFileSync(at, lines.join("\n") + "\n");
	return at;
}

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

console.log("--- TEST 2: no divider a SUBAGENT caused ---");
check(dividerCount([...parent, ...sub]) === 2, "parent start + re-prime → 2 dividers");
// The subagent sits in its OWN bin, between the two parent misses, so a leaked
// flag would show up as a third divider rather than hiding inside an existing one.
check(
	dividerCount(sub) === 0,
	"a subagent transcript alone → 0 dividers (was 1 before #115)"
);

// …and WHERE, not just how many (PR review round 2). The fixture is built so
// placement matters — the subagent's bin sits between the parent's two misses —
// so a divider drawn on the wrong bin, or a suppressed one resurfacing inside a
// bin that already has one, keeps the counts at 2 and 0 and passes regardless.
const rendered = (buildWtftLines([...parent, ...sub], DEFAULTS,
	{ interval: "1h", mode: "bucket", width: 80 }) as string[])
	.map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""));
// Bin rows are newest-first and labelled in LOCAL time, so they are matched by
// shape rather than by hour — an assertion pinned to a clock reading is the #96
// flaky-pricing trap in a different costume.
const binRows = rendered
	.map((line, i) => ({ line, i }))
	.filter(r => /^\d\d:\d\d\s+\$/.test(r.line))
	.map(r => r.i);
const hasDividerAbove = (i: number) => (rendered[i - 1] || "").includes("Cache Miss");
check(binRows.length === 3, `three bins render (${binRows.length})`);
// Newest first: [0] is the parent's 14:00Z re-prime, [1] the subagent's 13:10Z
// bin, [2] the parent's 12:00Z cold start.
check(hasDividerAbove(binRows[0]), "a divider sits on the parent's re-prime bin");
check(hasDividerAbove(binRows[2]), "…and on the parent's own cold-start bin");
check(
	!hasDividerAbove(binRows[1]),
	"…and NOT on the bin between them, which only the subagent occupies"
);

console.log("--- TEST 3: cost is untouched ---");
// cacheMiss is a label on the interaction, never a term in the price. Pinned to
// an ARITHMETIC expectation rather than to a second parse of the same fixture:
// comparing post-fix against post-fix can only catch non-determinism, and would
// have passed just as happily if the fix had moved every dollar (PR review).
// $/Mtok for claude-opus-5, from docs/manifests/wtft-pricing.json; the 1h cache
// write is the manifest's 6.25 5m rate's 1h sibling at 2x input, which
// tests/wtft-pricing-tiers.test.ts is the guard for. Spelled out here so this
// suite fails loudly if a rate moves, rather than re-deriving the answer from
// the code it is testing.
const RATES = { input: 5, cacheWrite1h: 10, cacheRead: 0.5, output: 25 };
function priced(cr: number, cw: number): number {
	return (2 * RATES.input + cw * RATES.cacheWrite1h + cr * RATES.cacheRead + 300 * RATES.output) / 1e6;
}
const parentCost = parent.reduce((s: number, i: any) => s + i.cost, 0);
const subCost = sub.reduce((s: number, i: any) => s + i.cost, 0);
const expectedParent = priced(0, 48278) + priced(50000, 1200) + priced(0, 91000);
const expectedSub = priced(0, 61000) + priced(61000, 900);
check(
	Math.abs(parentCost - expectedParent) < 1e-9,
	`parent cost is exactly the sum of its turns ($${parentCost.toFixed(6)})`
);
check(
	Math.abs(subCost - expectedSub) < 1e-9,
	`subagent still reports its own cost ($${subCost.toFixed(6)}) — dropped flag, not dropped spend`
);

console.log("--- TEST 4: provenance closes the gap the envelope cannot ---");
// Pi marks a subagent at FILE level (a parentSession header, no per-entry flag),
// and the nested workflow layout stamps nothing either. The parse-time gate
// cannot see either shape, so loadSubagentInteractions clears the flag for
// anything that came out of a subagent transcript, whatever its harness writes.
const piPath = path.join(dir, "pi-subagent.jsonl");
fs.writeFileSync(piPath, [
	usageLine({ id: "pi_start", ts: "2026-07-01T13:40:00Z", cr: 0, cw: 55000 }), // no isSidechain
	usageLine({ id: "pi_hit", ts: "2026-07-01T13:45:00Z", cr: 55000, cw: 800 }),
].join("\n") + "\n");

check(
	parseSessionFile(piPath).some((i: any) => i.cacheMiss === true),
	"an unstamped subagent transcript DOES look like a miss at parse time (the gap)"
);
const viaProvenance = loadSubagentInteractions([piPath]);
check(
	viaProvenance.length === 2 && viaProvenance.every((i: any) => !i.cacheMiss),
	"…and loadSubagentInteractions clears it anyway — 0 dividers"
);
check(dividerCount(viaProvenance) === 0, "so the unstamped subagent draws no divider either");

console.log("--- TEST 5: the merge cannot resurrect the flag ---");
// isSidechain itself is deliberately NOT widened by the merge: it gates
// splitOverheadCost's recache detection and the prevCtx chain, so ORing it would
// move a merged message's cache-write dollars between buckets (PR review round
// 2). Only the label the merge can get wrong is cleared.
// deduplicateInteractions keeps the MAX-COST copy of a message id. If a re-logged
// copy omits the envelope's isSidechain and wins on cost, the flag came back.
const mixed = [
	// Same id, two copies: the cheap one knows it is a sidechain, the dear one does not.
	...parseSessionFile(writeFixture(path.join(dir, "mixed.jsonl"), [
		usageLine({ id: "m1", ts: "2026-07-01T15:00:00Z", cr: 0, cw: 1000, isSidechain: true }),
		usageLine({ id: "m1", ts: "2026-07-01T15:00:00Z", cr: 0, cw: 90000 }),
	])),
];
const mergedIx = deduplicateInteractions(mixed);
check(mergedIx.length === 1, "the two copies collapse to one billed message");
check(!mergedIx[0].cacheMiss, "the divider stays suppressed when any copy knew it was a sidechain");
check(
	mergedIx[0].isSidechain !== true,
	"…and isSidechain itself is NOT widened, so no overhead bucket moves"
);

console.log("--- TEST 6: the daemon's own reader is gated too ---");
// The CLI renders from the TAG FILE, and the daemon writes subagent tag lines
// through parseSessionFile + deduplicateInteractions + serializeClassified —
// never through loadSubagentInteractions (PR review round 2, High). Clearing the
// flag in only one reader bakes `miss: 1` into the tag file and makes the Pi
// widget and the CLI disagree about the same session.
const daemonSide = deduplicateInteractions(parseSessionFile(piPath));
check(
	daemonSide.some((i: any) => i.cacheMiss === true),
	"the daemon's parse sees the same unstamped miss (the gap it would bake in)"
);
const tagLines = clearSubagentCacheMiss(daemonSide)
	.map((i: any) => serializeClassified(i))
	.join("\n")
	.split("\n")
	.filter(Boolean)
	.map((l: string) => JSON.parse(l));
check(tagLines.length > 0, "…it serializes tag lines for the subagent");
check(
	tagLines.every((l: any) => l.miss !== 1),
	"…and not one of them carries miss=1, so the tag file cannot resurrect the divider"
);

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

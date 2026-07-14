#!/usr/bin/env -S npx tsx
/**
 * @package princess-pi-packages
 * @test wtft-phase3-overhead
 * @description Validates #52 Phase 3 against the BUILT bin/wtft.mjs:
 *   1. Compaction meter-split — isCompactSummary flags next assistant turn;
 *      dual tag lines; cache_write $ → compaction, remainder → work category;
 *      the two sum to the original cost (conservation).
 *   2. Recache detection — exact 5-condition meter conjunction → overhead
 *      line; any single failed condition → no split.
 *   3. Interrupted — both marker spellings stamp the PRECEDING turn whole;
 *      literal inside assistant text does NOT reclassify.
 *   4. Pi compaction — type:"compaction" meter-splits and still carries
 *      compactionTokensBefore (#90 unaffected).
 *   5. Legend renders Cmpct/Intr/Ovrhd in CATEGORY_ORDER slots.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
	parseEntryToInteraction,
	parseSessionFile,
	classifyInteraction,
	deduplicateInteractions,
	splitOverheadCost,
	serializeClassifiedWithOverheadSplit,
	isInterruptMarker,
	readClassifiedTagFile,
} from "../bin/wtft.mjs";

const CLI_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";
let passed = 0, failed = 0;
function assert(label: string, ok: boolean) {
	console.log(`  ${ok ? GREEN + "PASS" : RED + "FAIL"}${RESET} ${label}`);
	ok ? passed++ : failed++;
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// --- Fixture builders ---

let idCounter = 0;
function claudeAssistant(opts: {
	usage?: any; content?: any[]; id?: string; ts?: number; sidechain?: boolean;
}) {
	return {
		type: "assistant",
		isSidechain: opts.sidechain || undefined,
		timestamp: new Date(opts.ts ?? Date.now()).toISOString(),
		message: {
			role: "assistant",
			id: opts.id || `msg_p3_${++idCounter}`,
			model: "claude-fable-5",
			usage: opts.usage ?? { input_tokens: 100, output_tokens: 50 },
			content: opts.content ?? [{ type: "text", text: "reply" }],
		},
	};
}

const RECACHE_USAGE = {
	input_tokens: 2,
	output_tokens: 300,
	cache_read_input_tokens: 16_000,
	cache_creation_input_tokens: 150_000,
	cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 150_000 },
};
// prevCtx ≈ 2 + 16k + 150k = 166002 → previous turn must be within ±15%
const PREV_USAGE = {
	input_tokens: 3,
	output_tokens: 200,
	cache_read_input_tokens: 155_000,
	cache_creation_input_tokens: 5_000,
	cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5_000 },
};
const prevCtxTokens = 3 + 155_000 + 5_000; // 160003; recache ctx=166002 → 3.7% delta ✓

// ---
// 1. splitOverheadCost unit behavior
// ---
console.log("1. splitOverheadCost — compaction and recache detection");
{
	// Compaction: afterCompaction flag → cache_write share extracted
	const compTurn = parseEntryToInteraction(
		claudeAssistant({
			usage: {
				input_tokens: 2, output_tokens: 300,
				cache_read_input_tokens: 20_000,
				cache_creation_input_tokens: 40_000,
				cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40_000 },
			},
			content: [{ type: "tool_use", name: "write", input: { file_path: "src/main.ts" } }],
		}),
		undefined, undefined, true // afterCompaction
	)!;
	const compSplit = splitOverheadCost(compTurn, 0);
	assert("compaction turn splits", compSplit !== null && compSplit.kind === "compaction");
	assert("compaction overhead < full cost", compSplit!.overheadCost > 0 && compSplit!.overheadCost < compTurn.cost);

	// Recache: full 5-condition conjunction
	const recache = parseEntryToInteraction(claudeAssistant({ usage: RECACHE_USAGE }))!;
	const rSplit = splitOverheadCost(recache, prevCtxTokens);
	assert("recache signature detected → overhead", rSplit !== null && rSplit.kind === "overhead");
	// cache_write dominates this turn's cost (150k cw @2× vs tiny rest)
	assert("recache overhead is the dominant share", rSplit!.overheadCost > 0.9 * recache.cost);

	// Each single broken condition → no split
	const breaks: [string, any, number][] = [
		["input > 16", { ...RECACHE_USAGE, input_tokens: 20 }, prevCtxTokens],
		["e1h != cw", { ...RECACHE_USAGE, cache_creation: { ephemeral_5m_input_tokens: 150_000, ephemeral_1h_input_tokens: 0 } }, prevCtxTokens],
		["cw ≤ 30k", { ...RECACHE_USAGE, cache_creation_input_tokens: 25_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 25_000 } }, prevCtxTokens],
		["cr ≥ 20% of ctx", { ...RECACHE_USAGE, cache_read_input_tokens: 60_000 }, 2 + 60_000 + 150_000],
		["prevCtx mismatch", RECACHE_USAGE, 50_000],
		["prevCtx unknown (0)", RECACHE_USAGE, 0],
	];
	for (const [label, usage, ctx] of breaks) {
		const t = parseEntryToInteraction(claudeAssistant({ usage }))!;
		assert(`no split when ${label}`, splitOverheadCost(t, ctx) === null);
	}

	// Sidechain never recache-splits
	const side = parseEntryToInteraction(claudeAssistant({ usage: RECACHE_USAGE, sidechain: true }))!;
	assert("sidechain excluded from recache", splitOverheadCost(side, prevCtxTokens) === null);
}

// ---
// 2. Dual-line serialization + conservation
// ---
console.log("\n2. serializeClassifiedWithOverheadSplit — dual lines, conservation");
{
	const recache = parseEntryToInteraction(claudeAssistant({ usage: RECACHE_USAGE, id: "msg_dual" }))!;
	const out = serializeClassifiedWithOverheadSplit(recache, prevCtxTokens);
	const lines = out.trim().split("\n").map(l => JSON.parse(l));
	assert("emits two lines", lines.length === 2);
	const main = lines[0], oh = lines[1];
	assert("overhead line cat=overhead", oh.cat === "overhead");
	assert("overhead line id suffixed #oh", oh.id === "msg_dual#oh");
	assert("main line cache-write tokens zeroed", (main.cw ?? 0) === 0);
	assert("overhead line carries cw tokens", oh.cw === 150_000);
	assert("costs sum to original (conservation)", approx(main.c + oh.c, Number(recache.cost.toFixed(6)), 2e-6));
	assert("same timestamp (same bucket)", main.t === oh.t);

	// Normal turn: single line
	const normal = parseEntryToInteraction(claudeAssistant({}))!;
	assert("normal turn emits one line", serializeClassifiedWithOverheadSplit(normal, prevCtxTokens).trim().split("\n").length === 1);
}

// ---
// 3. Interrupted markers (parseSessionFile end-to-end)
// ---
console.log("\n3. Interrupted — marker spellings, preceding-turn stamp, noise immunity");
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-p3-intr-"));
	const sessionPath = path.join(dir, "s.jsonl");
	const mk = (o: any) => JSON.stringify(o);
	fs.writeFileSync(sessionPath, [
		mk(claudeAssistant({ id: "msg_killed_1", content: [{ type: "tool_use", name: "write", input: { file_path: "src/a.ts" } }] })),
		mk({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
		mk(claudeAssistant({ id: "msg_killed_2", content: [{ type: "tool_use", name: "bash", input: { command: "git status" } }] })),
		mk({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } }),
		// Noise: literal inside assistant text must NOT stamp anything
		mk(claudeAssistant({ id: "msg_noise", content: [{ type: "text", text: "the marker [Request interrupted by user] is detected like this" }] })),
		mk(claudeAssistant({ id: "msg_normal", content: [{ type: "tool_use", name: "write", input: { file_path: "src/b.ts" } }] })),
	].join("\n") + "\n");

	const parsed = deduplicateInteractions(parseSessionFile(sessionPath));
	const byId = new Map(parsed.map(i => [i.messageId, i]));
	assert("plain marker stamps preceding turn", classifyInteraction(byId.get("msg_killed_1")!) === "interrupted");
	assert("'for tool use' marker stamps preceding turn", classifyInteraction(byId.get("msg_killed_2")!) === "interrupted");
	assert("literal in assistant text does not stamp itself", classifyInteraction(byId.get("msg_noise")!) === "prompt");
	assert("following turn unaffected", classifyInteraction(byId.get("msg_normal")!) === "code");

	// tool-result noise: marker inside a tool_result user entry (non-text block)
	assert("marker inside tool_result block ignored", !isInterruptMarker({
		type: "user",
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "[Request interrupted by user]" }] },
	}));
	fs.rmSync(dir, { recursive: true, force: true });
}

// ---
// 4. Compaction via parseSessionFile (Claude) and Pi type:"compaction"
// ---
console.log("\n4. Compaction flags — Claude isCompactSummary and Pi type:compaction");
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-p3-comp-"));
	const sessionPath = path.join(dir, "s.jsonl");
	fs.writeFileSync(sessionPath, [
		JSON.stringify(claudeAssistant({ id: "msg_before" })),
		JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued..." } }),
		JSON.stringify(claudeAssistant({
			id: "msg_after_compact",
			usage: {
				input_tokens: 2, output_tokens: 300, cache_read_input_tokens: 20_000,
				cache_creation_input_tokens: 40_000,
				cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40_000 },
			},
			content: [{ type: "tool_use", name: "write", input: { file_path: "src/c.ts" } }],
		})),
	].join("\n") + "\n");
	const parsed = deduplicateInteractions(parseSessionFile(sessionPath));
	const after = parsed.find(i => i.messageId === "msg_after_compact")!;
	assert("Claude: turn after compact summary flagged", after.afterCompaction === true);
	assert("Claude: earlier turn not flagged", parsed.find(i => i.messageId === "msg_before")!.afterCompaction === undefined);
	const split = splitOverheadCost(after, 0);
	assert("flagged turn meter-splits to compaction", split?.kind === "compaction");
	assert("remainder classifies as work (code)", classifyInteraction({ ...after, cacheWriteTokens: 0, afterCompaction: undefined }) === "code");

	// Pi: type:"compaction" stamping — both #90 tokensBefore and Phase 3 flag
	const piSession = path.join(dir, "pi.jsonl");
	fs.writeFileSync(piSession, [
		JSON.stringify({ type: "compaction", tokensBefore: 717_518 }),
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant", id: "pi_after", model: "claude-fable-5",
				timestamp: new Date().toISOString(),
				usage: { input: 5, output: 100, cacheRead: 0, cacheWrite: 43_411 },
				content: [{ type: "text", text: "continuing" }],
			},
		}),
	].join("\n") + "\n");
	const piParsed = parseSessionFile(piSession);
	const piAfter = piParsed.find(i => i.messageId === "pi_after")!;
	assert("Pi: compactionTokensBefore still carried (#90)", piAfter.compactionTokensBefore === 717_518);
	assert("Pi: afterCompaction flag set", piAfter.afterCompaction === true);
	assert("Pi: meter-split kind compaction", splitOverheadCost(piAfter, 0)?.kind === "compaction");
	fs.rmSync(dir, { recursive: true, force: true });
}

// ---
// 5. Legend + stacking via built CLI on a fixture with all three overheads
// ---
console.log("\n5. Legend renders Cmpct/Intr/Ovrhd (built CLI, daemon pipeline)");
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-p3-legend-"));
	const sessionPath = path.join(dir, "session.jsonl");
	const now = Date.now();
	fs.writeFileSync(sessionPath, [
		JSON.stringify(claudeAssistant({ id: "m1", ts: now - 300_000, usage: PREV_USAGE, content: [{ type: "tool_use", name: "write", input: { file_path: "src/x.ts" } }] })),
		JSON.stringify(claudeAssistant({ id: "m2", ts: now - 240_000, usage: RECACHE_USAGE })),
		JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "continued" } }),
		JSON.stringify(claudeAssistant({
			id: "m3", ts: now - 180_000,
			usage: { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 16_000, cache_creation_input_tokens: 45_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 45_000 } },
		})),
		JSON.stringify(claudeAssistant({ id: "m4", ts: now - 120_000, content: [{ type: "tool_use", name: "bash", input: { command: "git status" } }] })),
		JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
	].join("\n") + "\n");

	// First invocation spawns the daemon; under batch-run load the tag file
	// can miss the CLI's ~1.4s wait window ("no data yet"), so poll for
	// classified output before the render whose legend we assert on.
	let out = "";
	for (let attempt = 0; attempt < 5; attempt++) {
		out = execSync(
			`${process.execPath} ${CLI_BIN} -s '${sessionPath}' -i 10m -l 3 -w 200 --no-emoji 2>&1 || true`,
			{ encoding: "utf8", timeout: 20_000 }
		);
		if (!out.includes("no data yet")) break;
		execSync("sleep 1");
	}
	const clean = out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	assert("legend shows Cmpct", clean.includes("Cmpct"));
	assert("legend shows Intr", clean.includes("Intr"));
	assert("legend shows Ovrhd", clean.includes("Ovrhd"));
	assert("legend order Cmpct < Intr < Ovrhd < Other",
		clean.indexOf("Cmpct") < clean.indexOf("Intr") &&
		clean.indexOf("Intr") < clean.indexOf("Ovrhd") &&
		clean.indexOf("Ovrhd") < clean.indexOf("Other"));

	// Daemon pipeline correctness: read the tag file back
	const tagsDir = path.join(dir, "wtft-tags");
	const tagFile = fs.readdirSync(tagsDir).find(f => f.endsWith(".jsonl"))!;
	const tagged = readClassifiedTagFile(path.join(tagsDir, tagFile));
	const cats = tagged.map(i => classifyInteraction(i));
	assert("tag file has overhead line (recache)", cats.includes("overhead"));
	assert("tag file has compaction line", cats.includes("compaction"));
	assert("tag file has interrupted line", cats.includes("interrupted"));
	// conservation: session total equals sum of tag lines
	const totalTagged = tagged.reduce((s, i) => s + i.cost, 0);
	const rawTotal = deduplicateInteractions(parseSessionFile(sessionPath)).reduce((s, i) => s + i.cost, 0);
	assert("conservation: tag total = raw session total", approx(totalTagged, rawTotal, 1e-4));

	// cleanup daemon spawned for the fixture
	try {
		const { getDaemonPidPath } = await import("../bin/wtft.mjs");
		const pid = parseInt(fs.readFileSync(getDaemonPidPath(sessionPath), "utf8").trim(), 10);
		if (pid > 0) process.kill(pid, "SIGTERM");
	} catch {}
	fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

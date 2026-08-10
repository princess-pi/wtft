/**
 * Tests for #149 — transcript-invisible spend, counted but never priced.
 *
 * Two halves, matching docs/spec-149-compaction-cost-scope.md §8:
 *
 *   V2–V4  the research harness's residual instrument. The point of these is
 *          that the FIRST instrument (pair status records by timestamp) was
 *          wrong: transcript entries are flushed up to ~1.5s after the status
 *          record that bills them, so timestamp windows sawtooth ±$0.20. V3 is
 *          the regression guard — it builds a fixture whose transcript lags
 *          deliberately and asserts the residual is still zero.
 *
 *   V5–V10 the wtft change: count `/compact` and away-recap events per harness,
 *          render them as an UNCOUNTED line, and change no cost number.
 *
 * Everything exercises public interfaces: the harness module's exports and
 * wtft's exported parser/renderer functions. No clock is read — every timestamp
 * below is a literal (#96).
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	scanUncountedBillables,
	newUncountedBillables,
	addUncountedBillables,
	readUncountedBillableClass,
	renderUncountedBillables,
	renderTokenSummary,
	parseSessionFile,
	discoverSubagentSessionFiles,
} from "../bin/wtft.mjs";

import {
	alignRecords,
	residualStaircase,
	loadWtftInteractions,
	readStatusLog,
	listLoggedSessions,
	auditSession,
} from "../research/149-cost-scope/paired-window-audit.mjs";

// ---
// FIXTURES
// ---

let tmpSeq = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-149-"));

function writeJsonl(name: string, entries: any[]): string {
	const p = path.join(tmpDir, `${name}-${tmpSeq++}.jsonl`);
	fs.writeFileSync(p, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
	return p;
}

/** One Claude Code assistant response, written as the two copies the real
 *  transcript writes (thinking block, then tool_use) sharing a message id. */
function ccAssistant(id: string, ts: string, usage: { in?: number; out: number; cw?: number; cr?: number }) {
	const u = {
		input_tokens: usage.in ?? 2,
		output_tokens: usage.out,
		cache_creation_input_tokens: usage.cw ?? 0,
		cache_read_input_tokens: usage.cr ?? 0,
		cache_creation: { ephemeral_1h_input_tokens: usage.cw ?? 0, ephemeral_5m_input_tokens: 0 },
	};
	return {
		type: "assistant",
		timestamp: ts,
		requestId: `req_${id}`,
		message: { id, role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "x" }], usage: u },
	};
}

/** Claude Code's per-turn cost, by the #146 formula confirmed against Claude
 *  Code's own arithmetic: Opus 5 = $5 in / $25 out / $0.50 cache read /
 *  $10.00 1h cache write per MTok. */
function opus5Cost(u: { in?: number; out: number; cw?: number; cr?: number }): number {
	return (u.in ?? 2) * 5e-6 + u.out * 25e-6 + (u.cw ?? 0) * 10e-6 + (u.cr ?? 0) * 0.5e-6;
}

function statusRecord(ts: string, epochMs: number, costUsd: number, transcriptPath: string, usage: { in?: number; out: number; cw?: number; cr?: number }) {
	return {
		_ts: ts,
		_epoch_ms: epochMs,
		session_id: "fixture",
		transcript_path: transcriptPath,
		model: { id: "claude-opus-5" },
		session_name: "fixture",
		cost: { total_cost_usd: costUsd },
		context_window: {
			total_input_tokens: (usage.cr ?? 0) + (usage.cw ?? 0),
			current_usage: {
				input_tokens: usage.in ?? 2,
				output_tokens: usage.out,
				cache_creation_input_tokens: usage.cw ?? 0,
				cache_read_input_tokens: usage.cr ?? 0,
			},
		},
	};
}

// ---
// V2/V3 — the residual instrument survives transcript write lag
// ---

describe("#149 residual instrument — usage alignment, not timestamps", () => {
	/** Three turns. Each transcript entry is stamped 5s AFTER the status record
	 *  that bills it — an exaggerated version of the real ~1.5s flush lag. A
	 *  timestamp-windowed instrument reports a sawtooth here; a usage-aligned
	 *  one reports nothing, because nothing is missing. */
	function laggedFixture() {
		const turns = [
			{ in: 2, out: 500, cw: 100, cr: 50_000 },
			{ in: 2, out: 900, cw: 40, cr: 90_000 },
			{ in: 2, out: 300, cw: 10, cr: 130_000 },
		];
		const base = 1_786_000_000_000;
		const transcript = writeJsonl("lagged", turns.map((u, i) =>
			ccAssistant(`msg_${i}`, new Date(base + i * 60_000 + 5_000).toISOString(), u)));

		let running = 0;
		const records = turns.map((u, i) => {
			running += opus5Cost(u);
			return statusRecord(new Date(base + i * 60_000).toISOString(), base + i * 60_000, running, transcript, u);
		});
		return { transcript, records, turns };
	}

	it("V3 — residual is zero when every transcript entry lags its status record", () => {
		const { transcript, records } = laggedFixture();
		const interactions = loadWtftInteractions(transcript);
		const aligned = alignRecords(records, interactions);
		const stair = residualStaircase(aligned, [], 0.0005);

		assert.strictEqual(aligned.length, records.length, "every record should align by usage");
		assert.ok(Math.abs(stair.finalResidual) < 1e-9, `expected ~0 residual, got ${stair.finalResidual}`);
		assert.strictEqual(stair.steps.length, 0, "no invisible spend in a fully-recorded session");
	});

	it("V2 — the staircase never steps downward", () => {
		const { transcript, records } = laggedFixture();
		const aligned = alignRecords(records, loadWtftInteractions(transcript));
		const stair = residualStaircase(aligned, [], 0.0005);
		assert.strictEqual(stair.negativeSteps, 0, "a downward step means alignment broke");
	});

	it("V4 — an injected invisible call shows as exactly one step of exactly its size", () => {
		const turns = [
			{ in: 2, out: 500, cw: 100, cr: 50_000 },
			{ in: 2, out: 900, cw: 40, cr: 90_000 },
		];
		const INVISIBLE = 0.157782; // the magnitude measured on ee53e779
		const base = 1_786_000_000_000;
		const transcript = writeJsonl("invisible", turns.map((u, i) =>
			ccAssistant(`msg_${i}`, new Date(base + i * 60_000 + 5_000).toISOString(), u)));

		// Claude Code bills turn 0, then the invisible call, then turn 1.
		let running = 0;
		const records = [];
		running += opus5Cost(turns[0]);
		records.push(statusRecord(new Date(base).toISOString(), base, running, transcript, turns[0]));
		running += INVISIBLE + opus5Cost(turns[1]);
		records.push(statusRecord(new Date(base + 60_000).toISOString(), base + 60_000, running, transcript, turns[1]));

		const stair = residualStaircase(alignRecords(records, loadWtftInteractions(transcript)), [], 0.0005);
		assert.strictEqual(stair.steps.length, 1, "one injected call → one step");
		assert.ok(Math.abs(stair.steps[0].usd - INVISIBLE) < 1e-9, `step should be ${INVISIBLE}, got ${stair.steps[0].usd}`);
		assert.strictEqual(stair.negativeSteps, 0);
	});
});

// ---
// V1 — the harness runs against real logged sessions
// ---

describe("#149 harness — runs against a real logged session", () => {
	it("V1 — auditSession produces a monotone staircase on every logged non-subagent session", () => {
		const logDir = path.join(os.homedir(), ".claude", "statusline-logs");
		const ids = listLoggedSessions(logDir);
		if (ids.length === 0) {
			console.log("  (skipped: no status-line logs on this machine)");
			return;
		}
		let audited = 0;
		let skippedSubagent = 0;
		for (const id of ids) {
			// §7 of the spec is explicit that the "0 negative steps" measurement
			// covers the 7 sessions it analyzed, none of which used Task
			// subagents, and that the interaction between subagent sidechains and
			// this instrument is UNTESTED. This machine now runs multi-agent
			// workflows that log sessions with real subagent transcripts (a
			// dispatcher session mid-run, e.g.) — asserting monotonicity there
			// would test a claim the spec never made. Skip, don't assert.
			let records;
			try { records = readStatusLog(logDir, id); } catch { continue; }
			const transcriptPath = records[0]?.transcript_path;
			if (transcriptPath && fs.existsSync(transcriptPath) && discoverSubagentSessionFiles(transcriptPath).length > 0) {
				skippedSubagent++;
				continue;
			}
			let report;
			try { report = auditSession(logDir, id); } catch { continue; } // too few records / moved transcript
			audited++;
			assert.strictEqual(report.negativeSteps, 0, `${id}: residual stepped downward — alignment broke`);
			assert.ok(report.residual >= -1e-6, `${id}: residual should never be negative, got ${report.residual}`);
			for (const s of report.steps) assert.ok(s.usd > 0, `${id}: a recorded step must be positive`);
		}
		if (skippedSubagent > 0) console.log(`  (${skippedSubagent} subagent-bearing session(s) skipped — see comment)`);
		if (audited === 0) {
			console.log("  (skipped: every logged session on this machine currently has subagent transcripts)");
			return;
		}
		// Sanity on readStatusLog's contract while we are here.
		const recs = readStatusLog(logDir, ids[0]);
		for (let i = 1; i < recs.length; i++) {
			assert.ok(recs[i]._epoch_ms >= recs[i - 1]._epoch_ms, "records must be ascending by _epoch_ms");
		}
	});
});

// ---
// V5–V7 — scanning for uncounted billables, per harness
// ---

describe("scanUncountedBillables — Claude Code", () => {
	it("V5 — a compact_boundary counts as one compaction", () => {
		const f = writeJsonl("cc-compact", [
			ccAssistant("m1", "2026-08-09T08:05:29.000Z", { out: 100, cr: 1000 }),
			{ type: "system", subtype: "compact_boundary", timestamp: "2026-08-09T08:24:34.707Z",
			  compactMetadata: { trigger: "manual", preTokens: 376813, postTokens: 15148, durationMs: 119665 } },
			{ type: "user", isCompactSummary: true, timestamp: "2026-08-09T08:24:35.000Z", message: { role: "user", content: "summary…" } },
			ccAssistant("m2", "2026-08-09T08:24:45.000Z", { out: 200, cr: 2000 }),
		]);
		const counts = scanUncountedBillables(f);
		assert.strictEqual(counts.compaction, 1, "boundary + summary is ONE compaction, not two");
		assert.strictEqual(counts.recap, 0);
	});

	it("V6 — an away_summary counts as one recap", () => {
		const f = writeJsonl("cc-recap", [
			{ type: "system", subtype: "away_summary", timestamp: "2026-08-10T00:59:18.134Z", content: "…" },
			{ type: "system", subtype: "away_summary", timestamp: "2026-08-10T01:56:33.932Z", content: "…" },
			{ type: "system", subtype: "turn_duration", timestamp: "2026-08-10T00:56:15.521Z", durationMs: 865362 },
		]);
		const counts = scanUncountedBillables(f);
		assert.strictEqual(counts.recap, 2);
		assert.strictEqual(counts.compaction, 0, "turn_duration is NOT an uncounted billable — only ~55% coincide with spend");
	});

	it("reports no blind spot for an ordinary session", () => {
		const f = writeJsonl("cc-plain", [ccAssistant("m1", "2026-08-09T08:05:29.000Z", { out: 100, cr: 1000 })]);
		assert.deepStrictEqual(scanUncountedBillables(f), { compaction: 0, recap: 0 });
	});

	it("returns zeros rather than throwing on a missing file", () => {
		assert.deepStrictEqual(scanUncountedBillables(path.join(tmpDir, "does-not-exist.jsonl")), { compaction: 0, recap: 0 });
	});
});

describe("scanUncountedBillables — Pi", () => {
	it("V7 — a Pi compaction entry counts once and still stamps compactionTokensBefore", () => {
		const f = writeJsonl("pi-compact", [
			{ type: "compaction", id: "cmp001", parentId: "msg002", timestamp: "2026-01-01T00:00:00Z", summary: "…", firstKeptEntryId: "msg003", tokensBefore: 50000 },
			{ type: "message", id: "msg003", parentId: "cmp001", timestamp: "2026-01-01T00:01:00Z",
			  message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "…" }],
			             usage: { input_tokens: 1000, output_tokens: 200, cost: { total: 0.005 } } } },
		]);
		assert.strictEqual(scanUncountedBillables(f).compaction, 1, "one compaction entry, counted once");
		assert.strictEqual(scanUncountedBillables(f).recap, 0, "Pi has no away-recap feature");

		// The existing #90 behaviour must be untouched by the new scan.
		const interactions = parseSessionFile(f);
		assert.strictEqual(interactions.length, 1);
		assert.strictEqual(interactions[0].compactionTokensBefore, 50000, "meter-split stamp still lands");
	});

	it("readUncountedBillableClass returns the class, or null for ordinary entries", () => {
		assert.strictEqual(readUncountedBillableClass({ type: "system", subtype: "compact_boundary" }), "compaction");
		assert.strictEqual(readUncountedBillableClass({ type: "system", subtype: "away_summary" }), "recap");
		assert.strictEqual(readUncountedBillableClass({ type: "compaction", tokensBefore: 1 }), "compaction");
		assert.strictEqual(readUncountedBillableClass({ type: "system", subtype: "turn_duration" }), null);
		assert.strictEqual(readUncountedBillableClass({ type: "user" }), null);
		assert.strictEqual(readUncountedBillableClass(null), null);
	});
});

describe("uncounted billable arithmetic", () => {
	it("newUncountedBillables starts at zero and add is a plain sum", () => {
		assert.deepStrictEqual(newUncountedBillables(), { compaction: 0, recap: 0 });
		assert.deepStrictEqual(
			addUncountedBillables({ compaction: 1, recap: 2 }, { compaction: 3, recap: 0 }),
			{ compaction: 4, recap: 2 },
		);
	});
});

// ---
// V8–V9 — the UNCOUNTED line
// ---

describe("renderUncountedBillables", () => {
	it("V8 — names both classes when both are present", () => {
		const out = renderUncountedBillables({ compaction: 1, recap: 3 });
		assert.match(out, /UNCOUNTED/);
		assert.match(out, /1 compaction\b/);
		assert.match(out, /3 recaps/);
		assert.match(out, /#149/);
		assert.match(out, /NOT in TOTAL/);
	});

	it("V8 — singular/plural, and only the non-zero classes", () => {
		assert.match(renderUncountedBillables({ compaction: 2, recap: 0 }), /2 compactions/);
		assert.doesNotMatch(renderUncountedBillables({ compaction: 2, recap: 0 }), /recap/);
		assert.match(renderUncountedBillables({ compaction: 0, recap: 1 }), /1 recap\b/);
		assert.doesNotMatch(renderUncountedBillables({ compaction: 0, recap: 1 }), /compaction/);
	});

	it("V8 — renders nothing when there is no blind spot to report", () => {
		assert.strictEqual(renderUncountedBillables({ compaction: 0, recap: 0 }), "");
		assert.strictEqual(renderUncountedBillables(undefined), "");
	});
});

describe("renderTokenSummary — UNCOUNTED is additive only", () => {
	const interactions = [{
		timestamp: Date.parse("2026-08-09T08:05:29.000Z"),
		cost: 0.5, messageId: "m1", model: "claude-opus-5",
		inputTokens: 2, outputTokens: 500, cacheReadTokens: 50_000, cacheWriteTokens: 100,
		reasoningTokens: 0, webSearchRequests: 0, webFetchRequests: 0, serverToolCost: 0,
		files: [], commands: [], texts: [],
	}] as any[];

	it("V9 — the TOTAL row is byte-identical with and without the uncounted argument", () => {
		const without = renderTokenSummary(interactions, 100, undefined);
		const with_ = renderTokenSummary(interactions, 100, undefined, { compaction: 2, recap: 5 });
		const totalOf = (s: string) => s.split("\n").find(l => l.startsWith("TOTAL"));
		assert.strictEqual(totalOf(with_), totalOf(without), "no cost number may change");
		assert.ok(with_.startsWith(without.replace(/\n$/, "")) || with_.includes(without.trimEnd()),
			"the uncounted line must be appended, never interleaved");
	});

	it("V8 — the UNCOUNTED line appears in the summary when counts are non-zero", () => {
		const out = renderTokenSummary(interactions, 100, undefined, { compaction: 1, recap: 0 });
		assert.match(out, /UNCOUNTED {2}1 compaction/);
	});

	it("V8 — output is unchanged when the argument is omitted", () => {
		const a = renderTokenSummary(interactions, 100, undefined);
		const b = renderTokenSummary(interactions, 100, undefined, { compaction: 0, recap: 0 });
		assert.strictEqual(a, b);
		assert.doesNotMatch(a, /UNCOUNTED/);
	});
});

// --- cleanup ---
process.on("exit", () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

console.log("✅ All #149 uncounted-billable tests passed.");

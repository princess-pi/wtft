/**
 * Tests for #149 — transcript-invisible spend, counted but never priced.
 *
 * Three groups, matching docs/spec-149-compaction-cost-scope.md §8:
 *
 *   V2–V4  the research harness's residual instrument, on synthetic fixtures.
 *          The point of these is that the FIRST instrument (pair status records
 *          by timestamp) was wrong: transcript entries are flushed up to ~1.5s
 *          after the status record that bills them, so timestamp windows sawtooth
 *          ±$0.20. V3 is the regression guard — it builds a fixture whose
 *          transcript lags deliberately and asserts the residual is still zero.
 *
 *   V1     the same instrument against whatever real sessions this machine has
 *          logged — a SURVEY, not a characterisation (#256). It prints one flat
 *          `#149-survey key=value` record per session and asserts only what
 *          holds on unknown data: that every session lands in exactly one
 *          bucket, that `readStatusLog` returns ascending records, and that
 *          steps and dips carry the sign their names promise. It still skips
 *          subagent-bearing sessions (spec §7: untested), and emits `##SKIP##`
 *          when there is nothing to run against, so `bun run test` can say the
 *          check did not happen instead of reporting a green it did not earn.
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
import { trackSandbox } from "./lib/sandbox";

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
const tmpDir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-149-")));

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

	it("V2b — a counter reset shows as exactly one dip of exactly its size", () => {
		// The shape measured on `d971ae4a` (#282): Claude Code's cumulative
		// `total_cost_usd` RESTARTS mid-session, so the third record reports the
		// cost of its own turn alone. R therefore drops by everything billed
		// before it and never recovers.
		//
		// This is V2's property inverted, and it lives here — on a fixture whose
		// arithmetic is decidable — rather than on whatever this machine happens
		// to have logged. V1 measured it on real sessions and was wrong about
		// what it proved (#256): the claim held for the 7 sessions the spec
		// analyzed and fails on 2 of the 23 this host now has.
		const turns = [
			{ in: 2, out: 500, cw: 100, cr: 50_000 },
			{ in: 2, out: 900, cw: 40, cr: 90_000 },
			{ in: 2, out: 871, cw: 17_748, cr: 211_573 },
		];
		const base = 1_786_000_000_000;
		const transcript = writeJsonl("reset", turns.map((u, i) =>
			ccAssistant(`msg_${i}`, new Date(base + i * 60_000 + 5_000).toISOString(), u)));

		const cum = [
			opus5Cost(turns[0]),
			opus5Cost(turns[0]) + opus5Cost(turns[1]),
			opus5Cost(turns[2]), // the reset: this turn's cost, and nothing before it
		];
		const records = turns.map((u, i) =>
			statusRecord(new Date(base + i * 60_000).toISOString(), base + i * 60_000, cum[i], transcript, u));

		const stair = residualStaircase(alignRecords(records, loadWtftInteractions(transcript)), [], 0.0005);
		const lost = opus5Cost(turns[0]) + opus5Cost(turns[1]);

		assert.strictEqual(stair.negativeSteps, 1, "one reset → one downward step");
		assert.strictEqual(stair.dips.length, 1, "every counted downward step must also be RECORDED");
		assert.ok(Math.abs(stair.dips[0].usd + lost) < 1e-9, `dip should be -${lost}, got ${stair.dips[0].usd}`);
		assert.strictEqual(stair.dips[0].at, records[2]._ts, "a dip carries the record it lands on");
		assert.strictEqual(stair.steps.length, 0, "a reset is not invisible spend — it must not be reported as a step");
	});

	it("V2c — dips and steps are disjoint, and negativeSteps equals dips.length", () => {
		const { transcript, records } = laggedFixture();
		const stair = residualStaircase(alignRecords(records, loadWtftInteractions(transcript)), [], 0.0005);
		assert.strictEqual(stair.negativeSteps, stair.dips.length, "the count and the record must not disagree");
		assert.deepStrictEqual(stair.dips, [], "a clean session records no dips");
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

describe("#149 harness — surveys every real logged session", () => {
	/** V1 is REPORT-ONLY on the residual's shape, and that is a correction rather
	 *  than a workaround (#256).
	 *
	 *  What it used to do: assert `negativeSteps === 0` on every non-subagent
	 *  session this machine had logged. Two things were wrong with that.
	 *
	 *  The property is false. Spec §7 measured it on the 7 sessions it analyzed;
	 *  this host now logs 23 auditable ones and 2 of them dip. One is a Claude
	 *  Code counter RESET — `d971ae4a` falls $20.906723 to exactly the cost of
	 *  the single turn that follows, and wtft priced that session to $0.000000
	 *  per interaction on both sides of the cliff (#282). Asserting there fails
	 *  the suite for something wtft got right.
	 *
	 *  And it under-reported itself. `assert` throws on the FIRST bad session and
	 *  ends the loop, so the suite only ever named `d8e0363d` (-$0.27) while the
	 *  $20.91 one sat behind it, in the asserted set, unseen for as long as both
	 *  existed. A survey that stops at the first finding is not a survey.
	 *
	 *  So the residual's shape moved to V2b/V2c, where the arithmetic is decidable
	 *  and a dip is a fixture rather than a fact about this laptop. What stays
	 *  asserted here is what a survey can honestly claim on unknown data: that
	 *  every session is ACCOUNTED FOR (no silent drops), that the records the
	 *  harness reads obey their ordering contract, and that steps and dips carry
	 *  the sign their names promise. The measurements themselves are printed as
	 *  flat key=value records — one per session, greppable, no prose to parse. */
	it("V1 — every logged session is accounted for, and the survey is printed in full", () => {
		const logDir = path.join(os.homedir(), ".claude", "statusline-logs");
		const ids = listLoggedSessions(logDir);
		if (ids.length === 0) {
			console.log("##SKIP## V1 — no ~/.claude/statusline-logs on this machine: the harness ran against no real session");
			return;
		}

		const surveyed: any[] = [];
		let audited = 0, skippedSubagent = 0, unreadable = 0, unauditable = 0;

		for (const id of ids) {
			const short = id.slice(0, 8);
			let records;
			try { records = readStatusLog(logDir, id); } catch {
				unreadable++;
				surveyed.push({ session: short, status: "unreadable-log" });
				continue;
			}

			// readStatusLog's ordering contract, checked on EVERY log rather than
			// on ids[0] — it is the one thing here that cannot depend on the host.
			for (let i = 1; i < records.length; i++) {
				assert.ok(records[i]._epoch_ms >= records[i - 1]._epoch_ms,
					`${short}: readStatusLog must return records ascending by _epoch_ms`);
			}

			// Spec §7 is explicit that the interaction between subagent sidechains
			// and this instrument is UNTESTED, so subagent-bearing sessions are
			// surveyed but never characterised.
			const transcriptPath = records[0]?.transcript_path;
			// Round 6: discovery returns { files, unreadable } — the walk's
			// readable files are the count that matters here.
			if (transcriptPath && fs.existsSync(transcriptPath) && discoverSubagentSessionFiles(transcriptPath).files.length > 0) {
				skippedSubagent++;
				surveyed.push({ session: short, status: "skipped-subagent", records: records.length });
				continue;
			}

			let report;
			try { report = auditSession(logDir, id); } catch (e) {
				unauditable++; // too few records, or a transcript that has since moved
				surveyed.push({ session: short, status: "unauditable", records: records.length, why: (e as Error).message.split(":").pop()?.trim() });
				continue;
			}
			audited++;

			// Shape invariants. These hold on ANY data — a step is spend the
			// transcript never recorded, a dip is the opposite — so asserting
			// them costs nothing and catches a sign error in the instrument.
			for (const s of report.steps) assert.ok(s.usd > 0, `${short}: a recorded step must be positive, got ${s.usd}`);
			for (const d of report.dips) assert.ok(d.usd < 0, `${short}: a recorded dip must be negative, got ${d.usd}`);
			assert.strictEqual(report.negativeSteps, report.dips.length,
				`${short}: negativeSteps (${report.negativeSteps}) and dips (${report.dips.length}) must not disagree`);

			surveyed.push({
				session: short,
				status: report.dips.length > 0 ? "DIPS" : "monotone",
				records: report.records,
				aligned: report.alignedRecords,
				residual: report.residual.toFixed(6),
				pct: report.residualPct.toFixed(1),
				steps: report.steps.length,
				dips: report.dips.length,
				worst_dip: report.dips.length ? Math.min(...report.dips.map((d: any) => d.usd)).toFixed(6) : "0",
			});
		}

		// Every id must land in exactly one bucket — the accounting IS the test.
		// A survey that drops sessions on the floor reports a clean sweep of a
		// corpus it never looked at.
		assert.strictEqual(audited + skippedSubagent + unreadable + unauditable, ids.length,
			"every logged session must be accounted for in exactly one bucket");
		assert.strictEqual(surveyed.length, ids.length, "one survey record per logged session");

		for (const r of surveyed) {
			console.log("  #149-survey  " + Object.entries(r).map(([k, v]) => `${k}=${v}`).join("  "));
		}
		console.log(`  #149-survey-totals  sessions=${ids.length}  audited=${audited}  skipped_subagent=${skippedSubagent}  unreadable=${unreadable}  unauditable=${unauditable}  dip_bearing=${surveyed.filter(r => r.status === "DIPS").length}`);

		if (audited === 0) {
			console.log("##SKIP## V1 — every logged session was skipped or unauditable: the residual instrument ran on nothing");
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

// ---
// research/149-cost-scope/paired-window-audit.mjs — paired-sample cost audit (#149)
//
// WHY THIS EXISTS
// `.cost.total_cost_usd` is computed inside Claude Code and written nowhere in
// the transcript, so wtft's total can only be checked against the status line.
// Comparing SESSION TOTALS is invalid: the status line samples a cumulative
// counter at render time, which produced a 1.6% phantom residual on a session
// whose per-turn deltas were exact (#149, comment 2). Paired samples are the
// only sound instrument.
//
// WHY THE OBVIOUS PAIRING IS ALSO WRONG
// The first version of this harness paired consecutive `_epoch_ms` records and
// priced the transcript messages whose timestamps fell between them. That
// produces a ±$0.20 SAWTOOTH, not a residual: Claude Code renders the status
// line the instant the response completes, and the transcript entry for that
// same response is flushed up to ~1.5s LATER. Every window therefore either
// double-counts or misses exactly one message, and the sign alternates. Reading
// any single window as evidence is a false positive; three of the "invisible
// cost classes" the first pass found were this artifact.
//
// THE INSTRUMENT THAT WORKS — USAGE ALIGNMENT
// Every status-line record carries `context_window.current_usage`: the usage of
// the most recent API response. That is a JOIN KEY. Match it against the
// deduplicated interaction list on (input, output, cache_creation, cache_read)
// and you know exactly which message Claude Code had billed when it wrote that
// record — no timestamp guessing. Define
//
//     R(k) = (claude_cost(k) - claude_cost(0)) - (wtft_cost_through_msg(k) - ...)
//
// over aligned records only. R is then a clean MONOTONE STAIRCASE: flat while
// the transcript explains the bill, stepping up exactly when Claude Code bills
// something the transcript never records. Each step is one transcript-invisible
// API call, and its size is the measurement.
//
// WHERE THE STAIRCASE IS VALIDATED — AND WHERE IT IS NOT
// On sessions WITHOUT Task subagents the staircase has ZERO negative steps
// (five logged sessions at first measurement, 2026-08-10T11:00Z; the sawtooth is
// entirely gone). On a session WITH subagents it is NOT validated: `e0d2ec4b`
// (18 subagent transcripts, 55/107 records aligned) reports 6 downward steps and
// the harness flags it `⚠️  alignment broke`. The mechanism is NOT identified —
// naming one here without measuring it would repeat the mistake the SAWTOOTH
// paragraph above documents. What is known: `loadWtftInteractions` does fold
// subagent files in, so it is not a missing-input problem, and the forward-only
// pointer in `alignRecords` is the obvious suspect on an interleaved,
// concurrently-written stream. Tracked as its own issue.
// PRACTICAL RULE: treat any non-zero `negativeSteps` as "this session is out of
// scope for this instrument", never as a finding. `tests/wtft-issue-149-*.test.ts`
// skips subagent-bearing sessions rather than asserting on them, and since #256
// does not assert monotonicity on the others either — it SURVEYS them and prints
// what it found. The property was measured on 7 sessions and asserted over 23;
// two dip, one of them because Claude Code's cumulative counter RESET mid-session
// (`d971ae4a`, -$20.906723 landing on exactly the next turn's cost, #282). Every
// downward step is now recorded in `dips[]` alongside the tally, because
// `negativeSteps: 1` said a session was out of scope without saying by how much,
// and a $20.91 artifact sat behind a $0.27 one, unseen, for as long as both
// existed.
//
// DEDUP RULE (do not "fix" this)
// The transcript writes multiple copies of one assistant message id as streaming
// usage grows. Deduping by FIRST copy undercounts output ~33%.
// `deduplicateInteractions` keeps the MAX-cost copy, which is the final billed
// value (#54). This harness calls wtft's own function so the residual measures
// SCOPE and never a difference in how the two sides were assembled.
//
// Usage:
//   node research/149-cost-scope/paired-window-audit.mjs <session-id-prefix> [flags]
//   node research/149-cost-scope/paired-window-audit.mjs --all
//
// Flags:
//   --all             audit every session that has a status-line log
//   --logs <dir>      override the status-line log directory
//   --raw-windows     also print the naive per-record window table (shows the sawtooth)
//   --json            machine-readable output
//   --step <usd>      minimum step counted as invisible spend (default 0.005)
// ---

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	parseSessionFile,
	parseEntryToInteraction,
	applyControlEntry,
	newParseStreamState,
	deduplicateInteractions,
	discoverSubagentSessionFiles,
} from "../../bin/wtft.mjs";

// ---
// CONFIG
// ---

const DEFAULT_LOG_DIR = path.join(os.homedir(), ".claude", "statusline-logs");
/** Below this a step is float noise on a 6dp counter, not an API call. */
const DEFAULT_STEP_USD = 0.005;

// ---
// ARGS
// ---

export function parseArgs(argv) {
	const opts = { session: null, all: false, logDir: DEFAULT_LOG_DIR, rawWindows: false, json: false, minStep: DEFAULT_STEP_USD };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--all") opts.all = true;
		else if (a === "--raw-windows") opts.rawWindows = true;
		else if (a === "--json") opts.json = true;
		else if (a === "--logs") opts.logDir = argv[++i];
		else if (a === "--step") opts.minStep = Number(argv[++i]);
		else if (!a.startsWith("-")) opts.session = a;
	}
	return opts;
}

// ---
// STATUS-LINE LOG
// ---

export function listLoggedSessions(logDir) {
	if (!fs.existsSync(logDir)) return [];
	return fs.readdirSync(logDir).filter(f => f.endsWith(".jsonl") && !f.startsWith(".")).map(f => f.slice(0, -6));
}

export function resolveSession(logDir, prefix) {
	const hits = listLoggedSessions(logDir).filter(s => s.startsWith(prefix) || s.includes(prefix));
	if (hits.length === 0) throw new Error(`no status-line log matches "${prefix}" in ${logDir}`);
	if (hits.length > 1) throw new Error(`ambiguous prefix "${prefix}": ${hits.join(", ")}`);
	return hits[0];
}

/** Records ascending by `_epoch_ms`. Torn final lines are skipped, not fatal —
 *  the logger is best-effort by design. */
export function readStatusLog(logDir, sessionId) {
	const out = [];
	for (const line of fs.readFileSync(path.join(logDir, `${sessionId}.jsonl`), "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const r = JSON.parse(line);
			if (typeof r?._epoch_ms === "number" && typeof r?.cost?.total_cost_usd === "number") out.push(r);
		} catch { /* torn write */ }
	}
	out.sort((a, b) => a._epoch_ms - b._epoch_ms);
	return out;
}

// ---
// TRANSCRIPT
// ---

/** wtft's own view: exactly the interaction list it prices, subagents rolled in
 *  the way wtft rolls them in. Anything else would measure the harness, not the gap. */
export function loadWtftInteractions(transcriptPath) {
	// Round 7: parseSessionFile can throw when a NESTED subagent transcript is
	// unreadable (attribution throws; previously silent zero). Production
	// callers are guarded; this research caller is not — one unreadable nested
	// transcript would abort the whole audit run where it used to complete
	// with a zero. Warn and continue: an audit that covers the readable files
	// and names the skip is closer to the truth than no audit at all.
	const all = [];
	try {
		all.push(...parseSessionFile(transcriptPath));
	} catch (err) {
		// Round 10 (macroscope, Medium): a throw here used to lose the PARENT's
		// own rows too — the whole parse result was dropped, not just the
		// nested part that threw. Recover the transcript's own interactions
		// from the raw lines (per-line parse, per-line swallow) so the audit
		// still prices the transcript's own reads; the nested cost is what may
		// be missing, and the warning names exactly that.
		console.warn(`[paired-window-audit] transcript could not be parsed (${transcriptPath}), recovering its own interactions; nested cost may be missing: ${err?.message ?? err}`);
		try {
			// Round 10 (macroscope, Medium): a bare per-line
			// parseEntryToInteraction loses the control stream — Pi
			// model_change records are never replayed, so entries parse with
			// an empty effective model and native-zero rows cannot be priced
			// against anything. Mirror parseSessionFile's loop (state + control
			// replay + same interaction arguments); only the nested
			// attribution, which is what threw, is omitted.
			const state = newParseStreamState();
			for (const line of fs.readFileSync(transcriptPath, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line);
					const isControl = applyControlEntry(entry, state, () => {
						if (all.length > 0) all[all.length - 1].interrupted = true;
					});
					if (isControl) continue;
					const interaction = parseEntryToInteraction(entry, state.thinkingLevel, state.compactionTokensBefore, state.afterCompaction, state.model);
					if (interaction) {
						all.push(interaction);
						state.compactionTokensBefore = undefined;
						state.afterCompaction = false;
					}
				} catch { /* torn or unparseable line — skip it, never abort the recovery */ }
			}
		} catch (readErr) {
			// The transcript itself cannot be read at all — nothing to recover.
			console.warn(`[paired-window-audit] transcript could not be read, treated as empty (${transcriptPath}): ${readErr?.message ?? readErr}`);
		}
	}
	// Round 6: discovery returns { files, unreadable } — the readable files
	// are what wtft prices. Round 9 (PR review, Low): the discovery call
	// itself can THROW (an unreadable subagents directory, an unreadable
	// Pi-pattern sibling sessionDir) — the same class the parse guard above
	// exists for, so it gets the same warn-and-continue treatment. An audit
	// that covers the readable files and names the skip is closer to the
	// truth than no audit at all.
	let subFiles = [];
	try {
		subFiles = discoverSubagentSessionFiles(transcriptPath).files;
	} catch (err) {
		console.warn(`[paired-window-audit] subagent discovery failed, no subagents for this transcript (${transcriptPath}): ${err?.message ?? err}`);
	}
	for (const sub of subFiles) {
		try {
			all.push(...parseSessionFile(sub));
		} catch (err) {
			console.warn(`[paired-window-audit] subagent transcript could not be parsed, skipped (${sub}): ${err?.message ?? err}`);
		}
	}
	const deduped = deduplicateInteractions(all);
	deduped.sort((a, b) => a.timestamp - b.timestamp);
	return deduped;
}

/** Non-assistant markers a step may coincide with. Read from the raw transcript
 *  because wtft's parser deliberately discards them. */
export function readTranscriptMarkers(transcriptPath) {
	const markers = [];
	for (const line of fs.readFileSync(transcriptPath, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let e;
		try { e = JSON.parse(line); } catch { continue; }
		const at = Date.parse(e.timestamp ?? "");
		if (Number.isNaN(at)) continue;
		if (e.type === "system" && typeof e.subtype === "string") {
			markers.push({ at, kind: e.subtype, meta: e.compactMetadata ?? {} });
		} else if (e.isCompactSummary === true) {
			markers.push({ at, kind: "compact_summary", meta: {} });
		} else if (e.type === "user" && !e.isMeta && !hasToolResult(e)) {
			markers.push({ at, kind: "human_prompt", meta: {} });
		}
	}
	markers.sort((a, b) => a.at - b.at);
	return markers;
}

function hasToolResult(e) {
	const c = e.message?.content;
	return Array.isArray(c) && c.some(b => b?.type === "tool_result");
}

// ---
// USAGE ALIGNMENT
// ---

const usageKey = u => `${u?.input_tokens ?? 0}/${u?.output_tokens ?? 0}/${u?.cache_creation_input_tokens ?? 0}/${u?.cache_read_input_tokens ?? 0}`;
const interactionKey = i => `${i.inputTokens}/${i.outputTokens}/${i.cacheWriteTokens}/${i.cacheReadTokens}`;

/**
 * Join status-line records to interactions on `context_window.current_usage`.
 *
 * The pointer only moves forward, so a record whose usage matches nothing ahead
 * of it (a mid-stream render, where `output_tokens` is a partial count) is
 * simply skipped — it carries no alignment information. Skipping costs nothing:
 * `wtftCum` is a prefix sum by INDEX, so a skipped record never drops an
 * interaction, it only defers it to the next aligned record.
 */
export function alignRecords(records, interactions) {
	const prefix = [0];
	for (const i of interactions) prefix.push(prefix[prefix.length - 1] + i.cost + (i.serverToolCost || 0));

	const aligned = [];
	let ptr = 0;
	for (const r of records) {
		const k = usageKey(r.context_window?.current_usage);
		let found = -1;
		for (let j = ptr; j < interactions.length; j++) {
			if (interactionKey(interactions[j]) === k) { found = j; break; }
		}
		if (found < 0) continue;
		ptr = found + 1;
		aligned.push({ record: r, index: found, wtftCum: prefix[found + 1] });
	}
	return aligned;
}

/** Residual staircase over aligned records, plus one entry per upward step. */
export function residualStaircase(aligned, markers, minStep) {
	if (aligned.length < 2) return { steps: [], dips: [], finalResidual: 0, claudeSpan: 0, negativeSteps: 0 };
	const a0 = aligned[0];
	const steps = [];
	/** Downward steps, recorded rather than merely tallied. `negativeSteps` alone
	 *  said a session was out of scope without saying where or by how much, which
	 *  is what let a $20.91 counter reset sit inside the asserted set unexamined
	 *  (#282). Same shape as `steps`, opposite sign. */
	const dips = [];
	let prevR = 0;
	let prev = a0;
	let negativeSteps = 0;

	for (const a of aligned) {
		const R = (a.record.cost.total_cost_usd - a0.record.cost.total_cost_usd) - (a.wtftCum - a0.wtftCum);
		const d = R - prevR;
		if (d >= minStep) {
			steps.push({
				at: a.record._ts,
				usd: d,
				residualAfter: R,
				fromTs: prev.record._ts,
				interactionsSpanned: a.index - prev.index,
				/** Context Claude Code held at the START of the step, from the
				 *  status payload. An invisible call that re-reads the whole
				 *  context costs contextTokens × cacheReadRate at minimum. */
				contextTokens: prev.record.context_window?.total_input_tokens ?? 0,
				markers: [...new Set(markers.filter(m => m.at > prev.record._epoch_ms && m.at <= a.record._epoch_ms).map(m => m.kind))],
			});
		} else if (d <= -minStep) {
			negativeSteps++;
			dips.push({
				at: a.record._ts,
				usd: d,
				residualAfter: R,
				fromTs: prev.record._ts,
				interactionsSpanned: a.index - prev.index,
				claudeCumBefore: prev.record.cost.total_cost_usd,
				claudeCumAfter: a.record.cost.total_cost_usd,
				contextTokens: prev.record.context_window?.total_input_tokens ?? 0,
				markers: [...new Set(markers.filter(m => m.at > prev.record._epoch_ms && m.at <= a.record._epoch_ms).map(m => m.kind))],
			});
		}
		prevR = R;
		prev = a;
	}

	return {
		steps,
		dips,
		finalResidual: prevR,
		claudeSpan: aligned[aligned.length - 1].record.cost.total_cost_usd - a0.record.cost.total_cost_usd,
		negativeSteps,
	};
}

// ---
// NAIVE WINDOWS (kept to demonstrate the artifact, never to draw conclusions from)
// ---

export function buildRawWindows(records, interactions) {
	const w = [];
	for (let i = 1; i < records.length; i++) {
		const t0 = records[i - 1]._epoch_ms, t1 = records[i]._epoch_ms;
		const inWin = interactions.filter(x => x.timestamp > t0 && x.timestamp <= t1);
		const claudeDelta = records[i].cost.total_cost_usd - records[i - 1].cost.total_cost_usd;
		const wtftDelta = inWin.reduce((s, x) => s + x.cost + (x.serverToolCost || 0), 0);
		w.push({ index: i, from: records[i - 1]._ts, to: records[i]._ts, messages: inWin.length, claudeDelta, wtftDelta, residual: claudeDelta - wtftDelta });
	}
	return w;
}

// ---
// AUDIT
// ---

export function auditSession(logDir, sessionId, minStep = DEFAULT_STEP_USD) {
	const records = readStatusLog(logDir, sessionId);
	if (records.length < 2) throw new Error(`${sessionId}: need >= 2 log records, have ${records.length}`);

	const transcriptPath = records[0].transcript_path;
	if (!transcriptPath || !fs.existsSync(transcriptPath)) throw new Error(`${sessionId}: transcript missing at ${transcriptPath}`);

	const interactions = loadWtftInteractions(transcriptPath);
	const markers = readTranscriptMarkers(transcriptPath);
	const aligned = alignRecords(records, interactions);
	const stair = residualStaircase(aligned, markers, minStep);

	const t0 = aligned.length ? aligned[0].record._epoch_ms : records[0]._epoch_ms;
	const t1 = aligned.length ? aligned[aligned.length - 1].record._epoch_ms : records[records.length - 1]._epoch_ms;
	const inSpan = m => m.at > t0 && m.at <= t1;
	const countIn = kind => markers.filter(m => m.kind === kind && inSpan(m)).length;

	// A step is attributed to compaction only when a compact boundary sits inside
	// its own window. Everything else stays UNATTRIBUTED — naming a mechanism the
	// data does not identify would be the same mistake hypothesis A was.
	const compactionSteps = stair.steps.filter(s => s.markers.includes("compact_boundary") || s.markers.includes("compact_summary"));
	const otherSteps = stair.steps.filter(s => !compactionSteps.includes(s));

	return {
		sessionId,
		transcriptPath,
		model: records[0].model?.id,
		sessionName: records[0].session_name,
		records: records.length,
		alignedRecords: aligned.length,
		interactions: interactions.length,
		alignedInteractions: aligned.length ? aligned[aligned.length - 1].index + 1 : 0,
		claudeSpan: stair.claudeSpan,
		residual: stair.finalResidual,
		residualPct: stair.claudeSpan ? (stair.finalResidual / stair.claudeSpan) * 100 : 0,
		negativeSteps: stair.negativeSteps,
		steps: stair.steps,
		dips: stair.dips,
		attribution: {
			compaction: { count: compactionSteps.length, usd: compactionSteps.reduce((s, x) => s + x.usd, 0) },
			unattributed: { count: otherSteps.length, usd: otherSteps.reduce((s, x) => s + x.usd, 0) },
		},
		markerCounts: {
			human_prompt: countIn("human_prompt"),
			turn_duration: countIn("turn_duration"),
			away_summary: countIn("away_summary"),
			compact_boundary: countIn("compact_boundary"),
		},
		rawWindows: buildRawWindows(records, interactions),
		minStep,
	};
}

// ---
// RENDER
// ---

const usd = n => (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(6);

export function renderReport(r, rawWindows) {
	const L = [];
	L.push(`=== ${r.sessionId.slice(0, 8)}  ${r.model}  "${r.sessionName ?? ""}"`);
	L.push(`    transcript  ${r.transcriptPath}`);
	L.push(`    ${r.alignedRecords}/${r.records} status records aligned to ${r.alignedInteractions}/${r.interactions} interactions`);
	L.push("");
	L.push(`    Claude Code billed over aligned span   ${usd(r.claudeSpan)}`);
	L.push(`    residual not explained by transcript   ${usd(r.residual)}   (${r.residualPct.toFixed(2)}%)`);
	L.push(`    downward steps (instrument sanity)     ${r.negativeSteps}   ${r.negativeSteps === 0 ? "✅ monotone" : "⚠️  alignment broke"}`);
	L.push("");
	L.push(`    ATTRIBUTION`);
	L.push(`      compaction     ${String(r.attribution.compaction.count).padStart(3)} step(s)   ${usd(r.attribution.compaction.usd)}`);
	L.push(`      unattributed   ${String(r.attribution.unattributed.count).padStart(3)} step(s)   ${usd(r.attribution.unattributed.usd)}`);
	L.push("");
	L.push(`    CONTEXT COUNTS IN SPAN   human prompts ${r.markerCounts.human_prompt}   turn ends ${r.markerCounts.turn_duration}   recaps ${r.markerCounts.away_summary}   compactions ${r.markerCounts.compact_boundary}`);
	L.push("");
	if (r.steps.length) {
		L.push(`    INVISIBLE-SPEND STEPS (>= ${usd(r.minStep)})`);
		L.push(`      ${"at".padEnd(21)} ${"usd".padStart(11)} ${"ctx tok".padStart(9)} ${"impliedOut".padStart(11)}  markers`);
		for (const s of r.steps) {
			// If the invisible call re-read the whole context from cache, the
			// leftover prices as output. Reported as a SHAPE, not a claim.
			const readFloor = s.contextTokens * 0.5e-6;
			const impliedOut = (s.usd - readFloor) / 25e-6;
			L.push(`      ${s.at.padEnd(21)} ${usd(s.usd).padStart(11)} ${String(s.contextTokens).padStart(9)} ${impliedOut.toFixed(0).padStart(11)}  ${s.markers.join(",")}`);
		}
		L.push(`      (impliedOut assumes Opus-5 rates: cache read $0.50/MTok, output $25/MTok)`);
		L.push("");
	}
	if (rawWindows) {
		const bad = r.rawWindows.filter(w => Math.abs(w.residual) > 0.02);
		L.push(`    NAIVE PER-RECORD WINDOWS with |residual| > $0.02 — ${bad.length} of ${r.rawWindows.length}`);
		L.push(`    (this is the SAWTOOTH, kept as a counter-example; do not read it as a gap)`);
		for (const w of bad.slice(0, 20)) {
			L.push(`      ${w.from} → ${w.to}  msgs ${String(w.messages).padStart(3)}  claude ${usd(w.claudeDelta).padStart(12)}  wtft ${usd(w.wtftDelta).padStart(12)}  resid ${usd(w.residual).padStart(12)}`);
		}
		L.push("");
	}
	return L.join("\n");
}

// ---
// MAIN
// ---

function main() {
	const opts = parseArgs(process.argv.slice(2));
	const ids = opts.all ? listLoggedSessions(opts.logDir) : [resolveSession(opts.logDir, opts.session ?? "")];

	const reports = [];
	for (const id of ids) {
		try { reports.push(auditSession(opts.logDir, id, opts.minStep)); }
		catch (e) { if (!opts.json) console.error(`-- skip ${id.slice(0, 8)}: ${e.message}`); }
	}

	if (opts.json) { console.log(JSON.stringify(reports, null, 2)); return; }

	for (const r of reports) { console.log(renderReport(r, opts.rawWindows)); }

	if (reports.length > 1) {
		const span = reports.reduce((s, r) => s + r.claudeSpan, 0);
		const resid = reports.reduce((s, r) => s + r.residual, 0);
		const comp = reports.reduce((s, r) => s + r.attribution.compaction.usd, 0);
		const unattr = reports.reduce((s, r) => s + r.attribution.unattributed.usd, 0);
		const neg = reports.reduce((s, r) => s + r.negativeSteps, 0);
		const steps = reports.reduce((s, r) => s + r.steps.length, 0);
		console.log(`=== ALL ${reports.length} SESSIONS`);
		console.log(`    billed ${usd(span)}   residual ${usd(resid)}   (${((resid / span) * 100).toFixed(2)}%)`);
		console.log(`    compaction ${usd(comp)}   unattributed ${usd(unattr)}   steps ${steps}   downward steps ${neg}`);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

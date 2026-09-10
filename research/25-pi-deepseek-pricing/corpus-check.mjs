#!/usr/bin/env node
/**
 * research/25-pi-deepseek-pricing/corpus-check.mjs — #25's Closer.
 *
 * #495's Closer proved wtft prices DeepSeek correctly on CLAUDE CODE
 * transcripts. It said nothing about the Pi harness, where 83.5% of this host's
 * 14,276 DeepSeek turns actually reach `calculateClaudeCost`
 * (see pi-fallthrough-count.mjs). This is the Pi-shaped sibling.
 *
 * HOW IT AVOIDS AGREEING WITH ITSELF. The expected figure is computed from a
 * rate card TRANSCRIBED BY HAND below, and from a surge rule re-implemented
 * below. Nothing in the expected path imports `wtft-cost.ts`. If this file
 * imported the registry it would compare the code against itself and print
 * 0.0000% for any card at all, correct or not.
 *
 * WHAT IT DOES NOT CHECK, said out loud because #495's Closer printed 0.0000%
 * and exit 0 while a whole harness went unexamined:
 *   - Claude Code transcripts. Out of scope here by construction; that is what
 *     #495's own Closer covered.
 *   - Whether the transcribed card matches what DeepSeek actually billed. This
 *     compares wtft against a second transcription of the same published card.
 *     Two transcriptions of a wrong card agree perfectly.
 *   - Turns that use Pi's native `cost.total`. wtft reports Pi's number for
 *     those, unchanged; whether Pi is right is Pi's question.
 *   - Any model with no transcribed card — `deepseek-reasoner` (527 turns).
 *     Those are counted as `unpriced` and never compared, because comparing a
 *     guess against a guess is not evidence.
 *
 * Reads ~/.pi/agent/sessions read-only. Writes nothing. `--json` for the record.
 *
 * Exit 0 only when the run examined something AND every compared turn matched:
 * `files > 0`, `compared > 0`, and zero mismatches. Exit 1 otherwise — INCLUDING
 * an empty corpus with zero mismatches, because a check that read nothing is not
 * a passing check.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { calculateClaudeCost } = await import(path.join(REPO, "bin", "wtft.mjs"));

const SESSIONS = path.join(os.homedir(), ".pi", "agent", "sessions");
const asJson = process.argv.includes("--json");

// ---
// THE INDEPENDENT CARD — hand-transcribed, not imported.
//
// Per 1M tokens, OFF-PEAK (DeepSeek publishes off-peak as half of peak).
// `input` is the cache-MISS rate, `cacheRead` the cache-HIT rate: DeepSeek's
// Anthropic-format endpoint reports no cache-creation tokens and bills a miss
// as plain input, so cache writes are genuinely free. `before` carries the card
// in force strictly before 2026-08-16T16:00:00Z.
//
// Source: DeepSeek's published pricing page as scraped for #495
// (research/495-deepseek-pricing/pricing-page-2026-08-25.md in the origin repo),
// re-typed here. If these disagree with extensions/lib/wtft-cost.ts, ONE OF THE
// TWO IS WRONG and this file's job is to say so — do not "fix" it by copying
// the registry's numbers across.
// ---
const RATE_CARD_CHANGED_AT = Date.UTC(2026, 7, 16, 16, 0, 0); // 2026-08-16T16:00:00Z
const V41_FLASH_FROM       = Date.UTC(2026, 8, 10, 4, 0, 0);  // 2026-09-10T04:00:00Z
const V4_PRO_REROUTE_FROM  = Date.UTC(2026, 8, 14, 4, 0, 0);  // 2026-09-14T04:00:00Z
const WEEKEND_OFFPEAK_FROM = Date.UTC(2026, 7, 23, 0, 0, 0);  // 2026-08-23T00:00:00Z
const PEAK_WINDOWS_UTC = [[60, 240], [360, 600]];             // 01:00–04:00, 06:00–10:00

// A model's cards, NEWEST FIRST, each with the instant it took effect. Two
// windows became three when V4.1 Flash retired the V4 Flash line (#100), which
// is why this is a list rather than a `current`/`before` pair — the pair could
// not express a model with two superseded cards, and v4-flash now has two.
//
// The V4.1 Flash numbers are transcribed from the scrape committed at
// research/100-deepseek-v41-flash/pricing-page-2026-09-10.md, the same
// independent route as the #495 numbers above it. NOT read from
// extensions/lib/wtft-cost.ts — see this file's header. Copying the registry
// across is the one edit that destroys what this file is for.
const CARD = {
	"deepseek-v4-pro": {
		// From 2026-09-14 the NAME routes to V4.1 Flash and bills at its card.
		cards: [
			{ from: V4_PRO_REROUTE_FROM,  input: 0.15, output: 0.60, cacheRead: 0.003 },
			{ from: RATE_CARD_CHANGED_AT, input: 0.66, output: 1.98, cacheRead: 0.022 },
			{ from: 0,                    input: 1.74, output: 3.48, cacheRead: 0.0145 },
		],
	},
	"deepseek-v4-flash": {
		cards: [
			{ from: V41_FLASH_FROM,       input: 0.15, output: 0.60, cacheRead: 0.003 },
			{ from: RATE_CARD_CHANGED_AT, input: 0.22, output: 0.66, cacheRead: 0.007 },
			{ from: 0,                    input: 0.14, output: 0.28, cacheRead: 0.0028 },
		],
	},
	// Believed released after the 2026-08-16 change, so a turn predating it would
	// be a fiction — but the registry carries the old card for it anyway since
	// #100, for symmetry with -flash whose retirement it shares. This table
	// MIRRORS that, because the two must agree about a period even when neither
	// expects to see a turn in it: without the row, a pre-2026-08-16 vision-exp
	// turn falls back to 0.22 here and resolves to 0.14 in wtft, and the
	// disagreement would be reported as a pricing mismatch that is really this
	// file being stale. Retired alongside -flash.
	"deepseek-v4-flash-vision-exp": {
		cards: [
			{ from: V41_FLASH_FROM,       input: 0.15, output: 0.60, cacheRead: 0.003 },
			{ from: RATE_CARD_CHANGED_AT, input: 0.22, output: 0.66, cacheRead: 0.007 },
			{ from: 0,                    input: 0.14, output: 0.28, cacheRead: 0.0028 },
		],
	},
	// V4.1 Flash under its own name. One card: it did not exist before it.
	"deepseek-flash": {
		cards: [
			{ from: 0, input: 0.15, output: 0.60, cacheRead: 0.003 },
		],
	},
};

/**
 * Longest key first — "deepseek-v4-flash" is a substring of the vision key.
 * "deepseek-flash" is a substring of neither, so it cannot steal a v4 lookup.
 */
const CARD_KEYS = Object.keys(CARD).sort((a, b) => b.length - a.length);

function cardFor(model) {
	const m = (model || "").toLowerCase().trim();
	if (CARD[m]) return { key: m, entry: CARD[m] };
	for (const key of CARD_KEYS) if (m.includes(key)) return { key, entry: CARD[key] };
	return null;
}

function surgeMultiplier(ts) {
	if (!ts) return 1.0;                       // unknown instant never surges
	const d = new Date(ts);
	if (ts >= WEEKEND_OFFPEAK_FROM) {
		const day = d.getUTCDay();
		if (day === 0 || day === 6) return 1.0; // Sat/Sun off-peak all day
	}
	const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
	for (const [start, end] of PEAK_WINDOWS_UTC) if (minutes >= start && minutes < end) return 2.0;
	return 1.0;
}

function expectedCost(entry, usage, ts) {
	// An UNKNOWN instant takes the STANDARD row — the newest card — and this is
	// the one place the transcription must copy wtft's rule rather than pick the
	// sensible-looking one. `resolveTieredRates` gates its dated windows on
	// `pricing.dateTiers && timestamp`, so a falsy timestamp skips every window
	// and lands on the unconditioned quad, however old the turn looks. The
	// caller passes 0 for a timestamp it could not parse (see below), so this
	// path is reachable.
	//
	// A first draft fell through to the OLDEST card here, on the reasoning that
	// an undated turn is probably old. Measured against wtft: 1.74 against 0.15
	// for v4-pro, an 11.6x divergence that would have reported every undated
	// turn as a mismatch — the checker's own bug wearing a finding's costume.
	// The corpus has no undated DeepSeek turn today, so nothing went red.
	//
	// Note it SELECTS a card rather than returning one: an earlier fix here
	// `return`ed entry.cards[0], so the caller's Math.abs(actual - expected) went
	// NaN, NaN > EPSILON is false, and an undated turn was silently neither
	// compared nor counted while the script still exited 0. A checker that skips
	// a turn without saying so is worse than one that gets it wrong loudly.
	//
	// `cards` is newest-first, so for a dated turn the first match wins.
	const rates = !ts
		? entry.cards[0]
		: (entry.cards.find(c => ts >= c.from) ?? entry.cards[entry.cards.length - 1]);
	const surge = surgeMultiplier(ts);
	return (
		usage.input * (rates.input * surge / 1e6) +
		// Reasoning tokens bill at the output rate, for every model.
		(usage.output + usage.reasoning) * (rates.output * surge / 1e6) +
		usage.cacheRead * (rates.cacheRead * surge / 1e6)
		// Cache writes are free on this endpoint — no term.
	);
}

function* sessionFiles(dir) {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* sessionFiles(full);
		else if (entry.name.endsWith(".jsonl")) yield full;
	}
}

// Absolute tolerance in dollars. A single turn's cost is O($0.01); floating
// point over five multiply-adds cannot reach this, and a wrong rate cannot
// hide under it.
const EPSILON = 1e-9;

let files = 0, deepseekTurns = 0, usedPiNative = 0, compared = 0, mismatches = 0, unpriced = 0;
const unpricedModels = new Map();
const worst = [];

for (const file of sessionFiles(SESSIONS)) {
	files++;
	let currentModel = "";
	let text;
	try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
	for (const line of text.split("\n")) {
		if (!line) continue;
		let o;
		try { o = JSON.parse(line); } catch { continue; }
		if (o.type === "model_change" && o.modelId) currentModel = o.modelId;
		if (o.type !== "message") continue;
		const msg = o.message;
		if (!msg || msg.role !== "assistant") continue;
		const model = msg.model || currentModel || "";
		if (!model.toLowerCase().includes("deepseek")) continue;
		deepseekTurns++;

		// Pi's usage shape: input/output/cacheRead/cacheWrite/reasoning.
		const u = msg.usage || {};
		const usage = {
			input: u.input_tokens ?? u.input ?? 0,
			output: u.output_tokens ?? u.output ?? 0,
			cacheRead: u.cache_read_input_tokens ?? u.cacheRead ?? 0,
			cacheWrite: u.cache_creation_input_tokens ?? u.cacheWrite ?? 0,
			reasoning: u.reasoning_tokens ?? u.reasoning ?? 0,
		};
		const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.reasoning;
		const rawNative = u.cost?.total;
		const nativeCost = rawNative === undefined || rawNative === null ? null : rawNative;

		// wtft-parser's condition: a native cost wins unless it is 0 with tokens.
		if (nativeCost !== null && !(nativeCost === 0 && tokens > 0)) { usedPiNative++; continue; }
		if (tokens === 0) continue; // no cost to check either way

		const found = cardFor(model);
		if (!found) {
			unpriced++;
			unpricedModels.set(model, (unpricedModels.get(model) || 0) + 1);
			continue;
		}

		const rawTs = msg.timestamp || o.timestamp;
		const ts = typeof rawTs === "string" ? new Date(rawTs).getTime()
			: typeof rawTs === "number" ? rawTs : 0;

		const actual = calculateClaudeCost(model, {
			input_tokens: usage.input,
			output_tokens: usage.output,
			cache_creation_input_tokens: usage.cacheWrite,
			cache_read_input_tokens: usage.cacheRead,
			cache_creation: u.cache_creation || null,
			reasoning_tokens: usage.reasoning,
		}, Number.isNaN(ts) ? 0 : ts);

		const expected = expectedCost(found.entry, usage, Number.isNaN(ts) ? 0 : ts);
		compared++;
		const delta = Math.abs(actual - expected);
		if (delta > EPSILON) {
			mismatches++;
			if (worst.length < 5) worst.push({ file, model, timestamp: rawTs, expected, actual, delta });
		}
	}
}

// null, not 0, when nothing was compared (pr-review round 2). A percentage over
// an empty denominator is the exact figure this check exists to stop printing.
// ---
// SYNTHETIC MATRIX — the periods the corpus does not contain (#100).
//
// Every card transcribed above is only exercised by a turn that happens to fall
// in its window. The corpus has no undated DeepSeek turn and no vision-exp turn
// before 2026-08-16, so TWO transcription bugs sat here green: an undated turn
// priced from the oldest card instead of the standard row (11.6x on v4-pro),
// and a missing vision-exp window that would have reported 0.22 against wtft's
// 0.14. Both were found by a reviewer reading the diff, not by this check —
// which is the check's own gap, since it is the thing that exists to find them.
//
// So: fabricate one turn per (model, period) cell and compare the same two
// sides. This DOES import wtft-cost, and that is not the violation it looks
// like — the expected figure still comes from the hand-transcribed CARD above,
// exactly as it does for a corpus turn. The import supplies the ACTUAL side,
// which is the side it has always supplied.
const MATRIX_USAGE = { input: 1_000_000, output: 1_000_000, reasoning: 0, cacheRead: 1_000_000 };
const MATRIX_INSTANTS = [
	["undated", 0],
	["2026-07-15 (pre-2026-08-16)",  Date.UTC(2026, 6, 15, 12, 0, 0)],
	["2026-08-24 (pre-V4.1 Flash)",  Date.UTC(2026, 7, 24, 12, 0, 0)],
	["2026-09-11 (post-Flash, pre-pro reroute)", Date.UTC(2026, 8, 11, 12, 0, 0)],
	["2026-09-15 (post-pro reroute)", Date.UTC(2026, 8, 15, 12, 0, 0)],
	["2026-09-15 02:00Z (peak)",      Date.UTC(2026, 8, 15, 2, 0, 0)],
];

let matrixChecked = 0, matrixMismatches = 0;
const matrixFailures = [];
{
	// Uses the SAME `calculateClaudeCost` the corpus loop uses — the one imported
	// from bin/wtft.mjs at the top of this file. Two reasons, and the second is
	// the one that bit:
	//
	//   - A separate `await import(...wtft-cost.ts)` made the matrix OPTIONAL: a
	//     failed import left matrixMismatches at 0 and the run still exited 0, a
	//     false green for exactly the transcription bugs this matrix exists to
	//     catch, and against this script's own fail-closed rule (an empty corpus
	//     exits 1).
	//   - It also made the two halves compare against DIFFERENT BUILDS. The
	//     corpus half read the bundle, the matrix half read the source, so a
	//     stale bundle — precisely the state a repricing leaves the tree in until
	//     `bun run build` — would let the matrix pass against the new registry
	//     while the corpus reported against the old one, with no way to attribute
	//     a mismatch to either.
	//
	// One actual implementation, one verdict.
	for (const model of Object.keys(CARD)) {
		for (const [label, ts] of MATRIX_INSTANTS) {
			const expected = expectedCost(CARD[model], MATRIX_USAGE, ts);
			const actual = calculateClaudeCost(model, {
				input_tokens: MATRIX_USAGE.input,
				output_tokens: MATRIX_USAGE.output,
				cache_read_input_tokens: MATRIX_USAGE.cacheRead,
			}, ts);
			matrixChecked++;
			// A non-finite expected is a TRANSCRIPTION bug, not a rate
			// disagreement — an earlier version returned a card OBJECT here and
			// every comparison silently went NaN, which `NaN > EPSILON` reports
			// as agreement.
			if (!Number.isFinite(expected)) {
				matrixMismatches++;
				matrixFailures.push(`${model} @ ${label}: expected is not a number (${expected})`);
			} else if (Math.abs(actual - expected) > EPSILON) {
				matrixMismatches++;
				matrixFailures.push(`${model} @ ${label}: expected ${expected.toFixed(6)} actual ${actual.toFixed(6)}`);
			}
		}
	}
}

// Fail closed on a matrix that did not run. Every cell is fabricated here, so
// "zero cells" can only mean the loop was skipped — never "nothing to check".
const MATRIX_CELLS = Object.keys(CARD).length * MATRIX_INSTANTS.length;
const matrixRan = matrixChecked === MATRIX_CELLS;
if (!matrixRan) {
}


const mismatchPercent = compared === 0 ? null : (mismatches / compared) * 100;
const record = {
	schema: "wtft-research/pi-deepseek-corpus-check@1",
	sessionsDir: SESSIONS,
	files,
	deepseekTurns,
	usedPiNativeCost: usedPiNative,
	compared,
	mismatches,
	mismatchPercent: mismatchPercent === null ? null : Number(mismatchPercent.toFixed(4)),
	unpriced,
	unpricedModels: Object.fromEntries(unpricedModels),
	outOfScope: [
		"Claude Code transcripts (covered by #495's own Closer)",
		"whether the transcribed card matches DeepSeek's actual billing",
		"turns priced by Pi's native cost.total",
		"models with no transcribed card — counted as unpriced, never compared",
	],
	worst,
	// The synthetic matrix travels in the RECORD, not only on stdout (#100). An
	// earlier version printed it after the JSON document, which appended text to
	// valid JSON and made the whole `--json` contract unparseable — the exact
	// failure the Agent-First Output standard exists to prevent, in a script
	// whose output another program is meant to read. Suppressing the lines under
	// --json would have met the letter and missed the point: a consumer asking
	// for the machine-readable mode should SEE this verdict, not lose it.
	syntheticMatrix: {
		cells: matrixChecked,
		expectedCells: MATRIX_CELLS,
		ran: matrixRan,
		mismatches: matrixMismatches,
		failures: matrixFailures,
	},
	// FAILS CLOSED on an empty corpus (pr-review, round 1). `mismatches === 0`
	// alone reports a clean check when ~/.pi/agent/sessions is missing or
	// unreadable and nothing was examined at all — which is the same shape of
	// dishonesty as #495's Closer printing 0.0000% for a harness it never read.
	ok: mismatches === 0 && files > 0 && compared > 0
		&& matrixRan && matrixMismatches === 0,
};
// `emptyCorpus` states a fact about the CORPUS, so it is derived from the
// corpus and from nothing else. It used to be inferred — "ok is false and there
// were no mismatches, therefore nothing was examined" — which held only while a
// clean corpus was the ONLY way for ok to be true. #100 added a second reason
// for ok to be false (a synthetic-matrix mismatch), and the inference silently
// became wrong: a matrix-only failure reported "EMPTY CORPUS — nothing was
// examined" in the same document that said files: 2505, compared: 11397.
// Measured, on this corpus. An inferred flag acquires a new false case every
// time a new failure reason is added; a derived one cannot.
if (files === 0 || compared === 0) {
	record.emptyCorpus = true;
}

if (asJson) {
	console.log(JSON.stringify(record, null, 2));
} else {
	console.log(`Pi DeepSeek corpus check — ${SESSIONS}`);
	console.log(`  files                    ${files}`);
	console.log(`  deepseek turns           ${deepseekTurns}`);
	console.log(`  priced by Pi natively    ${usedPiNative}   (not checked here)`);
	console.log(`  compared against card    ${compared}`);
	console.log(`  unpriced (no card)       ${unpriced}   ${[...unpricedModels.keys()].join(", ") || "-"}`);
	console.log(`  mismatches               ${mismatches}  ${
		mismatchPercent === null ? "(no percentage — nothing was compared)" : `(${mismatchPercent.toFixed(4)}%)`}`);
	if (record.emptyCorpus) {
		console.log("");
		console.log(`  EMPTY CORPUS — nothing was examined. ${files === 0
			? `no .jsonl session files under ${SESSIONS}`
			: "session files exist but no DeepSeek turn reached calculateClaudeCost"}.`);
		console.log("  Exit 1: a check that read nothing is not a passing check.");
	}
	console.log("");
	console.log("  NOT checked by this run:");
	for (const s of record.outOfScope) console.log(`    - ${s}`);
	for (const w of worst) {
		console.log(`  MISMATCH ${w.model} @ ${w.timestamp}: expected ${w.expected} actual ${w.actual}`);
	}
	console.log("");
	console.log(`  synthetic matrix         ${matrixChecked} cells, ${matrixMismatches} mismatch(es)`);
	for (const f of matrixFailures) console.log(`    MISMATCH ${f}`);
	if (!matrixRan) {
		console.log(`  MATRIX DID NOT RUN — ${matrixChecked} cells, expected ${MATRIX_CELLS}.`);
		console.log("  Exit 1: a check that ran nothing is not a passing check.");
	}
}

// `record.ok` already folds in the matrix, so the exit code and the JSON
// document cannot disagree about the verdict.
process.exit(record.ok ? 0 : 1);

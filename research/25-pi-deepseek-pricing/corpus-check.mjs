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
const WEEKEND_OFFPEAK_FROM = Date.UTC(2026, 7, 23, 0, 0, 0);  // 2026-08-23T00:00:00Z
const PEAK_WINDOWS_UTC = [[60, 240], [360, 600]];             // 01:00–04:00, 06:00–10:00

const CARD = {
	"deepseek-v4-pro": {
		current: { input: 0.66, output: 1.98, cacheRead: 0.022 },
		before:  { input: 1.74, output: 3.48, cacheRead: 0.0145 },
	},
	"deepseek-v4-flash": {
		current: { input: 0.22, output: 0.66, cacheRead: 0.007 },
		before:  { input: 0.14, output: 0.28, cacheRead: 0.0028 },
	},
	// Released after the card change, so no `before` window exists for it.
	"deepseek-v4-flash-vision-exp": {
		current: { input: 0.22, output: 0.66, cacheRead: 0.007 },
		before:  null,
	},
};

/** Longest key first — "deepseek-v4-flash" is a substring of the vision key. */
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
	const rates = (entry.before && ts && ts < RATE_CARD_CHANGED_AT) ? entry.before : entry.current;
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
	// FAILS CLOSED on an empty corpus (pr-review, round 1). `mismatches === 0`
	// alone reports a clean check when ~/.pi/agent/sessions is missing or
	// unreadable and nothing was examined at all — which is the same shape of
	// dishonesty as #495's Closer printing 0.0000% for a harness it never read.
	ok: mismatches === 0 && files > 0 && compared > 0,
};
if (record.ok === false && mismatches === 0) {
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
}

process.exit(record.ok ? 0 : 1);

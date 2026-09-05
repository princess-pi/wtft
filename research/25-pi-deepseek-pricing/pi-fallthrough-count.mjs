#!/usr/bin/env node
/**
 * research/25-pi-deepseek-pricing/pi-fallthrough-count.mjs — #25 deliverable (1).
 *
 * How many of this host's Pi DeepSeek turns actually reach wtft's
 * `calculateClaudeCost`, versus how many use Pi's own per-turn cost?
 *
 * The answer decides how much of the rest of #25 matters. `wtft-parser.ts`
 * prefers a harness-native cost and falls through ONLY when that cost is 0
 * while tokens were consumed. If the fall-through were rare, wtft's DeepSeek
 * rate card would be near-decorative on Pi; if it is near-total, wtft is the
 * thing pricing every Pi DeepSeek session on this machine.
 *
 * Reads ~/.pi/agent/sessions read-only. Writes nothing. `--json` for the
 * machine-readable record.
 *
 * Measured 2026-09-04: 390 files, 14,276 DeepSeek turns, 11,923 (83.5%)
 * fall through. Re-run before quoting; the corpus grows every session.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSIONS = path.join(os.homedir(), ".pi", "agent", "sessions");
const asJson = process.argv.includes("--json");

function* sessionFiles(dir) {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* sessionFiles(full);
		else if (entry.name.endsWith(".jsonl")) yield full;
	}
}

const byModel = new Map();
let files = 0, turns = 0, fellThrough = 0, nativeUsed = 0;

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
		const m = o.message;
		if (!m || m.role !== "assistant") continue;
		const model = m.model || currentModel || "";
		if (!model.toLowerCase().includes("deepseek")) continue;

		const u = m.usage || {};
		// The same normalization wtft-parser's Pi adapter performs.
		const tokens =
			(u.input_tokens ?? u.input ?? 0) +
			(u.output_tokens ?? u.output ?? 0) +
			(u.cache_read_input_tokens ?? u.cacheRead ?? 0) +
			(u.cache_creation_input_tokens ?? u.cacheWrite ?? 0) +
			(u.reasoning_tokens ?? u.reasoning ?? 0);
		const rawNative = u.cost?.total;
		const nativeCost = rawNative === undefined || rawNative === null ? null : rawNative;

		// buildInteraction's exact condition.
		const usesNative = nativeCost !== null && !(nativeCost === 0 && tokens > 0);

		turns++;
		if (usesNative) nativeUsed++; else fellThrough++;

		const row = byModel.get(model) || { turns: 0, fellThrough: 0, nativeUsed: 0 };
		row.turns++;
		if (usesNative) row.nativeUsed++; else row.fellThrough++;
		byModel.set(model, row);
	}
}

const pct = (n, d) => (d === 0 ? 0 : (n / d) * 100);
const record = {
	schema: "wtft-research/pi-deepseek-fallthrough@1",
	sessionsDir: SESSIONS,
	files,
	deepseekTurns: turns,
	fellThroughToCalculateClaudeCost: fellThrough,
	usedPiNativeCost: nativeUsed,
	fallThroughPercent: Number(pct(fellThrough, turns).toFixed(2)),
	byModel: Object.fromEntries([...byModel].sort((a, b) => b[1].turns - a[1].turns)),
};

if (asJson) {
	console.log(JSON.stringify(record, null, 2));
} else {
	console.log(`files                 ${files}`);
	console.log(`deepseek turns        ${turns}`);
	console.log(`-> calculateClaudeCost ${fellThrough}  (${pct(fellThrough, turns).toFixed(2)}%)`);
	console.log(`-> Pi native cost      ${nativeUsed}  (${pct(nativeUsed, turns).toFixed(2)}%)`);
	console.log("");
	for (const [model, row] of Object.entries(record.byModel)) {
		console.log(`  ${model.padEnd(30)} turns ${String(row.turns).padStart(6)}  calc ${String(row.fellThrough).padStart(6)}  native ${String(row.nativeUsed).padStart(6)}`);
	}
}

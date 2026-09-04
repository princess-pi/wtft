#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @command tests/timeline-24h.ts — console renderer, NOT a test suite
 * @description Renders all 24 hours of the SURGE timeline for one model, so a
 *   human can eyeball clock-face placement and surge coloring. Deliberately NOT
 *   matched by tests/run.ts (its discovery glob is `*.test.ts`); run it by hand.
 *
 *   Model resolution, in order:
 *     1. `--model <id>` (or a positional id) — the surge schedule depends on
 *        the model: only DeepSeek ids surge.
 *     2. `$PI_MODEL` — Pi sets this for every shell command it runs, so inside
 *        a Pi session the current model resolves with no argument at all.
 *     3. `"unknown"` — renders all-green (no surge), which is the honest answer
 *        when the model cannot be known.
 *
 *   The surge windows are timezone-dependent (they are UTC windows mapped into
 *   local hours by getSurgeLocalHours). Default is host-local time; pass
 *   `--tz <IANA>` to override (e.g. `--tz UTC`, `--tz America/New_York`).
 *
 * @usage
 *   bun tests/timeline-24h.ts                    # current model via $PI_MODEL
 *   bun tests/timeline-24h.ts --model deepseek-v4-pro
 *   bun tests/timeline-24h.ts deepseek-v4-pro --tz UTC
 */

import { buildTimelineString, getSurgeLocalHours } from "../extensions/lib/wtft-renderer.ts";

const CLOCK_FACES = ["🕛","🕐","🕑","🕒","🕓","🕔","🕕","🕖","🕗","🕘","🕙","🕚"];

function printHelp(): void {
	console.log(`Usage: bun tests/timeline-24h.ts [--model <id>] [--tz <IANA>]
  --model, -m <id>   model id (defaults to $PI_MODEL, then "unknown")
  --tz, -t <IANA>    timezone for surge-window mapping (default: host local)
  --help, -h         this help`);
}

function parseArgs(argv: string[]): { model?: string; tz?: string } {
	const out: { model?: string; tz?: string } = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--model" || a === "-m") out.model = argv[++i];
		else if (a === "--tz" || a === "-t") out.tz = argv[++i];
		else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
		else if (!a.startsWith("-")) out.model = a; // positional model id
		else {
			console.error(`unknown flag: ${a}`);
			printHelp();
			process.exit(2);
		}
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const model = args.model ?? process.env.PI_MODEL ?? "unknown";
const isDeepSeek = model.toLowerCase().includes("deepseek");
const surgeHours = isDeepSeek ? getSurgeLocalHours(args.tz) : new Set<number>();

console.log(`model:        ${model}`);
console.log(`deepseek:     ${isDeepSeek ? "yes (surge applies)" : "no (all off-peak)"}`);
console.log(`timezone:     ${args.tz ?? "(host local)"}`);
console.log(`surge hours:  ${[...surgeHours].sort((a, b) => a - b).join(", ") || "(none)"}`);
console.log("");

for (let h = 0; h < 24; h++) {
	const raw = buildTimelineString(surgeHours, h);
	console.log(`  ${String(h).padStart(2, "0")}  ${CLOCK_FACES[h % 12]}  ${raw}`);
}

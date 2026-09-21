#!/usr/bin/env bun
/**
 * Renders all 24 hours of the SURGE timeline for one model, so a
 *   human can eyeball clock-face placement and surge coloring.
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
		if (a === "--model" || a === "-m") {
			const v = argv[i + 1];
			if (v === undefined || v.startsWith("-")) {
				console.error(`missing value for ${a}`);
				printHelp();
				process.exit(2);
			}
			out.model = v;
			i++;
		} else if (a === "--tz" || a === "-t") {
			const v = argv[i + 1];
			if (v === undefined || v.startsWith("-")) {
				console.error(`missing value for ${a}`);
				printHelp();
				process.exit(2);
			}
			out.tz = v;
			i++;
		} else if (a === "--help" || a === "-h") {
			printHelp();
			process.exit(0);
		} else if (!a.startsWith("-")) {
			out.model = a; // positional model id
		} else {
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

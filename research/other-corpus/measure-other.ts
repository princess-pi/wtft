/**
 * @package wtft
 * @module research/other-corpus/measure-other
 * @description Corpus measurement for the "other" bucket (#10/#11).
 *
 * Why: #10 and #11 each reason from ONE session. Before changing a classifier
 * we want the population shape — which categories the corpus lands in, and
 * which bash primary commands dominate "other" across both harnesses.
 *
 * Usage: bun research/other-corpus/measure-other.ts [--limit N] [--harness id]
 */
import * as fs from "node:fs";
import { execSync } from "node:child_process";
// deduplicateInteractions is NOT optional here (#106 review, High/reasoning).
// parseSessionFile returns RAW lines -- one Interaction per content block, the
// same message.id and usage repeated -- and summing those inflates cost ~1.8x.
// Worse for THIS measurement: duplicate blocks of one message classify
// differently (a text block reads `prompt`, its tool_use sibling reads
// `other`), so an undeduped split is not a scaled version of the truth, it is
// a different shape. The first cut of these scripts omitted it and the
// published percentages were wrong.
import { parseSessionFile, deduplicateInteractions, classifyInteraction, normalizeCommand } from "../../extensions/lib/wtft-parser.ts";

const args = process.argv.slice(2);
const limit = Number(args[args.indexOf("--limit") + 1]) || 400;
const only = args.includes("--harness") ? args[args.indexOf("--harness") + 1] : null;

function find(root: string): string[] {
	try {
		return execSync(`find ${root} -name '*.jsonl' -size +40k -newermt '-60 days'`, { encoding: "utf8", maxBuffer: 1e9 })
			.trim().split("\n").filter(Boolean);
	} catch { return []; }
}

const home = process.env.HOME!;
const sets: Record<string, string[]> = {
	"claude-code": find(`${home}/.claude/projects`),
	pi: find(`${home}/.pi/agent/sessions`),
};

for (const [harness, all] of Object.entries(sets)) {
	if (only && harness !== only) continue;
	const files = all.sort(() => Math.random() - 0.5).slice(0, limit);
	const byCat = new Map<string, { cost: number; n: number }>();
	const otherCmds = new Map<string, { cost: number; n: number }>();
	let total = 0, parsed = 0;
	for (const f of files) {
		let interactions;
		try { interactions = deduplicateInteractions(parseSessionFile(f)); } catch { continue; }
		parsed++;
		for (const i of interactions) {
			const cat = classifyInteraction(i);
			const b = byCat.get(cat) || { cost: 0, n: 0 };
			b.cost += i.cost; b.n++; byCat.set(cat, b);
			total += i.cost;
			if (cat !== "other") continue;
			for (const raw of i.commands) {
				const norm = normalizeCommand(raw);
				if (!norm) continue;
				const line = norm.split("\n").map(l => l.trim()).find(l => l && !l.startsWith("#"));
				if (!line) continue;
				const primary = line.split(" ")[0]!;
				const e = otherCmds.get(primary) || { cost: 0, n: 0 };
				e.cost += i.cost; e.n++; otherCmds.set(primary, e);
				break;
			}
		}
	}
	console.log(`\n===== ${harness}: ${parsed}/${files.length} sessions parsed, $${total.toFixed(2)} =====`);
	console.log("-- top-level categories --");
	for (const [c, v] of [...byCat.entries()].sort((a, b) => b[1].cost - a[1].cost))
		console.log(`${c.padEnd(12)} $${v.cost.toFixed(2).padStart(10)}  ${((v.cost / total) * 100).toFixed(1).padStart(5)}%  ${v.n} turns`);
	console.log("-- top 45 'other' primary commands --");
	for (const [c, v] of [...otherCmds.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 45))
		console.log(`${c.slice(0, 28).padEnd(30)} $${v.cost.toFixed(2).padStart(9)}  ${String(v.n).padStart(5)} calls`);
}

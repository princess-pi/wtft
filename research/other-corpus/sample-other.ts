/**
 * @package wtft
 * @module research/other-corpus/sample-other
 * @description Dump raw bash commands behind a given "other" primary token (#10/#11).
 * Usage: bun research/other-corpus/sample-other.ts <token> [<token>...] [--limit N] [--n 8]
 */
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

const argv = process.argv.slice(2);
const limit = Number(argv[argv.indexOf("--limit") + 1]) || 300;
const per = Number(argv[argv.indexOf("--n") + 1]) || 8;
const want = new Set(argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--limit" && argv[i - 1] !== "--n"));

const files = execSync(`find ${process.env.HOME}/.claude/projects -name '*.jsonl' -size +40k -newermt '-60 days'`, { encoding: "utf8", maxBuffer: 1e9 })
	.trim().split("\n").filter(Boolean).sort(() => Math.random() - 0.5).slice(0, limit);

const samples = new Map<string, string[]>();
for (const f of files) {
	let interactions; try { interactions = deduplicateInteractions(parseSessionFile(f)); } catch { continue; }
	for (const i of interactions) {
		if (classifyInteraction(i) !== "other") continue;
		for (const raw of i.commands) {
			const norm = normalizeCommand(raw);
			if (!norm) continue;
			const line = norm.split("\n").map(l => l.trim()).find(l => l && !l.startsWith("#"));
			if (!line) continue;
			const primary = line.split(" ")[0]!;
			if (want.has(primary)) {
				const arr = samples.get(primary) || [];
				if (arr.length < per) { arr.push(raw.slice(0, 300)); samples.set(primary, arr); }
			}
			break;
		}
	}
}
for (const [tok, arr] of samples) {
	console.log(`\n######## ${tok} ########`);
	arr.forEach((s, n) => console.log(`--- ${n + 1} ---\n${s}`));
}

/**
 * @package wtft
 * @module research/other-corpus/reclaim-estimate
 * @description Size each proposed "other"-reclaim rule against the corpus (#106).
 *
 * Why: #10 and #11 each propose a list of fixes from ONE session apiece. This
 * attributes every "other" dollar in a large corpus to the FIRST rule that would
 * have caught it, so the rules can be ordered by what they actually buy rather
 * than by what one transcript happened to contain.
 *
 * These rules are SKETCHES used to size the work — the shipped rules live in
 * `extensions/lib/wtft-parser.ts` and are covered by tests. Re-run this after the
 * fix to see what the residue is made of; do not quote a figure from it into
 * prose, because the draw is random.
 *
 * Usage: bun research/other-corpus/reclaim-estimate.ts [--limit N]
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

const WRAPPERS = /^(?:timeout\s+\S+|time|nice(?:\s+-n\s+\S+)?|nohup|command|sudo(?:\s+-\S+)*|env(?:\s+\w+=(?:"[^"]*"|'[^']*'|\S+))*|xargs(?:\s+-\S+)*)\s+/;
const GIT_WRAPPERS = /^(?:gh|pr-open|pr-submit|pr-watch|pr-threads|pr-cleanup|pr-merge|pr-reject|pr-review|pr-verdict|pr-guard|git-checkpoint|git-overview|git-snap|wt-new|iarts-mirror)\b/;
const READERS = /^(?:sed|cat|head|tail|less|more|bat|nl|tee|wc|awk|cut|diff|jq)\b/;
const INLINE = /^(?:python3?|node|bun|deno|perl|ruby)\s+(?:-\s*$|-\s|-c\b|-e\b|-\s*<<)/;
const TESTRUN = /^(?:bun\s+(?:test|run\s+test)|npm\s+(?:test|run\s+test)|pytest|jest|vitest|go\s+test|cargo\s+test|bash\s+tests?\/|\.?\/?tests?\/\S+\.(?:sh|ts|js|mjs))\b/;
const BUILDRUN = /^(?:bun\s+(?:build|run\s+(?:build|typecheck|lint))|npm\s+run\s+(?:build|typecheck|lint)|tsc\b|make\b|cargo\s+build|go\s+build)/;
const NOISE = /^(?:echo|printf|ls|pwd|sleep|date|mkdir|rm|cp|mv|touch|chmod|which|stat|file|wait)\b/;

/** Candidate normalizeCommand: newline/||/redirect-tolerant cd strip, $( ) values, wrappers. */
function norm2(cmd: string): string {
	let s = cmd.trim();
	for (let pass = 0; pass < 12; pass++) {
		const before = s;
		s = s.replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|\$\((?:[^()]|\([^()]*\))*\)|[^\s;&|]+)[ \t]*)+/, "");
		s = s.replace(/^(?:&&|\|\|?|;|\n)[\s\n]*/, "");
		s = s.replace(/^\\\s*\n\s*/, "");
		// cd <word|quoted|$( )> [redirects] then && ; || or a NEWLINE
		s = s.replace(/^cd[ \t]+(?:"[^"]*"|'[^']*'|\$\((?:[^()]|\([^()]*\))*\)|[^\s;&|]+)(?:[ \t]+\d?[<>]+[^\s;&|]+)*[ \t]*(?:&&|\|\||;|\n)[\s\n]*/, "");
		s = s.replace(WRAPPERS, "");
		if (s === before) break;
		s = s.trimStart();
	}
	return s.trim();
}

const files = execSync(`find ${process.env.HOME}/.claude/projects -name '*.jsonl' -size +40k -newermt '-60 days'`, { encoding: "utf8", maxBuffer: 1e9 })
	.trim().split("\n").filter(Boolean).sort(() => Math.random() - 0.5).slice(0, limit);

const rule = new Map<string, { cost: number; n: number }>();
let otherTotal = 0, sessionTotal = 0;
const add = (k: string, c: number) => { const e = rule.get(k) || { cost: 0, n: 0 }; e.cost += c; e.n++; rule.set(k, e); };

for (const f of files) {
	let ints; try { ints = deduplicateInteractions(parseSessionFile(f)); } catch { continue; }
	for (const i of ints) {
		sessionTotal += i.cost;
		if (classifyInteraction(i) !== "other") continue;
		otherTotal += i.cost;
		if (i.commands.length === 0) { add(i.unrecognizedTool ? "R0 unmapped-tool turn (no bash)" : "R0 no commands, no files", i.cost); continue; }
		const raws = i.commands.map(c => normalizeCommand(c));
		const cds = raws.map(r => norm2(r)).filter(Boolean);
		if (cds.length === 0) { add("R1 cd/var-strip to empty (pure cd)", i.cost); continue; }
		const first = cds[0]!.split("\n").map(l => l.trim()).find(l => l && !l.startsWith("#")) || cds[0]!;
		const oldFirst = raws.find(Boolean)?.split("\n").map(l => l.trim()).find(l => l && !l.startsWith("#")) || "";
		if (cds.some(c => GIT_WRAPPERS.test(c))) { add("R2 gh + pr-*/git-* wrappers to git", i.cost); continue; }
		if (TESTRUN.test(first)) { add("R3 test runner to tests", i.cost); continue; }
		if (BUILDRUN.test(first)) { add("R4 build/typecheck to code", i.cost); continue; }
		if (INLINE.test(first)) { add("R5 inline script by embedded path", i.cost); continue; }
		if (READERS.test(first)) { add("R6 file reader/writer by path", i.cost); continue; }
		if (/^(?:for|while|until|if|do|then|\{|\(|function|\w+\(\))/.test(first)) { add("R7 shell keyword/function, unwrap body", i.cost); continue; }
		if (!/^[A-Za-z_.~/]/.test(first)) { add("R8 parse miss (token is not a command)", i.cost); continue; }
		if (oldFirst !== first) { add("R9 caught only by improved cd/wrapper strip", i.cost); continue; }
		if (NOISE.test(first)) { add("RA shell noise, stays other", i.cost); continue; }
		add(`RZ still other: ${first.split(" ")[0]}`, i.cost);
	}
}

console.log(`corpus $${sessionTotal.toFixed(2)}, other $${otherTotal.toFixed(2)} (${(otherTotal / sessionTotal * 100).toFixed(1)}%)\n`);
const rows = [...rule.entries()].sort((a, b) => b[1].cost - a[1].cost);
for (const [k, v] of rows.filter(r => !r[0].startsWith("RZ")))
	console.log(`${k.padEnd(46)} $${v.cost.toFixed(2).padStart(9)}  ${(v.cost / otherTotal * 100).toFixed(1).padStart(5)}% of other  ${v.n} turns`);
const rest = rows.filter(r => r[0].startsWith("RZ"));
const restCost = rest.reduce((s, r) => s + r[1].cost, 0);
console.log(`${"RZ unmatched residue (top 20 below)".padEnd(46)} $${restCost.toFixed(2).padStart(9)}  ${(restCost / otherTotal * 100).toFixed(1).padStart(5)}% of other`);
for (const [k, v] of rest.slice(0, 20)) console.log(`      ${k.slice(3).padEnd(38)} $${v.cost.toFixed(2).padStart(8)}  ${v.n}`);

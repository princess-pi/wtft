/**
 * @package wtft
 * @module research/other-corpus/before-after
 * @description The measurement Amendment 4 of docs/spec-52-finer-grain-categories.md
 *   quotes (#106). Classifies one FIXED, DEDUPLICATED session list with two
 *   builds of the classifier and prints both splits side by side.
 *
 * Why this script exists rather than two runs of `measure-other.ts`: that one
 * samples at random per run, so a before/after pair from it compares different
 * sessions and the delta is partly the draw. #106 review round 2 called the
 * cited figures underivable from the committed code, correctly — this is the
 * script that derives them.
 *
 * Two invariants make the result checkable rather than merely plausible:
 *   - the session list is sorted and sliced, never shuffled, so two runs on an
 *     unchanged transcript directory select the same sessions;
 *   - the corpus TOTAL must be identical on both sides to the cent, EXCEPT for
 *     cost carried in by newly-discovered subagents. A reclassification moves
 *     money between categories and cannot change the total; subagent discovery
 *     legitimately ADDS cost that was previously invisible (#3/#138), so a
 *     delta is only acceptable when the two sides disagree about which subagent
 *     sessions they found. The script says which, so the reader can check.
 *
 * That second rule is not theoretical. It caught a real defect this branch
 * introduced: reading `cd /real 2>/dev/null || cd /tmp` as "last cd wins" sent
 * subagent discovery to /tmp, and $0.38 of a real subagent's cost disappeared
 * from a session total with every unit test still green.
 *
 * Usage:
 *   bun research/other-corpus/before-after.ts --before <path-to-other-checkout>
 *                                             [--sessions N]
 *
 * `--before` is a checkout of the build to compare against (e.g. the main
 * clone); this worktree is always the "after" side.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const argv = process.argv.slice(2);
const arg = (name: string) => {
	const i = argv.indexOf(name);
	return i === -1 ? null : argv[i + 1] ?? null;
};

const BEFORE = arg("--before");
const AFTER = path.resolve(import.meta.dirname, "..", "..");
const N = Number(arg("--sessions")) || 250;

if (!BEFORE) {
	console.error("usage: bun research/other-corpus/before-after.ts --before <checkout> [--sessions N]");
	console.error("  --before  a checkout of the build to compare against (e.g. the main clone)");
	process.exit(2);
}

/** Sorted, never shuffled — the same directory yields the same list. */
function pick(root: string, n: number): string[] {
	try {
		return execSync(`find ${root} -name '*.jsonl' -size +40k -newermt '-60 days'`, { encoding: "utf8", maxBuffer: 1e9 })
			.trim().split("\n").filter(Boolean).sort().slice(0, n);
	} catch { return []; }
}

/**
 * Copy the selected transcripts to a snapshot directory, and measure THAT.
 *
 * Without this, the two passes read the live files at different instants, and a
 * session still being written to grows between them — so the "after" side sees
 * turns the "before" side never saw, and the totals invariant below compares
 * two different corpora.
 *
 * Honest note on how this was arrived at: a $0.0379 difference on Claude Code
 * against an exactly-matching idle Pi corpus LOOKED like live appends, and this
 * snapshot was written on that theory. It was wrong — the snapshot reproduced
 * the same delta to the cent, which is what proved the difference was real and
 * sent the investigation to the `||` defect the header describes. The snapshot
 * stays because the confound is real and cheap to remove, not because it was
 * the explanation.
 */
function snapshot(files: string[], tag: string): string[] {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wtft-ab-${tag}-`));
	return files.map((f, n) => {
		// Keep the basename: discovery and session-id logic read it.
		const dest = path.join(dir, `${n}-${path.basename(f)}`);
		try { fs.copyFileSync(f, dest); return dest; } catch { return ""; }
	}).filter(Boolean);
}

const home = process.env.HOME!;
const sets: Record<string, string[]> = {
	"claude-code": snapshot(pick(path.join(home, ".claude", "projects"), N), "cc"),
	pi: snapshot(pick(path.join(home, ".pi", "agent", "sessions"), N), "pi"),
};

let mismatch = false;

for (const [harness, files] of Object.entries(sets)) {
	if (files.length === 0) { console.log(`\n===== ${harness}: no sessions found, skipped =====`); continue; }
	const side: Record<string, { by: Map<string, number>; tot: number; subagents: Set<string> }> = {};

	for (const [label, root] of [["BEFORE", BEFORE], ["AFTER", AFTER]] as const) {
		// Cache-busting query so both builds load as distinct modules.
		const mod = await import(`${root}/extensions/lib/wtft-parser.ts?${label}${harness}`);
		const by = new Map<string, number>();
		const subagents = new Set<string>();
		let tot = 0;
		for (const f of files) {
			let ints;
			try { ints = mod.deduplicateInteractions(mod.parseSessionFile(f)); } catch { continue; }
			for (const i of ints) {
				const c = mod.classifyInteraction(i);
				by.set(c, (by.get(c) || 0) + i.cost);
				tot += i.cost;
				for (const id of (i as any).claudeSubAgentSessionIds ?? []) subagents.add(id);
			}
		}
		side[label] = { by, tot, subagents };
	}

	const b = side.BEFORE!, a = side.AFTER!;
	const delta = a.tot - b.tot;
	const gained = [...a.subagents].filter(id => !b.subagents.has(id));
	const lost = [...b.subagents].filter(id => !a.subagents.has(id));
	// A delta is acceptable ONLY when the two sides found different subagents.
	const explained = gained.length > 0 || lost.length > 0;
	if (Math.abs(delta) > 0.005 && !explained) mismatch = true;

	console.log(`\n===== ${harness}: ${files.length} sessions =====`);
	console.log(`total  BEFORE $${b.tot.toFixed(2)}  AFTER $${a.tot.toFixed(2)}  delta $${delta.toFixed(4)}` +
		(Math.abs(delta) <= 0.005 ? "  (equal, as required)"
			: explained ? "  (explained by subagent discovery, below)"
			: "   <-- UNEXPLAINED; a reclassification cannot change the total"));
	if (gained.length) console.log(`  subagents found only AFTER  (cost recovered): ${gained.join(", ")}`);
	if (lost.length) console.log(`  subagents found only BEFORE (cost LOST — investigate): ${lost.join(", ")}`);
	for (const c of [...new Set([...b.by.keys(), ...a.by.keys()])]
		.sort((x, y) => (a.by.get(y) || 0) - (a.by.get(x) || 0))) {
		const bv = b.by.get(c) || 0, av = a.by.get(c) || 0;
		if (bv < 0.01 && av < 0.01) continue;
		console.log(`${c.padEnd(13)}$${bv.toFixed(2).padStart(9)} ${(bv / b.tot * 100).toFixed(1).padStart(5)}%  ->  $${av.toFixed(2).padStart(9)} ${(av / a.tot * 100).toFixed(1).padStart(5)}%`);
	}
}

process.exit(mismatch ? 1 : 0);

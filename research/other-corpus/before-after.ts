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
 * The frozen corpus is a projects-shaped tree, not a flat directory: each
 * selected transcript keeps its path relative to its harness's sessions root
 * (`<snap>/projects/...` for Claude Code, `<snap>/pi/...` for Pi), so a
 * discovered `claude -p` child transcript can be copied to the same relative
 * location its own root would place it at. Both BEFORE and AFTER parse the
 * live selection once before anything is copied — a discovery pass, then the
 * freeze — so a child only one build's classifier discovers is still in the
 * frozen corpus, and the gained/lost subagent check below can still fire on
 * it. Both measured passes then read the frozen tree through
 * `WTFT_CLAUDE_PROJECTS_DIR` (the #129 seam), never the live projects root —
 * a child transcript still being written between the two passes would
 * otherwise move the totals with no classifier change involved. `HOME` is not
 * the seam: bun caches `os.homedir()` at process start, so a fake `HOME` set
 * after the process is already running does not move `projectsDir()`'s
 * default.
 *
 * Usage:
 *   bun research/other-corpus/before-after.ts --before <path-to-other-checkout>
 *                                             [--sessions N]
 *
 * `--before` is a checkout of the build to compare against (e.g. the main
 * clone); this worktree is always the "after" side. Selection honours
 * `WTFT_CLAUDE_PROJECTS_DIR` / `WTFT_PI_SESSIONS_DIR` for the live roots to
 * pick from, so a test can point both at a fixture. Selection keeps the
 * `-size +40k -newermt '-60 days'` filter unconditionally — a fixture must
 * satisfy it (write files over 40 KB with a fresh mtime) rather than the
 * script relaxing it for tests.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface SubAgentBearing { claudeSubAgentFolds?: { id: string; file?: string }[]; claudeSubAgentSessionIds?: string[] }

/** Sorted, never shuffled — the same directory yields the same list. */
export function pickTranscripts(root: string, n: number): string[] {
	// A root that does not exist is a harness this host does not have; any
	// other failure, find's included, throws.
	try { fs.statSync(root); } catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	return execFileSync("find", [root, "-name", "*.jsonl", "-size", "+40k", "-newermt", "-60 days"], { encoding: "utf8", maxBuffer: 1e9 })
		.trim().split("\n").filter(Boolean).sort().slice(0, n);
}

/** Whether a checkout's Claude Code discovery honours `WTFT_CLAUDE_PROJECTS_DIR`
 *  as the measured pass sets it: in `process.env`, read with no argument (older
 *  builds take none). A build without it reads the live projects root, so the
 *  two sides would classify different corpora. A checkout that cannot be
 *  loaded throws: that is a bad `--before`, not an old build. */
export async function honoursProjectsSeam(checkout: string): Promise<boolean> {
	const mod = await import(`${checkout}/extensions/lib/harness/claude-code/discovery.ts?seam`);
	if (typeof mod.projectsDir !== "function") return false;
	const saved = process.env.WTFT_CLAUDE_PROJECTS_DIR;
	process.env.WTFT_CLAUDE_PROJECTS_DIR = "/seam-probe";
	try { return mod.projectsDir() === "/seam-probe"; }
	finally {
		if (saved === undefined) delete process.env.WTFT_CLAUDE_PROJECTS_DIR;
		else process.env.WTFT_CLAUDE_PROJECTS_DIR = saved;
	}
}

/** Every subagent transcript path folded into any of these interactions, at
 *  any depth — `claudeSubAgentFolds` is already flattened across depths, so a
 *  single pass over the top-level interactions names them all. An id an older
 *  build reports without a path is looked up through `resolve`. */
export function foldFilesOf(
	interactions: readonly SubAgentBearing[],
	resolve: (id: string) => string | null = () => null,
): string[] {
	const lookUp = (id: string): string[] => {
		const found = resolve(id);
		if (found === null) console.error(`before-after: no transcript found for subagent id ${id}, so it is not frozen`);
		return found === null ? [] : [found];
	};
	return interactions.flatMap(i => {
		if (!i.claudeSubAgentFolds) return (i.claudeSubAgentSessionIds ?? []).flatMap(lookUp);
		return i.claudeSubAgentFolds.flatMap(f => typeof f.file === "string" ? [f.file] : lookUp(f.id));
	});
}

/** The subagent ids these interactions report, from `claudeSubAgentFolds[].id`.
 *  Falls back to `claudeSubAgentSessionIds` per interaction for a BEFORE build
 *  old enough to carry only that field. */
export function subagentIdsOf(interactions: readonly SubAgentBearing[]): string[] {
	return interactions.flatMap(i =>
		i.claudeSubAgentFolds ? i.claudeSubAgentFolds.map(f => f.id) : (i.claudeSubAgentSessionIds ?? []));
}

/**
 * Copy the selected transcripts, plus every subagent file either build's
 * discovery pass named, into a projects-shaped snapshot directory, and
 * measure THAT.
 *
 * Without this, the passes read the live files at different instants, and a
 * session still being written to grows between them — so the "after" side
 * sees turns the "before" side never saw, and the totals invariant below
 * compares two different corpora.
 *
 * Honest note on how this was arrived at: a $0.0379 difference on Claude Code
 * against an exactly-matching idle Pi corpus LOOKED like live appends, and a
 * flat-copy snapshot was written on that theory. It was wrong — the snapshot
 * reproduced the same delta to the cent, which is what proved the difference
 * was real and sent the investigation to the `||` defect the header
 * describes. The snapshot stays because the confound is real and cheap to
 * remove, not because it was the explanation.
 */
export function snapshotCorpus(opts: {
	snapDir: string;
	ccRoot: string;
	piRoot: string;
	ccFiles: readonly string[];
	piFiles: readonly string[];
	foldFiles: readonly string[];
}): { projects: string; pi: string } {
	const projectsOut = path.join(opts.snapDir, "projects");
	const piOut = path.join(opts.snapDir, "pi");
	fs.mkdirSync(projectsOut, { recursive: true });
	fs.mkdirSync(piOut, { recursive: true });

	const copyUnder = (file: string, root: string, outRoot: string): void => {
		const rel = path.relative(root, file);
		if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
			console.error(`before-after: fold file outside its root, skipped: ${file}`);
			return;
		}
		const dest = path.join(outRoot, rel);
		try {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.copyFileSync(file, dest);
		} catch (err) {
			// Fatal: a file missing from the snapshot would be skipped by both
			// measured passes, and the comparison would certify a smaller corpus.
			throw new Error(`before-after: could not copy into the snapshot: ${file} (${err instanceof Error ? err.message : String(err)})`);
		}
	};

	for (const f of opts.foldFiles) copyUnder(f, opts.ccRoot, projectsOut);
	for (const f of opts.ccFiles) copyUnder(f, opts.ccRoot, projectsOut);
	for (const f of opts.piFiles) copyUnder(f, opts.piRoot, piOut);

	return { projects: projectsOut, pi: piOut };
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const arg = (name: string) => {
		const i = argv.indexOf(name);
		return i === -1 ? null : argv[i + 1] ?? null;
	};

	const beforeArg = arg("--before");
	// The import below resolves a relative specifier against this file, not the cwd.
	const BEFORE = beforeArg === null ? null : path.resolve(beforeArg);
	const AFTER = path.resolve(import.meta.dirname, "..", "..");
	const N = Number(arg("--sessions")) || 250;

	if (!BEFORE) {
		console.error("usage: bun research/other-corpus/before-after.ts --before <checkout> [--sessions N]");
		console.error("  --before  a checkout of the build to compare against (e.g. the main clone)");
		process.exit(2);
	}

	const home = process.env.HOME!;
	// Canonical, because the parser names fold files by their real path.
	const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
	const ccRoot = real(process.env.WTFT_CLAUDE_PROJECTS_DIR || path.join(home, ".claude", "projects"));
	const piRoot = real(process.env.WTFT_PI_SESSIONS_DIR || path.join(home, ".pi", "agent", "sessions"));

	const picked: Record<string, string[]> = {
		"claude-code": pickTranscripts(ccRoot, N),
		pi: pickTranscripts(piRoot, N),
	};

	if (!(await honoursProjectsSeam(BEFORE))) {
		console.error(`before-after: ${BEFORE} predates the WTFT_CLAUDE_PROJECTS_DIR seam, so its measured pass would read the live projects root, not the frozen corpus. Compare against a newer checkout.`);
		process.exit(2);
	}

	// Cache-busting query so both builds load as distinct modules.
	const modBEFORE = await import(`${BEFORE}/extensions/lib/wtft-parser.ts?BEFORE`);
	const modAFTER = await import(`${AFTER}/extensions/lib/wtft-parser.ts?AFTER`);

	// Discovery pass: both builds parse the LIVE selection once, with the real
	// projects root still in effect, before anything is frozen.
	const liveFiles = [...picked["claude-code"], ...picked.pi];
	// AFTER's resolver finds the transcript for an id an older build names without a path.
	const { makeSessionResolver } = await import(`${AFTER}/extensions/lib/wtft-spawn-tree.ts`);
	const resolveId: (id: string) => string | null = makeSessionResolver();
	const foldFiles = new Set<string>();
	for (const [label, mod] of [["BEFORE", modBEFORE], ["AFTER", modAFTER]] as const) {
		for (const f of liveFiles) {
			let parsed;
			try { parsed = mod.parseSessionFile(f); }
			catch (err) {
				console.error(`before-after: ${label}'s discovery parse failed, so the children only it would find are not frozen: ${f} (${err instanceof Error ? err.message : String(err)})`);
				continue;
			}
			// Canonical, like the roots, so a symlinked projects root does not read as "outside".
			for (const file of foldFilesOf(parsed, resolveId)) foldFiles.add(real(file));
		}
	}

	const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-ab-"));
	process.on("exit", () => fs.rmSync(snapDir, { recursive: true, force: true }));
	const { projects: snapProjects, pi: snapPi } = snapshotCorpus({
		snapDir, ccRoot, piRoot,
		ccFiles: picked["claude-code"], piFiles: picked.pi,
		foldFiles: [...foldFiles],
	});

	process.env.WTFT_CLAUDE_PROJECTS_DIR = snapProjects;

	const sets: Record<string, string[]> = {
		"claude-code": picked["claude-code"].map(f => path.join(snapProjects, path.relative(ccRoot, f))),
		pi: picked.pi.map(f => path.join(snapPi, path.relative(piRoot, f))),
	};

	let mismatch = false;

	for (const [harness, files] of Object.entries(sets)) {
		if (files.length === 0) { console.log(`\n===== ${harness}: no sessions found, skipped =====`); continue; }
		const side: Record<string, { by: Map<string, number>; tot: number; subagents: Set<string> }> = {};

		for (const [label, mod] of [["BEFORE", modBEFORE], ["AFTER", modAFTER]] as const) {
			const by = new Map<string, number>();
			const subagents = new Set<string>();
			let tot = 0;
			for (const f of files) {
				let ints;
				try { ints = mod.deduplicateInteractions(mod.parseSessionFile(f)); } catch { continue; }
				for (const id of subagentIdsOf(ints)) subagents.add(id);
				for (const i of ints) {
					const c = mod.classifyInteraction(i);
					by.set(c, (by.get(c) || 0) + i.cost);
					tot += i.cost;
				}
			}
			side[label] = { by, tot, subagents };
		}

		const b = side.BEFORE!, a = side.AFTER!;
		const delta = a.tot - b.tot;
		const gained = [...a.subagents].filter(id => !b.subagents.has(id));
		const lost = [...b.subagents].filter(id => !a.subagents.has(id));

		// THE TOTAL MAY RISE. IT MAY NEVER FALL. That is the whole rule, and it took
		// three tries to state it as one line instead of three interacting ones:
		//
		//   cut 1: `explained = gained || lost` — a loss excused ITSELF.
		//   cut 2: `explained = gained && !lost` — better, but the gate still only
		//          fired on `Math.abs(delta)`, so a corpus total that FELL while any
		//          new subagent was discovered came back "explained" and exited 0
		//          (#106 review round 4, High/reasoning). A regression that loses
		//          more than a new discovery adds was certified as fine.
		//
		// A reclassification cannot move a dollar; discovery can only ADD cost that
		// was previously invisible. So a negative delta has no legitimate cause, and
		// neither does a lost subagent id — each fails on its own, with no reference
		// to the other.
		if (delta < -0.005) mismatch = true;
		if (lost.length > 0) mismatch = true;
		// A RISE still needs a reason, and the only acceptable one is discovery.
		const explained = gained.length > 0;
		if (delta > 0.005 && !explained) mismatch = true;

		console.log(`\n===== ${harness}: ${files.length} sessions =====`);
		console.log(`total  BEFORE $${b.tot.toFixed(2)}  AFTER $${a.tot.toFixed(2)}  delta $${delta.toFixed(4)}` +
			(delta < -0.005 ? "   <-- TOTAL FELL; spend became invisible, which is never acceptable"
				: Math.abs(delta) <= 0.005 ? "  (equal, as required)"
				: explained ? "  (a RISE explained by subagent discovery, below)"
				: "   <-- UNEXPLAINED RISE; a reclassification cannot change the total"));
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
}

if (import.meta.main) await main();

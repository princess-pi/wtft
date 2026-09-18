#!/usr/bin/env -S bun
/**
 * tests/wtft-89-harness-order.test.ts — sticky, MRU harness ordering for the
 * scoped picker (#89, H1–H5). Spec: docs/spec-89-scoped-picker.md.
 *
 * Run: bun tests/wtft-89-harness-order.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { trackSandbox } from "./lib/sandbox";

import { mainCloneDir, readHarnessOrder, recordHarnessOpened, orderByHarness } from "../bin/wtft.mjs";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

function mktmp(prefix: string): string {
	return fs.realpathSync(trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), prefix))));
}

/** A real git repo with a main clone and one worktree, or null if git can't. */
function makeRepoWithWorktree(sandbox: string): { clone: string; worktree: string } | null {
	try {
		const clone = path.join(sandbox, "clone");
		fs.mkdirSync(clone, { recursive: true });
		const run = (dir: string, args: string[]) =>
			execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 });
		run(clone, ["init", "-q", "-b", "main"]);
		run(clone, ["config", "user.email", "t@example.com"]);
		run(clone, ["config", "user.name", "t"]);
		fs.writeFileSync(path.join(clone, "README"), "x\n");
		run(clone, ["add", "-A"]);
		run(clone, ["commit", "-qm", "init"]);
		// In-tree, exactly like wt-new: <clone>/.claude/worktrees/<branch>/ — so
		// the config walk-up from the worktree passes THROUGH the clone (H1/H2's
		// whole premise: no special-case code needed for a worktree to reach its
		// main clone's config).
		const worktree = path.join(clone, ".claude", "worktrees", "89-branch");
		run(clone, ["worktree", "add", "-q", "-b", "89-branch", worktree]);
		return { clone, worktree };
	} catch {
		return null;
	}
}

// ---
// H1/H2 — read and write both resolve the main clone through mainCloneDir.
// ---
console.log("\n=== H1/H2: read and write both target the main clone ===\n");
{
	const sandbox = mktmp("wtft-89-order-");
	const repo = makeRepoWithWorktree(sandbox);
	if (!repo) {
		console.log("  (skip: git worktree unusable in this environment)");
	} else {
		const originalCwd = process.cwd();
		const originalHome = process.env.HOME;
		const originalXdg = process.env.XDG_CONFIG_HOME;
		try {
			// Isolate config resolution entirely inside the sandbox — no real
			// ~/.config/wtft/config.json may be read or written by this suite
			// (CLAUDE.md: never touch the real ~/.claude or ~/.pi corpus, and by
			// extension never a real user's config either).
			process.env.HOME = sandbox;
			process.env.XDG_CONFIG_HOME = path.join(sandbox, "xdg-config");

			check(mainCloneDir(repo.worktree) === repo.clone,
				"H2: mainCloneDir resolves the MAIN clone from inside a worktree");
			check(mainCloneDir(repo.clone) === repo.clone,
				"H2: mainCloneDir resolves itself from the main clone");

			process.chdir(repo.worktree);
			check(readHarnessOrder().length === 0, "H1: no config file yet reads as an empty order");

			recordHarnessOpened("pi", repo.worktree);
			const afterOne = readHarnessOrder();
			check(afterOne[0] === "pi", `H2: opening 'pi' from the WORKTREE writes to the order (${afterOne.join(",")})`);

			const written = path.join(repo.clone, ".wtft", "config.json");
			check(fs.existsSync(written), "H2: the file lands at <main clone>/.wtft/config.json");
			const notInWorktree = path.join(repo.worktree, ".wtft", "config.json");
			check(!fs.existsSync(notInWorktree), "H2: …and NOT inside the worktree itself");

			recordHarnessOpened("claude-code", repo.worktree);
			const afterTwo = readHarnessOrder();
			check(afterTwo[0] === "claude-code" && afterTwo[1] === "pi",
				`H3: opening 'claude-code' moves it to the FRONT, 'pi' still recorded behind it (${afterTwo.join(",")})`);

			recordHarnessOpened("pi", repo.worktree);
			const afterReopen = readHarnessOrder();
			check(afterReopen.join(",") === "pi,claude-code",
				`H3: re-opening 'pi' moves it back to the front — MRU, not append (${afterReopen.join(",")})`);
		} finally {
			process.chdir(originalCwd);
			if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
			if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdg;
		}
	}
}

// ---
// H2 — best-effort: no repo, no git info -> the write is a silent no-op.
// ---
console.log("\n=== H2: best-effort when there is no main clone to write to ===\n");
{
	const plain = mktmp("wtft-89-noorder-");
	check(mainCloneDir(plain) === null, "H2: a non-repo directory resolves to no main clone");
	// Must not throw — this is the whole point of "best-effort".
	let threw = false;
	try { recordHarnessOpened("pi", plain); } catch { threw = true; }
	check(!threw, "H2: recordHarnessOpened on a non-repo cwd does not throw");
	check(!fs.existsSync(path.join(plain, ".wtft")), "H2: …and writes nothing there");
}

// ---
// H3/H4/H5 — grouping and ordering candidates.
// ---
console.log("\n=== H3-H5: orderByHarness groups, orders, and skips empties ===\n");
{
	const candidates = [
		{ harness: "claude-code", timestamp: 100 },
		{ harness: "pi", timestamp: 200 },
		{ harness: "claude-code", timestamp: 300 },
		{ harness: "pi", timestamp: 50 },
	];

	// No sticky order yet: registry order decides (H4).
	const noOrder = orderByHarness(candidates, [], ["claude-code", "pi"]);
	check(noOrder.every(c => c.harness === "claude-code") === false, "H3: sanity — mixed input");
	check(
		noOrder[0].harness === "claude-code" && noOrder[1].harness === "claude-code" &&
		noOrder[2].harness === "pi" && noOrder[3].harness === "pi",
		`H4: with no sticky order, harnesses fall back to registry order (${noOrder.map(c => c.harness).join(",")})`
	);
	check(noOrder[0].timestamp === 300 && noOrder[1].timestamp === 100,
		"H3: within a harness group, newest first");

	// Sticky order names pi first.
	const withOrder = orderByHarness(candidates, ["pi", "claude-code"], ["claude-code", "pi"]);
	check(withOrder[0].harness === "pi" && withOrder[2].harness === "claude-code",
		`H3: sticky order puts 'pi' first (${withOrder.map(c => c.harness).join(",")})`);

	// An unseen harness (not in `order`, not even in the registry list) still
	// appears, just last.
	const withUnknown = orderByHarness(
		[...candidates, { harness: "codex", timestamp: 999 }],
		["pi", "claude-code"],
		["claude-code", "pi"]
	);
	check(withUnknown[withUnknown.length - 1].harness === "codex",
		`H4: an unseen harness absent from both the order AND the registry list still goes last (${withUnknown.map(c => c.harness).join(",")})`);

	// H5 — a harness first in the order but with no candidates contributes no rows.
	const noPi = orderByHarness(
		candidates.filter(c => c.harness !== "pi"),
		["pi", "claude-code"],
		["claude-code", "pi"]
	);
	check(!noPi.some(c => c.harness === "pi"), "H5: a harness with zero candidates contributes zero rows");
	check(noPi.length === 2, `H5: …and nothing else is padded in to replace it (${noPi.length})`);

	// A DUPLICATE in `order` itself must not double-render a harness
	// (pr-review, Low).
	const dupOrder = orderByHarness(candidates, ["pi", "pi", "claude-code"], ["claude-code", "pi"]);
	check(dupOrder.filter(c => c.harness === "pi").length === 2,
		`orderByHarness: a duplicated id in the sticky order does not duplicate that harness's rows (${dupOrder.length} total rows for ${candidates.length} candidates)`);
}

// ---
// H2 (real fix) — readHarnessOrder(startDir) reads from the SAME directory
// recordHarnessOpened wrote to under --dir, not from process.cwd() (pr-review,
// Medium: before this, the two silently diverged whenever --dir differed from
// the launching shell's cwd).
// ---
console.log("\n=== H2: readHarnessOrder(startDir) matches recordHarnessOpened's --dir target ===\n");
{
	const sandbox = mktmp("wtft-89-order-dir-");
	const repo = makeRepoWithWorktree(sandbox);
	if (!repo) {
		console.log("  (skip: git worktree unusable)");
	} else {
		const originalCwd = process.cwd();
		const originalHome = process.env.HOME;
		const originalXdg = process.env.XDG_CONFIG_HOME;
		try {
			process.env.HOME = sandbox;
			process.env.XDG_CONFIG_HOME = path.join(sandbox, "xdg-config");

			// Stand somewhere else entirely — an unrelated directory outside the
			// repo — and record an --dir-style open against the worktree.
			const elsewhere = path.join(sandbox, "elsewhere");
			fs.mkdirSync(elsewhere, { recursive: true });
			process.chdir(elsewhere);

			check(readHarnessOrder().length === 0,
				"H2: from an unrelated cwd, the repo's sticky order is invisible with no startDir");

			recordHarnessOpened("pi", repo.worktree);
			check(readHarnessOrder().length === 0,
				"H2: …and stays invisible after the write, still with no startDir — proves the write went to the REPO, not here");
			check(readHarnessOrder(repo.worktree).join(",") === "pi",
				`H2: …but IS visible when readHarnessOrder is pointed at the same --dir target (${readHarnessOrder(repo.worktree).join(",")})`);

			// readHarnessOrder resolved through mainCloneDir here, so it must
			// leave process.cwd() untouched (its chdir fallback runs only
			// without git).
			check(process.cwd() === elsewhere || process.cwd() === fs.realpathSync(elsewhere),
				"H2: readHarnessOrder(startDir) leaves process.cwd() unchanged");
		} finally {
			process.chdir(originalCwd);
			if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
			if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdg;
		}
	}
}

// ---
// H2 (real fix) — recordHarnessOpened refuses to clobber a malformed config
// file rather than silently discarding its other settings (pr-review,
// Medium).
// ---
console.log("\n=== H2: recordHarnessOpened refuses to clobber malformed config ===\n");
{
	const sandbox = mktmp("wtft-89-order-malformed-");
	const repo = makeRepoWithWorktree(sandbox);
	if (!repo) {
		console.log("  (skip: git worktree unusable)");
	} else {
		const originalCwd = process.cwd();
		const originalHome = process.env.HOME;
		const originalXdg = process.env.XDG_CONFIG_HOME;
		try {
			process.env.HOME = sandbox;
			process.env.XDG_CONFIG_HOME = path.join(sandbox, "xdg-config");
			process.chdir(repo.worktree);

			const configPath = path.join(repo.clone, ".wtft", "config.json");
			fs.mkdirSync(path.dirname(configPath), { recursive: true });
			fs.writeFileSync(configPath, "{ this is not valid json");

			recordHarnessOpened("pi", repo.worktree);
			const stillBroken = fs.readFileSync(configPath, "utf8");
			check(stillBroken === "{ this is not valid json",
				"H2: a malformed config.json is left untouched, not overwritten with just { harnessOrder }");
		} finally {
			process.chdir(originalCwd);
			if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
			if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdg;
		}
	}
}

// ---
// H1/H2 (real fix, round 2) — an OUT-OF-TREE worktree (not nested under the
// clone at all, `worktrees.ts`'s second documented layout) reads its own
// sticky order correctly. The walk-up-based read this repo shipped in round
// 1 could never reach the clone's config.json from here — only a
// git-`mainCloneDir`-based read, which does not care where the worktree
// physically lives, can (pr-review round 2, Medium).
// ---
console.log("\n=== H1/H2: out-of-tree worktree reads its own repo's sticky order ===\n");
{
	const sandbox = mktmp("wtft-89-order-outoftree-");
	let outOfTree: { clone: string; worktree: string } | null = null;
	try {
		const clone = path.join(sandbox, "clone");
		fs.mkdirSync(clone, { recursive: true });
		const run = (dir: string, args: string[]) =>
			execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 });
		run(clone, ["init", "-q", "-b", "main"]);
		run(clone, ["config", "user.email", "t@example.com"]);
		run(clone, ["config", "user.name", "t"]);
		fs.writeFileSync(path.join(clone, "README"), "x\n");
		run(clone, ["add", "-A"]);
		run(clone, ["commit", "-qm", "init"]);
		// OUT-of-tree: a sibling of the clone, never nested under it — no
		// walk-up from here is textually "under" the clone.
		const worktree = path.join(sandbox, "worktrees", "89-branch");
		run(clone, ["worktree", "add", "-q", "-b", "89-out-branch", worktree]);
		outOfTree = { clone, worktree };
	} catch {
		outOfTree = null;
	}

	if (!outOfTree) {
		console.log("  (skip: git worktree unusable)");
	} else {
		const originalCwd = process.cwd();
		const originalHome = process.env.HOME;
		const originalXdg = process.env.XDG_CONFIG_HOME;
		try {
			process.env.HOME = sandbox;
			process.env.XDG_CONFIG_HOME = path.join(sandbox, "xdg-config");
			process.chdir(outOfTree.worktree);

			check(mainCloneDir(outOfTree.worktree) === outOfTree.clone,
				"H2: mainCloneDir resolves the clone from an OUT-OF-TREE worktree too (git-based, not path-based)");

			recordHarnessOpened("pi", outOfTree.worktree);
			check(readHarnessOrder(outOfTree.worktree).join(",") === "pi",
				`H1: readHarnessOrder sees the write from the out-of-tree worktree itself (${readHarnessOrder(outOfTree.worktree).join(",")})`);
			check(readHarnessOrder().join(",") === "pi",
				"H1: …and from process.cwd() standing right there, with no startDir needed");
		} finally {
			process.chdir(originalCwd);
			if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
			if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdg;
		}
	}
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

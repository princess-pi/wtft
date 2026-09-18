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
// H1/H2 — read via config walk-up, write targets the main clone.
// ---
console.log("\n=== H1/H2: read walk-up, write targets the main clone ===\n");
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

	// H5 — an empty harness group contributes no rows.
	const noPi = orderByHarness(
		candidates.filter(c => c.harness !== "pi"),
		["pi", "claude-code"],
		["claude-code", "pi"]
	);
	check(!noPi.some(c => c.harness === "pi"), "H5: a harness with zero candidates contributes zero rows");
	check(noPi.length === 2, `H5: …and nothing else is padded in to replace it (${noPi.length})`);
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

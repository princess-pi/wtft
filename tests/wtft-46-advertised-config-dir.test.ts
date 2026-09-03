#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test wtft-46-advertised-config-dir
 * @description `--help` never advertises the pre-rename config directory (#46).
 *
 *   FOUND BY A PARITY CHECK, not by reading. Closer 2 of #46 compares this
 *   repo's build against the princess-pi-tools build it is meant to replace,
 *   across both repos, the discovery path, the default path and the token
 *   surfaces. Every surface was byte-identical except one `--help` line: this
 *   repo told the reader to extend the pricing registry via
 *   `~/.config/princess-pi-packages/wtft-pricing.json`, a directory that does
 *   not exist on this host, while ppt had already corrected it (#560/#562).
 *
 *   WHY THE TEXT WAS WRONG (the code was fine). The resolvers used to read
 *   `princess-pi-tools` FIRST and fall back to `princess-pi-packages` only when
 *   it alone existed. That fallback was deleted with the one-time migration
 *   (princess-pi/wtft#51, decision 2). ADVERTISING it was wrong even before the
 *   deletion: a reader who followed `--help` created a directory nothing
 *   prefers.
 *
 *   So this suite pins two things, and only things a machine can settle. §1: no
 *   manifest string advertises a `~/.config/<legacy>/` path. §2: the resolvers,
 *   CALLED against a temp XDG_CONFIG_HOME, resolve to the advertised directory
 *   even when the old one is the only one present — the fallback is gone.
 *
 *   §2 replaced a check that compared where each name first appeared in the
 *   source text. Two review lenses rejected that independently: textual order is
 *   not execution order, and a comment saying the fallback was removed still
 *   contains the word. It could pass on broken code and fail on correct code.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getHarnessConfigPath, getUserPricingPath } from "../bin/wtft.mjs";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("46-advertised-config-dir");

const RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function check(ok: boolean, label: string, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n       ${detail}` : ""}`); failed++; }
}

const REPO = path.resolve(import.meta.dirname, "..");
const LEGACY = "princess-pi-packages";
const CURRENT = "princess-pi-tools";

console.log("\n1. No manifest string advertises a config path under the pre-rename directory");
{
	const dir = path.join(REPO, "docs", "manifests");
	const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
	check(files.length > 0, `found ${files.length} manifest(s)`, dir);

	// A CONFIG PATH, not any mention. The manifests also carry sample session
	// output with `~/g-p/princess-pi-packages/...` in it — those are examples of
	// a repo name in a path the tool once rendered, not instructions, and
	// rewriting them would falsify the example rather than fix anything. The
	// pattern is deliberately anchored on `.config/`.
	const CONFIG_PATH = new RegExp(String.raw`\.config/${LEGACY}/`, "g");
	for (const f of files) {
		const raw = fs.readFileSync(path.join(dir, f), "utf8");
		const hits = [...raw.matchAll(CONFIG_PATH)];
		check(hits.length === 0, `${f} advertises no ~/.config/${LEGACY}/ path`,
			hits.length ? `${hits.length} occurrence(s)` : undefined);
	}
}

console.log("\n2. The directory it advertises is the one the resolvers actually prefer");
{
	const manifest = fs.readFileSync(path.join(REPO, "docs", "manifests", "wtft-cmd.json"), "utf8");
	check(manifest.includes(`.config/${CURRENT}/wtft-pricing.json`),
		`the pricing override is advertised under ${CURRENT}`);

	// CALL THE RESOLVERS, do not read their source. The first version of this
	// block compared `src.indexOf(CURRENT)` against `src.indexOf(LEGACY)` and
	// asserted the current name appeared first — textual position as a proxy for
	// runtime precedence. Two review lenses rejected it independently, and both
	// were right: a comment or import mentioning either name flips the result
	// with no behaviour change, and a comment saying the fallback was REMOVED
	// still contains the word, so the check passes on code that lost it. A test
	// that can pass on broken code and fail on correct code enforces nothing.
	//
	// These call the real functions against a temp XDG_CONFIG_HOME, which is
	// what the resolvers read. `tests/run.ts` already gives every suite a fresh
	// one, so nothing here can see or touch a developer's real config.
	const saved = process.env.XDG_CONFIG_HOME;
	try {
		for (const [label, resolve, basename] of [
			["harness config", getHarnessConfigPath, "wtft-harnesses.json"],
			["user pricing", getUserPricingPath, "wtft-pricing.json"],
		] as const) {
			// (a) Neither directory present: the CURRENT path is what it names,
			//     so a first-time writer is told where the file should go.
			const bare = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-46-cfg-")));
			process.env.XDG_CONFIG_HOME = bare;
			check(resolve() === path.join(bare, CURRENT, basename),
				`V2a ${label}: with neither directory, it resolves to ${CURRENT}`, resolve());

			// (b) ONLY the legacy directory: the fallback is deleted, so the
			//     resolver still names CURRENT.
			const legacyOnly = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-46-cfg-")));
			fs.mkdirSync(path.join(legacyOnly, LEGACY), { recursive: true });
			fs.writeFileSync(path.join(legacyOnly, LEGACY, basename), "{}");
			process.env.XDG_CONFIG_HOME = legacyOnly;
			check(resolve() === path.join(legacyOnly, CURRENT, basename),
				`V2b ${label}: with only ${LEGACY}, it still resolves to ${CURRENT}`, resolve());

			// (c) BOTH present: current wins.
			const both = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-46-cfg-")));
			for (const d of [CURRENT, LEGACY]) {
				fs.mkdirSync(path.join(both, d), { recursive: true });
				fs.writeFileSync(path.join(both, d, basename), "{}");
			}
			process.env.XDG_CONFIG_HOME = both;
			check(resolve() === path.join(both, CURRENT, basename),
				`V2c ${label}: with both present, ${CURRENT} wins`, resolve());
		}
	} finally {
		if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = saved;
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

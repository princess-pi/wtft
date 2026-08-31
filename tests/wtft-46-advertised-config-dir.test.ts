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
 *   WHY THE CODE WAS FINE AND THE TEXT WAS NOT. `readUserPricing` and the
 *   harness registry read `princess-pi-tools` FIRST and fall back to
 *   `princess-pi-packages` only when it alone exists. That fallback is correct
 *   and stays. What is not correct is ADVERTISING the fallback: a reader who
 *   follows `--help` creates a directory nothing prefers, then wonders why the
 *   override is ignored the moment the current one appears.
 *
 *   So the rule this suite pins is narrow and mechanical: the legacy name may
 *   appear in CODE (as a fallback) and in TESTS (which exercise it), never in a
 *   user-facing manifest string. That is checkable; "keep the docs current" is
 *   not.
 */

import * as fs from "node:fs";
import * as path from "node:path";

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

console.log("\n2. The directory it does advertise is the one the resolvers prefer");
{
	const manifest = fs.readFileSync(path.join(REPO, "docs", "manifests", "wtft-cmd.json"), "utf8");
	check(manifest.includes(`.config/${CURRENT}/wtft-pricing.json`),
		`the pricing override is advertised under ${CURRENT}`);

	// And the fallback is still IN THE CODE, which is the half that must not be
	// "fixed" by a search-and-replace: deleting it would strand anyone who still
	// has only the old directory.
	for (const rel of ["extensions/lib/wtft-pricing-config.ts", "extensions/lib/harness/registry.ts"]) {
		const src = fs.readFileSync(path.join(REPO, rel), "utf8");
		const legacyIdx = src.indexOf(LEGACY), currentIdx = src.indexOf(CURRENT);
		check(legacyIdx !== -1 && currentIdx !== -1 && currentIdx < legacyIdx,
			`${rel} reads ${CURRENT} first and still falls back to ${LEGACY}`,
			`current@${currentIdx} legacy@${legacyIdx}`);
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

#!/usr/bin/env bun
/**
 * `--help` never advertises a legacy config directory (#46, #156).
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
// Two legacy generations, oldest first. #156 retired `princess-pi-tools`
// itself — the directory #46 once called CURRENT is now also legacy.
const LEGACIES = ["princess-pi-packages", "princess-pi-tools"];
const CURRENT = "wtft";

console.log("\n1. No manifest string advertises a config path under either legacy directory");
{
	const dir = path.join(REPO, "docs", "manifests");
	const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
	check(files.length > 0, `found ${files.length} manifest(s)`, dir);

	// A CONFIG PATH, not any mention. The manifests also carry sample session
	// output with `~/g-p/princess-pi-packages/...` and `~/g-p/princess-pi-tools/...`
	// in them — those are examples of a repo name in a path the tool once
	// rendered, not instructions, and rewriting them would falsify the example
	// rather than fix anything. The pattern is deliberately anchored on
	// `.config/`.
	for (const legacy of LEGACIES) {
		const CONFIG_PATH = new RegExp(String.raw`\.config/${legacy}/`, "g");
		for (const f of files) {
			const raw = fs.readFileSync(path.join(dir, f), "utf8");
			const hits = [...raw.matchAll(CONFIG_PATH)];
			check(hits.length === 0, `${f} advertises no ~/.config/${legacy}/ path`,
				hits.length ? `${hits.length} occurrence(s)` : undefined);
		}
	}
}

console.log("\n2. The directory it advertises is the one the resolvers actually prefer");
{
	const manifest = fs.readFileSync(path.join(REPO, "docs", "manifests", "wtft-cmd.json"), "utf8");
	check(manifest.includes(`.config/${CURRENT}/pricing.json`),
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
		for (const [label, resolve, currentBasename, legacyBasenames] of [
			["harness config", getHarnessConfigPath, "harnesses.json", "wtft-harnesses.json"],
			["user pricing", getUserPricingPath, "pricing.json", "wtft-pricing.json"],
		] as const) {
			// (a) No directory present: the CURRENT path is what it names, so a
			//     first-time writer is told where the file should go.
			const bare = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-46-cfg-")));
			process.env.XDG_CONFIG_HOME = bare;
			check(resolve() === path.join(bare, CURRENT, currentBasename),
				`V2a ${label}: with no directory present, it resolves to ${CURRENT}`, resolve());

			// (b) ONLY a legacy directory, for each generation: no fallback, the
			//     resolver still names CURRENT. Both legacy generations used the
			//     same basename — only the directory name moved, at #46 and again
			//     at #156.
			for (const legacy of LEGACIES) {
				const legacyOnly = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-46-cfg-")));
				fs.mkdirSync(path.join(legacyOnly, legacy), { recursive: true });
				fs.writeFileSync(path.join(legacyOnly, legacy, legacyBasenames), "{}");
				process.env.XDG_CONFIG_HOME = legacyOnly;
				check(resolve() === path.join(legacyOnly, CURRENT, currentBasename),
					`V2b ${label}: with only ${legacy} present, it still resolves to ${CURRENT}`, resolve());
			}

			// (c) Both legacy generations AND current present: current wins.
			const both = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-46-cfg-")));
			fs.mkdirSync(path.join(both, CURRENT), { recursive: true });
			fs.writeFileSync(path.join(both, CURRENT, currentBasename), "{}");
			for (const legacy of LEGACIES) {
				fs.mkdirSync(path.join(both, legacy), { recursive: true });
				fs.writeFileSync(path.join(both, legacy, legacyBasenames), "{}");
			}
			process.env.XDG_CONFIG_HOME = both;
			check(resolve() === path.join(both, CURRENT, currentBasename),
				`V2c ${label}: with every generation present, ${CURRENT} wins`, resolve());
		}
	} finally {
		if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = saved;
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

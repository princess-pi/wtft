#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test wtft-own-config-dir
 * @description wtft reads and writes its own config, not princess-pi-tools's.
 *
 *   1. No source file under extensions/ or bin/ builds a config PATH out of
 *      "princess-pi-tools" (textual scan, allowlisted for provenance tags and
 *      unrelated example paths that legitimately still name the string).
 *   2. An XDG fixture reads wtft/config.json and ignores a
 *      princess-pi-tools/wtft.json sitting right beside it — no fallback.
 *   3. Walk-up finds `<fixture>/.wtft/config.json` from a subdirectory.
 *   4. The pricing and harness registry resolvers land under wtft/ too.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";

const RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function check(ok: boolean, label: string, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n       ${detail}` : ""}`); failed++; }
}

const REPO = path.resolve(import.meta.dirname, "..");

// ---
// 1. No config-path hit for "princess-pi-tools" in extensions/ or bin/ (*.ts)
// ---
console.log("\n1. rg 'princess-pi-tools' extensions bin -g '*.ts' returns no config-path hits");
{
	// A pure-JS walk, not a shelled `rg`: this suite runs wherever `bun test`
	// runs, and a source scan should not gain a new binary dependency to prove
	// a fact about the source tree itself.
	function walk(dir: string, out: string[] = []): string[] {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full, out);
			else if (entry.name.endsWith(".ts")) out.push(full);
		}
		return out;
	}
	const files = [...walk(path.join(REPO, "extensions")), ...walk(path.join(REPO, "bin"))];
	check(files.length > 20, `found ${files.length} .ts files to scan`);

	// Every surviving mention of "princess-pi-tools" must be one of:
	//   - a `@package princess-pi-tools` provenance tag (unrelated to #156 —
	//     a repo-wide holdover from the pre-extraction naming, #584)
	//   - this suite's own header, or wtft-config-dir.ts's header, which name
	//     the retired string to document that it is retired
	//   - harness/types.ts's example `displayPath`, illustrating a cwd INSIDE
	//     the princess-pi-tools clone — a repo name in a path the tool once
	//     rendered, not a config location
	//   - a `princess-pi-tools#N` ISSUE reference, or a `princess-pi-tools/
	//     research/...` DOC path in the origin repo — neither is a config
	//     location this repo reads or writes
	//   - the `getUserPricingPath`/`getHarnessConfigPath` docstrings' own
	//     "not princess-pi-tools's" clause, explaining what changed
	const ALLOW = [
		/@package princess-pi-tools/,
		/g-p\/princess-pi-tools\//, // example displayPath, harness/types.ts
		/princess-pi-tools#\d+/, // issue reference
		/princess-pi-tools\/research\//, // doc path in the origin repo
		/princess-pi-tools's\)/, // "not princess-pi-tools's)" docstring clause
	];
	const hits: string[] = [];
	for (const file of files) {
		if (path.basename(file) === "wtft-config-dir.ts") continue; // this file's own explanatory comment
		const lines = fs.readFileSync(file, "utf8").split("\n");
		lines.forEach((line, i) => {
			if (!line.includes("princess-pi-tools")) return;
			if (ALLOW.some(re => re.test(line))) return;
			hits.push(`${path.relative(REPO, file)}:${i + 1}: ${line.trim()}`);
		});
	}
	check(hits.length === 0, "no config-path hit for princess-pi-tools remains", hits.join("\n"));
}

// ---
// 2. XDG fixture: reads wtft/config.json, ignores princess-pi-tools/wtft.json
// ---
console.log("\n2. An XDG fixture reads wtft/config.json and ignores princess-pi-tools/wtft.json beside it");
{
	const fixture = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-owncfg-xdg-")));
	const prevXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = path.join(fixture, ".config");

	// The decoy: the OLD path, with a value that would fail the assertion
	// below if it were read.
	const oldDir = path.join(fixture, ".config", "princess-pi-tools");
	fs.mkdirSync(oldDir, { recursive: true });
	fs.writeFileSync(path.join(oldDir, "wtft.json"), JSON.stringify({ disabledEmoji: false }));

	// The real path.
	const newDir = path.join(fixture, ".config", "wtft");
	fs.mkdirSync(newDir, { recursive: true });
	fs.writeFileSync(path.join(newDir, "config.json"), JSON.stringify({ disabledEmoji: true }));

	const { isEmojiDisabled } = await import("../extensions/lib/wtft-cli-shared.ts");
	check(isEmojiDisabled() === true,
		"isEmojiDisabled() reads wtft/config.json, not princess-pi-tools/wtft.json",
		`got ${isEmojiDisabled()}`);

	if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = prevXdg;
}

// ---
// 3. Walk-up finds <fixture>/.wtft/config.json from a subdirectory
// ---
console.log("\n3. Walk-up finds .wtft/config.json from a subdirectory");
{
	const fixture = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-owncfg-walkup-")));
	const prevXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = path.join(fixture, ".config"); // empty — nothing global to confuse this

	const projectRoot = path.join(fixture, "project");
	const sub = path.join(projectRoot, "deep", "sub");
	fs.mkdirSync(sub, { recursive: true });
	fs.mkdirSync(path.join(projectRoot, ".wtft"), { recursive: true });
	fs.writeFileSync(path.join(projectRoot, ".wtft", "config.json"), JSON.stringify({ disabledEmoji: true }));

	const originalCwd = process.cwd();
	process.chdir(sub);
	try {
		// Same import as §2, re-used rather than cache-busted: `loadConfig`
		// reads `process.cwd()` and `$XDG_CONFIG_HOME` live on every call —
		// nothing here is decided at import time.
		const { isEmojiDisabled } = await import("../extensions/lib/wtft-cli-shared.ts");
		check(isEmojiDisabled() === true,
			"isEmojiDisabled() finds .wtft/config.json by walking up from a subdirectory",
			`got ${isEmojiDisabled()}`);
	} finally {
		process.chdir(originalCwd);
		if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = prevXdg;
	}
}

// ---
// 4. Pricing and harness registry resolvers land under wtft/ too
// ---
console.log("\n4. getUserPricingPath and getHarnessConfigPath resolve under wtft/");
{
	const fixture = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-owncfg-resolvers-")));
	const prevXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = fixture;

	const { getUserPricingPath } = await import("../extensions/lib/wtft-pricing-config.ts");
	const { getHarnessConfigPath } = await import("../extensions/lib/harness/registry.ts");

	check(getUserPricingPath() === path.join(fixture, "wtft", "pricing.json"),
		"getUserPricingPath() resolves to <XDG>/wtft/pricing.json", getUserPricingPath());
	check(getHarnessConfigPath() === path.join(fixture, "wtft", "harnesses.json"),
		"getHarnessConfigPath() resolves to <XDG>/wtft/harnesses.json", getHarnessConfigPath());

	if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = prevXdg;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

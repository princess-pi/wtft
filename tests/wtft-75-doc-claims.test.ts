#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test wtft-75-doc-claims
 * @description Four doc claims that the #32 audit found contradicting the code
 *   (#75), each pinned against the code it describes so it cannot drift back:
 *
 *   1. Every flag a README `wtft …` example names is one `parseWtftCliArgs`
 *      accepts. The audit found `wtft --history`, a flag that never existed;
 *      a reader copying it got an unknown-flag error.
 *   2. `docs/spec-159-pack-and-smoke.md` names every entry of `package.json`
 *      `files`. It said "the two bundles — the whole `files` allowlist" while
 *      `files` had four entries and the spec's own suite asserted all four.
 *   3. `CONTEXT.md`'s Pager entry and `bin/wtft.ts`'s refusal agree on which
 *      harness has the pager. The glossary said CLI-only; the CLI said Pi-only.
 *   4. The README's `install-wtft` exit-code list carries every code the
 *      script can exit with, read from the script's own `exit N` / `EXIT=N`
 *      sites.
 *
 *   These read source files, not built output, so the suite needs no build and
 *   no session corpus. The flag set in (1) is derived from the parser's own
 *   `arg === "--x"` literals rather than from the manifest, because the
 *   manifest is prose for `--help` and the parser is what rejects a flag.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = path.resolve(import.meta.dir, "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
/** Source with `//` and block comments removed, so a literal quoted in prose does not count. */
const stripTsComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
/** Shell source with `#` comment lines removed (a `#` mid-line is left alone: it may be in a string). */
const stripShComments = (src: string) => src.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");

const RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function check(ok: boolean, label: string, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n       ${detail}` : ""}`); failed++; }
}

// ---
// 1. README `wtft` examples name only flags the parser accepts.
// ---
console.log("\n1. README wtft examples name real flags");
{
	const parser = stripTsComments(read("extensions/lib/wtft-cli-shared.ts"));
	const accepted = new Set<string>();
	for (const m of parser.matchAll(/arg === "(-{1,2}[A-Za-z][\w-]*)"/g)) accepted.add(m[1]);
	for (const m of parser.matchAll(/arg\.startsWith\("(--[\w-]+)="\)/g)) accepted.add(m[1]);
	check(accepted.size > 20, `parser exposes a flag set to compare against (${accepted.size} literals)`);

	const readme = read("README.md");
	const blocks = [...readme.matchAll(/```sh\n([\s\S]*?)```/g)].map(m => m[1]);
	const named: string[] = [];
	for (const block of blocks) {
		for (const line of block.split("\n")) {
			const t = line.trim();
			if (!t.startsWith("wtft ")) continue;
			for (const tok of t.split(/\s+/).slice(1)) {
				if (tok.startsWith("-")) named.push(tok.replace(/=.*$/, ""));
			}
		}
	}
	check(named.length > 0, `README has wtft examples with flags (${named.length} flag tokens)`);
	const unknown = named.filter(f => !accepted.has(f));
	check(unknown.length === 0, "every README wtft flag is accepted by parseWtftCliArgs",
		unknown.length ? `not in parser: ${unknown.join(", ")}` : undefined);

	// The closer names the manifest too: it is what `--help` and `--why` render
	// from, so a README example naming a flag the manifest omits documents
	// something `--help` would deny. Flags are found in the manifest's strings.
	const manifest = read("docs/manifests/wtft-cmd.json");
	const inManifest = new Set([...manifest.matchAll(/(?<![\w-])(-{1,2}[A-Za-z][\w-]*)/g)].map(m => m[1]));
	const undocumented = named.filter(f => !inManifest.has(f));
	check(undocumented.length === 0, "every README wtft flag is named in docs/manifests/wtft-cmd.json",
		undocumented.length ? `not in manifest: ${undocumented.join(", ")}` : undefined);
}

// ---
// 2. spec-159 names every `files` entry.
// ---
console.log("\n2. spec-159 names the whole files allowlist");
{
	const files: string[] = JSON.parse(read("package.json")).files;
	const spec = read("docs/spec-159-pack-and-smoke.md");
	check(files.length === 4, `package.json files has four entries (${files.length})`);
	const missing = files.filter(f => !spec.includes(f));
	check(missing.length === 0, "spec-159 names every files entry",
		missing.length ? `absent from spec: ${missing.join(", ")}` : undefined);
	check(!/two bundles[\s\S]{0,160}the whole `files` allowlist/.test(spec),
		"spec-159 no longer calls two bundles the whole allowlist");
	check(/four-entry `files` allowlist/.test(spec),
		"spec-159 states the allowlist count, and it is four");
	check(!/NOT delivered by any npm channel/.test(spec),
		"spec-159 no longer says the Pi extensions ship via no npm channel");
}

// ---
// 3. CONTEXT.md Pager entry agrees with bin/wtft.ts.
// ---
console.log("\n3. CONTEXT.md pager entry agrees with the CLI");
{
	const ctx = read("CONTEXT.md");
	const m = ctx.match(/\*\*Pager\*\*:\n([\s\S]*?)\n_Avoid_/);
	check(!!m, "CONTEXT.md has a Pager entry");
	const entry = m ? m[1] : "";
	const cli = read("bin/wtft.ts");
	check(/-p\/--pager is a Pi TUI overlay and is not available in the CLI/.test(cli),
		"bin/wtft.ts refuses -p as a Pi TUI overlay not available in the CLI");
	check(!/CLI-only/.test(entry), "Pager entry does not call the pager CLI-only");
	check(/Pi/.test(entry) && /not\s+available\s+in the CLI/.test(entry),
		"Pager entry says it is a Pi overlay not available in the CLI",
		`entry: ${entry.replace(/\n/g, " ")}`);
}

// ---
// 4. README's install-wtft exit codes match the script.
// ---
console.log("\n4. README install-wtft exit codes match the script");
{
	const script = stripShComments(read("bin/install-wtft"));
	const codes = new Set<string>();
	for (const m of script.matchAll(/\bexit (\d+)\b/g)) codes.add(m[1]);
	for (const m of script.matchAll(/\bEXIT=(\d+)\b/g)) codes.add(m[1]);
	const readme = read("README.md");
	const section = readme.slice(readme.indexOf("## Install"), readme.indexOf("## What CI gates"));
	const bold = new Set([...section.matchAll(/\*\*(\d+)\*\*/g)].map(m => m[1]));
	const missing = [...codes].filter(c => !bold.has(c));
	check(codes.size >= 5, `script exits with several distinct codes (${[...codes].sort((a, b) => +a - +b).join(", ")})`);
	check(missing.length === 0, "README bolds every exit code the script can return",
		missing.length ? `not in README: ${missing.join(", ")}` : undefined);
	// Bound to the code, not just present: the cause must sit in the same
	// sentence as its bolded number, so swapping the two would fail here.
	check(/\*\*1\*\*[^.]*(no-dir|cannot be created)/.test(section),
		"README ties an un-creatable --dir to exit 1");
	check(/\*\*64\*\*[^.]*HOME/.test(section),
		"README ties HOME unset to exit 64");
	check(/--version[^.]*path/.test(section),
		"README says install-wtft --version prints a path, not a version");
	check(/\*\*64\*\*[^.]*relative `--dir`/.test(section),
		"README ties a relative --dir with a vanished cwd to exit 64");
	check(/`--` is not an end-of-options marker/.test(section),
		"README says -- is not an end-of-options marker");
	// The README says `--help` spells those two out. Read the help the script
	// prints (the header comment, per its own -h arm) and hold it to that.
	const help = execFileSync("bash", [path.join(REPO, "bin/install-wtft"), "--help"], { encoding: "utf8" });
	check(/--version\s+absolute path of THIS SCRIPT, not a version/.test(help),
		"install-wtft --help says --version prints the script path");
	check(/`--` is NOT an end-of-options marker/.test(help),
		"install-wtft --help says -- is not an end-of-options marker");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

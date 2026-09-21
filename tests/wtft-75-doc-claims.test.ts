#!/usr/bin/env bun
/**
 * Five doc claims pinned against the code or doc they describe
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

	// `wtft spawn-record` is a POSITIONAL SUBCOMMAND with its own parser (#116),
	// and its flags are deliberately NOT in `parseWtftCliArgs` — the report path
	// must never accept them. So the example lines are routed to the parser that
	// actually handles them. Unioning the two sets instead would let a report
	// example name `--mechanism` and still pass, which is the drift this checks
	// for.
	const subcommandParser = stripTsComments(read("extensions/lib/wtft-spawn-ledger.ts"));
	const subcommandAccepted = new Set<string>(["--json", "--help", "-h"]);
	for (const m of subcommandParser.matchAll(/\^--\(([\w|]+)\)/g)) {
		for (const name of m[1].split("|")) subcommandAccepted.add(`--${name}`);
	}
	check(subcommandAccepted.size > 4,
		`spawn-record exposes a flag set to compare against (${subcommandAccepted.size} literals)`);

	const readme = read("README.md");
	const blocks = [...readme.matchAll(/```sh\n([\s\S]*?)```/g)].map(m => m[1]);
	const named: string[] = [];
	const subcommandNamed: string[] = [];
	for (const block of blocks) {
		// Shell line continuations first: a `\`-terminated line carries flags
		// onto the next physical line, and splitting on "\n" left every one of
		// them unchecked. The README's first multi-line example arrived with
		// #116, so this had been vacuously true until then.
		const joined = block.replace(/\\\n\s*/g, " ");
		for (const line of joined.split("\n")) {
			const t = line.trim();
			if (!t.startsWith("wtft ")) continue;
			const isSubcommand = /^wtft\s+spawn-record\b/.test(t);
			for (const tok of t.split(/\s+/).slice(1)) {
				if (!tok.startsWith("-")) continue;
				(isSubcommand ? subcommandNamed : named).push(tok.replace(/=.*$/, ""));
			}
		}
	}
	check(named.length > 0, `README has wtft examples with flags (${named.length} flag tokens)`);
	const unknown = named.filter(f => !accepted.has(f));
	check(unknown.length === 0, "every README wtft flag is accepted by parseWtftCliArgs",
		unknown.length ? `not in parser: ${unknown.join(", ")}` : undefined);

	check(subcommandNamed.length > 0,
		`README has spawn-record examples with flags (${subcommandNamed.length} flag tokens)`);
	const unknownSub = subcommandNamed.filter(f => !subcommandAccepted.has(f));
	check(unknownSub.length === 0, "every README spawn-record flag is accepted by runSpawnRecordCommand",
		unknownSub.length ? `not in subcommand parser: ${unknownSub.join(", ")}` : undefined);

	// The closer names the manifest too: it is what `--help` and `--why` render
	// from, so a README example naming a flag the manifest omits documents
	// something `--help` would deny. Flags are found in the manifest's strings.
	const manifest = read("docs/manifests/wtft-cmd.json");
	const inManifest = new Set([...manifest.matchAll(/(?<![\w-])(-{1,2}[A-Za-z][\w-]*)/g)].map(m => m[1]));
	const undocumented = [...named, ...subcommandNamed].filter(f => !inManifest.has(f));
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

// ---
// 5. adding-a-harness.md pins the native-cost / server-tool-cost rule (#118).
// ---
console.log("\n5. adding-a-harness.md states the native-cost/server-tool-cost rule");
{
	const doc = read("docs/adding-a-harness.md");
	check(/MUST NOT include server-side tool charges/.test(doc),
		"adding-a-harness.md says a harness-native per-turn cost MUST NOT include server-side tool charges");
	check(/zero\s+`server_tool_use`/.test(doc),
		"adding-a-harness.md says an adapter whose native cost already includes them must zero server_tool_use");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

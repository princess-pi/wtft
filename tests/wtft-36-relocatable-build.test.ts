#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test wtft-36-relocatable-build
 * @description The published artifact is self-contained (#36).
 *
 *   `files` in package.json ships `bin/wtft.mjs` and `bin/wtft-daemon.mjs` and
 *   NOTHING else, so anything those two files still reach for at runtime — a
 *   bare import, a repo-relative data file — is unreachable in every install.
 *   Two separate defects had that shape:
 *
 *   1. The `@princess-pi/libs` extraction added it (and `wcwidth`) to `external`
 *      in build.ts, leaving bare imports in the emitted ESM. Node resolves those
 *      by walking up from the FILE, so the artifact only ran from a directory
 *      with the dependency in an ancestor `node_modules`. It also broke a test
 *      that RELIES on relocatability rather than asserting it — wtft-308 §6
 *      copies wtft.mjs somewhere with no wtft-daemon.mjs beside it, to inject a
 *      daemon that dies during startup structurally instead of by timing.
 *   2. --help, --why and --version read docs/manifests/wtft-cmd.json relative to
 *      the artifact. Fixing (1) is what made this one reachable: before it, the
 *      module error came first and hid the ENOENT behind it.
 *
 *   WHY A DEDICATED SUITE. Both defects were found by a test that only needed
 *   relocatability as a means to something else, and (2) had never been caught
 *   at all, because no test runs the artifact from outside this repo. A property
 *   that everything depends on and nothing asserts is exactly the one that
 *   regresses, so this suite owns it: V1 says WHY it is relocatable, V3 says
 *   THAT it is, and V2 stops V3 passing for the wrong reason.
 *
 *   Requires stock `node` on PATH — not `process.execPath`, which is bun under
 *   the runner. Running the artifact on the runtime consumers actually use is
 *   the whole claim.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("36-relocatable-build");

const RED = "\x1b[31m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RESET = "\x1b[0m";
let passed = 0, failed = 0, skipped = 0;
function check(ok: boolean, label: string, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n       ${detail}` : ""}`); failed++; }
}
function skip(label: string) { console.log(`  ${YELLOW}SKIP${RESET} ${label}`); skipped++; }

const REPO = path.resolve(import.meta.dirname, "..");
const ARTIFACTS = ["wtft.mjs", "wtft-daemon.mjs"];

// The suite tests the BUILT artifact, so it has to exist. Building here rather
// than requiring the caller to remember keeps `bun tests/run.ts` self-contained.
execSync("bun run build", { cwd: REPO, stdio: "pipe" });

let NODE = "";
try { NODE = execSync("command -v node", { encoding: "utf8" }).trim(); } catch { /* none */ }

// ---
// 1. No bare import survives the bundle — the structural reason for §3.
// ---
console.log("\n1. The emitted ESM reaches for nothing outside itself");
{
	// A specifier is "bare" unless it is relative, absolute, or a node: builtin.
	const BARE = /(?:^|[\s;}])(?:import|export)[^;'"]*?from\s*["']([^"'.\/][^"']*)["']/g;
	const DYNAMIC = /\bimport\(\s*["']([^"'.\/][^"']*)["']\s*\)/g;
	for (const name of ARTIFACTS) {
		const code = fs.readFileSync(path.join(REPO, "bin", name), "utf8");
		const found = new Set<string>();
		for (const re of [BARE, DYNAMIC]) {
			re.lastIndex = 0;
			for (const m of code.matchAll(re)) {
				if (!m[1].startsWith("node:")) found.add(m[1]);
			}
		}
		check(found.size === 0, `V1: bin/${name} has no bare imports`,
			found.size ? `still external: ${[...found].join(", ")}` : undefined);
	}
}

// ---
// 2. …and the directory it is copied to really has no node_modules to fall
//    back on. Without this, §3 would pass on a host where an ancestor happened
//    to carry one, certifying a property the artifact does not have.
// ---
console.log("\n2. The copy is somewhere node cannot resolve a package");
const loose = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-36-loose-")));
for (const name of ARTIFACTS) fs.copyFileSync(path.join(REPO, "bin", name), path.join(loose, name));
{
	// The break is at the BOTTOM, so the filesystem root is checked too. The
	// natural `d !== path.dirname(d)` header stops one directory early —
	// `path.dirname("/") === "/"`, so the body never runs for `/` — which would
	// leave a root-level node_modules unseen while node's own resolution walks
	// up to it. Unlikely layout, but this check exists ONLY to stop §3 passing
	// for the wrong reason, so a hole in it is the one hole that matters.
	// (PR #44 review, Low.)
	const ancestors: string[] = [];
	for (let d = loose; ; d = path.dirname(d)) {
		if (fs.existsSync(path.join(d, "node_modules"))) ancestors.push(d);
		if (d === path.dirname(d)) break;
	}
	check(ancestors.length === 0, "V2: no node_modules in any ancestor of the copy",
		ancestors.length ? `would have resolved from: ${ancestors.join(", ")}` : undefined);
}

// ---
// 3. The behaviour itself, on stock node.
// ---
console.log("\n3. Every self-describing command runs from the copy, on stock node");
{
	if (!NODE) {
		skip("no `node` on PATH — the stock-node arm did not run");
	} else {
		for (const flag of ["--help", "--why", "--version"]) {
			let out = "", code = 0;
			try {
				out = execFileSync(NODE, [path.join(loose, "wtft.mjs"), flag], { encoding: "utf8", stdio: "pipe" });
			} catch (err: any) {
				out = `${err.stdout || ""}${err.stderr || ""}`;
				code = err.status ?? 1;
			}
			check(code === 0, `V3: \`wtft ${flag}\` exits 0 from a bare directory`,
				code === 0 ? undefined : `exit ${code}: ${out.trim().split("\n").slice(0, 3).join(" | ").slice(0, 300)}`);
		}
		// The daemon is a separate entrypoint with its own bundle, so it gets its
		// own check rather than being assumed to travel with the CLI.
		let dcode = 0;
		try { execFileSync(NODE, [path.join(loose, "wtft-daemon.mjs"), "--help"], { encoding: "utf8", stdio: "pipe" }); }
		catch (err: any) { dcode = err.status ?? 1; }
		check(dcode === 0, "V3: `wtft-daemon --help` exits 0 from a bare directory", `exit ${dcode}`);
	}
}

// ---
// 4. Bundling third-party code carries its licence with it. @princess-pi/libs is
//    MIT-0 and waives attribution; the rest are MIT and do not — the notice must
//    appear "in all copies or substantial portions", and a bundle is a copy.
//
//    THE CHECK IS DERIVED FROM THE BUNDLE, because the previous one could not
//    fail for its stated reason. It looked for two fixed strings from a
//    hand-written banner that build.ts emitted unconditionally: strip wcwidth
//    from the bundle entirely and it still passed. A reconcile audit found that,
//    and two real gaps behind it — `clone` and `defaults` were bundled and named
//    nowhere, and the banner reproduced the STANDARD MIT disclaimer while
//    wcwidth's own LICENSE uses a BSD-2-style one, so it was not reproducing
//    wcwidth's notice at all.
//
//    Now the notice is generated from the `// node_modules/<pkg>/` markers bun
//    writes, with each LICENSE copied verbatim — so this reads the same markers
//    and demands a matching entry. Bundle a new dependency and it fails.
// ---
console.log("\n4. The bundle carries the verbatim licence of every package it bundles");
for (const name of ARTIFACTS) {
	const code = fs.readFileSync(path.join(REPO, "bin", name), "utf8");
	const bundled = new Set<string>();
	for (const m of code.matchAll(/^\/\/ node_modules\/((?:@[^/\n]+\/)?[^/\n]+)\//gm)) {
		if (!m[1].startsWith("@princess-pi/")) bundled.add(m[1]);
	}
	check(bundled.size > 0, `V4a: bin/${name} names the packages it vendored`, [...bundled].join(","));
	for (const pkg of [...bundled].sort()) {
		const licPath = ["LICENSE", "LICENSE.md", "LICENCE", "license"]
			.map(f => path.join(REPO, "node_modules", pkg, f))
			.find(f => fs.existsSync(f));
		if (!licPath) { check(false, `V4b: ${pkg} has a LICENSE file to reproduce`); continue; }
		// A distinctive middle line, not the boilerplate opener: "Permission is
		// hereby granted" appears in every MIT text and would match the wrong
		// project's notice.
		const distinctive = fs.readFileSync(licPath, "utf8")
			.split("\n").map(l => l.trim())
			.filter(l => /^Copyright/i.test(l))[0] ?? "";
		check(distinctive !== "" && code.includes(distinctive),
			`V4b: bin/${name} carries ${pkg}'s own notice ("${distinctive.slice(0, 46)}…")`);
	}
	// Flagless, and line 1. `#!/usr/bin/env -S node --experimental-strip-types`
	// is right for the .ts entrypoint and fatal on the plain-JS bundle: node 18
	// and 20 answer `bad option` and exit. bun copies the entrypoint's shebang
	// through, so build.ts has to replace it.
	check(code.split("\n")[0] === "#!/usr/bin/env node",
		`V4c: bin/${name} line 1 is a flagless node shebang`, JSON.stringify(code.split("\n")[0]));
}

// ---
// 5. --version answers FROM THE ARTIFACT, not from whatever package.json happens
//    to sit above it (#46).
//
//    This check used to assert the opposite — that a bundled artifact dropped
//    into a package layout read `../package.json` (#347). #46's install layout
//    is where that bites:
//    `~/bin/wtft` looks up at `$HOME/package.json`, which is either absent
//    (--version prints "unknown", on the one command you run when you already
//    suspect you are running the wrong build) or PRESENT and unrelated
//    (--version confidently prints someone else's version number).
//
//    build.ts now substitutes the version it read out of package.json at build
//    time, so package.json is still the single source of truth and the artifact
//    still answers alone. The neighbouring file below carries a DELIBERATELY
//    WRONG version: if the read ever comes back, this fails instead of passing
//    on a value that happens to match.
// ---
console.log("\n5. --version answers from the artifact, ignoring a neighbouring package.json");
{
	if (!NODE) {
		skip("no `node` on PATH — the published-layout arm did not run");
	} else {
		const pkgRoot = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-36-pkg-")));
		fs.mkdirSync(path.join(pkgRoot, "bin"));
		for (const name of ARTIFACTS) fs.copyFileSync(path.join(REPO, "bin", name), path.join(pkgRoot, "bin", name));
		const realPkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
		const DECOY_VERSION = "9.9.9-decoy";
		fs.writeFileSync(path.join(pkgRoot, "package.json"), JSON.stringify({
			name: realPkg.name, version: DECOY_VERSION, type: realPkg.type, bin: realPkg.bin,
		}));
		let out = "", code = 0;
		try { out = execFileSync(NODE, [path.join(pkgRoot, "bin", "wtft.mjs"), "--version"], { encoding: "utf8", stdio: "pipe" }); }
		catch (err: any) { out = `${err.stdout || ""}${err.stderr || ""}`; code = err.status ?? 1; }
		check(code === 0 && out.includes(realPkg.version) && !out.includes(DECOY_VERSION),
			`V5: --version prints the built-in ${realPkg.version}, not the neighbouring ${DECOY_VERSION}`,
			`exit ${code}: ${out.trim().slice(0, 200)}`);

		// And with NO package.json anywhere above it, which is the #46 install
		// layout exactly. Before the injection this printed "unknown"; the
		// `unknown` clause below is belt-and-braces rather than load-bearing,
		// since build.ts's define compiles the fallback out of the bundle
		// altogether — remove the define and the version check above is what
		// fails.
		const bare = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-36-bare-")));
		for (const name of ARTIFACTS) fs.copyFileSync(path.join(REPO, "bin", name), path.join(bare, name));
		let bareOut = "", bareCode = 0;
		try { bareOut = execFileSync(NODE, [path.join(bare, "wtft.mjs"), "--version"], { encoding: "utf8", stdio: "pipe" }); }
		catch (err: any) { bareOut = `${err.stdout || ""}${err.stderr || ""}`; bareCode = err.status ?? 1; }
		check(bareCode === 0 && bareOut.includes(realPkg.version) && !bareOut.includes("unknown"),
			`V5b: with no package.json above it at all, --version still prints ${realPkg.version}`,
			`exit ${bareCode}: ${bareOut.trim().slice(0, 200)}`);
	}
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed > 0 ? 1 : 0);

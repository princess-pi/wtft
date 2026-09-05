#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test wtft-36-relocatable-build
 * @description The published artifact is self-contained (#36).
 *
 *   `files` in package.json ships four prebuilt bundles and NOTHING else — the
 *   two CLI bins, plus the two Pi-extension bundles #60 added — so anything any
 *   of them still reaches for at runtime, a bare import or a repo-relative data
 *   file, is unreachable in every install. §1 scans all four; §2-§5 exercise the
 *   two bins, the only ones that must RUN from a bare directory.
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
 *   THAT it is, and V2 stops V3 passing for the wrong reason. §4 and §5 ride
 *   along on the same artifact rather than in suites of their own — the bundled
 *   licence notices, and #46's claim that `--version` answers from the artifact
 *   and not from a neighbouring package.json.
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
// The whole shipped surface, READ FROM package.json's `files` allowlist rather
// than restated here. §1 scans all of it, because a bare import is unreachable
// in an install no matter which bundle carries it. §2, §3 and §5 stay on
// ARTIFACTS because they RUN the artifact and only the bins are runnable; §4
// stays on ARTIFACTS for a worse reason — it predates the Pi bundles and nobody
// widened it, so pi/wtft.js vendors clone, defaults and wcwidth and has its
// licence notice checked by nothing (#73).
//
// Derived, not listed, for the reason §4's marker regex exists to teach: a
// hand-kept copy of a fact the build already owns drifts the moment the build
// changes and nothing says so. #60 put the two Pi bundles in `files` on
// 2026-09-03 and the hardcoded pair here kept scanning only the bins until #32
// — one day, because CI landed the day after. With no CI it would have been
// however long nobody happened to look, which is the number that matters.
//
// Plain files only. npm's `files` also accepts globs and DIRECTORY names —
// a bare `"bin"` is legal and ships the whole directory — and readFileSync
// takes neither. So check what is actually relied on: every entry resolves to
// a readable regular file. Checking the string's shape is not enough, because
// `"bin"` has no glob character and no trailing slash and would sail through
// to the EISDIR this guard exists to pre-empt (PR review).
const SHIPPED: string[] = JSON.parse(
	fs.readFileSync(path.join(REPO, "package.json"), "utf8"),
).files ?? [];

// The suite tests the BUILT artifact, so it has to exist. Building here rather
// than requiring the caller to remember keeps `bun tests/run.ts` self-contained.
execSync("bun run build", { cwd: REPO, stdio: "pipe" });

// Validate SHIPPED only AFTER the build. Every path in `files` is build output
// and every one is gitignored (.gitignore: `bin/*.mjs`, `pi/*.js`), so on a
// clean checkout none of them exists yet — statting them first would fail the
// suite for the absence the very next line exists to fix (PR review round 2).
{
	const notAFile = SHIPPED.filter(f => {
		if (/[*?[\]]/.test(f)) return true;                       // a glob, not a path
		try { return !fs.statSync(path.join(REPO, f)).isFile(); }  // a directory, or absent
		catch { return true; }
	});
	if (SHIPPED.length === 0 || notAFile.length > 0) {
		console.error(`package.json \`files\` must be a non-empty list of plain files this suite can read; `
			+ `not usable: ${JSON.stringify(notAFile)} (of ${JSON.stringify(SHIPPED)})`);
		process.exit(1);
	}
}

let NODE = "";
try { NODE = execSync("command -v node", { encoding: "utf8" }).trim(); } catch { /* none */ }

// ---
// 1. NOTHING survives the bundle except node: builtins — the structural reason
//    for §3.
// ---
console.log("\n1. The emitted ESM reaches for nothing but node: builtins");
{
	// The allowed set is `node:` and NOTHING ELSE. Not "no bare imports", which
	// is what this checked through two review rounds while claiming more.
	//
	// The narrowing came from the word "bare": each pattern began `[^"'./]`, so
	// a specifier starting with a dot or a slash was skipped by construction —
	// and #29's defect 2 was `await import("./manifest-help.js")`, a RELATIVE
	// import of a file that had moved into @princess-pi/libs. The exact defect
	// this suite exists to catch was outside the only check that claimed to
	// catch it, under a label reading "reaches for nothing outside itself".
	//
	// A bundle is self-contained by construction, so the honest assertion is
	// also the simplest: every module it needed is inlined, therefore any
	// surviving specifier of any shape is a bug — relative, absolute or bare.
	// Measured on all four bundles at db5cc38: zero non-`node:` specifiers of
	// any kind, so this costs nothing today and closes the whole class.
	//
	// Four syntactic forms, because each reaches outside just as well:
	// `… from "x"`, `import("x")`, a side-effect `import "x"`, and
	// `require("x")`.
	const FROM = /(?:^|[\s;}])(?:import|export)[^;'"]*?from\s*["']([^"']+)["']/g;
	const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
	const SIDE_EFFECT = /(?:^|[\s;}])import\s*["']([^"']+)["']/g;
	const REQUIRE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
	for (const rel of SHIPPED) {
		const code = fs.readFileSync(path.join(REPO, rel), "utf8");
		const found = new Set<string>();
		for (const re of [FROM, DYNAMIC, SIDE_EFFECT, REQUIRE]) {
			re.lastIndex = 0;
			for (const m of code.matchAll(re)) {
				if (!m[1].startsWith("node:")) found.add(m[1]);
			}
		}
		check(found.size === 0, `V1: ${rel} imports nothing but node: builtins`,
			found.size ? `still reaches for: ${[...found].join(", ")}` : undefined);
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
console.log("\n3. wtft's three display flags, and the daemon's --help, run from the copy on stock node");
{
	if (!NODE) {
		skip("no `node` on PATH — the stock-node arm did not run");
	} else {
		// A PRIVATE HOME. bin/wtft.ts calls loadUserPricing() and
		// loadExternalHarnesses() BEFORE the display-flag early exits, so with an
		// inherited HOME these runs read the developer's ~/.config and can
		// `import()` whatever wtft-harnesses.json names there. A relocatability
		// check that depends on one box's config is not checking relocatability.
		const fakeHome = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-36-home-")));
		const env = { ...process.env, HOME: fakeHome, XDG_CONFIG_HOME: path.join(fakeHome, ".config") };

		for (const flag of ["--help", "--why", "--version"]) {
			let out = "", code = 0;
			try {
				out = execFileSync(NODE, [path.join(loose, "wtft.mjs"), flag], { encoding: "utf8", stdio: "pipe", env });
			} catch (err: any) {
				out = `${err.stdout || ""}${err.stderr || ""}`;
				code = err.status ?? 1;
			}
			// Output, not just the exit code: main() is guarded on the invoked
			// name (bin/wtft.ts), so a copy under an unexpected name exits 0
			// having printed nothing — which a code-only check reads as success.
			check(code === 0 && out.trim().length > 0,
				`V3: \`wtft ${flag}\` exits 0 AND prints something from a bare directory`,
				`exit ${code}, ${out.trim().length} bytes: ${out.trim().split("\n").slice(0, 3).join(" | ").slice(0, 300)}`);
		}
		// The daemon is a separate entrypoint with its own bundle, so it gets its
		// own check rather than being assumed to travel with the CLI. --help
		// only: it parses --session/--list/--cleanup/--restart/--stop/--debug and
		// answers neither --why nor --version.
		let dcode = 0;
		try { execFileSync(NODE, [path.join(loose, "wtft-daemon.mjs"), "--help"], { encoding: "utf8", stdio: "pipe", env }); }
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
	// `.*node_modules/`, matching build.ts noticeFor() character for character —
	// NOT the `^// node_modules/` this was.
	//
	// bun writes each marker as the path it RESOLVED, so the direct-child form
	// appears only when the build ran somewhere that has its own node_modules.
	// Observed 2026-09-04 in a fresh git worktree that had none: every marker
	// read `// ../../../node_modules/clone/clone.js`, resolved up to the main
	// clone's, and the anchored form matched none of them — V4a failed for a
	// reason with nothing to do with licences. Install into that worktree and
	// the markers revert to the direct-child form, so the failure comes and
	// goes with the tree's state, which is worse than one that stays.
	//
	// Either way the anchored form was the two-matchers-disagreeing defect this
	// section's own comment warns about, one function away from the warning.
	const bundled = new Map<string, string>();   // package name -> directory
	for (const m of code.matchAll(/^\/\/ (.*node_modules\/((?:@[^/\n]+\/)?[^/\n]+))\//gm)) {
		if (!m[2].startsWith("@princess-pi/")) bundled.set(m[2], path.join(REPO, m[1]));
	}
	check(bundled.size > 0, `V4a: bin/${name} names the packages it vendored`, [...bundled.keys()].join(","));
	for (const pkg of [...bundled.keys()].sort()) {
		// The SAME matcher build.ts uses. A fixed name list here while the build
		// globs meant a dependency shipping COPYING would build green and fail
		// the suite that gates the build — two matchers disagreeing about the
		// same question.
		// The directory the MARKER named, not REPO/node_modules/<pkg>: the
		// marker's path is the one bun resolved, so it is the only one
		// guaranteed to hold the LICENSE that actually went into the bundle.
		const pkgDir = bundled.get(pkg)!;
		const licPath = (fs.existsSync(pkgDir) ? fs.readdirSync(pkgDir) : [])
			.filter(f => /^(licen[cs]e|copying)/i.test(f))
			.sort()
			.map(f => path.join(pkgDir, f))
			.find(f => fs.statSync(f).isFile());
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
		// `unknown` clause below is belt-and-braces rather than load-bearing:
		// the define makes `injected` a non-empty literal, so the fallback is
		// UNREACHABLE — it is still present in the bundle, just behind an
		// `if (injected) return`. Remove the define and the version check above
		// is what fails.
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

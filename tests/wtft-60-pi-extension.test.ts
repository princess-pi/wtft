#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test wtft-60-pi-extension
 * @description The Pi extension face is self-contained and loadable (#60).
 *
 *   The extraction copied `extensions/wtft.ts` + `extensions/token-budget.ts`
 *   out of princess-pi-tools and never re-wired them: Pi loads the ppt package
 *   (`settings.json` → packages → `pi.extensions: ["./extensions"]`), and those
 *   two files were deleted from it by ppt#588. This repo never registered
 *   itself as a Pi package, so `/wtft` and `/budget` went dark.
 *
 *   The fix: `package.json` declares a `pi` manifest pointing at `./pi`, and
 *   `build.ts` bundles the two extensions into that directory the SAME
 *   self-contained way the CLI bundles are built (#36) — `@princess-pi/libs`
 *   and `wcwidth` are vendored in, so the npm `dependencies` stay empty and the
 *   extension needs no node_modules at runtime. The `.ts` source stays in
 *   `extensions/` and is NOT auto-discovered (a `pi` manifest replaces the
 *   convention dir), so there is no double registration.
 *
 *   This suite owns three facts: the manifest points at ./pi, the bundles are
 *   emitted and importable (default export is a function), and the bundles
 *   reach for nothing outside themselves. It mirrors wtft-36's V1 structural
 *   check rather than re-deriving a different definition of "self-contained".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";
let passed = 0;
let failed = 0;

function check(ok: boolean, label: string, detail?: string) {
	if (ok) {
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} else {
		console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n       ${detail}` : ""}`);
		failed++;
	}
}

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const EXTENSIONS = ["wtft.js", "token-budget.js"];

// The suite tests the BUILT bundle, so it has to exist. Building here rather
// than requiring the caller to remember keeps `bun tests/run.ts` self-contained
// (same rule as wtft-36).
execSync("bun run build", { cwd: REPO, stdio: "pipe" });

console.log("\n=== WTFT #60 PI EXTENSION ===");

// ---
// 1. The package declares itself a Pi package whose extensions are ./pi.
// ---
// 1. package.json is a Pi package pointing at ./pi. The exact ["./pi"] list is
//    the no-double-registration guarantee: a `pi` manifest REPLACES the
//    `extensions/` convention dir in pi's package-manager (it returns early on
//    a manifest and never falls through to the convention dirs), so the .ts
//    source in extensions/ is not auto-discovered alongside the ./pi bundles.
//    Verified against pi 0.84.4 dist/core/package-manager.js resolvePackageResources.
// ---
console.log("\n1. package.json is a Pi package pointing at ./pi");
check(
	(PKG.keywords ?? []).includes("pi-package"),
	"`pi-package` keyword is set",
	`keywords: ${JSON.stringify(PKG.keywords ?? [])}`,
);
check(
	Array.isArray(PKG.pi?.extensions) && PKG.pi.extensions.length === 1 && PKG.pi.extensions[0] === "./pi",
	"pi.extensions is exactly [\"./pi\"]",
	`pi: ${JSON.stringify(PKG.pi)}`,
);

// ---
// 2. The bundles are emitted. No bare import survives — the structural reason
//    they load with no node_modules (#36, mirrored for the extension face).
// ---
console.log("\n2. The emitted bundles reach for nothing outside themselves");
for (const name of EXTENSIONS) {
	const file = path.join(REPO, "pi", name);
	check(fs.existsSync(file), `pi/${name} exists`);

	if (!fs.existsSync(file)) continue;
	const code = fs.readFileSync(file, "utf8");

	const BARE = /(?:^|[\s;}])(?:import|export)[^;'"]*?from\s*["']([^"'.\/][^"']*)["']/g;
	const DYNAMIC = /\bimport\(\s*["']([^"'.\/][^"']*)["']\s*\)/g;
	const found = new Set<string>();
	for (const re of [BARE, DYNAMIC]) {
		re.lastIndex = 0;
		for (const m of code.matchAll(re)) {
			if (!m[1].startsWith("node:")) found.add(m[1]);
		}
	}
	check(found.size === 0, `V1: pi/${name} has no bare imports`, found.size ? `still external: ${[...found].join(", ")}` : undefined);
}

// ---
// 3. The bundles actually import and export a default function — the shape Pi's
//    loader calls (loadExtensionFromFactory / module.default).
// ---
console.log("\n3. Each bundle's default export is a function");
for (const name of EXTENSIONS) {
	const file = path.join(REPO, "pi", name);
	if (!fs.existsSync(file)) {
		check(false, `pi/${name} default export is a function`, "file missing — §2 failed");
		continue;
	}
	try {
		const out = execSync(
			`bun -e 'import(${JSON.stringify(file)}).then(m => { process.exit(typeof m.default === "function" ? 0 : 1); }).catch(() => process.exit(1))'`,
			{ encoding: "utf8", stdio: "pipe" },
		);
		check(true, `pi/${name} imports and exports a default function`);
	} catch {
		check(false, `pi/${name} imports and exports a default function`);
	}
}

console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

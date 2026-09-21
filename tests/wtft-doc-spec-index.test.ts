#!/usr/bin/env -S node --experimental-strip-types
/**
 * every docs/spec-*.md is reachable from EXT_WTFT.html (#161)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DOCS_DIR = path.join(REPO_ROOT, "docs");
const EXT_WTFT_PATH = path.join(DOCS_DIR, "EXT_WTFT.html");

// ---
// TEST 1: sanity — the glob and the file both exist and are non-trivial
// ---
console.log("--- TEST 1: fixtures exist ---");

const specFiles = fs.readdirSync(DOCS_DIR).filter(f => /^spec-.*\.md$/.test(f));
check(specFiles.length > 0, `docs/spec-*.md glob finds at least one file (found ${specFiles.length})`);
check(fs.existsSync(EXT_WTFT_PATH), "docs/EXT_WTFT.html exists");

const extHtml = fs.readFileSync(EXT_WTFT_PATH, "utf8");
const hrefs = [...extHtml.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
check(hrefs.length > 0, `docs/EXT_WTFT.html has at least one href (found ${hrefs.length}) — was 0 before #161`);

// ---
// TEST 2: forward direction — every on-disk spec-*.md is linked
// ---
console.log("\n--- TEST 2: every docs/spec-*.md on disk is linked from docs/EXT_WTFT.html ---");

for (const file of specFiles.sort()) {
	check(
		hrefs.some(h => h === file || h.endsWith(`/${file}`)),
		`${file} is href-linked from docs/EXT_WTFT.html`
	);
}

// ---
// RESULT
// ---
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error("❌ WTFT DOC SPEC INDEX TEST FAILED");
	process.exit(1);
}
console.log("✅ WTFT DOC SPEC INDEX TEST PASSED — every on-disk spec is reachable from the system spec root!");

#!/usr/bin/env -S node --experimental-strip-types
/**
 * tests/wtft-doc-spec-index.test.ts — every docs/spec-*.md is reachable from EXT_WTFT.html (#161)
 *
 * Before #161, docs/EXT_WTFT.html had zero <a href> links (rg -o 'href="[^"]*"' → 0 matches)
 * and one heading in 35KB — a reader landing on the page could not reach any of the 11
 * docs/spec-*.md feature specs. This test is the gate that keeps that from silently
 * regressing: any spec-*.md file added later that nobody links from the system-spec page
 * fails this suite instead of quietly becoming an orphan.
 *
 * FORWARD DIRECTION ONLY, deliberately:
 *   - Asserted: every docs/spec-*.md present ON DISK is href-linked from docs/EXT_WTFT.html.
 *   - NOT asserted: every href in docs/EXT_WTFT.html resolves to a file that exists.
 *
 * Why not the reverse: #161's spec doc pre-links five sibling specs that do not exist on
 * this branch yet — docs/spec-144-145-164-session-discovery.md, docs/spec-148-*.md,
 * docs/spec-149-*.md, docs/spec-159-*.md, docs/spec-163-*.md — because five other branches
 * are adding them in parallel and the page is meant to be correct the moment each one
 * merges, not edited again afterward. A reverse ("every link resolves") assertion would
 * fail on every clean checkout of this branch until all five land, which is not a
 * regression — it is the expected, temporary state of a page that links forward to work
 * in flight. Testing the forward direction only still catches the actual failure mode
 * (#161: a real, on-disk spec with no link to it) without being brittle to merge order.
 *
 * Run: node --experimental-strip-types tests/wtft-doc-spec-index.test.ts
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

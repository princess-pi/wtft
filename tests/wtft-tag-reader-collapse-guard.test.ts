#!/usr/bin/env bun
/**
 * Every tag-file reader must collapse by message.id before summing
 *   (docs/wtft-incremental-render-spec.md).
 */

import * as fs from "node:fs";
import * as path from "node:path";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}`); failed++; }
}

const repoRoot = path.resolve(import.meta.dirname, "..");

/** Files that touch tag files but are NOT subject to the collapse rule, each with
 *  the reason it is exempt. An entry here is a claim someone can check, which is the
 *  whole difference between this and the prose rule it replaces. */
const ALLOWED: Record<string, string> = {
	// extensions/token-budget.ts routed through readClassifiedTagFile in #17
	// (filed as #454) — no longer needs an allowlist entry.
	// Tag WRITER: reads its own markers and the tail it resumes from, through
	// tag-log; never sums a cost from a tag.
	"bin/wtft-daemon.ts": "tag WRITER; reads its own markers through tag-log, sums nothing",
	// Resolves getTagPath purely to hand it to checkDaemonHealth (liveness by
	// mtime/PID). Reads no tag CONTENT and sums nothing.
	"extensions/lib/wtft-cli-shared.ts": "tag path used for daemon health only; reads no tag content",
};

/** Strip line and block comments so a mention of the canonical helper INSIDE a
 *  comment cannot pass as a call to it. */
function stripComments(text: string): string {
	// Order matters: block comments first, then line comments. String literals
	// containing "//" would be over-stripped by this, which is acceptable —
	// over-stripping can only turn a "routed" into an "unrouted", i.e. it fails
	// LOUD and never lets a real violation through.
	return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const CANONICAL = String.raw`(?:readClassifiedTagFile|readTagFileWithVerdict|seedClassifiedTagFile|classifiedInteractionsFromContent|dedupeClassifiedById)`;

/** Routed means the file actually IMPORTS or CALLS the canonical collapse —
 *  never merely mentions it.
 *
 *  Limit: this proves the canonical collapse is REACHED somewhere in the
 *  file, not that it is applied to the array the file then sums. */
function isRouted(text: string): boolean {
	const code = stripComments(text);
	const calls = new RegExp(String.raw`\b` + CANONICAL + String.raw`\s*\(`).test(code);
	const imports = new RegExp(
		String.raw`\bimport\b[^;]*?\b` + CANONICAL + String.raw`\b`,
		"s",
	).test(code);
	return calls || imports;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === "node_modules" || e.name === ".git") continue;
			sourceFiles(full, out);
		} else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
			out.push(full);
		}
	}
	return out;
}

console.log("wtft tag-file reader collapse guard");
console.log("");

const scanned = [
	...sourceFiles(path.join(repoRoot, "extensions")),
	...sourceFiles(path.join(repoRoot, "bin")),
];

const readers: string[] = [];
for (const file of scanned) {
	const text = fs.readFileSync(file, "utf8");
	const touchesTag =
		text.includes("getTagPath") || text.includes("TAG_SUFFIX") || text.includes(".wtft-tag.");
	if (!touchesTag) continue;
	const readsLines = text.includes("JSON.parse")
		|| new RegExp(String.raw`\b(?:tagRecords|parseTagLine|` + CANONICAL.slice(3, -1) + String.raw`)\s*\(`).test(stripComments(text));
	if (!readsLines) continue;
	readers.push(path.relative(repoRoot, file));
}

console.log(`1. found ${readers.length} source file(s) that resolve a tag path and read tag lines`);
assert(
	`the scan finds something — a predicate matching nothing would pass vacuously forever (${readers.length} > 0)`,
	readers.length > 0,
);

console.log("\n2. each is routed through the canonical collapse, or explicitly exempt");
const unrouted: string[] = [];
for (const rel of readers) {
	const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
	const routed = isRouted(text);
	const exempt = Object.prototype.hasOwnProperty.call(ALLOWED, rel);
	if (routed) {
		console.log(`  ${GREEN}routed${RESET}  ${rel}`);
	} else if (exempt) {
		console.log(`  ${GREEN}exempt${RESET}  ${rel} — ${ALLOWED[rel]}`);
	} else {
		console.log(`  ${RED}UNROUTED${RESET} ${rel}`);
		unrouted.push(rel);
	}
}
assert(
	`no unrouted tag-file reader${unrouted.length ? `: ${unrouted.join(", ")} — route it through readClassifiedTagFile, or add it to ALLOWED with a reason and a pinning test` : ""}`,
	unrouted.length === 0,
);

console.log("\n3. the allowlist does not rot");
// An exemption for a file that no longer matches the predicate is dead weight that
// makes the list look more load-bearing than it is, and hides the next real entry.
const staleAllows = Object.keys(ALLOWED).filter((rel) => !readers.includes(rel));
assert(
	`every ALLOWED entry still matches the scan${staleAllows.length ? ` (stale: ${staleAllows.join(", ")})` : ""}`,
	staleAllows.length === 0,
);
// The canonical implementation must itself be reachable, or "routed" means nothing.
const libPath = path.join(repoRoot, "extensions", "lib", "wtft-daemon-lib.ts");
const libText = fs.readFileSync(libPath, "utf8");
assert(
	`dedupeClassifiedById is exported from wtft-daemon-lib.ts`,
	/export function dedupeClassifiedById\b/.test(libText),
);
assert(
	`readClassifiedTagFile applies it on every read`,
	/return dedupeClassifiedById\(interactions\)/.test(libText),
);

console.log("");
console.log(failed === 0 ? `${GREEN}${passed} passed${RESET}` : `${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed === 0 ? 0 : 1);

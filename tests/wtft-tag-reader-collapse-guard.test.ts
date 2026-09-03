#!/usr/bin/env bun
/**
 * @package princess-pi-tools
 * @test wtft-tag-reader-collapse-guard
 * @description #270 review round 11 (Low/contract, docs/wtft-incremental-render-spec.md) —
 *   the "every tag-file reader must collapse by message.id before summing" rule was
 *   stated only in prose, and the spec conceded outright that "nothing structural will
 *   stop" a new reader from bypassing it. An unenforced rule is a wish: this repo's own
 *   standard is that before a rule is written down, you name how a VIOLATION WOULD BE
 *   COUNTED. This test is that count.
 *
 *   A tag file legitimately holds several lines for one billed message at growing usage
 *   (see the spec, "The append filter, and what the tag file may contain"), measured at
 *   39-76% of usage-bearing ids. Any reader that sums raw `c`/`in`/`out` across those
 *   lines over-reports. The canonical collapse is `dedupeClassifiedById`, which
 *   `readClassifiedTagFile` applies on every read.
 *
 *   Closer: every source file that BOTH resolves a tag path (getTagPath / TAG_SUFFIX /
 *   a literal ".wtft-tag.") AND parses JSON must either route through
 *   readClassifiedTagFile / dedupeClassifiedById, or appear in ALLOWED below with a
 *   reason and a pinning test or issue. A new unrouted reader fails this suite.
 *
 *   It found one on its first run: extensions/token-budget.ts (#454).
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
	// Reads tag lines and sums per-model TOKENS in a 120s window with no id
	// collapse — a real violation, filed as #454 rather than fixed blind,
	// because the correct per-field reduction for tokens (vs max-cost for
	// money) is a product decision. Removing this entry closes #454.
	"extensions/token-budget.ts": "KNOWN VIOLATION, filed as #454",
	// The tag file's WRITER. It reads that file back in exactly one place —
	// readLastMetaOffset, which scans the last 8KB for `_meta.offset` and
	// returns a byte number. It never sums a cost or a token from a tag line,
	// so the collapse rule has nothing to apply to. Its two mentions of the
	// canonical functions are both in comments, which is the OTHER file the
	// old substring check waved through (PR review round 12).
	"bin/wtft-daemon.ts": "tag WRITER; reads only _meta.offset, sums nothing",
	// Deliberately does not import wtft-daemon-lib (see that file's CONSTANTS
	// comment) and reimplements the max-cost-by-id collapse by hand. That copy
	// is pinned value-for-value against the canonical path by
	// tests/wtft-270-session-summary-dedup.test.ts, which is what an exemption
	// has to buy. It passed as "routed" until PR review round 12 — on a
	// substring match against its own explanatory comment, not on any call.
	"extensions/lib/session-selector.ts":
		"hand-rolled collapse, pinned by tests/wtft-270-session-summary-dedup.test.ts",
	// Only EXCLUDES tag files from transcript discovery ("wtft-tags" is our own
	// output). Never reads their contents.
	"extensions/lib/wtft-parser.ts": "excludes tag files from discovery; does not read them",
	// Resolves getTagPath purely to hand it to checkDaemonHealth (liveness by
	// mtime/PID). Reads no tag CONTENT and sums nothing.
	"extensions/lib/wtft-cli-shared.ts": "tag path used for daemon health only; reads no tag content",
};

/** Strip line and block comments so a mention of the canonical helper INSIDE a
 *  comment cannot pass as a call to it. The first cut of this test used a bare
 *  `text.includes(...)` and session-selector.ts sailed through as "routed"
 *  purely because the comment explaining why it does NOT import
 *  dedupeClassifiedById happens to name it (PR review). That is precisely the
 *  shape this suite exists to catch, so the detector cannot be fooled by it:
 *  any future `// TODO: use dedupeClassifiedById` would have done the same. */
function stripComments(text: string): string {
	// Order matters: block comments first, then line comments. String literals
	// containing "//" would be over-stripped by this, which is acceptable —
	// over-stripping can only turn a "routed" into an "unrouted", i.e. it fails
	// LOUD and never lets a real violation through.
	return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

const CANONICAL = String.raw`(?:readClassifiedTagFile|dedupeClassifiedById)`;

/** Routed means the file actually IMPORTS or CALLS the canonical collapse —
 *  never merely mentions it.
 *
 *  KNOWN LIMIT, stated so a green run is not read as more than it is (PR
 *  review): this proves the canonical collapse is REACHED somewhere in the
 *  file, not that it is applied to the very array the file then sums. A reader
 *  that imports dedupeClassifiedById for an unrelated purpose, or calls it on a
 *  throwaway array and sums raw lines elsewhere, passes this guard while still
 *  over-reporting. Proving application needs dataflow analysis, not a regex.
 *  This is a tripwire on the known shape — the same caveat
 *  tests/wtft-270-single-subagent-reader.test.ts states for its own checks —
 *  and its value is that the bypass it CANNOT catch is a deliberate act,
 *  whereas the one it does catch (a new reader that simply never heard of the
 *  rule) is the one that happens by accident. */
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

console.log("wtft tag-file reader collapse guard (#270 review round 11)");
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
	if (!text.includes("JSON.parse")) continue;
	readers.push(path.relative(repoRoot, file));
}

console.log(`1. found ${readers.length} source file(s) that resolve a tag path and parse JSON`);
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

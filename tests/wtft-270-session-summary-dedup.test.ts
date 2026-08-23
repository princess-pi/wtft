#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-270-session-summary-dedup
 * @description #270 review round 2 (Medium/contract, extensions/lib/session-selector.ts) —
 *   getSessionSummary() reimplements "collapse tag-file lines by message.id, keep max
 *   cost" by hand instead of calling the shared `dedupeClassifiedById`
 *   (extensions/lib/wtft-daemon-lib.ts), because session-selector.ts is a standalone
 *   module that deliberately does not import the daemon's internals (see the
 *   CONSTANTS comment at the top of session-selector.ts). Two independent
 *   implementations of the same rule with nothing pinning them together is exactly
 *   how they drift apart — this test is that pin.
 *
 *   Closer: over a synthetic tag file whose message.id "msg-A" is re-emitted at a
 *   higher cost in a later line (the growing-usage shape #270 exists to collapse),
 *   getSessionSummary()'s cost/turns must equal the cost/turns independently derived
 *   from readClassifiedTagFile() + dedupeClassifiedById() — the canonical collapse —
 *   over the same file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionSummary } from "../extensions/lib/session-selector.ts";
import { readClassifiedTagFile } from "../extensions/lib/wtft-daemon-lib.ts";
import { mkSandbox } from "./lib/sandbox";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
function assert(label: string, ok: boolean) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}`); failed++; }
}

const sandbox = mkSandbox(path.join(require("node:os").tmpdir(), "wtft-270-summary-dedup-"));
const sessionDir = sandbox;
const sessionBase = "session-summary-dedup-test.jsonl";
const sessionPath = path.join(sessionDir, sessionBase);
fs.writeFileSync(sessionPath, ""); // Tier-3 fallback only reads this if no tag file matches — unused here.

const tagsDir = path.join(sessionDir, "wtft-tags");
fs.mkdirSync(tagsDir, { recursive: true });
// Deliberately NOT session-selector's mirrored TAGGER_VERSION constant — an
// arbitrary version exercises the same Tier-2 "scan for any matching tag file"
// path getSessionSummary uses in practice, and keeps this test from silently
// going stale if that mirrored constant is ever corrected or bumped.
const tagPath = path.join(tagsDir, `${sessionBase}.wtft-tag.v9.9.9.jsonl`);

const lines = [
	{ t: 1000, c: 0.01, id: "msg-A" }, // msg-A, first (low-cost, partial) emission
	{ t: 1001, c: 0.02, id: "msg-B" },
	{ t: 1002, c: 0.05, id: "msg-A" }, // msg-A re-emitted later, growing usage — higher cost
	{ t: 1003, c: 0.03 },              // no message.id at all
	{ _hb: true },                     // heartbeat — every reader skips this
];
fs.writeFileSync(tagPath, lines.map(l => JSON.stringify(l)).join("\n") + "\n");

console.log("1. getSessionSummary agrees with the canonical readClassifiedTagFile+dedupeClassifiedById collapse");

const summary = getSessionSummary(sessionPath);
const canonical = readClassifiedTagFile(tagPath);
const canonicalCost = canonical.reduce((sum, i) => sum + i.cost, 0);
const canonicalTurns = canonical.length;

assert(`tagVersion resolved via Tier-2 scan (got ${summary.tagVersion})`, summary.tagVersion === "9.9.9");
assert(`msg-A collapsed to its max cost, not summed (cost=${summary.cost}, expected ${canonicalCost})`, Math.abs(summary.cost - canonicalCost) < 1e-9);
assert(`turns match the canonical collapse (turns=${summary.turns}, expected ${canonicalTurns})`, summary.turns === canonicalTurns);
assert(`exactly 3 distinct interactions after collapse (msg-A once, msg-B, no-id)`, canonicalTurns === 3);
assert(`cost is 0.10 — 0.05 (msg-A max) + 0.02 (msg-B) + 0.03 (no id), not 0.11 (summed)`, Math.abs(summary.cost - 0.10) < 1e-9);

console.log("\n2. a malformed tag file degrades the ANSWER, never throws out of getSessionSummary");

// #270 review round 10 (Medium/contract) — getSessionSummary's catch was
// deliberately narrowed to just the fs.readFileSync, so the max-cost-by-id
// collapse now sits OUTSIDE any try. That is intentional: a defect in the
// collapse must surface rather than masquerade as a missing tag file. But the
// two call sites in this module have no guard of their own, and one of them is
// a bare `displayCandidates.map((c) => getSessionSummary(c.path))` — so a throw
// from ANY one candidate's tag file takes down the whole interactive session
// picker, not just that row.
//
// The narrowed catch is only safe while the collapse genuinely has no throw
// path. That was argued in a comment and never tested. This is the test: every
// line shape below is hostile, and the requirement is a returned summary, not
// an exception.
const hostileLines = [
	'null',                              // JSON.parse succeeds, yields null
	'true',                              // a bare primitive, not an object
	'42',                                // ditto
	'"a string"',                        // ditto
	'[]',                                // an array — has no .id and no .c
	'[1,2,3]',
	'{"c":"not-a-number","id":"x"}',     // cost of the wrong type
	'{"c":null,"id":"y"}',
	'{"c":0.01,"id":123}',               // id of the wrong type — must take the no-id path
	'{"c":0.01,"id":{"nested":true}}',
	'{"c":0.01,"id":["a"]}',
	'{"c":0.01,"id":""}',                // empty-string id is falsy — no-id path
	'{"c":NaN}',                         // not valid JSON — the per-line guard eats it
	'{"unterminated": ',                 // truncated line, the partial-write shape
	'{"_hb":true,"c":9999}',             // heartbeat carrying a cost must still be skipped
	'{"_hb":null,"c":0.02,"id":"z"}',    // falsy _hb — NOT a heartbeat, must count
	'\u0000\u0001binary junk',
	'   ',                               // whitespace-only
	'',                                  // empty
];
const hostileTag = path.join(tagsDir, `${sessionBase}.wtft-tag.v9.9.8.jsonl`);

let threw: unknown = null;
let hostileSummary: ReturnType<typeof getSessionSummary> | null = null;
try {
	// No trailing newline, on purpose — the last line is the truncated one.
	fs.writeFileSync(hostileTag, hostileLines.join("\n"));
	// Remove the well-formed tag so the Tier-2 scan lands on the hostile one.
	fs.unlinkSync(tagPath);
	hostileSummary = getSessionSummary(sessionPath);
} catch (err) {
	threw = err;
}

assert(
	`getSessionSummary does not throw on ${hostileLines.length} malformed tag lines${threw ? ` (threw: ${threw instanceof Error ? threw.message : String(threw)})` : ""}`,
	threw === null,
);
assert(
	`it returns a summary object rather than undefined`,
	hostileSummary !== null && typeof hostileSummary === "object",
);
assert(
	`cost is a finite number, never NaN (got ${hostileSummary?.cost})`,
	typeof hostileSummary?.cost === "number" && Number.isFinite(hostileSummary.cost),
);
assert(
	`turns is a non-negative integer (got ${hostileSummary?.turns})`,
	Number.isInteger(hostileSummary?.turns) && (hostileSummary?.turns ?? -1) >= 0,
);
// Only the two well-formed cost-bearing rows should register: the falsy-_hb
// line (0.02) and the wrong-type/empty ids, which take the no-id summing path.
assert(
	`the heartbeat carrying c=9999 is still skipped (cost=${hostileSummary?.cost} is nowhere near 9999)`,
	(hostileSummary?.cost ?? 0) < 1,
);

// The same guarantee for the caller shape that actually crashes: a bare .map()
// over several candidates, one of which is poisoned.
let mapThrew: unknown = null;
try {
	[sessionPath, sessionPath, sessionPath].map((p2) => getSessionSummary(p2));
} catch (err) {
	mapThrew = err;
}
assert(
	`a bare .map() over the poisoned candidate survives — the session-picker call shape${mapThrew ? ` (threw: ${mapThrew instanceof Error ? mapThrew.message : String(mapThrew)})` : ""}`,
	mapThrew === null,
);

console.log(failed === 0 ? `\n${GREEN}${passed} passed${RESET}` : `\n${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed === 0 ? 0 : 1);

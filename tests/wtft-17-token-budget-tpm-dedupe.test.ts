#!/usr/bin/env bun
/**
 * @package princess-pi-tools
 * @test wtft-17-token-budget-tpm-dedupe
 * @description #17 — extensions/token-budget.ts (formerly rate-limiter.ts)
 *   read classified tag files with its own raw JSON.parse loop and summed
 *   `in`/`cr` tokens per model in a sliding window WITHOUT collapsing lines
 *   that share a `message.id` first. A tag file legitimately holds several
 *   lines for one billed message at growing usage (39-76% of usage-bearing
 *   ids across twelve live transcripts, `tests/wtft-270-subagent-crosspoll-
 *   dedup.test.ts`), so every re-emitted message inside the window was
 *   counted once per line instead of once — TPM over-reported. Every other
 *   reader collapses first via `dedupeClassifiedById`
 *   (`readClassifiedTagFile` runs it on every read); this one never did
 *   (`tests/wtft-tag-reader-collapse-guard.test.ts` caught it as #454,
 *   filed here as #17).
 *
 *   Closer: over a synthetic tag file whose `message.id` "msg-A" is
 *   re-emitted at growing usage inside the 60s TPM window, `aggregateActiveTpm`
 *   and `getHostingSessionTpm` must count msg-A ONCE, at its final (max-cost)
 *   usage — matching the token total independently derived from
 *   `readClassifiedTagFile` (the canonical collapse) over the same file, not
 *   the raw per-line sum.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { aggregateActiveTpm, getHostingSessionTpm } from "../extensions/token-budget.ts";
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

const sandbox = mkSandbox(path.join(os.tmpdir(), "wtft-17-tpm-dedupe-"));
const sessionId = "tpm-dedupe-test-session";
const tagBase = `${sessionId}.jsonl`;
const tagPath = path.join(sandbox, `${tagBase}.wtft-tag.v9.9.9.jsonl`);

// aggregateActiveTpm/getHostingSessionTpm call Date.now() internally rather than
// taking a clock parameter, so NOW must track the real wall clock, not a fixed
// constant — a hardcoded past/future NOW makes production's age = Date.now() -
// interaction.timestamp diverge from this fixture's age = NOW - interaction.timestamp,
// and the divergence changes sign as real time passes the constant (PR review).
const NOW = Date.now();

const lines = [
	// msg-A: growing-usage re-emission, BOTH copies inside the 60s TPM window —
	// the shape that over-reports when summed instead of collapsed.
	{ t: NOW - 50_000, c: 0.01, id: "msg-A", m: "claude-sonnet-4-6-20250606", in: 800, cr: 0 },
	{ t: NOW - 10_000, c: 0.05, id: "msg-A", m: "claude-sonnet-4-6-20250606", in: 1000, cr: 500 }, // final, higher-cost emission
	// msg-B: single emission, no duplicate — sanity check the fix doesn't
	// touch the non-duplicated case.
	{ t: NOW - 5_000, c: 0.02, id: "msg-B", m: "claude-sonnet-4-6-20250606", in: 300, cr: 0 },
	// no message.id at all — passes through dedupeClassifiedById untouched.
	{ t: NOW - 3_000, c: 0.01, m: "claude-sonnet-4-6-20250606", in: 100, cr: 0 },
	// heartbeat — every reader skips this.
	{ _hb: true },
];
fs.writeFileSync(tagPath, lines.map(l => JSON.stringify(l)).join("\n") + "\n");

const activeFiles = [{ path: tagPath, mtime: NOW }];

console.log("1. aggregateActiveTpm collapses msg-A before summing (60s window)");

// Independent source of truth: the canonical collapse, summed by hand over
// its OWN result — not a re-implementation of aggregateActiveTpm's logic.
const canonical = readClassifiedTagFile(tagPath);
const canonicalTpm = canonical
	.filter(i => (NOW - i.timestamp) <= 60_000)
	.reduce((sum, i) => sum + i.inputTokens + i.cacheReadTokens, 0);

const stats = aggregateActiveTpm(activeFiles, null);
const shortCode = Object.keys(stats)[0];

assert(`exactly one model bucket produced (got ${Object.keys(stats).length})`, Object.keys(stats).length === 1);
assert(
	`canonical collapse yields 1900 (msg-A final 1500 + msg-B 300 + no-id 100), not 2700 (msg-A summed)`,
	canonicalTpm === 1900,
);
assert(
	`aggregateActiveTpm's tpm matches the canonical collapse (tpm=${shortCode ? stats[shortCode].tpm : "none"}, expected ${canonicalTpm})`,
	!!shortCode && stats[shortCode].tpm === canonicalTpm,
);

console.log("\n2. getHostingSessionTpm collapses msg-A the same way, for the hosting session only");

const sessionTpms = getHostingSessionTpm(sessionId, activeFiles);
const sessionShortCode = Object.keys(sessionTpms)[0];

assert(
	`getHostingSessionTpm matches the canonical collapse (tpm=${sessionShortCode ? sessionTpms[sessionShortCode] : "none"}, expected ${canonicalTpm})`,
	!!sessionShortCode && sessionTpms[sessionShortCode] === canonicalTpm,
);

console.log("");
console.log(failed === 0 ? `${GREEN}${passed} passed${RESET}` : `${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed === 0 ? 0 : 1);

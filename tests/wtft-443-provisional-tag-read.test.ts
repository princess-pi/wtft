/**
 * @package princess-pi-tools
 * @test wtft-443-provisional-tag-read
 * @description #443 — a one-shot `wtft` read of a session whose tag the daemon
 *   is ABOUT to repair reports the pre-repair number as a plain total, with no
 *   indication that it is provisional.
 *
 *   Measured on the issue's specimen (session 7c0c2b7e, 15 Task subagents,
 *   finished 2026-08-13, its genuine pre-#270 v2.7.1 tag restored byte-identical
 *   before each trial, every daemon killed first):
 *
 *     run 1   $79.74   <- a 5.7% undercount, reported as a plain total
 *     run 2+  $84.59   <- equals `wtft -F` to the cent
 *
 *   The cause is statement order in `bin/wtft.ts`: the daemon is spawned, then
 *   the tag is read immediately afterwards, so the read races the daemon it just
 *   started and always loses on the first run. `awaitDaemonUp` exists on that
 *   path but is entered only when `interactions.length === 0`; a populated-but-
 *   stale tag satisfies neither condition, so nothing waits.
 *
 *   Duppy chose remedy (b) — say the total is provisional — over (a), blocking
 *   the read, because blocking a one-shot CLI for a repair whose length is
 *   proportional to the session's subagent volume is the cost that read-then-
 *   render exists to avoid.
 *
 *   This suite pins the READER PREDICATE, `readTagProvisional`. The end-to-end
 *   half of the Closer (one `wtft --tokens` invocation either equals `-F` or
 *   exits 9) lives in the CLI, and is covered separately.
 *
 *   TWO CONDITIONS, either sufficient:
 *
 *   P-a `stale-version` — the resolved tag is not at WTFT_TAGGER_VERSION.
 *     `getTagPath`'s resolution rule 3 falls back to "any-version tag in the own
 *     dir, newest mtime", so a read can legitimately land on a tag written under
 *     superseded semantics while the daemon builds a current-version one beside
 *     it. Detectable from the path alone.
 *
 *   P-b `unswept` — a current-version tag holding classified data but carrying
 *     no `_meta.swept` marker. The daemon appends that marker once its first
 *     `scanForSubAgents()` has completed, so its ABSENCE means no subagent
 *     transcript has been read by any daemon since this tag was written. That is
 *     precisely the 5.7% above.
 *
 *   WHY THE MARKER NEEDS ITS OWN APPEND, rather than riding the existing
 *   `_meta.offset` line: that line is written only by `flushPending()`, which
 *   runs only when new PARENT interactions arrive. On a finished session — the
 *   repro's own case — it never runs again, so a piggybacked marker would never
 *   be written for the exact sessions this issue is about.
 *
 *   NO SCAN WINDOW, and the assertion below is INVERTED from its first version.
 *   The reader originally scanned only the last 8KB, justified as "matching
 *   `readLastMetaOffset`". That justification does not survive contact: that
 *   function windows because it does a PARTIAL read and never loads the file,
 *   while this one has already read the whole tag to answer has-classified-data.
 *   Windowing already-in-memory content bought no I/O and cost a real failure
 *   mode — on a busy session the marker is buried within minutes, and the read
 *   would have gone false-provisional forever.
 *
 *   Closer: a current-version tag with classified lines and no `_meta.swept`
 *   reads provisional; the same tag with the marker reads settled; a
 *   non-current-version tag reads provisional regardless of the marker.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	WTFT_TAGGER_VERSION,
	readTagProvisional,
	readTagFileWithVerdict,
	tagProvisionalFromContent,
} from "../extensions/lib/wtft-daemon-lib.js";
import { trackSandbox } from "./lib/sandbox";

const GREEN = "\x1b[32m", RED = "\x1b[31m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function assert(label: string, ok: boolean) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}`); failed++; }
}

const tmp = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-443-")));
const SESSION = "0a1b2c3d-4e5f-6789-abcd-ef0123456789.jsonl";

/** A classified line, in the shape `serializeClassified` actually writes: `t`
 *  for timestamp, `c` for cost, lowercase category. An earlier version of this
 *  helper used `{id, cat, cost}`, which satisfies the provisional predicate —
 *  it only asks that a line carry neither `_hb` nor `_meta` — but which
 *  `classifiedToInteraction` rejects, so it yielded zero interactions. That was
 *  invisible until a test read both halves from one buffer. Use the real shape
 *  everywhere so a fixture can never be classified-for-one-reader-only. */
function classified(id: string, cost: number): string {
	return JSON.stringify({
		t: 1787626924479, c: cost, cat: "code", f: [], cmd: [],
		id, m: "claude-sonnet-4-6", in: 1200, out: 90,
	}) + "\n";
}
const HEARTBEAT = JSON.stringify({ _hb: { first: 1, last: 2 } }) + "\n";
const OFFSET = JSON.stringify({ _meta: { offset: 4096 } }) + "\n";
const SWEPT = JSON.stringify({ _meta: { swept: 1787626924479 } }) + "\n";

/** Write a tag file at `version` holding `body`; returns its path. */
function writeTag(name: string, version: string, body: string): string {
	const p = path.join(tmp, `${name}.${SESSION}.wtft-tag.v${version}.jsonl`);
	fs.writeFileSync(p, body);
	return p;
}

console.log("wtft provisional tag read (#443)");
console.log("──────────────────────────────");
console.log(`tagger version under test: v${WTFT_TAGGER_VERSION}`);

// --- P-b: the repro's case -------------------------------------------------
{
	const p = writeTag("unswept", WTFT_TAGGER_VERSION, classified("m1", 1.5) + classified("m2", 2.5) + OFFSET);
	const r = readTagProvisional(p);
	assert("current-version tag with classified lines and no swept marker is provisional", r.provisional === true);
	assert("  ...and names 'unswept' as the reason", r.reason === "unswept");
}
{
	const p = writeTag("swept", WTFT_TAGGER_VERSION, classified("m1", 1.5) + classified("m2", 2.5) + SWEPT);
	const r = readTagProvisional(p);
	assert("the same tag carrying _meta.swept is settled", r.provisional === false);
	assert("  ...and names no reason", r.reason === null);
}
{
	// The marker must be recognised when it rides a _meta line that also carries
	// an offset — the shape flushPending writes once the sweep has happened.
	const combined = JSON.stringify({ _meta: { offset: 4096, swept: 1787626924479 } }) + "\n";
	const p = writeTag("combined", WTFT_TAGGER_VERSION, classified("m1", 1.5) + combined);
	assert("swept riding the same _meta line as offset is recognised", readTagProvisional(p).provisional === false);
}

// --- P-a: version mismatch outranks the marker ------------------------------
{
	const stale = WTFT_TAGGER_VERSION === "2.6.1" ? "2.6.0" : "2.6.1";
	const p = writeTag("oldversion", stale, classified("m1", 1.5) + SWEPT);
	const r = readTagProvisional(p);
	assert("a non-current-version tag is provisional even WITH the swept marker", r.provisional === true);
	assert("  ...and names 'stale-version', which outranks 'unswept'", r.reason === "stale-version");
}

// --- Nothing to qualify: a read that returns no total is not provisional ----
{
	const p = writeTag("empty", WTFT_TAGGER_VERSION, "");
	assert("an empty tag is not provisional (no total was returned to doubt)", readTagProvisional(p).provisional === false);
}
{
	const p = writeTag("nodata", WTFT_TAGGER_VERSION, HEARTBEAT + OFFSET);
	assert("a tag holding only _hb/_meta lines is not provisional", readTagProvisional(p).provisional === false);
}
{
	const missing = path.join(tmp, `gone.${SESSION}.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	assert("a missing tag file is not provisional", readTagProvisional(missing).provisional === false);
}

// --- The marker is POSITIONAL: it must be the last significant record -------
// The finding that produced this, from macroscopeapp on PR #511 and verified
// against the daemon: `sweptAtMs` was process-local while the marker persists in
// the FILE, and `flushPending()` runs BEFORE `scanForSubAgents()` in the same
// poll. So a new parent turn — including one that spawns a new subagent — is
// appended after a marker left by an earlier sweep or an earlier daemon. Reading
// "a marker exists" as "settled" then reports exit 0 for data no sweep has
// covered: #443's own undercount, through a narrower window.
{
	// Marker first, classified data after it — a stale marker, by construction.
	let body = SWEPT;
	for (let i = 0; i < 400; i++) body += classified(`m${i}`, 0.01);
	assert("  (fixture is large enough that a windowed scan would also have missed it)",
		Buffer.byteLength(body) > 8192);
	const p = writeTag("staleMarker", WTFT_TAGGER_VERSION, body);
	const r = readTagProvisional(p);
	assert("classified data appended AFTER a marker invalidates it", r.provisional === true);
	assert("  ...reported as 'unswept', the same reason as no marker at all", r.reason === "unswept");
}
{
	// The same bytes with the marker LAST. This is what keeps the previous case
	// honest: it proves the verdict turns on the marker's POSITION, not on file
	// size, and that there is still no scan window — the classified prefix is
	// well over 8KB and the marker is found regardless.
	let body = "";
	for (let i = 0; i < 400; i++) body += classified(`m${i}`, 0.01);
	assert("  (classified prefix exceeds any 8KB window)", Buffer.byteLength(body) > 8192);
	const p = writeTag("markerLast", WTFT_TAGGER_VERSION, body + SWEPT);
	const r = readTagProvisional(p);
	assert("the same data with the marker LAST is settled", r.provisional === false);
	assert("  ...and names no reason", r.reason === null);
}
{
	// Heartbeats and offset lines carry no cost, so they must not invalidate a
	// marker — otherwise every idle session would drift back to provisional
	// while nothing was actually happening.
	const p = writeTag("hbAfter", WTFT_TAGGER_VERSION, classified("m1", 1.5) + SWEPT + HEARTBEAT + OFFSET);
	assert("_hb and _meta.offset lines after the marker do not invalidate it",
		readTagProvisional(p).provisional === false);
}

// --- Corrupt lines must not be mistaken for data or for a marker ------------
{
	const p = writeTag("corrupt", WTFT_TAGGER_VERSION, "{not json\n" + classified("m1", 1.5));
	assert("an unparseable line is skipped, and real classified data still counts", readTagProvisional(p).provisional === true);
}
{
	const wrongType = JSON.stringify({ _meta: { swept: "yes" } }) + "\n";
	const p = writeTag("weirdswept", WTFT_TAGGER_VERSION, classified("m1", 1.5) + wrongType);
	assert("a non-numeric _meta.swept does not settle the read", readTagProvisional(p).provisional === true);
}

// --- One read, both answers ------------------------------------------------
// PR review round 3. readClassifiedTagFile and readTagProvisional each opened
// the file themselves, so a caller wanting both did TWO reads with a gap. The
// daemon is a separate OS process appending to that same file: land the
// repaired lines AND the marker inside the gap, and the caller gets the stale
// interactions with a settled verdict — #443's silent undercount again, through
// a narrower window. readTagFileWithVerdict closes it by construction.
{
	const p = writeTag("oneread", WTFT_TAGGER_VERSION, classified("m1", 1.5) + classified("m2", 2.5));
	const r = readTagFileWithVerdict(p);
	assert("readTagFileWithVerdict returns the interactions", r.interactions.length === 2);
	assert("  ...and the verdict, from the same buffer", r.provisional.provisional === true);
	assert("  ...agreeing with readTagProvisional on the same file",
		r.provisional.reason === readTagProvisional(p).reason);
}
{
	// The verdict is a pure function of (path, content), so a caller holding
	// content can never disagree with one holding the path.
	const body = classified("m1", 1.5) + SWEPT;
	const p = writeTag("purefn", WTFT_TAGGER_VERSION, body);
	assert("tagProvisionalFromContent matches the path-reading form",
		tagProvisionalFromContent(p, body).provisional === readTagProvisional(p).provisional);
}
{
	// A missing file must not throw out of the combined reader — the CLI guards
	// with existsSync, but the race that guard cannot close is this one.
	const missing = path.join(tmp, `nothere.${SESSION}.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const r = readTagFileWithVerdict(missing);
	assert("a missing tag yields no interactions and no doubt",
		r.interactions.length === 0 && r.provisional.provisional === false);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

/**
 * @package princess-pi-packages
 * @test wtft-443-daemon-swept-marker
 * @description #443 slice 2 — the WRITER half. `readTagProvisional` (slice 1)
 *   decides a tag is settled by finding `_meta.swept`; this suite pins that the
 *   daemon actually writes it, and keeps it findable.
 *
 *   The marker means: THIS daemon has completed at least one full
 *   `scanForSubAgents()` over this session. Before it exists, no subagent
 *   transcript has been read since the tag was written, which is exactly the
 *   5.7% undercount the issue measures on its specimen.
 *
 *   THE MARKER IS POSITIONAL AND RE-STAMPED, not written once. The first
 *   version was one-shot and that was wrong (macroscopeapp on PR #511, verified
 *   against the daemon): `sweptAtMs` was process-local while the marker persists
 *   in the FILE, and `flushPending()` runs BEFORE `scanForSubAgents()` in the
 *   same poll. So a new parent turn — including one that spawns a subagent —
 *   lands after a marker left by an earlier sweep or an earlier daemon, and a
 *   read in that window reported SETTLED for data no sweep had covered: #443's
 *   own undercount through a narrower window.
 *
 *   So the contract is: the marker must be the LAST significant record, and the
 *   daemon re-stamps whenever the tag grew since the last stamp. It still cannot
 *   ride the existing `_meta.offset` line, because that line is written only by
 *   `flushPending()`, which runs only when new PARENT interactions arrive — on a
 *   FINISHED session, this issue's own case, it never runs again.
 *
 *   WITHHELD ON A FAILED POLL. `pollHadFailure` is reset by the poll loop (not
 *   by `scanForSubAgents`, which runs after `flushPending` and would wipe the
 *   flush's own failure) and set by every failure handler, so a poll that could
 *   not write what it was asked to does not stamp the tag as settled over the
 *   gap. The readonly case below injects that for real with chmod 0444.
 *
 *   A session with NO subagents still gets the marker. "Nothing to sweep" and
 *   "swept" are the same state as far as a reader is concerned, and withholding
 *   it would make every subagent-free session read provisional forever.
 *
 *   Closer: spawn a daemon on a session with a subagent transcript; the tag
 *   gains `_meta.swept` and `readTagProvisional` flips from provisional to
 *   settled; a flood of later turns returns it to settled via a NEW marker (the
 *   count must rise, since "a marker exists" is true before and after); and a
 *   tag that cannot be written is never stamped at all.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
	getDaemonPidPath,
	readTagProvisional,
	WTFT_TAGGER_VERSION,
} from "../bin/wtft.mjs";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

// Private pid namespace for this suite (#486). Must precede the first
// getDaemonPidPath() and the first daemon spawn.
isolateTmpdir("443-swept");

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");

const RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function assert(label: string, ok: boolean) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}`); failed++; }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const cleanupPids: number[] = [];
const cleanupPidFiles: string[] = [];

function turnLine(id: string, tsMs: number, inputTokens: number, outputTokens: number): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			id,
			model: "claude-sonnet-4-6",
			timestamp: new Date(tsMs).toISOString(),
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
			content: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

/** A session fixture: transcript, tags dir, and (optionally) one subagent. */
function makeSession(slug: string, withSubagent: boolean) {
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), `wtft-443-${slug}-`)));
	const sessionPath = path.join(dir, "session.jsonl");
	fs.writeFileSync(sessionPath, JSON.stringify({
		type: "session", version: 3, id: `parent-443-${slug}`,
		timestamp: new Date().toISOString(), cwd: dir,
	}) + "\n");
	const tagsDir = path.join(dir, "wtft-tags");
	fs.mkdirSync(tagsDir, { recursive: true });
	cleanupPidFiles.push(getDaemonPidPath(sessionPath));

	const T0 = Date.now() - 60_000;
	if (withSubagent) {
		const subagentDir = path.join(dir, "session", "subagents");
		fs.mkdirSync(subagentDir, { recursive: true });
		let seed = "";
		for (let i = 0; i < 4; i++) seed += turnLine(`msg_443_${slug}_sub_${i}`, T0 + i * 1_000, 1000 + i * 100, 50);
		fs.writeFileSync(path.join(subagentDir, `agent-443${slug}.jsonl`), seed);
	}
	// One parent turn, so the tag holds classified data — readTagProvisional
	// deliberately says "not provisional" for a tag that yields no total.
	fs.appendFileSync(sessionPath, turnLine(`msg_443_${slug}_parent_0`, T0, 900, 40));

	const tagPath = path.join(tagsDir, path.basename(sessionPath) + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	return { dir, sessionPath, tagPath };
}

function startDaemon(sessionPath: string) {
	const child = spawn(process.execPath, [DAEMON_BIN, "--session", sessionPath], {
		detached: true, stdio: "ignore",
	});
	child.unref();
	if (child.pid) cleanupPids.push(child.pid);
	return child;
}

/** Poll until `fn()` is true, or give up. Returns whether it became true. */
async function waitFor(fn: () => boolean, tries = 40, ms = 250): Promise<boolean> {
	for (let i = 0; i < tries; i++) {
		if (fn()) return true;
		await sleep(ms);
	}
	return fn();
}

/** How many `_meta.swept` lines the tag holds. The re-stamp is only observable
 *  as an INCREASE — "a marker exists" is true before and after. */
function countSweptMarkers(tagPath: string): number {
	try {
		return fs.readFileSync(tagPath, "utf8").split("\n").filter(l => {
			if (!l.trim()) return false;
			try {
				const o = JSON.parse(l);
				return !!(o._meta && typeof o._meta.swept === "number");
			} catch { return false; }
		}).length;
	} catch { return 0; }
}

function tagHasSweptMarker(tagPath: string): boolean {
	try {
		return fs.readFileSync(tagPath, "utf8").split("\n").some(l => {
			if (!l.trim()) return false;
			try {
				const o = JSON.parse(l);
				return !!(o._meta && typeof o._meta.swept === "number");
			} catch { return false; }
		});
	} catch { return false; }
}

console.log("wtft daemon writes the _meta.swept marker (#443)");
console.log("──────────────────────────────");

try {
	// --- A session WITH a subagent: the issue's shape ----------------------
	{
		const { sessionPath, tagPath } = makeSession("sub", true);
		// Before any daemon exists there is no marker, so a populated tag reads
		// provisional. Proven against a hand-built tag in slice 1; asserted here
		// against the real writer so the two halves cannot drift apart.
		startDaemon(sessionPath);
		const gotData = await waitFor(() => fs.existsSync(tagPath) && fs.readFileSync(tagPath, "utf8").includes('"cat"'));
		assert("daemon writes classified data for a session with a subagent", gotData);

		const gotMarker = await waitFor(() => tagHasSweptMarker(tagPath));
		assert("daemon appends _meta.swept once its first sweep completes", gotMarker);
		assert("  ...and readTagProvisional flips to settled", readTagProvisional(tagPath).provisional === false);
	}

	// --- A session with NO subagent: nothing to sweep IS swept -------------
	{
		const { sessionPath, tagPath } = makeSession("nosub", false);
		startDaemon(sessionPath);
		const gotMarker = await waitFor(() => tagHasSweptMarker(tagPath));
		assert("a session with no subagents still gets the marker", gotMarker);
		assert("  ...so it does not read provisional forever", readTagProvisional(tagPath).provisional === false);
	}

	// --- A live session RE-STAMPS; it does not lean on the old marker -------
	// The end-to-end half of the positional contract, and the fix for
	// macroscopeapp's finding on PR #511: flushPending() runs BEFORE
	// scanForSubAgents() in the same poll, so new parent turns land after
	// whatever marker the tag already holds. A one-shot marker would then
	// certify data no sweep had covered. The daemon must write a NEW marker
	// after the new data, and the reader must refuse the old one until it does.
	{
		const { sessionPath, tagPath } = makeSession("busy", true);
		startDaemon(sessionPath);
		assert("busy fixture: marker present before the flood", await waitFor(() => tagHasSweptMarker(tagPath)));
		const markersBefore = countSweptMarkers(tagPath);

		const T1 = Date.now();
		let flood = "";
		for (let i = 0; i < 160; i++) flood += turnLine(`msg_443_busy_flood_${i}`, T1 + i * 10, 1200, 60);
		fs.appendFileSync(sessionPath, flood);

		// Wait for the flooded turns to REACH the tag, so what follows describes a
		// tag that really does hold data newer than the first marker.
		const landed = await waitFor(() => {
			try { return fs.readFileSync(tagPath, "utf8").includes("msg_443_busy_flood_159"); }
			catch { return false; }
		});
		assert("  (the flooded turns reached the tag)", landed);

		const settled = await waitFor(() => readTagProvisional(tagPath).provisional === false);
		assert("the tag returns to settled after the flood", settled);
		// The non-vacuous half: it is settled because a NEW marker was written,
		// not because the reader accepted the old one. "A marker exists" is true
		// before and after, so only the COUNT can tell those two apart.
		assert("  ...because the daemon re-stamped, not because the old marker was reused",
			countSweptMarkers(tagPath) > markersBefore);
	}

	// --- A failed write must not be stamped as swept -----------------------
	// PR review: flushPending cleared pendingItems BEFORE writing (pre-existing
	// on main), so a failed append lost a whole billed batch permanently — and
	// once #443 added the marker, a sweep could then stamp "settled" over the
	// gap, turning a silent undercount into an affirmative false claim.
	//
	// Injected for real rather than mocked: chmod the tag 0444 so appendFileSync
	// genuinely throws EACCES. Skips loudly under a uid that ignores the mode
	// (root, or a filesystem mounted without permissions) instead of asserting
	// something that cannot be true there.
	{
		const { sessionPath, tagPath } = makeSession("readonly", false);
		startDaemon(sessionPath);
		assert("readonly fixture: settled before the tag is locked",
			await waitFor(() => tagHasSweptMarker(tagPath)));
		const markersBefore = countSweptMarkers(tagPath);

		fs.chmodSync(tagPath, 0o444);
		let writable = true;
		try {
			fs.appendFileSync(tagPath, "");
			fs.accessSync(tagPath, fs.constants.W_OK);
		} catch { writable = false; }

		if (writable) {
			console.log("      \u2502 ##SKIP## tag still writable at mode 0444 (root or permissionless fs) — cannot inject the failure");
		} else {
			const T2 = Date.now();
			let more = "";
			for (let i = 0; i < 8; i++) more += turnLine(`msg_443_ro_${i}`, T2 + i * 10, 1300, 70);
			fs.appendFileSync(sessionPath, more);

			// Give the daemon several polls to try, fail, and NOT stamp.
			await sleep(667 * 5);
			assert("no new swept marker is written while the tag cannot be appended to",
				countSweptMarkers(tagPath) === markersBefore);

			// Restore and confirm it recovers: the retained batch lands and the
			// daemon re-stamps, so the failure is a pause, not a permanent loss.
			fs.chmodSync(tagPath, 0o644);
			const recovered = await waitFor(() => countSweptMarkers(tagPath) > markersBefore);
			assert("it recovers once the tag is writable again", recovered);
			const tag = fs.readFileSync(tagPath, "utf8");
			assert("  ...and the turns held back during the failure are not lost",
				tag.includes("msg_443_ro_7"));
			// The other direction, and the one appendToTagOrRewind exists for: the
			// batch is retried across several failed polls, so it must land ONCE,
			// not once per attempt. Counted on a raw line match rather than through
			// the reader, because dedupeClassifiedById would hide a duplicate that
			// happened to carry a message.id — and the no-id case it cannot hide is
			// exactly what the rewind protects.
			const landings = tag.split("\n").filter(l => l.includes("msg_443_ro_7")).length;
			assert(`  ...and land exactly once, not once per failed poll (${landings} === 1)`,
				landings === 1);
		}
	}
} finally {
	for (const pid of cleanupPids) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
	await sleep(300);
	for (const pid of cleanupPids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
	for (const f of cleanupPidFiles) { try { fs.unlinkSync(f); } catch { /* not there */ } }
}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

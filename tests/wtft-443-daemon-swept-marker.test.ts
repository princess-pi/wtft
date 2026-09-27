/**
 * #443 slice 2 — the WRITER half. `readTagProvisional` (slice 1)
 *   decides a tag is settled by finding `_meta.swept`; this suite pins that the
 *   daemon actually writes it, and keeps it findable.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readTagProvisional } from "../extensions/lib/wtft-daemon-lib.ts";
import { trackSandbox } from "./lib/sandbox";
import { tagSession, type TaggedSession } from "./lib/tagger-harness.ts";

const RED = "\x1b[31m", GREEN = "\x1b[32m", RESET = "\x1b[0m";
let passed = 0, failed = 0;
function assert(label: string, ok: boolean) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}`); failed++; }
}

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

/** A session fixture: transcript and (optionally) one subagent. */
function makeSession(slug: string, withSubagent: boolean) {
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), `wtft-443-${slug}-`)));
	const sessionPath = path.join(dir, "session.jsonl");
	fs.writeFileSync(sessionPath, JSON.stringify({
		type: "session", version: 3, id: `parent-443-${slug}`,
		timestamp: new Date().toISOString(), cwd: dir,
	}) + "\n");

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

	tagger = tagSession(sessionPath);
	return { dir, sessionPath, tagPath: tagger.tagPath };
}

/** The session the last makeSession tagged. */
let tagger: TaggedSession;

/** Poll until `fn()` is true, or give up. Returns whether it became true. */
function waitFor(fn: () => boolean, tries = 40): boolean {
	for (let i = 0; i < tries; i++) {
		if (fn()) return true;
		tagger.poll();
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

console.log("the tagger writes the _meta.swept marker (#443)");
console.log("──────────────────────────────");

{
	// --- A session WITH a subagent: the issue's shape ----------------------
	{
		const { tagPath } = makeSession("sub", true);
		const gotData = waitFor(() => fs.existsSync(tagPath) && fs.readFileSync(tagPath, "utf8").includes('"cat"'));
		assert("the tagger writes classified data for a session with a subagent", gotData);

		const gotMarker = waitFor(() => tagHasSweptMarker(tagPath));
		assert("the tagger appends _meta.swept once its first sweep completes", gotMarker);
		assert("  ...and readTagProvisional flips to settled", readTagProvisional(tagPath).provisional === false);
	}

	// --- A session with NO subagent: nothing to sweep IS swept -------------
	{
		const { tagPath } = makeSession("nosub", false);
		const gotMarker = waitFor(() => tagHasSweptMarker(tagPath));
		assert("a session with no subagents still gets the marker", gotMarker);
		assert("  ...so it does not read provisional forever", readTagProvisional(tagPath).provisional === false);
	}

	// --- A live session RE-STAMPS; it does not lean on the old marker -------
	// New parent turns land after whatever marker the tag already holds, so a
	// NEW marker must follow them, and the reader refuses the old one until then.
	{
		const { sessionPath, tagPath } = makeSession("busy", true);
		assert("busy fixture: marker present before the flood", waitFor(() => tagHasSweptMarker(tagPath)));
		const markersBefore = countSweptMarkers(tagPath);

		const T1 = Date.now();
		let flood = "";
		for (let i = 0; i < 160; i++) flood += turnLine(`msg_443_busy_flood_${i}`, T1 + i * 10, 1200, 60);
		fs.appendFileSync(sessionPath, flood);

		// Wait for the flooded turns to REACH the tag, so what follows describes a
		// tag that really does hold data newer than the first marker.
		const landed = waitFor(() => {
			try { return fs.readFileSync(tagPath, "utf8").includes("msg_443_busy_flood_159"); }
			catch { return false; }
		});
		assert("  (the flooded turns reached the tag)", landed);

		const settled = waitFor(() => readTagProvisional(tagPath).provisional === false);
		assert("the tag returns to settled after the flood", settled);
		// The non-vacuous half: it is settled because a NEW marker was written,
		// not because the reader accepted the old one. "A marker exists" is true
		// before and after, so only the COUNT can tell those two apart.
		assert("  ...because the tagger re-stamped, not because the old marker was reused",
			countSweptMarkers(tagPath) > markersBefore);
	}

}

console.log("\n──────────────────────────────");
console.log(`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

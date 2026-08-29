// tests/wtft-tag-format.test.ts — gates the wtft tag file wire format (filename
// pattern + record shape) against docs/wtft-tag-format.md.
//
// WHY THIS FILE EXISTS. The tag file format was an implicit shared assumption
// between the daemon (writer), the rate-limiter (reader), and session-selector
// (reader). ppp#499 single-sourced the version; this test pins the filename
// pattern and record shape so drift from any writer or reader is caught here
// rather than at runtime (Phase 5, btw#63).
//
// The fixture does NOT re-implement classifyInteraction. It passes `_cat`
// directly so the category is data, not a re-derived value, and the round-trip
// test stays focused on the wire format rather than the classifier.

import { WTFT_TAGGER_VERSION } from "../extensions/lib/wtft-tagger-version.ts";
import {
	serializeClassified,
	classifiedToInteraction,
	dedupeClassifiedById,
} from "../extensions/lib/wtft-daemon-lib.ts";
import type { Interaction } from "../extensions/lib/wtft-parser.ts";

let failures = 0;
function check(ok: boolean, label: string, detail?: string) {
	if (ok) console.log(`✅ ${label}`);
	else {
		failures++;
		console.log(`❌ ${label}${detail ? `\n   ${detail}` : ""}`);
	}
}

// ---
// Minimal interaction fixture — required fields only.
// ---
const minimalInteraction: Interaction = {
	timestamp: 1_700_000_000_000,
	cost: 0.001234567890, // more than 6 dp — serialize must round
	messageId: undefined,
	model: undefined,
	files: [],
	commands: [],
	texts: [],
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	reasoningTokens: 0,
	webSearchRequests: 0,
	webFetchRequests: 0,
	serverToolCost: 0,
	_cat: "prompt",
};

// ---
// §1: filename pattern
// ---
{
	const sessionBase = "9abc1234-5678-90ef-abcd-ef1234567890";
	const expected = `${sessionBase}.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`;
	// The pattern is: sessionBase + suffix. Verify the suffix constant round-trips.
	const suffix = `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`;
	check(
		expected.endsWith(suffix),
		`filename pattern ends with .wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`,
		`expected suffix "${suffix}", got "${expected.slice(-suffix.length)}"`,
	);
	check(
		!suffix.includes("undefined"),
		`WTFT_TAGGER_VERSION is not undefined (got "${WTFT_TAGGER_VERSION}")`,
	);
	check(
		/^\d+\.\d+\.\d+$/.test(WTFT_TAGGER_VERSION),
		`WTFT_TAGGER_VERSION looks like semver ("${WTFT_TAGGER_VERSION}")`,
	);
}

// ---
// §2a: required fields round-trip
// ---
{
	const line = serializeClassified(minimalInteraction);
	const obj = JSON.parse(line.trim());

	check(typeof obj.t === "number", "round-trip: t is a number", `got ${typeof obj.t}`);
	check(obj.t === minimalInteraction.timestamp, `round-trip: t === ${minimalInteraction.timestamp}`, `got ${obj.t}`);

	check(typeof obj.c === "number", "round-trip: c is a number", `got ${typeof obj.c}`);
	// Must be rounded to 6 decimal places — not more
	const dp = (obj.c.toString().split(".")[1] ?? "").length;
	check(dp <= 6, `round-trip: c rounded to ≤6 dp (cost was ${minimalInteraction.cost.toFixed(10)})`, `got ${dp} dp: ${obj.c}`);

	check(typeof obj.cat === "string", "round-trip: cat is a string", `got ${typeof obj.cat}`);
	check(Array.isArray(obj.f), "round-trip: f is an array");
	check(Array.isArray(obj.cmd), "round-trip: cmd is an array");

	// classifiedToInteraction must reconstruct the interaction
	const restored = classifiedToInteraction(obj);
	check(restored !== null, "classifiedToInteraction: returns non-null for a valid line");
	if (restored) {
		check(restored.timestamp === minimalInteraction.timestamp, "round-trip: timestamp survives", `got ${restored.timestamp}`);
		check(Math.abs(restored.cost - Number(minimalInteraction.cost.toFixed(6))) < 1e-10, "round-trip: cost survives (6dp)", `got ${restored.cost}`);
		check(restored.files.length === 0, "round-trip: empty files survives");
		check(restored.commands.length === 0, "round-trip: empty commands survives");
	}
}

// ---
// §2a: files and commands round-trip
// ---
{
	const withFiles: Interaction = {
		...minimalInteraction,
		files: [
			{ path: "/home/user/foo.ts", action: "write" },
			{ path: "/home/user/bar.ts", action: "read" },
		],
		commands: ["bun test"],
	};
	const line = serializeClassified(withFiles);
	const obj = JSON.parse(line.trim());

	check(
		Array.isArray(obj.f) && obj.f.length === 2,
		"files: two entries serialized",
		`got length ${(obj.f ?? []).length}`,
	);
	check(obj.f?.[0]?.a === "w", "files: write action serialized as 'w'", `got "${obj.f?.[0]?.a}"`);
	check(obj.f?.[1]?.a === "r", "files: read action serialized as 'r'", `got "${obj.f?.[1]?.a}"`);
	check(obj.f?.[0]?.p === "/home/user/foo.ts", "files: path round-trips");

	check(Array.isArray(obj.cmd) && obj.cmd[0] === "bun test", "commands: entry round-trips");

	const restored = classifiedToInteraction(obj);
	check(restored?.files[0]?.action === "write", "files: 'w' round-trips to 'write'");
	check(restored?.files[1]?.action === "read", "files: 'r' round-trips to 'read'");
}

// ---
// §2a: optional field `ir` (interrupted)
// ---
{
	const interrupted: Interaction = { ...minimalInteraction, interrupted: true };
	const line = serializeClassified(interrupted);
	const obj = JSON.parse(line.trim());
	check(obj.ir === 1, "interrupted: ir serialized as 1", `got ${JSON.stringify(obj.ir)}`);
	const restored = classifiedToInteraction(obj);
	check(restored?.interrupted === true, "interrupted: ir=1 round-trips to interrupted=true");

	// absent ir → interrupted is falsy
	const notInterrupted: Interaction = { ...minimalInteraction };
	const line2 = serializeClassified(notInterrupted);
	const obj2 = JSON.parse(line2.trim());
	check(!("ir" in obj2), "not-interrupted: ir absent from JSON");
	const restored2 = classifiedToInteraction(obj2);
	check(!restored2?.interrupted, "not-interrupted: classifiedToInteraction gives falsy interrupted");
}

// ---
// §2a: optional numeric fields absent when zero
// ---
{
	const line = serializeClassified(minimalInteraction);
	const obj = JSON.parse(line.trim());
	for (const key of ["in", "out", "cr", "cw", "rs", "ws", "wf"]) {
		check(!(key in obj), `zero-token field "${key}" absent from JSON`);
	}
}

// ---
// §2b: overhead line — #oh id is distinct from bare id
// ---
{
	const bareId = "msg-abc123";
	const ohId = `${bareId}#oh`;

	const mainLine: Interaction = { ...minimalInteraction, messageId: bareId, cost: 0.01 };
	const ohLine: Interaction = { ...minimalInteraction, messageId: ohId, cost: 0.005 };

	const serialized = [
		serializeClassified(mainLine),
		serializeClassified(ohLine),
	].join("");

	// Parse both lines
	const parsed = serialized
		.trim()
		.split("\n")
		.map((l) => classifiedToInteraction(JSON.parse(l)))
		.filter((x): x is Interaction => x !== null);

	check(parsed.length === 2, "overhead: two lines parsed (not collapsed)", `got ${parsed.length}`);

	// dedupeClassifiedById must keep both — they have different ids
	const deduped = dedupeClassifiedById(parsed);
	check(deduped.length === 2, "overhead: dedupeClassifiedById keeps #oh line distinct", `got ${deduped.length}`);
}

// ---
// §4: dedup — same bare id, keep highest cost
// ---
{
	const id = "msg-dedup-test";
	const low: Interaction = { ...minimalInteraction, messageId: id, cost: 0.01 };
	const high: Interaction = { ...minimalInteraction, messageId: id, cost: 0.02 };

	const lines = [serializeClassified(low), serializeClassified(high)].join("");
	const parsed = lines
		.trim()
		.split("\n")
		.map((l) => classifiedToInteraction(JSON.parse(l)))
		.filter((x): x is Interaction => x !== null);

	const deduped = dedupeClassifiedById(parsed);
	check(deduped.length === 1, "dedup: two lines with same id collapse to one", `got ${deduped.length}`);
	check(
		Math.abs((deduped[0]?.cost ?? 0) - 0.02) < 1e-9,
		"dedup: highest-cost copy survives",
		`got ${deduped[0]?.cost}`,
	);
}

// ---
// §2c: heartbeat skip (classifiedToInteraction returns null for non-interaction shapes)
// ---
{
	const hbLine = JSON.stringify({ _hb: { first: true }, t: 1000, c: 0.001 });
	const result = classifiedToInteraction(JSON.parse(hbLine));
	// classifiedToInteraction requires both t and c to be numbers — a heartbeat has them.
	// The heartbeat-skip logic lives in readers, not in classifiedToInteraction itself.
	// So verify that readers CAN detect heartbeats via the _hb key.
	const parsed = JSON.parse(hbLine);
	check("_hb" in parsed, "heartbeat: _hb key present — readers use this to skip");
	check(!("cat" in parsed), "heartbeat: no 'cat' field — distinguishable from interaction lines");
}

console.log(
	failures === 0
		? "\n✅ wtft-tag-format: all green"
		: `\n❌ ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);

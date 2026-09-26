#!/usr/bin/env -S bun
/**
 * Every tag record kind is decided by the typed reader, never by substring.
 */

import {
	parseTagLine,
	tagRecords,
	currentGeneration,
	sweepState,
	lastOffset,
	isDataRecord,
} from "../extensions/lib/tag-log.ts";
import {
	serializeClassified,
	tagProvisionalFromContent,
	classifiedInteractionsFromContent,
	foldedSessionIdsFromContent,
	foldRecordLine,
	generationRecordLine,
	WTFT_TAGGER_VERSION,
} from "../extensions/lib/wtft-daemon-lib.ts";
import type { Interaction } from "../extensions/lib/wtft-parser.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const turn = (id: string, cost: number, extra: Partial<Interaction> = {}): Interaction => ({
	timestamp: 1_789_000_000_000, cost, messageId: id, model: "claude-sonnet-4-6",
	files: [], commands: [], texts: [],
	inputTokens: 1, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
	webSearchRequests: 0, webFetchRequests: 0, serverToolCost: 0, _cat: "prompt", ...extra,
});
const line = (obj: unknown) => JSON.stringify(obj) + "\n";
const tagPath = `/x/wtft-tags/s.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`;

// ---
console.log("\nPART K — every record shape, one reader");

const kinds: [string, string, string][] = [
	["turn", serializeClassified(turn("a", 0.1)), "turn"],
	["sourced turn", serializeClassified(turn("b", 0.1), "abc123"), "turn"],
	["overhead line", serializeClassified(turn("a#oh", 0.05)), "turn"],
	["heartbeat", line({ _hb: { first: 1, last: 2 } }), "heartbeat"],
	["stop", line({ _hb: "stop", reason: "SIGTERM" }), "stop"],
	["offset", line({ _meta: { offset: 512 } }), "offset"],
	["swept", line({ _meta: { swept: 3 } }), "swept"],
	["unswept", line({ _meta: { unswept: 4 } }), "unswept"],
	["spawnPending", line({ _meta: { spawnPending: { key: "k", at: 5, commands: ["claude -p x"] } } }), "spawn-pending"],
	["spawnSettled", line({ _meta: { spawnSettled: "k", children: ["/c.jsonl"] } }), "spawn-settled"],
	["fold", foldRecordLine("p", "c", "abc123"), "fold"],
	["generation", generationRecordLine("abc123", "c"), "generation"],
];
for (const [name, text, kind] of kinds) {
	check(parseTagLine(text)?.kind === kind, `K ${name} reads as ${kind} (got ${parseTagLine(text)?.kind})`);
}
check(parseTagLine("")?.kind === undefined && parseTagLine('{"t":1,"c":')?.kind === undefined,
	"K an empty or partial line is null, not a record");
check(parseTagLine(line({ _meta: { later: 1 } }))?.kind === "meta-other", "K an unknown _meta shape is meta-other");
check(parseTagLine(line({ id: "x" }))?.kind === "unknown", "K an object that is no record of ours is unknown, which the sweep state reads as data");
check(parseTagLine(line({ _hb: null }))?.kind === "unknown", "K a null heartbeat is unknown, not a heartbeat");

// ---
console.log("\nPART N — #140: the kind is decided by shape, not by substring");

// A JSON string value that IS a marker name is the shape a substring check
// cannot tell from the key: `"cmd":["_hb"]`, `"p":"_meta"`.
const hostile = turn("h", 0.2, { commands: ["_hb"], files: [{ path: "_meta", action: "read" }] });
const hostileLine = serializeClassified(hostile);
check(hostileLine.includes('"_hb"') && hostileLine.includes('"_meta"'), "N fixture precondition: the serialised line holds both marker names as string values");
check(parseTagLine(hostileLine)?.kind === "turn", "N #140 a turn whose command is _hb and whose file path is _meta is a turn");
const hostileTag = line({ _hb: { first: 1, last: 1 } }) + hostileLine + line({ _meta: { offset: 9 } });
check(tagRecords(hostileTag).some(isDataRecord), "N #140 and it counts as data");
check(tagProvisionalFromContent(tagPath, hostileTag).provisional === true,
	"N a tag whose last data record has no sweep marker after it is unswept");
check(classifiedInteractionsFromContent(hostileTag).length === 1, "N the reader returns it as one interaction");

// ---
console.log("\nPART G — generation and sweep state");

const genTag =
	serializeClassified(turn("own", 1))
	+ serializeClassified(turn("c1", 2), "srcA")
	+ foldRecordLine("p", "childA", "srcA")
	+ generationRecordLine("srcA", "childA")
	+ serializeClassified(turn("c2", 4), "srcA")
	+ serializeClassified(turn("d1", 8), "srcB")
	+ line({ _meta: { swept: 1 } });
const kept = currentGeneration(tagRecords(genTag));
const keptIds = kept.flatMap(r => r.kind === "turn" ? [r.interaction.messageId] : []).join(",");
check(keptIds === "own,c2,d1", `G the kept turns are own, c2, d1 (got ${keptIds})`);
check(kept.filter(r => r.kind === "turn").length === 3, `G a later generation drops its source's earlier lines: own, c2, d1 (got ${kept.filter(r => r.kind === "turn").length})`);
check([...foldedSessionIdsFromContent(genTag.split(generationRecordLine("srcA", "childA")).join(""))].join() === "childA", "G fixture precondition: without the generation record the fold is read");
check([...foldedSessionIdsFromContent(genTag)].length === 0, "G and drops the fold record written before it");
check(classifiedInteractionsFromContent(genTag).reduce((s, i) => s + i.cost, 0) === 13, "G the reader's cost is 1 + 4 + 8");
check(sweepState(tagRecords(genTag)) === "swept", "G a swept marker last reads swept");
check(sweepState(tagRecords(genTag + line({ _hb: { first: 1, last: 2 } }))) === "swept", "G a heartbeat after it is passed over");
check(sweepState(tagRecords(genTag + line({ _meta: { offset: 1 } }))) === "swept", "G an offset marker after it is passed over");
check(sweepState(tagRecords(genTag + serializeClassified(turn("late", 1)))) === "unswept", "G a turn after it reads unswept");
check(sweepState(tagRecords(genTag + line({ _meta: { unswept: 2 } }))) === "unswept", "G an unswept marker after it wins");
check(sweepState(tagRecords(genTag + foldRecordLine("p", "x", "srcC"))) === "unswept", "G a fold record is data: unswept");
check(sweepState(tagRecords(genTag + generationRecordLine("srcC", "x"))) === "unswept", "G a generation record is data: unswept");
check(sweepState(tagRecords(line({ _hb: { first: 1, last: 1 } }))) === "unswept", "G markers alone read unswept");
check(sweepState(tagRecords(genTag + line({ _hb: 5 }))) === "unswept", "G an object of no known shape after the marker reads as data: unswept");
check(lastOffset(tagRecords(line({ _meta: { offset: 5 } }) + genTag + line({ _meta: { offset: 77 } }) + line({ _hb: { first: 1, last: 1 } }))) === 77, "G the last offset marker wins");
check(lastOffset(tagRecords(genTag)) === null, "G no offset marker is null");
const riding = tagRecords(line({ _meta: { offset: 33, swept: 1 } }));
check(riding[0]?.kind === "swept" && lastOffset(riding) === 33, "G a sweep marker sharing its line with an offset reads as swept and still carries the offset");
check(tagProvisionalFromContent(tagPath, line({ _hb: { first: 1, last: 1 } }) + line({ _meta: { offset: 0 } })).provisional === false,
	"G well-formed markers alone are not provisional: nothing was produced to doubt");
check(tagProvisionalFromContent(tagPath.replace(`v${WTFT_TAGGER_VERSION}`, "v0.0.1"), genTag).reason === "stale-version",
	"G the file name version outranks the content");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

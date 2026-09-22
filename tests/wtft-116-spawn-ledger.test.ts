#!/usr/bin/env -S bun
/**
 * the spawn ledger (#116, direction A)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	SPAWN_RECORD_SCHEMA,
	MAX_RECORD_BYTES,
	MAX_FIELD_BYTES,
	serializeSpawnRecord,
	appendSpawnRecord,
	readSpawnLedger,
	spawnLedgerPath,
	MAX_LEDGER_BYTES,
	type SpawnRecord,
} from "../extensions/lib/wtft-spawn-ledger.ts";
import { computeSpawnTree } from "../extensions/lib/wtft-spawn-tree.ts";
import { getVisualLength } from "../extensions/lib/wtft-renderer.ts";
import { claudeSpawnCwds } from "../bin/wtft.mjs";
import { spawnSync } from "node:child_process";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("116-spawn-ledger");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-116-")));

const PARENT = "9f29d624-531c-47b0-abf6-0790bb65180d";
const CHILD_A = "d38296d6-1111-4222-8333-444455556666";
const CHILD_B = "9411532a-7777-4888-8999-aaaabbbbcccc";

function rec(over: Partial<SpawnRecord> = {}): SpawnRecord {
	return {
		schema: SPAWN_RECORD_SCHEMA,
		ts: "2026-09-16T05:00:00Z",
		parent: PARENT,
		child: CHILD_A,
		mechanism: "pr-review-lens",
		...over,
	} as SpawnRecord;
}

// ---
// PART A — the writer
// ---
console.log("\nPART A — the writer refuses what cannot be resolved later");

{
	const line = serializeSpawnRecord(rec());
	check(!line.includes("\n"), "A1  a serialised record is exactly one line");
	const back = JSON.parse(line);
	check(back.schema === SPAWN_RECORD_SCHEMA, "A2  it carries the schema tag");
	check(back.parent === PARENT && back.child === CHILD_A, "A3  both ids round-trip");
	check(!("cwd" in back) || back.cwd === undefined, "A4  an absent optional field is absent, not null");
}

// A Pi session id is a timestamp PREFIXED to a uuid, so "contains a uuid" is
// the rule, not "is a uuid" — a bare-uuid rule made a Pi session unable to be a
// parent at all, which left the Pi widget's block unreachable on the only
// harness it runs in. These are ids no lookup
// could ever use: no uuid at all, or not one path component.
for (const bad of ["", "not-a-uuid", "9f29d624531c47b0abf60790bb65180d",
	`sub/${PARENT}`, `../${PARENT}`, `${PARENT}${"x".repeat(200)}`]) {
	let threw = false;
	try { serializeSpawnRecord(rec({ child: bad })); } catch { threw = true; }
	check(threw, `A5  a malformed child id is refused on write: ${JSON.stringify(bad.slice(0, 20))}`);
}
{
	let threw = false;
	try { serializeSpawnRecord(rec({ parent: "nope" })); } catch { threw = true; }
	check(threw, "A6  a malformed parent id is refused on write");
}
{
	let threw = false;
	try { serializeSpawnRecord(rec({ mechanism: "" })); } catch { threw = true; }
	check(threw, "A7  an empty mechanism is refused — the report would name nothing");
}
{
	// The per-field cap is what keeps "one line, one write(2)" true in practice:
	// two concurrent appends that interleave lose BOTH lines, not one. (The
	// basis is Linux holding the inode lock for one `write`, not PIPE_BUF —
	// that is the pipe guarantee, and the spec retracted the claim.)
	let threw = false;
	try { serializeSpawnRecord(rec({ label: "x".repeat(MAX_FIELD_BYTES + 1) })); } catch { threw = true; }
	check(threw, `A8  a label over ${MAX_FIELD_BYTES} bytes is refused`);

	// A9 used to be `MAX_RECORD_BYTES === 4096` — a constant compared to itself,
	// which is not a test of anything. The cap is reachable only through JSON
	// escape expansion, where one input character costs more than one byte on
	// the wire but only one against the field cap.
	//
	// THE FILLER CHANGED, and the reason is worth keeping. It used to be
	// `\u0001` — 6 wire bytes per character, the cheapest way to reach 4096.
	// Since PR #136 the writer REFUSES every control character outright (a
	// newline in a label forges a report row; an ESC runs in the reader's
	// terminal), so that input now fails a different check first and A9 stopped
	// testing the record cap at all. A double-quote is the next best expansion:
	// 2 wire bytes, 1 against the cap, so five capped fields still overflow
	// 4096 and the cap stays reachable and therefore still worth pinning.
	let recordThrew = "";
	try {
		serializeSpawnRecord(rec({
			cwd: '"'.repeat(MAX_FIELD_BYTES),
			label: '"'.repeat(MAX_FIELD_BYTES),
			model: '"'.repeat(MAX_FIELD_BYTES),
			mechanism: '"'.repeat(MAX_FIELD_BYTES),
		}));
	} catch (err) { recordThrew = err instanceof Error ? err.message : String(err); }
	check(/atomic-append limit/.test(recordThrew),
		`A9  a record past ${MAX_RECORD_BYTES} bytes is REFUSED, not merely capped per field (got ${recordThrew.slice(0, 80) || "no throw"})`);

	for (const badTs of ["", "yesterday", "2026-09-16", "2026-13-99T00:00:00Z"]) {
		let tsThrew = false;
		try { serializeSpawnRecord(rec({ ts: badTs })); } catch { tsThrew = true; }
		check(tsThrew, `A9b a ts that is not ISO-8601 UTC is refused: ${JSON.stringify(badTs)}`);
	}
}

{
	const ledger = path.join(dir, "append.jsonl");
	appendSpawnRecord(rec(), ledger);
	appendSpawnRecord(rec({ child: CHILD_B, label: "reasoning" }), ledger);
	const lines = fs.readFileSync(ledger, "utf8").trim().split("\n");
	check(lines.length === 2, "A10 two appends make two lines");
	check(JSON.parse(lines[1]).label === "reasoning", "A11 the second line is the second record");
}

{
	// Concurrency: N processes appending at once must produce N intact lines.
	const ledger = path.join(dir, "concurrent.jsonl");
	const N = 24;
	const script = path.join(dir, "appender.ts");
	fs.writeFileSync(script, `
import { appendSpawnRecord, SPAWN_RECORD_SCHEMA } from ${JSON.stringify(path.resolve(import.meta.dirname, "../extensions/lib/wtft-spawn-ledger.ts"))};
appendSpawnRecord({ schema: SPAWN_RECORD_SCHEMA, ts: "2026-09-16T05:00:00Z",
  parent: ${JSON.stringify(PARENT)}, child: ${JSON.stringify(CHILD_A)},
  mechanism: "concurrent", label: process.argv[2] }, ${JSON.stringify(ledger)});
`);
	const kids = [];
	for (let i = 0; i < N; i++) {
		kids.push(Bun.spawn(["bun", script, `lens-${i}`], { stdout: "ignore", stderr: "ignore" }));
	}
	await Promise.all(kids.map(k => k.exited));
	const lines = fs.readFileSync(ledger, "utf8").trim().split("\n");
	check(lines.length === N, `A12 ${N} concurrent appends make ${N} lines (got ${lines.length})`);
	let parsed = 0;
	for (const l of lines) { try { JSON.parse(l); parsed++; } catch {} }
	check(parsed === N, `A13 every concurrent line is intact JSON (${parsed}/${N})`);
}

{
	const saved = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = path.join(dir, "xdg");
	check(spawnLedgerPath() === path.join(dir, "xdg", "wtft", "spawns.jsonl"),
		"A14 XDG_STATE_HOME is honoured");
	delete process.env.XDG_STATE_HOME;
	check(spawnLedgerPath() === path.join(os.homedir(), ".local", "state", "wtft", "spawns.jsonl"),
		"A15 the default is ~/.local/state/wtft/spawns.jsonl");
	if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
}

// ---
// PART B — the reader
// ---
console.log("\nPART B — the reader counts what it skips");

{
	const ledger = path.join(dir, "read.jsonl");
	fs.writeFileSync(ledger, [
		serializeSpawnRecord(rec()),
		"{ this is not json",
		serializeSpawnRecord(rec({ child: CHILD_B })),
		JSON.stringify({ schema: "wtft/spawn@99", parent: PARENT, child: CHILD_B, ts: "x", mechanism: "m" }),
		JSON.stringify({ schema: SPAWN_RECORD_SCHEMA, parent: PARENT, ts: "x", mechanism: "m" }),
		"",
	].join("\n"));
	const led = readSpawnLedger(ledger);
	const kids = led.childrenOf.get(PARENT) ?? [];
	check(kids.length === 2, `B1  two valid edges read (got ${kids.length})`);
	check(led.malformedLines === 3,
		`B2  three unusable lines COUNTED, not swallowed (got ${led.malformedLines})`);
	check(kids[0].child === CHILD_A && kids[1].child === CHILD_B, "B3  edges keep ledger order");
	check(kids[0].mechanism === "pr-review-lens", "B4  the mechanism survives the round trip");
}

{
	const led = readSpawnLedger(path.join(dir, "does-not-exist.jsonl"));
	check(led.childrenOf.size === 0 && led.malformedLines === 0,
		"B5  an absent ledger is empty, not an error — nothing has spawned yet");
}


// ---
// PART C — the walk
// ---
console.log("\nPART C — the walk: once each, bounded, and honest about gaps");

const projects = path.join(dir, "projects");
// Resolution goes through `HarnessDiscovery.resolveSessionById`, so the
// fixture tree is pointed at by the same env seam discovery uses — not by an
// option this module invents for itself.
fs.mkdirSync(projects, { recursive: true });
process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;

/** A transcript with `turns` identical priced assistant turns, under a project
 *  dir named for its cwd — the shape a launcher child actually lands in. */
function childTranscript(uuid: string, turns: number, cwd = "/tmp/pr-review-x"): string {
	const slug = cwd.replace(/\//g, "-");
	const projDir = path.join(projects, slug);
	fs.mkdirSync(projDir, { recursive: true });
	const at = path.join(projDir, `${uuid}.jsonl`);
	const lines: string[] = [];
	for (let i = 0; i < turns; i++) {
		lines.push(JSON.stringify({
			type: "assistant",
			timestamp: new Date(Date.UTC(2026, 8, 16, 5, i)).toISOString(),
			cwd,
			message: {
				role: "assistant", id: `${uuid}-${i}`, model: "claude-opus-5",
				content: [{ type: "text", text: "x" }],
				usage: { input_tokens: 100, output_tokens: 300, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
			},
		}));
	}
	fs.writeFileSync(at, lines.join("\n") + "\n");
	return at;
}

function ledgerOf(name: string, edges: Array<Partial<SpawnRecord>>): string {
	const at = path.join(dir, name);
	fs.writeFileSync(at, edges.map(e => serializeSpawnRecord(rec(e))).join("\n") + "\n");
	return at;
}

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

{
	childTranscript(U(1), 3);
	const led = ledgerOf("one.jsonl", [{ child: U(1), label: "correctness" }]);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led });
	check(tree.descendants === 1, `C1  one recorded child resolves (got ${tree.descendants})`);
	check(tree.edges[0].resolved === true, "C2  the edge says it resolved");
	check(tree.edges[0].depth === 1, "C3  a direct child is depth 1");
	check(tree.edges[0].mechanism === "pr-review-lens", "C4  the mechanism reaches the report");
	check(tree.total.costUsd > 0 && tree.total.outputTokens === 900,
		`C5  the child's own tokens are the tree total (got ${tree.total.outputTokens})`);
	check(tree.unattributed.length === 0, "C6  nothing unattributed when everything resolves");
}

{
	// A DIAMOND: parent → A and parent → B, and BOTH A and B recorded the same
	// grandchild. The money is spent once; a naive walk bills it twice.
	childTranscript(U(10), 1); childTranscript(U(11), 1); childTranscript(U(12), 1);
	const led = ledgerOf("diamond.jsonl", [
		{ child: U(10) }, { child: U(11) },
		{ parent: U(10), child: U(12) }, { parent: U(11), child: U(12) },
	]);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led });
	check(tree.descendants === 3, `C7  a diamond counts three sessions, not four (got ${tree.descendants})`);
	check(tree.total.outputTokens === 900, `C8  the shared grandchild's cost lands ONCE (got ${tree.total.outputTokens})`);
	const dup = tree.edges.filter(e => e.child === U(12));
	check(dup.length === 2 && dup.filter(e => e.skip === "already-counted").length === 1,
		"C8b the second edge to the shared child is REPORTED as already-counted, not dropped");
}

{
	// A CYCLE. Nothing legitimate writes one, but a ledger is append-only text
	// that any process may write, so the walk must terminate on one anyway.
	childTranscript(U(20), 1); childTranscript(U(21), 1);
	// The ROOT gets a session file too. Without it the `U(21)→PARENT` edge would
	// come back `not-found` and C10 would pass with the seen-guard deleted
	// — measuring a missing fixture, not the guard.
	childTranscript(PARENT, 1);
	const led = ledgerOf("cycle.jsonl", [
		{ child: U(20) },
		{ parent: U(20), child: U(21) },
		{ parent: U(21), child: U(20) },
		{ parent: U(21), child: PARENT },
	]);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led });
	check(tree.descendants === 2, `C9  a cycle terminates and counts each session once (got ${tree.descendants})`);
	const rootEdge = tree.edges.find(e => e.child === PARENT);
	check(rootEdge !== undefined && !rootEdge.resolved && rootEdge.skip === "in-self-total",
		`C10 the root is never a descendant of itself — its money IS the self total, so a cycle back to it reads in-self-total, not a gap (got ${rootEdge?.skip})`);
}

{
	// DEPTH: a chain of EIGHT sessions (U(30)..U(37)), capped at 5. The CUT is
	// reported as an edge; what lies beyond it is not enumerated, which is what
	// a bound is. `depthCapped` therefore counts cuts, not the sessions behind
	// them, and a non-zero value means the tree is known to be partial.
	for (let i = 30; i <= 37; i++) childTranscript(U(i), 1);
	const edges: Array<Partial<SpawnRecord>> = [{ child: U(30) }];
	for (let i = 30; i < 37; i++) edges.push({ parent: U(i), child: U(i + 1) });
	const led = ledgerOf("deep.jsonl", edges);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led, maxDepth: 5 });
	check(tree.descendants === 5, `C11 the cap admits exactly maxDepth levels (got ${tree.descendants})`);
	check(tree.depthCapped === 1, `C12 the cut is reported, not silent (got ${tree.depthCapped})`);
	check(tree.maxDepth === 5, "C13 the cap in force is stated in the result");
	check(tree.edges.some(e => e.skip === "depth-capped" && e.depth === 6),
		"C13b the cut is an edge in the report, at the depth that exceeded the cap");
}

{
	// An UNRESOLVABLE child: the edge was recorded, the transcript is not there.
	const led = ledgerOf("missing.jsonl", [{ child: U(40), label: "vanished" }]);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led });
	check(tree.descendants === 0, "C14 an unresolvable child is not a descendant");
	check(tree.unattributed.length === 1, "C15 it is reported as unattributed");
	check(tree.unattributed[0].reason === "not-found", "C16 with the reason named");
	check(tree.edges[0].total === null,
		"C17 its cost is null, never 0 — a zero would launder a gap into a fact");
	check(tree.total.costUsd === 0, "C18 and it contributes nothing to the tree total");
	check(tree.edges[0].skip === "not-found", "C18b the skip reason is on the edge too");
}

{
	// A child we cannot read may still have recorded children of its own, and
	// those may be perfectly readable. Dropping the subtree with the parent
	// loses real, resolvable money over one missing file — and the grandchild
	// is an edge in the LEDGER, not an entry in the file that is missing.
	childTranscript(U(61), 2);
	const led = ledgerOf("gap-subtree.jsonl", [
		{ child: U(60) },                 // recorded, no session file
		{ parent: U(60), child: U(61) },  // its child, which IS on disk
	]);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led });
	check(tree.descendants === 1, `C23 the readable grandchild is still counted (got ${tree.descendants})`);
	check(tree.total.outputTokens === 600,
		`C23b its cost lands despite its parent being unreadable (got ${tree.total.outputTokens})`);
	check(tree.unattributed.length === 1, "C23c and the gap in the middle is still reported");
}

{
	// `unreadable` is the one skip class that is a bug rather than a fact, and
	// it has its own reason so a reader can tell it from a missing file.
	const file = childTranscript(U(70), 1);
	fs.chmodSync(file, 0o000);
	const led = ledgerOf("unreadable-child.jsonl", [{ child: U(70) }]);
	// Ask the OS whether this process can read it, rather than inferring from
	// the outcome: `descendants === 1` would also be true if the parser
	// swallowed the EACCES and returned an empty interaction list, which is the
	// zero-laundering this suite exists to forbid — and the run would print a
	// harmless-looking SKIP instead of failing.
	let canRead = true;
	try { fs.accessSync(file, fs.constants.R_OK); } catch { canRead = false; }
	const tree = computeSpawnTree(PARENT, { ledgerPath: led });
	fs.chmodSync(file, 0o644);
	if (canRead) {
		console.log("  ⏭  C24 SKIPPED — this process can read a chmod 000 file (root?)");
	} else {
		check(tree.unattributed[0]?.reason === "unreadable",
			`C24 an unreadable session file is 'unreadable', not 'not-found' (got ${tree.unattributed[0]?.reason})`);
		check(tree.edges[0].path !== null,
			"C24b and the edge still names the file that failed, so a reader can go and look");
	}
}

{
	// Every optional the ledger carries has to reach the report, or recording it
	// was wasted. `cwd` was silently dropped by the first version of this walk.
	childTranscript(U(80), 1);
	const led = ledgerOf("optionals.jsonl", [
		{ child: U(80), label: "correctness", model: "opus", cwd: "/tmp/pr-review-abc" },
	]);
	const e = computeSpawnTree(PARENT, { ledgerPath: led }).edges[0];
	check(e.label === "correctness" && e.model === "opus" && e.cwd === "/tmp/pr-review-abc",
		`C25 label, model and cwd all reach the edge (got ${JSON.stringify([e.label, e.model, e.cwd])})`);
	check(e.parent === PARENT && e.path !== null, "C25b as do parent and the resolved path");
}

{
	const led = ledgerOf("nobody.jsonl", [{ parent: U(50), child: U(51) }]);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led });
	check(tree.descendants === 0 && tree.edges.length === 0,
		"C19 another session's edges are not this session's descendants");
}

{
	const led = path.join(dir, "malformed-tree.jsonl");
	fs.writeFileSync(led, "{ nope\n" + serializeSpawnRecord(rec({ child: U(1) })) + "\n");
	const tree = computeSpawnTree(PARENT, { ledgerPath: led });
	check(tree.malformedLedgerLines === 1,
		"C20 the reader's skipped-line count reaches the report");
}



{
	// An UNREADABLE ledger must not read like an empty one. This is #116's own
	// failure mode reintroduced inside #116's fix: a zero that might mean
	// "could not look" is exactly the silence the issue is about.
	const led = path.join(dir, "unreadable.jsonl");
	fs.writeFileSync(led, serializeSpawnRecord(rec({ child: U(1) })) + "\n");
	fs.chmodSync(led, 0o000);
	let canRead = true;
	try { fs.accessSync(led, fs.constants.R_OK); } catch { canRead = false; }
	const tree = computeSpawnTree(PARENT, { ledgerPath: led });
	fs.chmodSync(led, 0o644);
	if (canRead) {
		// Running as root, or on a filesystem that ignores the mode bits.
		console.log("  ⏭  C21 SKIPPED — this process can read a chmod 000 file (root?)");
	} else {
		check(tree.descendants === 0 && tree.ledgerError !== null,
			"C21 an unreadable ledger reports ledgerError, not an empty tree");
		check(/EACCES|permission/i.test(tree.ledgerError!),
			`C21b the error names the cause (got ${tree.ledgerError})`);
	}
	const fine = computeSpawnTree(PARENT, { ledgerPath: path.join(dir, "nope.jsonl") });
	check(fine.ledgerError === null,
		"C22 an ABSENT ledger is not an error — nothing has spawned yet");
}

{
	// BREADTH, not depth. C is recorded twice: once at the end of a long chain
	// (which appears FIRST in the ledger) and once directly under the root.
	// Depth-first reached it at depth 5, put its own children at depth 6, and
	// cut them — although they are two levels from the root. The reported tree
	// depended on the order lines happened to be appended in.
	for (const n of [90, 91, 92, 93, 94, 95]) childTranscript(U(n), 1);
	const led = ledgerOf("bfs.jsonl", [
		{ child: U(90) },                 // the long chain, recorded first
		{ parent: U(90), child: U(91) },
		{ parent: U(91), child: U(92) },
		{ parent: U(92), child: U(93) },
		{ parent: U(93), child: U(94) },  // U(94) at depth 5 this way…
		{ child: U(94) },                 // …and at depth 1 this way
		{ parent: U(94), child: U(95) },  // depth 6 via the chain, 2 via direct
	]);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led, maxDepth: 5 });
	check(tree.descendants === 6,
		`C26 every session within the bound is counted, whatever order the ledger holds (got ${tree.descendants})`);
	check(tree.depthCapped === 0,
		`C26b and nothing is cut, because nothing is genuinely deeper than 5 (got ${tree.depthCapped})`);
	const deep = tree.edges.find(e => e.child === U(94) && e.resolved);
	check(deep?.depth === 1, `C26c the shared session is reached at its MINIMUM depth (got ${deep?.depth})`);
}

{
	// A child already inside SELF must not be billed a second time. A spawner is
	// free to record an edge for a child the parent's own turn already names —
	// `cd /tmp/x && claude -p --session-id <uuid>` is both mechanisms at once.
	childTranscript(U(100), 3);
	const led = ledgerOf("double.jsonl", [{ child: U(100) }]);
	const billed = computeSpawnTree(PARENT, { ledgerPath: led });
	const guarded = computeSpawnTree(PARENT, {
		ledgerPath: led, alreadyAttributed: new Set([U(100)]),
	});
	check(billed.total.outputTokens === 900, "C27 without the guard the child is counted");
	check(guarded.total.outputTokens === 0 && guarded.descendants === 0,
		`C27b with it, nothing is added a second time (got ${guarded.total.outputTokens})`);
	check(guarded.edges[0].skip === "in-self-total",
		`C27c and the edge is still REPORTED, naming why (got ${guarded.edges[0].skip})`);
	check(guarded.unattributed.length === 0,
		"C27d it is not a gap — the money landed, just not here");
}

{
	// A diamond onto a child that cannot be read: the second edge must not claim
	// `already-counted`, which asserts the money landed, and the gap must be
	// reported once, because it is one session rather than two.
	const led = ledgerOf("gap-diamond.jsonl", [
		{ child: U(110) }, { child: U(110) },
	]);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led });
	check(tree.edges.length === 2 && tree.edges[0].skip === "not-found"
		&& tree.edges[1].skip === "already-seen-unresolved",
		`C28 the repeat edge repeats the OUTCOME, it does not claim a count (got ${tree.edges[1].skip})`);
	check(tree.unattributed.length === 1,
		`C28b and one missing session is one gap, not two (got ${tree.unattributed.length})`);
}

{
	// Resolution goes through the harness seam, which takes the NEWEST copy when
	// a session id exists in two project dirs — the moved-session case (#155,
	// #6). A hand-rolled scan took whichever readdir returned first.
	const stale = childTranscript(U(120), 1, "/old/place");
	const fresh = childTranscript(U(120), 4, "/new/place");
	fs.utimesSync(stale, new Date(1), new Date(1));
	const led = ledgerOf("moved.jsonl", [{ child: U(120) }]);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led });
	check(tree.edges[0].path === fresh,
		`C29 a moved session is priced from the newest copy, not the stale one`);
	check(tree.total.outputTokens === 1200,
		`C29b which is the one with the real cost in it (got ${tree.total.outputTokens})`);
}

{
	// A child inside SELF still has its OWN recorded children, and those are NOT
	// inside self. This is the nesting the issue expects: a `claude -p` child
	// that dispatches its own pr-review lenses. Reporting the edge and then
	// dropping the subtree loses every lens.
	childTranscript(U(130), 1);
	childTranscript(U(131), 2);
	const led = ledgerOf("in-self-subtree.jsonl", [
		{ child: U(130) },
		{ parent: U(130), child: U(131) },
	]);
	const tree = computeSpawnTree(PARENT, {
		ledgerPath: led, alreadyAttributed: new Set([U(130)]),
	});
	check(tree.edges[0].skip === "in-self-total", "C30 the in-self child is reported, not added");
	check(tree.descendants === 1 && tree.total.outputTokens === 600,
		`C30b and ITS children are still walked and priced (got ${tree.descendants}, ${tree.total.outputTokens})`);
}

{
	// An oversized ledger is REFUSED, not windowed. A tail read reported the
	// truncation and every surface then had to carry a "may be missing older
	// edges" condition — a refusal cannot omit an edge silently, which is both
	// simpler and stricter (Duppy, 2026-09-16: for disk and memory limits, take
	// the simple path and wait for headroom).
	const led = path.join(dir, "huge.jsonl");
	const filler = serializeSpawnRecord(rec({ parent: U(999), child: U(998) })) + "\n";
	const fd = fs.openSync(led, "w");
	try {
		const chunk = Buffer.from(filler.repeat(500), "utf8");
		let written = 0;
		while (written <= MAX_LEDGER_BYTES) { fs.writeSync(fd, chunk); written += chunk.length; }
	} finally { fs.closeSync(fd); }

	let threw = "";
	try { readSpawnLedger(led); } catch (err) { threw = err instanceof Error ? err.message : String(err); }
	check(/over the \d+-byte limit/.test(threw) && /prune it/.test(threw),
		`C31 an oversized ledger is refused, with the remedy in the message (got ${threw.slice(0, 90) || "no throw"})`);

	const tree = computeSpawnTree(PARENT, { ledgerPath: led });
	check(tree.ledgerError !== null && tree.descendants === 0,
		"C31b and it surfaces as ledgerError — never as a quietly shortened tree");
}

{
	// Nothing repairs a partial line, and nothing needs to: a short write means
	// the disk is full, and the remedy for a full disk is a disk with space on
	// it. What matters is that the damage is REPORTED rather than silent — the
	// fragment and the record that merges into it come back as one counted
	// malformed line, so `malformedLedgerLines` is non-zero and every surface
	// says so.
	const led = path.join(dir, "fragment.jsonl");
	fs.writeFileSync(led, '{"schema":"wtft/spawn@1","ts":"2026-09-1' + "\n");
	appendSpawnRecord(rec({ child: U(150) }), led);
	const ledger = readSpawnLedger(led);
	check(ledger.malformedLines === 1, `C32 a partial line is counted, not swallowed (got ${ledger.malformedLines})`);
	check((ledger.childrenOf.get(PARENT) ?? []).length === 1,
		"C32b and a record appended after a TERMINATED fragment still reads");
}

// ---
// PART D — the issue's own Closer, through the CLI
// ---
console.log("\nPART D — the Closer: a parent, a launcher child, one record");

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_BIN = path.join(REPO_ROOT, "bin", "wtft.mjs");
const HERDR_LINE = 'herdr agent start ppt-824-serve-home-from-env --kind claude --pane wE:pCW -- --model sonnet';

{
	// The control from the issue's Repro: the launcher command does not spawn a
	// `claude` the parser can see, so no directory is searched for it at all.
	check(claudeSpawnCwds([HERDR_LINE], "/own").length === 0,
		"D1  the launcher command still yields nothing to search — nothing here re-derives an edge");
	check(claudeSpawnCwds(['cd /repo && claude -p "review this"'], null).join() === "/repo",
		"D2  the claude -p control still resolves (#138 is untouched)");
}

const cliDir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-116-cli-")));
const cliProjects = path.join(cliDir, "projects");
const stateHome = path.join(cliDir, "state");

/** The launcher child: its own uuid, its own project dir, nothing pointing back. */
const CLOSER_CHILD = "d38296d6-aaaa-4bbb-8ccc-ddddeeeeffff";
{
	const slug = "-tmp-pr-review-closer";
	fs.mkdirSync(path.join(cliProjects, slug), { recursive: true });
	const lines: string[] = [];
	for (let i = 0; i < 4; i++) {
		lines.push(JSON.stringify({
			type: "assistant",
			timestamp: new Date(Date.UTC(2026, 8, 16, 6, i)).toISOString(),
			cwd: "/tmp/pr-review-closer",
			message: {
				role: "assistant", id: `child-${i}`, model: "claude-opus-5",
				content: [{ type: "text", text: "x" }],
				usage: { input_tokens: 500, output_tokens: 1200, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0 },
			},
		}));
	}
	fs.writeFileSync(path.join(cliProjects, slug, `${CLOSER_CHILD}.jsonl`), lines.join("\n") + "\n");
}

/** The parent: a real bash turn carrying the launcher command, plus its own spend. */
function parentTranscript(): string {
	const at = path.join(cliDir, `${PARENT}.jsonl`);
	const turn = (i: number, block: unknown) => JSON.stringify({
		type: "assistant",
		timestamp: new Date(Date.UTC(2026, 8, 16, 5, i)).toISOString(),
		cwd: "/home/princess-pi/git-projects/wtft",
		message: {
			role: "assistant", id: `parent-${i}`, model: "claude-opus-5",
			content: [block],
			usage: { input_tokens: 100, output_tokens: 300, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
		},
	});
	fs.writeFileSync(at, [
		turn(0, { type: "text", text: "dispatching" }),
		turn(1, { type: "tool_use", id: "t1", name: "Bash", input: { command: HERDR_LINE } }),
		turn(2, { type: "text", text: "done" }),
	].join("\n") + "\n");
	return at;
}

let runSeq = 0;
/** Each run gets its own copy of the parent transcript: the CLI's tag file is
 *  written beside the session, and a shared fixture would let one run's repair
 *  move the next run's number (the #90 suite hit this and fixed it the same way). */
function cli(args: string[], env: Record<string, string> = {}): { out: string; status: number | null } {
	const source = parentTranscript();
	const copyDir = path.join(cliDir, `run-${runSeq++}`);
	fs.mkdirSync(copyDir, { recursive: true });
	const copy = path.join(copyDir, `${PARENT}.jsonl`);
	fs.copyFileSync(source, copy);
	const r = spawnSync("node", [CLI_BIN, "-s", copy, ...args], {
		encoding: "utf8",
		env: { ...process.env, XDG_STATE_HOME: stateHome, WTFT_CLAUDE_PROJECTS_DIR: cliProjects, ...env },
	});
	if (r.status !== 0 && r.status !== 9) {
		throw new Error(`wtft -s <copy> ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
	}
	return { out: (r.stdout || "").replace(/\x1b\[[0-9;]*m/g, ""), status: r.status };
}

function recordCli(args: string[]): { status: number | null; out: string; err: string } {
	const r = spawnSync("node", [CLI_BIN, "spawn-record", ...args], {
		encoding: "utf8",
		env: { ...process.env, XDG_STATE_HOME: stateHome },
	});
	return { status: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// --- the writer, as a spawner would call it ---
{
	const bad = recordCli(["--parent", PARENT, "--child", "not-a-uuid", "--mechanism", "herdr-agent-start"]);
	check(bad.status === 2, `D3  a malformed child id exits 2, at the spawner (got ${bad.status})`);
	const missing = recordCli(["--parent", PARENT, "--child", CLOSER_CHILD]);
	check(missing.status === 2, `D4  a missing --mechanism exits 2 (got ${missing.status})`);
	check(!fs.existsSync(path.join(stateHome, "wtft", "spawns.jsonl")),
		"D5  neither refusal wrote a line");

	const ok = recordCli(["--parent", PARENT, "--child", CLOSER_CHILD,
		"--mechanism", "herdr-agent-start", "--label", "agent/824", "--model", "sonnet", "--json"]);
	check(ok.status === 0, `D6  a good record exits 0 (got ${ok.status}: ${ok.err.trim()})`);
	const echoed = JSON.parse(ok.out.trim());
	check(echoed.child === CLOSER_CHILD && echoed.mechanism === "herdr-agent-start",
		"D7  --json echoes the exact line written");
	const onDisk = fs.readFileSync(path.join(stateHome, "wtft", "spawns.jsonl"), "utf8").trim();
	check(JSON.parse(onDisk).label === "agent/824", "D8  and the ledger holds it");

	const unknown = recordCli(["--parent", PARENT, "--child", CLOSER_CHILD, "--mechansim", "typo"]);
	check(unknown.status === 2 && /unknown argument --mechansim/.test(unknown.err),
		"D8b a typo'd flag NAMES itself instead of blaming a missing one (#91)");
	const noValue = recordCli(["--parent", PARENT, "--child", CLOSER_CHILD, "--mechanism"]);
	check(noValue.status === 2 && /--mechanism needs a value/.test(noValue.err),
		"D8c a flag with no value says which flag");
	const eqForm = recordCli([`--parent=${PARENT}`, `--child=${CLOSER_CHILD}`, "--mechanism=eq-form", "--json"]);
	check(eqForm.status === 0 && JSON.parse(eqForm.out).mechanism === "eq-form",
		"D8d --flag=value works, and is therefore documented");
	const help = recordCli(["--help"]);
	check(help.status === 0 && /--parent/.test(help.out),
		"D8e --help prints the usage");
	// The flag is REFUSED, not merely undocumented — the previous spelling of
	// this check searched the README for the string "--ts", which the sentence
	// explaining its absence then made fail. Ask the code.
	const withTs = recordCli(["--parent", PARENT, "--child", CLOSER_CHILD,
		"--mechanism", "m", "--ts", "1999-01-01T00:00:00Z"]);
	check(withTs.status === 2 && /unknown argument --ts/.test(withTs.err),
		`D8f there is no --ts: the clock fills it, so the ledger cannot disagree with itself (got ${withTs.status})`);
	check(!/--ts\b/.test(help.out), "D8g the usage does not offer it either");
	const quiet = recordCli(["--parent", PARENT, "--child", CLOSER_CHILD, "--mechanism", "quiet"]);
	check(quiet.status === 0 && quiet.out === "",
		"D8h without --json the writer prints nothing at all");

	// Exit 3: the record is fine and the ledger cannot be written. A spawner is
	// told to ignore it, which only works if it is a DIFFERENT code from 2.
	const notADir = path.join(cliDir, "not-a-dir.txt");
	fs.writeFileSync(notADir, "i am a file\n");
	const blocked = spawnSync("node", [CLI_BIN, "spawn-record",
		"--parent", PARENT, "--child", CLOSER_CHILD, "--mechanism", "blocked"], {
		encoding: "utf8",
		env: { ...process.env, XDG_STATE_HOME: notADir },
	});
	check(blocked.status === 3, `D8i an unwritable ledger exits 3, not 2 (got ${blocked.status})`);

	// Re-normalise the ledger for the report assertions below.
	fs.writeFileSync(path.join(stateHome, "wtft", "spawns.jsonl"), "");
	recordCli(["--parent", PARENT, "--child", CLOSER_CHILD,
		"--mechanism", "herdr-agent-start", "--label", "agent/824", "--model", "sonnet"]);
}

// --- the report, with the record ---
let selfCostWithRecord = 0;
{
	const doc = JSON.parse(cli(["--json"]).out);
	check(doc.spawned?.descendants === 1,
		`D9  the recorded child is a descendant (got ${doc.spawned?.descendants})`);
	check(doc.spawned.edges[0].mechanism === "herdr-agent-start",
		"D10 the edge's provenance is in the document");
	check(doc.spawned.edges[0].total.costUsd > 0, "D11 the child's cost is read");
	check(Math.abs(doc.tree.costUsd - (doc.total.costUsd + doc.spawned.total.costUsd)) < 1e-9,
		"D12 tree = total + spawned, as a field, so nobody adds two numbers and guesses");
	check(doc.total.costUsd > 0, "D13 the parent still reports its own spend");
	check(doc.spawned.edges[0].model === "sonnet" && doc.spawned.edges[0].label === "agent/824",
		"D13b the model and label the spawner recorded reach the document");
	check(doc.spawned.schema === "wtft/spawn-tree@2" && doc.spawned.maxDepth === 5
		&& doc.spawned.ledgerError === null && doc.spawned.malformedLedgerLines === 0
		&& doc.spawned.depthCapped === 0 && Array.isArray(doc.spawned.unattributed),
		"D13c every field of the tree contract is present, not just the ones with news in them");
	check(doc.schema === "wtft/session@5",
		"D13d the document that gained `spawned` and `tree` says so in its schema");
	const keys = Object.keys(doc);
	check(keys.indexOf("spawned") === keys.indexOf("uncounted") + 1 && keys.indexOf("tree") === keys.indexOf("spawned") + 1,
		"D13e the wire order is the documented order — JSON.stringify emits this literal");
	selfCostWithRecord = doc.total.costUsd;
}

// --- the same run with the record deleted ---
{
	fs.writeFileSync(path.join(stateHome, "wtft", "spawns.jsonl"), "");
	const doc = JSON.parse(cli(["--json"]).out);
	check(doc.spawned.descendants === 0, "D14 delete the record and the child is not claimed");
	check(Math.abs(doc.total.costUsd - selfCostWithRecord) < 1e-9,
		"D15 SELF IS UNCHANGED either way — the ledger only ever adds");
	check(Math.abs(doc.tree.costUsd - doc.total.costUsd) < 1e-9,
		"D16 and tree collapses to self");
}

// --- the rendered surface ---
{
	const noEdges = cli(["--tokens"]).out;
	check(!noEdges.includes("SPAWNED"),
		"D17 no block for a session that spawned nothing — silence is the right report");

	const r = recordCli(["--parent", PARENT, "--child", CLOSER_CHILD, "--mechanism", "herdr-agent-start", "--label", "agent/824"]);
	check(r.status === 0, "D18 re-record the edge");
	const withEdges = cli(["--tokens"]).out;
	check(withEdges.includes("SPAWNED"), "D19 the block appears once there is an edge");
	check(withEdges.includes("herdr-agent-start"), "D20 naming the mechanism");

	// D21 used to be /TREE/.test(...) — a substring, not the number it names.
	// Read the three figures off the table and hold them to each other, which
	// is the only version that fails when the arithmetic is wrong.
	const money = (label: string): number | null => {
		// `^\s*` — the CLI pads every rendered line by `--pad` (default 1).
		const m = new RegExp(`^\\s*${label}\\s+.*?\\$([0-9.]+)\\s*$`, "m").exec(withEdges);
		return m ? Number(m[1]) : null;
	};
	const totalRow = money("TOTAL"), spawnedRow = money("SPAWNED"), treeRow = money("TREE");
	check(totalRow !== null && spawnedRow !== null && treeRow !== null,
		`D21 the table prints TOTAL, SPAWNED and TREE figures (got ${JSON.stringify([totalRow, spawnedRow, treeRow])})`);
	check(treeRow !== null && Math.abs(treeRow - (totalRow! + spawnedRow!)) < 0.01,
		`D21b TREE is TOTAL + SPAWNED in the RENDERED table too (${totalRow} + ${spawnedRow} vs ${treeRow})`);

	const jsonDoc = JSON.parse(cli(["--json"]).out);
	check(Math.abs(totalRow! - jsonDoc.total.costUsd) < 0.01 && Math.abs(treeRow! - jsonDoc.tree.costUsd) < 0.01,
		"D22 and the two surfaces report the same two numbers");
	check(withEdges.indexOf("TOTAL") < withEdges.indexOf("SPAWNED"),
		"D22b with SPAWNED below TOTAL, which still means this session's own turns");
}

{
	// An unreadable ledger renders its own block. Rendering the same silence as
	// "spawned nothing" is #116's failure mode wearing #116's fix as a disguise.
	const ledger = path.join(stateHome, "wtft", "spawns.jsonl");
	fs.chmodSync(ledger, 0o000);
	const out = cli(["--tokens"]).out;
	const doc = JSON.parse(cli(["--json"]).out);
	fs.chmodSync(ledger, 0o644);
	if (doc.spawned.ledgerError === null) {
		console.log("  ⏭  D23 SKIPPED — this process can read a chmod 000 file (root?)");
	} else {
		check(/could not be read/.test(out),
			"D23 --tokens says the ledger could not be read");
		check(/descendants unknown, not zero/.test(out),
			"D23b in those words — a zero would be a claim we do not have");
		check(!/^\s*TREE\s/m.test(out),
			"D23c and prints NO tree total, because there is no tree to total");
	}
}


// --- D24: an empty own-total does not erase the lineage ---
//
// Round-4 review, Medium/contract. `--json` reports `spawned` on the no-data and
// pending arms through `emitSessionJson`; the RENDERED arms returned inside
// `finishEmptyReport`, before `renderTokenSummary` was ever reached. A parent
// whose own tag has no classified data yet — the ordinary state of a launcher
// that spawns and then waits — printed nothing at all about children worth real
// money, and exited 0 saying so. Two surfaces, one state, opposite answers.
{
	// A session file that exists and parses to zero interactions: one user line,
	// no assistant turn. That is the no-data arm, not the pending arm (which
	// needs the file absent).
	// Its OWN uuid, not PARENT's. Sharing the id made the moved-session follow
	// (#155) resolve this path to the populated copy under run-N/ and report that
	// session's $0.0315 as "the empty parent's own total" — a fixture bug that
	// looked exactly like the contract violation under test.
	const EMPTY_PARENT = "c47f1a90-1111-4222-8333-444455556666";
	const emptyDir = path.join(cliDir, "empty-parent");
	fs.mkdirSync(emptyDir, { recursive: true });
	const emptyPath = path.join(emptyDir, `${EMPTY_PARENT}.jsonl`);
	fs.writeFileSync(emptyPath, JSON.stringify({
		type: "user",
		timestamp: new Date(Date.UTC(2026, 8, 16, 5, 0)).toISOString(),
		message: { role: "user", content: "no assistant turn here" },
	}) + "\n");

	// The edge is recorded, and it points at a child with real spend.
	const rec = recordCli(["--parent", EMPTY_PARENT, "--child", CLOSER_CHILD, "--mechanism", "herdr-agent-start", "--label", "agent/824"]);
	check(rec.status === 0, "D24 the edge is recorded before the empty-total run");

	const run = (args: string[]) => spawnSync("node", [CLI_BIN, "-s", emptyPath, ...args], {
		encoding: "utf8",
		env: { ...process.env, XDG_STATE_HOME: stateHome, WTFT_CLAUDE_PROJECTS_DIR: cliProjects },
	});

	const rendered = run(["--tokens"]);
	// Exit 1 here means the daemon died before writing anything — a fact about
	// this host, not about the lineage. Skip VISIBLY rather than pass: a silent
	// skip and a pass look identical in the summary line, which is the whole
	// failure mode this suite was written against.
	if (rendered.status === 1) {
		console.log("  ⏭  D24 SKIPPED — the daemon exited before writing; nothing to render against");
	} else {
		const out = (rendered.stdout || "").replace(/\x1b\[[0-9;]*m/g, "");
		check(out.includes("SPAWNED"),
			`D24a a session with no turns of its own STILL reports its recorded children (got ${JSON.stringify(out.slice(0, 200))})`);
		check(out.includes("herdr-agent-start"),
			"D24b naming the mechanism, exactly as the populated arm does");

		// And the two surfaces agree, which is the property that was broken.
		const jsonRun = run(["--json"]);
		const doc = JSON.parse(jsonRun.stdout);
		check(doc.spawned.descendants === 1,
			`D24c --json reports the same one descendant (got ${doc.spawned.descendants})`);
		check(Math.abs(doc.total.costUsd) < 1e-12,
			`D24d while this session's OWN total is still zero — the lineage is reported BESIDE it, never folded in (total=${doc.total.costUsd}, spawned=${doc.spawned.total?.costUsd}, tree=${doc.tree.costUsd})`);
		check(doc.tree.costUsd > 0,
			"D24e and tree carries the descendant's money, so the run is not reporting $0 overall");
	}
}


// --- D25: a spawner cannot forge report rows or drive the reader's terminal ---
//
// `mechanism` and `label` are free text from a
// spawner, and this block prints them into a padded column. A newline
// round-trips through JSON perfectly — stringify escapes it, parse restores it —
// so `padEnd` would emit a row that is really two, and a spawner could forge
// report lines showing whatever money it liked. An ESC starts a sequence the
// reader's terminal executes.
//
// Two layers, tested as two: the writer REFUSES, and the renderer SANITISES
// anyway — because the ledger is a file on disk that can be hand-edited or
// written by an older build, which is the one case a writer guard cannot cover.
{
	const LEDGER = path.join(stateHome, "wtft", "spawns.jsonl");

	// -- layer 1: the writer refuses --
	const nl = recordCli(["--parent", PARENT, "--child", CLOSER_CHILD, "--mechanism", "herdr-agent-start",
		"--label", "agent/824\nSPAWNED    forged-row                                   $99.99"]);
	check(nl.status === 2, `D25 a label carrying a newline is refused (exit ${nl.status})`);
	check(/control character/i.test(nl.err), `D25a and the refusal says why (${JSON.stringify(nl.err.slice(0, 140))})`);

	const esc = recordCli(["--parent", PARENT, "--child", CLOSER_CHILD, "--mechanism", "herdr-agent-start",
		"--label", "agent/824\u001b]0;pwned\u0007"]);
	check(esc.status === 2, `D25b an OSC escape sequence is refused too (exit ${esc.status})`);

	// -- layer 2: the renderer sanitises a record the writer never saw --
	//
	// The payload must land INSIDE the 40-column name field. The earlier fixture
	// used a long `SPAWNED    forged-row ... $99.99` label, and the field own
	// truncation cut it off before the assertions ever saw it -- so D25c passed
	// with `safe()` DELETED from the row. Measured, not reasoned: the mutation
	// was applied and the suite stayed green. Short payloads only, from here.
	//
	// D25d was worse: the old layer-2 ledger carried NO escape sequence at all,
	// so "no OSC survives" asserted the absence of something never present. The
	// second record below is the one that makes it a test.
	const rec2 = (child: string, label: string, min: number) => JSON.stringify({
		schema: "wtft/spawn@1", parent: PARENT, child,
		ts: new Date(Date.UTC(2026, 8, 16, 6, min)).toISOString(),
		mechanism: "herdr-agent-start", label,
	});
	const OSC = "b" + String.fromCharCode(27) + "]0;pwned" + String.fromCharCode(7) + "c";
	fs.writeFileSync(LEDGER,
		rec2(CLOSER_CHILD, "a\nFORGED $9.99", 0) + "\n" +
		rec2(CHILD_A, OSC, 1) + "\n");

	const out = cli(["--tokens"]).out;
	// One edge must render as ONE line. Column 0 is NOT the discriminator here:
	// the block indents every physical line, so a split row lands at column 1,
	// not 0 -- measured, by deleting `safe()` and watching a column-0 assertion
	// stay green. What actually changes is that the label text leaves its own
	// mechanism behind, so pin them together.
	const carriesForged = out.split("\n").filter(l => l.includes("FORGED"));
	check(carriesForged.length > 0 && carriesForged.every(l => l.includes("herdr-agent-start")),
		`D25c a hand-written newline cannot split one edge off from its own mechanism onto a line of its own (${JSON.stringify(carriesForged.map(l => l.slice(0, 40)))})`);
	check(!out.includes(String.fromCharCode(27) + "]"),
		"D25d and an OSC sequence that IS present in the ledger does not survive into the rendered output");
	check(out.includes("\uFFFD"),
		"D25e and the replacement character is VISIBLE, so a reader can tell a label was tampered with rather than merely short");
}


// --- D27: the ERROR message is untrusted text too ---
//
// and it is the same vector as D25 arriving at the
// one code path that returns BEFORE D25's sanitiser ran.
//
// `renderSpawnTree` prints `spawned.ledgerError` and returns early. That message
// embeds the ledger PATH, and the path is built from `XDG_STATE_HOME`, which the
// caller controls. So a newline in the environment variable forges report rows
// exactly as a newline in a `label` would, and an ESC starts a sequence the
// reader's terminal executes.
//
// Worth its own test rather than an extra assertion on D25, because the defect
// was NOT a missing sanitiser — it was a sanitiser declared below the arm that
// needed it. A test that only exercised the edge-rendering path would go on
// passing while this arm stayed raw, which is precisely what happened.
{
	const evilHome = path.join(cliDir, "evil\nSPAWNED    forged-error-row                             $99.99");
	fs.mkdirSync(path.join(evilHome, "wtft"), { recursive: true });
	// A directory where the ledger file should be: readable path, unreadable as a
	// ledger, so the error arm renders and the path lands in the message.
	fs.mkdirSync(path.join(evilHome, "wtft", "spawns.jsonl"), { recursive: true });

	const evil = spawnSync("node", [CLI_BIN, "-s", parentTranscript(), "--tokens"], {
		encoding: "utf8",
		env: { ...process.env, XDG_STATE_HOME: evilHome, WTFT_CLAUDE_PROJECTS_DIR: cliProjects },
		timeout: 30_000,
	});
	const out = (evil.stdout ?? "") + (evil.stderr ?? "");

	check(/could not be read/i.test(out),
		"D27 a ledger path that is a directory renders the error arm — the arm under test");
	// The property is NOT "the text never appears" — the sanitised path legitimately
	// still contains it, inline, on the error-detail line. The property is that it
	// cannot BECOME A ROW: no line may START with it, and it may not be split
	// across two lines. An earlier spelling of this assertion demanded the text be
	// absent entirely and failed against the correct output, which would have read
	// as a live vulnerability.
	const carrying = out.split("\n").filter(l => l.includes("forged-error-row"));
	// D27a is the weak half and is labelled as such: measured against the unfixed
	// renderer it PASSES, because the forged row replaces the detail line rather
	// than adding one. D27a2 and D27b are the assertions with teeth — both fail
	// RED, D27a2 reporting `SPAWNED    forged-error-row` sitting at column 0.
	// Kept anyway, because a future defect that ADDS a line is a different shape
	// and this is the only assertion that would catch it.
	check(carrying.length <= 1,
		`D27a a newline in XDG_STATE_HOME cannot split the message across lines (${carrying.length} lines carry it)`);
	check(!carrying.some(l => /^\S/.test(l)),
		`D27a2 and what survives stays INDENTED as error detail, never at column 0 where a report row starts (${JSON.stringify(carrying.map(l => l.slice(0, 40)))})`);
	check(out.includes("�"),
		"D27b the replacement character is visible, so a reader can tell the path was tampered with");
}


// --- D26: a FIFO at the ledger path is refused, not waited on ---
//
// `statSync(path)`
// then `readFileSync(path)` is wrong twice: the size that passed the 8 MiB check
// belonged to a file that may have grown by the time the second call opens it
// (so the advertised refusal did not hold), and `readFileSync` on a named pipe
// with no writer NEVER RETURNS — `wtft --json` hung instead of reporting
// `spawned.ledgerError`. The writer had the same shape: `openSync(file, "a")`
// blocks on a FIFO before it can exit 3.
//
// Both now open once with O_NONBLOCK and ask the DESCRIPTOR what it is.
//
// The timeout is the assertion here. A test that merely checks an exit code
// would pass by hanging until the suite is killed, which is the bug.
{
	const fifoDir = path.join(cliDir, "fifo-state", "wtft");
	fs.mkdirSync(fifoDir, { recursive: true });
	const fifo = path.join(fifoDir, "spawns.jsonl");
	const mk = spawnSync("mkfifo", [fifo], { encoding: "utf8" });

	if (mk.status !== 0) {
		console.log("  SKIPPED D26 - mkfifo unavailable on this host; nothing to point at");
	} else {
		const fifoEnv = { ...process.env, XDG_STATE_HOME: path.join(cliDir, "fifo-state"), WTFT_CLAUDE_PROJECTS_DIR: cliProjects };

		// -- the reader --
		const src = parentTranscript();
		const copyDir = path.join(cliDir, "fifo-run");
		fs.mkdirSync(copyDir, { recursive: true });
		const copy = path.join(copyDir, `${PARENT}.jsonl`);
		fs.copyFileSync(src, copy);

		const read = spawnSync("node", [CLI_BIN, "-s", copy, "--json"], {
			encoding: "utf8", env: fifoEnv, timeout: 30_000,
		});
		check(read.signal !== "SIGTERM" && read.error === undefined,
			`D26 the report does not hang on a FIFO ledger (signal=${read.signal}, error=${read.error?.message})`);
		if (read.stdout) {
			const doc = JSON.parse(read.stdout);
			check(doc.spawned.ledgerError !== null,
				`D26a it reports ledgerError instead (${JSON.stringify(doc.spawned.ledgerError)})`);
			check(/not a regular file/i.test(String(doc.spawned.ledgerError)),
				"D26b naming what it found, so the human can go delete it");
		}

		// -- the writer --
		const write = spawnSync("node", [CLI_BIN, "spawn-record",
			"--parent", PARENT, "--child", CLOSER_CHILD, "--mechanism", "herdr-agent-start"], {
			encoding: "utf8", env: fifoEnv, timeout: 30_000,
		});
		check(write.signal !== "SIGTERM" && write.error === undefined,
			`D26c spawn-record does not hang on a FIFO ledger (signal=${write.signal})`);
		check(write.status === 3,
			`D26d it exits 3 — the unwritable-ledger code a spawner already ignores (got ${write.status})`);
	}
}


// --- D28: a wide-character label cannot shift the money column ---
//
// The row is built with `full.length > 40` and
// `name.padEnd(40)`. Both count UTF-16 CODE UNITS; a terminal lays out COLUMNS.
// A BMP wide character — CJK, Hangul, the fullwidth forms — is ONE code unit and
// TWO columns, so 40 of them pass the width check untouched, `padEnd(40)` adds
// nothing, and every money figure in the block shifts right by 40.
//
// Same disease as #130's byte-offset-as-string-index: a count taken in one space
// and spent in another. `getVisualLength` already exists for exactly this, and
// lives in the same file as the row that does not call it.
//
// Astral emoji do NOT expose it — a surrogate pair is two code units AND two
// columns, so the two measures agree by coincidence and a 🐱 fixture would pass
// against the broken code. The fixture uses CJK deliberately and ASSERTS the
// divergence first, so it cannot quietly stop exercising the bug.
{
	const LEDGER = path.join(stateHome, "wtft", "spawns.jsonl");
	const WIDE = "貓".repeat(40);        // 40 code units, 80 columns
	const NARROW = "cat".repeat(14);          // 42 code units, 42 columns

	check(WIDE.length === 40 && getVisualLength(WIDE) === 80,
		`D28 fixture precondition: the wide label is 40 code units and 80 columns — the gap under test (len=${WIDE.length}, visual=${getVisualLength(WIDE)})`);
	check(NARROW.length === getVisualLength(NARROW),
		`D28a fixture precondition: the ASCII control label measures the same in both spaces (len=${NARROW.length}, visual=${getVisualLength(NARROW)})`);

	const rec = (child: string, label: string, min: number) => JSON.stringify({
		schema: "wtft/spawn@1", parent: PARENT, child,
		ts: new Date(Date.UTC(2026, 8, 16, 6, min)).toISOString(),
		mechanism: "herdr-agent-start", label,
	});
	// Two children that BOTH fail to resolve, so both rows carry the same money
	// text.
	const UNRESOLVABLE_A = "d38296d6-2222-4333-8444-555566667777";
	const UNRESOLVABLE_B = "d38296d6-3333-4444-8555-666677778888";
	fs.writeFileSync(LEDGER, rec(UNRESOLVABLE_A, NARROW, 0) + "\n" + rec(UNRESOLVABLE_B, WIDE, 1) + "\n");

	const lines = cli(["--tokens"]).out.split("\n");
	const wideRow = lines.find(l => l.includes("貓"));
	const narrowRow = lines.find(l => l.includes("cat"));
	check(wideRow !== undefined && narrowRow !== undefined,
		`D28b both edges render a row (wide=${wideRow !== undefined}, narrow=${narrowRow !== undefined})`);
	// No magic column constant here on purpose: the money field is `padStart(12)`
	// and padStart does NOT truncate, so a long skip reason makes the TOTAL row
	// width vary by design, and the block's own indent has been miscounted twice
	// while writing this test. Pin the fixture instead — assert both rows carry
	// the SAME money text, which makes equal row width mean equal name width,
	// and nothing else.
	const moneyOf = (row: string) => row.trim().split(/\s+/).pop()!;
	if (wideRow && narrowRow) {
		check(moneyOf(wideRow) === moneyOf(narrowRow),
			`D28c fixture precondition: both edges render the same money text, so row width isolates the NAME field (narrow=${moneyOf(narrowRow)}, wide=${moneyOf(wideRow)})`);
		check(getVisualLength(wideRow) === getVisualLength(narrowRow),
			`D28d a wide-character label occupies the same terminal columns as an ASCII one, so the money column stays put (narrow=${getVisualLength(narrowRow)}, wide=${getVisualLength(wideRow)})`);
	}
}


console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

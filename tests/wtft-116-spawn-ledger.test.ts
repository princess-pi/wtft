#!/usr/bin/env -S bun
/**
 * tests/wtft-116-spawn-ledger.test.ts — the spawn ledger (#116, direction A)
 *
 * A launcher-spawned session contributes ZERO to its parent today, and no
 * amount of re-parsing can change that: the parent's transcript has no `cd`
 * and no `claude` at the command head, the child lives in a project dir the
 * parent never wrote to, and NEITHER TRANSCRIPT CONTAINS A FIELD NAMING THE
 * OTHER. There is no edge to re-derive. So the spawner writes it down at spawn
 * time, when it is free.
 *
 * Part A — the writer refuses what it cannot resolve later (bad UUID, oversized
 *          record), and one record is one atomic append.
 * Part B — the reader counts what it skips. A malformed line that vanishes
 *          silently is money that vanishes silently.
 * Part C — the walk: a diamond counts once, a cycle terminates, depth is capped
 *          and REPORTED, an unresolvable child is `unattributed` with a null
 *          cost — never a zero, which would launder a gap into a fact.
 * Part D — the issue's own Closer, end to end through the CLI.
 *
 * Spec: docs/spec-116-spawn-ledger.md
 * Run:  bun tests/wtft-116-spawn-ledger.test.ts
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
	type SpawnRecord,
} from "../extensions/lib/wtft-spawn-ledger.ts";
import { computeSpawnTree } from "../extensions/lib/wtft-spawn-tree.ts";
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

for (const bad of ["", "not-a-uuid", "9f29d624531c47b0abf60790bb65180d", PARENT + "x"]) {
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
	// The 4 KiB refusal is what keeps "one line, one write(2)" true: past
	// PIPE_BUF two concurrent appends can interleave and BOTH lines are lost.
	let threw = false;
	try { serializeSpawnRecord(rec({ label: "x".repeat(MAX_FIELD_BYTES + 1) })); } catch { threw = true; }
	check(threw, `A8  a label over ${MAX_FIELD_BYTES} bytes is refused`);
	check(MAX_RECORD_BYTES === 4096, "A9  the record cap is PIPE_BUF, not an arbitrary number");
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
	const tree = computeSpawnTree(PARENT, { ledgerPath: led, projectsRoot: projects });
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
	const tree = computeSpawnTree(PARENT, { ledgerPath: led, projectsRoot: projects });
	check(tree.descendants === 3, `C7  a diamond counts three sessions, not four (got ${tree.descendants})`);
	check(tree.total.outputTokens === 900, `C8  the shared grandchild's cost lands ONCE (got ${tree.total.outputTokens})`);
}

{
	// A CYCLE. Nothing legitimate writes one, but a ledger is append-only text
	// that any process may write, so the walk must terminate on one anyway.
	childTranscript(U(20), 1); childTranscript(U(21), 1);
	const led = ledgerOf("cycle.jsonl", [
		{ child: U(20) },
		{ parent: U(20), child: U(21) },
		{ parent: U(21), child: U(20) },
		{ parent: U(21), child: PARENT },
	]);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led, projectsRoot: projects });
	check(tree.descendants === 2, `C9  a cycle terminates and counts each session once (got ${tree.descendants})`);
	check(!tree.edges.some(e => e.child === PARENT && e.resolved),
		"C10 the root is never a descendant of itself");
}

{
	// DEPTH: a chain of 7, capped at 5. The nodes past the cap are REPORTED as
	// capped, never dropped — a silent cap is the same failure as a silent skip.
	for (let i = 30; i <= 37; i++) childTranscript(U(i), 1);
	const edges: Array<Partial<SpawnRecord>> = [{ child: U(30) }];
	for (let i = 30; i < 37; i++) edges.push({ parent: U(i), child: U(i + 1) });
	const led = ledgerOf("deep.jsonl", edges);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led, projectsRoot: projects, maxDepth: 5 });
	check(tree.descendants === 5, `C11 the cap admits exactly maxDepth levels (got ${tree.descendants})`);
	check(tree.depthCapped === 1, `C12 the cut is reported, not silent (got ${tree.depthCapped})`);
	check(tree.maxDepth === 5, "C13 the cap in force is stated in the result");
}

{
	// An UNRESOLVABLE child: the edge was recorded, the transcript is not there.
	const led = ledgerOf("missing.jsonl", [{ child: U(40), label: "vanished" }]);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led, projectsRoot: projects });
	check(tree.descendants === 0, "C14 an unresolvable child is not a descendant");
	check(tree.unattributed.length === 1, "C15 it is reported as unattributed");
	check(tree.unattributed[0].reason === "no-transcript", "C16 with the reason named");
	check(tree.edges[0].total === null,
		"C17 its cost is null, never 0 — a zero would launder a gap into a fact");
	check(tree.total.costUsd === 0, "C18 and it contributes nothing to the tree total");
}

{
	const led = ledgerOf("nobody.jsonl", [{ parent: U(50), child: U(51) }]);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led, projectsRoot: projects });
	check(tree.descendants === 0 && tree.edges.length === 0,
		"C19 another session's edges are not this session's descendants");
}

{
	const led = path.join(dir, "malformed-tree.jsonl");
	fs.writeFileSync(led, "{ nope\n" + serializeSpawnRecord(rec({ child: U(1) })) + "\n");
	const tree = computeSpawnTree(PARENT, { ledgerPath: led, projectsRoot: projects });
	check(tree.malformedLedgerLines === 1,
		"C20 the reader's skipped-line count reaches the report");
}


console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

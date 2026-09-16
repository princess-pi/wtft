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
 * Part A — the writer refuses what it cannot resolve later: a bad UUID, a `ts`
 *          that is not ISO-8601, an oversized field, an oversized record. One
 *          record is one atomic append, and a short write is a failure, not a
 *          silent truncation.
 * Part B — the reader counts what it skips. A malformed line that vanishes
 *          silently is money that vanishes silently.
 * Part C — the walk: a diamond counts once, a cycle terminates, depth is capped
 *          and the cut is REPORTED (what lies beyond it is not — that is what a
 *          bound is), an unresolvable child is `unattributed` with a null cost
 *          — never a zero, which would launder a gap into a fact — and an
 *          unreadable ledger is `ledgerError`, never an empty tree.
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
import { cwdForClaudeSpawn } from "../bin/wtft.mjs";
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

	// A9 used to be `MAX_RECORD_BYTES === 4096` — a constant compared to itself,
	// which is not a test of anything. The cap is reachable only through JSON
	// escape expansion (a control character costs 6 bytes on the wire and 1
	// against the field cap), which is exactly the input a hand-written ledger
	// line or an exotic label could carry.
	let recordThrew = "";
	try {
		serializeSpawnRecord(rec({
			cwd: "\u0001".repeat(MAX_FIELD_BYTES),
			label: "\u0001".repeat(MAX_FIELD_BYTES),
			model: "\u0001".repeat(MAX_FIELD_BYTES),
			mechanism: "\u0001".repeat(MAX_FIELD_BYTES),
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
	const dup = tree.edges.filter(e => e.child === U(12));
	check(dup.length === 2 && dup.filter(e => e.skip === "already-counted").length === 1,
		"C8b the second edge to the shared child is REPORTED as already-counted, not dropped");
}

{
	// A CYCLE. Nothing legitimate writes one, but a ledger is append-only text
	// that any process may write, so the walk must terminate on one anyway.
	childTranscript(U(20), 1); childTranscript(U(21), 1);
	// The ROOT gets a session file too. Without it the `U(21)→PARENT` edge would
	// come back `no-session-file` and C10 would pass with the seen-guard deleted
	// — measuring a missing fixture, not the guard.
	childTranscript(PARENT, 1);
	const led = ledgerOf("cycle.jsonl", [
		{ child: U(20) },
		{ parent: U(20), child: U(21) },
		{ parent: U(21), child: U(20) },
		{ parent: U(21), child: PARENT },
	]);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led, projectsRoot: projects });
	check(tree.descendants === 2, `C9  a cycle terminates and counts each session once (got ${tree.descendants})`);
	const rootEdge = tree.edges.find(e => e.child === PARENT);
	check(rootEdge !== undefined && !rootEdge.resolved && rootEdge.skip === "already-counted",
		`C10 the root is never a descendant of itself, even with its own session file on disk (got ${rootEdge?.skip})`);
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
	check(tree.edges.some(e => e.skip === "depth-capped" && e.depth === 6),
		"C13b the cut is an edge in the report, at the depth that exceeded the cap");
}

{
	// An UNRESOLVABLE child: the edge was recorded, the transcript is not there.
	const led = ledgerOf("missing.jsonl", [{ child: U(40), label: "vanished" }]);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led, projectsRoot: projects });
	check(tree.descendants === 0, "C14 an unresolvable child is not a descendant");
	check(tree.unattributed.length === 1, "C15 it is reported as unattributed");
	check(tree.unattributed[0].reason === "no-session-file", "C16 with the reason named");
	check(tree.edges[0].total === null,
		"C17 its cost is null, never 0 — a zero would launder a gap into a fact");
	check(tree.total.costUsd === 0, "C18 and it contributes nothing to the tree total");
	check(tree.edges[0].skip === "no-session-file", "C18b the skip reason is on the edge too");
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
	const tree = computeSpawnTree(PARENT, { ledgerPath: led, projectsRoot: projects });
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
	const tree = computeSpawnTree(PARENT, { ledgerPath: led, projectsRoot: projects });
	const readable = tree.descendants === 1;
	fs.chmodSync(file, 0o644);
	if (readable) {
		console.log("  ⏭  C24 SKIPPED — this process can read a chmod 000 file (root?)");
	} else {
		check(tree.unattributed[0]?.reason === "unreadable",
			`C24 an unreadable session file is 'unreadable', not 'no-session-file' (got ${tree.unattributed[0]?.reason})`);
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
	const e = computeSpawnTree(PARENT, { ledgerPath: led, projectsRoot: projects }).edges[0];
	check(e.label === "correctness" && e.model === "opus" && e.cwd === "/tmp/pr-review-abc",
		`C25 label, model and cwd all reach the edge (got ${JSON.stringify([e.label, e.model, e.cwd])})`);
	check(e.parent === PARENT && e.path !== null, "C25b as do parent and the resolved path");
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



{
	// An UNREADABLE ledger must not read like an empty one. This is #116's own
	// failure mode reintroduced inside #116's fix: a zero that might mean
	// "could not look" is exactly the silence the issue is about.
	const led = path.join(dir, "unreadable.jsonl");
	fs.writeFileSync(led, serializeSpawnRecord(rec({ child: U(1) })) + "\n");
	fs.chmodSync(led, 0o000);
	const tree = computeSpawnTree(PARENT, { ledgerPath: led, projectsRoot: projects });
	const readable = tree.ledgerError === null;
	fs.chmodSync(led, 0o644);
	if (readable) {
		// Running as root, or on a filesystem that ignores the mode bits.
		console.log("  ⏭  C21 SKIPPED — this process can read a chmod 000 file (root?)");
	} else {
		check(tree.descendants === 0 && tree.ledgerError !== null,
			"C21 an unreadable ledger reports ledgerError, not an empty tree");
		check(/EACCES|permission/i.test(tree.ledgerError!),
			`C21b the error names the cause (got ${tree.ledgerError})`);
	}
	const fine = computeSpawnTree(PARENT, { ledgerPath: path.join(dir, "nope.jsonl"), projectsRoot: projects });
	check(fine.ledgerError === null,
		"C22 an ABSENT ledger is not an error — nothing has spawned yet");
}

// ---
// PART D — the issue's own Closer, through the CLI
// ---
console.log("\nPART D — the Closer: a parent, a launcher child, one record");

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_BIN = path.join(REPO_ROOT, "bin", "wtft.mjs");
const HERDR_LINE = 'herdr agent start ppt-824-serve-home-from-env --kind claude --pane wE:pCW -- --model sonnet';

{
	// The control from the issue's Repro, and the reason this issue exists at
	// all: the spawning command yields NO cwd, so today's attribution pass hits
	// its `if (!cwd) continue` and the child's whole cost is dropped.
	check(cwdForClaudeSpawn([HERDR_LINE]) === null,
		"D1  the launcher command still yields no cwd — nothing here re-derives an edge");
	check(cwdForClaudeSpawn(['cd /repo && claude -p "review this"']) === "/repo",
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
	check(doc.spawned.schema === "wtft/spawn-tree@1" && doc.spawned.maxDepth === 5
		&& doc.spawned.ledgerError === null && doc.spawned.malformedLedgerLines === 0
		&& doc.spawned.depthCapped === 0 && Array.isArray(doc.spawned.unattributed),
		"D13c every field of the tree contract is present, not just the ones with news in them");
	check(doc.schema === "wtft/session@2",
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


console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

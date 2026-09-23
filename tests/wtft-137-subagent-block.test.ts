#!/usr/bin/env -S bun
/**
 * The SUBAGENTS block: one row per built-in subagent, priced from the tag
 * file's own lines, stated as money already inside TOTAL.
 * Spec: docs/spec-137-150-subagent-block.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { parseSessionFile } from "../extensions/lib/wtft-parser.ts";
import { computeSessionSummary } from "../extensions/lib/wtft-renderer.ts";
import { classifiedToInteraction, transcriptSourceId } from "../extensions/lib/wtft-daemon-lib.ts";
import { subagentRows, SUBAGENT_ROW_LIMIT } from "../extensions/lib/wtft-subagent-block.ts";
import { renderTokenSummary } from "../extensions/lib/wtft-renderer.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const SESSION_DIR = "/p/-tmp-x";
const SESSION = "a1370000-0000-4000-8000-000000000137";
const sub = (name: string) => path.join(SESSION_DIR, SESSION, "subagents", `agent-${name}.jsonl`);

/** A tag line, as the daemon writes one. `s` names the transcript it came from. */
function line(id: string, cost: number, opts: { s?: string; m?: string | null } = {}) {
	const obj: any = { t: Date.UTC(2026, 8, 23, 5), c: cost, cat: "code", f: [], cmd: [], id, in: 10, out: 100 };
	if (opts.m !== null) obj.m = opts.m ?? "claude-opus-5";
	if (opts.s) obj.s = opts.s;
	return classifiedToInteraction(obj)!;
}

const A = sub("aaaa"), B = sub("bbbb"), C = sub("cccc");
const sA = transcriptSourceId(A, SESSION_DIR), sB = transcriptSourceId(B, SESSION_DIR);
const interactions = [
	line("own-1", 1.0),
	line("a-1", 0.3, { s: sA }), line("a-2", 0.2, { s: sA }),
	line("b-1", 2.0, { s: sB }),
	line("b-untagged", 5.0, { s: sB, m: null }),
];
const subagents = [
	{ transcript: A, meta: { agentType: "general-purpose", spawnDepth: 1, description: "Fix the prose drift", model: "sonnet" } },
	{ transcript: B, meta: null },
	{ transcript: C, meta: { agentType: "general-purpose", spawnDepth: 1, description: "Never ran" } },
];

// ---
// PART S — the source key survives the tag reader
// ---
console.log("\nPART S — a tag line's source reaches the interaction");
check(line("x", 1, { s: "abc" }).source === "abc" && line("y", 1).source === undefined,
	"S1 classifiedToInteraction copies `s` to `source`, and leaves it unset for the session's own lines");

// ---
// PART R — rows
// ---
console.log("\nPART R — one row per subagent, priced from its own lines");
const rows = subagentRows(interactions, subagents, SESSION_DIR);
const byT = new Map(rows.map(r => [r.transcript, r]));
check(Math.abs((byT.get(A)?.total?.costUsd ?? 0) - 0.5) < 1e-9, `R1 a subagent's cost is the sum of its own tagged lines (got ${byT.get(A)?.total?.costUsd})`);
check(Math.abs((byT.get(B)?.total?.costUsd ?? 0) - 2.0) < 1e-9, `R2 an untagged turn is not counted, as in TOTAL (got ${byT.get(B)?.total?.costUsd})`);
check(byT.get(C)?.total === null, "R3 a subagent with no tagged lines has total null, never zero");
check(byT.get(A)?.label === "Fix the prose drift" && byT.get(A)?.model === "sonnet",
	`R4 the meta's description and model name the row (got ${byT.get(A)?.label} / ${byT.get(A)?.model})`);
check(byT.get(B)?.label === "agent-bbbb" && byT.get(B)?.model === null,
	`R5 no meta: the transcript's basename, and no model (got ${byT.get(B)?.label} / ${byT.get(B)?.model})`);
check(rows.map(r => r.transcript).join() === [B, A, C].join(), "R6 most expensive first, not-yet-tagged last");
{
	const D = sub("dddd");
	const onlyUntagged = subagentRows([line("d-1", 4.0, { s: transcriptSourceId(D, SESSION_DIR), m: null })],
		[{ transcript: D, meta: null }], SESSION_DIR);
	check(onlyUntagged[0].total === null, `R6b a subagent whose only lines carry no model is null, not a zero total (got ${JSON.stringify(onlyUntagged[0].total)})`);
}
const own = interactions.filter(i => !i.source && i.model).reduce((s, i) => s + i.cost, 0);
const rowSum = rows.reduce((s, r) => s + (r.total?.costUsd ?? 0), 0);
check(Math.abs(own + rowSum - 3.5) < 1e-9, `R7 own turns plus the rows equal TOTAL's 3.50 — the rows are inside it (got ${own + rowSum})`);

// ---
// PART B — the rendered block
// ---
console.log("\nPART B — the block under --tokens");
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const text = plain(renderTokenSummary(interactions, 120, undefined, undefined, undefined, rows));
const block = text.split("\n").filter(l => /SUBAGENTS|agent-bbbb|Fix the prose|Never ran/.test(l));
check(/SUBAGENTS\s+3 built-in subagent\(s\) — INSIDE TOTAL above, not added to it/.test(text),
	`B1 the heading says the money is inside TOTAL\n${block.join("\n")}`);
check(/Fix the prose drift\s+sonnet\s+\$0\.50/.test(text), "B2 a row shows description, model and cost");
check(/agent-bbbb\s+—\s+\$2\.00/.test(text), "B3 no model is a dash");
check(/Never ran\s+\S+\s+\(not yet tagged\)/.test(text), "B4 a subagent with no lines says so instead of $0.00");
check(text.indexOf("SUBAGENTS") > text.indexOf("TOTAL"), "B5 the block comes after TOTAL");
check(!plain(renderTokenSummary(interactions, 120, undefined, undefined, undefined, [])).includes("SUBAGENTS"),
	"B6 no built-in subagent, no block");

const many = Array.from({ length: SUBAGENT_ROW_LIMIT + 3 }, (_, i) => ({
	transcript: sub(`m${i}`), label: `sub ${i}`, model: "opus", total: null,
}));
const cut = plain(renderTokenSummary(interactions, 120, undefined, undefined, undefined, many as any));
check(cut.split("\n").filter(l => /^\s+sub \d+/.test(l)).length === SUBAGENT_ROW_LIMIT && /3 more not shown — every row is in --json/.test(cut),
	`B7 past ${SUBAGENT_ROW_LIMIT} rows, one line counts the rest`);

// ---
// PART E — the Closer, through the CLI and a real daemon
// ---
console.log("\nPART E — wtft --tokens and --json on a session with a built-in subagent");
{
	isolateTmpdir("137-subagent-block");
	const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-137-")));
	const projects = path.join(dir, "projects");
	const proj = path.join(projects, "-tmp-e2e");
	const sid = "a1371111-0000-4000-8000-000000000137";
	const turn = (id: string, i: number, out: number, sidechain = false) => JSON.stringify({
		type: "assistant", timestamp: new Date(Date.UTC(2026, 8, 23, 5, i)).toISOString(), cwd: "/tmp/e2e",
		...(sidechain ? { isSidechain: true } : {}),
		message: { role: "assistant", id, model: "claude-opus-5", content: [{ type: "text", text: "x" }],
			usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
	});
	fs.mkdirSync(path.join(proj, sid, "subagents"), { recursive: true });
	const session = path.join(proj, `${sid}.jsonl`);
	fs.writeFileSync(session, [turn("own-1", 0, 300), turn("own-2", 1, 200)].join("\n") + "\n");
	const agent = path.join(proj, sid, "subagents", "agent-e2e0001.jsonl");
	fs.writeFileSync(agent, [turn("sub-1", 2, 4000, true), turn("sub-2", 3, 3000, true)].join("\n") + "\n");
	fs.writeFileSync(agent.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "general-purpose", spawnDepth: 1, description: "Measure the daemon", model: "sonnet" }));
	const expected = computeSessionSummary(parseSessionFile(agent)).total.costUsd;

	const cli = (args: string[]) => spawnSync("node", [path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs"), "-s", session, ...args],
		{ encoding: "utf8", env: { ...process.env, WTFT_CLAUDE_PROJECTS_DIR: projects, XDG_STATE_HOME: path.join(dir, "state") } });
	// The daemon writes the tag asynchronously; a fresh run reads what it has.
	let doc: any = null;
	for (let k = 0; k < 20; k++) {
		const r = cli(["--json"]);
		try { doc = JSON.parse(r.stdout); } catch { doc = null; }
		if (doc?.subagents?.[0]?.total) break;
		spawnSync("sleep", ["0.5"]);
	}
	const row = doc?.subagents?.find((r: any) => r.transcript.endsWith("agent-e2e0001.jsonl"));
	check(doc?.schema === "wtft/session@7", `E1 the document is wtft/session@7 (got ${doc?.schema})`);
	check(row?.meta?.description === "Measure the daemon" && Math.abs((row?.total?.costUsd ?? -1) - expected) < 1e-6,
		`E2 subagents[].total is what the subagent's own turns cost (got ${row?.total?.costUsd}, expected ${expected})`);
	check(doc && Math.abs(doc.total.costUsd - (row.total.costUsd + computeSessionSummary(parseSessionFile(session)).total.costUsd)) < 1e-6,
		"E3 and it is inside total: the session's own turns plus the subagent equal total");
	const tokens = (cli(["--tokens"]).stdout || "").replace(/\x1b\[[0-9;]*m/g, "");
	check(/SUBAGENTS\s+1 built-in subagent\(s\) — INSIDE TOTAL above/.test(tokens) && /Measure the daemon\s+sonnet\s+\$/.test(tokens),
		`E4 --tokens prints the block with the description in place of agent-<hash>\n${tokens.split("\n").filter(l => /SUBAGENTS|Measure/.test(l)).join("\n")}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

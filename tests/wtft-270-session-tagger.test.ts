#!/usr/bin/env -S bun
/**
 * SessionTagger replayed over the golden corpus with no daemon process: the
 * records `stepTagger` returns are the golden's data lines. Heartbeats are the
 * daemon's cadence, not the tagger's output, and are left out of the compare.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCurrentVersionTagPath } from "../extensions/lib/wtft-daemon-lib.ts";
import { newTaggerState, stepTagger, fsWorld, type TaggerState, type World } from "../extensions/lib/session-tagger.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { writeCorpus, type CorpusSession } from "./lib/golden-corpus.ts";
import { normaliseTag, viewOf } from "./lib/golden-normalise.ts";

const GOLDEN_DIR = path.resolve(import.meta.dirname, "fixtures", "270-golden-tags");

isolateTmpdir("270-session-tagger");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-tagger-")));
const corpus = writeCorpus(root);
process.env.WTFT_CLAUDE_PROJECTS_DIR = corpus.projects;

/** A clock the test advances: one poll per tick. */
function clock(start = Date.now()) {
	let now = start;
	return { world: fsWorld(() => now), tick: (ms = 700) => { now += ms; } };
}

/** Step until a poll produces nothing, as an idle daemon would. */
function runUntilQuiet(state: TaggerState, world: World, tick: () => void, max = 12): { records: string; steps: number } {
	let records = "";
	for (let i = 0; i < max; i++) {
		const r = stepTagger(state, world, { flush: true });
		records += r.records;
		tick();
		if (!r.records) return { records, steps: i + 1 };
	}
	return { records, steps: max };
}

const isHeartbeat = (line: string) => line.includes('"_hb"');

console.log("\nPART G — the golden corpus, replayed through stepTagger");
for (const s of corpus.sessions) {
	const tagPath = getCurrentVersionTagPath(s.session);
	fs.mkdirSync(path.dirname(tagPath), { recursive: true });
	const state = newTaggerState(s.session, tagPath);
	const c = clock();
	const run = runUntilQuiet(state, c.world, c.tick);
	fs.writeFileSync(tagPath, run.records);
	const lines = normaliseTag(run.records, s, root).filter(l => !isHeartbeat(l));
	const wantLines = fs.readFileSync(path.join(GOLDEN_DIR, `${s.name}.lines.jsonl`), "utf8")
		.split("\n").filter(l => l.trim() && !isHeartbeat(l));
	const same = lines.length === wantLines.length && lines.every((l, k) => l === wantLines[k]);
	if (!same) {
		const got = new Set(lines);
		const want = new Set(wantLines);
		for (const l of wantLines) if (!got.has(l)) console.error(`    - ${l}`);
		for (const l of lines) if (!want.has(l)) console.error(`    + ${l}`);
	}
	check(same, `G ${s.name}: the records match the golden's data lines (${lines.length} lines, ${run.steps} steps)`);
	const view = viewOf(tagPath, s);
	const wantView = JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, `${s.name}.view.json`), "utf8"));
	check(JSON.stringify(view) === JSON.stringify(wantView), `G ${s.name}: the parsed view matches the golden (got ${JSON.stringify(view)})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

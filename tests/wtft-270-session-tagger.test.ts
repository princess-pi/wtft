#!/usr/bin/env -S bun
/**
 * SessionTagger replayed over the golden corpus with no daemon process: the
 * records `stepTagger` returns are the golden's data lines. Heartbeats are the
 * daemon's cadence, not the tagger's output, and are left out of the compare.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCurrentVersionTagPath, readTagFileWithVerdict } from "../extensions/lib/wtft-daemon-lib.ts";
import { parseSessionFile } from "../extensions/lib/wtft-parser.ts";
import { newTaggerState, stepTagger, resumeTagger, fsWorld, MTIME_SETTLE_MS, type TaggerState, type World } from "../extensions/lib/session-tagger.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { writeCorpus, ccUser, ccAssistant, bash, ccProjectFile, UUID, piHeader, piTurn, T0 } from "./lib/golden-corpus.ts";
import { normaliseTag, viewOf } from "./lib/golden-normalise.ts";
import { cwdToStrictSlug } from "../extensions/lib/harness/session-cwd.ts";

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

/** A clock the test advances: one poll per tick. With `driftPerRead` every
 *  read moves it too, so a slice deadline can pass inside one scan. */
function clock(opts: { start?: number; driftPerRead?: number } = {}) {
	let now = opts.start ?? Date.now();
	const drift = opts.driftPerRead ?? 0;
	return { world: fsWorld(() => { now += drift; return now; }), tick: (ms = 700) => { now += ms; } };
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

// ---
// Fixtures for the step sequences: written whole, then stepped.
// ---

/** A Claude Code session with `n` Task children of two turns each. */
function taskSession(sandbox: string, seq: number, n: number): { session: string; children: string[]; cwd: string } {
	const cwd = path.join(sandbox, `task-${seq}`);
	const session = ccProjectFile(corpus.projects, cwd, UUID(seq));
	const subagents = path.join(path.dirname(session), UUID(seq), "subagents");
	fs.mkdirSync(subagents, { recursive: true });
	fs.writeFileSync(session,
		ccUser(T0, cwd)
		+ ccAssistant({ id: `r${seq}`, tsMs: T0 + 1_000, output: 100, cr: 0, cw: 20_000, blocks: [{ type: "tool_use", name: "Task", input: { description: "look" } }] }));
	const children: string[] = [];
	for (let k = 0; k < n; k++) {
		const file = path.join(subagents, `agent-${String.fromCharCode(97 + k)}${String(seq).padStart(4, "0")}.jsonl`);
		fs.writeFileSync(file, childTurn(k, 1) + childTurn(k, 2));
		children.push(file);
	}
	return { session, children, cwd };
}

/** Turn `m` of Task child `k`, id `<letter><m>`. */
function childTurn(k: number, m: number): string {
	return ccAssistant({ id: `${String.fromCharCode(97 + k)}${m}`, tsMs: T0 + 2_000 + k * 10_000 + m * 1_000, output: 50 * m, cr: 0, cw: 1_000, sidechain: true });
}

const hasTurn = (records: string, id: string) => records.includes(`"id":"${id}"`);
const sweptCount = (records: string) => (records.match(/"swept":/g) ?? []).length;

/** Appends what a step returned to the tag, as the daemon does after every call. */
function tagWriter(tagPath: string) {
	fs.mkdirSync(path.dirname(tagPath), { recursive: true });
	fs.writeFileSync(tagPath, "");
	let all = "";
	return { append(records: string) { all += records; fs.appendFileSync(tagPath, records); }, get all() { return all; } };
}

console.log("\nPART P — the caller owns the write cadence");
{
	const s = corpus.sessions.find(x => x.name === "cc-plain")!;
	const tagPath = getCurrentVersionTagPath(s.session);
	const state = newTaggerState(s.session, tagPath);
	const c = clock();
	const held = stepTagger(state, c.world, { flush: false });
	check(!/"id":/.test(held.records) && !held.records.includes('"offset"'), `P flush: false returns no turn line and no offset marker (got ${JSON.stringify(held.records)})`);
	check(state.pendingItems.length > 0, `P the turns read are held as pending (${state.pendingItems.length})`);
	check(held.activity, "P the step still reports the session's activity");
	c.tick();
	const flushed = stepTagger(state, c.world, { flush: true });
	const lines = flushed.records.split("\n").filter(l => l.trim());
	const turnLines = lines.filter(l => /"id":/.test(l));
	const offsetAt = lines.findIndex(l => l.includes('"offset"'));
	const onlyTurnsBefore = lines.slice(0, offsetAt).every(l => /"id":/.test(l));
	check(turnLines.length === 8 && offsetAt === 8 && onlyTurnsBefore, `P flush: true then returns the held turns followed by one offset marker (${turnLines.length} turn lines, offset at ${offsetAt})`);
	check(state.pendingItems.length === 0, "P and nothing stays pending");
}

console.log("\nPART C — a sliced scan reads a transcript that grew after the pass took it (#257)");
{
	const f = taskSession(root, 11, 3);
	const tagPath = getCurrentVersionTagPath(f.session);
	const state = newTaggerState(f.session, tagPath);
	const c = clock({ driftPerRead: 1 });
	const tag = tagWriter(tagPath);
	const first = stepTagger(state, c.world, { flush: true, sliceMs: 0 });
	tag.append(first.records);
	check(first.cut, "C fixture: with a zero slice the first step reads one transcript and reports cut");
	const taken = f.children.findIndex(file => state.discoveredSubagentFiles.has(file));
	check(taken >= 0 && state.discoveredSubagentFiles.size === 1, `C fixture: exactly one transcript was taken by the pass (child ${taken})`);
	const letter = String.fromCharCode(97 + taken);
	check(hasTurn(first.records, `${letter}1`) && !hasTurn(first.records, `${letter}2`), `C fixture: its first turn is written and its last is held (${letter}1 written, ${letter}2 held)`);
	// The growth: two turns, so one is written and one is held.
	fs.appendFileSync(f.children[taken], childTurn(taken, 3) + childTurn(taken, 4));
	let passRecords = "";
	let steps = 0;
	let ended = false;
	for (; steps < 12; steps++) {
		c.tick();
		const r = stepTagger(state, c.world, { flush: false, sliceMs: 0 });
		tag.append(r.records);
		passRecords += r.records;
		if (!r.cut) { ended = true; break; }
	}
	check(ended, `C fixture: the pass ends within the step budget (${steps + 1} slices)`);
	check(hasTurn(passRecords, `${letter}3`), `C the grown transcript is read again before the pass ends: ${letter}3 is in the pass's records`);
	check(sweptCount(tag.all) === 0, "C and the tag is not stamped swept while the growth was unread");
	// Quiet polls release the held turns and stamp swept, as before.
	const rest = runUntilQuiet(state, c.world, c.tick);
	tag.append(rest.records);
	check(hasTurn(tag.all, `${letter}4`) && sweptCount(tag.all) === 1, `C the held turn is released on a quiet poll and the tag is stamped swept once (${sweptCount(tag.all)})`);
}

/** A Claude Code session in `cwd` that ran `claude -p` with no `cd`, so its
 *  child transcript lands in the session's own project directory. */
function sameDirClaudep(sandbox: string, seq: number, childTurns = 2): { session: string; child: string; cwd: string } {
	const cwd = path.join(sandbox, `own-${seq}`);
	const session = ccProjectFile(corpus.projects, cwd, UUID(seq));
	fs.writeFileSync(session,
		ccUser(T0, cwd)
		+ ccAssistant({ id: `s${seq}`, tsMs: T0 + 1_000, output: 80, cr: 0, cw: 5_000, blocks: [bash("claude -p 'go'")] })
		+ ccAssistant({ id: `t${seq}`, tsMs: T0 + 60_000, output: 30, cr: 5_000, cw: 100 }));
	const child = ccProjectFile(corpus.projects, cwd, UUID(seq + 100));
	fs.writeFileSync(child,
		ccUser(T0 + 2_000, cwd)
		+ ccAssistant({ id: "k1", tsMs: T0 + 3_000, output: 500, cr: 0, cw: 8_000 })
		+ (childTurns > 1 ? ccAssistant({ id: "k2", tsMs: T0 + 30_000, output: 20, cr: 8_000, cw: 50 }) : ""));
	return { session, child, cwd };
}

/** The session's transcript moves to another project directory, as a cwd change moves it. */
function moveSession(session: string, newCwd: string): string {
	const moved = ccProjectFile(corpus.projects, newCwd, path.basename(session, ".jsonl"));
	fs.renameSync(session, moved);
	return moved;
}

const costOf = (turns: { cost?: number }[]) => Number(turns.reduce((sum, i) => sum + (i.cost || 0), 0).toFixed(6));
/** Tag lines carry each cost rounded to a millionth; a sum of them can sit one off a full parse. */
const sameCost = (a: number, b: number) => Math.abs(a - b) <= 2e-6;
const tagCost = (tagPath: string) => costOf(readTagFileWithVerdict(tagPath).interactions);
const parseCost = (session: string) => costOf(parseSessionFile(session));

console.log("\nPART M — a same-directory claude -p child keeps one source across a move of its session (#263)");
{
	const f = sameDirClaudep(root, 12);
	const tagPath = getCurrentVersionTagPath(f.session);
	const tag = tagWriter(tagPath);
	const state = newTaggerState(f.session, tagPath);
	const c = clock();
	tag.append(runUntilQuiet(state, c.world, c.tick).records);
	const before = tagCost(tagPath);
	const beforeFull = parseCost(f.session);
	check(hasTurn(tag.all, "k1") && hasTurn(tag.all, "k2") && sameCost(before, beforeFull), `M fixture: the child is read and the tag equals a full parse before the move ($${before} vs $${beforeFull})`);
	const moved = moveSession(f.session, path.join(root, "own-12-moved"));
	// The daemon that follows the move stops here; a new one resumes from the tag.
	const resumed = newTaggerState(moved, tagPath);
	resumed.lastSize = state.lastSize;
	const r = resumeTagger(resumed, tag.all, c.world);
	tag.append(r.records);
	check(r.complete && resumed.discoveredClaudeFiles.has(f.child), "M the resume registers the child again under the moved session");
	fs.appendFileSync(f.child, ccAssistant({ id: "k3", tsMs: T0 + 90_000, output: 70, cr: 8_000, cw: 10 }) + ccAssistant({ id: "k4", tsMs: T0 + 91_000, output: 10, cr: 8_100, cw: 5 }));
	c.tick();
	tag.append(runUntilQuiet(resumed, c.world, c.tick).records);
	const after = tagCost(tagPath);
	const full = parseCost(moved);
	check(hasTurn(tag.all, "k3") && hasTurn(tag.all, "k4"), "M the turns the child gained after the move are read");
	check(sameCost(after, full), `M the tag's total equals a full parse of the moved session and its child ($${after} vs $${full})`);
	const gens = tag.all.split("\n").filter(l => l.includes('"_gen"'));
	check(gens.length === 2 && gens[0] === gens[1], `M the resumed read opens its generation under the source the earlier lines carry, so they are retired (${gens.length} generation records)`);
}
{
	const f = sameDirClaudep(root, 13);
	const tagPath = getCurrentVersionTagPath(f.session);
	const tag = tagWriter(tagPath);
	const state = newTaggerState(f.session, tagPath);
	const c = clock();
	tag.append(runUntilQuiet(state, c.world, c.tick).records);
	const moved = moveSession(f.session, path.join(root, "own-13-moved"));
	state.sessionPath = moved;
	// The child rotates after the move: rewritten shorter, so it is read again from its start.
	fs.writeFileSync(f.child, ccUser(T0 + 2_000, f.cwd) + ccAssistant({ id: "k1", tsMs: T0 + 3_000, output: 400, cr: 0, cw: 8_000 }));
	c.tick(MTIME_SETTLE_MS + 1);
	tag.append(runUntilQuiet(state, c.world, c.tick).records);
	const gens = tag.all.split("\n").filter(l => l.includes('"_gen"'));
	check(gens.length === 2 && gens[0] === gens[1], `M a child rotated after the move opens its new generation under the source its earlier lines carry (${gens.length} generation records)`);
	const after = tagCost(tagPath);
	const full = parseCost(moved);
	check(sameCost(after, full), `M so the earlier lines are retired and the tag equals a full parse ($${after} vs $${full})`);
}

const genLines = (records: string) => records.split("\n").filter(l => l.includes('"_gen"'));
const turnLine = (records: string, id: string) => records.split("\n").find(l => l.includes(`"id":"${id}"`));
const sourceOfLine = (line: string | undefined) => (line ? JSON.parse(line).s : undefined) as string | undefined;

console.log("\nPART R — what a resume recovers, and what a scan releases (#267)");
console.log("  H — the children a settled lookup found are read after a restart");
{
	// A Task child and a claude -p child: with a zero slice the lookup settles
	// and the Task child is read, then the slice is cut before the claude -p child.
	const f = taskSession(root, 14, 1);
	fs.appendFileSync(f.session, ccAssistant({ id: "p14", tsMs: T0 + 5_000, output: 10, cr: 20_000, cw: 10, blocks: [bash("claude -p 'go'")] }));
	const child = ccProjectFile(corpus.projects, f.cwd, UUID(114));
	fs.writeFileSync(child, ccUser(T0 + 6_000, f.cwd) + ccAssistant({ id: "k1", tsMs: T0 + 7_000, output: 500, cr: 0, cw: 8_000 }) + ccAssistant({ id: "k2", tsMs: T0 + 8_000, output: 5, cr: 8_000, cw: 0 }));
	const tagPath = getCurrentVersionTagPath(f.session);
	const tag = tagWriter(tagPath);
	const state = newTaggerState(f.session, tagPath);
	const c = clock({ driftPerRead: 1 });
	const first = stepTagger(state, c.world, { flush: true, sliceMs: 0 });
	tag.append(first.records);
	const settledWithChild = first.records.includes('"spawnSettled":"p14"') && first.records.includes(path.basename(child));
	check(first.cut && settledWithChild && genLines(first.records).length === 1 && !hasTurn(first.records, "k1"),
		"H fixture: the lookup settled naming the child, the Task child was read, and the slice was cut before the claude -p child");
	// The daemon stops here; the next life resumes from the tag.
	const resumed = newTaggerState(f.session, tagPath);
	resumed.lastSize = state.lastSize;
	const r = resumeTagger(resumed, tag.all, c.world);
	tag.append(r.records);
	check(r.complete && resumed.discoveredClaudeFiles.has(child), "H the resume registers the child the settled lookup found and no earlier life read");
	c.tick();
	tag.append(runUntilQuiet(resumed, c.world, c.tick).records);
	check(hasTurn(tag.all, "k1") && hasTurn(tag.all, "k2"), "H and the next steps read it");
}
console.log("  H — a claude -p child discovery also finds is left to discovery on resume");
{
	// A Pi root whose sibling child names it as parent AND sits in the window of
	// its `claude -p` turn, so both paths find one file.
	const cwd = path.join(root, "pi-both-15");
	const dir = path.join(corpus.projects, cwdToStrictSlug(cwd));
	fs.mkdirSync(dir, { recursive: true });
	const session = path.join(dir, "pi-root-0015.jsonl");
	fs.writeFileSync(session, piHeader("pi-root-0015", T0, cwd) + piTurn("q1", T0 + 1_000, 250, ["claude -p 'go'"]) + piTurn("q2", T0 + 60_000, 120));
	const child = path.join(dir, "pi-child-0016.jsonl");
	fs.writeFileSync(child, piHeader("pi-child-0016", T0 + 2_000, cwd, "pi-root-0015") + piTurn("c1", T0 + 3_000, 90) + piTurn("c2", T0 + 4_000, 30));
	const tagPath = getCurrentVersionTagPath(session);
	const tag = tagWriter(tagPath);
	const state = newTaggerState(session, tagPath);
	const c = clock();
	tag.append(runUntilQuiet(state, c.world, c.tick).records);
	check(tag.all.includes('"spawnSettled":"q1"') && tag.all.includes(path.basename(child)) && genLines(tag.all).length === 1 && hasTurn(tag.all, "c1"),
		"H fixture: the lookup found the sibling discovery also found, and it was read once");
	const resumed = newTaggerState(session, tagPath);
	resumed.lastSize = state.lastSize;
	tag.append(resumeTagger(resumed, tag.all, c.world).records);
	check(!resumed.discoveredClaudeFiles.has(child), "H the resume leaves a child discovery finds to discovery: it is not registered as a claude -p child");
	c.tick();
	const after = runUntilQuiet(resumed, c.world, c.tick).records;
	tag.append(after);
	check(genLines(after).length === 1 && (after.match(/"id":"c1"/g) ?? []).length === 1, `H so the resumed life reads it once (${genLines(after).length} generation, ${(after.match(/"id":"c1"/g) ?? []).length} c1 line)`);
}
console.log("  A — the resume leaves a folded claude -p transcript to the one folding it");
{
	const s = corpus.sessions.find(x => x.name === "cc-claudep")!;
	const tagPath = getCurrentVersionTagPath(s.session);
	const tag = tagWriter(tagPath);
	const state = newTaggerState(s.session, tagPath);
	const c = clock();
	tag.append(runUntilQuiet(state, c.world, c.tick).records);
	const grandchild = s.children["claudep-grandchild"];
	const childFile = s.children["claudep-child"];
	check(tag.all.includes(`"child":"${path.basename(grandchild, ".jsonl")}"`), "A fixture: the child's parse folds the grandchild");
	const resumed = newTaggerState(s.session, tagPath);
	resumed.lastSize = state.lastSize;
	tag.append(resumeTagger(resumed, tag.all, c.world).records);
	check(resumed.discoveredClaudeFiles.has(childFile) && !resumed.discoveredClaudeFiles.has(grandchild),
		"A the resume registers the child again and leaves the grandchild to it");
	c.tick();
	const after = runUntilQuiet(resumed, c.world, c.tick).records;
	tag.append(after);
	const full = parseCost(s.session);
	const got = tagCost(tagPath);
	check(sameCost(got, full), `A and the tag still equals a full parse after the resume ($${got} vs $${full})`);
}
console.log("  B, G — the held turn of a child no longer found is written, under the source its earlier lines carry");
{
	const f = sameDirClaudep(root, 17);
	const tagPath = getCurrentVersionTagPath(f.session);
	const tag = tagWriter(tagPath);
	const state = newTaggerState(f.session, tagPath);
	const c = clock();
	const first = stepTagger(state, c.world, { flush: true });
	tag.append(first.records);
	check(hasTurn(first.records, "k1") && !hasTurn(first.records, "k2"), "B fixture: the child's first turn is written and its last is held");
	fs.unlinkSync(f.child);
	c.tick();
	const after = stepTagger(state, c.world, { flush: true });
	tag.append(after.records);
	check(hasTurn(after.records, "k2"), "G a deleted claude -p child's held turn is written by the next scan");
	check(sourceOfLine(turnLine(after.records, "k2")) === sourceOfLine(turnLine(first.records, "k1")), "B under the source its earlier lines carry");
	check(after.records.includes('"swept"'), "B and that scan stamps the tag swept: the deleted child counts as gone, not as a failure");
}
{
	const f = sameDirClaudep(root, 18);
	const tagPath = getCurrentVersionTagPath(f.session);
	const tag = tagWriter(tagPath);
	const state = newTaggerState(f.session, tagPath);
	const c = clock();
	tag.append(stepTagger(state, c.world, { flush: true }).records);
	fs.renameSync(f.child, path.join(root, "own-18-child-moved.jsonl"));
	c.tick();
	const after = stepTagger(state, c.world, { flush: true });
	tag.append(after.records);
	check(hasTurn(after.records, "k2") && after.records.includes('"swept"'), "G a moved claude -p child's held turn is written and the tag is stamped swept");
}
console.log("  C — the generation record is written before that held turn, when its transcript opened none");
{
	const f = sameDirClaudep(root, 19, 1);
	const tagPath = getCurrentVersionTagPath(f.session);
	const tag = tagWriter(tagPath);
	const state = newTaggerState(f.session, tagPath);
	const c = clock();
	const first = stepTagger(state, c.world, { flush: true });
	tag.append(first.records);
	check(!hasTurn(first.records, "k1") && genLines(first.records).length === 0, "C fixture: a one-turn child holds its turn and opens no generation");
	fs.unlinkSync(f.child);
	c.tick();
	const after = stepTagger(state, c.world, { flush: true });
	tag.append(after.records);
	const lines = after.records.split("\n").filter(l => l.trim());
	const genAt = lines.findIndex(l => l.includes('"_gen"'));
	const turnAt = lines.findIndex(l => l.includes('"id":"k1"'));
	check(genAt >= 0 && turnAt === genAt + 1, `C the generation record precedes the released turn (gen at ${genAt}, turn at ${turnAt})`);
}
console.log("  D — a held turn is pruned when its transcript was read again under the same source in the same scan");
{
	const f = taskSession(root, 20, 1);
	const tagPath = getCurrentVersionTagPath(f.session);
	const tag = tagWriter(tagPath);
	const state = newTaggerState(f.session, tagPath);
	const c = clock();
	const first = stepTagger(state, c.world, { flush: true });
	tag.append(first.records);
	check(hasTurn(first.records, "a1") && !hasTurn(first.records, "a2"), "D fixture: the Task child's last turn is held");
	// The session and its <id>/ tree move together, so the child's new path has the same source.
	const newCwd = path.join(root, "task-20-moved");
	const moved = moveSession(f.session, newCwd);
	fs.renameSync(path.join(path.dirname(f.session), UUID(20)), path.join(path.dirname(moved), UUID(20)));
	state.sessionPath = moved;
	c.tick();
	const after = stepTagger(state, c.world, { flush: true });
	tag.append(after.records);
	check(genLines(after.records).length === 1 && genLines(after.records)[0] === genLines(first.records)[0], "D the moved child is read again under the same source, as a new generation");
	check(!hasTurn(after.records, "a2"), "D and the old path's held turn is pruned, not written after that generation");
	c.tick();
	tag.append(runUntilQuiet(state, c.world, c.tick).records);
	check((tag.all.match(/"id":"a2"/g) ?? []).length === 1 && tag.all.includes('"swept"'), "D the quiet poll releases it once and the tag is stamped swept");
}
console.log("  E — a later line of one message merges its claude -p commands into the open lookup");
{
	const cwd = path.join(root, "merge-21");
	const session = ccProjectFile(corpus.projects, cwd, UUID(21));
	const other = path.join(root, "merge-21-other");
	fs.writeFileSync(session,
		ccUser(T0, cwd)
		+ ccAssistant({ id: "m1", tsMs: T0 + 1_000, output: 10, cr: 0, cw: 100, blocks: [bash("claude -p 'one'")] }));
	const tagPath = getCurrentVersionTagPath(session);
	const state = newTaggerState(session, tagPath);
	// The clock sits inside the spawn window, so the lookup stays open.
	const c = clock({ start: T0 + 2_000 });
	let records = stepTagger(state, c.world, { flush: true }).records;
	// The message's later line, in a later poll, carries one more command.
	fs.appendFileSync(session, ccAssistant({ id: "m1", tsMs: T0 + 1_000, output: 20, cr: 0, cw: 100, blocks: [bash("claude -p 'one'"), bash(`cd ${other} && claude -p 'two'`)] }));
	c.tick();
	records += stepTagger(state, c.world, { flush: true }).records;
	const pendings = records.split("\n").filter(l => l.includes('"spawnPending"')).map(l => JSON.parse(l)._meta.spawnPending);
	check(pendings.length === 2 && pendings[0].commands.length === 1 && pendings[1].commands.length === 2 && pendings.every(p => p.key === "m1"),
		`E the lookup is recorded when queued and again when the later line adds a command (${pendings.map(p => p.commands.length).join(",")})`);
	check(state.pendingClaudeCommands.length === 1 && state.pendingClaudeCommands[0].interaction.commands.length === 2,
		"E one open lookup holds both commands");
	// A child appears in the second directory inside the window: the merged lookup finds it.
	const child = ccProjectFile(corpus.projects, other, UUID(121));
	fs.writeFileSync(child, ccUser(T0 + 3_000, other) + ccAssistant({ id: "k1", tsMs: T0 + 4_000, output: 500, cr: 0, cw: 8_000 }));
	c.tick();
	stepTagger(state, c.world, { flush: true });
	c.tick();
	const later = stepTagger(state, c.world, { flush: true });
	check(state.discoveredClaudeFiles.has(child) && hasTurn(later.records, "k1"), "E and the merged lookup finds the child the added command spawned");
}

console.log("\nPART W — every failure the daemon warned about comes back as one log line per transcript");
{
	const f = sameDirClaudep(root, 22);
	const tagPath = getCurrentVersionTagPath(f.session);
	const state = newTaggerState(f.session, tagPath);
	const c = clock();
	fs.chmodSync(f.session, 0o000);
	const first = stepTagger(state, c.world, { flush: true });
	const warns = (r: { log: { level: string; text: string }[] }) => r.log.filter(l => l.level === "warn").map(l => l.text);
	check(warns(first).length === 1 && warns(first)[0].includes("the session transcript could not be read at discovery") && warns(first)[0].includes(f.session),
		`W an unreadable session transcript is one warn line naming it (${JSON.stringify(warns(first))})`);
	check(state.sessionReadFailed && state.pollHadFailure, "W and the step records the read failure");
	c.tick();
	const second = stepTagger(state, c.world, { flush: true });
	check(warns(second).length === 0, "W the next step does not warn again");
	fs.chmodSync(f.session, 0o644);
	c.tick();
	const third = stepTagger(state, c.world, { flush: true });
	check(third.activity && !state.sessionReadFailed, "W once readable the transcript is read and the failure clears");
	// The child: registered by the lookup, then unreadable.
	fs.chmodSync(f.child, 0o000);
	c.tick();
	const fourth = stepTagger(state, c.world, { flush: true });
	check(warns(fourth).length === 1 && warns(fourth)[0].includes("could not be read or parsed") && warns(fourth)[0].includes(path.basename(f.child, ".jsonl")),
		`W an unreadable child is one warn line naming its session id (${JSON.stringify(warns(fourth))})`);
	c.tick();
	const fifth = stepTagger(state, c.world, { flush: true });
	check(warns(fifth).length === 0 && !fifth.records.includes('"swept"'), "W not warned again, and the tag is not stamped swept while it fails");
	fs.chmodSync(f.child, 0o644);
	c.tick();
	const sixth = runUntilQuiet(state, c.world, c.tick).records;
	check(hasTurn(sixth, "k2") && sixth.includes('"swept"'), "W once readable the child's held turn is released and the tag is stamped swept");
	check(first.log.some(l => l.level === "debug"), "W debug lines ride the same log");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

#!/usr/bin/env -S bun
/**
 * generation records drop a rotated child's old lines; nested `claude -p` cost converges (#114, #14)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { deduplicateInteractions, parseSessionFile } from "../extensions/lib/wtft-parser.ts";
import { readTagFileWithVerdict, transcriptSourceId, WTFT_TAGGER_VERSION } from "../extensions/lib/wtft-daemon-lib.ts";
import { getSessionSummary } from "../extensions/lib/session-selector.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("114-generation-records");

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-114-")));
const projects = path.join(dir, "projects");
process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
process.env.WTFT_PI_SESSIONS_DIR = path.join(dir, "pi-sessions");
process.env.XDG_CONFIG_HOME = path.join(dir, "config");

const T0 = Date.UTC(2026, 8, 18, 5, 0, 0);
const uuid = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
const line = (o: unknown) => JSON.stringify(o) + "\n";

function turnLine(id: string, tsMs: number, outputTokens: number, spawnCwd?: string): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso,
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6", timestamp: iso,
			usage: { input_tokens: 1000, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: spawnCwd
				? [{ type: "toolCall", name: "bash", arguments: { command: `cd ${spawnCwd} && claude -p "go"` } }]
				: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

const cwdOf = (id: string) => path.join(dir, `cwd-${id}`);
const projectDirOf = (id: string) => path.join(projects, cwdOf(id).replace(/\//g, "-"));

const costOf = (interactions: { cost: number }[]) => interactions.reduce((n, i) => n + i.cost, 0);
const outOf = (interactions: { outputTokens: number }[]) => interactions.reduce((n, i) => n + i.outputTokens, 0);

// ---
// PART R — the reader counts only a source's latest generation
// ---
console.log("\nPART R — readTagFileWithVerdict honours `_gen`");

{
	const tagsDir = path.join(dir, "r", "wtft-tags");
	fs.mkdirSync(tagsDir, { recursive: true });
	const tagPath = path.join(tagsDir, `r-session.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const i = (id: string, out: number, s?: string) =>
		line({ t: T0, c: out / 1000, cat: "code", f: [], cmd: [], id, m: "claude-sonnet-4-6", out, ...(s ? { s } : {}) });
	fs.writeFileSync(tagPath,
		i("own-1", 1)
		+ line({ _gen: { s: "aaaa0001", session: "kid-a" } })
		+ i("a-old", 10, "aaaa0001")
		+ line({ _fold: { parent: "r-session", child: "kid-a", s: "aaaa0001" } })
		+ line({ _fold: { parent: "r-session", child: "grand-old", s: "aaaa0001" } })
		+ line({ _gen: { s: "bbbb0002", session: "kid-b" } })
		+ i("b-1", 100, "bbbb0002")
		+ line({ _fold: { parent: "r-session", child: "kid-b", s: "bbbb0002" } })
		+ line({ _meta: { swept: T0 } })
		+ line({ _gen: { s: "aaaa0001", session: "kid-a" } })
		+ i("a-new", 1000, "aaaa0001")
		+ line({ _fold: { parent: "r-session", child: "kid-a", s: "aaaa0001" } })
		+ i("own-2", 2));
	const read = readTagFileWithVerdict(tagPath);
	const ids = read.interactions.map(x => x.messageId).sort();
	check(JSON.stringify(ids) === JSON.stringify(["a-new", "b-1", "own-1", "own-2"]),
		`R1 a line before a later _gen for its s is dropped; another source's lines and lines with no s are kept (got ${JSON.stringify(ids)})`);
	check(outOf(read.interactions) === 1103,
		`R2 the total is the latest generation's: 1 + 100 + 1000 + 2 (got ${outOf(read.interactions)})`);
	check(read.folded.has("kid-a") && read.folded.has("kid-b") && !read.folded.has("grand-old") && read.folded.size === 2,
		`R3 a fold record before a later _gen for its s is dropped too (got ${JSON.stringify([...read.folded])})`);

	const genLast = path.join(tagsDir, `g-session.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	fs.writeFileSync(genLast, i("own-1", 1) + line({ _meta: { swept: T0 } }) + line({ _gen: { s: "cccc0003", session: "kid-c" } }));
	const genRead = readTagFileWithVerdict(genLast);
	check(genRead.provisional.provisional === true && genRead.provisional.reason === "unswept",
		`R4 a generation record is data: a swept tag followed by one reads unswept (got ${JSON.stringify(genRead.provisional)})`);
}

// ---
// PART D — the daemon opens a new generation when a child transcript rotates (#114)
// ---
console.log("\nPART D — a rotated child is billed for its latest generation only");

function startDaemon(rootPath: string) {
	const daemon = spawn(process.execPath, [DAEMON_BIN, "--session", rootPath], { detached: true, stdio: "ignore", env: { ...process.env } });
	daemon.unref();
	return daemon;
}
async function stopDaemon(daemon: ReturnType<typeof spawn>) {
	try { if (daemon.pid) process.kill(daemon.pid, "SIGTERM"); } catch { /* already gone */ }
	for (let i = 0; i < 40; i++) {
		try { if (daemon.pid) process.kill(daemon.pid, 0); } catch { return; }
		await sleep(100);
	}
}
/** Poll the tag until `done` holds and it reads swept, or ten seconds pass. */
async function settle(tagPath: string, done: (read: ReturnType<typeof readTagFileWithVerdict>) => boolean) {
	let read = readTagFileWithVerdict(tagPath);
	for (let i = 0; i < 40 && !(done(read) && !read.provisional.provisional); i++) {
		await sleep(250);
		read = readTagFileWithVerdict(tagPath);
	}
	return read;
}
function taskRoot(name: string, root: string) {
	const rootDir = path.join(dir, name);
	fs.mkdirSync(path.join(rootDir, root, "subagents"), { recursive: true });
	const rootPath = path.join(rootDir, `${root}.jsonl`);
	fs.writeFileSync(rootPath, turnLine(`turn-root-${name}`, Date.now() - 60_000, 1));
	return {
		rootPath,
		child: path.join(rootDir, root, "subagents", "agent-rot.jsonl"),
		tagPath: path.join(rootDir, "wtft-tags", `${root}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`),
	};
}
const turns = (prefix: string, outs: number[], base: number) =>
	outs.map((out, k) => turnLine(`${prefix}-${k}`, base + k * 1_000, out)).join("");

for (const how of ["truncate", "replace"] as const) {
	const { rootPath, child, tagPath } = taskRoot(`d-${how}`, uuid(how === "truncate" ? 11 : 12));
	const base = Date.now() - 50_000;
	// Old run: N = 3 interactions, 700 output tokens. New run: M = 2 different ones, 40.
	fs.writeFileSync(child, turns(`old-${how}`, [100, 200, 400], base));
	const daemon = startDaemon(rootPath);
	const before = await settle(tagPath, r => outOf(r.interactions) === 701);
	check(outOf(before.interactions) === 701,
		`D${how === "truncate" ? 1 : 3}a fixture precondition: the tag holds the old run's 700 plus the root's 1 before the rotation (got ${outOf(before.interactions)})`);
	if (how === "truncate") {
		fs.writeFileSync(child, turns(`new-${how}`, [15, 25], base + 10_000));
	} else {
		// A new inode, already larger than the file it replaces — no size decrease to see.
		const next = child + ".next";
		fs.writeFileSync(next, turns(`new-${how}`, [5, 5, 5, 5, 5, 5, 5, 5], base + 10_000));
		check(fs.statSync(next).size > fs.statSync(child).size, "D3b fixture precondition: the replacement is larger than the original");
		fs.renameSync(next, child);
	}
	const after = await settle(tagPath, r => outOf(r.interactions) === 41);
	await stopDaemon(daemon);
	check(outOf(after.interactions) === 41,
		`D${how === "truncate" ? 2 : 4} #114 after a ${how}, the tag's total is the new run's 40 plus the root's 1, not the old 700 on top (got ${outOf(after.interactions)})`);
}

{
	// A rewrite of the same byte length on the same inode: neither size nor inode moves.
	const { rootPath, child, tagPath } = taskRoot("d-same-size", uuid(14));
	const base = Date.now() - 50_000;
	fs.writeFileSync(child, turns("old-same", [100, 200, 400], base));
	const before = fs.statSync(child);
	const daemon = startDaemon(rootPath);
	const read1 = await settle(tagPath, r => outOf(r.interactions) === 701);
	check(outOf(read1.interactions) === 701,
		`D6a fixture precondition: the tag holds the old run's 700 plus the root's 1 (got ${outOf(read1.interactions)})`);
	fs.writeFileSync(child, turns("new-same", [111, 222, 444], base + 10_000));
	const after = fs.statSync(child);
	check(after.size === before.size && after.ino === before.ino,
		`D6b fixture precondition: the rewrite kept the byte length and the inode (${before.size}/${after.size}, ${before.ino}/${after.ino})`);
	const read2 = await settle(tagPath, r => outOf(r.interactions) === 778);
	await stopDaemon(daemon);
	check(outOf(read2.interactions) === 778,
		`D7 #114 a rewrite that neither shrinks the file nor changes its inode still opens a new generation: 777 plus the root's 1 (got ${outOf(read2.interactions)})`);
}

{
	// A restart re-appends every child line; an id-less line must not be billed twice.
	const { rootPath, child, tagPath } = taskRoot("d-restart", uuid(13));
	const iso = new Date(Date.now() - 40_000).toISOString();
	fs.writeFileSync(child, JSON.stringify({
		type: "message", timestamp: iso,
		message: { role: "assistant", model: "claude-sonnet-4-6", timestamp: iso,
			usage: { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: [{ type: "text", text: "no id" }] },
	}) + "\n");
	check(parseSessionFile(child).length === 1 && !parseSessionFile(child)[0].messageId,
		"D5a fixture precondition: the child's one turn parses, with no message id");
	let daemon = startDaemon(rootPath);
	const first = await settle(tagPath, r => outOf(r.interactions) === 301);
	await stopDaemon(daemon);
	daemon = startDaemon(rootPath);
	await sleep(1_500);
	const second = await settle(tagPath, r => outOf(r.interactions) >= 301);
	await stopDaemon(daemon);
	const appended = fs.readFileSync(tagPath, "utf8").split("\n").filter(l => l.includes('"no id"') || (l.includes('"out":300') && !l.includes('"_'))).length;
	check(outOf(first.interactions) === 301 && appended >= 2,
		`D5b fixture precondition: the first life billed it once, and the restart appended the line again (${appended} copies on disk)`);
	check(outOf(second.interactions) === 301,
		`D5 a restart that re-appends an id-less child line bills it once (got ${outOf(second.interactions)})`);
}

// ---
// PART N — nested `claude -p` cost converges without `wtft -F` (#14)
// ---
console.log("\nPART N — a nested claude -p session's later writes reach the tag");

const spawnCostInTag = (read: ReturnType<typeof readTagFileWithVerdict>, id: string) =>
	read.interactions.find(i => i.messageId === id)?.cost ?? -1;
const spawnCostReparsed = (child: string, id: string) =>
	deduplicateInteractions(parseSessionFile(child)).find(i => i.messageId === id)?.cost ?? -2;

{
	// The child spawned GRAND long ago and has stopped writing; GRAND keeps going.
	const ROOT = uuid(21), GRAND = uuid(22);
	const { rootPath, child, tagPath } = taskRoot("n-grow", ROOT);
	const spawnedAt = Date.now() - 50_000;
	fs.writeFileSync(child, turnLine("n-grow-spawn", spawnedAt, 10, cwdOf(GRAND)));
	fs.mkdirSync(projectDirOf(GRAND), { recursive: true });
	const grand = path.join(projectDirOf(GRAND), `${GRAND}.jsonl`);
	fs.writeFileSync(grand, turnLine("n-grow-g0", spawnedAt + 2_000, 100));
	const daemon = startDaemon(rootPath);
	const early = await settle(tagPath, r => r.folded.has(GRAND));
	const earlyCost = spawnCostInTag(early, "n-grow-spawn");
	check(early.folded.has(GRAND) && Math.abs(earlyCost - spawnCostReparsed(child, "n-grow-spawn")) < 1e-6,
		`N1a fixture precondition: the daemon folded GRAND's first turn onto the spawning turn ($${earlyCost})`);
	await sleep(3_000);
	fs.appendFileSync(grand, turnLine("n-grow-g1", spawnedAt + 30_000, 2_000));
	await sleep(1_000);
	fs.appendFileSync(grand, turnLine("n-grow-g2", spawnedAt + 40_000, 4_000));
	const full = spawnCostReparsed(child, "n-grow-spawn");
	check(full > earlyCost + 1e-6, `N1b fixture precondition: a full re-parse now costs more than the first fold ($${full} > $${earlyCost})`);
	const late = await settle(tagPath, r => Math.abs(spawnCostInTag(r, "n-grow-spawn") - full) < 1e-6);
	await stopDaemon(daemon);
	check(Math.abs(spawnCostInTag(late, "n-grow-spawn") - full) < 1e-6,
		`N1 #14 the tag's cost for the spawning turn equals a full re-parse within $0.000001 ($${spawnCostInTag(late, "n-grow-spawn")} vs $${full})`);
	check(Math.abs(costOf(late.interactions) - costOf(deduplicateInteractions(parseSessionFile(rootPath))) - costOf(deduplicateInteractions(parseSessionFile(child)))) < 1e-5,
		"N2 and the tag's total is the root plus the child as re-parsed");
}

{
	// GRAND's transcript appears after the daemon parsed the child, inside the discovery window.
	const ROOT = uuid(23), GRAND = uuid(24);
	const { rootPath, child, tagPath } = taskRoot("n-late", ROOT);
	const spawnedAt = Date.now();
	fs.writeFileSync(child, turnLine("n-late-spawn", spawnedAt, 10, cwdOf(GRAND)));
	const daemon = startDaemon(rootPath);
	const first = await settle(tagPath, r => spawnCostInTag(r, "n-late-spawn") > 0);
	check(spawnCostInTag(first, "n-late-spawn") > 0 && !first.folded.has(GRAND),
		"N3a fixture precondition: the daemon billed the spawning turn before GRAND existed");
	// Past the settle re-reads that follow the child's own write, so only the window can catch it.
	await sleep(3_000);
	fs.mkdirSync(projectDirOf(GRAND), { recursive: true });
	fs.writeFileSync(path.join(projectDirOf(GRAND), `${GRAND}.jsonl`), turnLine("n-late-g0", spawnedAt + 5_000, 900));
	const full = spawnCostReparsed(child, "n-late-spawn");
	const late = await settle(tagPath, r => r.folded.has(GRAND));
	await stopDaemon(daemon);
	check(late.folded.has(GRAND) && Math.abs(spawnCostInTag(late, "n-late-spawn") - full) < 1e-6,
		`N3 #14 a nested session that appears after the child's parse is folded and recorded ($${spawnCostInTag(late, "n-late-spawn")} vs $${full})`);
}

{
	// The tag's own session: a second claude -p child starts after the first was already found.
	const ROOT = uuid(25), KID = uuid(26), KID2 = uuid(27);
	const rootDir = path.join(dir, "n-pending");
	fs.mkdirSync(rootDir, { recursive: true });
	const rootPath = path.join(rootDir, `${ROOT}.jsonl`);
	const tagPath = path.join(rootDir, "wtft-tags", `${ROOT}.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const spawnedAt = Date.now();
	fs.mkdirSync(projectDirOf(KID), { recursive: true });
	fs.writeFileSync(path.join(projectDirOf(KID), `${KID}.jsonl`), turnLine("n-pend-k1", spawnedAt + 1_000, 50));
	fs.writeFileSync(rootPath, turnLine("n-pend-root", spawnedAt, 1, cwdOf(KID)));
	const daemon = startDaemon(rootPath);
	const first = await settle(tagPath, r => r.folded.has(KID));
	check(first.folded.has(KID) && !first.folded.has(KID2),
		"N4a fixture precondition: the daemon found the first child before the second existed");
	fs.writeFileSync(path.join(projectDirOf(KID), `${KID2}.jsonl`), turnLine("n-pend-k2", spawnedAt + 4_000, 70));
	const late = await settle(tagPath, r => r.folded.has(KID2));
	await stopDaemon(daemon);
	check(late.folded.has(KID2) && outOf(late.interactions) === 121,
		`N4 #14 a second child in the same window is read too: 1 + 50 + 70 (got ${outOf(late.interactions)}, folded ${JSON.stringify([...late.folded])})`);
}

// ---
// PART S — every tag reader honours a generation, and a source survives a session move
// ---
console.log("\nPART S — the session picker's summary, and the source key");

{
	const sessionDir = path.join(dir, "s-picker");
	fs.mkdirSync(path.join(sessionDir, "wtft-tags"), { recursive: true });
	const sessionPath = path.join(sessionDir, `${uuid(31)}.jsonl`);
	fs.writeFileSync(sessionPath, turnLine("s-own", T0, 1));
	const tagPath = path.join(sessionDir, "wtft-tags", `${path.basename(sessionPath)}.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
	const i = (id: string, c: number, s?: string) =>
		line({ t: T0, c, cat: "code", f: [], cmd: [], id, m: "claude-sonnet-4-6", out: 1, ...(s ? { s } : {}) });
	fs.writeFileSync(tagPath,
		i("s-own-1", 0.5)
		+ line({ _gen: { s: "aaaa0001", session: "kid" } })
		+ i("s-old", 4, "aaaa0001")
		+ line({ _fold: { parent: "sess", child: "kid", s: "aaaa0001" } })
		+ line({ _gen: { s: "aaaa0001", session: "kid" } })
		+ i("s-new", 0.25, "aaaa0001")
		+ line({ _fold: { parent: "sess", child: "kid", s: "aaaa0001" } })
		+ line({ _meta: { swept: T0 } }));
	const summary = getSessionSummary(sessionPath);
	check(Math.abs(summary.cost - 0.75) < 1e-9,
		`S1 the session picker's summary counts the latest generation only: $0.50 + $0.25 (got $${summary.cost})`);
	check(summary.turns === 2,
		`S1b and a fold, generation or meta record is not a turn (got ${summary.turns})`);
	check(readTagFileWithVerdict(tagPath).interactions.length === summary.turns,
		"S1c the picker's turn count matches the canonical reader's over the same tag");
}

{
	// A session that moves: a child under it keeps its source, a claude -p child elsewhere keeps its own.
	const before = path.join(dir, "s-move", "projects-a", "sess");
	const after = path.join(dir, "s-move", "projects-b", "deeper", "sess");
	const taskChildBefore = path.join(before, "kid", "subagents", "agent-x.jsonl");
	const taskChildAfter = path.join(after, "kid", "subagents", "agent-x.jsonl");
	const elsewhere = path.join(dir, "s-move", "other", "claude-kid.jsonl");
	check(transcriptSourceId(taskChildBefore, before) === transcriptSourceId(taskChildAfter, after),
		"S2 a child under the session directory keeps its source when the session moves");
	check(transcriptSourceId(elsewhere, before) === transcriptSourceId(elsewhere, after),
		"S3 a claude -p child outside it keeps its source too");
	check(transcriptSourceId(taskChildBefore, before) !== transcriptSourceId(elsewhere, before),
		"S4 two transcripts are two sources");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

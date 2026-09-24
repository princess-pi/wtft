#!/usr/bin/env -S bun
/**
 * #208 — before-after.ts reads a frozen corpus, not the live projects root.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { foldFilesOf, honoursProjectsSeam, pickTranscripts, snapshotCorpus, subagentIdsOf } from "../research/other-corpus/before-after.ts";
import { parseSessionFile } from "../extensions/lib/wtft-parser.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

isolateTmpdir("208-before-after-snapshot");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-208-")));
const T0 = Date.UTC(2026, 8, 22, 5, 0, 0);

function turnLine(id: string, tsMs: number, outputTokens: number, commands: string[] = []): string {
	const iso = new Date(tsMs).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso,
		message: {
			role: "assistant", id, model: "claude-sonnet-4-6", timestamp: iso,
			usage: { input_tokens: 1000, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: commands.length > 0
				? commands.map(command => ({ type: "toolCall", name: "bash", arguments: { command } }))
				: [{ type: "text", text: `turn ${id}` }],
		},
	}) + "\n";
}

function sessionLine(id: string, tsMs: number, cwd: string): string {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(tsMs).toISOString(), cwd }) + "\n";
}

/** A large, zero-cost filler turn — pads a transcript past `pickTranscripts`'s 40 KB gate
 *  without moving the dollar totals it is used alongside. */
function paddingLine(bytes: number): string {
	const iso = new Date(T0).toISOString();
	return JSON.stringify({
		type: "message",
		timestamp: iso,
		message: {
			role: "assistant", id: "padding", model: "claude-sonnet-4-6", timestamp: iso,
			usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			content: [{ type: "text", text: "x".repeat(bytes) }],
		},
	}) + "\n";
}

/** A transcript filed the way the harness files it: under the slug of the
 *  cwd it ran in. */
function writeTranscript(root: string, cwd: string, sessionId: string, body: string): string {
	const projectDir = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
	fs.mkdirSync(projectDir, { recursive: true });
	const file = path.join(projectDir, `${sessionId}.jsonl`);
	fs.writeFileSync(file, body);
	return file;
}

const costOf = (file: string) => parseSessionFile(file).reduce((sum, i) => sum + i.cost, 0);

// ---
// Fixture: a parent whose turn spawns `claude -p` in a child's cwd, and the
// child transcript filed under the child cwd's own slug, inside the ±15s
// discovery window.
// ---
const liveRoot = path.join(dir, "live-projects");
process.env.WTFT_CLAUDE_PROJECTS_DIR = liveRoot;

const parentCwd = path.join(dir, "parent-project");
const childCwd = path.join(dir, "child-project");
const parentId = "aaaaaaaa-1111-4111-8111-111111111111";
const childId = "bbbbbbbb-2222-4222-8222-222222222222";

const parentFile = writeTranscript(liveRoot, parentCwd, parentId,
	sessionLine(parentId, T0, parentCwd)
	+ turnLine(`${parentId}-turn`, T0, 100, [`cd ${childCwd} && claude -p 'go'`]));

const childFile = writeTranscript(liveRoot, childCwd, childId,
	sessionLine(childId, T0 + 2_000, childCwd)
	+ turnLine(`${childId}-turn`, T0 + 2_000, 700));

// ---
// PART F — the live parse discovers and names the child (spec case 1)
// ---
console.log("\nPART F — foldFilesOf / subagentIdsOf on the live parse");

const parentAloneCwd = path.join(dir, "parent-alone-project");
const parentAloneId = "cccccccc-3333-4333-8333-333333333333";
const parentAloneFile = writeTranscript(liveRoot, parentAloneCwd, parentAloneId,
	sessionLine(parentAloneId, T0, parentAloneCwd) + turnLine(`${parentAloneId}-turn`, T0, 100));
const parentAloneCost = costOf(parentAloneFile);

const liveParentInteractions = parseSessionFile(parentFile);
const liveParentCost = liveParentInteractions.reduce((sum, i) => sum + i.cost, 0);

check(liveParentCost > parentAloneCost,
	`F0 fixture precondition: the live parent's parsed cost includes the child (alone $${parentAloneCost.toFixed(6)}, with child $${liveParentCost.toFixed(6)})`);

const foldFiles = foldFilesOf(liveParentInteractions);
check(foldFiles.includes(childFile),
	`F1 foldFilesOf names the child file (got ${JSON.stringify(foldFiles)})`);

const subagentIds = subagentIdsOf(liveParentInteractions);
check(subagentIds.includes(childId),
	`F2 subagentIdsOf names the child id — the fold id is the reported subagent id (got ${JSON.stringify(subagentIds)})`);

// ---
// PART Z — snapshotCorpus freezes the fold, live growth does not move it (spec case 2)
// ---
console.log("\nPART Z — the snapshot is frozen; the live corpus is not");

const emptyPiRoot = path.join(dir, "empty-pi");
fs.mkdirSync(emptyPiRoot, { recursive: true });

const snapDir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-208-snap-")));
const { projects: snapProjects } = snapshotCorpus({
	snapDir,
	ccRoot: liveRoot,
	piRoot: emptyPiRoot,
	ccFiles: [parentFile],
	piFiles: [],
	foldFiles,
});

const snapChildFile = path.join(snapProjects, path.relative(liveRoot, childFile));
check(fs.existsSync(snapChildFile),
	`Z1 the child transcript is copied into the snapshot tree (expected ${snapChildFile})`);

const snapParentFile = path.join(snapProjects, path.relative(liveRoot, parentFile));
process.env.WTFT_CLAUDE_PROJECTS_DIR = snapProjects;
const snapCostBefore = costOf(snapParentFile);

// Append a costly new turn to the LIVE child, after the freeze.
fs.appendFileSync(childFile, turnLine(`${childId}-turn2`, T0 + 3_000, 5_000));

const snapCostAfter = costOf(snapParentFile);
check(Math.abs(snapCostAfter - snapCostBefore) < 1e-9,
	`Z2 with WTFT_CLAUDE_PROJECTS_DIR at the snapshot, the snapshot parent's cost is unchanged after the live child grows (before $${snapCostBefore.toFixed(6)}, after $${snapCostAfter.toFixed(6)})`);

process.env.WTFT_CLAUDE_PROJECTS_DIR = liveRoot;
const liveCostAfterGrowth = costOf(parentFile);
check(liveCostAfterGrowth > liveParentCost,
	`Z3 precondition: with WTFT_CLAUDE_PROJECTS_DIR at the live root, the live parent's cost DID rise after the child grew (before $${liveParentCost.toFixed(6)}, after $${liveCostAfterGrowth.toFixed(6)})`);

// ---
// PART P — pickTranscripts keeps the size/age gate; the small child clears it
// only through folding, never through selection
// ---
console.log("\nPART P — pickTranscripts selects the padded transcript, not the small child");

const e2eRoot = path.join(dir, "e2e-projects");
const e2eParentCwd = path.join(dir, "e2e-parent-project");
const e2eChildCwd = path.join(dir, "e2e-child-project");
const e2eParentId = "dddddddd-4444-4444-8444-444444444444";
const e2eChildId = "eeeeeeee-5555-4555-8555-555555555555";

const e2eParentFile = writeTranscript(e2eRoot, e2eParentCwd, e2eParentId,
	sessionLine(e2eParentId, T0, e2eParentCwd)
	+ turnLine(`${e2eParentId}-turn`, T0, 100, [`cd ${e2eChildCwd} && claude -p 'go'`])
	+ paddingLine(60_000));

const e2eChildFile = writeTranscript(e2eRoot, e2eChildCwd, e2eChildId,
	sessionLine(e2eChildId, T0 + 2_000, e2eChildCwd)
	+ turnLine(`${e2eChildId}-turn`, T0 + 2_000, 700));

const picked = pickTranscripts(e2eRoot, 250);
check(picked.length === 1 && picked[0] === e2eParentFile,
	`P1 only the padded parent clears the 40 KB filter, not the small child (got ${JSON.stringify(picked)})`);
void e2eChildFile;

// ---
// PART E — end to end: the script exits 0 and reports no lost cost (spec case 3)
// ---
console.log("\nPART E — the script run against the fixture exits 0 with no cost LOST");

const emptyPiRootE2e = path.join(dir, "e2e-empty-pi");
fs.mkdirSync(emptyPiRootE2e, { recursive: true });
const emptyHome = path.join(dir, "e2e-empty-home");
fs.mkdirSync(emptyHome, { recursive: true });

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "research", "other-corpus", "before-after.ts");

const childTmp = path.join(dir, "e2e-tmp");
fs.mkdirSync(childTmp, { recursive: true });
// `--before .` from the checkout: a relative path, resolved against the cwd.
const result = spawnSync("bun", [SCRIPT, "--before", "."], {
	cwd: REPO,
	encoding: "utf8",
	env: { ...process.env, HOME: emptyHome, TMPDIR: childTmp, WTFT_CLAUDE_PROJECTS_DIR: e2eRoot, WTFT_PI_SESSIONS_DIR: emptyPiRootE2e },
});

const stdout = result.stdout || "";
const stderr = result.stderr || "";

check(result.status === 0,
	`E1 the script exits 0 (got ${result.status}, stderr tail: ${stderr.slice(-400)})`);
check(!stdout.includes("cost LOST"),
	`E2 stdout does not contain "cost LOST" (stdout tail: ${stdout.slice(-400)})`);
const afterTotal = Number(/AFTER \$(\d+\.\d+)/.exec(stdout)?.[1] ?? "NaN");
check(afterTotal >= 0.015,
	`E4 the reported total includes the frozen child's cost, so discovery ran on the snapshot (AFTER $${afterTotal}, parent alone is under $0.005)`);
check(/claude-code: \d+ sessions =====/.test(stdout),
	`E3 the fixture was actually selected — output names 1+ sessions for claude-code, not "no sessions found" (stdout head: ${stdout.slice(0, 300)})`);
check(result.status === 0 && result.error === undefined,
	"E5 a relative --before resolves against the cwd, not the script's directory");
const leftover = fs.readdirSync(childTmp).filter(f => f.startsWith("wtft-ab-"));
check(leftover.length === 0, `E6 the snapshot directory is removed on exit (left: ${JSON.stringify(leftover)})`);

check(await honoursProjectsSeam(REPO), "E8 this checkout honours the projects-root seam");
const seamless = path.join(dir, "seamless-checkout");
fs.mkdirSync(path.join(seamless, "extensions", "lib", "harness", "claude-code"), { recursive: true });
fs.writeFileSync(path.join(seamless, "extensions", "lib", "harness", "claude-code", "discovery.ts"),
	"export function projectsDir(): string { return '/home/x/.claude/projects'; }\n");
check(!(await honoursProjectsSeam(seamless)), "E9 a checkout whose projectsDir ignores the seam is detected");
// An older build reads the variable from process.env and takes no argument.
const envOnly = path.join(dir, "env-only-checkout");
fs.mkdirSync(path.join(envOnly, "extensions", "lib", "harness", "claude-code"), { recursive: true });
fs.writeFileSync(path.join(envOnly, "extensions", "lib", "harness", "claude-code", "discovery.ts"),
	"export function projectsDir(): string { return process.env.WTFT_CLAUDE_PROJECTS_DIR || '/home/x/.claude/projects'; }\n");
check(await honoursProjectsSeam(envOnly), "E9b a build that reads the seam from process.env with no argument is accepted");
let loadFailed = false;
try { await honoursProjectsSeam(path.join(dir, "no-such-checkout")); } catch { loadFailed = true; }
check(loadFailed, "E9c a --before that cannot be loaded throws instead of reading as an old build");
const refused = spawnSync("bun", [SCRIPT, "--before", seamless], {
	cwd: REPO, encoding: "utf8",
	env: { ...process.env, HOME: emptyHome, TMPDIR: childTmp, WTFT_CLAUDE_PROJECTS_DIR: e2eRoot, WTFT_PI_SESSIONS_DIR: emptyPiRootE2e },
});
check(refused.status === 2 && /predates the WTFT_CLAUDE_PROJECTS_DIR seam/.test(refused.stderr ?? ""),
	`E10 the script refuses such a --before with exit 2 (got ${refused.status})`);

// An older build's path-less ids are looked up, not dropped.
check(JSON.stringify(foldFilesOf([{ claudeSubAgentSessionIds: ["kid"] }], id => id === "kid" ? "/p/kid.jsonl" : null)) === '["/p/kid.jsonl"]',
	"E11 an id reported without a path is resolved to its transcript");

// A fold with no `file` and no resolver answer is reported as unresolved, not thrown on.
check(JSON.stringify(foldFilesOf([{ claudeSubAgentFolds: [{ id: "x" } as { id: string; file?: string }] }])) === "[]",
	"E7 a fold with no file contributes nothing to the freeze");

// ---
// PART G — every way the gate could pass without comparing fails instead
// ---
console.log("\nPART G — exit codes when the comparison cannot be trusted");

const runScript = (args: string[], env: Record<string, string> = {}) => spawnSync("bun", [SCRIPT, ...args], {
	cwd: REPO, encoding: "utf8",
	env: { ...process.env, HOME: emptyHome, TMPDIR: childTmp, WTFT_CLAUDE_PROJECTS_DIR: e2eRoot, WTFT_PI_SESSIONS_DIR: emptyPiRootE2e, ...env },
});

const empty = runScript(["--before", "."], { WTFT_CLAUDE_PROJECTS_DIR: path.join(dir, "no-cc"), WTFT_PI_SESSIONS_DIR: path.join(dir, "no-pi") });
check(empty.status === 3 && /nothing was compared/.test(empty.stderr ?? ""),
	`G1 nothing selected exits 3, not 0 (got ${empty.status})`);
check(runScript(["--before", ".", "--session", "10"]).status === 2, "G2 an unknown flag exits 2");
check(runScript(["--before", ".", "--sessions", "-1"]).status === 2, "G3 a non-positive --sessions exits 2");

/** A checkout whose parser wraps this one's, changing what BEFORE reports. */
function fakeBefore(name: string, parserBody: string): string {
	const root = path.join(dir, `fake-${name}`);
	const lib = path.join(root, "extensions", "lib");
	fs.mkdirSync(path.join(lib, "harness", "claude-code"), { recursive: true });
	fs.writeFileSync(path.join(lib, "harness", "claude-code", "discovery.ts"),
		`export * from ${JSON.stringify(path.join(REPO, "extensions", "lib", "harness", "claude-code", "discovery.ts"))};\n`);
	fs.writeFileSync(path.join(lib, "wtft-parser.ts"), parserBody.replaceAll("REAL", JSON.stringify(path.join(REPO, "extensions", "lib", "wtft-parser.ts"))));
	return root;
}
const nanBuild = fakeBefore("nan", `export * from REAL;
import * as real from REAL;
export function parseSessionFile(...a: any[]) { const xs = (real.parseSessionFile as any)(...a); if (xs[0]) xs[0].cost = NaN; return xs; }
`);
const nan = runScript(["--before", nanBuild]);
check(nan.status === 3 && /not a finite number/.test(nan.stderr ?? ""), `G4 a NaN total exits 3 (got ${nan.status})`);

const noApi = fakeBefore("noapi", `import * as real from REAL;
export const parseSessionFile = real.parseSessionFile;
export const classifyInteraction = real.classifyInteraction;
`);
const noapi = runScript(["--before", noApi]);
check(noapi.status === 3 && /measured pass could not read/.test(noapi.stderr ?? ""),
	`G5 a measured pass that throws exits 3, instead of reading as an explained rise (got ${noapi.status})`);

// A rise bigger than the newly found subagent: BEFORE loses its folds and half its cost.
const riseRoot = path.join(dir, "rise-projects");
const riseParentCwd = path.join(dir, "rise-parent"), riseChildCwd = path.join(dir, "rise-child");
writeTranscript(riseRoot, riseParentCwd, "ffffffff-6666-4666-8666-666666666666",
	sessionLine("ffffffff-6666-4666-8666-666666666666", T0, riseParentCwd)
	+ turnLine("rise-parent-turn", T0, 20_000, [`cd ${riseChildCwd} && claude -p 'go'`])
	+ paddingLine(60_000));
writeTranscript(riseRoot, riseChildCwd, "abababab-7777-4777-8777-777777777777",
	sessionLine("abababab-7777-4777-8777-777777777777", T0 + 2_000, riseChildCwd)
	+ turnLine("rise-child-turn", T0 + 2_000, 700));
const halfBuild = fakeBefore("half", `export * from REAL;
import * as real from REAL;
export function parseSessionFile(...a: any[]) { const xs = (real.parseSessionFile as any)(...a); for (const i of xs) { delete i.claudeSubAgentFolds; i.cost = i.cost / 2; } return xs; }
`);
const rise = runScript(["--before", halfBuild], { WTFT_CLAUDE_PROJECTS_DIR: riseRoot });
check(rise.status === 1 && /RISE larger than/.test(rise.stdout ?? ""),
	`G6 a rise larger than the newly found subagent's cost fails, not "explained" (got ${rise.status})`);

// snapshotCorpus: a file that cannot be copied, or lies outside its root, fails; a `..`-named one inside it is copied.
const snapRoot = path.join(dir, "snap-fail");
fs.mkdirSync(path.join(snapRoot, "..archive"), { recursive: true });
const dotted = path.join(snapRoot, "..archive", "s.jsonl");
fs.writeFileSync(dotted, "{}\n");
const snapOut = path.join(dir, "snap-out");
snapshotCorpus({ snapDir: snapOut, ccRoot: snapRoot, piRoot: path.join(dir, "no-pi"), ccFiles: [dotted], piFiles: [], foldFiles: [] });
check(fs.existsSync(path.join(snapOut, "projects", "..archive", "s.jsonl")), "G7 an in-root name starting with .. is copied");
let copyThrew = false;
try { snapshotCorpus({ snapDir: path.join(dir, "snap-out-2"), ccRoot: snapRoot, piRoot: path.join(dir, "no-pi"), ccFiles: [path.join(snapRoot, "gone.jsonl")], piFiles: [], foldFiles: [] }); }
catch { copyThrew = true; }
check(copyThrew, "G8 a file that cannot be copied fails the snapshot");
let outsideThrew = false;
try { snapshotCorpus({ snapDir: path.join(dir, "snap-out-3"), ccRoot: snapRoot, piRoot: path.join(dir, "no-pi"), ccFiles: [], piFiles: [], foldFiles: [path.join(dir, "elsewhere.jsonl")] }); }
catch { outsideThrew = true; }
check(outsideThrew, "G9 a fold file outside the projects root fails the snapshot");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

#!/usr/bin/env -S bun
/**
 * tests/wtft-146-149-subagent-discovery.test.ts — subagent discovery and meta
 * reading, #146–#149.
 *
 *   § 146  an unreadable `.meta.json` gets a notice; an absent one does not.
 *   § 147  discoverSubagentSessionFiles reads a header's first line, not the
 *          whole transcript.
 *   § 148  a deeply nested transcript is listed, never cut off silently;
 *          a directory symlink cycle lists each child once.
 *   § 149  the invariants #137 shipped with nothing defending them: the
 *          `discoverOnce` memo, `isFork`, the `.jsonl` guard, the Pi row.
 *
 * Read counts run the bundle under stock node with tests/lib/fs-read-spy.mjs,
 * because bun does not route a bundle's `node:fs` through a patched module.
 *
 * Run: bun tests/wtft-146-149-subagent-discovery.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { discoverSubagentSessionFiles, readSubagentMeta, WTFT_TAGGER_VERSION } from "../bin/wtft.mjs";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { skip } from "./lib/skips";

isolateTmpdir("146-149-subagent-discovery");

const REPO = path.resolve(import.meta.dirname, "..");
const CLI_BIN = path.join(REPO, "bin", "wtft.mjs");
const SPY = path.join(REPO, "tests", "lib", "fs-read-spy.mjs");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let passed = 0, failed = 0;
function check(cond: boolean, msg: string, detail?: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.log(`  ❌ FAIL: ${msg}${detail ? `\n       ${detail}` : ""}`); }
}

const root = fs.realpathSync(trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-146-"))));
const projects = path.join(root, "projects");

// ---
// FIXTURES
// ---

const turn = (id: string) => JSON.stringify({
	type: "assistant", timestamp: new Date().toISOString(),
	message: {
		role: "assistant", id, model: "claude-sonnet-4-6",
		usage: { input_tokens: 1200, output_tokens: 90 },
		content: [{ type: "text", text: "work" }],
	},
}) + "\n";

const compaction = JSON.stringify({
	type: "system", subtype: "compact_boundary", timestamp: new Date().toISOString(),
	compactMetadata: { trigger: "manual", preTokens: 1000, postTokens: 100, durationMs: 1 },
}) + "\n";

/** A tag with the parent's turn and a swept marker, so `--json` takes the
 *  REPORT path rather than the `no-data` arm. */
function writeTag(sessionPath: string, id: string): void {
	const tagsDir = path.join(path.dirname(sessionPath), "wtft-tags");
	fs.mkdirSync(tagsDir, { recursive: true });
	fs.writeFileSync(
		path.join(tagsDir, `${path.basename(sessionPath)}.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`),
		JSON.stringify({ t: Date.now() - 60_000, c: 0.0123, cat: "code", f: [], cmd: [], id, m: "claude-sonnet-4-6", in: 1200, out: 90 }) + "\n"
		+ JSON.stringify({ _meta: { offset: fs.statSync(sessionPath).size, swept: Date.now() - 60_000 } }) + "\n");
}

/** A Claude Code session with a tag; returns its path and its subagents dir. */
function claudeSession(name: string): { sessionPath: string; subDir: string } {
	const slug = path.join(projects, `-sandbox-${name}`);
	const sessionPath = path.join(slug, `${name}.jsonl`);
	const subDir = path.join(slug, name, "subagents");
	fs.mkdirSync(subDir, { recursive: true });
	fs.writeFileSync(sessionPath, turn(`msg_${name}_parent`));
	writeTag(sessionPath, `msg_${name}_parent`);
	return { sessionPath, subDir };
}

function runJson(sessionPath: string, spyOut?: string): { code: number | null; doc: any; stderr: string } {
	const args = spyOut ? ["--import", SPY, CLI_BIN] : [CLI_BIN];
	const r = spawnSync("node", [...args, "-s", sessionPath, "--json"], {
		encoding: "utf8",
		env: { ...process.env, WTFT_CLAUDE_PROJECTS_DIR: projects, ...(spyOut ? { FS_SPY_OUT: spyOut } : {}) },
	});
	let doc: any = null;
	try { doc = JSON.parse(r.stdout); } catch { /* callers assert on doc */ }
	return { code: r.status, doc, stderr: r.stderr };
}

// ---
// § 146 — an unreadable meta is not "this harness wrote no record"
// ---
console.log("\n§ 146 — unreadable .meta.json\n");
if (isRoot) {
	skip("root reads a mode-000 file, so § 146 cannot build its unreadable meta");
} else {
	const { sessionPath, subDir } = claudeSession("meta-unreadable");
	fs.writeFileSync(path.join(subDir, "agent-aaaa.jsonl"), turn("msg_child"));
	const metaPath = path.join(subDir, "agent-aaaa.meta.json");
	fs.writeFileSync(metaPath, JSON.stringify({ agentType: "general-purpose", spawnDepth: 1 }));
	fs.chmodSync(metaPath, 0o000);
	let run;
	try { run = runJson(sessionPath); } finally { fs.chmodSync(metaPath, 0o644); }
	const rows = run.doc?.subagents ?? [];
	check(rows.length === 1 && rows[0].meta === null, "precondition: the child is listed with meta null", JSON.stringify(rows));
	const notice = (run.doc?.notices ?? []).find((n: any) => n.code === "subagent-meta-unreadable");
	check(notice !== undefined && String(notice.text).includes(metaPath),
		"an unreadable meta carries a subagent-meta-unreadable notice naming the file", JSON.stringify(run.doc?.notices));

	const absent = claudeSession("meta-absent");
	fs.writeFileSync(path.join(absent.subDir, "agent-bbbb.jsonl"), turn("msg_child"));
	const clean = runJson(absent.sessionPath);
	check((clean.doc?.subagents ?? []).length === 1, "control precondition: the meta-less child is listed");
	check(!(clean.doc?.notices ?? []).some((n: any) => n.code === "subagent-meta-unreadable"),
		"an absent meta carries no such notice", JSON.stringify(clean.doc?.notices));
}

// ---
// § 147 — first line only
// ---
console.log("\n§ 147 — discovery reads line 1, not the whole transcript\n");
{
	const dir = path.join(root, "pi-big");
	fs.mkdirSync(dir, { recursive: true });
	const filler = ("x".repeat(1023) + "\n").repeat(4096); // 4 MiB after the header
	const main = path.join(dir, "main.jsonl");
	const child = path.join(dir, "child.jsonl");
	const stranger = path.join(dir, "stranger.jsonl");
	fs.writeFileSync(main, JSON.stringify({ type: "session", id: "pi-main" }) + "\n" + filler);
	fs.writeFileSync(child, JSON.stringify({ type: "session", id: "pi-child", parentSession: "pi-main" }) + "\n" + filler);
	fs.writeFileSync(stranger, JSON.stringify({ type: "session", id: "pi-other", parentSession: "someone-else" }) + "\n" + filler);

	const driver = path.join(root, "discover-driver.mjs");
	fs.writeFileSync(driver, `import { discoverSubagentSessionFiles } from ${JSON.stringify(CLI_BIN)};\n`
		+ `process.stdout.write(JSON.stringify(discoverSubagentSessionFiles(process.argv[2])));\n`);
	const spyOut = path.join(root, "spy-147.json");
	const r = spawnSync("node", ["--import", SPY, driver, main], { encoding: "utf8", env: { ...process.env, FS_SPY_OUT: spyOut } });
	let found: any = null;
	try { found = JSON.parse(r.stdout); } catch { /* asserted below */ }
	check(found !== null && found.files.length === 1 && found.files[0] === child && found.unreadable === null,
		"precondition: the Pi child is discovered and the stranger is not", r.stdout + r.stderr);
	const spy = JSON.parse(fs.readFileSync(spyOut, "utf8"));
	const bytes = [main, child, stranger].reduce((sum, f) => sum + (spy.bytesRead[f] ?? 0), 0);
	check(bytes < 1024 * 1024, `discovery reads under 1 MiB of three 4 MiB transcripts (${bytes} bytes)`);
}

// ---
// § 148 — depth truncation and symlink cycles
// ---
console.log("\n§ 148 — depth truncation, symlink cycle\n");
{
	// No depth cap: the walk is bounded by visiting each real directory once,
	// so a transcript nested past Claude Code's own limit is still listed
	// rather than cut off from a list that looks complete.
	const deep = claudeSession("depth-deep");
	let dir = deep.subDir;
	for (let i = 1; i < 8; i++) dir = path.join(dir, `agent-l${i}`, "subagents");
	fs.mkdirSync(dir, { recursive: true });
	const leaf = path.join(dir, "agent-leaf.jsonl");
	fs.writeFileSync(leaf, turn("msg_leaf"));
	const found = discoverSubagentSessionFiles(deep.sessionPath);
	check(found.files.includes(leaf) && found.unreadable === null,
		"a transcript nested eight levels deep is listed, and nothing is reported");
	const deepRun = runJson(deep.sessionPath);
	check((deepRun.doc?.subagents ?? []).some((r: any) => r.transcript === leaf) && deepRun.doc?.provisional?.provisional === false,
		"--json lists it and the report stays settled", JSON.stringify({ rows: deepRun.doc?.subagents, provisional: deepRun.doc?.provisional }));

	if (!isRoot) {
		// The meta notice survives an incomplete discovery. A directory that can
		// be listed but not traversed (r--) makes its entries unstat-able: the
		// walk reports that, the rows are withheld, and the unreadable meta
		// beside the readable top-level child is still named.
		const both = claudeSession("incomplete-meta");
		fs.writeFileSync(path.join(both.subDir, "agent-top.jsonl"), turn("msg_top"));
		const topMeta = path.join(both.subDir, "agent-top.meta.json");
		fs.writeFileSync(topMeta, JSON.stringify({ agentType: "general-purpose", spawnDepth: 1 }));
		const locked = path.join(both.subDir, "agent-locked");
		fs.mkdirSync(locked);
		fs.writeFileSync(path.join(locked, "agent-inner.jsonl"), turn("msg_inner"));
		fs.chmodSync(locked, 0o444);
		fs.chmodSync(topMeta, 0o000);
		let r;
		try { r = runJson(both.sessionPath); } finally { fs.chmodSync(topMeta, 0o644); fs.chmodSync(locked, 0o755); }
		check(r.doc !== null && !("subagents" in r.doc) && r.doc.provisional?.reason === "subagent-unreadable",
			"precondition: incomplete discovery withholds the rows", JSON.stringify({ keys: r.doc && Object.keys(r.doc), provisional: r.doc?.provisional }));
		check((r.doc?.notices ?? []).some((n: any) => n.code === "subagent-meta-unreadable" && String(n.text).includes(topMeta)),
			"…and the unreadable meta's notice is still emitted", JSON.stringify(r.doc?.notices));
	}

	const cyc = claudeSession("symlink-cycle");
	fs.writeFileSync(path.join(cyc.subDir, "agent-cccc.jsonl"), turn("msg_child") + compaction);
	fs.symlinkSync(".", path.join(cyc.subDir, "loop"));
	const cycRun = runJson(cyc.sessionPath);
	check((cycRun.doc?.subagents ?? []).length === 1, `a 'loop -> .' symlink lists the child once (${(cycRun.doc?.subagents ?? []).length} rows)`);
	check(cycRun.doc?.uncounted?.compaction === 1, `…and its one compaction counts once (${cycRun.doc?.uncounted?.compaction})`);
}

// ---
// § 149 — #137's undefended invariants
// ---
console.log("\n§ 149 — #137's invariants\n");
{
	// The discoverOnce memo: one `--json` run walks the subagents dir once.
	const memo = claudeSession("memo");
	fs.writeFileSync(path.join(memo.subDir, "agent-dddd.jsonl"), turn("msg_child"));
	const spyOut = path.join(root, "spy-149.json");
	const run = runJson(memo.sessionPath, spyOut);
	check(run.doc !== null && (run.doc.subagents ?? []).length === 1, "precondition: the memo fixture reports its child", run.stderr.slice(0, 300));
	const spy = JSON.parse(fs.readFileSync(spyOut, "utf8"));
	const walks = spy.readdirCalls[memo.subDir] ?? 0;
	check(walks === 1, `one --json run walks the subagents dir exactly once (${walks})`);

	// isFork: carried when present, either value; undefined when absent.
	const metaDir = path.join(root, "meta");
	fs.mkdirSync(metaDir, { recursive: true });
	const withMeta = (name: string, meta: object): string => {
		const t = path.join(metaDir, `${name}.jsonl`);
		fs.writeFileSync(t, "");
		fs.writeFileSync(path.join(metaDir, `${name}.meta.json`), JSON.stringify(meta));
		return t;
	};
	const base = { agentType: "general-purpose", spawnDepth: 1 };
	check(readSubagentMeta(withMeta("agent-fork-true", { ...base, isFork: true }))?.isFork === true, "isFork: true is carried");
	check(readSubagentMeta(withMeta("agent-fork-false", { ...base, isFork: false }))?.isFork === false, "isFork: false is carried");
	const noFork = readSubagentMeta(withMeta("agent-fork-absent", base));
	check(noFork !== null && noFork.isFork === undefined, "isFork is undefined when the meta has none");

	// The .jsonl guard: without it, `.jsonl`'s six characters are sliced off a
	// four-character extension and the reader opens an unrelated neighbour.
	// The decoy sits exactly where that slice lands, and holds a valid meta.
	const txt = path.join(metaDir, "agent-a.txt");
	fs.writeFileSync(txt, "");
	fs.writeFileSync(txt.slice(0, -".jsonl".length) + ".meta.json", JSON.stringify(base));
	check(readSubagentMeta(txt) === null, "a non-.jsonl transcript path reads no meta, not a mis-sliced neighbour");

	// The Pi-sibling row: spec-26's "both patterns it knows".
	const piDir = path.join(root, "pi-rows");
	fs.mkdirSync(piDir, { recursive: true });
	const piMain = path.join(piDir, "pi-main.jsonl");
	const piChild = path.join(piDir, "pi-child.jsonl");
	fs.writeFileSync(piMain, JSON.stringify({ type: "session", id: "pi-row-main", cwd: root }) + "\n");
	fs.writeFileSync(piChild, JSON.stringify({ type: "session", id: "pi-row-child", parentSession: "pi-row-main", cwd: root }) + "\n");
	writeTag(piMain, "msg_pi_parent");
	const piRun = runJson(piMain);
	const piRows = piRun.doc?.subagents ?? [];
	const piRow = piRows.find((r: any) => r.transcript === piChild);
	check(piRow !== undefined && piRow.meta === null, "a Pi sibling is listed as a subagent row with meta null", JSON.stringify(piRows));
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

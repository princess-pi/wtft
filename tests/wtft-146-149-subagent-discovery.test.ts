#!/usr/bin/env -S bun
/**
 * tests/wtft-146-149-subagent-discovery.test.ts — subagent discovery and meta
 * reading, #146–#149.
 *
 *   § 146  an unreadable `.meta.json` gets a notice; an absent one does not.
 *   § 147  discoverSubagentSessionFiles reads a header's first line, not the
 *          whole transcript, and a `claude -p` scan skips a directory named
 *          `*.jsonl` instead of reading it.
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

{
	// A directory named `*.jsonl` holds no transcript, and reading one throws
	// EISDIR — which the catch below would report as an unreadable transcript,
	// withholding the daemon's swept marker on every poll from then on.
	const home = path.join(root, "claude-home");
	const cwd = path.join(root, "bash-spawn-cwd");
	const projectDir = path.join(home, ".claude", "projects", cwd.replace(/\//g, "-"));
	fs.mkdirSync(projectDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	const stamp = new Date().toISOString();
	const spawned = path.join(projectDir, "spawned.jsonl");
	fs.writeFileSync(spawned, JSON.stringify({ type: "assistant", timestamp: stamp }) + "\n");
	fs.mkdirSync(path.join(projectDir, "not-a-transcript.jsonl"));
	// A SYMLINK to a directory is not `isDirectory()`, so only its EISDIR says
	// what it is.
	fs.symlinkSync(path.join(projectDir, "not-a-transcript.jsonl"), path.join(projectDir, "linked-dir.jsonl"));

	const driver = path.join(root, "claude-p-driver.mjs");
	fs.writeFileSync(driver, `import { discoverClaudeSubAgentSessionFiles } from ${JSON.stringify(CLI_BIN)};\n`
		+ `process.stdout.write(JSON.stringify(discoverClaudeSubAgentSessionFiles(process.argv[2], Date.parse(process.argv[3]))));\n`);
	const r = spawnSync("node", [driver, cwd, stamp], { encoding: "utf8", env: { ...process.env, HOME: home } });
	let out: any = null;
	try { out = JSON.parse(r.stdout); } catch { /* asserted below */ }
	check(out !== null && out.files.length === 1 && out.files[0] === spawned,
		"a `claude -p` transcript beside a directory named *.jsonl is still discovered", r.stdout + r.stderr);
	check(out !== null && out.unreadable === null,
		"…and the directory itself is not reported unreadable", JSON.stringify(out && out.unreadable));
}

// ---
// § 148 — unbounded depth and symlink cycles
// ---
console.log("\n§ 148 — unbounded depth, symlink cycle\n");
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

	// A symlinked DIRECTORY is not traversed: `seen` bounds a cycle but not an
	// acyclic foreign tree, so `subagents/all -> /` would walk the filesystem.
	const esc = claudeSession("symlink-escape");
	const inside = path.join(esc.subDir, "agent-in.jsonl");
	fs.writeFileSync(inside, turn("msg_in"));
	const outside = path.join(root, "outside-tree");
	fs.mkdirSync(outside, { recursive: true });
	fs.writeFileSync(path.join(outside, "agent-out.jsonl"), turn("msg_out"));
	fs.symlinkSync(outside, path.join(esc.subDir, "all"));
	const escFound = discoverSubagentSessionFiles(esc.sessionPath);
	check(escFound.files.length === 1 && escFound.files[0] === inside && escFound.unreadable === null,
		`a symlinked directory is not walked (${escFound.files.length} files)`, JSON.stringify(escFound.files));

	// Both halves dedup by real path, not by the string they happened to
	// build: a Pi sibling symlinked to an already-walked Claude child is one
	// transcript, and listing it twice would double-count its cost.
	const dualDir = path.join(projects, "-sandbox-dual");
	const dualSession = path.join(dualDir, "dual.jsonl");
	const dualSub = path.join(dualDir, "dual", "subagents");
	fs.mkdirSync(dualSub, { recursive: true });
	fs.writeFileSync(dualSession, JSON.stringify({ type: "session", id: "dual-main" }) + "\n" + turn("msg_dual_parent"));
	const walked = path.join(dualSub, "agent-eeee.jsonl");
	fs.writeFileSync(walked, JSON.stringify({ type: "session", id: "dual-child", parentSession: "dual-main" }) + "\n" + turn("msg_dual"));
	fs.symlinkSync(walked, path.join(dualDir, "sibling.jsonl"));
	// Same in the Pi half: a sibling that is a symlink to a directory holds no
	// cost and must not report the session unreadable.
	fs.mkdirSync(path.join(dualDir, "a-directory"));
	fs.symlinkSync(path.join(dualDir, "a-directory"), path.join(dualDir, "linked-dir.jsonl"));
	const dualFound = discoverSubagentSessionFiles(dualSession);
	check(dualFound.files.length === 1 && dualFound.files[0] === walked && dualFound.unreadable === null,
		`a Pi sibling symlinked to a walked Claude child is listed once (${dualFound.files.length} files)`, JSON.stringify(dualFound.files));
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

	// Same invariant on the widget, the surface the guard was extracted from:
	// one render walks the subagents dir once, not once for the interactions
	// and again for the spawn tree.
	{
		const w = claudeSession("widget-memo");
		fs.writeFileSync(path.join(w.subDir, "agent-ffff.jsonl"), turn("msg_widget_child"));
		const home = path.join(root, "widget-home");
		fs.mkdirSync(path.join(home, "xdg", "wtft"), { recursive: true });
		fs.writeFileSync(path.join(home, "xdg", "wtft", "config.json"), "{}\n");
		const widgetDriver = path.join(root, "widget-driver.mjs");
		fs.writeFileSync(widgetDriver,
			`import * as mod from ${JSON.stringify(path.join(REPO, "pi", "wtft.js"))};\n`
			+ `const handlers = {};\n`
			+ `let command;\n`
			+ `mod.default({ on: (n, f) => { handlers[n] = f; }, registerCommand: (_n, d) => { command = d.handler; } });\n`
			+ `const ctx = { sessionManager: { getSessionFile: () => process.argv[2] }, ui: { setWidget: () => {}, notify: () => {}, custom: () => {} }, model: undefined, width: 80 };\n`
			+ `await handlers["agent_settled"](undefined, ctx);\n`
			+ `if (process.argv[3]) await command(process.argv[3], ctx);\n`);
		const widgetSpy = path.join(root, "spy-149-widget.json");
		const wr = spawnSync("node", ["--import", SPY, widgetDriver, w.sessionPath], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "xdg"), FS_SPY_OUT: widgetSpy, WTFT_CLAUDE_PROJECTS_DIR: projects },
		});
		const wSpy = fs.existsSync(widgetSpy) ? JSON.parse(fs.readFileSync(widgetSpy, "utf8")) : { readdirCalls: {} };
		const wWalks = wSpy.readdirCalls[w.subDir] ?? 0;
		check(wWalks === 1, `one widget render walks the subagents dir exactly once (${wWalks})`, wr.stderr.slice(0, 300));

		// `/wtft --tokens` walks three times: the settle render above, the
		// command's own re-render, and the summary's read. The spawn tree's
		// double-count guard adds none — it takes the list that read produced.
		const tokensSpy = path.join(root, "spy-149-widget-tokens.json");
		const tr = spawnSync("node", ["--import", SPY, widgetDriver, w.sessionPath, "--tokens"], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "xdg"), FS_SPY_OUT: tokensSpy, WTFT_CLAUDE_PROJECTS_DIR: projects },
		});
		const tSpy = fs.existsSync(tokensSpy) ? JSON.parse(fs.readFileSync(tokensSpy, "utf8")) : { readdirCalls: {} };
		const tWalks = tSpy.readdirCalls[w.subDir] ?? 0;
		check(tWalks === 3, `/wtft --tokens adds no walk for the spawn tree (${tWalks} walks, one per read)`, tr.stderr.slice(0, 300));
	}

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

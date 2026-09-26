#!/usr/bin/env -S bun
/**
 * The daemon's tag output over the golden corpus is pinned.
 *
 * Each later slice must leave every golden unchanged. Regenerate with
 * `WTFT_GOLDEN_UPDATE=1 bun tests/wtft-270-golden-tags.test.ts` and read the diff.
 *
 * Compared as a normalised line multiset plus a parsed view, not as bytes in
 * file order: the order children are read follows `readdir`, which the
 * filesystem decides. Normalised away: the sandbox path and its slug, source
 * hashes (relabelled by child), heartbeat and sweep clocks, and the byte
 * offset marker, which follows the sandbox path's length.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { readTagFileWithVerdict, getCurrentVersionTagPath } from "../extensions/lib/wtft-daemon-lib.ts";
import { normaliseTag, viewOf } from "./lib/golden-normalise.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { writeCorpus, type CorpusSession } from "./lib/golden-corpus.ts";

const DAEMON_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.mjs");
const GOLDEN_DIR = path.resolve(import.meta.dirname, "fixtures", "270-golden-tags");
const UPDATE = process.env.WTFT_GOLDEN_UPDATE === "1";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

isolateTmpdir("270-golden");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

// The suite runs the bundle stock node runs, so an edited source with no build
// would pass against yesterday's daemon. Refuse that outright.
const libDir = path.resolve(import.meta.dirname, "..", "extensions", "lib");
const daemonSources = [
	path.resolve(import.meta.dirname, "..", "bin", "wtft-daemon.ts"),
	...fs.readdirSync(libDir, { recursive: true, encoding: "utf8" }).filter(f => f.endsWith(".ts")).map(f => path.join(libDir, f)),
];
const newestSourceMs = Math.max(...daemonSources.map(f => fs.statSync(f).mtimeMs));
check(fs.statSync(DAEMON_BIN).mtimeMs > newestSourceMs, "fixture precondition: bin/wtft-daemon.mjs is newer than every daemon source (else run bun run build)");
if (failed > 0) { console.log(`\n${passed} passed, ${failed} failed`); process.exit(1); }

const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-270-golden-")));
const corpus = writeCorpus(root);
process.env.WTFT_CLAUDE_PROJECTS_DIR = corpus.projects;

// ---

async function runDaemon(s: CorpusSession): Promise<string> {
	const tagPath = getCurrentVersionTagPath(s.session);
	const daemon = spawn(process.execPath, [DAEMON_BIN, "--session", s.session], { detached: true, stdio: "ignore", env: { ...process.env } });
	daemon.unref();
	// Settled, then one more poll with nothing to do, so the heartbeat after
	// the data is in the file too.
	let settled = false;
	for (let i = 0; i < 80 && !settled; i++) {
		await sleep(250);
		if (!fs.existsSync(tagPath)) continue;
		const read = readTagFileWithVerdict(tagPath);
		settled = read.interactions.length > 0 && !read.provisional.provisional;
	}
	await sleep(1_500);
	try { if (daemon.pid) process.kill(daemon.pid, "SIGTERM"); } catch { /* already gone */ }
	for (let i = 0; i < 40; i++) {
		try { if (daemon.pid) process.kill(daemon.pid, 0); } catch { break; }
		await sleep(100);
	}
	check(settled, `${s.name}: the daemon stamped the tag swept`);
	return tagPath;
}

// ---

console.log(`\nGolden tags — ${UPDATE ? "UPDATING" : "comparing"} ${GOLDEN_DIR}`);
const tags = await Promise.all(corpus.sessions.map(s => runDaemon(s).then(tag => [s, tag] as const)));

if (UPDATE) fs.mkdirSync(GOLDEN_DIR, { recursive: true });
for (const [s, tagPath] of tags) {
	const lines = normaliseTag(fs.readFileSync(tagPath, "utf8"), s, root);
	const view = viewOf(tagPath, s);
	const linesFile = path.join(GOLDEN_DIR, `${s.name}.lines.jsonl`);
	const viewFile = path.join(GOLDEN_DIR, `${s.name}.view.json`);
	if (UPDATE) {
		fs.writeFileSync(linesFile, lines.join("\n") + "\n");
		fs.writeFileSync(viewFile, JSON.stringify(view, null, 2) + "\n");
		console.log(`  wrote ${s.name}: ${lines.length} lines, ${JSON.stringify(view)}`);
		continue;
	}
	const wantLines = fs.readFileSync(linesFile, "utf8").split("\n").filter(l => l.trim());
	const wantView = JSON.parse(fs.readFileSync(viewFile, "utf8"));
	const sameLines = lines.length === wantLines.length && lines.every((l, k) => l === wantLines[k]);
	if (!sameLines) {
		const got = new Set(lines);
		const want = new Set(wantLines);
		for (const l of wantLines) if (!got.has(l)) console.error(`    - ${l}`);
		for (const l of lines) if (!want.has(l)) console.error(`    + ${l}`);
	}
	check(sameLines, `${s.name}: the normalised tag lines match the golden (${lines.length} lines)`);
	check(JSON.stringify(view) === JSON.stringify(wantView),
		`${s.name}: the parsed view matches the golden (got ${JSON.stringify(view)})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

#!/usr/bin/env -S bun
/**
 * The session's own transcript rotating under the tagger: the tag's total is the new content's,
 * never old plus new. docs/wtft-tag-format.md §2e.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCurrentVersionTagPath, readTagFileWithVerdict } from "../extensions/lib/wtft-daemon-lib.ts";
import { newTaggerState, stepTagger, fsWorld } from "../extensions/lib/session-tagger.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";
import { ccUser, ccAssistant, ccProjectFile, UUID, T0, bash } from "./lib/golden-corpus.ts";
import { tagRecords, lastOffset } from "../extensions/lib/tag-log.ts";

isolateTmpdir("202-own-rotation");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const root = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-202-")));
const projects = path.join(root, "projects");
process.env.WTFT_CLAUDE_PROJECTS_DIR = projects;
const cwd = path.join(root, "work");

function transcript(first: number, count: number, output: number): string {
	let s = "";
	for (let i = 0; i < count; i++) {
		s += ccUser(T0 + (first + i) * 60_000, cwd);
		s += ccAssistant({ id: `msg_${first + i}`, tsMs: T0 + (first + i) * 60_000 + 1000, output });
	}
	return s;
}

function run(name: string, n: number, replace: (file: string, content: string) => void) {
	const session = ccProjectFile(projects, cwd, UUID(n));
	const tagPath = getCurrentVersionTagPath(session);
	fs.mkdirSync(path.dirname(tagPath), { recursive: true });
	fs.writeFileSync(session, transcript(0, 5, 1000));
	let now = Date.now();
	const world = fsWorld(() => now);
	const state = newTaggerState(session, tagPath);
	const poll = (times: number) => {
		for (let i = 0; i < times; i++) {
			const r = stepTagger(state, world, { flush: true });
			if (r.records) fs.appendFileSync(tagPath, r.records);
			now += 700;
		}
	};
	poll(4);
	const before = readTagFileWithVerdict(tagPath).interactions.filter(i => !i.isSidechain);
	check(before.length === 5, `${name}: fixture precondition: the tag holds the 5 old turns (${before.length})`);
	replace(session, transcript(100, 2, 7));
	poll(4);
	const after = readTagFileWithVerdict(tagPath).interactions.filter(i => !i.isSidechain);
	const ids = after.map(i => i.messageId ?? i.id).join(",");
	check(after.length === 2, `${name}: the tag counts only the 2 new turns (${after.length}: ${ids})`);
	check(after.every(i => i.outputTokens === 7), `${name}: and they are the new ones`);
	const total = after.reduce((sum, i) => sum + i.outputTokens, 0);
	check(total === 14, `${name}: the tag's output total is the new transcript's (${total})`);
}

console.log("\n202 — rotated to empty, with a claude -p lookup open");
{
	const session = ccProjectFile(projects, cwd, UUID(3));
	const tagPath = getCurrentVersionTagPath(session);
	fs.mkdirSync(path.dirname(tagPath), { recursive: true });
	fs.writeFileSync(session, ccUser(T0, cwd) + ccAssistant({ id: "msg_spawn", tsMs: T0 + 1000, output: 5, blocks: [bash("claude -p hello")] }));
	let now = T0 + 2000;
	const world = fsWorld(() => now);
	const state = newTaggerState(session, tagPath);
	const poll = () => {
		const r = stepTagger(state, world, { flush: true });
		if (r.records) fs.appendFileSync(tagPath, r.records);
		now += 700;
		return r;
	};
	poll();
	check(state.pendingClaudeCommands.length === 1, "fixture precondition: the spawning turn opened a lookup");
	fs.writeFileSync(session, "");
	const r = poll();
	check(r.wrote, "the step that wrote the generation record reports a write");
	check(state.pendingClaudeCommands.length === 0, "the old transcript's lookup is dropped");
	const records = tagRecords(fs.readFileSync(tagPath, "utf8"));
	check(records.some(x => x.kind === "spawn-settled"), "and settled in the tag, so a resume does not reopen it");
	check(lastOffset(records) === 0, "the offset marker is back at 0");
	for (let i = 0; i < 6; i++) poll();
	check(!readTagFileWithVerdict(tagPath).provisional.provisional, "a later clean poll stamps the tag swept");
}

console.log("\n202 — the session's own transcript rotates");
run("shrunk in place", 1, (file, content) => fs.writeFileSync(file, content));
run("replaced by a new file", 2, (file, content) => {
	fs.writeFileSync(`${file}.new`, content);
	fs.renameSync(`${file}.new`, file);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

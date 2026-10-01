#!/usr/bin/env -S node --experimental-strip-types
/**
 * --watch follows its tag file when it is replaced at the same path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";
import { replacedTagFile, getCurrentVersionTagPath } from "../extensions/lib/wtft-daemon-lib.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-139-")));
const session = path.join(dir, "s.jsonl");
fs.writeFileSync(session, "");
const tag = getCurrentVersionTagPath(session);
fs.mkdirSync(path.dirname(tag), { recursive: true });
fs.writeFileSync(tag, "a\n");
const ino = fs.statSync(tag).ino;

check(replacedTagFile(tag, ino, session) === null, "the watched file, unchanged, is not a replacement");

fs.renameSync(tag, path.join(dir, "old-tag"));
check(replacedTagFile(tag, ino, session) === null, "a file moved away with nothing in its place is not a replacement yet");

fs.writeFileSync(tag, "b\n");
const fresh = fs.statSync(tag).ino !== ino;
check(fresh, "fixture: the recreated file has a new inode");
if (fresh) {
	const next = replacedTagFile(tag, ino, session);
	check(next !== null && next.path === tag && next.ino === fs.statSync(tag).ino, `a file recreated at the same path is followed (got ${JSON.stringify(next)})`);
}

const same = fs.statSync(tag).ino;
check(replacedTagFile(tag, same, session, true)?.path === tag, "after the watcher saw a rename, a file at the same path is followed even with the same inode");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

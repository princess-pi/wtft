#!/usr/bin/env -S node --experimental-strip-types
/**
 * --watch's incremental tag read closes its fd when the read throws.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox } from "./lib/sandbox";
import { readAppended } from "../extensions/lib/wtft-daemon-lib.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

function fdsOn(target: string): number {
	const real = fs.realpathSync(target);
	let n = 0;
	for (const fd of fs.readdirSync("/proc/self/fd")) {
		try { if (fs.readlinkSync(`/proc/self/fd/${fd}`) === real) n++; } catch { /* closed while listing */ }
	}
	return n;
}

const dir = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-530-")));
const tag = path.join(dir, "s.tag.jsonl");
fs.writeFileSync(tag, "a\nb\n");
check(readAppended(tag, 2, 4).toString("utf8") === "b\n", "reads the bytes appended after the offset");
check(fdsOn(tag) === 0, "a successful read leaves no fd open on the tag file");

const unreadable = path.join(dir, "a-directory");
fs.mkdirSync(unreadable);
const probe = fs.openSync(unreadable, "r");
check(fdsOn(unreadable) === 1, `fixture: the count sees a held fd, and the open succeeds so a throw comes from the read (got ${fdsOn(unreadable)})`);
fs.closeSync(probe);
let throws = 0;
for (let i = 0; i < 5; i++) {
	try { readAppended(unreadable, 0, 8); } catch { throws++; }
}
check(throws === 5, `fixture: every read throws (got ${throws} of 5)`);
check(fdsOn(unreadable) === 0, `no fd left open after 5 throwing reads (got ${fdsOn(unreadable)})`);

const lib = fs.readFileSync(new URL("../extensions/lib/wtft-daemon-lib.ts", import.meta.url), "utf8");
const watch = lib.slice(lib.indexOf("export async function watchTagFile("));
const body = watch.slice(0, watch.indexOf("\nexport ", 1));
check(body.includes("readAppended(") && !body.includes("fs.openSync("), "watchTagFile reads its tag through readAppended and opens no fd of its own");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

#!/usr/bin/env -S node --experimental-strip-types
/**
 * The title's session suffix strips a literal `.jsonl`, and only that.
 */

import { buildWtftLines } from "../extensions/lib/wtft-renderer.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const ix = [{
	timestamp: Date.parse("2026-09-26T10:00:00Z"), cost: 1, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0,
	cacheWriteTokens: 0, reasoningTokens: 0, files: [], commands: [], texts: [], unrecognizedTool: false, serverToolCost: 0,
}] as any[];
const settings = { interval: "1h", limit: 5, width: 120, mode: "cumulative" as const, timezone: "UTC" };
const title = (suffix: string) => (buildWtftLines(ix, settings, { sessionNameSuffix: suffix }) ?? [])[0]!.replace(/\x1b\[[0-9;]*m/g, "");

check(title("a1b2c3d4.jsonl").includes("...c3d4"), `a .jsonl session ends in its last four name characters (${title("a1b2c3d4.jsonl")})`);
check(title("abcxjsonl").includes("...sonl"), `a name ending xjsonl keeps its own last four characters (${title("abcxjsonl")})`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

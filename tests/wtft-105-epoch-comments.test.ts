#!/usr/bin/env -S node --experimental-strip-types
/**
 * Every effectiveBefore epoch in MODEL_PRICING matches the ISO comment beside it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as cost from "../extensions/lib/wtft-cost.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const source = fs.readFileSync(path.resolve(import.meta.dirname, "..", "extensions", "lib", "wtft-cost.ts"), "utf8");
const pairs = [...source.matchAll(/effectiveBefore:\s*([A-Z0-9_]+|\d+)\s*\/\*\s*(\S+)\s*\*\//g)];
check(pairs.length === source.split("effectiveBefore:").length - 2,
	`every effectiveBefore window in wtft-cost.ts carries an ISO comment (${pairs.length} found)`);
for (const [, expr, iso] of pairs) {
	const epoch = /^\d+$/.test(expr) ? Number(expr) : (cost as Record<string, unknown>)[expr];
	check(typeof epoch === "number" && epoch === Date.parse(iso),
		`${expr} = ${typeof epoch === "number" ? new Date(epoch).toISOString() : "not an exported number"}, comment says ${iso}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

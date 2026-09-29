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
const windows = [...source.matchAll(/effectiveBefore:\s*(?!number\b)\S/g)].length;
const pairs = [...source.matchAll(/effectiveBefore:\s*([A-Z0-9_]+|\d+)\s*\/\*\s*(\S+Z)\s*\*\//g)];
check(windows > 0 && pairs.length === windows,
	`every one of the ${windows} effectiveBefore windows in wtft-cost.ts carries a UTC ISO comment (${pairs.length} do)`);
for (const [, expr, iso] of pairs) {
	const epoch = /^\d+$/.test(expr) ? Number(expr) : (cost as Record<string, unknown>)[expr];
	check(typeof epoch === "number" && epoch === Date.parse(iso),
		`${expr} = ${typeof epoch === "number" ? `${epoch} (${new Date(epoch).toISOString()})` : "not an exported number"}, comment says ${iso}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

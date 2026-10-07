#!/usr/bin/env bun
/**
 * --pad and --thinking-budget leave an unusable next argument for the parser, as -l and -w do.
 */

import { parseWtftCliArgs } from "../extensions/lib/wtft-cli-shared.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const good = parseWtftCliArgs(["--pad", "3", "--thinking-budget", "800"]);
check(good.pad === 3 && good.thinkingBudget === 800, `fixture precondition: valid values are taken (${good.pad}, ${good.thinkingBudget})`);
check(parseWtftCliArgs(["--pad", "--tokens"]).tokens === true, "--pad with no number does not swallow --tokens");
check(parseWtftCliArgs(["--pad", "-2", "--tokens"]).tokens === true, "--pad with a negative value does not swallow --tokens");
check(parseWtftCliArgs(["--thinking-budget", "--tokens"]).tokens === true, "--thinking-budget with no number does not swallow --tokens");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

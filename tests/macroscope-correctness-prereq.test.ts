#!/usr/bin/env bun
/**
 * .macroscope/correctness/correctness.md names this repo's CI check as a prerequisite, by the check name the PR's Checks tab shows.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const FILE = path.join(REPO, ".macroscope", "correctness", "correctness.md");
const CI = path.join(REPO, ".github", "workflows", "ci.yml");
const CI_JOB = "git-channel";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detail = "") {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}${detail ? `\n     ${detail}` : ""}`); }
}

const ci = fs.readFileSync(CI, "utf8").replace(/\r/g, "");
const lines = ci.split("\n");
const jobsAt = lines.findIndex((l) => l === "jobs:");
const jobAt = lines.findIndex((l, i) => i > jobsAt && l === `  ${CI_JOB}:`);
check(jobsAt >= 0 && jobAt > jobsAt, `fixture precondition: ci.yml has job '${CI_JOB}'`);
const block: string[] = [];
for (const l of lines.slice(jobAt + 1)) {
	if (/^ {0,2}\S/.test(l) && !/^\s*#/.test(l)) break;
	block.push(l);
}
const direct = block.filter((l) => /^ {4}\S/.test(l) && !/^ {4}#/.test(l));
check(!direct.some((l) => /^ {4}(strategy|uses|if):/.test(l)), `job '${CI_JOB}' has no matrix, reusable workflow or if:, so a check named by its name: line exists on every head`);
const checkName = direct.find((l) => /^ {4}name: /.test(l))?.replace(/^ {4}name: /, "").trim() ?? CI_JOB;
const trigger = lines.slice(0, jobsAt);
check(!trigger.some((l) => /^\s+(paths|paths-ignore|branches-ignore|types):/.test(l)), "ci.yml triggers carry no path or type filter");
check(trigger.some((l) => l === "  pull_request:"), "ci.yml runs on pull_request");

// Exact text: any other key, list form, quoting or second block fails here instead of parsing differently from Macroscope.
const expected = `---\nrequires:\n  - "${checkName}"\nwaitsForDiscoveryTimeout: 5\nwaitsForTimeout: 30\n---\n`;
const actual = fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : "";
check(actual === expected, "correctness.md is exactly one requires entry (the Checks-tab name of the CI job), waitsForDiscoveryTimeout 5 and waitsForTimeout 30", JSON.stringify(actual));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

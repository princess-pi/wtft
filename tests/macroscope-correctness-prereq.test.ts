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

const raw = fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : "";
check(raw !== "", ".macroscope/correctness/correctness.md exists");

const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
const fmLines = fm.split("\n");

// Only these front-matter shapes are read; any other line (flow list, scalar, other indent) fails here instead of parsing to [].
const shapes = fmLines.filter((l) => !/^(requires|waitsFor):$/.test(l) && !/^  - "?[^"\n]+"?$/.test(l) && !/^(waitsForTimeout|waitsForDiscoveryTimeout): \d+$/.test(l));
check(shapes.length === 0, "front matter uses only block lists and integer fields", shapes.join(" | "));

const list = (key: string): string[] => {
	const start = fmLines.indexOf(`${key}:`);
	if (start < 0) return [];
	const out: string[] = [];
	for (const l of fmLines.slice(start + 1)) {
		const m = l.match(/^  - "?([^"\n]+)"?$/);
		if (!m) break;
		out.push(m[1].trim());
	}
	return out;
};
const num = (key: string): number | undefined => {
	const m = fm.match(new RegExp(`^${key}: (\\d+)$`, "m"));
	return m ? Number(m[1]) : undefined;
};

const ci = fs.readFileSync(CI, "utf8");
const jobsText = ci.slice(ci.search(/^jobs:$/m));
const block = jobsText.match(new RegExp(`^  ${CI_JOB}:\\n((?:    .*\\n|\\n)*)`, "m"))?.[1] ?? "";
check(block !== "", `fixture precondition: ci.yml has job '${CI_JOB}'`);
check(!/^    strategy:/m.test(block), `job '${CI_JOB}' has no matrix, so its check name is its name: line`);
const checkName = block.match(/^    name: (.+)$/m)?.[1].trim() ?? CI_JOB;

const requires = list("requires");
const waitsFor = list("waitsFor");
check(requires.length === 1 && requires[0] === checkName, `requires is exactly the Checks-tab name of job '${CI_JOB}' ('${checkName}')`, JSON.stringify(requires));

const cyclic = [...requires, ...waitsFor].filter((n) => n === "*" || /macroscope|review-gate/i.test(n));
check(cyclic.length === 0, "no prerequisite is Macroscope's own check or review-gate, which reads Macroscope", cyclic.join(" "));
check(new Set([...requires, ...waitsFor]).size <= 10, "at most 10 distinct prerequisite names");

check(num("waitsForTimeout") === 30, "waitsForTimeout is 30 minutes", String(num("waitsForTimeout")));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

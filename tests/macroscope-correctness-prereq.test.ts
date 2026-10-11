#!/usr/bin/env bun
/**
 * .macroscope/correctness/correctness.md makes Macroscope review a head only after this repo's own CI passes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const FILE = path.join(REPO, ".macroscope", "correctness", "correctness.md");
const WORKFLOWS = path.join(REPO, ".github", "workflows");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detail = "") {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}${detail ? `\n     ${detail}` : ""}`); }
}

const raw = fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : "";
check(raw !== "", ".macroscope/correctness/correctness.md exists");

const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
const list = (key: string): string[] => {
	const m = fm.match(new RegExp(`^${key}:\\n((?:  - .*\\n?)*)`, "m"));
	return m ? [...m[1].matchAll(/^  - "?([^"\n]+)"?$/gm)].map((x) => x[1].trim()) : [];
};
const num = (key: string): number | undefined => {
	const m = fm.match(new RegExp(`^${key}: (\\d+)$`, "m"));
	return m ? Number(m[1]) : undefined;
};

const requires = list("requires");
const waitsFor = list("waitsFor");
check(requires.includes("git-channel"), "requires names the CI job 'git-channel', so a failing head is skipped before it is billed", JSON.stringify(requires));

const jobNames = fs.readdirSync(WORKFLOWS)
	.filter((f) => f.endsWith(".yml"))
	.flatMap((f) => {
		const text = fs.readFileSync(path.join(WORKFLOWS, f), "utf8");
		const jobs = text.slice(text.search(/^jobs:$/m));
		return [...jobs.matchAll(/^  ([a-z][a-z0-9_-]*):$/gm)].map((m) => m[1]);
	});
check(jobNames.length > 0, "fixture precondition: workflow jobs found", jobNames.join(" "));
for (const name of [...requires, ...waitsFor]) {
	check(jobNames.includes(name), `prerequisite '${name}' is a job in .github/workflows`, jobNames.join(" "));
}

const cyclic = [...requires, ...waitsFor].filter((n) => n === "*" || /macroscope|review-gate/i.test(n));
check(cyclic.length === 0, "no prerequisite is Macroscope's own check or review-gate, which reads Macroscope", cyclic.join(" "));
check(new Set([...requires, ...waitsFor]).size <= 10, "at most 10 distinct prerequisite names");

const timeout = num("waitsForTimeout");
check(timeout !== undefined && timeout >= 1 && timeout <= 30, "waitsForTimeout is 1-30 minutes", String(timeout));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

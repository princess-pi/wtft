#!/usr/bin/env -S bun
/**
 * #270 S6: bin/wtft.ts `main` dispatches to the CLI arms in extensions/lib/cli/.
 * docs/spec-270-cli-arms.md § 3. Behaviour is pinned by the existing CLI suites.
 */

import * as fs from "node:fs";
import * as path from "node:path";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const root = path.resolve(import.meta.dirname, "..");
const src = fs.readFileSync(path.join(root, "bin", "wtft.ts"), "utf8").split("\n");
const start = src.findIndex(l => /^async function main\(/.test(l));
const end = start < 0 ? -1 : src.findIndex((l, i) => i > start && l === "}");
const mainLines = start >= 0 && end > start ? end - start + 1 : Infinity;

console.log("A. main is a dispatcher");
check(mainLines < 80, `bin/wtft.ts main is under 80 lines (${mainLines})`);

console.log("\nB. the arms exist and main calls each");
const arms: Array<[string, string]> = [
	["session.ts", "selectSession"],
	["force-rebuild.ts", "runForceRebuild"],
	["watch.ts", "runWatch"],
	["report.ts", "runReport"],
	["daemon-command.ts", "runDaemonCommand"],
];
const mainBody = src.slice(start, end + 1).join("\n");
for (const [file, fn] of arms) {
	const p = path.join(root, "extensions", "lib", "cli", file);
	const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
	check(new RegExp(`export (async )?function ${fn}\\(`).test(text), `extensions/lib/cli/${file} exports ${fn}`);
	check(new RegExp(`\\b${fn}\\(`).test(mainBody), `main calls ${fn}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

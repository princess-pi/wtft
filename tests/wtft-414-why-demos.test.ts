#!/usr/bin/env -S bun
/**
 * Every `--why` chart demo is the chart wtft draws for that demo's command, not a hand-drawn picture.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { whyDemo } from "../artifacts/renderer/why-demos.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "docs", "manifests", "wtft-cmd.json"), "utf8"));
const why: { commands: string[]; demo?: string[]; demoFrom?: string }[] = manifest.why;
const rendered = why.filter((entry) => entry.demoFrom === "chart");
const commands = rendered.map((entry) => entry.commands[0]);
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

for (const command of ["", "-i 4h -l 12", "--harness claude-code", "-p", "--watch"]) {
	check(commands.includes(command), `fixture precondition: the '${command}' demo is marked demoFrom chart`);
}

for (const entry of rendered) {
	const name = `'${entry.commands[0]}'`;
	const want = whyDemo(entry.commands[0]);
	const got = entry.demo ?? [];
	const first = got.findIndex((line, i) => line !== want[i]);
	check(got.length === want.length && first === -1,
		`${name}: the demo rows equal the rendered chart (${first === -1 ? `${got.length} vs ${want.length} rows` : `row ${first} differs: ${JSON.stringify(plain(got[first] ?? ""))} vs ${JSON.stringify(plain(want[first] ?? ""))}`}) — run bun run artifacts`);
	check(want.some((line) => line.includes("✨")) && want.some((line) => /█ earlier bins {2}✨ this bin/.test(plain(line))),
		`${name}: fixture precondition — the rendered cumulative chart has ✨ cells and the key line`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

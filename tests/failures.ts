#!/usr/bin/env -S bun
/**
 * `bun run test-failures [--days <n>] [--json]`: local test failures per suite per UTC day.
 * docs/spec-555-test-failure-log.md § 2.
 */

import { countFailures, failureLogPath } from "./lib/test-failure-log.ts";

const USAGE = "usage: bun run test-failures [--days <n>] [--json]";

let days = 7;
let json = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--json") json = true;
	else if (arg === "--days") {
		const value = args[++i];
		if (value === undefined || !/^[1-9]\d{0,3}$/.test(value)) {
			console.error(`--days needs a whole number from 1 to 9999, got ${JSON.stringify(value ?? "")}\n${USAGE}`);
			process.exit(2);
		}
		days = Number(value);
	} else {
		console.error(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
		process.exit(2);
	}
}

const log = failureLogPath();
const count = countFailures(log, days) ?? { days: [], unreadableLines: 0 };

if (json) {
	console.log(JSON.stringify({ schema: "wtft-test-failures@1", log, ...count }));
} else {
	if (count.days.length === 0) console.log(`no test runs in the last ${days} day(s) in ${log}`);
	for (const d of count.days) {
		const failed = Object.entries(d.failures).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
		console.log(`${d.day} (UTC): ${d.runs} run${d.runs === 1 ? "" : "s"}${failed.length === 0 ? ", no failures" : ""}`);
		for (const [suite, n] of failed) console.log(`  ${n} × ${suite}`);
	}
	if (count.unreadableLines > 0) console.log(`${count.unreadableLines} unreadable line(s) in ${log}`);
}

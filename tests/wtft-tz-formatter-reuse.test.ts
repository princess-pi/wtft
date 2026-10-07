#!/usr/bin/env bun
/**
 * A report with a timezone builds one date formatter per timezone, not one per interaction.
 */

import { getZonedParts } from "../extensions/lib/wtft-renderer.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const Real = Intl.DateTimeFormat;
let built = 0;
(Intl as { DateTimeFormat: unknown }).DateTimeFormat = new Proxy(Real, {
	construct(target, args) { built++; return Reflect.construct(target, args); },
});
const at = Date.parse("2026-03-08T08:30:00Z");
let parts: ReturnType<typeof getZonedParts>[] = [];
try {
	for (let i = 0; i < 500; i++) parts.push(getZonedParts(at + i * 60_000, "America/Denver"));
	parts.push(getZonedParts(at, "Europe/London"));
	parts.push(getZonedParts(at, "Not/AZone"));
	parts.push(getZonedParts(at, "Not/AZone"));
} finally {
	(Intl as { DateTimeFormat: unknown }).DateTimeFormat = Real;
}

check(parts[0]!.hour === 1 && parts[0]!.day === 8, `fixture precondition: 08:30Z is 01:30 MST in Denver on Mar 8 (${JSON.stringify(parts[0])})`);
check(parts[60]!.hour === 3, `the DST jump still lands: an hour later is 03:30 MDT (${JSON.stringify(parts[60])})`);
check(parts[500]!.hour === 8, "a second timezone gets its own formatter");
check(built <= 4, `500 Denver calls, one London and two unknown zones build at most 4 formatters (built ${built})`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

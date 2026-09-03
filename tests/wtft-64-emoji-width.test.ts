#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test wtft-64-emoji-width
 * @description getVisualLength reports RENDERED width, not wcwidth's (#64).
 *
 *   wcwidth treats the "ambiguous"-width emoji — ☀️ (U+2600) and ⚡ (U+26A1),
 *   the block U+2600–U+27BF — as 1 column, but every modern terminal renders
 *   them as 2. The SURGE timeline was therefore measured one column short (two
 *   with a ⚡ surge badge), so any width math on the title line was off. The
 *   clock faces 🕐–🕛 and moons 🌑–🌘 are already Wide in wcwidth and must stay 2.
 */

import * as assert from "node:assert";
import { getVisualLength } from "../extensions/lib/wtft-renderer.ts";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";
let passed = 0;
let failed = 0;

function check(label: string, fn: () => void) {
	try {
		fn();
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} catch (err) {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		console.log(`       ${(err as Error).message.split("\n").join("\n       ")}`);
		failed++;
	}
}

console.log("\n=== WTFT #64 EMOJI WIDTH ===");

check("☀️ (U+2600 U+FE0F) is width 2", () => {
	assert.strictEqual(getVisualLength("☀️"), 2);
});

check("⚡ (U+26A1) is width 2", () => {
	assert.strictEqual(getVisualLength("⚡"), 2);
});

check("⚠️ (U+26A0 U+FE0F) is width 2", () => {
	assert.strictEqual(getVisualLength("⚠️"), 2);
});

check("🕛 clock face stays width 2", () => {
	assert.strictEqual(getVisualLength("🕛"), 2);
});

check("🌗 moon stays width 2", () => {
	assert.strictEqual(getVisualLength("🌗"), 2);
});

check("─ box rule stays width 1", () => {
	assert.strictEqual(getVisualLength("─"), 1);
});

check("ASCII stays width 1", () => {
	assert.strictEqual(getVisualLength("a"), 1);
});

check("ANSI escapes are stripped before measuring", () => {
	assert.strictEqual(getVisualLength("\x1b[32m☀️\x1b[0m"), 2);
});

check("a stray control byte is skipped, not summed as -1", () => {
	// \x07 (BEL) is a control byte wcwidth reports as -1. The old whole-line
	// wcwidth returned -1 for the entire string; the per-codepoint pass must
	// skip it rather than poison the sum.
	assert.strictEqual(getVisualLength("ab\x07cd"), 4);
});

// The load-bearing case: the timeline at noon is 31 columns, not 30.
// 2 (moon) + 12 (dashes) + 2 (☀️) + 2 (🕛) + 11 (dashes) + 2 (moon).
check("full noon timeline measures 31 columns", () => {
	assert.strictEqual(getVisualLength("🌗────────────☀️🕛───────────🌗"), 31);
});

check("full timeline with ⚡ surge badge measures the badge at width 2", () => {
	assert.strictEqual(getVisualLength("🌗────────────☀️🕛───────────🌗 ⚡ SURGE 2x"), 31 + 1 + 2 + " SURGE 2x".length);
});

console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

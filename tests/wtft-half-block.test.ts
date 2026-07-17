/**
 * #109 Half-block bar rendering tests.
 *
 * Verifies:
 *  - distributeHalfSlots: proportional distribution at double resolution
 *  - halfSlotCountsToArray: flattens counts into CATEGORY_ORDER array
 *  - renderHalfBlockBar: correct █/▌ glyphs and ANSI color codes
 */
import {
	distributeHalfSlots,
	halfSlotCountsToArray,
	renderHalfBlockBar,
} from "../bin/wtft.mjs";
import * as assert from "node:assert";

// Helper: construct a costs record that satisfies the function signature.
// distributeHalfSlots accepts Record<Category, number> — for testing we
// pass a plain object with string keys.
function costs(o: Record<string, number>) { return o as Record<string, number>; }

// --- distributeHalfSlots ---

{
	// Even split at low resolution: 2 categories, barWidth=3 → 6 half-slots
	const result = distributeHalfSlots(costs({ code: 5, plan: 5 }), 3);
	assert.strictEqual(result["code"], 3, "equal split: code gets 3 half-slots");
	assert.strictEqual(result["plan"], 3, "equal split: plan gets 3 half-slots");
}

{
	// Uneven split: barWidth=5 → 10 half-slots, 70/30 split → 7/3
	const result = distributeHalfSlots(costs({ code: 70, plan: 30 }), 5);
	assert.strictEqual(result["code"], 7, "70%: code gets 7 of 10 half-slots");
	assert.strictEqual(result["plan"], 3, "30%: plan gets 3 of 10 half-slots");
}

{
	// Zero cost → all zero
	const result = distributeHalfSlots(costs({ code: 0, plan: 0 }), 10);
	assert.strictEqual(result["code"], 0);
	assert.strictEqual(result["plan"], 0);
}

{
	// Zero barWidth → all zero
	const result = distributeHalfSlots(costs({ code: 100 }), 0);
	assert.strictEqual(result["code"], 0);
}

console.log("✅ distributeHalfSlots");

// --- halfSlotCountsToArray ---

{
	// Converts counts to ordered array
	const counts = { plan: 2, code: 3 } as Record<Category, number>;
	const arr = halfSlotCountsToArray(counts);
	assert.strictEqual(arr.length, 5);
	assert.strictEqual(arr[0], "plan");
	assert.strictEqual(arr[1], "plan");
	assert.strictEqual(arr[2], "code");
	assert.strictEqual(arr[3], "code");
	assert.strictEqual(arr[4], "code");
}

{
	// Respects CATEGORY_ORDER, not insertion order
	// overhead comes before plan in CATEGORY_ORDER
	const counts = { code: 1, overhead: 2 } as Record<Category, number>;
	const arr = halfSlotCountsToArray(counts);
	assert.strictEqual(arr[0], "overhead");
	assert.strictEqual(arr[1], "overhead");
	assert.strictEqual(arr[2], "code");
}

{
	// Category with 0 count is omitted
	const counts = { plan: 0, code: 2 } as Record<Category, number>;
	const arr = halfSlotCountsToArray(counts);
	assert.strictEqual(arr.length, 2);
	assert.strictEqual(arr[0], "code");
}

console.log("✅ halfSlotCountsToArray");

// --- renderHalfBlockBar ---

// Styles with known fg values for assertions
const styles = { plan: { fg: 75 }, code: { fg: 179 }, tests: { fg: 149 } } as Record<string, { fg: number }>;

{
	// Same category pair → █ (full block)
	const bar = renderHalfBlockBar(["plan", "plan"], styles);
	// Should contain exactly one █ glyph
	assert.ok(bar.includes("█"), "same pair: contains █");
	assert.ok(!bar.includes("▌"), "same pair: no ▌");
	// ANSI escape with correct fg color
	assert.ok(bar.includes("\x1b[38;5;75m█\x1b[0m"), "same pair: fg=75 (plan)");
}

{
	// Different categories → ▌ with FG + BG
	const bar = renderHalfBlockBar(["plan", "code"], styles);
	assert.ok(bar.includes("▌"), "different pair: contains ▌");
	assert.ok(!bar.includes("█"), "different pair: no █");
	// FG=plan(75), BG=code(179)
	assert.ok(
		bar.includes("\x1b[38;5;75;48;5;179m▌\x1b[0m"),
		"different pair: FG=75(plan), BG=179(code)"
	);
}

{
	// Multiple cells: 4 half-slots → 2 cells
	const bar = renderHalfBlockBar(["code", "code", "plan", "tests"], styles);
	// Cell 0: code+code → █(179)
	// Cell 1: plan+tests → ▌(75/149)
	assert.ok(bar.includes("\x1b[38;5;179m█\x1b[0m"), "cell 0: code full block");
	assert.ok(
		bar.includes("\x1b[38;5;75;48;5;149m▌\x1b[0m"),
		"cell 1: plan FG, tests BG"
	);
}

{
	// Odd number of half-slots: last slot alone → █
	const bar = renderHalfBlockBar(["code"], styles);
	assert.ok(bar.includes("\x1b[38;5;179m█\x1b[0m"), "odd slot: rendered as full block");
}

console.log("✅ renderHalfBlockBar");

console.log("\n🎉 All half-block tests passed!");

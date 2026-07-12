/**
 * Tests for #90 — Compaction entry tracking in wtft-parser.
 *
 * Validates that parseSessionFile detects CompactionEntry entries
 * and stamps compactionTokensBefore onto the next assistant interaction.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { parseSessionFile } from "../bin/wtft.mjs";

// --- Helpers ---

function writeTempSession(entries: any[]): string {
	const tmp = path.join(os.tmpdir(), `wtft-compaction-test-${Date.now()}.jsonl`);
	const lines = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
	fs.writeFileSync(tmp, lines);
	return tmp;
}

// --- Tests ---

describe("parseSessionFile — compaction tracking", () => {
	it("stamps compactionTokensBefore on next assistant interaction", () => {
		const session = writeTempSession([
			{ type: "compaction", id: "cmp001", parentId: "msg002", timestamp: "2026-01-01T00:00:00Z", summary: "...", firstKeptEntryId: "msg003", tokensBefore: 50000 },
			{ type: "message", id: "msg003", parentId: "cmp001", timestamp: "2026-01-01T00:01:00Z", message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "Continuing work..." }], usage: { input_tokens: 1000, output_tokens: 200, cost: { total: 0.005 } } } },
		]);
		const interactions = parseSessionFile(session);
		try { fs.unlinkSync(session); } catch {}

		assert.strictEqual(interactions.length, 1, "should produce 1 assistant interaction");
		assert.strictEqual(interactions[0].compactionTokensBefore, 50000, "should stamp 50K compaction tokens");
		assert.strictEqual(interactions[0].model, "claude-sonnet-5");
	});

	it("does NOT stamp compaction on non-assistant entries", () => {
		const session = writeTempSession([
			{ type: "compaction", id: "cmp001", parentId: "msg002", timestamp: "2026-01-01T00:00:00Z", summary: "...", firstKeptEntryId: "msg003", tokensBefore: 30000 },
			{ type: "message", id: "msg003", parentId: "cmp001", timestamp: "2026-01-01T00:01:00Z", message: { role: "user", content: "Continue" } },
		]);
		const interactions = parseSessionFile(session);
		try { fs.unlinkSync(session); } catch {}

		// User messages are not parsed to interactions
		assert.strictEqual(interactions.length, 0, "user messages produce no interactions");
	});

	it("only stamps the NEXT interaction (single-consumption)", () => {
		const session = writeTempSession([
			{ type: "compaction", id: "cmp001", parentId: "msg002", timestamp: "2026-01-01T00:00:00Z", summary: "...", firstKeptEntryId: "msg003", tokensBefore: 10000 },
			{ type: "message", id: "msg003", parentId: "cmp001", timestamp: "2026-01-01T00:01:00Z", message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "First after compaction" }], usage: { input_tokens: 100, output_tokens: 50, cost: { total: 0.001 } } } },
			{ type: "message", id: "msg004", parentId: "msg003", timestamp: "2026-01-01T00:02:00Z", message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "Second after compaction" }], usage: { input_tokens: 100, output_tokens: 50, cost: { total: 0.001 } } } },
		]);
		const interactions = parseSessionFile(session);
		try { fs.unlinkSync(session); } catch {}

		assert.strictEqual(interactions.length, 2);
		assert.strictEqual(interactions[0].compactionTokensBefore, 10000, "first interaction gets compaction stamp");
		assert.strictEqual(interactions[1].compactionTokensBefore, undefined, "second interaction does NOT get the stamp");
	});

	it("handles multiple compactions in sequence", () => {
		const session = writeTempSession([
			{ type: "compaction", id: "cmp001", parentId: "msg002", timestamp: "2026-01-01T00:00:00Z", summary: "...", firstKeptEntryId: "msg003", tokensBefore: 10000 },
			{ type: "compaction", id: "cmp002", parentId: "msg003", timestamp: "2026-01-01T00:01:00Z", summary: "...", firstKeptEntryId: "msg004", tokensBefore: 20000 },
			{ type: "message", id: "msg005", parentId: "cmp002", timestamp: "2026-01-01T00:02:00Z", message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "After two compactions" }], usage: { input_tokens: 100, output_tokens: 50, cost: { total: 0.001 } } } },
		]);
		const interactions = parseSessionFile(session);
		try { fs.unlinkSync(session); } catch {}

		assert.strictEqual(interactions.length, 1);
		// Last compaction wins (stamps most recent)
		assert.strictEqual(interactions[0].compactionTokensBefore, 20000, "last compaction value wins");
	});

	it("handles session without compaction entries (backward compat)", () => {
		const session = writeTempSession([
			{ type: "message", id: "msg001", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", model: "claude-haiku", content: [{ type: "text", text: "Hello" }], usage: { input_tokens: 50, output_tokens: 10, cost: { total: 0.001 } } } },
		]);
		const interactions = parseSessionFile(session);
		try { fs.unlinkSync(session); } catch {}

		assert.strictEqual(interactions.length, 1);
		assert.strictEqual(interactions[0].compactionTokensBefore, undefined);
	});

	it("handles compaction entry with missing tokensBefore", () => {
		const session = writeTempSession([
			{ type: "compaction", id: "cmp001", parentId: "msg002", timestamp: "2026-01-01T00:00:00Z", summary: "...", firstKeptEntryId: "msg003" },
			{ type: "message", id: "msg003", parentId: "cmp001", timestamp: "2026-01-01T00:01:00Z", message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "After compaction" }], usage: { input_tokens: 100, output_tokens: 50, cost: { total: 0.001 } } } },
		]);
		const interactions = parseSessionFile(session);
		try { fs.unlinkSync(session); } catch {}

		assert.strictEqual(interactions.length, 1);
		assert.strictEqual(interactions[0].compactionTokensBefore, undefined, "missing tokensBefore → undefined");
	});
});

console.log("✅ All compaction tracking tests passed.");

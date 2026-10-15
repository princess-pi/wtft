/**
 * The floor marker: docs/spec-515-floor-marker.md § 4.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";

import { createUncountedLatch, type UncountedLatchIo } from "../extensions/lib/uncounted-latch.ts";

const turn = (id: string) => JSON.stringify({
	type: "assistant",
	timestamp: "2026-10-14T12:00:00.000Z",
	message: { id, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 1 } },
}) + "\n";
const compaction = JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "2026-10-14T12:01:00.000Z" }) + "\n";
const recap = JSON.stringify({ type: "system", subtype: "away_summary", timestamp: "2026-10-14T12:02:00.000Z" }) + "\n";

class FakeIo implements UncountedLatchIo {
	files = new Map<string, string>();
	bytesRead = 0;
	size(p: string): number | null {
		const c = this.files.get(p);
		return c === undefined ? null : Buffer.byteLength(c);
	}
	readFrom(p: string, offset: number): string | null {
		const c = this.files.get(p);
		if (c === undefined) return null;
		const out = Buffer.from(c).subarray(offset).toString("utf8");
		this.bytesRead += Buffer.byteLength(out);
		return out;
	}
}

describe("createUncountedLatch", () => {
	it("sees a compaction and does not see plain turns", () => {
		const io = new FakeIo();
		io.files.set("/s/a.jsonl", turn("m1") + compaction);
		io.files.set("/s/b.jsonl", turn("m2"));
		assert.strictEqual(createUncountedLatch(io).seen(["/s/b.jsonl"]), false);
		assert.strictEqual(createUncountedLatch(io).seen(["/s/b.jsonl", "/s/a.jsonl"]), true);
	});

	it("reads only appended bytes and sees a recap added later", () => {
		const io = new FakeIo();
		io.files.set("/s/a.jsonl", turn("m1"));
		const latch = createUncountedLatch(io);
		assert.strictEqual(latch.seen(["/s/a.jsonl"]), false);
		const before = io.bytesRead;
		io.files.set("/s/a.jsonl", turn("m1") + recap);
		assert.strictEqual(latch.seen(["/s/a.jsonl"]), true);
		assert.strictEqual(io.bytesRead - before, Buffer.byteLength(recap));
	});

	it("finishes a line split across two reads", () => {
		const io = new FakeIo();
		const half = Math.floor(compaction.length / 2);
		io.files.set("/s/a.jsonl", turn("m1") + compaction.slice(0, half));
		const latch = createUncountedLatch(io);
		assert.strictEqual(latch.seen(["/s/a.jsonl"]), false);
		io.files.set("/s/a.jsonl", turn("m1") + compaction);
		assert.strictEqual(latch.seen(["/s/a.jsonl"]), true);
	});

	it("rereads a file that shrank below its offset", () => {
		const io = new FakeIo();
		io.files.set("/s/a.jsonl", turn("m1") + turn("m2"));
		const latch = createUncountedLatch(io);
		assert.strictEqual(latch.seen(["/s/a.jsonl"]), false);
		io.files.set("/s/a.jsonl", compaction);
		assert.strictEqual(latch.seen(["/s/a.jsonl"]), true);
	});

	it("reads nothing once latched, and treats a missing file as nothing seen", () => {
		const io = new FakeIo();
		io.files.set("/s/a.jsonl", compaction);
		const latch = createUncountedLatch(io);
		assert.strictEqual(latch.seen(["/s/missing.jsonl"]), false);
		assert.strictEqual(latch.seen(["/s/a.jsonl"]), true);
		const before = io.bytesRead;
		io.files.set("/s/a.jsonl", compaction + turn("m3"));
		assert.strictEqual(latch.seen(["/s/a.jsonl"]), true);
		assert.strictEqual(io.bytesRead, before);
	});
});

/**
 * The floor marker: docs/spec-515-floor-marker.md § 4.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";

import { createUncountedLatch, type UncountedLatchIo } from "../extensions/lib/uncounted-latch.ts";
import { chartLines } from "../extensions/lib/chart-call.ts";
import { wtftSession } from "../artifacts/renderer/fake-session.ts";
import { withTerminal } from "../artifacts/renderer/report.ts";

const turn = (id: string) => JSON.stringify({
	type: "assistant",
	timestamp: "2026-10-14T12:00:00.000Z",
	message: { id, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 1 } },
}) + "\n";
const compaction = JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "2026-10-14T12:01:00.000Z" }) + "\n";
const recap = JSON.stringify({ type: "system", subtype: "away_summary", timestamp: "2026-10-14T12:02:00.000Z" }) + "\n";

class FakeIo implements UncountedLatchIo {
	files = new Map<string, string | Buffer>();
	bytesRead = 0;
	size(p: string): number | null {
		const c = this.files.get(p);
		return c === undefined ? null : Buffer.from(c).length;
	}
	readFrom(p: string, offset: number): Buffer | null {
		const c = this.files.get(p);
		if (c === undefined) return null;
		const out = Buffer.from(c).subarray(offset);
		this.bytesRead += out.length;
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

	it("keeps its place when a read ends inside a multi-byte character", () => {
		const io = new FakeIo();
		const wide = JSON.stringify({ type: "system", subtype: "compact_boundary", content: "café ☕ naïve" }) + "\n";
		const cut = Buffer.byteLength(turn("m1")) + Buffer.from(wide).indexOf(Buffer.from("☕")) + 1;
		const whole = Buffer.from(turn("m1") + wide);
		io.files.set("/s/a.jsonl", whole.subarray(0, cut));
		const latch = createUncountedLatch(io);
		assert.strictEqual(latch.seen(["/s/a.jsonl"]), false);
		io.files.set("/s/a.jsonl", whole);
		assert.strictEqual(latch.seen(["/s/a.jsonl"]), true);
	});

	it("sees a Pi compaction entry", () => {
		const io = new FakeIo();
		io.files.set("/s/pi.jsonl", JSON.stringify({ type: "compaction", tokensBefore: 120000 }) + "\n");
		assert.strictEqual(createUncountedLatch(io).seen(["/s/pi.jsonl"]), true);
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

describe("the chart's floor marker", () => {
	const NOW = Date.UTC(2026, 8, 26, 15, 30);
	const draw = (floor?: boolean) => (withTerminal(200, NOW, () => chartLines({
		interactions: wtftSession("claude-sonnet-5-5"),
		unit: "cost",
		asked: { interval: "1h", limit: 6, timezone: "UTC" },
		fallback: { width: 150 },
		floor,
	})) ?? []).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
	const rows = (lines: string[]) => lines.filter((l) => /^\S*\d+:\d\d /.test(l));

	it("puts ≥ before the newest row's total cost and nowhere else", () => {
		const lines = rows(draw(true));
		assert.ok(lines.length >= 2, "the fixture draws at least two rows");
		assert.match(lines[0], /≥\$\d/);
		for (const l of lines.slice(1)) assert.doesNotMatch(l, /≥/);
	});

	it("draws no ≥ without the flag", () => {
		assert.ok(draw().every((l) => !l.includes("≥")));
	});
});

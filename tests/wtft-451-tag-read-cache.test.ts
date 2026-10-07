/**
 * The tag read cache: docs/spec-451-tag-read-cache.md § 5.
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { createTagReadCache, type TagFileStat, type TagReadIo } from "../extensions/lib/tag-read-cache.ts";
import { readClassifiedTagFile } from "../extensions/lib/wtft-daemon-lib.ts";

function turnLine(id: string, inTokens: number): string {
	return JSON.stringify({ t: 1_800_000_000_000, c: 0.01, id, m: "claude-sonnet-4-6", in: inTokens, cr: 0 }) + "\n";
}

class FakeIo implements TagReadIo {
	files = new Map<string, { stat: TagFileStat; content: string }>();
	reads = 0;
	put(p: string, ino: number, content: string): void {
		this.files.set(p, { stat: { ino, size: Buffer.byteLength(content) }, content });
	}
	stat(p: string): TagFileStat | null {
		return this.files.get(p)?.stat ?? null;
	}
	read(p: string): { stat: TagFileStat; content: string } | null {
		this.reads++;
		return this.files.get(p) ?? null;
	}
}

const ids = (cache: ReturnType<typeof createTagReadCache>, p: string) => cache.interactions(p).map(i => i.messageId);

describe("createTagReadCache", () => {
	it("reads an unchanged tag file once across calls", () => {
		const io = new FakeIo();
		io.put("/t/a", 7, turnLine("m1", 100));
		const cache = createTagReadCache(io);
		assert.deepStrictEqual(ids(cache, "/t/a"), ["m1"]);
		assert.deepStrictEqual(ids(cache, "/t/a"), ["m1"]);
		assert.strictEqual(io.reads, 1);
	});

	it("reads again after the size or the inode changed", () => {
		const io = new FakeIo();
		io.put("/t/a", 7, turnLine("m1", 100));
		const cache = createTagReadCache(io);
		cache.interactions("/t/a");
		io.put("/t/a", 7, turnLine("m1", 100) + turnLine("m2", 200));
		assert.deepStrictEqual(ids(cache, "/t/a"), ["m1", "m2"]);
		io.put("/t/a", 8, turnLine("m3", 100) + turnLine("m4", 200));
		assert.deepStrictEqual(ids(cache, "/t/a"), ["m3", "m4"]);
		assert.strictEqual(io.reads, 3);
	});

	it("returns nothing for a tag file it cannot stat, and keeps no entry for it", () => {
		const io = new FakeIo();
		io.put("/t/a", 7, turnLine("m1", 100));
		const cache = createTagReadCache(io);
		cache.interactions("/t/a");
		io.files.delete("/t/a");
		assert.deepStrictEqual(ids(cache, "/t/a"), []);
		io.put("/t/a", 7, turnLine("m9", 100));
		assert.deepStrictEqual(ids(cache, "/t/a"), ["m9"]);
	});

	it("returns nothing when the read fails after a good stat", () => {
		const io = new FakeIo();
		io.put("/t/a", 7, turnLine("m1", 100));
		io.read = () => null;
		assert.deepStrictEqual(ids(createTagReadCache(io), "/t/a"), []);
	});

	it("retain drops every other tag file", () => {
		const io = new FakeIo();
		io.put("/t/a", 7, turnLine("m1", 100));
		io.put("/t/b", 8, turnLine("m2", 100));
		const cache = createTagReadCache(io);
		cache.interactions("/t/a");
		cache.interactions("/t/b");
		cache.retain(["/t/b"]);
		cache.interactions("/t/a");
		cache.interactions("/t/b");
		assert.strictEqual(io.reads, 3);
	});
});

describe("createTagReadCache on real files", () => {
	it("matches a fresh full read after an in-place heartbeat and after an appended turn", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-451-"));
		try {
			const tag = path.join(tmp, "s.jsonl.wtft-tag.v9.9.9.jsonl");
			const hb = (last: number) => JSON.stringify({ _hb: { first: 1_800_000_000_000, last } }) + "\n";
			fs.writeFileSync(tag, turnLine("m1", 100) + hb(1_800_000_000_001));
			const cache = createTagReadCache();
			assert.deepStrictEqual(cache.interactions(tag), readClassifiedTagFile(tag));

			const hbStart = fs.statSync(tag).size - Buffer.byteLength(hb(1_800_000_000_001));
			const fd = fs.openSync(tag, "r+");
			fs.writeSync(fd, hb(1_800_000_000_999), hbStart);
			fs.closeSync(fd);
			assert.deepStrictEqual(cache.interactions(tag), readClassifiedTagFile(tag));

			fs.appendFileSync(tag, turnLine("m2", 200));
			const fresh = readClassifiedTagFile(tag);
			assert.deepStrictEqual(fresh.map(i => i.messageId), ["m1", "m2"]);
			assert.deepStrictEqual(cache.interactions(tag), fresh);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

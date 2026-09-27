/**
 * The living manuals are docs/wtft.html and docs/token-budget.html.
 * The old EXT_ page names are gone from the tree.
 */

import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const banned = ["EXT_" + "WTFT", "EXT_" + "TOKEN_BUDGET"];

describe("#329 spec pages drop the extension prefix", () => {
	it("the two manuals live under their new names", () => {
		assert.equal(fs.existsSync(path.join(root, "docs/wtft.html")), true);
		assert.equal(fs.existsSync(path.join(root, "docs/token-budget.html")), true);
	});

	it("no tracked path or file still names the old pages", () => {
		const files = execFileSync("git", ["ls-files", "-z"], { cwd: root })
			.toString()
			.split("\0")
			.filter(Boolean);
		const hits: string[] = [];
		for (const file of files) {
			if (banned.some((needle) => file.includes(needle))) hits.push(file);
			const abs = path.join(root, file);
			let data: Buffer;
			try {
				if (!fs.statSync(abs).isFile()) continue;
				data = fs.readFileSync(abs);
			} catch {
				continue;
			}
			for (const needle of banned) {
				if (data.includes(Buffer.from(needle))) hits.push(`${file} contains ${needle}`);
			}
		}
		assert.deepEqual(hits, []);
	});
});

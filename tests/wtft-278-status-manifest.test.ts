/**
 * #278: docs/EXT_WTFT.html's daemon status list renders from
 * docs/manifests/wtft-status.json, and that manifest is pinned to
 * renderDaemonStatus, so the page cannot describe a status the code never shows.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { DAEMON_REASON_TEXT, type DaemonStatus } from "../extensions/lib/daemon-health.ts";
import { renderDaemonStatus } from "../extensions/lib/wtft-daemon-lib.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const MANIFEST_PATH = path.join(REPO, "docs", "manifests", "wtft-status.json");
const DOC_PATH = path.join(REPO, "docs", "EXT_WTFT.html");
const COLORS: Record<string, string> = { green: "32", yellow: "33", red: "31", grey: "90" };

interface StatusEntry {
	text: string;
	color: string;
	reason?: string;
	example: DaemonStatus | null;
	meaning: string;
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as { schema: string; statuses: StatusEntry[] };

describe("#278 the status manifest matches renderDaemonStatus", () => {
	it("declares its schema", () => {
		assert.strictEqual(manifest.schema, "wtft/status-manifest@1");
	});

	for (const s of manifest.statuses) {
		it(`"${s.text}" is what the code renders, in ${s.color}`, () => {
			assert.ok(COLORS[s.color], `unknown color ${s.color}`);
			assert.ok(s.meaning.length > 0, "meaning is empty");
			const rendered = s.example
				? renderDaemonStatus(s.example)
				: fs.readFileSync(path.join(REPO, "extensions", "lib", "wtft-daemon-lib.ts"), "utf8").includes(`\\x1b[${COLORS[s.color]}m●\\x1b[0m ${s.text}"`)
					? `  \x1b[${COLORS[s.color]}m●\x1b[0m ${s.text}`
					: "(not in wtft-daemon-lib.ts)";
			assert.strictEqual(rendered, `  \x1b[${COLORS[s.color]}m●\x1b[0m ${s.text}`);
			if (s.reason) assert.strictEqual(s.example?.reason, s.reason, "reason and example disagree");
		});
	}

	it("every health reason has an entry", () => {
		const listed = new Set(manifest.statuses.map(s => s.reason).filter(Boolean));
		const missing = Object.keys(DAEMON_REASON_TEXT).filter(r => !listed.has(r));
		assert.deepStrictEqual(missing, []);
	});
});

describe("#278 EXT_WTFT.html renders from manifests, not by hand", () => {
	const doc = fs.readFileSync(DOC_PATH, "utf8");

	it("fetches the status manifest into the status list", () => {
		assert.ok(doc.includes("fetch('manifests/wtft-status.json')"));
		assert.match(doc, /<ul id="wtft-status-reference">\s*<li><em[^>]*>Loading/);
	});

	it("renders the exit codes from wtft-cmd.json", () => {
		assert.match(doc, /<ul id="wtft-exit-codes">\s*<li><em[^>]*>Loading/);
		assert.ok(doc.includes("renderExitCodes(data)"));
	});

	it("hand-writes no status text the manifest owns", () => {
		for (const s of manifest.statuses) {
			assert.ok(!doc.includes(`● ${s.text}</span>`), `EXT_WTFT.html still hand-lists "${s.text}"`);
		}
	});
});

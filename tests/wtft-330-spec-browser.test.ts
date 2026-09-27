/**
 * The chart spec and its picker are pages in the artifact browser.
 * The spec embeds the picker that sits beside it.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const artifacts = path.resolve(import.meta.dirname, "../artifacts");

describe("#330 the chart spec is a browser page", () => {
	it("lists the spec and the picker, and both files exist", () => {
		const index = JSON.parse(fs.readFileSync(path.join(artifacts, "docs.json"), "utf8"));
		const paths = (index.docs as Array<{ path: string }>).map((doc) => doc.path);
		assert.ok(paths.includes("chart-spec/spec.mdx"));
		assert.ok(paths.includes("chart-spec/picker.html"));
		assert.equal(fs.existsSync(path.join(artifacts, "chart-spec/spec.mdx")), true);
		assert.equal(fs.existsSync(path.join(artifacts, "chart-spec/picker.html")), true);
	});

	it("embeds the picker from the same directory", () => {
		const spec = fs.readFileSync(path.join(artifacts, "chart-spec/spec.mdx"), "utf8");
		assert.match(spec, /src="picker\.html"/);
		assert.match(spec, /\]\(picker\.html\)/);
	});

	it("renders an mdx file as markdown with its html left intact", () => {
		const js = fs.readFileSync(path.join(artifacts, "assets/browser.js"), "utf8");
		assert.match(js, /html:\s*true/);
		assert.match(js, /splitFrontmatter/);
		assert.match(js, /\.mdx/);
		assert.match(js, /id="toc"|getElementById\("toc"\)/);
	});
});

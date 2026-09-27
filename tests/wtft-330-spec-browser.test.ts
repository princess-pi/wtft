/**
 * The chart spec and its picker are pages in the artifact browser.
 * The spec embeds the picker that sits beside it.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { headingDomId, pageTitle, parseRoute, resolveRelative, rewriteHref, splitFrontmatter } from "../artifacts/assets/route.mjs";

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
		assert.equal(resolveRelative("chart-spec/spec.mdx", "picker.html"), "chart-spec/picker.html");
		assert.equal(
			resolveRelative("chart-spec/spec.mdx", "picker.html?preset=cost#tokens"),
			"chart-spec/picker.html?preset=cost#tokens",
		);
	});

	it("points a plain file at the document directory", () => {
		const href = rewriteHref("chart-spec/spec.mdx", "data.csv", new Set());
		assert.equal(href, "chart-spec/data.csv");
		const heading = rewriteHref("chart-spec/spec.mdx", "#sample", new Set());
		assert.equal(heading, "#chart-spec/spec.mdx#doc-sample");
		assert.equal(headingDomId("***", 1), "doc-section");
	});

	it("keeps a heading on the document route", () => {
		const route = parseRoute("#chart-spec/spec.mdx#sample");
		assert.equal(route.path, "chart-spec/spec.mdx");
		assert.equal(route.frag, "sample");
		const encoded = parseRoute("#chart-spec/other.mdx%23part");
		assert.equal(encoded.path, "chart-spec/other.mdx");
		assert.equal(encoded.frag, "part");
	});

	it("drops a frontmatter fence that is the last line", () => {
		const split = splitFrontmatter("---\ntitle: Chart\n---");
		assert.equal(split.meta.title, "Chart");
		assert.equal(split.body, "");
		const rule = splitFrontmatter("---\ntitle: Chart\n----\n\n# Hi\n");
		assert.equal(rule.meta.title, undefined);
		assert.match(rule.body, /# Hi/);
		const opener = splitFrontmatter("-----\n\n# Hi\n");
		assert.equal(opener.meta.title, undefined);
		assert.match(opener.body, /# Hi/);
		assert.equal(pageTitle({ title: "Chart" }, "Artifacts"), "Chart");
	});
});

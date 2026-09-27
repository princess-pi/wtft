/**
 * The chart spec and its picker are pages in the artifact browser.
 * The spec embeds the picker that sits beside it.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { headingDomId, headingFrag, pageTitle, parseRoute, resolveRelative, rewriteHref, splitFrontmatter } from "../artifacts/assets/route.mjs";

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
		const href = rewriteHref("chart-spec/spec.mdx", "data.csv#x", new Set());
		assert.equal(href, "chart-spec/data.csv#x");
		const heading = rewriteHref("chart-spec/spec.mdx", "#sample", new Set());
		assert.equal(heading, "#chart-spec/spec.mdx#doc-sample");
		assert.equal(headingDomId("***", 1), "doc-section");
		assert.equal(headingFrag("sample"), "doc-sample");
		assert.equal(headingFrag("My%20Heading"), "doc-my-heading");
		assert.equal(
			rewriteHref("chart-spec/spec.mdx", "#My%20Heading", new Set()),
			"#chart-spec/spec.mdx#doc-my-heading",
		);
		assert.equal(rewriteHref("chart-spec/spec.mdx", "/foo.html", new Set()), "/foo.html");
		assert.equal(rewriteHref("chart-spec/spec.mdx", "other.mdx?v=1", new Set()), "#chart-spec/other.mdx?v=1");
		const html = new Set(["chart-spec/picker.html"]);
		const known = new Set(["chart-spec/picker.html"]);
		assert.equal(
			rewriteHref("chart-spec/spec.mdx", "picker.html?preset=cost#tokens", known, html),
			"#chart-spec/picker.html?preset=cost#tokens",
		);
		const route = parseRoute("#chart-spec/picker.html?preset=cost#tokens");
		assert.equal(route.path, "chart-spec/picker.html");
		assert.equal(route.search, "?preset=cost");
		assert.equal(route.frag, "tokens");
	});

	it("keeps a heading on the document route", () => {
		const route = parseRoute("#chart-spec/spec.mdx#sample");
		assert.equal(route.path, "chart-spec/spec.mdx");
		assert.equal(route.frag, "sample");
		const encoded = parseRoute("#chart-spec/picker.html?q=a%23b");
		assert.equal(encoded.path, "chart-spec/picker.html");
		assert.equal(encoded.search, "?q=a%23b");
		assert.equal(encoded.frag, "");
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

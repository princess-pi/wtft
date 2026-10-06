import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";

describe("spec browser width", () => {
	it("lets the middle column grow to 1600px", () => {
		const css = fs.readFileSync(new URL("../artifacts/assets/browser.css", import.meta.url), "utf8");
		const rule = css.match(/#content \{[^}]*\}/)?.[0];
		assert.ok(rule, "browser.css has a #content rule");
		assert.match(rule, /max-width: 1600px;/);
	});
});

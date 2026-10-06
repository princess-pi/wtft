import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const artifacts = path.resolve(import.meta.dirname, "../artifacts");
const read = (file: string) => fs.readFileSync(path.join(artifacts, file), "utf8");
const MIN_FONT_PX = 14;

function filesUnder(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		return entry.isDirectory() ? filesUnder(full) : [full];
	});
}

const diagramFiles = () => filesUnder(artifacts).filter((file) => /\/diagrams\/[^/]+\.svg$/.test(file));

describe("diagrams are SVG files shown at their own size", () => {
	it("the parser spec embeds four diagrams, each in a .diagram frame with alt text and the SVG's own size", () => {
		const spec = read("parser/spec.mdx");
		const frames = [...spec.matchAll(/<div class="diagram"><img src="(diagrams\/[a-z-]+\.svg)" alt="[^"]+" width="(\d+)" height="(\d+)"><\/div>/g)];
		assert.equal(frames.length, 4);
		for (const [, src, width, height] of frames) {
			const root = /<svg\b[^>]*>/.exec(read(path.join("parser", src)))?.[0] ?? "";
			assert.match(root, new RegExp(` width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`), src);
		}
	});

	it("every diagram is drawn at its own pixel size, with no text under 14px", () => {
		const files = diagramFiles();
		assert.ok(files.length >= 4, "the fixture has diagrams to check");
		for (const file of files) {
			const svg = fs.readFileSync(file, "utf8");
			const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
			const size = / width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/.exec(root);
			assert.ok(size, `${file} declares width, height and viewBox`);
			assert.deepEqual([size[3], size[4]], [size[1], size[2]], `${file} viewBox matches its pixel size`);
			assert.doesNotMatch(svg, /\b(transform|scale)\b|font:/, `${file} has no transform or font shorthand`);
			const declared = [...svg.matchAll(/font-size\s*[:=]\s*"?([^;"\s}]+)/g)].map((m) => m[1]);
			assert.ok(declared.length > 0, `${file} sets a font size`);
			for (const value of declared) {
				const px = /^(\d+(?:\.\d+)?)(px)?$/.exec(value);
				assert.ok(px && Number(px[1]) >= MIN_FONT_PX, `${file} has font-size ${value}`);
			}
		}
	});

	it("the frame scrolls, and never scales its image down", () => {
		const css = read("assets/browser.css");
		assert.match(css.match(/\.diagram \{[^}]*\}/)?.[0] ?? "", /overflow: auto;/);
		assert.match(css.match(/#content \.diagram img, #content \.diagram svg \{[^}]*\}/)?.[0] ?? "", /max-width: none;/);
	});

	it("the frame pans on drag", () => {
		const browser = read("assets/browser.js");
		assert.match(browser, /querySelectorAll\("\.diagram"\)[\s\S]{0,400}pointerdown[\s\S]{0,600}scrollLeft[\s\S]{0,100}scrollTop/);
	});

	it("no artifact mentions mermaid", () => {
		for (const file of filesUnder(artifacts)) assert.doesNotMatch(fs.readFileSync(file, "utf8"), /mermaid/i, file);
	});
});

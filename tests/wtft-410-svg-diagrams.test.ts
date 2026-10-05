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
	it("the parser spec embeds four diagrams, each in a .diagram frame with alt text, and each file exists", () => {
		const spec = read("parser/spec.mdx");
		const frames = [...spec.matchAll(/<div class="diagram"><img src="(diagrams\/[a-z-]+\.svg)" alt="([^"]+)"[^>]*><\/div>/g)];
		assert.equal(frames.length, 4);
		for (const [, src] of frames) assert.ok(fs.existsSync(path.join(artifacts, "parser", src)), src);
	});

	it("every diagram declares its pixel size and sets no text under 14px", () => {
		const files = diagramFiles();
		assert.ok(files.length >= 4, "the fixture has diagrams to check");
		for (const file of files) {
			const svg = fs.readFileSync(file, "utf8");
			const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
			assert.match(root, /\swidth="\d+"/, file);
			assert.match(root, /\sheight="\d+"/, file);
			const sizes = [...svg.matchAll(/font(?:-size)?[:=]\s*"?(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
			assert.ok(sizes.length > 0, `${file} sets a font size`);
			for (const size of sizes) assert.ok(size >= MIN_FONT_PX, `${file} has ${size}px text`);
		}
	});

	it("the frame scrolls, and never scales its image down", () => {
		const css = read("assets/browser.css");
		assert.match(css.match(/\.diagram \{[^}]*\}/)?.[0] ?? "", /overflow: auto;/);
		assert.match(css.match(/#content \.diagram img \{[^}]*\}/)?.[0] ?? "", /max-width: none;/);
	});

	it("the frame pans on drag", () => {
		const browser = read("assets/browser.js");
		assert.match(browser, /querySelectorAll\("\.diagram"\)[\s\S]{0,400}pointerdown[\s\S]{0,600}scrollLeft[\s\S]{0,100}scrollTop/);
	});

	it("no artifact mentions mermaid", () => {
		for (const file of filesUnder(artifacts)) assert.doesNotMatch(fs.readFileSync(file, "utf8"), /mermaid/i, file);
	});
});

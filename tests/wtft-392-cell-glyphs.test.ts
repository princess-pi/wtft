/**
 * Block and box glyphs are painted as cells. docs/spec-392-cell-glyphs.md.
 */

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import { cellsHtml } from "../artifacts/assets/cell-glyphs.mjs";
import { ansiToHtml } from "../artifacts/renderer/ansi.ts";

const spans = (html: string) => [...html.matchAll(/<span style="([^"]*)">([^<]*)<\/span>/g)].map((m) => ({ style: m[1], text: m[2] }));

describe("cellsHtml", () => {
	it("paints a run of full blocks as one cell span as wide as the run", () => {
		const [cell, ...rest] = spans(cellsHtml("███"));
		assert.equal(rest.length, 0);
		assert.equal(cell.text, "███");
		assert.match(cell.style, /display:inline-block/);
		assert.match(cell.style, /width:3ch/);
		assert.match(cell.style, /height:1lh/);
		assert.match(cell.style, /-webkit-text-fill-color:transparent/);
		assert.match(cell.style, /linear-gradient\(currentColor,currentColor\) left bottom \/ 100% 100% no-repeat/);
	});

	it("paints each lower eighth as its own run, filling that share of the cell from the bottom", () => {
		const cells = spans(cellsHtml("▃▃▇"));
		assert.deepEqual(cells.map((c) => c.text), ["▃▃", "▇"]);
		assert.match(cells[0].style, /width:2ch;.*left bottom \/ 100% 37\.5% no-repeat/);
		assert.match(cells[1].style, /width:1ch;.*left bottom \/ 100% 87\.5% no-repeat/);
	});

	it("gives a line a run and every junction a cell of its own, arms reaching the edges they name", () => {
		const cells = spans(cellsHtml("──┼┼─"));
		assert.deepEqual(cells.map((c) => c.text), ["──", "┼", "┼", "─"]);
		assert.match(cells[0].style, /width:2ch;.*left center \/ 100% max\(1px,\.08em\) no-repeat/);
		for (const arm of ["left center / 50%", "right center / 50%", "center top / max\\(1px,\\.08em\\) 50%", "center bottom / max\\(1px,\\.08em\\) 50%"]) {
			assert.match(cells[1].style, new RegExp(arm.replace("/", "\\/")));
		}
		const corner = spans(cellsHtml("┐"))[0].style;
		assert.match(corner, /left center/);
		assert.match(corner, /center bottom/);
		assert.doesNotMatch(corner, /right center|center top/);
	});

	it("paints exactly the characters the spec lists, and fills each as it says", () => {
		const listed = "─━│┃┌┐└┘├┤┬┴┼╴╵╶╷▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐▔▕▖▗▘▙▚▛▜▝▞▟";
		const painted = [];
		for (let cp = 0x2500; cp <= 0x259f; cp++) {
			const ch = String.fromCodePoint(cp);
			if (cellsHtml(ch) !== ch) painted.push(ch);
		}
		assert.equal(painted.join(""), listed);
		const style = (ch: string) => spans(cellsHtml(ch))[0].style;
		assert.match(style("▉"), /left top \/ 87\.5% 100%/);
		assert.match(style("▏"), /left top \/ 12\.5% 100%/);
		assert.match(style("▐"), /right top \/ 50% 100%/);
		assert.match(style("▀"), /left top \/ 100% 50%/);
		assert.match(style("▖"), /left bottom \/ 50% 50%/);
		assert.equal(style("▟").match(/50% 50%/g)?.length, 3);
		assert.match(style("━"), /left center \/ 100% max\(2px,\.16em\)/);
		assert.match(style("┃"), /center top \/ max\(2px,\.16em\) 50%/);
		assert.equal(spans(cellsHtml("┼┼▉▉")).length, 4);
	});

	it("escapes text and leaves every other character, shades included, as text", () => {
		assert.equal(cellsHtml("<a & b> ░▒▓ 💸 x"), "&lt;a &amp; b&gt; ░▒▓ 💸 x");
		const mixed = cellsHtml("a█<");
		assert.ok(mixed.startsWith("a<span "));
		assert.ok(mixed.endsWith("</span>&lt;"));
	});
});

describe("where cells are painted", () => {
	it("ansiToHtml paints block runs inside the colour span", () => {
		assert.equal(ansiToHtml("\x1b[38;5;196m██\x1b[0m x"), `<span style="color:rgb(255,0,0)">${cellsHtml("██")}</span> x`);
	});

	it("the spec browser paints every code block but mermaid", () => {
		const browser = fs.readFileSync(new URL("../artifacts/assets/browser.js", import.meta.url), "utf8");
		assert.match(browser, /import \{[^}]*\bcellsHtml\b[^}]*\} from "\.\/cell-glyphs\.mjs"/);
		assert.match(browser, /querySelectorAll\("pre code:not\(\.language-mermaid\)"\)[\s\S]{0,200}cellsHtml\(/);
	});

	it("every page that paints cells sets a whole-pixel font size and line height on its pre", () => {
		const read = (file: string) => fs.readFileSync(new URL(`../artifacts/${file}`, import.meta.url), "utf8");
		for (const file of ["chart-spec/picker.html", "chart-lib/fair.html"]) assert.match(read(file), /\bpre \{[^}]*font: \d+px\/\d+px /, file);
		const css = read("assets/browser.css");
		assert.match(css, /#content pre \{[^}]*font: \d+px\/\d+px /);
		assert.match(css, /#content pre code \{ font: inherit; \}/);
	});
});

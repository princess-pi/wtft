/**
 * The parser explainer and its playground are pages in the artifact browser, and the
 * playground runs the production parser. docs/spec-386-chart-artifacts.md § parser.
 */

import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { RENDERER_BUNDLE } from "../build-artifacts.ts";
import { resolveRelative } from "../artifacts/assets/route.mjs";
import { classifyInteraction, deduplicateInteractions, parseSessionFile, splitOverheadCost } from "../extensions/lib/wtft-parser.ts";
import { parseJsonlText } from "../artifacts/renderer/parse-text.ts";
import { PARSER_PRESETS, presetText } from "../artifacts/renderer/parser-presets.ts";

const artifacts = path.resolve(import.meta.dirname, "../artifacts");
const read = (file: string) => fs.readFileSync(path.join(artifacts, file), "utf8");

describe("the parser pages are browser pages", () => {
	it("lists the explainer and the playground, and both files exist", () => {
		const index = JSON.parse(read("docs.json"));
		const docs = index.docs as Array<{ path: string; group?: string; kind?: string }>;
		const spec = docs.find((doc) => doc.path === "parser/spec.mdx");
		const playground = docs.find((doc) => doc.path === "parser/playground.html");
		assert.equal(spec?.group, "Parser");
		assert.equal(playground?.group, "Parser");
		assert.equal(playground?.kind, "html");
		assert.equal(fs.existsSync(path.join(artifacts, "parser/spec.mdx")), true);
		assert.equal(fs.existsSync(path.join(artifacts, "parser/playground.html")), true);
	});

	it("embeds the playground from the same directory", () => {
		const spec = read("parser/spec.mdx");
		assert.match(spec, /<iframe src="playground\.html"/);
		assert.match(spec, /\[Open the playground on its own\]\(playground\.html\)/);
		assert.equal(resolveRelative("parser/spec.mdx", "playground.html"), "parser/playground.html");
	});

	it("imports from the bundle only names the bundle exports", async () => {
		const page = read("parser/playground.html");
		const imports = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/renderer\/wtft-chart\.mjs"/.exec(page);
		assert.ok(imports, "the playground imports the bundle");
		const names = imports[1].split(",").map((name) => name.trim()).filter(Boolean);
		const bundle = await import(pathToFileURL(RENDERER_BUNDLE).href);
		for (const name of names) assert.ok(name in bundle, `the bundle exports ${name}`);
		for (const name of ["parseJsonlText", "extractRealCommands", "CATEGORY_STYLE"]) assert.ok(names.includes(name), `the playground uses ${name}`);
	});
});

describe("the bundle exports the parser's per-line half", () => {
	const EXPORTS = [
		"parseEntryToInteraction", "newParseStreamState", "applyControlEntry", "readControlEntry", "classifyInteraction",
		"deduplicateInteractions", "splitOverheadCost", "normalizeCommand", "commandSpawnsAgent", "isInterruptMarker",
		"extractRealCommands", "splitCommandWords", "parseJsonlText", "PARSER_PRESETS", "presetText",
	];

	it("exports each function", async () => {
		const bundle = await import(pathToFileURL(RENDERER_BUNDLE).href);
		for (const name of EXPORTS) assert.ok(name in bundle, `the bundle exports ${name}`);
	});

	it("parses every preset in a page with no process, as the source does, and leaves no process behind", () => {
		const script = `
			const bundle = await import(${JSON.stringify(pathToFileURL(RENDERER_BUNDLE).href)});
			delete globalThis.process;
			const out = {};
			for (const [id, preset] of Object.entries(bundle.PARSER_PRESETS)) {
				out[id] = bundle.parseJsonlText(bundle.presetText(preset)).turns.map((t) => [t.category, t.decidedBy, t.interaction.cost, t.overhead]);
			}
			console.log(JSON.stringify({ out, left: "process" in globalThis }));
		`;
		const result = JSON.parse(execFileSync("node", ["--input-type=module", "-e", script], { encoding: "utf8", env: process.env }));
		assert.equal(result.left, false);
		for (const [id, preset] of Object.entries(PARSER_PRESETS)) {
			const source = parseJsonlText(presetText(preset)).turns.map((t) => [t.category, t.decidedBy, t.interaction.cost, t.overhead]);
			assert.deepEqual(result.out[id], JSON.parse(JSON.stringify(source)), id);
		}
	});
});

describe("parseJsonlText reads text as parseSessionFile reads a file", () => {
	it("gives each preset the categories it names", () => {
		for (const [id, preset] of Object.entries(PARSER_PRESETS)) {
			assert.deepEqual(parseJsonlText(presetText(preset)).turns.map((t) => t.category), preset.expect, id);
		}
	});

	it("matches parseSessionFile, the dedupe, the classifier and the split on every preset", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-parser-artifact-"));
		const realProjects = process.env.WTFT_CLAUDE_PROJECTS_DIR;
		// The spawn preset's fold looks in the projects root; an empty one finds no child.
		process.env.WTFT_CLAUDE_PROJECTS_DIR = path.join(dir, "projects");
		try {
			for (const [id, preset] of Object.entries(PARSER_PRESETS)) {
				const file = path.join(dir, `${id}.jsonl`);
				fs.writeFileSync(file, presetText(preset));
				const fromFile = deduplicateInteractions(parseSessionFile(file));
				const fromText = parseJsonlText(presetText(preset));
				assert.deepEqual(fromText.turns.map((t) => t.interaction), fromFile, id);
				let prev = 0;
				fromFile.forEach((interaction, at) => {
					const turn = fromText.turns[at]!;
					assert.equal(turn.category, classifyInteraction(interaction), id);
					assert.deepEqual(turn.overhead, splitOverheadCost(interaction, prev), id);
					if (!interaction.isSidechain) prev = interaction.inputTokens + interaction.cacheReadTokens + interaction.cacheWriteTokens;
				});
			}
		} finally {
			if (realProjects === undefined) delete process.env.WTFT_CLAUDE_PROJECTS_DIR;
			else process.env.WTFT_CLAUDE_PROJECTS_DIR = realProjects;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("notes what it did with each line", () => {
		const text = ["", "not json{", JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }), presetText(PARSER_PRESETS.interrupt!)].join("\n");
		const kinds = parseJsonlText(text).notes.map((note) => note.kind);
		assert.deepEqual(kinds, ["blank", "bad-json", "ignored", "turn", "control", "partial"]);
		const parsed = parseJsonlText(text);
		assert.equal(parsed.notes[4]!.control, "interrupt");
		assert.equal(parsed.lines, 4);
		assert.equal(parsed.jsonLines, 3);
	});

	it("names the input that decided, and the lines a merged turn came from", () => {
		const decided = (id: string) => parseJsonlText(presetText(PARSER_PRESETS[id]!)).turns.map((t) => t.decidedBy);
		assert.deepEqual(decided("bash-tests"), ["commands"]);
		assert.deepEqual(decided("read-edit-tests"), ["files"]);
		assert.deepEqual(decided("cache-miss"), ["texts", "texts"]);
		assert.deepEqual(decided("interrupt"), ["interrupted"]);
		assert.deepEqual(parseJsonlText(presetText(PARSER_PRESETS["read-edit-tests"]!)).turns[0]!.lines, [1, 2, 3]);
		const miss = parseJsonlText(presetText(PARSER_PRESETS["cache-miss"]!)).turns[1]!;
		assert.equal(miss.interaction.cacheMiss, true);
		assert.equal(miss.overhead?.kind, "overhead");
		assert.equal(parseJsonlText(presetText(PARSER_PRESETS["pi-compaction"]!)).turns[0]!.overhead?.kind, "compaction");
		assert.equal(parseJsonlText(presetText(PARSER_PRESETS["claude-spawn"]!)).turns[0]!.spawnsAgent, true);
	});
});

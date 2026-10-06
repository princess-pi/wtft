#!/usr/bin/env bun
// build-artifacts.ts — bundles the chart for the browser pages under artifacts/, and draws the --why chart demos

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { whyDemo } from "./artifacts/renderer/why-demos.ts";

const ROOT = import.meta.dir;
export const RENDERER_ENTRY = path.join(ROOT, "artifacts", "renderer", "entry.ts");
export const RENDERER_BUNDLE = path.join(ROOT, "artifacts", "renderer", "wtft-chart.mjs");
export const CMD_MANIFEST = path.join(ROOT, "docs", "manifests", "wtft-cmd.json");
const SOURCES_LINE = /^\/\/ wtft-chart sources: ([0-9a-f]{64})\n/;

// bun's browser target has no `pathToFileURL`, which the harness registry imports and
// the chart never calls.
const URL_SHIM = "export const pathToFileURL = (p) => new URL('file://' + p);\nexport const fileURLToPath = (u) => new URL(u).pathname;\n";

async function build() {
	const result = await Bun.build({
		entrypoints: [RENDERER_ENTRY],
		target: "browser",
		format: "esm",
		minify: true,
		metafile: true,
		plugins: [{
			name: "url-shim",
			setup(build) {
				build.onResolve({ filter: /^node:url$/ }, () => ({ path: "url-shim", namespace: "shim" }));
				build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({ contents: URL_SHIM, loader: "js" }));
			},
		}],
	});
	if (!result.success || !result.metafile) throw new Error(result.logs.map(String).join("\n"));
	const files = Object.keys(result.metafile.inputs)
		.map((input) => path.resolve(input))
		.filter((file) => file.startsWith(ROOT + path.sep) && !file.includes(`${path.sep}node_modules${path.sep}`) && fs.existsSync(file));
	files.push(path.join(ROOT, "build-artifacts.ts"), path.join(ROOT, "package.json"));
	const hash = createHash("sha256");
	for (const file of [...new Set(files)].sort()) hash.update(`${path.relative(ROOT, file)}\0${fs.readFileSync(file, "utf8")}\0`);
	return { sources: hash.digest("hex"), text: await result.outputs[0].text() };
}

/** The sha-256 over every tracked repo file the bundle is built from, this build script and `package.json` included. */
export async function rendererSourcesHash(): Promise<string> {
	return (await build()).sources;
}

/** The sources hash the committed bundle names on its first line, or null when it names none. */
export function committedSourcesHash(): string | null {
	return SOURCES_LINE.exec(fs.readFileSync(RENDERER_BUNDLE, "utf8"))?.[1] ?? null;
}

/** The browser bundle's text, built in memory, its first line naming its sources hash. */
export async function buildRendererBundle(): Promise<string> {
	const { sources, text } = await build();
	return `// wtft-chart sources: ${sources}\n${text}`;
}

/** The command manifest's text with each `why[]` entry marked `"demoFrom": "chart"` given the rows `whyDemo` draws for its first command. */
export function withRenderedDemos(manifestText: string): string {
	const manifest = JSON.parse(manifestText);
	for (const entry of manifest.why ?? []) {
		if (entry.demoFrom !== "chart") continue;
		if (typeof entry.commands?.[0] !== "string") throw new Error(`wtft-cmd.json: a demoFrom chart entry has no command: ${entry.scenario}`);
		entry.demo = whyDemo(entry.commands[0]);
	}
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

if (import.meta.main) {
	const text = await buildRendererBundle();
	fs.mkdirSync(path.dirname(RENDERER_BUNDLE), { recursive: true });
	fs.writeFileSync(RENDERER_BUNDLE, text);
	console.log(`✅ artifacts/renderer/wtft-chart.mjs (${(Buffer.byteLength(text) / 1024).toFixed(0)} KB)`);
	fs.writeFileSync(CMD_MANIFEST, withRenderedDemos(fs.readFileSync(CMD_MANIFEST, "utf8")));
	console.log("✅ docs/manifests/wtft-cmd.json --why chart demos");
}

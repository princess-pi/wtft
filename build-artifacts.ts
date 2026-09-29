#!/usr/bin/env bun
// build-artifacts.ts — bundles the chart for the browser pages under artifacts/

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = import.meta.dir;
export const RENDERER_ENTRY = path.join(ROOT, "artifacts", "renderer", "entry.ts");
export const RENDERER_BUNDLE = path.join(ROOT, "artifacts", "renderer", "wtft-chart.mjs");

// bun's browser target has no `pathToFileURL`, which the harness registry imports and
// the chart never calls.
const URL_SHIM = "export const pathToFileURL = (p) => new URL('file://' + p);\nexport const fileURLToPath = (u) => new URL(u).pathname;\n";

/** The browser bundle's text, built in memory. */
export async function buildRendererBundle(): Promise<string> {
	const result = await Bun.build({
		entrypoints: [RENDERER_ENTRY],
		target: "browser",
		format: "esm",
		minify: true,
		plugins: [{
			name: "url-shim",
			setup(build) {
				build.onResolve({ filter: /^node:url$/ }, () => ({ path: "url-shim", namespace: "shim" }));
				build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({ contents: URL_SHIM, loader: "js" }));
			},
		}],
	});
	if (!result.success) throw new Error(result.logs.map(String).join("\n"));
	return await result.outputs[0].text();
}

if (import.meta.main) {
	const text = await buildRendererBundle();
	fs.mkdirSync(path.dirname(RENDERER_BUNDLE), { recursive: true });
	fs.writeFileSync(RENDERER_BUNDLE, text);
	console.log(`✅ artifacts/renderer/wtft-chart.mjs (${(Buffer.byteLength(text) / 1024).toFixed(0)} KB)`);
}

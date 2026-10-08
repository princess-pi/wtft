#!/usr/bin/env bun
/**
 * `wtft --version` has one source. Spec: docs/spec-12-version-source.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { renderWtftVersion } from "../extensions/lib/wtft-cli-shared.ts";
import { bundleSources, lastBuildMs } from "./lib/last-build";

const REPO = path.resolve(import.meta.dirname, "..");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

console.log("V1 no manifest carries a version");
{
	const dir = path.join(REPO, "docs", "manifests");
	const manifests = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	check(manifests.length > 0, `fixture precondition: manifests found (${manifests.length})`);
	const withVersion = manifests.filter((f) => Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), "version"));
	check(withVersion.length === 0, `no top-level version key (found in: ${withVersion.join(", ") || "none"})`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

console.log("\nV2 the built CLI's --version from another directory");
{
	const newestSourceMs = Math.max(...bundleSources().map((f) => fs.statSync(path.join(REPO, f)).mtimeMs));
	check((lastBuildMs() ?? 0) > newestSourceMs, "fixture precondition: the last build started after every bundle source was saved (else run bun run build)");
	const r = spawnSync("node", [path.join(REPO, "bin", "wtft.mjs"), "--version"], { cwd: os.tmpdir(), encoding: "utf8", timeout: 30_000 });
	const first = (r.stdout ?? "").split("\n")[0];
	check(r.status === 0 && first === `wtft ${pkg.version}`, `first line is "wtft ${pkg.version}" (exit ${r.status}${r.error ? `, ${r.error.message}` : ""}: ${JSON.stringify(first)})`);
}

console.log("\nV3 unbundled source in a directory with another package.json");
{
	const decoy = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-12-decoy-"));
	fs.writeFileSync(path.join(decoy, "package.json"), JSON.stringify({ name: "decoy", version: "9.9.9" }));
	const before = process.cwd();
	let first = "";
	try {
		process.chdir(decoy);
		first = renderWtftVersion({ name: "/wtft" } as never, pathToFileURL(path.join(REPO, "extensions", "wtft.ts")).href, "/wtft").split("\n")[0];
	} finally {
		process.chdir(before);
		fs.rmSync(decoy, { recursive: true, force: true });
	}
	check(first.startsWith(`/wtft ${pkg.version}`) && !first.includes("9.9.9"), `first line names /wtft and package.json's version, not the decoy's (${JSON.stringify(first)})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

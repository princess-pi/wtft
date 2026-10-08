#!/usr/bin/env bun
/**
 * `wtft --version` has one source. Spec: docs/spec-12-version-source.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

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

console.log("\nV2 --version from another directory");
{
	const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
	const r = spawnSync("node", [path.join(REPO, "bin", "wtft.mjs"), "--version"], { cwd: os.tmpdir(), encoding: "utf8", timeout: 30_000 });
	const first = r.stdout.split("\n")[0];
	check(r.status === 0 && first === `wtft ${pkg.version}`, `first line is "wtft ${pkg.version}" (exit ${r.status}: ${JSON.stringify(first)})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

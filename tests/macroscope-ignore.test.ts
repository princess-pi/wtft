#!/usr/bin/env bun
/**
 * .macroscope/ignore.md carries Macroscope's documented default base patterns plus prose patterns.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { isIgnored, parseIgnoreFile } from "./lib/macroscope-ignore.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const IGNORE = path.join(REPO, ".macroscope", "ignore.md");
const PINNED = path.join(import.meta.dirname, "fixtures", "macroscope-default-base-patterns.txt");

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detail = "") {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}${detail ? `\n     ${detail}` : ""}`); }
}

check(fs.existsSync(IGNORE), ".macroscope/ignore.md exists");
const raw = fs.existsSync(IGNORE) ? fs.readFileSync(IGNORE, "utf8") : "";
const patterns = parseIgnoreFile(raw);
const pinnedText = fs.readFileSync(PINNED);
const pinned = parseIgnoreFile(pinnedText.toString("utf8"));

check(pinned.length === 157, "pinned fixture holds all 157 documented default patterns", `${pinned.length} patterns`);
const pinnedHash = createHash("sha256").update(pinnedText).digest("hex");
check(pinnedHash === "8e800113401cdf7dd4c63102103dbb64cf7c7e0d83a0a6df10fe97ad6975173e", "pinned fixture is unchanged from the downloaded documented list", pinnedHash);
const missing = pinned.filter(p => !patterns.includes(p));
check(missing.length === 0, "every pinned default base pattern is present", missing.join(", "));
check(patterns.length <= 1000, "at most 1,000 patterns", String(patterns.length));
check(!raw.split("\n").some(l => l.trim() === "---"), "no front matter (test detection stays on)");
const padded = raw.split("\n").filter(l => l !== l.trim() && l.trim() !== "");
check(padded.length === 0, "no line with surrounding whitespace", padded.join("|"));
const exotic = patterns.filter(p => /[!\[\]{}]/.test(p));
check(exotic.length === 0, "no syntax beyond * ** ?", exotic.join(", "));
const malformed = patterns.filter(p => /^[-*+] |[`"']|^\/|\s#/.test(p));
check(malformed.length === 0, "no bullets, backticks, quotes, leading slash or trailing comments", malformed.join(", "));
check(!patterns.some(p => /(^|\/)(test|tests|__tests__)\b|_test\.|\.test\.|\.spec\./.test(p)), "no test patterns");

const ignored = [
	"docs/x.md", "README.md", "CONTEXT.md", "docs/manifests/wtft-cmd.json", "research/a/b.py",
	"notes.txt", "a/b/c.rst", "x/page.htm", "page.html", "page.mdx", "docs/sub/deep/file.ts",
];
const reviewed = [
	"bin/wtft.ts", "bin/wtft-daemon.ts", "extensions/lib/daemon-health.ts", "extensions/wtft.ts",
	"artifacts/renderer/wtft-chart.ts", "build.ts", ".github/scripts/pricing-bump-check.sh",
	".github/workflows/ci.yml", "tests/x.test.ts", "tests/wtft-daemon.test.sh",
];
for (const p of ignored) check(isIgnored(p, patterns), `ignores ${p}`);
for (const p of reviewed) check(!isIgnored(p, patterns), `reviews ${p}`);

check(isIgnored("a/b/c.min.js", ["**/*.min.js"]), "** spans directories");
check(isIgnored("c.min.js", ["**/*.min.js"]), "**/ matches zero directories");
check(isIgnored("src/a.go", ["src/*"]) && !isIgnored("src/a/b.go", ["src/*"]), "* stays within one segment");
check(isIgnored("file1.go", ["file?.go"]) && !isIgnored("file12.go", ["file?.go"]), "? is one character");
check(isIgnored("a/b/x.pb.go", ["*.pb.go"]), "a pattern with no / matches at any depth");
check(isIgnored("vendor/a/b", ["vendor/**"]) && !isIgnored("x/vendor/a", ["vendor/**"]), "vendor/** is root-anchored");
check(isIgnored("src/a/b/c.go", ["src/**/*.go"]), "src/**/*.go matches at any depth");
check(!isIgnored("a.md", ["# c", "", "x.md"]), "comments and blank lines are not patterns");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

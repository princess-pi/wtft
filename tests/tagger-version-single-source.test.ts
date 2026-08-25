// tests/tagger-version-single-source.test.ts — the tagger version has exactly one
// definition (#499, gate E).
//
// The failure this gates: session-selector.ts carried a hand-mirrored
// `TAGGER_VERSION = "2.3.8"` that fell four bumps behind the daemon's 2.7.1 —
// its Tier-1 tag lookup never hit, and current-version tags rendered with a
// stale-version suffix. A mirrored constant is a comment wearing a type: nothing
// diffs it against the original. Single source, everything imports.

import * as fs from "fs";
import * as path from "path";
import { WTFT_TAGGER_VERSION } from "../extensions/lib/wtft-tagger-version.ts";
import { WTFT_TAGGER_VERSION as FROM_DAEMON_LIB } from "../extensions/lib/wtft-daemon-lib.ts";

let failures = 0;
function check(ok: boolean, label: string, detail?: string) {
	if (ok) console.log(`✅ ${label}`);
	else {
		failures++;
		console.log(`❌ ${label}${detail ? `\n   ${detail}` : ""}`);
	}
}

// 1. The shared module is the source and looks like a version.
check(/^\d+\.\d+\.\d+$/.test(WTFT_TAGGER_VERSION), `wtft-tagger-version.ts exports a semver (${WTFT_TAGGER_VERSION})`);

// 2. daemon-lib re-exports the same value — existing importers stay correct.
check(FROM_DAEMON_LIB === WTFT_TAGGER_VERSION, `wtft-daemon-lib re-exports the same version`);

// 3. No second definition anywhere: across extensions/ and bin/ TS sources, the
//    only assignment of a version literal to a *TAGGER_VERSION name lives in the
//    shared module. This is the gate that would have caught 2.3.8.
const ROOT = path.join(__dirname, "..");
const SOURCE_DIRS = ["extensions", "bin"];
const offenders: string[] = [];
function scan(dir: string) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			scan(p);
			continue;
		}
		if (!entry.name.endsWith(".ts")) continue; // .mjs are generated from these
		const rel = path.relative(ROOT, p);
		if (rel === path.join("extensions", "lib", "wtft-tagger-version.ts")) continue;
		const src = fs.readFileSync(p, "utf8");
		const m = src.match(/TAGGER_VERSION\s*=\s*["'][\d.]+["']/);
		if (m) offenders.push(`${rel}: ${m[0]}`);
	}
}
for (const d of SOURCE_DIRS) scan(path.join(ROOT, d));
check(
	offenders.length === 0,
	`no second tagger-version literal outside wtft-tagger-version.ts`,
	offenders.join("; "),
);

// 4. The selector actually resolves the daemon's version: a tag file written
//    under the daemon's exact current name is picked up and reported as that
//    version (Tier 1 by name, and the display treats it as current).
import { getSessionSummary } from "../extensions/lib/session-selector.ts";
import { trackSandbox } from "./lib/sandbox";
const tmp = trackSandbox(fs.mkdtempSync(path.join(require("os").tmpdir(), "tagger-single-source-")));
try {
	const session = path.join(tmp, "abc.jsonl");
	fs.writeFileSync(session, "{}\n");
	const tagsDir = path.join(tmp, "wtft-tags");
	fs.mkdirSync(tagsDir);
	fs.writeFileSync(
		path.join(tagsDir, `abc.jsonl.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`),
		JSON.stringify({ t: "2026-08-25T00:00:00Z", c: 0.01, cat: "code" }) + "\n",
	);
	const summary = getSessionSummary(session);
	check(
		summary.tagVersion === WTFT_TAGGER_VERSION,
		`getSessionSummary resolves a current-version tag as v${WTFT_TAGGER_VERSION}`,
		`got tagVersion=${String(summary.tagVersion)}`,
	);
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n✅ tagger version single-source: all green" : `\n❌ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

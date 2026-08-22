#!/usr/bin/env bun
/**
 * @package princess-pi-packages
 * @test wtft-179-daemon-health-reason
 * @description #179 — the daemon health reason is a machine code, the status text is
 *   derived from it. Verifies the spec's V1–V4:
 *
 *     V1  no bare reason sentence survives in control flow
 *     V2  a typo'd code comparison FAILS `tsc --noEmit` (negative control)
 *     V3  the #124 startup grace window actually holds — the behaviour test that
 *         did not exist, and whose absence is why #165 could have regressed it
 *     V4  every code renders the same user-facing sentence as before the split
 *
 *   V3 is the load-bearing one. V1/V2 protect the representation; V3 protects the
 *   behaviour, so it survives any future change to how the reason is represented.
 *
 * Runner: self-contained script (repo convention). Run with:
 *   bun run test wtft-179
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	DAEMON_REASON_TEXT,
	daemonReasonText,
	renderDaemonStatus,
	type DaemonHealthReason,
} from "../extensions/lib/wtft-daemon-lib.ts";
import { ensureDaemonRunning, getDaemonStatus } from "../extensions/lib/wtft-cli-shared.ts";
import { trackSandbox } from "./lib/sandbox";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function assert(label: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} else {
		console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n        ${detail}` : ""}`);
		failed++;
	}
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---
// V1 — the display sentences appear ONLY in the lookup table, never in a comparison
// ---
// The regression #179 guards against is a control-flow site that compares `reason` to a
// human sentence. Grepping for `=== "<sentence>"` is the exact shape of that mistake.

console.log("V1. No reason sentence is compared as a control token");
{
	const sources = [
		"extensions/lib/wtft-daemon-lib.ts",
		"extensions/lib/wtft-cli-shared.ts",
		"extensions/wtft.ts",
		"bin/wtft.ts",
	];
	const sentences = Object.values(DAEMON_REASON_TEXT);
	const offenders: string[] = [];

	for (const rel of sources) {
		const abs = path.join(REPO_ROOT, rel);
		if (!fs.existsSync(abs)) continue;
		const lines = fs.readFileSync(abs, "utf8").split("\n");
		lines.forEach((line, i) => {
			// The table itself declares these sentences — that is the one legal home.
			if (/DAEMON_REASON_TEXT|^\s*"[a-z-]+":\s*"/.test(line)) return;
			for (const sentence of sentences) {
				if (line.includes(`=== "${sentence}"`) || line.includes(`!== "${sentence}"`)) {
					offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
				}
			}
		});
	}
	assert(
		"reason sentences are never used in an equality comparison",
		offenders.length === 0,
		offenders.join("\n        "),
	);
}

// ---
// V2 — negative control: a typo'd code comparison must fail typecheck
// ---
// A compiler gate that cannot be shown to go red is indistinguishable from no gate
// (the lesson of #168). Before the split, `health.reason === "daemon not fuond"` compiled
// happily to an always-false branch. It must now be a type error.

console.log("V2. A typo'd health-code comparison fails `tsc --noEmit`");
{
	const PROBE = path.join(REPO_ROOT, "bin", "__reason_code_probe__.ts");
	const PROBE_SOURCE = `// Temporary negative control written by tests/wtft-179-daemon-health-reason.test.ts (#179).
// Deliberately compares a DaemonHealthReason against a value outside the union.
import type { DaemonStatus } from "../extensions/lib/wtft-daemon-lib.ts";
export function probe(status: DaemonStatus): boolean {
	return status.reason === "daemon not fuond";
}
`;
	try {
		fs.writeFileSync(PROBE, PROBE_SOURCE, "utf8");
		const r = spawnSync("bun", ["run", "typecheck"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			timeout: 180_000,
		});
		const status = r.status ?? -1;
		const output = `${r.stdout || ""}${r.stderr || ""}`;
		assert(
			"typecheck rejects a health code outside the union",
			status !== 0,
			status === 0 ? "tsc exited 0 — the union is NOT gating comparisons." : "",
		);
		assert(
			"…and the diagnostic names the offending comparison",
			/__reason_code_probe__/.test(output),
			`tsc output did not mention the probe:\n${output.slice(0, 800)}`,
		);
	} finally {
		try { fs.unlinkSync(PROBE); } catch {}
	}
}

// ---
// V3 — the #124 startup grace window (the behaviour test that was missing)
// ---
// Deterministic by construction: we point ensureDaemonRunning at a stand-in daemon that
// starts and never claims the PID file. checkDaemonHealth therefore reports `not-found`
// for the whole run, which is precisely the state the grace window exists to mask. A real
// daemon would race us to `alive` and make the assertion flaky.

console.log("V3. #124 grace window — `starting`/`waiting-session`, never `not-found`, inside 5s");
{
	const fixture = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-179-")));
	const fakeDaemonDir = path.join(fixture, "bin");
	fs.mkdirSync(fakeDaemonDir, { recursive: true });
	// Stand-in daemon: exits immediately, writes no PID file, claims nothing.
	fs.writeFileSync(path.join(fakeDaemonDir, "wtft-daemon.mjs"), "process.exit(0);\n", "utf8");

	try {
		// --- 3a. Spawned, session .jsonl does not exist yet → waiting-session
		const missingSession = path.join(fixture, "never-created.jsonl");
		ensureDaemonRunning(missingSession, fakeDaemonDir);
		const waiting = getDaemonStatus(missingSession);
		assert(
			"no session file inside the window → code `waiting-session`",
			waiting.reason === "waiting-session",
			`got ${JSON.stringify(waiting.reason)}`,
		);
		assert(
			"…and the indicator does NOT read 'daemon not found'",
			!renderDaemonStatus(waiting).includes(DAEMON_REASON_TEXT["not-found"]),
			renderDaemonStatus(waiting),
		);

		// --- 3b. Spawned, session .jsonl exists → starting
		const realSession = path.join(fixture, "session.jsonl");
		fs.writeFileSync(realSession, "", "utf8");
		ensureDaemonRunning(realSession, fakeDaemonDir);
		const starting = getDaemonStatus(realSession);
		assert(
			"session file present inside the window → code `starting`",
			starting.reason === "starting",
			`got ${JSON.stringify(starting.reason)}`,
		);
		assert(
			"…and the indicator reads 'starting...' — the #124 requirement",
			renderDaemonStatus(starting).includes(DAEMON_REASON_TEXT["starting"]),
			renderDaemonStatus(starting),
		);

		// --- 3c. Past the 5s window → the mask lifts and the truth shows through
		console.log("     (waiting out the 5s grace window…)");
		await sleep(5200);
		const expired = getDaemonStatus(realSession);
		assert(
			"after 5s the window closes → code `not-found`",
			expired.reason === "not-found",
			`got ${JSON.stringify(expired.reason)}`,
		);
	} finally {
		try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {}
	}
}

// ---
// V4 — the split changed no user-visible text
// ---
// The whole claim of #179 is that the sentences are now free to change. This test pins
// what they are TODAY, so a change is a deliberate edit here rather than a silent drift.

console.log("V4. Display text is unchanged for every code");
{
	const EXPECTED: Record<DaemonHealthReason, string> = {
		"not-started": "daemon not started",
		"starting": "starting...",
		"waiting-session": "waiting for session .jsonl...",
		"not-found": "daemon not found",
		"idle-timeout": "idle timeout",
		"restart-failed": "restart failed",
	};

	for (const [code, text] of Object.entries(EXPECTED) as [DaemonHealthReason, string][]) {
		assert(`\`${code}\` renders "${text}"`, daemonReasonText(code) === text, `got "${daemonReasonText(code)}"`);
	}

	assert(
		"every union member has display text (no missing entry)",
		Object.keys(DAEMON_REASON_TEXT).length === Object.keys(EXPECTED).length,
		`table has ${Object.keys(DAEMON_REASON_TEXT).join(", ")}`,
	);

	// An unknown/absent code must degrade, never throw — the widget renders on every tick.
	assert("undefined code degrades to 'unknown'", daemonReasonText(undefined) === "unknown");

	// The two removed booleans (`starting`, `waiting`) must not have crept back as
	// derivable state alongside the code they duplicated.
	const libSource = fs.readFileSync(path.join(REPO_ROOT, "extensions/lib/wtft-daemon-lib.ts"), "utf8");
	assert(
		"DaemonStatus does not reintroduce `starting?:` / `waiting?:` flags",
		!/^\s*(starting|waiting)\?:\s*boolean/m.test(libSource),
	);
}

console.log(`\n${failed === 0 ? GREEN : RED}${passed} passed, ${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

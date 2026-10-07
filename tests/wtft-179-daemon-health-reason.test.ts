#!/usr/bin/env bun
/**
 * #179 — the daemon health reason is a machine code, the status text is
 *   derived from it.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	DAEMON_REASON_TEXT,
	daemonReasonText,
	getDaemonPidPath,
	renderDaemonStatus,
	type DaemonHealthReason,
} from "../extensions/lib/wtft-daemon-lib.ts";
import { leaseHolder, leasePid } from "../extensions/lib/lease.ts";
import { stopHolder } from "../extensions/lib/holder.ts";
import { awaitStandIn } from "./lib/stand-in-daemon.ts";
import { ensureDaemonRunning, getDaemonStatus } from "../extensions/lib/wtft-cli-shared.ts";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

// Private pid namespace for this suite (#486). ensureDaemonRunning() reaches
// spawnWtftDaemon()/getDaemonPidPath(), which key off os.tmpdir(), so this must
// precede the first call to it.
isolateTmpdir("daemon-health-reason");

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
		...fs.readdirSync(path.join(REPO_ROOT, "extensions", "lib", "cli")).map(f => `extensions/lib/cli/${f}`),
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
	// Not in bin/: pack-and-smoke, running beside this suite, refuses a bin/ with
	// an untracked file. A config extending the repo's checks the probe alone.
	const PROBE_DIR = path.join(REPO_ROOT, "tmp", `wtft-179-probe-${process.pid}`);
	const PROBE = path.join(PROBE_DIR, "__reason_code_probe__.ts");
	const PROBE_SOURCE = `// Temporary negative control written by tests/wtft-179-daemon-health-reason.test.ts (#179).
// Deliberately compares a DaemonHealthReason against a value outside the union.
import type { DaemonStatus } from "../../extensions/lib/wtft-daemon-lib.ts";

export function probe(status: DaemonStatus): boolean {
	return status.reason === "daemon not fuond";
}
`;
	try {
		fs.mkdirSync(PROBE_DIR, { recursive: true });
		fs.writeFileSync(PROBE, PROBE_SOURCE, "utf8");
		fs.writeFileSync(path.join(PROBE_DIR, "tsconfig.json"),
			JSON.stringify({ extends: "../../tsconfig.json", include: ["__reason_code_probe__.ts"] }));
		const r = spawnSync(path.join(REPO_ROOT, "node_modules", ".bin", "tsc"), ["--noEmit", "-p", PROBE_DIR], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			timeout: 180_000,
		});
		// A tsc that never ran is not a rejection.
		assert("fixture: tsc ran", !r.error && r.status !== null, `tsc did not run: ${r.error?.message ?? r.signal}`);
		if (!r.error && r.status !== null) {
			const output = `${r.stdout || ""}${r.stderr || ""}`;
			assert(
				"typecheck rejects a health code outside the union",
				r.status !== 0,
				r.status === 0 ? "tsc exited 0 — the union is NOT gating comparisons." : "",
			);
			assert(
				"…and the diagnostic names the offending comparison",
				/__reason_code_probe__.*TS2367/.test(output) && /daemon not fuond/.test(output),
				`tsc output did not mention the probe:\n${output.slice(0, 800)}`,
			);
		}
	} finally {
		fs.rmSync(PROBE_DIR, { recursive: true, force: true });
	}
}

// ---
// V3 — the startup indicator, with no clock window
// ---
// The spawner claims the lease for its child, so a stand-in that claims nothing
// still holds it while it lives: waiting-session with no session file, live with
// one, not-found once it has exited. Nothing waits out a timer.

console.log("V3. #124 startup indicator — the spawner's claim, not a grace window (#281)");
{
	const fixture = trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), "wtft-179-")));
	const fakeDaemonDir = path.join(fixture, "stand-in");
	fs.mkdirSync(fakeDaemonDir, { recursive: true });
	fs.writeFileSync(path.join(fakeDaemonDir, "wtft-daemon.mjs"), "setTimeout(() => process.exit(0), 30_000);\n", "utf8");
	const children: number[] = [];
	const claimed = (session: string): number => {
		const pid = leasePid(leaseHolder(getDaemonPidPath(session)));
		if (pid > 0) children.push(pid);
		return pid;
	};

	try {
		// --- 3a. Spawned, session .jsonl does not exist yet → waiting-session
		const missingSession = path.join(fixture, "never-created.jsonl");
		ensureDaemonRunning(missingSession, fakeDaemonDir);
		const waitingPid = claimed(missingSession);
		assert("3a precondition: the claimed child reads as a daemon", awaitStandIn(waitingPid), "");
		const waiting = getDaemonStatus(missingSession);
		assert(
			"no session file while the child lives → code `waiting-session`",
			waiting.reason === "waiting-session",
			`got ${JSON.stringify(waiting.reason)}`,
		);
		assert(
			"…and the indicator does NOT read 'daemon not found'",
			!renderDaemonStatus(waiting).includes(DAEMON_REASON_TEXT["not-found"]),
			renderDaemonStatus(waiting),
		);

		// --- 3b. Spawned, session .jsonl exists → alive from the first ask
		const realSession = path.join(fixture, "session.jsonl");
		fs.writeFileSync(realSession, "", "utf8");
		ensureDaemonRunning(realSession, fakeDaemonDir);
		const upPid = claimed(realSession);
		assert("3b precondition: the claimed child reads as a daemon", awaitStandIn(upPid), "");
		const up = getDaemonStatus(realSession);
		assert(
			"session file present, child alive → alive with no reason code",
			up.alive && up.reason === undefined,
			`got ${JSON.stringify(up)}`,
		);

		// --- 3c. The child exits without serving → the truth shows at the next ask
		assert("3c precondition: the child has exited", upPid > 0 && await stopHolder(upPid) === "stopped", "");
		const gone = getDaemonStatus(realSession);
		assert(
			"after the child exits → code `not-found`",
			gone.reason === "not-found",
			`got ${JSON.stringify(gone.reason)}`,
		);
	} finally {
		for (const pid of children) await stopHolder(pid);
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
	const libSource = fs.readFileSync(path.join(REPO_ROOT, "extensions/lib/daemon-health.ts"), "utf8");
	assert("fixture: DaemonStatus is declared there", libSource.includes("export interface DaemonStatus"));
	assert(
		"DaemonStatus does not reintroduce `starting?:` / `waiting?:` flags",
		!/^\s*(starting|waiting)\?:\s*boolean/m.test(libSource),
	);
}

console.log(`\n${failed === 0 ? GREEN : RED}${passed} passed, ${failed} failed${RESET}`);
process.exit(failed > 0 ? 1 : 0);

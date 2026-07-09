#!/usr/bin/env -S node --experimental-strip-types
/**
 * @package princess-pi-packages
 * @test wtft-watch-smoke
 * @description Verifies that `./wtft --watch` doesn't crash on startup and
 *   responds to the 'q' keystroke to exit cleanly. Catches missing-import bugs
 *   like hideCursor/showCursor/enterRawStdin being undefined in the bundle
 *   (monolith split regression from #68/#75).
 *
 *   Uses `script(1)` to provide a pseudo-TTY (required by watch mode's isTTY
 *   guard), then pipes 'q' to verify graceful exit.
 *
 *   Also checks the built bundle has no unresolved function references by
 *   verifying that all TTY-helper function declarations match their call sites
 *   (no name-collision `2`-suffixed variants).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

const SCRIPT = path.resolve(import.meta.dirname, "..", "wtft");
const CLI_BIN = path.resolve(import.meta.dirname, "..", "bin", "wtft.mjs");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function assert(label: string, ok: boolean) {
	if (ok) {
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} else {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		failed++;
	}
}

// ---
// Fixture: simplest possible session (1 interaction)
// ---

const SESSION_ID = "fixture-watch-smoke";
const MESSAGE_ID = "msg_watch_001";
const TIMESTAMP = Date.now();

function makeFixture(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wtft-watch-test-"));
	const sessionPath = path.join(dir, `${SESSION_ID}.jsonl`);

	const lines = [
		JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				id: MESSAGE_ID,
				timestamp: new Date(TIMESTAMP).toISOString(),
				model: "claude-sonnet-4-20250514",
				usage: { input_tokens: 100, output_tokens: 50 },
				content: [{ type: "text", text: "Hello." }],
			},
		}),
	];
	fs.writeFileSync(sessionPath, lines.join("\n") + "\n");
	return sessionPath;
}

// ---
// Test 1: Post-build bundle integrity check
// ---
console.log("1. Post-build bundle integrity");

const bundle = fs.readFileSync(CLI_BIN, "utf8");

// Verify all three TTY helpers appear as proper function declarations
assert(
	"hideCursor is a function declaration in bundle",
	/function hideCursor\s*\(/.test(bundle)
);
assert(
	"showCursor is a function declaration in bundle",
	/function showCursor\s*\(/.test(bundle)
);
assert(
	"enterRawStdin is a function declaration in bundle",
	/function enterRawStdin\s*\(/.test(bundle)
);

// Check that NO name-collision variants exist (would indicate unresolved imports)
assert(
	"no hideCursor2/showCursor2/enterRawStdin2 variants",
	!/hideCursor2\b/.test(bundle) && !/showCursor2\b/.test(bundle) && !/enterRawStdin2\b/.test(bundle)
);

// ---
// Test 2: --watch smoke test via pseudo-TTY
// ---
console.log("\n2. --watch smoke test (pseudo-TTY via script)");

const sessionPath = makeFixture();
let cleanExit = false;
let timedOut = false;

try {
	const result = await new Promise<{ code: number | null; output: string }>(
		(resolve, reject) => {
			const s = spawn(
				"script",
				["-q", "-c", `${SCRIPT} --watch -s '${sessionPath}' -l1`, "/dev/null"],
				{ stdio: ["pipe", "pipe", "pipe"] }
			);

			let output = "";
			s.stdout.on("data", (d: Buffer) => {
				output += d.toString();
			});
			s.stderr.on("data", (d: Buffer) => {
				output += d.toString();
			});

			// Send 'q' after the process has had time to start up
			setTimeout(() => {
				s.stdin.write("q");
			}, 1500);

			// Timeout safety valve
			const timer = setTimeout(() => {
				s.kill();
				timedOut = true;
				resolve({ code: null, output });
			}, 8000);

			s.on("exit", (code) => {
				clearTimeout(timer);
				resolve({ code, output });
			});
			s.on("error", reject);
		}
	);

	assert(
		"wtft --watch exits with code 0 on 'q'",
		result.code === 0
	);
	assert(
		"wtft --watch prints 'watch stopped' summary on exit",
		result.output.includes("watch stopped")
	);
	if (timedOut) {
		assert("wtft --watch did not hang (timeout)", false);
	}
} catch (err) {
	assert(
		`wtft --watch smoke test: ${(err as Error).message}`,
		false
	);
}

// Cleanup fixture
try {
	fs.rmSync(path.dirname(sessionPath), { recursive: true, force: true });
} catch {}

// ---
// Results
// ---
console.log("\n──────────────────────────────");
console.log(
	`Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`
);
process.exit(failed > 0 ? 1 : 0);

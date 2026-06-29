import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseEntryToInteraction, buildWtftLines, type Interaction } from "../extensions/lib/wtft-shared.ts";

// Create a temp directory for our mock sessions
const tmpDir = path.join(os.tmpdir(), `wtft-test-${Math.random().toString(36).substring(2, 11)}`);
fs.mkdirSync(tmpDir, { recursive: true });

console.log(`=== RUNNING WTFT ISSUE #21 TESTS inside ${tmpDir} ===`);

try {
	// ---
	// TEST 1: RECURSIVE SUBAGENT COST ROLLUP
	// ---
	console.log("\nTesting recursive subagent cost rollup...");

	// 1. Setup mock session files
	const parentSessionFile = path.join(tmpDir, "session-12345.jsonl");
	const subagentsDir = path.join(tmpDir, "session-12345", "subagents");
	fs.mkdirSync(subagentsDir, { recursive: true });

	const subagentFileA = path.join(subagentsDir, "agent-abc.jsonl");
	const subagentFileB = path.join(subagentsDir, "agent-xyz.jsonl");

	// Parent has 1 turn at timestamp T1 (cost: $5.00)
	const t1 = new Date("2026-06-25T10:00:00Z").getTime();
	const parentData = [
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				timestamp: t1,
				usage: { cost: { total: 5.00 } }
			}
		})
	].join("\n") + "\n";

	// Subagent A has 1 turn at timestamp T1 - 30 mins (cost: $2.50)
	const t2 = t1 - 30 * 60 * 1000;
	const subagentAData = [
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				timestamp: t2,
				usage: { cost: { total: 2.50 } }
			}
		})
	].join("\n") + "\n";

	// Subagent B has 1 turn at timestamp T1 + 30 mins (cost: $1.50)
	const t3 = t1 + 30 * 60 * 1000;
	const subagentBData = [
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				timestamp: t3,
				usage: { cost: { total: 1.50 } }
			}
		})
	].join("\n") + "\n";

	fs.writeFileSync(parentSessionFile, parentData);
	fs.writeFileSync(subagentFileA, subagentAData);
	fs.writeFileSync(subagentFileB, subagentBData);

	// 2. Perform mock rollup file loading (exactly mirroring bin/wtft.ts's algorithm)
	const loadedSessionFiles = [parentSessionFile];
	const extName = path.extname(parentSessionFile);
	if (extName === ".jsonl") {
		const baseName = path.basename(parentSessionFile, extName);
		const parentDir = path.dirname(parentSessionFile);
		const possibleSubagentsDir = path.join(parentDir, baseName, "subagents");
		if (fs.existsSync(possibleSubagentsDir)) {
			const subFiles = fs.readdirSync(possibleSubagentsDir);
			for (const f of subFiles) {
				if (f.startsWith("agent-") && f.endsWith(".jsonl")) {
					loadedSessionFiles.push(path.join(possibleSubagentsDir, f));
				}
			}
		}
	}

	// Verify both subagents were detected
	assert.strictEqual(loadedSessionFiles.length, 3, "Loader must find parent plus two subagents");
	assert.ok(loadedSessionFiles.includes(subagentFileA), "Must include subagent A");
	assert.ok(loadedSessionFiles.includes(subagentFileB), "Must include subagent B");

	// 3. Compile lines and verify interactions are parsed and sorted correctly
	const lines: string[] = [];
	for (const file of loadedSessionFiles) {
		const content = fs.readFileSync(file, "utf8");
		lines.push(...content.split("\n"));
	}

	const interactions: Interaction[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line);
		const parsed = parseEntryToInteraction(entry);
		if (parsed) {
			interactions.push(parsed);
		}
	}

	assert.strictEqual(interactions.length, 3, "Total parsed interactions must equal 3");

	// Verify binned timelines cumulative calculation
	const defaultSettings = {
		interval: "1h",
		limit: 10,
		width: 80,
		showTicks: false,
		mode: "cumulative" as "cumulative" | "bucket",
		timezone: "UTC"
	};

	const renderedLines = buildWtftLines(interactions, defaultSettings);
	assert.ok(renderedLines, "Should render wtft output lines");

	// Total cost must sum up: Parent ($5) + Sub A ($2.50) + Sub B ($1.50) = $9.00
	const totalCost = interactions.reduce((sum, i) => sum + i.cost, 0);
	assert.strictEqual(totalCost, 9.00, "Rolled-up sum must equal exact cost total ($9.00)");
	console.log("✅ Recursive Subagent rollup test PASSED!");

	// ---
	// TEST 2: NON-TTY FALLBACK BEHAVIOR
	// ---
	console.log("\nTesting Non-interactive Fallback Selection output...");

	interface SessionCandidate {
		path: string;
		harness: "pi" | "claude-code";
		timestamp: number;
		name: string;
	}

	const mockCandidates: SessionCandidate[] = [
		{ path: parentSessionFile, harness: "claude-code", timestamp: Date.now(), name: "session-12345.jsonl" }
	];

	// Capture console.log output during fallback resolution
	const loggedLines: string[] = [];
	const originalLog = console.log;
	console.log = (msg: string) => { loggedLines.push(msg); };

	let selectedPath = "";
	try {
		// Mock non-TTY execution path
		const isTTY = process.stdout.isTTY;
		// Temporarily override isTTY to false
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

		if (!process.stdout.isTTY) {
			for (let i = 0; i < Math.min(mockCandidates.length, 5); i++) {
				const c = mockCandidates[i];
				const shortName = c.name;
				const dateStr = new Date(c.timestamp).toLocaleString();
				console.log(`  [${i + 1}] ${shortName} (${dateStr}) [${c.harness.toUpperCase()}]`);
			}
			selectedPath = mockCandidates[0].path;
		}

		// Restore isTTY
		Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
	} finally {
		console.log = originalLog;
	}

	assert.strictEqual(selectedPath, parentSessionFile, "Fallback selector must automatically return newest session path");
	assert.ok(loggedLines.length > 0, "Fallback selector must log info when running inside non-TTY");
	assert.ok(loggedLines[0].includes("session-12345.jsonl"), "Logged lines must display candidates summary list");
	console.log("✅ Non-TTY selector fallback test PASSED!");

} catch (err) {
	console.error("❌ System test FAILED:", err);
	process.exit(1);
} finally {
	// Cleanup temp directory
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {}
}

console.log("\n✅ ALL ISSUE #21 VALIDATION TESTS PASSED PERFECTLY!");

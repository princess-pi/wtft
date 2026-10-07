#!/usr/bin/env bun
/**
 * Tests the artifact we actually ship (#159), not the dev tree.
 */

import * as assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { trackSandbox, isolateTmpdir } from "./lib/sandbox";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

let passed = 0;
let failed = 0;

function check(label: string, fn: () => void) {
	try {
		fn();
		console.log(`  ${GREEN}PASS${RESET} ${label}`);
		passed++;
	} catch (err) {
		console.log(`  ${RED}FAIL${RESET} ${label}`);
		console.log(`       ${(err as Error).message.split("\n").join("\n       ")}`);
		failed++;
	}
}

const KNOWN_LIMIT =
	`${DIM}Known limit: this suite installs the npm pack tarball (bun on PATH for\n` +
	`prepare during the pack only) with plain node/npm and runs the two CLIs. It does\n` +
	`NOT exercise the git-URL channel, which runs \`prepare\` and needs bun on PATH,\n` +
	`nor load the Pi bundles. Green here != every install channel green.${RESET}`;

console.log(KNOWN_LIMIT);
console.log();

// Private pid namespace for this suite — a shared /tmp would reach other
// suites' daemons and the daemons of real sessions on this host.
isolateTmpdir("pack-and-smoke");

function mkTemp(prefix: string): string {
	return trackSandbox(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function killLingeringDaemons() {
	try {
		for (const pf of fs.readdirSync(os.tmpdir())) {
			if (!pf.startsWith("wtft-daemon-") || !pf.endsWith(".pid")) continue;
			try {
				const pid = parseInt(fs.readFileSync(path.join(os.tmpdir(), pf), "utf8").trim(), 10);
				// Only signal the PID if it is actually a wtft-daemon: a stale pid
				// file whose PID the kernel has since recycled would otherwise
				// SIGTERM an unrelated process. `ps -o command=` is the portable
				// equivalent of reading /proc/<pid>/cmdline (works on Linux AND
				// macOS/BSD, where /proc does not exist).
				let cmdline = "";
				try { cmdline = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim(); } catch {}
				if (pid > 0 && cmdline.includes("wtft-daemon")) process.kill(pid, "SIGTERM");
			} catch {}
		}
	} catch {}
}

const REBUILD_TOUCHED = ["extensions/lib/harness/builtins.generated.ts", "bun.lock"];

function gitStatusLines(paths: string[]): string[] {
	const out = execFileSync("git", ["status", "--porcelain", "--", ...paths], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	return out.split("\n").map((l) => l.trimEnd()).filter(Boolean);
}

const untracked = REBUILD_TOUCHED.filter((f) => spawnSync("git", ["ls-files", "--error-unmatch", "--", f], { cwd: REPO_ROOT }).status !== 0);
if (untracked.length > 0) {
	console.log(`${RED}FAIL${RESET} pre-flight: not tracked, so their status says nothing: ${untracked.join(", ")}`);
	process.exit(1);
}
const preExistingDirt = gitStatusLines(REBUILD_TOUCHED);

if (preExistingDirt.length > 0) {
	console.log(`${RED}FAIL${RESET} pre-flight: ${REBUILD_TOUCHED.join(", ")} already has uncommitted changes`);
	console.log(`       npm pack runs prepare, which can rewrite them.`);
	for (const l of preExistingDirt) console.log(`       ${l}`);
	failed++;
	console.log(`\nResults: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}`);
	process.exit(1);
}

let exitCode = 0;

try {
	// ---
	// 1. Pack the repo. Runs FROM the repo (bun allowed for `prepare`).
	// ---

	const packDir = mkTemp("wtft-pack-");
	const packResult = spawnSync("npm", ["pack", "--pack-destination", packDir, "--silent"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});

	check("npm pack succeeds", () => {
		assert.strictEqual(packResult.status, 0, `npm pack exited ${packResult.status}: ${packResult.stderr}`);
	});

	const tgzFiles = fs.readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
	const tgzPath = tgzFiles[0] ? path.join(packDir, tgzFiles[0]) : "";

	check("tarball produced", () => {
		assert.strictEqual(tgzFiles.length, 1, `expected 1 tarball, found ${tgzFiles.length}`);
	});

	check(`npm pack leaves the tracked files prepare can rewrite (${REBUILD_TOUCHED.join(", ")}) unchanged`, () => {
		assert.deepStrictEqual(gitStatusLines(REBUILD_TOUCHED), [], "prepare changed a tracked file");
	});

	if (!tgzPath) {
		throw new Error("no tarball produced — cannot continue");
	}

	const tarballEntries = new Set(
		execFileSync("tar", ["-tzf", tgzPath], { encoding: "utf8" })
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.map((l) => l.replace(/^package\//, ""))
			.filter((l) => !l.endsWith("/")),
	);
	const filesEntries: string[] = PKG.files;
	const mandatory = ["package.json", "LICENSE", "README.md"];

	check("package.json's files lists exactly the two CLI bundles and the two Pi-extension bundles", () => {
		assert.deepStrictEqual([...filesEntries].sort(), ["bin/wtft-daemon.mjs", "bin/wtft.mjs", "pi/token-budget.js", "pi/wtft.js"]);
	});

	check("the tarball holds exactly package.json's files entries plus package.json, LICENSE and README.md", () => {
		assert.deepStrictEqual([...tarballEntries].sort(), [...filesEntries, ...mandatory].sort());
	});

	check("every package.json bin target is in the tarball", () => {
		const missing = Object.values(PKG.bin as Record<string, string>).map((t) => t.replace(/^\.\//, "")).filter((t) => !tarballEntries.has(t));
		assert.deepStrictEqual(missing, [], `bin targets absent from tarball: ${missing.join(", ")}`);
	});

	// ---
	// 3. Install with a PATH that has no bun on it at all.
	// ---

	const stockBin = mkTemp("wtft-stockbin-");
	const nodePath = (process.env.PATH ?? "").split(":").map((d) => path.join(d, "node")).find((f) => {
		try { return path.basename(fs.realpathSync(f)) === "node"; } catch { return false; }
	}) ?? "";
	const npmPath = path.join(path.dirname(nodePath), "npm");

	check("resolved node's real path is named node, with npm beside it", () => {
		const v = execFileSync(nodePath, ["--version"], { encoding: "utf8" });
		assert.ok(/^v\d+\.\d+\.\d+/.test(v.trim()), `unexpected node --version: ${v}`);
		assert.strictEqual(path.basename(fs.realpathSync(nodePath)), "node");
		assert.ok(fs.existsSync(npmPath), `no npm beside node: ${npmPath}`);
	});

	fs.symlinkSync(nodePath, path.join(stockBin, "node"));
	fs.symlinkSync(npmPath, path.join(stockBin, "npm"));
	const stockPath = `${stockBin}:/usr/bin:/bin`;
	const stockEnv = { PATH: stockPath, HOME: process.env.HOME ?? "", TMPDIR: os.tmpdir(), XDG_STATE_HOME: mkTemp("wtft-state-") };

	check("bun is genuinely unreachable on the stock install PATH", () => {
		const r = spawnSync("bash", ["-c", "command -v bun"], { env: stockEnv, encoding: "utf8" });
		assert.notStrictEqual(r.status, 0, `bun resolved on stock PATH: ${r.stdout}`);
	});

	const consumerParent = mkTemp("wtft-consumer-");
	const consumerDir = path.join(consumerParent, "consumer");
	fs.mkdirSync(consumerDir);
	check("the consumer directory, the installed runs' cwd, is outside the checkout", () => {
		assert.ok(path.relative(fs.realpathSync(REPO_ROOT), fs.realpathSync(consumerDir)).startsWith(".."), `${consumerDir} is under ${REPO_ROOT}`);
	});
	fs.writeFileSync(
		path.join(consumerDir, "package.json"),
		JSON.stringify({ name: "pack-and-smoke-consumer", version: "0.0.0", private: true }),
	);

	const installResult = spawnSync("npm", ["install", tgzPath, "--no-audit", "--no-fund", "--loglevel=error"], {
		cwd: consumerDir,
		env: stockEnv,
		encoding: "utf8",
	});

	check("npm install (plain node/npm, no bun on PATH) succeeds", () => {
		assert.strictEqual(installResult.status, 0, `npm install exited ${installResult.status}: ${installResult.stderr}`);
	});

	const wtftBin = path.join(consumerDir, "node_modules", ".bin", "wtft");
	const daemonBin = path.join(consumerDir, "node_modules", ".bin", "wtft-daemon");

	check("wtft and wtft-daemon bins are present after install", () => {
		for (const b of [wtftBin, daemonBin]) assert.ok(fs.existsSync(b), `missing: ${b}`);
	});

	// ---
	// 4. Real commands against the installed package.
	// ---

	function runInstalled(bin: string, args: string[], xdgHome: string, walkUp = false) {
		const env: NodeJS.ProcessEnv = { ...stockEnv, XDG_CONFIG_HOME: xdgHome, COLUMNS: "250" };
		if (!walkUp) env.PRINCESS_PI_CONFIG_NO_WALKUP = "1";
		return spawnSync(bin, args, { cwd: consumerDir, env, encoding: "utf8" });
	}

	const versionResult = runInstalled(wtftBin, ["--version"], mkTemp("wtft-xdg-"));
	check(`wtft --version exits 0 and its first line is exactly "wtft ${PKG.version}"`, () => {
		assert.strictEqual(versionResult.status, 0, `exit ${versionResult.status}: ${versionResult.stdout}${versionResult.stderr}`);
		assert.strictEqual(versionResult.stdout.split("\n")[0], `wtft ${PKG.version}`);
	});

	const daemonResult = runInstalled(daemonBin, ["--help"], mkTemp("wtft-xdg-"));
	check("wtft-daemon --help exits 0", () => {
		assert.strictEqual(daemonResult.status, 0, `exit ${daemonResult.status}: ${daemonResult.stdout}${daemonResult.stderr}`);
	});

	const fixtureDir = mkTemp("wtft-fixture-");
	const fixturePath = path.join(fixtureDir, "pack-and-smoke-fixture.jsonl");
	// Relative timestamp (a minute ago) so the fixture stays inside the default
	// interval window regardless of when the suite runs — a hardcoded past date
	// would eventually age out of a recency-filtered default interval.
	const fixtureTs = new Date(Date.now() - 60000).toISOString();
	// Shape matches the -s session-file parser (bin/wtft.mjs `parse2.matchAssistant`):
	// top-level `type: "message"` (NOT the transcript parser's `type: "assistant"`)
	// with `timestamp`/`model`/`usage` nested under `message`.
	fs.writeFileSync(
		fixturePath,
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				id: "msg_pack_and_smoke",
				// Pinned pricing-table entry (see bin/wtft.mjs MODELS): the cost is
				// deterministic ($4.50 = 1M in × $3/M + 100K out × $15/M).
				model: "claude-sonnet-4-6",
				timestamp: fixtureTs,
				usage: { input_tokens: 1000000, output_tokens: 100000 },
				content: [{ type: "text", text: "smoke" }],
			},
		}) + "\n",
	);

	const renderResult = runInstalled(
		wtftBin,
		["-s", fixturePath, "--cost", "--no-emoji", "--pad", "0"],
		mkTemp("wtft-xdg-"),
	);

	check("wtft -s <fixture> shows the deterministic $4.50 cost (exit 0, no ❌ or System Error line on stdout or stderr)", () => {
		assert.strictEqual(renderResult.status, 0, `exit ${renderResult.status}: ${renderResult.stdout}${renderResult.stderr}`);
		assert.ok(!/❌|System Error/.test(renderResult.stdout + renderResult.stderr), `error banner in output:\n${renderResult.stdout}${renderResult.stderr}`);
		// $4.50 is the deterministic total (1M in × $3/M + 100K out × $15/M) and is
		// distinct from the axis labels ($0.00/$1.25/$2.50/$3.75/$5.00), so this
		// pins parse → interaction → cost, not merely "some non-zero figure".
		assert.ok(renderResult.stdout.includes("$4.50"), `expected $4.50 rendered cost, got:\n${renderResult.stdout}`);
	});

	const renderArgs = ["-s", fixturePath, "--cost", "--no-emoji", "--pad", "0"];
	fs.mkdirSync(path.join(consumerParent, ".wtft"));
	fs.writeFileSync(path.join(consumerParent, ".wtft", "config.json"), JSON.stringify({ mode: "bucket" }));
	const walked = runInstalled(wtftBin, renderArgs, mkTemp("wtft-xdg-"), true);
	const planted = runInstalled(wtftBin, renderArgs, mkTemp("wtft-xdg-"));
	check("fixture precondition: with config walk-up on, the render loses the cumulative key and still exits 0 with $4.50", () => {
		assert.ok(renderResult.stdout.includes("earlier bins"), `cumulative key absent from the plain render:\n${renderResult.stdout}`);
		assert.strictEqual(walked.status, 0, `exit ${walked.status}: ${walked.stderr}`);
		assert.ok(walked.stdout.includes("$4.50") && !walked.stdout.includes("earlier bins"), `the planted config did not reach a walking-up run:\n${walked.stdout}`);
	});
	check("with walk-up off, a .wtft/config.json above the installed wtft's cwd leaves its render cumulative with $4.50", () => {
		assert.ok(planted.stdout.includes("earlier bins") && planted.stdout.includes("$4.50"), `planted config reached the run:\n${planted.stdout}`);
	});
} catch (err) {
	console.log(`${RED}Unexpected error:${RESET} ${(err as Error).stack ?? err}`);
	failed++;
	exitCode = 1;
} finally {
	killLingeringDaemons();
	const finalDirt = gitStatusLines(REBUILD_TOUCHED);
	if (finalDirt.length > 0) {
		console.log(`${RED}FAIL${RESET} post-flight: ${REBUILD_TOUCHED.join(", ")} left dirty, restoring`);
		try { execFileSync("git", ["checkout", "--", ...REBUILD_TOUCHED], { cwd: REPO_ROOT }); } catch {}
		failed++;
	}
}

console.log();
console.log(KNOWN_LIMIT);
console.log(`\n${BOLD}Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}${RESET}`);
process.exit(exitCode !== 0 || failed > 0 ? 1 : 0);

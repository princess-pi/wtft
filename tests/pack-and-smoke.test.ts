#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test pack-and-smoke
 * @description Tests the artifact we actually ship (#159), not the dev tree.
 *   `npm pack` the repo, install the tarball into a fresh temp dir with plain
 *   node/npm (bun excluded from PATH), then run real commands against the
 *   installed package — proving the registry/tarball channel ships a
 *   self-contained artifact that runs on stock node.
 *
 *   Why it is smaller than the princess-pi-tools original: that package ships
 *   six bins plus `docs/manifests/` read at runtime and an installer that
 *   deploys skills. This package ships exactly two bundles (`bin/wtft.mjs`,
 *   `bin/wtft-daemon.mjs`, the `files` allowlist) that are self-contained by
 *   #36 — the manifest is inlined at build, and `@princess-pi/libs` + `wcwidth`
 *   are vendored into the bundle. So the tarball's correctness is "the two
 *   bundles are present and run on stock node", not a docs/ allowlist.
 *
 * @limit KNOWN, STATED HERE AND IN THE OUTPUT: this suite proves the
 *   REGISTRY/TARBALL channel only (npm pack → npm install → plain node). It
 *   does not exercise the git-URL channel, which runs `prepare` and needs bun
 *   on PATH (bun-on-PATH is permitted for git-URL installs only, never for the
 *   registry channel).
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
	`${DIM}Known limit: this suite proves the REGISTRY/TARBALL install channel only\n` +
	`(npm pack -> npm install -> plain node, bun excluded from PATH). It does NOT\n` +
	`exercise the git-URL channel, which runs \`prepare\` and needs bun on PATH -\n` +
	`an accepted constraint. Green here != every install channel green.${RESET}`;

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
				// SIGTERM an unrelated process. On non-Linux /proc is absent, so
				// the check fails closed (no signal) and the daemon self-exits.
				let cmdline = "";
				try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch {}
				if (pid > 0 && cmdline.includes("wtft-daemon")) process.kill(pid, "SIGTERM");
			} catch {}
		}
	} catch {}
}

// ---
// Guard: `npm pack` fires `prepare`, which re-runs `bun build.ts` and rewrites
// bin/*.mjs. That is a no-op only if the tree was clean going in. Detect the
// pre-existing state and refuse to touch it, rather than clobbering WIP.
// ---

const REBUILD_TOUCHED = ["bin/"];

function gitStatusLines(paths: string[]): string[] {
	const out = execFileSync("git", ["status", "--porcelain", "--", ...paths], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	return out.split("\n").map((l) => l.trimEnd()).filter(Boolean);
}

const preExistingDirt = gitStatusLines(REBUILD_TOUCHED);

if (preExistingDirt.length > 0) {
	console.log(`${RED}FAIL${RESET} pre-flight: bin/ already has uncommitted changes`);
	console.log(`       This suite's npm pack step rebuilds that path and would clobber it.`);
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

	// Restore whatever `prepare` touched — the pre-flight proved this was clean.
	execFileSync("git", ["checkout", "--", ...REBUILD_TOUCHED], { cwd: REPO_ROOT });
	check("tree restored after npm pack", () => {
		assert.deepStrictEqual(gitStatusLines(REBUILD_TOUCHED), [], "bin/ still dirty");
	});

	if (!tgzPath) {
		throw new Error("no tarball produced — cannot continue");
	}

	// ---
	// 2. `files` allowlist coverage — the tarball carries the two bundles plus
	//    npm's mandatory package.json/LICENSE/README, and nothing else.
	// ---

	const tarballEntries = new Set(
		execFileSync("tar", ["-tzf", tgzPath], { encoding: "utf8" })
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.map((l) => l.replace(/^package\//, ""))
			.filter((l) => !l.endsWith("/")), // drop directory entries (package/bin/ -> bin/)
	);

	const expectedBinMjs = fs
		.readdirSync(path.join(REPO_ROOT, "bin"))
		.filter((f) => f.endsWith(".mjs"))
		.map((f) => path.join("bin", f));

	check(`all ${expectedBinMjs.length} bin/*.mjs files are in the tarball`, () => {
		const missing = expectedBinMjs.filter((f) => !tarballEntries.has(f));
		assert.deepStrictEqual(missing, [], `missing from tarball: ${missing.join(", ")}`);
	});

	// npm always adds package.json, LICENSE and README.md regardless of the
	// `files` allowlist — those are expected. Anything beyond them and the
	// bundles is a leak (a loose glob pulling source, tests, or node_modules).
	const alwaysIncluded = ["package.json", "LICENSE", "README.md"];
	const allowed = new Set([...expectedBinMjs, ...alwaysIncluded]);
	check("the tarball carries the bundles plus npm-mandatory files, and nothing else", () => {
		const extra = [...tarballEntries].filter((f) => !allowed.has(f));
		assert.deepStrictEqual(extra, [], `unexpected in tarball: ${extra.join(", ")}`);
	});

	// ---
	// 3. Install with a PATH that has no bun on it at all.
	// ---

	const stockBin = mkTemp("wtft-stockbin-");
	const nodePath = execFileSync("bash", ["-lc", "command -v node"], { encoding: "utf8" }).trim();
	const npmPath = execFileSync("bash", ["-lc", "command -v npm"], { encoding: "utf8" }).trim();

	check("resolved node is a real node binary, not bun", () => {
		const v = execFileSync(nodePath, ["--version"], { encoding: "utf8" });
		assert.ok(/^v\d+\.\d+\.\d+/.test(v.trim()), `unexpected node --version: ${v}`);
		assert.strictEqual(path.basename(fs.realpathSync(nodePath)), "node");
	});

	fs.symlinkSync(nodePath, path.join(stockBin, "node"));
	fs.symlinkSync(npmPath, path.join(stockBin, "npm"));
	const stockPath = `${stockBin}:/usr/bin:/bin`;
	const stockEnv = { PATH: stockPath, HOME: process.env.HOME ?? "", TMPDIR: os.tmpdir() };

	check("bun is genuinely unreachable on the stock install PATH", () => {
		const r = spawnSync("bash", ["-c", "command -v bun"], { env: stockEnv, encoding: "utf8" });
		assert.notStrictEqual(r.status, 0, `bun resolved on stock PATH: ${r.stdout}`);
	});

	const consumerDir = mkTemp("wtft-consumer-");
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

	function runInstalled(bin: string, args: string[], xdgHome: string) {
		return spawnSync(bin, args, {
			env: { ...stockEnv, XDG_CONFIG_HOME: xdgHome },
			encoding: "utf8",
		});
	}

	const versionResult = runInstalled(wtftBin, ["--version"], mkTemp("wtft-xdg-"));
	check(`wtft --version exits 0 and reports ${PKG.version}`, () => {
		assert.strictEqual(versionResult.status, 0, `exit ${versionResult.status}: ${versionResult.stdout}${versionResult.stderr}`);
		assert.ok(versionResult.stdout.includes(PKG.version), `expected "${PKG.version}" in: ${versionResult.stdout}`);
	});

	const daemonResult = runInstalled(daemonBin, ["--help"], mkTemp("wtft-xdg-"));
	check("wtft-daemon --help exits 0", () => {
		assert.strictEqual(daemonResult.status, 0, `exit ${daemonResult.status}: ${daemonResult.stdout}${daemonResult.stderr}`);
	});

	// A minimal, real Claude-Code-shaped session so the render exercises actual
	// parsing (message usage -> Interaction -> rendered cost), not just CLI arg
	// handling.
	const fixtureDir = mkTemp("wtft-fixture-");
	const fixturePath = path.join(fixtureDir, "pack-and-smoke-fixture.jsonl");
	fs.writeFileSync(
		fixturePath,
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				id: "msg_pack_and_smoke",
				model: "claude-sonnet-4-6",
				timestamp: "2026-08-10T12:00:00.000Z",
				usage: { input_tokens: 1000, output_tokens: 100 },
				content: [{ type: "text", text: "smoke" }],
			},
		}) + "\n",
	);

	const renderResult = runInstalled(
		wtftBin,
		["-s", fixturePath, "--cost", "--no-emoji", "--pad", "0"],
		mkTemp("wtft-xdg-"),
	);

	check("wtft -s <fixture> renders a cost bar chart (exit 0, no error banner, a $-figure)", () => {
		assert.strictEqual(renderResult.status, 0, `exit ${renderResult.status}: ${renderResult.stdout}${renderResult.stderr}`);
		assert.ok(!/❌|System Error/.test(renderResult.stdout), `error banner in output:\n${renderResult.stdout}`);
		assert.ok(/\$\d/.test(renderResult.stdout), `no rendered dollar figure in output:\n${renderResult.stdout}`);
	});
} catch (err) {
	console.log(`${RED}Unexpected error:${RESET} ${(err as Error).stack ?? err}`);
	failed++;
	exitCode = 1;
} finally {
	killLingeringDaemons();
	const finalDirt = gitStatusLines(REBUILD_TOUCHED);
	if (finalDirt.length > 0) {
		console.log(`${RED}FAIL${RESET} post-flight: bin/ left dirty, restoring`);
		try { execFileSync("git", ["checkout", "--", ...REBUILD_TOUCHED], { cwd: REPO_ROOT }); } catch {}
		failed++;
	}
}

console.log();
console.log(KNOWN_LIMIT);
console.log(`\n${BOLD}Results: ${GREEN}${passed} passed${RESET}, ${RED}${failed} failed${RESET}${RESET}`);
process.exit(exitCode !== 0 || failed > 0 ? 1 : 0);

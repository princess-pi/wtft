#!/usr/bin/env bun
/**
 * @package @princess-pi/wtft
 * @test wtft-46-install-wtft
 * @description `bin/install-wtft` puts THIS repo's build on PATH (#46).
 *
 *   WHY THIS EXISTS. `wtft` on this host resolves to
 *   ~/.bun/bin/wtft -> the princess-pi-tools clone, reporting 1.1.0 while this
 *   repo builds 1.0.0 — so #36, #37, #39 and #18 are all absent from the binary
 *   that actually runs, and lazy session discovery got implemented twice, once
 *   in each repo. `install-workflow-tools` never installed wtft (zero
 *   references); the route is `bun link` plus ppt's package.json bin map.
 *
 *   EVERY CHECK DRIVES THE CLI, and every one of them drives a TEMP --dir and a
 *   TEMP PATH. Nothing here writes to the real ~/bin or reads the developer's
 *   real PATH: the --dir seam exists precisely so this suite never depends on
 *   how one box happens to be wired. A suite that installed to the real ~/bin
 *   to prove installing works would be a suite nobody could run twice.
 *
 *   Contract under test: docs/spec-46-install-wtft.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { trackSandbox, isolateTmpdir, mkSandbox } from "./lib/sandbox";

isolateTmpdir("46-install-wtft");

const RED = "\x1b[31m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RESET = "\x1b[0m";
let passed = 0, failed = 0, skipped = 0;
function check(ok: boolean, label: string, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n       ${detail}` : ""}`); failed++; }
}
function skip(label: string) { console.log(`  ${YELLOW}SKIP${RESET} ${label}`); skipped++; }

const REPO = path.resolve(import.meta.dirname, "..");
const INSTALLER = path.join(REPO, "bin", "install-wtft");

// install-wtft builds before it copies, so the PATH handed to it needs bun.
// NOT `path.dirname(process.execPath)`: under this runner that resolves to the
// npm package's internal `.../node_modules/bun/bin/bun.exe`, a directory that
// contains no `bun` command at all — every install-mode check then failed with
// status "build-failed" for a reason having nothing to do with the installer.
// The controlled PATH exists to pin which `wtft` wins, not to sandbox bun.
const BUN_DIR = (() => {
	try { return path.dirname(execSync("command -v bun", { encoding: "utf8" }).trim()); }
	catch { return ""; }
})();

// The installer builds before it copies, so the artifacts need not pre-exist —
// but every OTHER suite in this repo imports ../bin/wtft.mjs, and the runner is
// serial, so building here keeps this suite from being the one that leaves the
// tree half-built if it dies partway.
execSync("bun run build", { cwd: REPO, stdio: "pipe" });

/**
 * Run the installer with a PATH we control. Never inherits the real one.
 *
 * A FAILED SPAWN RETURNS -1, NOT 1. `execFileSync` on a file that does not
 * exist throws with `status === undefined`, so the obvious `e.status ?? 1`
 * makes "there is no installer" indistinguishable from "the installer reported
 * drift" — and the drift check below then PASSES on an empty repo. It did,
 * once, while this file was being written. -1 is outside the documented
 * exit-code table, so every check that names a real code fails honestly.
 */
function run(args: string[], pathDirs: string[] = []): { code: number; out: string; err: string } {
	try {
		const out = execFileSync(INSTALLER, args, {
			encoding: "utf8", stdio: "pipe",
			env: { ...process.env, PATH: [...pathDirs, BUN_DIR, "/usr/bin", "/bin"].join(":") },
		});
		return { code: 0, out, err: "" };
	} catch (e: any) {
		if (typeof e?.status !== "number") return { code: -1, out: e?.stdout ?? "", err: String(e?.message ?? e) };
		return { code: e.status, out: e.stdout ?? "", err: e.stderr ?? "" };
	}
}

// ---
// 1. --check on a host with nothing installed reports drift, and says so in a
//    document rather than a sentence. This is the mutation-proof for "the
//    installer notices absence at all": delete the missing-file branch and it
//    exits 0 on an empty directory.
// ---
console.log("\n1. --check --json on an empty dir reports drift, naming both artifacts");
{
	const dir = mkSandbox(path.join(os.tmpdir(), "46-empty-"));
	const { code, out } = run(["--check", "--json", "--dir", dir]);
	check(code === 1, "V1a: exit 1 (drift)", `got ${code}`);

	let doc: any = null;
	try { doc = JSON.parse(out); } catch { /* left null */ }
	check(doc !== null, "V1b: stdout is a single JSON document", out.slice(0, 200));
	check(doc?.schema === "install-wtft@1", "V1c: schema is install-wtft@1", JSON.stringify(doc?.schema));
	check(doc?.status === "drift", "V1d: status is drift", JSON.stringify(doc?.status));
	check(doc?.mode === "check", "V1e: mode is check", JSON.stringify(doc?.mode));

	const states = Object.fromEntries((doc?.artifacts ?? []).map((a: any) => [a.name, a.state]));
	check(states["wtft"] === "missing" && states["wtft-daemon.mjs"] === "missing",
		"V1f: both artifacts reported missing, keyed by their INSTALLED names",
		JSON.stringify(states));

	// --check writes nothing. A doctor mode that installs is not a doctor mode.
	check(fs.readdirSync(dir).length === 0, "V1g: --check wrote nothing", fs.readdirSync(dir).join(","));
}

// ---
// 2. Install into an empty directory, then re-check. The re-check is the point:
//    an installer that copies but whose --check cannot see its own work would
//    pass a "files exist" assertion and still be useless as a doctor.
// ---
console.log("\n2. Installing into an empty dir produces both artifacts, executable and byte-identical");
{
	const dir = mkSandbox(path.join(os.tmpdir(), "46-install-"));
	const { code, out } = run(["--json", "--dir", dir]);
	check(code === 0, "V2a: exit 0", `got ${code}: ${out.slice(0, 200)}`);

	let doc: any = null;
	try { doc = JSON.parse(out); } catch { /* left null */ }
	check(doc?.status === "ok" && doc?.mode === "install", "V2b: status ok in install mode", JSON.stringify(doc?.status));

	// wtft-daemon lands twice: under the name daemonDir joins, and under the
	// human-facing name package.json's bin map and the README both use.
	for (const [src, dst] of [["wtft.mjs", "wtft"], ["wtft-daemon.mjs", "wtft-daemon.mjs"], ["wtft-daemon.mjs", "wtft-daemon"]]) {
		const from = path.join(REPO, "bin", src), to = path.join(dir, dst);
		const exists = fs.existsSync(to);
		check(exists, `V2c: ${dst} exists`, to);
		if (!exists) continue;
		check(fs.readFileSync(from).equals(fs.readFileSync(to)), `V2d: ${dst} is byte-identical to bin/${src}`);
		check((fs.statSync(to).mode & 0o777) === 0o755, `V2e: ${dst} is 0755`,
			`0${(fs.statSync(to).mode & 0o777).toString(8)}`);
	}

	const re = run(["--check", "--json", "--dir", dir]);
	check(re.code === 0, "V2f: --check now exits 0", `got ${re.code}`);
}

// ---
// 3. The installed command actually RUNS, on stock node, from a directory that
//    is not the repo — and its daemon is beside it under the exact filename
//    bin/wtft.ts joins onto `daemonDir`. V2 proves the bytes arrived; only this
//    proves they are usable where they landed. #36 is what makes it possible:
//    before it, a copy of the artifact died with ERR_MODULE_NOT_FOUND.
// ---
console.log("\n3. The installed copy runs on stock node, with its daemon beside it");
{
	let NODE = "";
	try { NODE = execSync("command -v node", { encoding: "utf8" }).trim(); } catch { /* none */ }
	if (!NODE) {
		skip("##SKIP## no `node` on PATH — the stock-node arm did not run");
	} else {
		const dir = mkSandbox(path.join(os.tmpdir(), "46-run-"));
		const inst = run(["--dir", dir]);
		check(inst.code === 0, "V3a: install exits 0", `got ${inst.code}`);

		const version = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
		let out = "", code = 0;
		try { out = execFileSync(NODE, [path.join(dir, "wtft"), "--version"], { encoding: "utf8", stdio: "pipe" }); }
		catch (e: any) { out = `${e.stdout ?? ""}${e.stderr ?? ""}`; code = e.status ?? 1; }
		check(code === 0 && out.includes(version),
			`V3b: node <dir>/wtft --version exits 0 and prints ${version}`,
			`exit ${code}: ${out.trim().slice(0, 200)}`);

		// The name, not just the presence. bin/wtft.ts joins the literal string
		// "wtft-daemon.mjs" onto dirname(import.meta.url) at four call sites, so
		// installing the daemon as `wtft-daemon` would leave --watch unable to
		// find it while --version and --help kept working.
		check(fs.existsSync(path.join(dir, "wtft-daemon.mjs")),
			"V3c: the daemon sits beside it as wtft-daemon.mjs, the name daemonDir joins",
			fs.readdirSync(dir).join(","));
	}
}

// ---
// 4. The shadow check. ~/.bun/bin precedes ~/bin on the host this was written
//    for — four times over — so installing into ~/bin while a `bun link`
//    exposes another wtft is a SUCCESSFUL INSTALL THAT CHANGES NOTHING. An
//    installer that exits 0 there is lying, which is how #46 went unnoticed
//    long enough for the same feature to be built twice.
//
//    Mutation-proof: delete the shadow branch and this exits 0 with the decoy
//    still winning.
// ---
console.log("\n4. A different wtft earlier on PATH is reported, not deleted");
{
	const dir = mkSandbox(path.join(os.tmpdir(), "46-shadowed-"));
	const decoyDir = mkSandbox(path.join(os.tmpdir(), "46-decoy-"));
	const decoy = path.join(decoyDir, "wtft");
	fs.writeFileSync(decoy, "#!/bin/sh\necho decoy\n");
	fs.chmodSync(decoy, 0o755);

	const { code, out } = run(["--json", "--dir", dir], [decoyDir]);
	check(code === 2, "V4a: exit 2 (shadowed), not 0", `got ${code}`);

	let doc: any = null;
	try { doc = JSON.parse(out); } catch { /* left null */ }
	check(doc?.status === "shadowed", "V4b: status is shadowed", JSON.stringify(doc?.status));
	check(doc?.shadow?.found === decoy, "V4c: shadow.found names the decoy", JSON.stringify(doc?.shadow));
	check(typeof doc?.shadow?.remedy === "string" && doc.shadow.remedy.includes(decoy),
		"V4d: shadow.remedy is the exact rm", JSON.stringify(doc?.shadow?.remedy));

	// Report, never delete — the install-workflow-tools precedent for retired
	// hooks. Removing an executable another repo manages is the same class of
	// move as silently installing one, and a `bun link` would restore it anyway.
	check(fs.existsSync(decoy), "V4e: the decoy is still there — reported, not deleted");

	// The install itself still happened. A shadow is a PATH fact, not a reason
	// to leave the target directory half-written.
	check(fs.existsSync(path.join(dir, "wtft")) && fs.existsSync(path.join(dir, "wtft-daemon.mjs")),
		"V4f: both artifacts were still installed", fs.readdirSync(dir).join(","));

	// And when the installed copy IS the winner, that is not a shadow.
	const clean = run(["--check", "--json", "--dir", dir], [dir]);
	let cleanDoc: any = null;
	try { cleanDoc = JSON.parse(clean.out); } catch { /* left null */ }
	check(clean.code === 0 && cleanDoc?.shadow === null && cleanDoc?.onPath === true,
		"V4g: our own copy winning on PATH is exit 0, shadow null, onPath true",
		`exit ${clean.code}: ${clean.out.slice(0, 200)}`);
}

// ---
// 5. Staleness. V1 catches absence; only this catches the copy that is present,
//    executable, and WRONG — which is the state every rebuild produces until
//    the installer is re-run, and the whole reason a copy needs a doctor mode
//    that a symlink would not.
//
//    Mutation-proof: drop the `cmp` and this exits 0 on a modified file.
// ---
console.log("\n5. A rebuilt artifact makes the installed copy stale, and --check says so");
{
	const dir = mkSandbox(path.join(os.tmpdir(), "46-stale-"));
	check(run(["--dir", dir]).code === 0, "V5a: install exits 0");

	fs.appendFileSync(path.join(dir, "wtft"), "\n// drift\n");
	const { code, out } = run(["--check", "--json", "--dir", dir]);
	check(code === 1, "V5b: --check exits 1", `got ${code}`);

	let doc: any = null;
	try { doc = JSON.parse(out); } catch { /* left null */ }
	const states = Object.fromEntries((doc?.artifacts ?? []).map((a: any) => [a.name, a.state]));
	check(states["wtft"] === "stale", "V5c: the changed artifact is 'stale', not 'missing'", JSON.stringify(states));
	check(states["wtft-daemon.mjs"] === "ok", "V5d: the untouched artifact is still 'ok'", JSON.stringify(states));

	// Losing the executable bit is its own state: the file is right and the
	// command still does not run.
	const dir2 = mkSandbox(path.join(os.tmpdir(), "46-noexec-"));
	check(run(["--dir", dir2]).code === 0, "V5e: second install exits 0");
	fs.chmodSync(path.join(dir2, "wtft"), 0o644);
	const r2 = run(["--check", "--json", "--dir", dir2]);
	let d2: any = null;
	try { d2 = JSON.parse(r2.out); } catch { /* left null */ }
	const s2 = Object.fromEntries((d2?.artifacts ?? []).map((a: any) => [a.name, a.state]));
	check(r2.code === 1 && s2["wtft"] === "not-executable",
		"V5f: a de-executable'd copy is 'not-executable', exit 1", `exit ${r2.code}: ${JSON.stringify(s2)}`);
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed > 0 ? 1 : 0);

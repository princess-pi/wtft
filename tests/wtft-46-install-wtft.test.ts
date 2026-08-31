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
 *   PATH this file constructs. Nothing here writes to the real ~/bin, and no
 *   installer child inherits the real PATH — the --dir seam exists precisely so
 *   this suite never depends on how one box happens to be wired.
 *
 *   TWO READS DO GO TO THE REAL PATH, and saying so is the point: `command -v
 *   bun` and `command -v node` locate the interpreters the child needs. An
 *   earlier version of this paragraph claimed no test read the real PATH at
 *   all, which was false in exactly those two places. What the child SEES is
 *   still fully constructed: bun arrives through a one-entry shim directory,
 *   never its own, because bun lives in ~/bin here — install-wtft's default
 *   target.
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

// install-wtft builds before it copies, so the PATH handed to it needs bun — but
// handing it bun's OWN directory is a trap that arms itself the first time
// anybody uses this tool for real. On this host `bun` is `~/bin/bun`, and `~/bin`
// is install-wtft's DEFAULT TARGET: the moment a real run puts `~/bin/wtft`
// there, every child in this suite sees a foreign `wtft` first on PATH and seven
// checks start failing on a working installer.
//
// So the child gets a directory containing exactly one entry, a `bun` symlink,
// and nothing else can leak in. (Not `path.dirname(process.execPath)` either:
// under this runner that is the npm package's internal `bun.exe` directory,
// which holds no `bun` command at all.)
const BUN_DIR = (() => {
	let real = "";
	try { real = execSync("command -v bun", { encoding: "utf8" }).trim(); } catch { return ""; }
	const shim = mkSandbox(path.join(os.tmpdir(), "46-bunshim-"));
	fs.symlinkSync(real, path.join(shim, "bun"));
	return shim;
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
	check(["wtft.mjs", "wtft-daemon.mjs", "wtft", "wtft-daemon"].every(n => states[n] === "missing"),
		"V1f: all FOUR artifacts reported missing, keyed by their INSTALLED names",
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

	// Two payload copies…
	for (const name of ["wtft.mjs", "wtft-daemon.mjs"]) {
		const from = path.join(REPO, "bin", name), to = path.join(dir, name);
		const exists = fs.existsSync(to);
		check(exists, `V2c: ${name} exists`, to);
		if (!exists) continue;
		check(fs.readFileSync(from).equals(fs.readFileSync(to)), `V2d: ${name} is byte-identical to bin/${name}`);
		check((fs.lstatSync(to).mode & 0o777) === 0o755, `V2e: ${name} is 0755`,
			`0${(fs.lstatSync(to).mode & 0o777).toString(8)}`);
	}
	// …and two command names, symlinked BESIDE them with a RELATIVE target, so
	// the directory can be moved. The extension is what tells node the file is
	// ESM; see V3 for the failure this replaced.
	for (const [link, target] of [["wtft", "wtft.mjs"], ["wtft-daemon", "wtft-daemon.mjs"]]) {
		const at = path.join(dir, link);
		const isLink = fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink();
		check(isLink, `V2f: ${link} is a symlink, not a copy`, at);
		if (isLink) check(fs.readlinkSync(at) === target,
			`V2g: ${link} -> ${target}, relative`, fs.readlinkSync(at));
	}

	const re = run(["--check", "--json", "--dir", dir]);
	check(re.code === 0, "V2h: --check now exits 0", `got ${re.code}`);
}

// ---
// 3. The installed command RUNS WHEN YOU TYPE ITS NAME — the consumer path, and
//    the one no test in this repo had ever taken. Every other check runs
//    `node <file>`, which hands node an explicit entry point and lets it detect
//    the module type; typing the name goes through the shebang instead.
//
//    That gap hid a total failure. The command used to be an extensionless COPY
//    of the bundle, and node only guesses module type for an extensionless file
//    from 20.10 (flagged) and 22 (default). /usr/bin/node here is 18.19.1 —
//    exactly the floor package.json's `engines: >=18` promises — where it dies
//    on the first `import`. Measured before the fix: exit 1 on 18, 20 AND 22.
//    Hence the symlink-to-.mjs layout V2 asserts.
//
//    A second defect hid behind it: bun copies the ENTRYPOINT's shebang through
//    verbatim, so the plain-JS bundle carried
//    `#!/usr/bin/env -S node --experimental-strip-types`, which node 18 and 20
//    reject outright with `bad option`. build.ts rewrites it now.
// ---
console.log("\n3. The installed command runs when you type its name, on every node we can find");
{
	// Every node this host's CONVENTIONAL locations hold — `command -v node`,
	// /usr/bin, /usr/local/bin, and nvm's version tree. Not "every node": fnm,
	// volta, asdf and homebrew layouts are invisible to it, and naming the
	// search rather than claiming completeness is the honest version. The sweep
	// matters because the failure is version-dependent: an earlier block took
	// `command -v node` plus /usr/bin/node and therefore skipped node 20.
	const nodes: string[] = [];
	const add = (p: string) => { if (p && fs.existsSync(p) && !nodes.includes(p)) nodes.push(p); };
	try { add(execSync("command -v node", { encoding: "utf8" }).trim()); } catch { /* none */ }
	add("/usr/bin/node");
	add("/usr/local/bin/node");
	const nvm = path.join(os.homedir(), ".nvm", "versions", "node");
	if (fs.existsSync(nvm)) for (const v of fs.readdirSync(nvm)) add(path.join(nvm, v, "bin", "node"));

	if (nodes.length === 0) {
		skip("##SKIP## no `node` on PATH — the stock-node arm did not run");
	} else {
		const dir = mkSandbox(path.join(os.tmpdir(), "46-run-"));
		const inst = run(["--dir", dir]);
		check(inst.code === 0, "V3a: install exits 0", `got ${inst.code}`);

		const version = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
		for (const nodeBin of nodes) {
			let nv = "?";
			try { nv = execFileSync(nodeBin, ["--version"], { encoding: "utf8" }).trim(); } catch { /* keep ? */ }
			let out = "", code = 0;
			try {
				// By NAME, through the shebang — no interpreter on the command
				// line. `PATH` is pinned so `env node` finds this exact one.
				// A private HOME as well as a pinned PATH: bin/wtft.ts reads user
				// pricing and external harnesses before the display-flag exits,
				// so an inherited HOME would let this box's config decide the
				// outcome — and `import()` code it names.
				const fakeHome = mkSandbox(path.join(os.tmpdir(), "46-home-"));
				out = execFileSync(path.join(dir, "wtft"), ["--version"], {
					encoding: "utf8", stdio: "pipe",
					env: {
						...process.env,
						PATH: [path.dirname(nodeBin), "/usr/bin", "/bin"].join(":"),
						HOME: fakeHome,
						XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
					},
				});
			} catch (e: any) { out = `${e.stdout ?? ""}${e.stderr ?? ""}`; code = e.status ?? 1; }
			check(code === 0 && out.includes(version),
				`V3b: <dir>/wtft --version, via its own shebang, on node ${nv}`,
				`exit ${code}: ${out.trim().slice(0, 200)}`);
		}

		// The name, not just the presence. bin/wtft.ts joins the literal string
		// "wtft-daemon.mjs" onto dirname(import.meta.url) — four sites there and
		// a fifth in wtft-cli-shared.ts's spawnWtftDaemon. Node resolves the
		// `wtft` symlink to its .mjs realpath, which is in this same directory,
		// so daemonDir lands here either way.
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

	// The PAYLOAD, not the command name — `<dir>/wtft` is a symlink, so writing
	// through it lands on wtft.mjs, which is exactly where the drift belongs.
	fs.appendFileSync(path.join(dir, "wtft.mjs"), "\n// drift\n");
	const { code, out } = run(["--check", "--json", "--dir", dir]);
	check(code === 1, "V5b: --check exits 1", `got ${code}`);

	let doc: any = null;
	try { doc = JSON.parse(out); } catch { /* left null */ }
	const states = Object.fromEntries((doc?.artifacts ?? []).map((a: any) => [a.name, a.state]));
	check(states["wtft.mjs"] === "stale", "V5c: the changed payload is 'stale', not 'missing'", JSON.stringify(states));
	check(states["wtft-daemon.mjs"] === "ok", "V5d: the untouched payload is still 'ok'", JSON.stringify(states));

	// A link is its own failure mode: present, executable through its target,
	// and pointing somewhere else entirely.
	const linkDirty = mkSandbox(path.join(os.tmpdir(), "46-badlink-"));
	run(["--dir", linkDirty]);
	fs.unlinkSync(path.join(linkDirty, "wtft"));
	fs.symlinkSync("wtft-daemon.mjs", path.join(linkDirty, "wtft"));
	const bad = run(["--check", "--json", "--dir", linkDirty]);
	let badDoc: any = null;
	try { badDoc = JSON.parse(bad.out); } catch { /* left null */ }
	const badStates = Object.fromEntries((badDoc?.artifacts ?? []).map((a: any) => [a.name, a.state]));
	check(bad.code === 1 && badStates["wtft"] === "wrong-target",
		"V5g: a command symlink pointing at the wrong payload is 'wrong-target'",
		`exit ${bad.code}: ${JSON.stringify(badStates)}`);

	// Losing the executable bit is its own state: the file is right and the
	// command still does not run.
	const dir2 = mkSandbox(path.join(os.tmpdir(), "46-noexec-"));
	check(run(["--dir", dir2]).code === 0, "V5e: second install exits 0");
	fs.chmodSync(path.join(dir2, "wtft.mjs"), 0o644);
	const r2 = run(["--check", "--json", "--dir", dir2]);
	let d2: any = null;
	try { d2 = JSON.parse(r2.out); } catch { /* left null */ }
	const s2 = Object.fromEntries((d2?.artifacts ?? []).map((a: any) => [a.name, a.state]));
	check(r2.code === 1 && s2["wtft.mjs"] === "not-executable",
		"V5f: a de-executable'd payload is 'not-executable', exit 1", `exit ${r2.code}: ${JSON.stringify(s2)}`);
}

// ---
// 6. The defects a fresh-context reconcile audit found that sections 1-5 did
//    not. Every one of them passed section 1-5 unchanged, which is the whole
//    argument for auditing prose against code rather than trusting a green
//    suite: these are not regressions, they are things nothing ever asserted.
//
//    Each check below was run against the PREVIOUS commit's script as well as
//    this one; the before/after is recorded in docs/spec-46-install-wtft.md.
// ---
console.log("\n6. Defects found by the reconcile audit");
{
	// S1 — the doctor had a write side effect. `mkdir -p` ran during argument
	// handling, before the mode branch, so --check CREATED its target. Three
	// separate places claimed "writes nothing".
	const ghostRoot = mkSandbox(path.join(os.tmpdir(), "46-ghost-"));
	const ghost = path.join(ghostRoot, "not-yet", "deeper");
	run(["--check", "--json", "--dir", ghost]);
	check(!fs.existsSync(ghost), "V6a: --check does not create a missing --dir", `created ${ghost}`);

	// S16 — the human drift report named no artifact at all: STATE_JSON was
	// piped through `tr ',' '\n'`, which splits each record across three lines,
	// so name and state never shared one and the sed matched nothing.
	const empty = mkSandbox(path.join(os.tmpdir(), "46-humandrift-"));
	const human = run(["--check", "--dir", empty]);
	const said = `${human.out}${human.err}`;
	check(/wtft:\s*missing/.test(said) && /wtft-daemon\.mjs:\s*missing/.test(said),
		"V6b: human drift output names each artifact and its state", said.slice(0, 300));

	// S20 — exit 2 is reachable under --check, where "installed into" is a lie.
	const synced = mkSandbox(path.join(os.tmpdir(), "46-synced-"));
	const decoyDir2 = mkSandbox(path.join(os.tmpdir(), "46-decoy2-"));
	fs.writeFileSync(path.join(decoyDir2, "wtft"), "#!/bin/sh\n"); fs.chmodSync(path.join(decoyDir2, "wtft"), 0o755);
	run(["--dir", synced]);
	const chk = run(["--check", "--dir", synced], [decoyDir2]);
	const chkSaid = `${chk.out}${chk.err}`;
	check(chk.code === 2 && !/installed into/.test(chkSaid),
		"V6c: --check reporting a shadow does not claim it installed anything",
		`exit ${chk.code}: ${chkSaid.slice(0, 200)}`);

	// S19 — a symlink pointing at our own copy runs our own bytes, but the
	// comparison resolved only the parent directory, so it was reported as a
	// foreign wtft with a remedy that would delete a working command.
	const linkDir = mkSandbox(path.join(os.tmpdir(), "46-link-"));
	fs.symlinkSync(path.join(synced, "wtft"), path.join(linkDir, "wtft"));
	const viaLink = run(["--check", "--json", "--dir", synced], [linkDir]);
	let linkDoc: any = null;
	try { linkDoc = JSON.parse(viaLink.out); } catch { /* left null */ }
	check(viaLink.code === 0 && linkDoc?.shadow === null && linkDoc?.onPath === true,
		"V6d: a symlink to our own copy is not a shadow",
		`exit ${viaLink.code}: ${viaLink.out.slice(0, 200)}`);

	// S28 — `--dir --json` installed into a directory literally named "--json"
	// and still exited 0.
	const flagAsDir = run(["--dir", "--json"]);
	check(flagAsDir.code === 64, "V6e: --dir followed by a flag is bad usage, not a directory name",
		`got ${flagAsDir.code}`);

	// S4 — an unset HOME aborted with bash's own "unbound variable" and no
	// document, on a script whose whole point is a machine-readable surface.
	let noHome = { code: -1, out: "", err: "" };
	try {
		execFileSync(INSTALLER, ["--check", "--json"], {
			encoding: "utf8", stdio: "pipe",
			env: { PATH: [BUN_DIR, "/usr/bin", "/bin"].join(":") },   // no HOME
		});
		noHome = { code: 0, out: "", err: "" };
	} catch (e: any) { noHome = { code: e?.status ?? -1, out: e?.stdout ?? "", err: e?.stderr ?? "" }; }
	check(noHome.code === 64 && /HOME is unset/.test(noHome.err),
		"V6f: unset HOME is bad usage with a named remedy, not an unbound-variable trace",
		`exit ${noHome.code}: ${noHome.err.slice(0, 200)}`);

	// S3 — three paths exited without emitting the document --json promises.
	const badDir = run(["--json", "--dir", "/dev/null/nope"]);
	let badDoc: any = null;
	try { badDoc = JSON.parse(badDir.out); } catch { /* left null */ }
	check(badDir.code === 1 && badDoc?.status === "no-dir",
		"V6g: an un-creatable --dir still emits a document under --json",
		`exit ${badDir.code}: ${badDir.out.slice(0, 200)}${badDir.err.slice(0, 120)}`);

	// S18 — the remedy interpolated the winner unquoted, so a path with a space
	// produced an `rm` that does not run.
	const spaceDir = mkSandbox(path.join(os.tmpdir(), "46-with space-"));
	fs.writeFileSync(path.join(spaceDir, "wtft"), "#!/bin/sh\n"); fs.chmodSync(path.join(spaceDir, "wtft"), 0o755);
	const spaced = run(["--check", "--json", "--dir", synced], [spaceDir]);
	let spacedDoc: any = null;
	try { spacedDoc = JSON.parse(spaced.out); } catch { /* left null */ }
	check(typeof spacedDoc?.shadow?.remedy === "string" && spacedDoc.shadow.remedy.includes(`'${spaceDir}/wtft'`),
		"V6h: the JSON remedy quotes a winner path containing a space",
		JSON.stringify(spacedDoc?.shadow?.remedy));

	// The PRINTED line too, which is what a human actually copies — and which
	// stayed broken through the first fix because only the JSON field was
	// checked. It emitted rm '"<path>"', double quotes inside the single ones,
	// so the command failed on the very path it named.
	const spacedHuman = run(["--check", "--dir", synced], [spaceDir]);
	const printed = `${spacedHuman.out}${spacedHuman.err}`;
	check(printed.includes(`rm '${spaceDir}/wtft'`) && !printed.includes(`rm '"`),
		"V6j: the PRINTED rm is single-quoted, with no stray double quotes",
		printed.split("\n").filter(l => l.includes("rm ")).join(" | ").slice(0, 200));

	// S17 — onPath was in the document and in no human line, so a green run hid
	// a command nobody can type.
	const offPath = run(["--dir", mkSandbox(path.join(os.tmpdir(), "46-offpath-"))]);
	check(offPath.code === 0 && /add .* to PATH/.test(`${offPath.out}${offPath.err}`),
		"V6i: a successful install into a dir that is not on PATH says so",
		`${offPath.out}${offPath.err}`.slice(0, 200));
}

// ---
// 7. The mutation probe runs. `docs/spec-46-install-wtft.md` says "run it; do
//    not trust the table" — but tests/run.ts collects only tests/*.test.ts, so
//    nothing ever did, leaving three results a reader had to re-derive by hand.
//    That is the state committing the script was supposed to end.
// ---
console.log("\n7. The mutation probe runs, and can fail");
{
	const probe = path.join(REPO, "research", "46-install-mutants", "run-mutants.sh");
	let out = "", code = 0;
	try { out = execFileSync(probe, [], { encoding: "utf8", stdio: "pipe" }); }
	catch (e: any) { out = `${e.stdout ?? ""}${e.stderr ?? ""}`; code = e.status ?? 1; }
	check(code === 0, "V7a: run-mutants.sh exits 0 — every mutant reported ok where the real script reported a fault",
		`exit ${code}: ${out.trim().slice(0, 400)}`);
	check(/M1 .*OK/.test(out) && /M2 .*OK/.test(out) && /M3 .*OK/.test(out),
		"V7b: all three mutations applied and were caught", out.trim().slice(0, 300));
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed > 0 ? 1 : 0);

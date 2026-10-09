#!/usr/bin/env bun
/**
 * `bin/install-wtft` and the host around it: the `claude` PATH guard, log parser daemons on
 * an older build, and a stale build (#46).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { mkSandbox } from "./lib/sandbox";
import { standInDaemonArgs, awaitStandIn } from "./lib/stand-in-daemon.ts";
import { getDaemonPidPath } from "../extensions/lib/wtft-daemon-lib.ts";
import { check, skip, REPO, INSTALLER, BUN_DIR, run, finish } from "./lib/install-wtft-suite.ts";

console.log("\n10. The claude-nsp-guard shim: ok, shadowed (exit 5), absent, mid-line non-match, precedence");
{
	const SENTINEL = "# nsp-guard-identity: 9a1c-claude-nsp-guard-sentinel";

	function writeGuard(dir: string): string {
		const p = path.join(dir, "claude");
		fs.writeFileSync(p, `#!/bin/sh\n# not the sentinel\n${SENTINEL}\necho guard\n`);
		fs.chmodSync(p, 0o755);
		return p;
	}
	function writeDecoyClaude(dir: string): string {
		const p = path.join(dir, "claude");
		fs.writeFileSync(p, "#!/bin/sh\necho decoy-claude\n");
		fs.chmodSync(p, 0o755);
		return p;
	}

	// V10a — the guard first on PATH: ok, found === guard.
	{
		const guardDir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-ok-"));
		const guard = writeGuard(guardDir);
		const dir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-ok-dir-"));
		const { code, out } = run(["--json", "--dir", dir], [guardDir]);
		let doc: any = null;
		try { doc = JSON.parse(out); } catch { /* left null */ }
		check(code === 0, "V10a: guard first on PATH exits 0", `got ${code}`);
		check(doc?.nspGuard?.state === "ok", "V10a: nspGuard.state is ok", JSON.stringify(doc?.nspGuard));
		check(doc?.nspGuard?.found === guard && doc?.nspGuard?.guard === guard,
			"V10a: found and guard both name the guard", JSON.stringify(doc?.nspGuard));
	}

	// V10b — a decoy claude earlier than the guard: exit 5, both paths named,
	// neither file touched.
	{
		const decoyDir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-shadow-decoy-"));
		const guardDir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-shadow-guard-"));
		const decoy = writeDecoyClaude(decoyDir);
		const guard = writeGuard(guardDir);
		const dir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-shadow-dir-"));
		const { code, out } = run(["--json", "--dir", dir], [decoyDir, guardDir]);
		let doc: any = null;
		try { doc = JSON.parse(out); } catch { /* left null */ }
		check(code === 5, "V10b: a shadowed guard exits 5", `got ${code}`);
		check(doc?.status === "nsp-guard-shadowed", "V10b: status is nsp-guard-shadowed", JSON.stringify(doc?.status));
		check(doc?.nspGuard?.state === "shadowed", "V10b: nspGuard.state is shadowed", JSON.stringify(doc?.nspGuard));
		check(doc?.nspGuard?.found === decoy, "V10b: found names the decoy", JSON.stringify(doc?.nspGuard));
		check(doc?.nspGuard?.guard === guard, "V10b: guard names the guard", JSON.stringify(doc?.nspGuard));
		check(fs.existsSync(decoy) && fs.existsSync(guard), "V10b: both files still exist — reported, never deleted");
	}

	// V10c — no claude anywhere on PATH. run() always appends /usr/bin and
	// /bin, so the precondition (neither holds a claude) must be asserted
	// first, not assumed.
	{
		if (fs.existsSync("/usr/bin/claude") || fs.existsSync("/bin/claude")) {
			skip("V10c: skipped — /usr/bin or /bin has a claude on this host, so 'no claude anywhere' cannot be reproduced");
		} else {
			const dir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-absent-dir-"));
			const { code, out } = run(["--json", "--dir", dir], []);
			let doc: any = null;
			try { doc = JSON.parse(out); } catch { /* left null */ }
			check(code === 0, "V10c: no claude anywhere exits 0", `got ${code}`);
			check(doc?.nspGuard?.state === "absent", "V10c: nspGuard.state is absent", JSON.stringify(doc?.nspGuard));
			check(doc?.nspGuard?.found === null, "V10c: found is null", JSON.stringify(doc?.nspGuard));
			check(doc?.nspGuard?.guard === null, "V10c: guard is null", JSON.stringify(doc?.nspGuard));
		}
	}

	// V10d — the sentinel text appearing mid-line (inside an echo) is not a
	// whole-line match, so this file is not the guard.
	{
		const fakeDir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-midline-"));
		const fake = path.join(fakeDir, "claude");
		fs.writeFileSync(fake, `#!/bin/sh\necho "${SENTINEL}"\n`);
		fs.chmodSync(fake, 0o755);
		const dir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-midline-dir-"));
		const { code, out } = run(["--json", "--dir", dir], [fakeDir]);
		let doc: any = null;
		try { doc = JSON.parse(out); } catch { /* left null */ }
		check(code === 0, "V10d: a mid-line mention alone exits 0", `got ${code}`);
		check(doc?.nspGuard?.state === "absent", "V10d: a mid-line mention is not a guard — state is absent",
			JSON.stringify(doc?.nspGuard));
		check(doc?.nspGuard?.found === fake, "V10d: found still names the file (it IS a claude, just not the guard)",
			JSON.stringify(doc?.nspGuard));
		check(doc?.nspGuard?.guard === null, "V10d: guard is null", JSON.stringify(doc?.nspGuard));
	}

	// V10e — precedence: a wtft PATH shadow (exit 2) outranks a shadowed nsp
	// guard. The exit code stays 2, but nspGuard still reports its own state
	// in the document — the escalation is suppressed, not the measurement.
	{
		const wtftDecoyDir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-prec-wtftdecoy-"));
		fs.writeFileSync(path.join(wtftDecoyDir, "wtft"), "#!/bin/sh\necho decoy\n");
		fs.chmodSync(path.join(wtftDecoyDir, "wtft"), 0o755);
		const claudeDecoyDir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-prec-claudedecoy-"));
		const guardDir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-prec-guard-"));
		const claudeDecoy = writeDecoyClaude(claudeDecoyDir);
		const guard = writeGuard(guardDir);
		const dir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-prec-dir-"));
		const { code, out } = run(["--json", "--dir", dir], [wtftDecoyDir, claudeDecoyDir, guardDir]);
		let doc: any = null;
		try { doc = JSON.parse(out); } catch { /* left null */ }
		check(code === 2, "V10e: the wtft PATH shadow wins the exit code, not the guard", `got ${code}`);
		check(doc?.status === "shadowed", "V10e: status is the wtft shadow, not nsp-guard-shadowed",
			JSON.stringify(doc?.status));
		check(doc?.nspGuard?.state === "shadowed", "V10e: nspGuard.state is STILL shadowed in the document",
			JSON.stringify(doc?.nspGuard));
		check(doc?.nspGuard?.found === claudeDecoy && doc?.nspGuard?.guard === guard,
			"V10e: nspGuard still names both paths", JSON.stringify(doc?.nspGuard));

		// Outranked is not silent: human mode adds an "Also:" line naming both.
		const human = run(["--dir", dir], [wtftDecoyDir, claudeDecoyDir, guardDir]);
		check(human.code === 2 && /Also: PATH resolves claude to /.test(human.err)
			&& human.err.includes(claudeDecoy) && human.err.includes(guard),
			"V10e: an outranked shadowed guard still gets an Also: line naming both paths",
			`exit ${human.code}: ${human.err.slice(0, 400)}`);
	}

	// V10f — human mode names both paths on stderr, with no --json.
	{
		const decoyDir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-human-decoy-"));
		const guardDir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-human-guard-"));
		const decoy = writeDecoyClaude(decoyDir);
		const guard = writeGuard(guardDir);
		const dir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-human-dir-"));
		const { code, err } = run(["--dir", dir], [decoyDir, guardDir]);
		check(code === 5, "V10f: human mode also exits 5", `got ${code}`);
		check(err.includes(decoy) && err.includes(guard),
			"V10f: the remedy on stderr names both the winner and the guard",
			err.slice(0, 400));
	}

	// V10g — the sentinel early in a guard whose first 160 lines are bigger
	// than a pipe buffer is still found: an early grep exit must not read as
	// no match.
	{
		const guardDir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-big-"));
		const guard = path.join(guardDir, "claude");
		const filler = Array.from({ length: 158 }, (_, n) => `# ${String(n).padEnd(2000, "x")}`).join("\n");
		fs.writeFileSync(guard, `#!/bin/sh\n${SENTINEL}\n${filler}\necho guard\n`);
		fs.chmodSync(guard, 0o755);
		check(fs.statSync(guard).size > 256 * 1024, "V10g: fixture precondition: the file is past a pipe buffer");
		const dir = mkSandbox(path.join(os.tmpdir(), "46-nspguard-big-dir-"));
		const { out } = run(["--check", "--json", "--dir", dir], [guardDir]);
		let doc: any = null;
		try { doc = JSON.parse(out); } catch { /* left null */ }
		check(doc?.nspGuard?.state === "ok" && doc?.nspGuard?.guard === guard,
			"V10g: a large guard with an early sentinel is still recognised", JSON.stringify(doc?.nspGuard));
	}
}

// ---
// 11. A daemon running an older build (one started no later than its bundle
//     last changed) is stopped and, per session, restarted. The
//     bundle is touched between the daemon's start and the install, which is
//     what a changed build does to it.
// ---
console.log("\n11. install-wtft restarts a daemon on an older build, and only then");
const binReal = fs.realpathSync(path.join(REPO, "bin"));
const olderOnCloneBin = (): string[] => {
	if (!fs.existsSync("/proc/self/stat")) return [];
	const btime = Number(/^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1]);
	const hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
	return fs.readdirSync("/proc").filter(p => /^\d+$/.test(p)).filter(p => {
		try {
			const cwd = fs.readlinkSync(`/proc/${p}/cwd`);
			const argv = fs.readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").filter(Boolean);
			const runtime = ["node", "nodejs", "bun", "bun.exe"].includes(path.basename(argv[0] ?? ""));
			const named = runtime ? argv.slice(1).find(a => !a.startsWith("-")) : argv[0];
			if (!named || !path.basename(named).startsWith("wtft-daemon")) return false;
			const script = path.resolve(cwd, named);
			if (fs.realpathSync(path.dirname(script)) !== binReal) return false;
			const ticks = Number(fs.readFileSync(`/proc/${p}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[19]);
			return btime + Math.floor(ticks / hz) <= Math.floor(fs.statSync(script).mtimeMs / 1000);
		} catch { return false; }
	});
};
const othersOnCloneBin = olderOnCloneBin();
if (!fs.existsSync("/proc/self/stat")) {
	console.log("  ##SKIP## no /proc on this host");
} else if (othersOnCloneBin.length > 0) {
	console.log(`  ##SKIP## V11: pids ${othersOnCloneBin.join(",")} on this host run a wtft-daemon from ${binReal} on an older build, which install-wtft counts too`);
} else {
	const dir = mkSandbox(path.join(os.tmpdir(), "46-restart-"));
	const bundle = path.join(dir, "wtft-daemon.mjs");
	// install runs the installed wtft-daemon, whose shebang needs node on PATH;
	// the PATH run() builds holds only bun and /usr/bin, where CI has no node.
	const nodeDir = mkSandbox(path.join(os.tmpdir(), "46-nodeshim-"));
	fs.symlinkSync(execSync("command -v node", { encoding: "utf8" }).trim(), path.join(nodeDir, "node"));
	const first = run(["--json", "--dir", dir], [nodeDir]);
	check(first.code === 0 && fs.existsSync(bundle), "V11 precondition: installed", `got ${first.code}`);
	const docOf = (out: string) => { try { return JSON.parse(out); } catch { return null; } };
	const pause = (s: number) => execSync(`sleep ${s}`);
	// A stopped child of this process stays a zombie until reaped, which kill 0 reads as alive.
	const alive = (pid: number) => { try { return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z"; } catch { return false; } };

	const mtime = fs.statSync(bundle).mtimeMs;
	const again = run(["--json", "--dir", dir], [nodeDir]);
	check(fs.statSync(bundle).mtimeMs === mtime, "V11a: an identical bundle is not rewritten, so its mtime still dates the build");
	check(docOf(again.out)?.daemons?.older === 0 && docOf(again.out)?.daemons?.restart === "none",
		"V11b: with no daemon on an older build, nothing restarts", JSON.stringify(docOf(again.out)?.daemons));

	const session = path.join(mkSandbox(path.join(os.tmpdir(), "46-restart-session-")), "s.jsonl");
	fs.writeFileSync(session, "");
	const daemon = spawn(process.execPath, [bundle, "--session", session], { stdio: "ignore", env: process.env });
	// Not a lease holder, so --restart cannot reach it: the failure path. It must
	// outlive four builds on a slow runner; the finally kills it.
	const bystander = spawn("bash", ["-c", 'exec -a "$0" sleep 600', bundle], { stdio: "ignore" });
	// A daemon from neither bin/ nor --dir, leased in the same TMPDIR: install-wtft does not count it.
	const unrelatedSession = path.join(mkSandbox(path.join(os.tmpdir(), "46-restart-unrelated-")), "u.jsonl");
	fs.writeFileSync(unrelatedSession, "");
	const unrelated = spawn(process.execPath, [standInDaemonArgs("setInterval(() => {}, 1000);")[0], "--session", unrelatedSession], { stdio: "ignore" });
	const unrelatedLease = getDaemonPidPath(unrelatedSession);
	const respawned: number[] = [];
	try {
		check(awaitStandIn(unrelated.pid!), "V11 precondition: the unrelated stand-in reads as a daemon");
		fs.writeFileSync(unrelatedLease, String(unrelated.pid));
		pause(1.1);
		const now = new Date();
		fs.utimesSync(bundle, now, now);
		// Past install-wtft's 2 s start-time error, so the daemon --restart spawns is newer.
		pause(2.1);
		const { code, out } = run(["--json", "--dir", dir], [nodeDir]);
		const doc = docOf(out);
		check(code === 0 && doc?.daemons?.older === 2, "V11c: both processes on the older build are counted", JSON.stringify(doc?.daemons));
		check(!alive(daemon.pid!), "V11d: the lease-holding daemon was stopped");
		const lease = path.join(process.env.TMPDIR!, fs.readdirSync(process.env.TMPDIR!).find(f => f.startsWith("wtft-daemon-") && f.endsWith(".pid") && f !== path.basename(unrelatedLease)) ?? "none");
		const leaseHolder = () => Number(fs.existsSync(lease) ? fs.readFileSync(lease, "utf8").trim() : 0);
		const holder = leaseHolder();
		if (holder > 0) respawned.push(holder);
		check(holder > 0 && holder !== daemon.pid && alive(holder), "V11e: a new daemon was started for its session", `lease=${lease} holder=${holder}`);
		check(doc?.daemons?.restart === "failed" && doc?.daemons?.left === 1,
			"V11f: the one --restart could not reach is still counted, and the restart reads failed", JSON.stringify(doc?.daemons));
		check(alive(unrelated.pid!) && fs.readFileSync(unrelatedLease, "utf8").trim() === String(unrelated.pid),
			"V11h: a daemon install-wtft did not count keeps its pid and its lease");
		// run() drops stderr on exit 0, and the failure line is on stderr.
		const human = spawnSync(INSTALLER, ["--dir", dir], { encoding: "utf8", env: { ...process.env, HOME: mkSandbox(path.join(os.tmpdir(), "46-restart-home-")), PATH: [nodeDir, BUN_DIR, "/usr/bin", "/bin"].join(":") } });
		if (leaseHolder() > 0) respawned.push(leaseHolder());
		check(/1 of 1 log parser daemon\(s\) on an older build still run after wtft-daemon --restart/.test(human.stderr),
			"V11g: the human report names what is left", `stderr: ${human.stderr.slice(0, 600)}`);
	} finally {
		daemon.kill("SIGKILL");
		bystander.kill("SIGKILL");
		unrelated.kill("SIGKILL");
		for (const pid of respawned) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
	}
}

console.log("\n12. --check reports a stale build: a source changed after the clone's last build");
{
	const clone = mkSandbox(path.join(os.tmpdir(), "46-stale-build-"));
	const sources = ["bin/wtft.ts", "bin/wtft-daemon.ts", "extensions/lib/harness/x.ts", "docs/manifests/wtft-cmd.json", "build.ts", "package.json", "bun.lock"];
	for (const dir of ["bin", "extensions/lib/harness", "docs/manifests", "tmp"]) fs.mkdirSync(path.join(clone, dir), { recursive: true });
	const installer = path.join(clone, "bin", "install-wtft");
	fs.copyFileSync(INSTALLER, installer);
	fs.chmodSync(installer, 0o755);
	const dest = mkSandbox(path.join(os.tmpdir(), "46-stale-build-dest-"));
	for (const name of ["wtft.mjs", "wtft-daemon.mjs"]) {
		fs.copyFileSync(path.join(REPO, "bin", name), path.join(clone, "bin", name));
		fs.copyFileSync(path.join(REPO, "bin", name), path.join(dest, name));
		fs.chmodSync(path.join(dest, name), 0o755);
		fs.symlinkSync(name, path.join(dest, name.replace(/\.mjs$/, "")));
	}
	const stamp = path.join(clone, "tmp", "last-build");
	const now = Date.now() / 1000;
	for (const f of sources) { fs.writeFileSync(path.join(clone, f), f === "package.json" ? JSON.stringify({ scripts: { build: "true" } }) : ""); fs.utimesSync(path.join(clone, f), now - 100, now - 100); }
	fs.writeFileSync(path.join(clone, "extensions/lib/harness/gone.ts"), "");
	for (const d of ["extensions/lib/harness/gone.ts", "extensions/lib/harness", "extensions/lib"]) fs.utimesSync(path.join(clone, d), now - 100, now - 100);
	fs.writeFileSync(stamp, "");
	fs.utimesSync(stamp, now - 50, now - 50);
	const checkJson = () => {
		const r = run(["--check", "--json", "--dir", dest], [], {}, installer);
		let doc: any = null;
		try { doc = JSON.parse(r.out); } catch { /* asserted below */ }
		return { ...r, doc };
	};

	const fresh = checkJson();
	check(fresh.code === 0 && fresh.doc?.status === "ok" && fresh.doc?.build === "current",
		"V12a: with every source older than tmp/last-build, --check exits 0, status ok, build current",
		`exit ${fresh.code}: ${fresh.out.slice(0, 300)} ${fresh.err.slice(0, 300)}`);

	for (const f of sources) {
		fs.utimesSync(path.join(clone, f), now, now);
		const r = checkJson();
		const human = run(["--check", "--dir", dest], [], {}, installer);
		check(r.code === 1 && r.doc?.status === "stale-build" && r.doc?.build === "stale"
			&& r.doc?.artifacts?.length === 4 && r.doc.artifacts.every((a: any) => a.state === "ok")
			&& human.code === 1 && human.err.includes(path.join(clone, f)),
			`V12b: ${f} newer than tmp/last-build -> exit 1, status stale-build, build stale, all four artifacts ok, stderr names it`,
			`exit ${r.code}: ${r.out.slice(0, 300)} | human ${human.code}: ${human.err.slice(0, 300)}`);
		fs.utimesSync(path.join(clone, f), now - 100, now - 100);
	}

	fs.unlinkSync(path.join(clone, "extensions/lib/harness/gone.ts"));
	const deleted = checkJson();
	const deletedHuman = run(["--check", "--dir", dest], [], {}, installer);
	check(deleted.code === 1 && deleted.doc?.status === "stale-build" && deleted.doc?.build === "stale"
		&& deletedHuman.err.includes(path.join(clone, "extensions/lib/harness")),
		"V12f: a source deleted after tmp/last-build -> exit 1, status stale-build, stderr names its directory",
		`exit ${deleted.code}: ${deleted.out.slice(0, 300)} | ${deletedHuman.err.slice(0, 300)}`);
	fs.utimesSync(path.join(clone, "extensions/lib/harness"), now - 100, now - 100);

	fs.utimesSync(path.join(clone, "bin", "wtft.ts"), now + 1000, now + 1000);
	const installRun = run(["--json", "--dir", dest], [], {}, installer);
	let installDoc: any = null;
	try { installDoc = JSON.parse(installRun.out); } catch { /* asserted below */ }
	check(installRun.code === 0 && installDoc?.mode === "install" && installDoc?.status === "ok" && installDoc?.build === "stale",
		"V12e: install mode with a source newer than tmp/last-build reports build stale in the document, with status ok, not stale-build",
		`exit ${installRun.code}: ${installRun.out.slice(0, 300)} ${installRun.err.slice(0, 300)}`);
	fs.utimesSync(path.join(clone, "bin", "wtft.ts"), now - 100, now - 100);

	fs.renameSync(stamp, `${stamp}.away`);
	const never = checkJson();
	check(never.code === 1 && never.doc?.status === "stale-build" && never.doc?.build === "stale",
		"V12c: no tmp/last-build -> exit 1, status stale-build", `exit ${never.code}: ${never.out.slice(0, 300)}`);

	fs.appendFileSync(path.join(dest, "wtft.mjs"), "\n// drift\n");
	const both = checkJson();
	check(both.code === 1 && both.doc?.status === "drift" && both.doc?.build === "stale",
		"V12d: drift alongside a stale build -> exit 1, status drift, build stale", `exit ${both.code}: ${both.out.slice(0, 300)}`);
}

finish();

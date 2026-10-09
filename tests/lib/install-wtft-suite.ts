/** Fixture helpers shared by the install-wtft suites. */


import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { isolateTmpdir, mkSandbox } from "./sandbox";

isolateTmpdir("46-install-wtft");

export const RED = "\x1b[31m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RESET = "\x1b[0m";
let passed = 0, failed = 0, skipped = 0;
export function check(ok: boolean, label: string, detail?: string) {
	if (ok) { console.log(`  ${GREEN}PASS${RESET} ${label}`); passed++; }
	else { console.log(`  ${RED}FAIL${RESET} ${label}${detail ? `\n       ${detail}` : ""}`); failed++; }
}
export function skip(label: string) { console.log(`  ${YELLOW}SKIP${RESET} ${label}`); skipped++; }

export const REPO = path.resolve(import.meta.dirname, "..", "..");
export const INSTALLER = path.join(REPO, "bin", "install-wtft");

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
export const BUN_DIR = (() => {
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
/**
 * A PRIVATE HOME/XDG_CONFIG_HOME, fresh per call, unless `env` overrides them.
 * #156 gave install-wtft a config-migration side effect — it now READS AND
 * MOVES files under XDG_CONFIG_HOME — so a caller that inherited the real
 * HOME (every one of them did, before this) would touch this host's actual
 * ~/.config the moment that landed. Never touch the real ~/.config from a
 * test: build a throwaway one instead.
 */
export function run(
	args: string[],
	pathDirs: string[] = [],
	env: Record<string, string> = {},
	installer = INSTALLER,
): { code: number; out: string; err: string } {
	const fakeHome = mkSandbox(path.join(os.tmpdir(), "46-run-home-"));
	try {
		const out = execFileSync(installer, args, {
			encoding: "utf8", stdio: "pipe",
			env: {
				...process.env,
				PATH: [...pathDirs, BUN_DIR, "/usr/bin", "/bin"].join(":"),
				HOME: fakeHome,
				XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
				...env,
			},
		});
		return { code: 0, out, err: "" };
	} catch (e: any) {
		if (typeof e?.status !== "number") return { code: -1, out: e?.stdout ?? "", err: String(e?.message ?? e) };
		return { code: e.status, out: e.stdout ?? "", err: e.stderr ?? "" };
	}
}

/** Print the tally, and exit 1 on a failure. */
export function finish(): never {
	console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
	process.exit(failed > 0 ? 1 : 0);
}

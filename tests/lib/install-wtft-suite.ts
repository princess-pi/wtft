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

export const BUN_DIR = (() => {
	let real = "";
	try { real = execSync("command -v bun", { encoding: "utf8" }).trim(); } catch { return ""; }
	const shim = mkSandbox(path.join(os.tmpdir(), "46-bunshim-"));
	fs.symlinkSync(real, path.join(shim, "bun"));
	return shim;
})();

execSync("bun run build", { cwd: REPO, stdio: "pipe" });

/** Run the installer with PATH set to `pathDirs`, bun and the system dirs, and a fresh HOME
 *  and XDG_CONFIG_HOME unless `env` sets them. Returns its exit code, or -1 when it could not
 *  be spawned. */
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

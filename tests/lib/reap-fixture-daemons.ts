/**
 * Suites spawn detached daemons. This reaps the ones left on a fixture:
 * a `--session` under the tmp dir, or a harness daemon whose root is.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function pathIsUnderTmp(file: string): boolean {
	const resolved = path.resolve(file);
	const tmp = path.resolve(os.tmpdir());
	return resolved === tmp || resolved.startsWith(tmp + path.sep) || resolved.startsWith("/tmp/");
}

/** `under`: reap only daemons whose session or harness root lies under this
 *  directory — one suite's own, when suites run side by side. */
export function reapFixtureDaemons(under?: string): number {
	const inScope = under === undefined
		? pathIsUnderTmp
		: (file: string) => { const r = path.relative(path.resolve(under), path.resolve(file)); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
	let killed = 0;
	let entries: string[];
	try {
		entries = fs.readdirSync("/proc");
	} catch {
		return 0;
	}
	for (const ent of entries) {
		if (!/^[1-9]\d*$/.test(ent)) continue;
		const pid = Number(ent);
		if (pid === process.pid) continue;
		let cmd = "";
		try {
			cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
		} catch {
			continue;
		}
		const args = cmd.split("\0").filter(arg => arg.length > 0);
		const isDaemon = args.some(arg => {
			const base = path.basename(arg);
			return base === "wtft-daemon.mjs" || base === "wtft-daemon.js" || base === "wtft-daemon" || base === "wtft-daemon.ts";
		});
		if (!isDaemon) continue;
		const sessIdx = args.indexOf("--session");
		const session = sessIdx >= 0 && sessIdx + 1 < args.length ? args[sessIdx + 1] : "";
		let roots: string[] = [];
		try {
			roots = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")
				.filter(row => row.startsWith("WTFT_CLAUDE_PROJECTS_DIR=") || row.startsWith("WTFT_PI_SESSIONS_DIR="))
				.map(row => row.slice(row.indexOf("=") + 1))
				.filter(row => row.length > 0);
		} catch { /* environ unreadable */ }
		const fixture = (session.length > 0 && inScope(session)) || roots.some(inScope);
		if (!fixture) continue;
		try {
			process.kill(pid, "SIGTERM");
			killed++;
		} catch { /* already gone */ }
	}
	return killed;
}

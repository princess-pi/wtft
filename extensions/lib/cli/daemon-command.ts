import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { WtftCliOptions } from "../wtft-cli-shared.js";

/** `--list`, `--cleanup`, `--restart`, `--stop`: passthrough to wtft-daemon. */
export function runDaemonCommand(opts: WtftCliOptions, daemonDir: string): void {
		const daemonPath = path.join(daemonDir, "wtft-daemon.mjs");
		const daemonArgs = [daemonPath];
		if (opts.daemonList) daemonArgs.push("--list");
		if (opts.daemonCleanup) daemonArgs.push("--cleanup");
		if (opts.daemonRestart) daemonArgs.push("--restart");
		if (opts.daemonStop) daemonArgs.push("--stop", opts.daemonStop);
		// An argument array, so a session path is never split by a shell.
		const result = spawnSync(process.execPath, daemonArgs, { encoding: "utf8", timeout: opts.daemonRestart ? undefined : 10000 });
		if (result.stdout) console.log(result.stdout.trim());
		if (result.stderr) console.error(result.stderr.trim());
		if (result.error) console.error(result.error.message);
		process.exitCode = result.error ? 1 : result.status ?? 1;
		return;
}

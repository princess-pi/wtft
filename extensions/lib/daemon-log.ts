/**
 * DaemonLog: where a detached daemon's stderr goes. One shared file, rotated
 * by copy-then-truncate so every appending daemon keeps writing to it.
 * docs/spec-daemon-log.md.
 */

import type { StdioOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DAEMON_LOG_MAX_BYTES = 1_000_000;

export function daemonLogPath(env: NodeJS.ProcessEnv = process.env): string {
	const state = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
	return path.join(state, "wtft", "daemon.log");
}

export function rotateDaemonLog(file: string, maxBytes: number): void {
	try {
		if (fs.statSync(file).size < maxBytes) return;
		fs.copyFileSync(file, `${file}.1`);
		fs.truncateSync(file, 0);
	} catch { /* no log yet, or unwritable: the spawn goes on without it */ }
}

export function daemonStdio(file = daemonLogPath()): { stdio: StdioOptions; close(): void } {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		rotateDaemonLog(file, DAEMON_LOG_MAX_BYTES);
		const fd = fs.openSync(file, "a");
		return { stdio: ["ignore", "ignore", fd], close: () => { try { fs.closeSync(fd); } catch { /* already closed */ } } };
	} catch {
		return { stdio: "ignore", close: () => {} };
	}
}

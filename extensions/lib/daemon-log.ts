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

const STALE_LOCK_MS = 60_000;

function takeLock(lock: string): boolean {
	try { fs.closeSync(fs.openSync(lock, "wx")); return true; } catch { return false; }
}

export function rotateDaemonLog(file: string, maxBytes: number): void {
	const lock = `${file}.lock`;
	try {
		const st = fs.lstatSync(file);
		if (!st.isFile() || st.size < maxBytes) return;
		if (!takeLock(lock)) {
			// Another process is rotating. One that died holding the lock left it
			// stale: remove it and race for it again, so one taker still wins.
			if (Date.now() - fs.statSync(lock).mtimeMs < STALE_LOCK_MS) return;
			fs.rmSync(lock, { force: true });
			if (!takeLock(lock)) return;
		}
		try {
			// Checked again under the lock: a rotation that finished since the first
			// check has already emptied the file, and copying it now would blank .1.
			if (fs.statSync(file).size < maxBytes) return;
			fs.copyFileSync(file, `${file}.1`);
			fs.chmodSync(`${file}.1`, 0o600);
			fs.truncateSync(file, 0);
		} finally {
			fs.rmSync(lock, { force: true });
		}
	} catch { /* no log yet, or unwritable: the spawn goes on without it */ }
}

export function daemonStdio(file = daemonLogPath()): { stdio: StdioOptions; close(): void } {
	try {
		// Session paths and warnings: this user's to read, no one else's.
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		// A FIFO with no reader would block the open forever.
		const existing = fs.lstatSync(file, { throwIfNoEntry: false });
		if (existing && !existing.isFile()) throw new Error("not a regular file");
		rotateDaemonLog(file, DAEMON_LOG_MAX_BYTES);
		const fd = fs.openSync(file, "a", 0o600);
		try { fs.fchmodSync(fd, 0o600); } catch { /* not ours to change; still logged */ }
		return { stdio: ["ignore", "ignore", fd], close: () => { try { fs.closeSync(fd); } catch { /* already closed */ } } };
	} catch {
		return { stdio: "ignore", close: () => {} };
	}
}

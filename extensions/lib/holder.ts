/**
 * Who a lease's pid is: a live daemon, a harness, something else, or nothing.
 * Every liveness and identity decision about a lease holder is made here, over
 * a process-table port a test replaces. docs/spec-holder.md.
 */

import { execFileSync, spawn as spawnChild } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { daemonStdio } from "./daemon-log.js";

export type Signal = 0 | "SIGTERM" | "SIGKILL";

export interface ProcessTable {
	signal(pid: number, sig: Signal): "sent" | "gone" | "denied";
	/** null: this host cannot tell, or the entry cannot be read (hidepid); signal 0 decides then. */
	state(pid: number): "running" | "zombie" | "gone" | null;
	/** null: unreadable. */
	cmdline(pid: number): string[] | null;
	/** Whether this host has a readable process table at all (Linux's /proc). */
	inspectable(): boolean;
	/** The command line as `ps` prints it, for a host with no /proc; null when it cannot say. */
	psCmdline(pid: number): string[] | null;
	/** A value that changes when the pid is reused; null when it cannot be read. */
	startTime(pid: number): string | null;
	/** Detached and unref'd, stderr to the daemon log; 0 when it failed. */
	spawn(command: string, args: string[], env: NodeJS.ProcessEnv): number;
}

export const linuxProcessTable: ProcessTable = {
	signal(pid, sig) {
		try { process.kill(pid, sig); return "sent"; }
		catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM" ? "denied" : "gone"; }
	},
	state(pid) {
		let stat: string;
		try { stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); }
		catch { return null; }
		return stat.charAt(stat.lastIndexOf(")") + 2) === "Z" ? "zombie" : "running";
	},
	cmdline(pid) {
		try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(a => a.length > 0); }
		catch { return null; }
	},
	inspectable() {
		return fs.existsSync("/proc/self/stat");
	},
	psCmdline(pid) {
		return psCmdline(pid);
	},
	startTime(pid) {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			// Field 22, starttime; fields after the ")" of comm start at 3.
			return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
		} catch {
			return null;
		}
	},
	spawn(command, args, env) {
		const log = daemonStdio();
		try {
			const child = spawnChild(command, args, { detached: true, stdio: log.stdio, env });
			child.unref();
			return child.pid ?? 0;
		} catch {
			return 0;
		} finally {
			log.close();
		}
	},
};

/** A pid's command line from `ps`, split on whitespace; null when `ps` cannot say. */
export function psCmdline(pid: number): string[] | null {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	try {
		const out = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
		const args = out.trim().split(/\s+/).filter(a => a.length > 0);
		return args.length > 0 ? args : null;
	} catch {
		return null;
	}
}

let table: ProcessTable = linuxProcessTable;

/** Swap the table in; returns the restore. */
export function useProcessTable(next: ProcessTable): () => void {
	const prev = table;
	table = next;
	return () => { table = prev; };
}

export function processTable(): ProcessTable {
	return table;
}

export type HolderKind = "gone" | "daemon" | "harness" | "other" | "unverified";

const DAEMON_BASENAMES = new Set(["wtft-daemon", "wtft-daemon.mjs", "wtft-daemon.js", "wtft-daemon.ts"]);

const RUNTIMES = new Set(["node", "nodejs", "bun", "bun.exe"]);
const RUNTIME_OPTIONS_WITH_VALUE = new Set(["-r", "--require", "--import", "--preload", "--loader", "--experimental-loader"]);
const RUNTIME_OPTIONS_WITHOUT_SCRIPT = new Set(["-e", "--eval", "-p", "--print"]);

/** The program is a daemon, or a runtime whose script is one; an argument after the script is data. */
export function isDaemonCmdline(args: string[]): boolean {
	if (args.length === 0) return false;
	if (DAEMON_BASENAMES.has(path.basename(args[0]))) return true;
	if (!RUNTIMES.has(path.basename(args[0]))) return false;
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (RUNTIME_OPTIONS_WITHOUT_SCRIPT.has(arg)) return false;
		if (RUNTIME_OPTIONS_WITH_VALUE.has(arg)) { i++; continue; }
		if (arg.startsWith("-")) continue;
		return DAEMON_BASENAMES.has(path.basename(arg));
	}
	return false;
}

export function classifyPid(pid: number): HolderKind {
	if (!Number.isSafeInteger(pid) || pid <= 0) return "gone";
	if (table.signal(pid, 0) === "gone") return "gone";
	const state = table.state(pid);
	if (state === "gone" || state === "zombie") return "gone";
	const args = table.cmdline(pid);
	if (args === null) return "unverified";
	if (!isDaemonCmdline(args)) return "other";
	return args.includes("--harness") ? "harness" : "daemon";
}

/** Running, whatever it is: a zombie is not. */
export function pidAlive(pid: number): boolean {
	return classifyPid(pid) !== "gone";
}

/** A lease naming such a pid is not stale. */
export function holdsLease(kind: HolderKind): boolean {
	return kind === "daemon" || kind === "harness" || kind === "unverified";
}

/** `classifyPid`, except that on a host with no /proc an unverified pid is read again through
 *  `ps`. Only the one-session callers that may signal (`-F`, `restartDaemon`) pay for that. */
export function verifiedKind(pid: number): HolderKind {
	const kind = classifyPid(pid);
	if (kind !== "unverified" || table.inspectable()) return kind;
	const args = table.psCmdline(pid);
	if (args === null) return "unverified";
	if (!isDaemonCmdline(args)) return "other";
	return args.includes("--harness") ? "harness" : "daemon";
}

/** Only a daemon is signalled by a one-session caller: a harness serves other sessions, an
 *  `other` is not ours, and an unverified pid may be anything. With no /proc a harness start
 *  cannot hand a session to a running harness, so there a harness is stopped too. */
export function mayStop(kind: HolderKind): boolean {
	return kind === "daemon" || (kind === "harness" && !table.inspectable());
}

export interface StopOptions { termMs?: number; killMs?: number; pollMs?: number }
export type StopOutcome = "stopped" | "denied" | "survived";

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function* stopSteps(pid: number, opts: StopOptions): Generator<number, StopOutcome, void> {
	const { termMs = 2000, killMs = 2000, pollMs = 20 } = opts;
	const kind = classifyPid(pid);
	const started = table.startTime(pid);
	const phases: [Signal, number][] = [["SIGTERM", termMs]];
	if (killMs > 0) phases.push(["SIGKILL", killMs]);
	for (const [sig, ms] of phases) {
		// A pid recycled during the wait is some other process: never signal it.
		if (sig === "SIGKILL" && (classifyPid(pid) !== kind || table.startTime(pid) !== started)) return "stopped";
		const sent = table.signal(pid, sig);
		if (sent === "gone") return "stopped";
		if (sent === "denied") return "denied";
		for (const until = Date.now() + ms; Date.now() < until;) {
			if (!pidAlive(pid)) return "stopped";
			yield pollMs;
		}
		if (!pidAlive(pid)) return "stopped";
	}
	return "survived";
}

/** SIGTERM, a wait, then SIGKILL and a wait. Yields, so the caller's own child gets reaped. */
export async function stopHolder(pid: number, opts: StopOptions = {}): Promise<StopOutcome> {
	const steps = stopSteps(pid, opts);
	for (let step = steps.next(); ; step = steps.next()) {
		if (step.done) return step.value;
		await new Promise(r => setTimeout(r, step.value));
	}
}

export function stopHolderSync(pid: number, opts: StopOptions = {}): StopOutcome {
	const steps = stopSteps(pid, opts);
	for (let step = steps.next(); ; step = steps.next()) {
		if (step.done) return step.value;
		sleepSync(step.value);
	}
}

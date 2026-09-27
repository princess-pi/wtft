/**
 * An in-memory `ProcessTable` (docs/spec-holder.md § 1).
 */

import type { ProcessTable, Signal } from "../../extensions/lib/holder.ts";

/** How a process answers a signal. `dies` is the default. */
export type OnSignal = "dies" | "ignores-term" | "zombie" | "denied" | "survives";

interface Proc { cmdline: string[]; state: "running" | "zombie"; onSignal: OnSignal; hidden: boolean; started: number }

export interface FakeProcessTable extends ProcessTable {
	add(pid: number, cmdline: string[], onSignal?: OnSignal): number;
	/** Alive, but its /proc entry cannot be read (hidepid). */
	hide(pid: number): void;
	/** Runs once, right after the next SIGTERM to `pid` lands. */
	afterTerm(pid: number, fn: () => void): void;
	daemon(pid: number, extra?: string[], onSignal?: OnSignal): number;
	alive(pid: number): boolean;
	/** Every signal sent, in order. */
	signals: { pid: number; sig: Signal }[];
	spawned: { pid: number; command: string; args: string[] }[];
}

export function fakeProcessTable(opts: { linux?: boolean; ps?: boolean } = {}): FakeProcessTable {
	const linux = opts.linux ?? true;
	const procs = new Map<number, Proc>();
	let nextPid = 50_000;
	const hooks = new Map<number, () => void>();
	let starts = 1;
	const table: FakeProcessTable = {
		signals: [],
		spawned: [],
		add(pid, cmdline, onSignal = "dies") {
			procs.set(pid, { cmdline, state: "running", onSignal, hidden: false, started: starts++ });
			return pid;
		},
		hide(pid) {
			const p = procs.get(pid);
			if (p) p.hidden = true;
		},
		afterTerm(pid, fn) {
			hooks.set(pid, fn);
		},
		daemon(pid, extra = [], onSignal = "dies") {
			return table.add(pid, ["node", "/x/bin/wtft-daemon.mjs", ...extra], onSignal);
		},
		alive(pid) {
			return procs.get(pid)?.state === "running";
		},
		signal(pid, sig) {
			const p = procs.get(pid);
			if (!p) return "gone";
			if (p.onSignal === "denied") return "denied";
			if (sig !== 0) table.signals.push({ pid, sig });
			if (sig === "SIGTERM" && hooks.has(pid)) {
				const hook = hooks.get(pid)!;
				hooks.delete(pid);
				queueMicrotask(hook);
			}
			if (sig === 0 || p.state === "zombie") return "sent";
			if (p.onSignal === "survives") return "sent";
			if (p.onSignal === "ignores-term" && sig === "SIGTERM") return "sent";
			if (p.onSignal === "zombie") p.state = "zombie";
			else procs.delete(pid);
			return "sent";
		},
		state(pid) {
			if (!linux) return null;
			const p = procs.get(pid);
			if (p?.hidden) return null;
			return p?.state ?? "gone";
		},
		inspectable() {
			return linux;
		},
		startTime(pid) {
			const p = procs.get(pid);
			return linux && p && !p.hidden ? String(p.started) : null;
		},
		cmdline(pid) {
			if (!linux) return null;
			const p = procs.get(pid);
			return p && !p.hidden ? (p.state === "zombie" ? [] : p.cmdline) : null;
		},
		psCmdline(pid) {
			const p = procs.get(pid);
			return opts.ps !== false && p ? p.cmdline : null;
		},
		spawn(command, args) {
			const pid = nextPid++;
			table.add(pid, [command, ...args]);
			table.spawned.push({ pid, command, args });
			return pid;
		},
	};
	return table;
}

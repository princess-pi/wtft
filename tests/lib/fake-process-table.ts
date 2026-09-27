/**
 * An in-memory `ProcessTable` (docs/spec-297-holder-module.md § 1).
 */

import type { ProcessTable, Signal } from "../../extensions/lib/holder.ts";

/** How a process answers a signal. `dies` is the default. */
export type OnSignal = "dies" | "ignores-term" | "zombie" | "denied" | "survives";

interface Proc { cmdline: string[]; state: "running" | "zombie"; onSignal: OnSignal }

export interface FakeProcessTable extends ProcessTable {
	add(pid: number, cmdline: string[], onSignal?: OnSignal): number;
	daemon(pid: number, extra?: string[], onSignal?: OnSignal): number;
	alive(pid: number): boolean;
	/** Every signal sent, in order. */
	signals: { pid: number; sig: Signal }[];
	spawned: { pid: number; command: string; args: string[] }[];
}

export function fakeProcessTable(opts: { linux?: boolean } = {}): FakeProcessTable {
	const linux = opts.linux ?? true;
	const procs = new Map<number, Proc>();
	let nextPid = 50_000;
	const table: FakeProcessTable = {
		signals: [],
		spawned: [],
		add(pid, cmdline, onSignal = "dies") {
			procs.set(pid, { cmdline, state: "running", onSignal });
			return pid;
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
			if (sig === 0 || p.state === "zombie") return "sent";
			if (p.onSignal === "survives") return "sent";
			if (p.onSignal === "ignores-term" && sig === "SIGTERM") return "sent";
			if (p.onSignal === "zombie") p.state = "zombie";
			else procs.delete(pid);
			return "sent";
		},
		state(pid) {
			if (!linux) return null;
			return procs.get(pid)?.state ?? "gone";
		},
		cmdline(pid) {
			if (!linux) return null;
			const p = procs.get(pid);
			return p ? (p.state === "zombie" ? [] : p.cmdline) : null;
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

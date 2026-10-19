/**
 * The host-wide test-run log and its per-day count. docs/spec-555-test-failure-log.md.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SuiteFailure { suite: string; timedOut: boolean; line: string }

export interface FailureRecord {
	utc: string;
	branch: string;
	checkout: string;
	suites: number;
	failures: SuiteFailure[];
}

export interface DayCount { day: string; runs: number; failures: Record<string, number> }

export interface FailureCount { days: DayCount[]; unreadableLines: number }

const DAY_MS = 86_400_000;
const LINE_MAX = 300;

/** `$XDG_STATE_HOME/wtft-tests/failures.jsonl`, defaulting to `~/.local/state/…`. */
export function failureLogPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "wtft-tests", "failures.jsonl");
}

/** The suite's first failing check, uncoloured; else its last non-empty line. */
export function firstFailingLine(output: string): string {
	const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map(l => l.trim()).filter(l => l !== "");
	const line = lines.find(l => /^(❌|FAIL\b|\(fail\))/.test(l)) ?? lines.at(-1) ?? "";
	return line.slice(0, LINE_MAX);
}

/** Appends one run. Throws when the log cannot be written. */
export function appendFailureRecord(file: string, record: FailureRecord): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, JSON.stringify(record) + "\n");
}

/**
 * Runs and failures per suite for the last `days` UTC days up to `now`, newest first, days with a
 * run only. Null when there is no log.
 */
export function countFailures(file: string, days: number, now: number = Date.now()): FailureCount | null {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	const first = new Date(now - (days - 1) * DAY_MS).toISOString().slice(0, 10);
	const byDay = new Map<string, DayCount>();
	let unreadableLines = 0;
	for (const line of text.split("\n")) {
		if (line === "") continue;
		let record: FailureRecord;
		try {
			record = JSON.parse(line);
		} catch {
			unreadableLines++;
			continue;
		}
		if (typeof record?.utc !== "string" || !Array.isArray(record.failures)
			|| !record.failures.every(f => typeof f?.suite === "string")) {
			unreadableLines++;
			continue;
		}
		const day = record.utc.slice(0, 10);
		if (day < first) continue;
		const count = byDay.get(day) ?? { day, runs: 0, failures: {} };
		count.runs++;
		for (const f of record.failures) count.failures[f.suite] = (count.failures[f.suite] ?? 0) + 1;
		byDay.set(day, count);
	}
	return { days: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)), unreadableLines };
}

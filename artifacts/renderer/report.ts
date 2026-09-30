import { parseWtftCliArgs, type WtftCliOptions } from "../../extensions/lib/wtft-cli-shared.ts";
import { askedOf, chartLines, chartUnit } from "../../extensions/lib/chart-call.ts";
import type { Interaction } from "../../extensions/lib/wtft-parser.ts";

export interface ReportEnv {
	columns: number;
	sessionFile: string;
	interactions: Interaction[];
	config?: { interval?: string; limit?: number; mode?: "cumulative" | "bucket"; timezone?: string; tokens?: boolean };
	/** Pins the clock the title's timeline strip reads. Unset, the strip is drawn for the real now. */
	now?: number;
}

export interface Report {
	opts: WtftCliOptions;
	unit: "cost" | "tokens";
	/** The session path line and the chart lines, pad included. */
	lines: string[];
}

/**
 * Runs `run` with the terminal `columns` wide and, when `now` is set, the clock at `now`. Both are restored after, and a
 * page with no `process` or no `process.stdout` is left with none. Under Node at exactly 80 columns the chart also asks
 * `tmux` or `tput`, which can replace the width.
 */
export function withTerminal<T>(columns: number, now: number | undefined, run: () => T): T {
	const host = globalThis as { process?: { stdout?: { columns?: number }; env?: Record<string, string> } };
	const hadProcess = "process" in host;
	const realProcess = host.process;
	host.process ??= { stdout: {}, env: {} };
	const hadStdout = "stdout" in host.process;
	host.process.stdout ??= {};
	const stdout = host.process.stdout;
	const realColumns = stdout.columns;
	const realNow = Date.now;
	stdout.columns = columns;
	if (now !== undefined) Date.now = () => now;
	try {
		return run();
	} finally {
		Date.now = realNow;
		stdout.columns = realColumns;
		if (!hadStdout) delete host.process.stdout;
		if (hadProcess) host.process = realProcess;
		else delete host.process;
	}
}

/** Turns a wtft command line into the session path line and the chart lines `wtft` prints for one report. */
export function renderReport(argv: string[], env: ReportEnv): Report {
	const opts = parseWtftCliArgs(argv);
	const config = env.config ?? {};
	const unit = chartUnit(opts, config.tokens);
	const termColumns = env.columns;
	const maxPad = Math.max(0, Math.floor(termColumns / 2) - 1);
	const pad = Math.min(opts.hasPad ? opts.pad : 1, maxPad);
	const padStr = " ".repeat(pad);

	const chart = withTerminal(termColumns, env.now, () => chartLines({
		interactions: env.interactions,
		asked: askedOf(opts),
		fallback: { width: termColumns - 2 * pad, interval: config.interval, limit: config.limit, mode: config.mode, timezone: config.timezone },
		unit,
		sessionFile: env.sessionFile,
		padRows: true,
	}));

	return {
		opts,
		unit,
		lines: [`${padStr}\x1b[90m${env.sessionFile}\x1b[0m`, ...(chart ?? []).map((line) => padStr + line)],
	};
}

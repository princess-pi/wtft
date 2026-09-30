import { parseWtftCliArgs, type WtftCliOptions } from "../../extensions/lib/wtft-cli-shared.ts";
import { buildWtftLines, chartLimit } from "../../extensions/lib/wtft-renderer.ts";
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
	let unit: "cost" | "tokens" = config.tokens ? "tokens" : "cost";
	if (opts.hasTokens) unit = "tokens";
	if (opts.hasCost) unit = "cost";

	const disabledEmoji = typeof opts.enableEmoji === "boolean" ? !opts.enableEmoji : false;
	const termColumns = env.columns;
	const maxPad = Math.max(0, Math.floor(termColumns / 2) - 1);
	const pad = Math.min(opts.hasPad ? opts.pad : 1, maxPad);
	const padStr = " ".repeat(pad);
	const paddedWidth = termColumns - 2 * pad;
	const finalInterval = opts.hasInterval ? opts.interval : (config.interval ?? "1h");
	const finalLimit = chartLimit(opts, config.limit);
	const finalMode = opts.hasMode ? opts.mode : (config.mode ?? "cumulative");
	const finalTimezone = opts.hasTimezone ? opts.timezone : config.timezone;

	const defaultSettings = {
		interval: "1h",
		limit: 100,
		width: Math.min(paddedWidth, 1023),
		mode: "cumulative" as "cumulative" | "bucket",
		timezone: undefined,
	};

	const chart = withTerminal(termColumns, env.now, () => buildWtftLines(env.interactions, defaultSettings, {
		interval: finalInterval,
		limit: finalLimit,
		padRowsTo: finalLimit,
		width: Math.min(paddedWidth, 1023),
		mode: finalMode,
		timezone: finalTimezone,
		disabledEmoji,
		sessionNameSuffix: env.sessionFile.slice(env.sessionFile.lastIndexOf("/") + 1),
		unit,
		showCostColumns: !opts.hideCostColumns,
		showTokenColumns: !opts.hideTokenColumns,
	}));

	return {
		opts,
		unit,
		lines: [`${padStr}\x1b[90m${env.sessionFile}\x1b[0m`, ...(chart ?? []).map((line) => padStr + line)],
	};
}

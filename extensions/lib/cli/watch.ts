import * as path from "node:path";
import { watchTagFile, getCurrentVersionTagPath, CLI_DEFAULT_LIMIT } from "../wtft-shared.js";
import { spawnWtftDaemon } from "../wtft-cli-shared.js";
import type { WtftCliOptions } from "../wtft-cli-shared.js";

/** `--watch`: spawn the daemon and render its tag until `q`. */
export async function runWatch(opts: WtftCliOptions, finalSessionPath: string, daemonDir: string, unit: "cost" | "tokens"): Promise<void> {
	const tagPath = getCurrentVersionTagPath(finalSessionPath);

	const daemonPath = path.join(daemonDir, "wtft-daemon.mjs");
	const daemonChild = spawnWtftDaemon(finalSessionPath, daemonDir);
	if (!daemonChild) {
		console.error(`\x1b[31m❌ Failed to start log parser daemon: ${daemonPath}\x1b[0m`);
		process.exit(1);
	}

	// No pre-sleep: watchTagFile waits on daemon state; reader catches up from lastReadOffset.
	await watchTagFile(finalSessionPath, tagPath, {
		daemonChild,
		interval: opts.hasInterval ? opts.interval : "1h",
		limit: opts.hasLimit ? opts.limit : CLI_DEFAULT_LIMIT,
		mode: opts.hasMode ? opts.mode : "cumulative",
		timezone: opts.hasTimezone ? opts.timezone : undefined,
		unit,
		showCostColumns: !opts.hideCostColumns,
		showTokenColumns: !opts.hideTokenColumns,
		daemonPath,
		pad: opts.pad,
		hasInterval: opts.hasInterval,
		hasLimit: opts.hasLimit,
		hasMode: opts.hasMode,
		hasTimezone: opts.hasTimezone,
		disabledEmoji: typeof opts.enableEmoji === "boolean" ? !opts.enableEmoji : undefined,
	});
	return; // watchTagFile never returns until SIGINT
}

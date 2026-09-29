import * as path from "node:path";
import { readConfig } from "@princess-pi/libs/config";
import { watchTagFile, getCurrentVersionTagPath, chartLimit, type WatchSettings } from "../wtft-shared.js";
import { WTFT_CONFIG_DIR, WTFT_CONFIG_TOOL } from "../wtft-config-dir.js";
import { spawnWtftDaemon } from "../wtft-cli-shared.js";
import type { WtftCliOptions } from "../wtft-cli-shared.js";

/** The render settings `--watch` starts from: each flag given, else the wtft config's value, else the code default. */
export function watchSettings(opts: WtftCliOptions, config: Record<string, unknown>): Pick<WatchSettings, "interval" | "limit" | "mode" | "timezone" | "hasInterval" | "hasLimit" | "hasMode" | "hasTimezone" | "disabledEmoji" | "defaultDisabledEmoji"> {
	return {
		interval: opts.hasInterval ? opts.interval : (typeof config.interval === "string" ? config.interval : "1h"),
		limit: chartLimit(opts, typeof config.limit === "number" ? config.limit : undefined),
		mode: opts.hasMode ? opts.mode : (config.mode === "cumulative" || config.mode === "bucket" ? config.mode : "cumulative"),
		timezone: opts.hasTimezone ? opts.timezone : (typeof config.timezone === "string" ? config.timezone : undefined),
		hasInterval: opts.hasInterval,
		hasLimit: opts.hasLimit,
		hasMode: opts.hasMode,
		hasTimezone: opts.hasTimezone,
		disabledEmoji: typeof opts.enableEmoji === "boolean" ? !opts.enableEmoji : undefined,
		defaultDisabledEmoji: typeof config.disabledEmoji === "boolean" ? config.disabledEmoji : false,
	};
}

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
		...watchSettings(opts, readConfig(WTFT_CONFIG_TOOL, WTFT_CONFIG_DIR)),
		unit,
		showCostColumns: !opts.hideCostColumns,
		showTokenColumns: !opts.hideTokenColumns,
		daemonPath,
		pad: opts.pad,
	});
	return; // watchTagFile never returns until SIGINT
}

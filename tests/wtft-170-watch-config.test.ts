#!/usr/bin/env -S node --experimental-strip-types
/**
 * --watch takes interval, limit, mode, timezone and emoji from the wtft config, the same as a plain run.
 */

import { watchSettings } from "../extensions/lib/cli/watch.ts";
import { parseWtftCliArgs } from "../extensions/lib/wtft-cli-shared.ts";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
	if (cond) { passed++; console.log(`  ✅ ${msg}`); }
	else { failed++; console.error(`  ❌ FAIL: ${msg}`); }
}

const config = { interval: "15m", limit: 7, mode: "bucket", timezone: "Asia/Tokyo", disabledEmoji: true };

const fromConfig = watchSettings(parseWtftCliArgs(["--watch"]), config);
check(fromConfig.interval === "15m", `interval from the config (got ${fromConfig.interval})`);
check(fromConfig.limit === 7, `limit from the config (got ${fromConfig.limit})`);
check(fromConfig.mode === "bucket", `mode from the config (got ${fromConfig.mode})`);
check(fromConfig.timezone === "Asia/Tokyo", `timezone from the config (got ${fromConfig.timezone})`);
check(fromConfig.defaultDisabledEmoji === true, `emoji setting from the config (got ${fromConfig.defaultDisabledEmoji})`);
check(fromConfig.disabledEmoji === undefined, "no emoji flag leaves a session log's emoji-settings entry free to apply");

const flags = watchSettings(parseWtftCliArgs(["--watch", "-i", "4h", "-l", "3", "--cumulative", "--timezone", "UTC", "--emoji"]), config);
check(flags.interval === "4h" && flags.limit === 3 && flags.mode === "cumulative" && flags.timezone === "UTC",
	`flags override the config (got ${flags.interval} ${flags.limit} ${flags.mode} ${flags.timezone})`);
check(flags.disabledEmoji === false, `--emoji overrides the config (got ${flags.disabledEmoji})`);

const bare = watchSettings(parseWtftCliArgs(["--watch"]), {});
check(bare.interval === "1h" && bare.mode === "cumulative" && bare.timezone === undefined && bare.defaultDisabledEmoji === false,
	"an empty config leaves the code defaults");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

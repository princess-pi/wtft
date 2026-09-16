#!/usr/bin/env -S bun
/**
 * debug/count-picker.ts — what one session-picker launch actually reads (#89)
 *
 * The instrument behind #89's closer. Timings alone could not settle that issue:
 * the tree walk is identical whatever the arms do, so it inflates any ratio
 * toward 1. Counts and BYTES can be argued with.
 *
 * `fullHistoryReads` used to be the headline number here. It is gone, with the
 * arm that produced it (#89, direction S) — a counter that can only ever read 0
 * is not a guard. `bytesRead` replaced it: every read in session-cwd.ts is a
 * bounded tail read, so bytes is the quantity that goes wrong if that ever
 * stops being true.
 *
 * Usage: bun debug/count-picker.ts [cwd]
 */

import { discoverSessions } from "../extensions/lib/session-selector.ts";
import {
	getCwdReadCount,
	getCwdBytesRead,
	getDirWalkCount,
	resetCwdCache,
} from "../extensions/lib/harness/session-cwd.ts";

const cwd = process.argv[2] || process.cwd();
resetCwdCache();
const t0 = performance.now();
const found = discoverSessions("auto", cwd);
console.log(JSON.stringify({
	cwd,
	candidates: found.length,
	ms: Math.round(performance.now() - t0),
	tailReads: getCwdReadCount(),
	bytesRead: getCwdBytesRead(),
	dirWalks: getDirWalkCount(),
}));

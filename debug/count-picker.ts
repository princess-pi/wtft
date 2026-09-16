#!/usr/bin/env -S bun
/**
 * debug/count-picker.ts — what one session-picker launch actually reads (#89)
 *
 * The instrument behind #89's closer. Timings alone could not settle that issue:
 * the tree walk is identical whatever the arms do, so it inflates any ratio
 * toward 1. Counts and BYTES can be argued with.
 *
 * `fullHistoryReads` used to be the headline number here. The arm that produced
 * it is gone (#89 — direction **S** in that issue's 2026-09-15 comment; the
 * issue BODY's own letters are A/B/C/D, and this is closest to its B), so the
 * counter behind it is gone too: one that can only ever read 0 is not a guard.
 *
 * The FIELD stays, pinned at 0. #89's closer is written against this probe's
 * output by name, so dropping the key would break the machine-readable
 * acceptance check the issue is graded by — a reader keying on it would get
 * `undefined` instead of a number. The guard moved to `bytesRead`, and to V22 in
 * tests/wtft-issue-144-145-164-session-discovery.test.ts, which asserts against
 * the SOURCE that session-cwd.ts still has exactly one read call: a byte counter
 * cannot see a read that declines to use the path it counts.
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
	// Structurally 0 since #89 — kept because the closer names this field.
	fullHistoryReads: 0,
	dirWalks: getDirWalkCount(),
}));

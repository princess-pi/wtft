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
 * THE FIELD IS GONE TOO, after one round of keeping it pinned at 0. A constant
 * is not a measurement: the closer's automated check (`fullHistoryReads` <= 50)
 * would have been permanently green by construction, which is worse than a
 * missing key — a reader gets a number that cannot vary instead of an absence
 * they would notice. #89 records that the check moved to `bytesRead`, and to V22
 * in tests/wtft-issue-144-145-164-session-discovery.test.ts, which asserts
 * against the SOURCE that session-cwd.ts still has exactly one read call: a byte
 * counter cannot see a read that declines to use the path it counts.
 *
 * `--per-harness` splits the totals, because they are not evenly shared:
 * measured 2026-09-16 from ~/git-projects/wtft, Claude discovery reads 281 MB
 * over 9,460 reads and walks 2,217 directories, while Pi reads 305 MB over 5,157
 * and walks none. An index that covered only Claude would leave half the cost.
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

const args = process.argv.slice(2);
const perHarness = args.includes("--per-harness");
const cwd = args.find(a => !a.startsWith("--")) || process.cwd();

// `picker` is what a launch with no `-s` opens on (bin/wtft.ts's
// getDefaultScoped): current worktree, 20 min. `unscoped` is the library
// default, which `-s` still searches.
const PICKER_DEFAULT = { scope: "worktree", windowMs: 20 * 60 * 1000 } as const;

function measure(harness: "auto" | "claude-code" | "pi", path: "picker" | "unscoped") {
	resetCwdCache();
	const t0 = performance.now();
	const found = discoverSessions(harness, cwd, path === "picker" ? PICKER_DEFAULT : undefined);
	return {
		cwd,
		harness,
		path,
		candidates: found.length,
		ms: Math.round(performance.now() - t0),
		tailReads: getCwdReadCount(),
		bytesRead: getCwdBytesRead(),
		dirWalks: getDirWalkCount(),
	};
}

for (const harness of perHarness ? ["claude-code", "pi", "auto"] as const : ["auto"] as const) {
	for (const path of ["picker", "unscoped"] as const) console.log(JSON.stringify(measure(harness, path)));
}

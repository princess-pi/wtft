/**
 * Tests for #24 — `getSurgeLocalHours` sampled the timezone offset once per
 * day, so a DST-transition day mapped local hours to the wrong instants. The
 * `tz` branch reused a single offset (sampled from `now`) for all 24
 * candidate hours; the `else` (no-`tz`) branch was suspected of the same
 * class of defect because it also builds all 24 hours from one `now`.
 *
 * MEASURED BEFORE FIXING (per the repo's "measure, don't trace" standard):
 * on Asia/Jerusalem's real 2026-03-27 spring-forward (offset +02:00 -> +03:00
 * at local 02:00), sampling `now` on each side of the transition instant
 * made the OLD code return a DIFFERENT surge set for the exact same
 * calendar day:
 *   now = 2026-03-26T22:30Z (local 00:30, offset still +02:00) -> {3,4,5,8,9,10,11}
 *   now = 2026-03-27T09:00Z (local 12:00, offset now +03:00)   -> {4,5,6,9,10,11,12}
 * Reproduced against `bin/wtft.mjs` on the pre-fix commit. The `else`
 * branch's output, by contrast, measured IDENTICAL regardless of which side
 * of the transition `now` fell on (confirmed for both directions below) —
 * `Date.prototype.setHours` re-derives its offset from the target local
 * time on every call rather than reusing one, so it never had the once-
 * per-day defect. Both branches are still pinned here: the `tz` branch
 * because it needed a real fix, the `else` branch as a regression guard and
 * to document where it deliberately still differs from the fixed `tz`
 * branch (an ambiguous fall-back hour, see below).
 *
 * Both a spring-forward day (Asia/Jerusalem, 2026-03-27, a Friday) and a
 * fall-back day (Africa/Cairo, 2023-10-26, also a Friday) are used because
 * the US/EU transitions this repo's other tests reach for both fall on a
 * Sunday, where #495's weekend-is-off-peak rule already returns the empty
 * set and hides this class of bug entirely (see #24's own text).
 *
 * Every expected instant/hour below is derived from the real IANA tzdata
 * offsets for these zones (independently confirmed via
 * `Intl.DateTimeFormat`, bisecting for the exact transition minute — see
 * PR #<this PR> research notes), not by calling the two-sample refinement
 * under test.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getSurgeLocalHours, getDeepSeekPeakMultiplier } from "../bin/wtft.mjs";

function sortedHours(set: Set<number>): number[] {
	return [...set].sort((a, b) => a - b);
}

// --- Spring forward: Asia/Jerusalem, 2026-03-27 (Friday) ---
// Real transition: local 02:00 -> 03:00, i.e. offset +02:00 before, +03:00
// from local 02:00 on. Local hour 2 does not exist that day.
const JERUSALEM = "Asia/Jerusalem";
const JERUSALEM_NOW_PRE_TRANSITION = Date.UTC(2026, 2, 26, 22, 30, 0);  // local 2026-03-27T00:30, offset +02:00
const JERUSALEM_NOW_POST_TRANSITION = Date.UTC(2026, 2, 27, 9, 0, 0);   // local 2026-03-27T12:00, offset +03:00

// Independently derived from tzdata: hour h<2 converts at +02:00, h>=2 at
// +03:00 (the nonexistent hour 2 lands on the same instant as hour 3 — see
// the dedicated test below for why).
const JERUSALEM_EXPECTED_INSTANTS: readonly string[] = [
	"2026-03-26T22:00:00.000Z", "2026-03-26T23:00:00.000Z", // 0, 1 (+02:00)
	"2026-03-27T00:00:00.000Z", "2026-03-27T00:00:00.000Z", // 2 (gap, resolves with 3), 3 (+03:00)
	"2026-03-27T01:00:00.000Z", "2026-03-27T02:00:00.000Z", "2026-03-27T03:00:00.000Z",
	"2026-03-27T04:00:00.000Z", "2026-03-27T05:00:00.000Z", "2026-03-27T06:00:00.000Z",
	"2026-03-27T07:00:00.000Z", "2026-03-27T08:00:00.000Z", "2026-03-27T09:00:00.000Z",
	"2026-03-27T10:00:00.000Z", "2026-03-27T11:00:00.000Z", "2026-03-27T12:00:00.000Z",
	"2026-03-27T13:00:00.000Z", "2026-03-27T14:00:00.000Z", "2026-03-27T15:00:00.000Z",
	"2026-03-27T16:00:00.000Z", "2026-03-27T17:00:00.000Z", "2026-03-27T18:00:00.000Z",
	"2026-03-27T19:00:00.000Z", "2026-03-27T20:00:00.000Z",
];

// getDeepSeekPeakMultiplier's windows are 01:00-04:00 and 06:00-10:00 UTC,
// Mon-Fri only (#495) — applied to JERUSALEM_EXPECTED_INSTANTS by hand:
// 01:00Z,02:00Z,03:00Z (hours 4,5,6) and 06:00Z..09:00Z (hours 9,10,11,12)
// charge 2x; every other instant above (including both copies of the
// 00:00Z collision at hours 2 and 3) does not.
const JERUSALEM_EXPECTED_SURGE_HOURS = [4, 5, 6, 9, 10, 11, 12];

describe("#24 getSurgeLocalHours (tz branch) resolves each local hour with its own DST offset", () => {
	it("(repro) the pre-fix code returned a different surge set depending only on which side of the transition `now` sampled — this asserts the discrepancy is gone", () => {
		const pre = getSurgeLocalHours(JERUSALEM, JERUSALEM_NOW_PRE_TRANSITION);
		const post = getSurgeLocalHours(JERUSALEM, JERUSALEM_NOW_POST_TRANSITION);
		assert.deepStrictEqual(sortedHours(pre), sortedHours(post));
	});

	it("matches exactly the hours getDeepSeekPeakMultiplier charges 2x for, converting each hour with the tzdata-correct offset for ITS side of the transition", () => {
		const surge = getSurgeLocalHours(JERUSALEM, JERUSALEM_NOW_POST_TRANSITION);
		for (let hour = 0; hour < 24; hour++) {
			const charged = getDeepSeekPeakMultiplier(Date.parse(JERUSALEM_EXPECTED_INSTANTS[hour])) === 2.0;
			assert.strictEqual(
				surge.has(hour), charged,
				`hour ${hour}: renderer says surge=${surge.has(hour)}, oracle instant ${JERUSALEM_EXPECTED_INSTANTS[hour]} charges ${charged ? "2x" : "1x"}`,
			);
		}
		assert.deepStrictEqual(sortedHours(surge), JERUSALEM_EXPECTED_SURGE_HOURS);
	});

	it("resolves the nonexistent local hour (02:00, the spring-forward gap) to the same peak/off-peak answer as the hour after it", () => {
		// Hour 2 never happens locally; the two-sample refinement converges on
		// the same instant (2026-03-27T00:00Z) as hour 3. Both are off-peak
		// here, so this pins that the gap hour is not incidentally miscounted
		// as its OWN, different instant.
		const surge = getSurgeLocalHours(JERUSALEM, JERUSALEM_NOW_POST_TRANSITION);
		assert.strictEqual(surge.has(2), surge.has(3));
		assert.strictEqual(surge.has(2), false);
	});
});

// --- Fall back: Africa/Cairo, 2023-10-26 (Friday) ---
// Real transition: local 24:00 (i.e. 2023-10-27T00:00) steps back to 23:00,
// so LOCAL HOUR 23 OF 2023-10-26 repeats: once at offset +03:00 (the hour's
// first pass) and again at offset +02:00 (the second pass, still reading as
// 2023-10-26 by wall clock). Both `now` samples below fall on that same
// local calendar day.
const CAIRO = "Africa/Cairo";
const CAIRO_NOW_PRE_TRANSITION = Date.UTC(2023, 9, 26, 9, 0, 0);   // local 2023-10-26T12:00, offset +03:00
const CAIRO_NOW_POST_TRANSITION = Date.UTC(2023, 9, 26, 21, 30, 0); // local 2023-10-26T23:30 (2nd pass), offset +02:00, still day 26

const CAIRO_EXPECTED_INSTANTS: readonly string[] = [
	"2023-10-25T21:00:00.000Z", "2023-10-25T22:00:00.000Z", "2023-10-25T23:00:00.000Z", // 0,1,2 (+03:00)
	"2023-10-26T00:00:00.000Z", "2023-10-26T01:00:00.000Z", "2023-10-26T02:00:00.000Z",
	"2023-10-26T03:00:00.000Z", "2023-10-26T04:00:00.000Z", "2023-10-26T05:00:00.000Z",
	"2023-10-26T06:00:00.000Z", "2023-10-26T07:00:00.000Z", "2023-10-26T08:00:00.000Z",
	"2023-10-26T09:00:00.000Z", "2023-10-26T10:00:00.000Z", "2023-10-26T11:00:00.000Z",
	"2023-10-26T12:00:00.000Z", "2023-10-26T13:00:00.000Z", "2023-10-26T14:00:00.000Z",
	"2023-10-26T15:00:00.000Z", "2023-10-26T16:00:00.000Z", "2023-10-26T17:00:00.000Z",
	"2023-10-26T18:00:00.000Z", "2023-10-26T19:00:00.000Z",
	"2023-10-26T21:00:00.000Z", // 23 (the fold hour, resolves to its LATER/post-transition occurrence)
];
const CAIRO_EXPECTED_SURGE_HOURS = [4, 5, 6, 9, 10, 11, 12];

describe("#24 getSurgeLocalHours (tz branch) on a fall-back day", () => {
	it("returns the same surge set for a `now` sampled before the fold and one sampled inside its later occurrence", () => {
		const pre = getSurgeLocalHours(CAIRO, CAIRO_NOW_PRE_TRANSITION);
		const post = getSurgeLocalHours(CAIRO, CAIRO_NOW_POST_TRANSITION);
		assert.deepStrictEqual(sortedHours(pre), sortedHours(post));
	});

	it("matches exactly the hours getDeepSeekPeakMultiplier charges 2x for, resolving the repeated hour to its later occurrence", () => {
		const surge = getSurgeLocalHours(CAIRO, CAIRO_NOW_POST_TRANSITION);
		for (let hour = 0; hour < 24; hour++) {
			const charged = getDeepSeekPeakMultiplier(Date.parse(CAIRO_EXPECTED_INSTANTS[hour])) === 2.0;
			assert.strictEqual(
				surge.has(hour), charged,
				`hour ${hour}: renderer says surge=${surge.has(hour)}, oracle instant ${CAIRO_EXPECTED_INSTANTS[hour]} charges ${charged ? "2x" : "1x"}`,
			);
		}
		assert.deepStrictEqual(sortedHours(surge), CAIRO_EXPECTED_SURGE_HOURS);
	});
});

// --- The `else` (no-`tz`) branch, made hermetic with an explicit TZ ---
//
// `getSurgeLocalHours(undefined, now)` reads the HOST's local time zone via
// `Date.prototype.setHours`. Pinning it here requires actually setting the
// host zone rather than trusting whatever the CI runner defaults to (this
// repo's CI runs a clean Ubuntu runner in UTC, where neither transition
// below would even exist). `process.env.TZ` is read lazily by Node's ICU
// binding, so mutating it mid-process changes subsequent `Date` results —
// restored in a `finally` so later suites in this same process (there are
// none here, `tests/run.ts` gives every suite its own process, but restore
// anyway rather than depend on that) see the original value.
describe("#24 getSurgeLocalHours (no-tz branch), hermetic via explicit TZ", () => {
	const originalTz = process.env.TZ;

	it("already had no once-per-day defect — same spring-forward day, sampled on both sides of the transition, agrees with itself", () => {
		process.env.TZ = JERUSALEM;
		try {
			const pre = getSurgeLocalHours(undefined, JERUSALEM_NOW_PRE_TRANSITION);
			const post = getSurgeLocalHours(undefined, JERUSALEM_NOW_POST_TRANSITION);
			assert.deepStrictEqual(sortedHours(pre), sortedHours(post));
			assert.deepStrictEqual(sortedHours(post), JERUSALEM_EXPECTED_SURGE_HOURS);
		} finally {
			if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
		}
	});

	it("resolves the Cairo fall-back day the same as the tz branch, EXCEPT it picks the EARLIER occurrence of the repeated hour — a documented, tested divergence, not a bug", () => {
		process.env.TZ = CAIRO;
		try {
			const surge = getSurgeLocalHours(undefined, CAIRO_NOW_POST_TRANSITION);
			// Neither occurrence of hour 23 is inside a peak window on this date
			// (21:00Z and 20:00Z are both outside [01:00,04:00) and [06:00,10:00)),
			// so the earlier-vs-later choice does not move the surge SET itself —
			// what it moves is the instant, asserted directly here against the
			// tzdata-derived oracle for the EARLIER occurrence (20:00Z, offset
			// +03:00), which is what `Date.prototype.setHours` returns and is
			// one hour earlier than the tz branch's 21:00Z for the same local hour.
			assert.deepStrictEqual(sortedHours(surge), CAIRO_EXPECTED_SURGE_HOURS);

			const d = new Date(CAIRO_NOW_POST_TRANSITION);
			d.setHours(23, 0, 0, 0);
			assert.strictEqual(d.toISOString(), "2023-10-26T20:00:00.000Z");
		} finally {
			if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
		}
	});
});

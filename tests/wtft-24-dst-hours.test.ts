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
 * Three zones, on both sides of UTC, are used because the fix (see
 * `resolveZonedLocalHour` in `extensions/lib/wtft-renderer.ts`) claims its
 * gap/fold resolution holds regardless of the zone's offset sign, and an
 * earlier draft of this PR shipped a two-sample refinement whose gap/fold
 * resolution was NOT sign-independent — verified wrong by review (PR review,
 * `Low/correctness`) against America/New_York before it merged: the earlier
 * code resolved a spring-forward gap backwards (matching the hour BEFORE)
 * for a negative-offset zone while matching the hour AFTER for a
 * positive-offset one. `resolveZonedLocalHour`'s day-buffered-offset-plus-
 * reparse approach was written to fix that, and NY is kept here as the
 * negative-offset proof, not dropped once the immediate finding was
 * addressed:
 *   - Asia/Jerusalem, 2026-03-27 (Friday) — spring forward, +02:00 -> +03:00.
 *   - Africa/Cairo, 2023-10-26 (Thursday) — fall back, +03:00 -> +02:00.
 *   - America/New_York, 2026-03-08 and 2026-11-01 (both Sundays; the US
 *     transition dates always are) — spring forward and fall back, both
 *     -05:00 <-> -04:00. Local Sunday, but NOT off-peak end to end: late
 *     local evening hours land on UTC MONDAY given the -05:00-ish offset, so
 *     the surge set is not trivially empty even though the ambiguous hour
 *     itself (2 for spring, 1 for fall) is not one of the surging hours.
 *
 * A second review round then caught a second, unrelated bug in the same
 * function: its reparse check compared only (year, month, day, hour),
 * ignoring minute and second — so for a zone with a non-whole-hour DST
 * shift it could accept a candidate reading `HH:30` as if it matched the
 * requested `HH:00`. Verified against Australia/Lord_Howe's real 30-minute
 * shift (`Low/reasoning` on the same PR review): local hours 0 and 1 on its
 * 2026-04-05 fall-back resolved 30 minutes early. That fix is pinned
 * directly against `resolveZonedLocalHour` (imported from the `.ts` source,
 * not the built `bin/wtft.mjs` — the exact hours involved never surge on
 * ANY real Lord Howe date, since its transitions are permanently
 * Sunday-locked to the Australian mainland's calendar, so `getSurgeLocalHours`
 * itself cannot observe this one through peak/off-peak membership the way
 * the other zones above do).
 *
 * Jerusalem and Cairo are used for the spring/fall PAIR on the positive
 * side, and reused (not re-derived) for the weekday requirement — the
 * US/EU transitions this repo's other tests reach both fall on a Sunday,
 * where #495's weekend-is-off-peak rule returns the empty set outright and
 * hides this class of bug (see #24's own text); New York is kept anyway, on
 * its real (Sunday) dates, purely to prove the negative-offset side.
 *
 * Every expected instant/hour below is derived from the real IANA tzdata
 * offsets for these zones (independently confirmed via
 * `Intl.DateTimeFormat`, bisecting for the exact transition minute), not by
 * calling `resolveZonedLocalHour` under test.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import { getSurgeLocalHours, getDeepSeekPeakMultiplier } from "../bin/wtft.mjs";
// Imported from the `.ts` source directly (the same pattern
// `tests/timeline-24h.ts` already uses), not the built `bin/wtft.mjs`:
// `resolveZonedLocalHour` has no reason to be part of the CLI's public
// bundle, and the Lord Howe case below needs it directly — see the file
// header for why `getSurgeLocalHours` cannot observe that bug on its own.
import { resolveZonedLocalHour } from "../extensions/lib/wtft-renderer.ts";

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
		// Hour 2 never happens locally; `resolveZonedLocalHour` converges on
		// the same instant (2026-03-27T00:00Z) as hour 3 — see
		// JERUSALEM_EXPECTED_INSTANTS, and the NY block below for the same
		// claim on the other side of UTC. Both are off-peak here, so this pins
		// that the gap hour is not incidentally miscounted as its OWN,
		// different instant.
		const surge = getSurgeLocalHours(JERUSALEM, JERUSALEM_NOW_POST_TRANSITION);
		assert.strictEqual(surge.has(2), surge.has(3));
		assert.strictEqual(surge.has(2), false);
	});
});

// --- Fall back: Africa/Cairo, 2023-10-26 (Thursday) ---
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

// --- Negative-offset proof: America/New_York, 2027-03-14 & 2026-11-01 ---
//
// Both are Sundays (the US transition dates always are — 2nd Sunday of
// March, 1st Sunday of November), so unlike Jerusalem/Cairo this pair
// cannot demonstrate the bug via a peak-window hit on the ambiguous hour
// itself. What it proves instead: `resolveZonedLocalHour`'s gap/fold policy
// is the SAME regardless of which side of UTC the zone sits on — an earlier
// version of this fix got that backwards for a negative-offset zone (see
// the file header). The surge set is not trivially empty despite the local
// Sunday: America/New_York's offset means several LATE local evening hours
// land on UTC MONDAY, which #495's weekday gate then charges normally.
// 2027 (not 2026) for the spring date specifically: 2026-03-08 predates
// #495's 2026-08-23 weekend-off-peak cutover, where a Saturday/Sunday
// still surged all day and the oracle below would need a second, dated
// branch to match — 2027-03-14 sidesteps that without changing anything
// this test is actually about.
const NEW_YORK = "America/New_York";
const NY_SPRING_NOW_PRE_TRANSITION = Date.UTC(2027, 2, 14, 5, 0, 0);   // local 2027-03-14T00:00, offset -05:00
const NY_SPRING_NOW_POST_TRANSITION = Date.UTC(2027, 2, 14, 20, 0, 0); // local 2027-03-14T16:00, offset -04:00
const NY_FALL_NOW_PRE_TRANSITION = Date.UTC(2026, 10, 1, 4, 0, 0);    // local 2026-11-01T00:00, offset -04:00
const NY_FALL_NOW_POST_TRANSITION = Date.UTC(2026, 10, 1, 20, 0, 0);  // local 2026-11-01T15:00 (2nd pass window has passed), offset -05:00

// Spring forward: local 02:00 -> 03:00, offset -05:00 -> -04:00. Hour 2 does
// not exist; resolves to the same instant as hour 3 (same rule as
// Jerusalem's positive-offset gap).
const NY_SPRING_EXPECTED_INSTANTS: readonly string[] = [
	"2027-03-14T05:00:00.000Z", "2027-03-14T06:00:00.000Z", // 0, 1 (-05:00)
	"2027-03-14T07:00:00.000Z", "2027-03-14T07:00:00.000Z", // 2 (gap, resolves with 3), 3 (-04:00)
	"2027-03-14T08:00:00.000Z", "2027-03-14T09:00:00.000Z", "2027-03-14T10:00:00.000Z",
	"2027-03-14T11:00:00.000Z", "2027-03-14T12:00:00.000Z", "2027-03-14T13:00:00.000Z",
	"2027-03-14T14:00:00.000Z", "2027-03-14T15:00:00.000Z", "2027-03-14T16:00:00.000Z",
	"2027-03-14T17:00:00.000Z", "2027-03-14T18:00:00.000Z", "2027-03-14T19:00:00.000Z",
	"2027-03-14T20:00:00.000Z", "2027-03-14T21:00:00.000Z", "2027-03-14T22:00:00.000Z",
	"2027-03-14T23:00:00.000Z", "2027-03-15T00:00:00.000Z", "2027-03-15T01:00:00.000Z",
	"2027-03-15T02:00:00.000Z", "2027-03-15T03:00:00.000Z",
];
// Hours 21, 22, 23 land on UTC MONDAY 2027-03-15 at 01:00Z-03:00Z, inside
// the 01:00-04:00 window — the only reason this Sunday has ANY surge hours.
const NY_SPRING_EXPECTED_SURGE_HOURS = [21, 22, 23];

// Fall back: local 02:00 -> 01:00, offset -04:00 -> -05:00. Hour 1 repeats;
// resolves to its LATER (-05:00, post-transition) occurrence — same rule as
// Cairo's positive-offset fold, opposite sign zone.
const NY_FALL_EXPECTED_INSTANTS: readonly string[] = [
	"2026-11-01T04:00:00.000Z", // 0 (-04:00)
	"2026-11-01T06:00:00.000Z", // 1 (fold, resolves to its LATER/-05:00 occurrence, not 05:00Z)
	"2026-11-01T07:00:00.000Z", "2026-11-01T08:00:00.000Z", "2026-11-01T09:00:00.000Z", // 2,3,4 (-05:00)
	"2026-11-01T10:00:00.000Z", "2026-11-01T11:00:00.000Z", "2026-11-01T12:00:00.000Z",
	"2026-11-01T13:00:00.000Z", "2026-11-01T14:00:00.000Z", "2026-11-01T15:00:00.000Z",
	"2026-11-01T16:00:00.000Z", "2026-11-01T17:00:00.000Z", "2026-11-01T18:00:00.000Z",
	"2026-11-01T19:00:00.000Z", "2026-11-01T20:00:00.000Z", "2026-11-01T21:00:00.000Z",
	"2026-11-01T22:00:00.000Z", "2026-11-01T23:00:00.000Z", "2026-11-02T00:00:00.000Z",
	"2026-11-02T01:00:00.000Z", "2026-11-02T02:00:00.000Z", "2026-11-02T03:00:00.000Z",
	"2026-11-02T04:00:00.000Z",
];
// Hours 20, 21, 22 land on UTC MONDAY 2026-11-02 at 01:00Z-03:00Z.
const NY_FALL_EXPECTED_SURGE_HOURS = [20, 21, 22];

describe("#24 getSurgeLocalHours (tz branch) on America/New_York — the negative-offset proof", () => {
	it("spring forward: same surge set on both sides of the transition, matching the tzdata oracle (including the UTC-Monday-crossing hours)", () => {
		const pre = getSurgeLocalHours(NEW_YORK, NY_SPRING_NOW_PRE_TRANSITION);
		const post = getSurgeLocalHours(NEW_YORK, NY_SPRING_NOW_POST_TRANSITION);
		assert.deepStrictEqual(sortedHours(pre), sortedHours(post));
		for (let hour = 0; hour < 24; hour++) {
			const charged = getDeepSeekPeakMultiplier(Date.parse(NY_SPRING_EXPECTED_INSTANTS[hour])) === 2.0;
			assert.strictEqual(post.has(hour), charged, `hour ${hour}: oracle instant ${NY_SPRING_EXPECTED_INSTANTS[hour]}`);
		}
		assert.deepStrictEqual(sortedHours(post), NY_SPRING_EXPECTED_SURGE_HOURS);
	});

	it("fall back: same surge set on both sides of the fold, matching the tzdata oracle, with the repeated hour resolved to its later occurrence", () => {
		const pre = getSurgeLocalHours(NEW_YORK, NY_FALL_NOW_PRE_TRANSITION);
		const post = getSurgeLocalHours(NEW_YORK, NY_FALL_NOW_POST_TRANSITION);
		assert.deepStrictEqual(sortedHours(pre), sortedHours(post));
		for (let hour = 0; hour < 24; hour++) {
			const charged = getDeepSeekPeakMultiplier(Date.parse(NY_FALL_EXPECTED_INSTANTS[hour])) === 2.0;
			assert.strictEqual(post.has(hour), charged, `hour ${hour}: oracle instant ${NY_FALL_EXPECTED_INSTANTS[hour]}`);
		}
		assert.deepStrictEqual(sortedHours(post), NY_FALL_EXPECTED_SURGE_HOURS);
	});

	it("resolves the spring-forward gap (local 02:00) the same way the else/host branch does — the gap case does NOT diverge between branches, on either side of UTC", () => {
		const originalTz = process.env.TZ;
		process.env.TZ = NEW_YORK;
		try {
			const hostSurge = getSurgeLocalHours(undefined, NY_SPRING_NOW_PRE_TRANSITION);
			const tzSurge = getSurgeLocalHours(NEW_YORK, NY_SPRING_NOW_PRE_TRANSITION);
			assert.deepStrictEqual(sortedHours(hostSurge), sortedHours(tzSurge));

			const d = new Date(NY_SPRING_NOW_PRE_TRANSITION);
			d.setHours(2, 0, 0, 0);
			assert.strictEqual(d.toISOString(), NY_SPRING_EXPECTED_INSTANTS[2]);
		} finally {
			if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
		}
	});

	it("resolves the fall-back fold (local 01:00) to the OPPOSITE occurrence from the else/host branch — same divergence direction as Cairo, opposite sign zone", () => {
		const originalTz = process.env.TZ;
		process.env.TZ = NEW_YORK;
		try {
			const d = new Date(NY_FALL_NOW_PRE_TRANSITION);
			d.setHours(1, 0, 0, 0);
			// Host picks the EARLIER (-04:00) occurrence; the tz branch above
			// resolved hour 1 to the LATER (-05:00) one, "2026-11-01T06:00:00.000Z".
			assert.strictEqual(d.toISOString(), "2026-11-01T05:00:00.000Z");
			assert.notStrictEqual(d.toISOString(), NY_FALL_EXPECTED_INSTANTS[1]);
		} finally {
			if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
		}
	});
});

// --- Direct: Australia/Lord_Howe's 30-minute shift (the minute-check fix) ---
//
// Real fall-back (DST end), 2026-04-05: local 02:00 DST (+11:00) steps back
// to local 01:30 standard (+10:30) — a 30-minute fold, not the usual
// one-hour one. The fold window is local 01:30-01:59; local hours 0:00 and
// 1:00 both occur exactly once, strictly BEFORE it, so neither is itself
// ambiguous. That made this a clean way to isolate the minute-comparison
// bug (see file header): a `resolveZonedLocalHour` that reparse-checks only
// (year, month, day, hour) accepts the 01:30 instant as if it were the
// requested 01:00, because both share `hour === 1`.
const LORD_HOWE = "Australia/Lord_Howe";

describe("#24 resolveZonedLocalHour, direct: Lord Howe's non-whole-hour shift", () => {
	it("resolves local hours 0 and 1 to their real :00 instant, not the zone's 30-minutes-later reading", () => {
		assert.strictEqual(resolveZonedLocalHour(2026, 4, 5, 0, LORD_HOWE), Date.parse("2026-04-04T13:00:00.000Z"));
		assert.strictEqual(resolveZonedLocalHour(2026, 4, 5, 1, LORD_HOWE), Date.parse("2026-04-04T14:00:00.000Z"));
	});

	it("still resolves an ordinary hour on the same day correctly (regression guard on the common path)", () => {
		assert.strictEqual(resolveZonedLocalHour(2026, 4, 5, 12, LORD_HOWE), Date.parse("2026-04-05T01:30:00.000Z"));
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

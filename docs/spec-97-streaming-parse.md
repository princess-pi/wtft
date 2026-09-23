# Spec — #97, part one: parse a transcript in chunks, not as one string

> **Issue:** [#97](https://github.com/princess-pi/wtft/issues/97) — *Daemon re-parses every
> subagent transcript in full on every poll — 4.2× file size resident.* Part of **P7** of
> [#194](https://github.com/princess-pi/wtft/issues/194). **This change is part of #97, not its
> close:** the issue's Closer is not met by it (see *The Closer*), and #97 stays open for the rest.

## The gap

`parseSessionFile` read the whole transcript into one string, split it into an array of every
line, and parsed them all while both were still alive. Its peak was the file as a string, plus the
line array, plus every parsed entry. The daemon re-reaches that peak each time a subagent
transcript changes, and V8 does not hand freed heap back, so the peak sets the resident size. The
issue measured a daemon watching a 25.3 MB session at 113.9 MB PSS (4.2× the file) on real
transcripts.

## The change

**`parseSessionFile` reads the file in 1 MiB chunks** and hands each complete line to the same
per-line body as before. A `StringDecoder` carries a UTF-8 character that is split across two
chunks, and the text after the last newline is carried into the next chunk. The final line is
parsed whether or not it ends in a newline, as `content.split("\n")` did. The same lines, in the
same order, go through the same control-entry, interaction and nested `claude -p` attribution
code. A `chunkBytes` that is not a positive safe integer throws a `RangeError` rather than
returning an empty parse. Every caller benefits: the daemon, the CLI's and the widget's subagent
reads, and every nested fold parse.

**Roads not taken, for now:**

- **Offset reads in the daemon (the issue's direction A).** Reading only the bytes appended since
  the last poll would also remove the CPU cost of re-parsing a changed transcript. But the daemon's
  subagent path rests on the full parse for rotation detection (#114's generation records), nested
  `claude -p` re-attribution (#14) and the one-child-one-holder rule (#107). Rebuilding those on
  offsets is a large change to the hot path, and it is the rest of #97.
- **A V8 young-generation flag for the daemon (`--max-semi-space-size=1`).** It was tried and
  measured (below) and left out: its benefit was not established. One 3-minute run with it read
  23.0 MB, but a 30-minute run read 33.5 MB, and a flagged run once its subagents were read
  (47.2 MB) matched an unflagged one (49.9 MB). It would also have applied only to daemons wtft
  spawns itself, not to one started by hand.

## Verification

`tests/wtft-97-streaming-parse.test.ts`:

- **PART E — output does not depend on where chunks fall.** One mixed fixture (a multi-byte
  character straddling chunk boundaries, blank and malformed lines, a model change, a last line
  with no newline) is parsed at chunk sizes 1, 3, 7, 64 and 1000. Each result equals a single-chunk
  parse of the whole fixture, which is one read of the entire file split on newlines, as the old
  whole-string read did. A truncated copy is parsed at chunk size 5 and equals the single-chunk
  parse of that truncated copy. Equivalence with the removed code path rests on that single-chunk
  case plus the existing suites that pin `parseSessionFile`'s output (the daemon, CLI parity and
  fold suites), which pass unchanged.
- **PART R — an invalid `chunkBytes` throws.** 0, −1, `NaN` and 1.5 each throw a `RangeError`.
- **PART M — one parse of a ~40 MB fixture grows peak RSS by less than 20 MB.** Measured
  2026-09-22 under bun: about 4 MB with this change. The same fixture grew about 49 MB with the old
  whole-string read (measured once, before the change, with the same script; the suite now runs
  only the new code). PART M runs under bun, so its figure is JavaScriptCore's heap, not V8's; the
  daemon under node is measured only by the script below.

## The Closer — measured 2026-09-22, and not met

A daemon watching a synthetic session whose three subagent transcripts total 28.3 MB, appended to
every 5 s: `debug/97-daemon-pss.sh <daemon.mjs> <label> <seconds> [node-flags]` (not a suite). The
script fails loudly rather than report a false reading: it checks the fixture, validates every
sample, and cleans up on exit. It samples once the daemon's tag file carries a subagent line. That
can be as soon as the **first** of the three transcripts is written, so the "once read" column may
land mid-sweep.

| Build | PSS once a subagent is read | after appends |
|---|---|---|
| before this change (`main`) | 98.0 MB | 56.9 MB after 3 min |
| **chunked parse (this change)** | **49.9 MB** | **38.7 MB after 3 min** |
| road not taken: + `--max-semi-space-size=1` | 18.9 MB | 23.0 MB after 3 min |
| road not taken: the same, 30 minutes | 47.2 MB | 33.5 MB after 30 min |

An earlier version of the script sampled on a fixed 25 s timer, before the daemon had read
anything. Its figures (about 20 MB at start-up for every build) were wrong and are not used.

**These figures predate #219** (one daemon per harness), which merged while this change was in
review and changes how a daemon holds sessions. A smoke run of the script on the merged build
read 77.3 MB once read and 14.2 MB after 20 s of appends. The parser result (chunking halves the
parse peak) does not depend on that, but the daemon-level figures must be re-measured under #219
as part of the rest of #97.

**What the numbers support.** The whole-string parse's peak was real: 98 MB for 28 MB of
transcripts. Chunking halves it. Neither build meets the issue's Closer (under 30 MB, not
growing). What remains in #97 is direction A, plus the per-transcript `writtenLines`, `writtenIds`
and `writtenCostById` maps in `bin/wtft-daemon.ts`'s `SubagentFileState`. Those grow with every
line emitted, are cleared when a rewrite is detected (`supersededWithoutDedup`), and are dropped
with the whole state when another transcript folds this one (`skipAsFoldedElsewhere`).

## Review record

Three `pr-review` rounds (Claude Opus). Every finding was fixed, or declined with a reason. After
round 3, Duppy chose to ship the chunked parse only and drop the V8 flag, whose benefit the
measurements did not establish. That removed the flag's spawn helper and the findings about it:
which spawners pass the flag, the Pi host's runtime, and a daemon started by hand. The measurement
script became loud about every failure. The docs now state only measured figures, with the issue's
4–5× figure attributed to the issue. The Closer is recorded as not met, and #97 stays open for the
rest.

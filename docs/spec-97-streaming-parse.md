# Spec — #97: parse a transcript in chunks, not as one string

> **Issue:** [#97](https://github.com/princess-pi/wtft/issues/97) — *Daemon re-parses every
> subagent transcript in full on every poll — 4.2× file size resident.* Part of **P7** of
> [#194](https://github.com/princess-pi/wtft/issues/194).

## The gap

`parseSessionFile` reads the whole transcript into one string, splits it into an array of every
line, and parses them all while both are still alive. Its peak is the file's bytes as a string,
plus the line array, plus every parsed entry. The issue's own measurement on real transcripts put
that peak at 4–5× the file: a daemon watching a 25.3 MB session sat at 113.9 MB PSS. The daemon
re-reaches that peak each time a subagent transcript changes, and V8 does not hand the freed heap
back, so the peak becomes the resident size.

This change's own measurement (`tests/wtft-97-streaming-parse.test.ts`'s PART M, under bun): one
parse of a 40 MB fixture grew peak RSS by about 49 MB with the old whole-string read and about
4 MB with the chunked read.

That account needs one qualification, shown by the measurement below: removing the peak by itself
(chunked parsing, no V8 flag) left resident size close to unchanged (55.5 → 55.3 MB on the
measurement workload). The growth is short-lived object churn inflating V8's young generation on
every re-parse, not the size of the peak alone — the semi-space flag below is what brings resident
size down.

## The change

**`parseSessionFile` reads the file in fixed-size chunks** (1 MiB) and hands each complete line to
the same per-line body it runs today. A `StringDecoder` carries a UTF-8 character split across two
chunks, and the text after the last newline is carried into the next chunk. The final line is
parsed whether or not it ends in a newline, exactly as `content.split("\n")` did. Nothing else
changes: the same lines, in the same order, through the same control-entry and interaction code,
then the same nested `claude -p` attribution. So peak memory is one chunk, one line, and the
interactions kept, instead of the file three ways over.

Every caller benefits, not only the daemon: the CLI's and the widget's subagent reads and every
nested fold parse go through the same function.

**A 1 MB semi-space (V8's young-generation setting) for the daemon under node.** Measured below,
the chunked parse alone removes the per-parse peak but not the daemon's resident growth:
re-parsing a changed transcript whole churns short-lived objects, and V8's default semi-space
size lets that churn inflate the heap. `daemonSpawnArgs` (`extensions/lib/wtft-daemon-spawn.ts`)
adds `--max-semi-space-size=1` under node to every daemon spawned through `spawnWtftDaemon` — the
CLI's one-shot and watch-mode spawns in `bin/wtft.ts`, and the widget's `ensureDaemonRunning`
(including its `agent_end` revive) — and to the daemon's own restart. bun is not V8 and gets no
flag. A daemon started by hand (`wtft-daemon.mjs --session …`, or the `wtft-daemon` link, whose
shebang is plain `#!/usr/bin/env node`) gets no flag either. The old generation is **not** capped:
a cap small enough to matter could crash the daemon out of memory on a genuinely large session,
which is worse than a large resident size.

**Road not taken, for now — offset reads in the daemon (the issue's direction A).** Reading only the
bytes appended since the last poll would also remove the CPU cost of re-parsing a changed
transcript. But the daemon's subagent path relies on the full parse for three things that were
built on it: rotation detection (#114's generation records, which compare the whole parse with what
was written), nested `claude -p` re-attribution when a folded transcript changes (#14), and the
one-child-one-holder rule (#107). Rebuilding those on offsets is a large change to the hot path.
This change reduces the memory without touching any of them. The measurement below shows the
offset half is still needed to reach the Closer; it stays open in #97.

## Verification

`tests/wtft-97-streaming-parse.test.ts`:

- **Same output as before (PART E).** One mixed fixture — a plain turn, a blank line, a malformed
  line, a multi-byte character straddling a chunk boundary, a `model_change` control entry, a wide
  multi-byte turn, and a final line with no trailing newline — is parsed at five chunk sizes (1, 3,
  7, 64, 1000 bytes), plus once more from a truncated copy whose last line is cut mid-write. All
  six match a single-chunk parse of the whole fixture byte for byte. Equivalence with the removed
  `readFileSync(...).split("\n")` path rests on that single-chunk case — it is what the old path
  did — plus the existing suites that pin `parseSessionFile`'s output (the daemon, the CLI parity
  and the fold suites), which pass unchanged.
- **The existing suites are unchanged.** Every test of `parseSessionFile`'s behaviour (the daemon,
  the CLI parity and the fold suites) passes as it did.
- **Peak memory does not scale with the file (PART M).** Parsing a 40 MB fixture in a fresh
  process: peak RSS grows by well under half the file's size, not several times over. This runs
  under bun, so the number it prints is JavaScriptCore's, not V8's — the daemon's V8 behaviour
  under node is covered only by `debug/97-daemon-pss.sh`, not by this suite.
- **An invalid `chunkBytes` throws, never a silent empty parse (PART R).** 0, -1, `NaN` and 1.5
  each raise a `RangeError` naming the value.

- **The daemon's flag:** under node the spawn argv starts with `--max-semi-space-size=1`; under
  bun it does not (D1, D2).

**The Closer — measured 2026-09-22, and not yet met.** A daemon watching a synthetic session whose
three subagent transcripts total about 28 MB, sampled after start-up and after 3 minutes of
appends every 5 s (`debug/97-daemon-pss.sh <daemon.mjs> <label> <seconds> [node-flags]`, not a
suite; the issue's own Closer asks for 30 minutes; the script invokes node directly against the
built `.mjs`, not through `daemonSpawnArgs`). The "this change" row was measured with
`NODE_OPTIONS=--max-semi-space-size=1`, equivalent to the flag `daemonSpawnArgs` passes when the
daemon is started the normal way:

| Build | PSS after start-up | after 3 min of appends |
|---|---|---|
| before this change | 20.5 MB | 55.5 MB |
| chunked parse only | 18.9 MB | 55.3 MB |
| chunked parse + 1 MB semi-space (this change) | 21.0 MB | 38.3 MB |
| road not taken: also capping the old generation at 24 MB | 22.2 MB | 34.2 MB |

So this change takes the daemon from about 55 MB to about 38 MB on this workload. That is part of
#97, not its close — the issue's Closer (under 30 MB, not growing) is not met by it. What remains
in #97 is direction A above — reading only the bytes appended since the last poll, instead of
re-parsing a changed transcript whole — and the per-transcript `writtenLines`, `writtenIds` and
`writtenCostById` maps in `bin/wtft-daemon.ts`'s `SubagentFileState`: they grow with every line
emitted, are cleared when a rewrite is detected (`supersededWithoutDedup`), and the whole
`SubagentFileState` is dropped when another transcript folds this one (`skipAsFoldedElsewhere`).

## Review record

Review round 2 — 11 findings:

| # | Finding | Disposition |
|---|---|---|
| 1 | `debug/97-daemon-pss.sh` could report a falsely low PSS, or exit 0, on a hidden failure | Fixed: `set -euo pipefail`; legitimate non-zero returns (a `kill` of an already-dead pid) guarded with `\|\| true`. |
| 2 | The python fixture generator used `datetime.UTC` (3.11+ only), had no exit-status check, and no floor on fixture size | Fixed: `datetime.timezone.utc`; exit status checked; subagents directory asserted ≥25 MiB, measured in bytes via `du -sb`. |
| 3 | An interrupted run could orphan the daemon process or leave its temp tree behind | Fixed: `trap 'kill "$PID" 2>/dev/null \|\| true; rm -rf "$ROOT"' EXIT`, set right after the daemon starts. |
| 4 | `pss()`/`sample()` could report a non-numeric or non-positive reading as if it were a real measurement | Fixed: `sample()` validates the value is a positive number before printing it, exiting non-zero with a labelled error otherwise. |
| 5 | The first sample could be taken before the daemon had read any subagent transcript, measuring an idle process instead of the thing under test | Fixed: `wait_for_tags` blocks, bounded to 60 s, until the tag file carries an `"s":` line, or exits with a labelled error. |
| 6 | `chunkBytes` of 0, a negative number, `NaN`, or a non-integer produced a silent empty parse | Fixed: `fileLines` throws a `RangeError` naming the value; covered by PART R. |
| 7 | `docs/EXT_WTFT.html`'s spec-97 row cited "4–5×" as this change's own result | Fixed: the row now states only measured figures (49 → 4 MB peak parse; 55 → 38 MB daemon PSS). |
| 8 | This spec's "4–5×" line, its verification wording, and its `writtenLines`/`writtenIds`/`writtenCostById` claim were imprecise or wrong | Fixed: the 4–5× figure is re-attributed to the issue's own measurement ("The gap" above); Verification states exactly what PART E, M and R prove; the maps' clearing rules are corrected (the Closer section above). |
| 9 | Pi host may not be the node CLI | Declined: verified 2026-09-22 that the Pi host and the CLI both run as the nvm node binary (`/home/princess-pi/.nvm/versions/node/v22.22.3/bin/node`), which accepts V8 flags. |
| 10 | Spec asserts facts about unshown files | Verified: `bin/wtft.ts` spawns the daemon only through `spawnWtftDaemon` (lines ~598 and ~632), and the built `bin/wtft-daemon.mjs`'s shebang is `#!/usr/bin/env node`. |
| 11 | PART M measures JSC, not V8 | Accepted, documented: Verification above (PART M) says so directly — the daemon's V8 behaviour under node is covered only by `debug/97-daemon-pss.sh`. |

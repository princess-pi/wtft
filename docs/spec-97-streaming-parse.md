# Spec — #97: parse a transcript in chunks, not as one string

> **Issue:** [#97](https://github.com/princess-pi/wtft/issues/97) — *Daemon re-parses every
> subagent transcript in full on every poll — 4.2× file size resident.* Part of **P7** of
> [#194](https://github.com/princess-pi/wtft/issues/194).

## The gap

`parseSessionFile` reads the whole transcript into one string, splits it into an array of every
line, and parses them all while both are still alive. Its peak is the file's bytes as a string,
plus the line array, plus every parsed entry: 4–5× the file. The daemon re-reaches that peak each
time a subagent transcript changes, and V8 does not hand the freed heap back, so the peak becomes
the resident size. Measured in the issue: a daemon watching a 25.3 MB session sat at 113.9 MB PSS.

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

**A 1 MB young generation for the daemon under node.** Measured below, the chunked parse alone
removes the per-parse peak but not the daemon's resident growth: re-parsing a changed transcript
whole churns short-lived objects, and V8's default young generation lets that churn inflate the
heap. `daemonSpawnArgs` (`extensions/lib/wtft-daemon-spawn.ts`) starts every long-lived daemon —
from the CLI, the widget, watch mode and the daemon's own restart — with
`--max-semi-space-size=1` when the runtime is node. bun is not V8 and gets no flag. The old
generation is **not** capped: a cap small enough to matter could crash the daemon out of memory
on a genuinely large session, which is worse than a large resident size.

**Road not taken, for now — offset reads in the daemon (the issue's direction A).** Reading only the
bytes appended since the last poll would also remove the CPU cost of re-parsing a changed
transcript. But the daemon's subagent path relies on the full parse for three things that were
built on it: rotation detection (#114's generation records, which compare the whole parse with what
was written), nested `claude -p` re-attribution when a folded transcript changes (#14), and the
one-child-one-holder rule (#107). Rebuilding those on offsets is a large change to the hot path.
This change reduces the memory without touching any of them. The measurement below shows the
offset half is still needed to reach the Closer, so it has its own issue: #222.

## Verification

`tests/wtft-97-streaming-parse.test.ts`:

- **Same output as before.** Over a set of fixture transcripts, including a multi-byte character
  that straddles a chunk boundary, a final line with no trailing newline, a truncated last line,
  blank lines and malformed lines: the chunked parse returns exactly the interactions the
  whole-string parse did. Run with a deliberately small chunk size, so the boundaries fall inside
  lines.
- **The existing suites are unchanged.** Every test of `parseSessionFile`'s behaviour (the daemon,
  the CLI parity and the fold suites) passes as it did.

- **The daemon's flag:** under node the spawn argv starts with `--max-semi-space-size=1`; under
  bun it does not (D1, D2).

**The Closer — measured 2026-09-22, and not yet met.** A daemon watching a synthetic session whose
three subagent transcripts total about 28 MB, sampled after start-up and after 3 minutes of
appends every 5 s (a scratch script, not a suite; the issue's own Closer asks for 30 minutes):

| Build | PSS after start-up | after 3 min of appends |
|---|---|---|
| before this change | 20.5 MB | 55.5 MB |
| chunked parse only | 18.9 MB | 55.3 MB |
| chunked parse + 1 MB young generation (this change) | 21.0 MB | 38.3 MB |
| road not taken: also capping the old generation at 24 MB | 22.2 MB | 34.2 MB |

So this change takes the daemon from about 55 MB to about 38 MB on this workload. That misses
the issue's 30 MB and still grows with each re-parse. The rest is the whole-file re-parse itself,
which #222 removes by reading only appended bytes. #97 closes with this change; #222 carries the
Closer's remaining half.

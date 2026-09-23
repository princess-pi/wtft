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

**Road not taken, for now — offset reads in the daemon (the issue's direction A).** Reading only the
bytes appended since the last poll would also remove the CPU cost of re-parsing a changed
transcript. But the daemon's subagent path relies on the full parse for three things that were
built on it: rotation detection (#114's generation records, which compare the whole parse with what
was written), nested `claude -p` re-attribution when a folded transcript changes (#14), and the
one-child-one-holder rule (#107). Rebuilding those on offsets is a large change to the hot path.
This change fixes the memory, which is the issue's Closer, without touching any of them. If the
measurement below still shows CPU mattering, the offset half gets its own issue.

## Verification

`tests/wtft-97-streaming-parse.test.ts`:

- **Same output as before.** Over a set of fixture transcripts, including a multi-byte character
  that straddles a chunk boundary, a final line with no trailing newline, a truncated last line,
  blank lines and malformed lines: the chunked parse returns exactly the interactions the
  whole-string parse did. Run with a deliberately small chunk size, so the boundaries fall inside
  lines.
- **The existing suites are unchanged.** Every test of `parseSessionFile`'s behaviour (the daemon,
  the CLI parity and the fold suites) passes as it did.

**The Closer — measured, recorded here.** A daemon watching a synthetic session whose subagent
transcripts total ≥25 MB: PSS sampled after start-up and after 30 minutes of appends. Target from
the issue: both under 30 MB, the second no more than a few MB above the first.

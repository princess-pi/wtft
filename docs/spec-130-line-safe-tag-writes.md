# Spec #130 — the tag file is line-safe by construction

## The rule this issue installs

**Every write the daemon makes to a `.wtft-tag.*.jsonl` file leaves the file a whole
number of complete lines**, and no write ever *ends* mid-line.

**One honest exception, and it is not hand-waved.** `appendTagFile` uses `fs.appendFileSync`,
which can short-write when the disk fills. #512 already owns that case and it is terminal: the
daemon stops, poisons the singleton lease with a rebuild token, and the next owner rederives
the tag from the transcript in full. So a failed append can leave a fragment, and it is
resolved by rebuild rather than by parsing — which is Duppy's stated preference for
out-of-space handling: abort, reconstruct, do not grow machinery for it. The newline check in
`appendTagFile` rejects a batch that does not *end* in a newline; it cannot stop a partial
write reaching disk, and this spec no longer claims it can.

That is the contract Duppy asked for (2026-09-16):

> If any of our WTFT daemon parsers write anything less than a full line to our tag file
> format, that's a bug in the parser. I don't want to put any code. I want the code reading
> tag files to be able to safely presume not only that lines are atomically written but
> also that every notify signal comes for a full line and at a predictable cadence in time.

**The format is JSONL.** One JSON object per line, `\n`-terminated, no trailing object
without its newline. `serializeClassified` (`extensions/lib/wtft-daemon-lib.ts`) ends every
record with `JSON.stringify(line) + "\n"`, and so does every `_meta` and `_hb` writer.

**What readers may therefore presume, and what this spec obliges the writer to deliver:**

| Presumption | What makes it true |
|---|---|
| Every line in the file at rest parses as JSON | no COMPLETED write ever ends mid-line, and a crash mid-append is repaired by the next daemon at startup |
| **No MID-FILE line is ever malformed** | the only line any reader can find incomplete is the LAST one, and only while a write is in flight. A welded or truncated line in the middle of the file is the #130 defect, and it cannot recur |
| ANY reader concurrent with a write may see one partial line at the end | a large append is not one `write(2)`, so this holds for whole-file readers too. Every reader keeps its final-line tolerance |
| Writes arrive in bursts no more often than one beat | `POLL_MS = 667` bounds how often a poll comes round — **not how many writes it makes.** One poll writes the classified batch, then `_meta.offset`, then a `_meta.swept` marker, plus one append per changed subagent transcript; `shutdown` writes outside the cadence entirely. A reader gets several notifications per beat |

**What no writer can deliver, stated so nobody builds on it:** `fs.watch`/inotify report
**bytes**, never lines. There is no "notify me on a newline" anywhere in the stack. The
guarantee above is not the watcher being clever — it is the file never being in a state
worth hiding. A reader that is woken twice for one line still sees valid JSONL both times.

## What was actually happening

Measured across this host, 2026-09-16 — 8,244 `.jsonl` files, 3,910,822 lines:

| Source | Files | Files with a mid-file broken line | Broken lines |
|---|---:|---:|---:|
| Harness transcripts (Claude Code + Pi) | 7,917 | **0** | **0** |
| wtft's own `wtft-tags/*.jsonl` | 327 | **96 (29%)** | **2,562** |

One harness file had no trailing newline on its **last** line, mid-append. That is the
benign live case, and it is the only partial line either harness produces. **No harness has
ever been observed leaving a partial line mid-file.** Every corrupt line on this host is
ours.

**2,554 of the 2,562 (99.7%)** carry a multi-byte UTF-8 sequence in the preceding 2 KiB —
`e2 86 92` (`→`) and `e2 80 94` (`—`), out of our own commit messages and tool descriptions.

### Defect 1 — a byte offset computed from a JS string index

`upsertHeartbeat` (`bin/wtft-daemon.ts`) scans backwards from EOF for the start of the last
line, so it can truncate a stale heartbeat off and append a fresh one. The scan reads
**bytes** and then measures in a **decoded string**:

```ts
searchOffset -= readSize;                  // a BYTE offset into the file
fs.readSync(fd, buf, 0, readSize, searchOffset);
tail = buf.toString("utf8") + tail;        // bytes -> UTF-16 code units
lastNl = tail.lastIndexOf("\n");           // an index in code units
...
const truncAt = searchOffset + lastLineStart;   // BYTE offset + STRING index
fs.ftruncateSync(fd, truncAt);
```

Every multi-byte character between `searchOffset` and the start of the last line makes the
string index smaller than the byte offset it stands for, so `truncAt` lands **that many
bytes early** — inside the preceding line. The append then welds the new heartbeat onto the
severed line:

```
{"_meta":{"swept":1788828490280}{"_hb":{"first":1,"last":2}}
```

Reproduced byte-exactly (`research/repro-130-heartbeat-drift.mjs`):

| Fixture | Drift | Lines before → after | Corrupt |
|---|---:|---:|---:|
| pure ASCII | 0 B | 3 → 3 | 0 |
| one em dash | 2 B | 3 → 2 | 1 |
| arrows + dashes | 6 B | 3 → 2 | 1 |

**What it eats.** 1,707 of the welds are `_meta` + `_hb`: a destroyed resume marker, and
`_meta.offset` is where the next daemon start resumes parsing from. 12 carry `"t":` —
classified cost data, money, gone. 7 are heartbeat-only.

**Two hazards in the same function, closed by the same fix.** The 512-byte backward chunk
read can split a UTF-8 sequence, so `buf.toString("utf8")` yields U+FFFD and the decoded
tail is not even the file's text. And the truncate happens on an `r+` fd while the append
goes through a separate `fs.appendFileSync` on the path — two descriptors for one logical
edit. Working in `Buffer` and never decoding a chunk removes the first; truncating to a
line boundary makes the second harmless, because both halves leave the file valid.

### Defect 2 — the reader advances past a line it could not parse

`parseNewLines` (`bin/wtft-daemon.ts`) reads `[lastSize, currentSize)` from the **session**
file and then does:

```ts
lastSize = currentSize;     // before the content is split on "\n"
```

When the poll lands while the harness is mid-append, the final chunk is a partial line. It
fails `JSON.parse`, is skipped by the loop's `catch`, and `lastSize` has already moved past
it — so the rest of that line is **never re-read**. The whole interaction is lost, silently,
and nothing counts it.

This is the benign case above turned into a real loss: the harness is behaving correctly and
we drop the turn anyway.

**Measured, not reasoned.** R1 below writes one turn in two halves with three beats in
between and asks the daemon what it counted. Against the pre-fix daemon the answer is `[]` —
not a mis-priced turn, an absent one.

## The fix

**Defect 1 — work in bytes, and truncate only to a line boundary.**

A new exported seam in `extensions/lib/wtft-daemon-lib.ts`:

```ts
export function lastLineStartByte(fd: number, size: number, chunkSize?: number): number
```

Returns the **byte** offset at which the file's last content line begins. It searches the
raw `Buffer` for `0x0a` and never decodes a chunk, so a multi-byte sequence straddling a
chunk boundary cannot affect the answer. `upsertHeartbeat` then reads exactly that one line,
decodes it whole (a complete line is complete UTF-8), and — when it is a heartbeat of the same
width — **overwrites it in place** with a single `writeSync` at that offset, on the one
descriptor already open.

The first version truncated to that offset and then appended through a second descriptor. Both
halves landed on a line boundary, so JSONL held at every instant — but the file briefly got
SHORTER, and an offset-tracking reader only ever asks whether the file GREW (#130 review round
2). Replacing in place removes the window rather than arguing it is harmless: the size never
changes, so no reader's position can go stale, and a torn write leaves a mix of two heartbeats
that are the same shape and the same length, hence still a complete parseable line. The
fixed width is what buys that — `first` and `last` are both 13-digit epoch milliseconds. A
line of any other width is not ours to overwrite, so the code appends instead.

**Defect 2 — consume only to the last newline, in bytes.**

```ts
const lastNl = buf.lastIndexOf(0x0a);
const fragment = buf.subarray(lastNl + 1);
// A fragment whose length did not move for a whole beat, and which parses, is
// not a fragment — it is the file's unterminated final record.
let settledFragment = false;
if (fragment.length > 0 && fragment.length === pendingFragmentSize) {
	try { JSON.parse(fragment.toString("utf8")); settledFragment = true; } catch (_) { }
}
pendingFragmentSize = settledFragment ? 0 : fragment.length;
if (lastNl === -1 && !settledFragment) return [];   // nothing complete — lastSize unmoved
const consumeTo = settledFragment ? buf.length : lastNl + 1;
lastSize += consumeTo;                              // BYTES, from a Buffer index
```

A partial trailing line is left for the next poll, which re-reads it whole. Searching the
`Buffer` rather than the decoded string is the same discipline as defect 1 and for the same
reason.

**Why the settled-fragment arm exists**, which an earlier draft of this section omitted
entirely (#130 review round 2): a transcript's own final record legitimately has no trailing
newline, and `parseSessionFile` — the whole-file reader the daemon must agree with — counts it.
Waiting for a newline that will never arrive would drift the daemon permanently below the
one-shot number, which is #156. So a fragment that has not moved for a beat and parses as JSON
is consumed. It is a heuristic about a SOURCE transcript, not about our own tag file, where the
writer guarantee makes it unnecessary.

**And the invariant is made structural, not a habit.** `appendTagFile` is the single helper
every tag append goes through, so it is where "whole lines" is enforced: a batch that does not
end in a newline is a programming error at the call site, and it fails loudly there instead of
becoming a line some reader has to tolerate. S1 and S2 then read the source and fail on the two
shapes that caused #130 — an append that bypasses the helper, and a truncate to an offset that
did not come from `lastLineStartByte`. #130 survived months because every reader swallowed it
silently; a check that reads the writer is the only thing that would have caught it.

**A WHOLE-FILE reader needs no new code — but its `catch` is NOT dead weight.** An earlier
draft of this spec said exactly that about `readClassifiedTagFile`, `readTagFileWithVerdict` and
`tagProvisionalFromContent`, and it was wrong (#130 review round 2). A large append is not one
`write(2)`, so a `readFileSync` can land inside one and return the complete lines plus a
fragment — the same fragment the offset reader sees, just dropped silently instead of
desynchronising the offset. Their `catch { continue; }` is what does the dropping, and removing
it on the strength of this contract would break them.

What the writer guarantee actually buys those readers is that the fragment can only ever be the
**last** thing in the file. Before #130 a weld could sit in the MIDDLE, taking the valid record
before it down with it — and 1,707 of those destroyed a `_meta` marker, which is where the next
daemon resumes from.

**One OFFSET-TRACKING reader does change, and the writer provably cannot cover it.**
`watchTagFile` reads `[lastReadOffset, size)` on every inotify wake and had the same
unconditional `lastReadOffset = stat.size` that `parseNewLines` had. The writer guarantee kills
*truncation welds*; it does not make a large append atomic against a concurrent read.
`syncSubagentTranscript` appends whole-transcript batches running to hundreds of KB, node may
split one append across several `write()` calls, and inotify can wake the watcher inside that
span. So the file is always complete lines PLUS, briefly, a partial one at the end.

That is one line of the same discipline, in the one place the writer cannot reach — not
defensive code against a writer we do not trust. Round 1 of review caught it; the first draft
of this spec claimed the watcher was safe because of the writer fix, and that was wrong.

## The 96 files already corrupted — what the bump does, and what it does not

Fixing the writer does nothing for a file already damaged, and those files are not inert.
1,707 of the welds destroyed a `_meta` marker, and `_meta.offset` is the resume point
`initClassified` reads: a v2.8.1 tag therefore resumes from a stale offset or re-parses, and
the 12 welds carrying `"t":` stay lost cost data for the life of the file. #130's Closer — a
rescan of `wtft-tags/` reporting zero mid-file unparseable lines — **cannot pass on this host**
without dealing with them.

`WTFT_TAGGER_VERSION` goes **2.8.1 → 2.8.2**. A tag file is a **disposable derived cache**, so
discarding it is both simpler and stricter than a repair pass — a repair would have to guess
where a welded line was meant to split, and would then be a code path this repo has to keep
correct forever for a defect that no longer happens. Round 1 of review raised this as the one
High finding, and it was right: the writer fix alone left the Closer unmeetable.

**What the bump does and does not do, stated precisely.** An earlier draft of this section said
it "makes every existing tag stale and rederived from its transcript". That overstates it, and
round 2 of review caught it. The three cases:

| A v2.8.1 tag whose session… | What happens to it | When |
|---|---|---|
| is reopened under a daemon | `sweepOldTagFiles` deletes it and the daemon rebuilds from the transcript | at that daemon's startup, not at the bump |
| is read one-shot without a daemon | still on disk, but `getTagPath` rule 3 serves it flagged provisional `stale-version` | every read, immediately |
| is never touched again | stays on disk, welded, forever | never |

So no corrupt number is ever presented as authoritative — the `stale-version` flag is the
by-construction half, and it needs no sweep to be true. What the bump does **not** deliver on
its own is the Closer's literal rescan.

**To dispose of them now, run this from the main clone — Princess Pi, before closing #130:**

```sh
find ~/git-projects -type d -name wtft-tags -print0 \
  | xargs -0 -I{} find {} -name '*.wtft-tag.v2.8.1.jsonl' -delete
```

Per session, `wtft -s <session> --force` does the same thing plus killing that session's daemon.
The Closer is therefore scoped to what the code guarantees: **zero mid-file unparseable lines
among tags at the CURRENT version**, which is true by construction the moment the writer fix
ships, rather than a claim about files no code will revisit.

## Tests

`tests/wtft-130-line-safe-tag-writes.test.ts`.

| # | Asserts |
|---|---|
| W1 | `lastLineStartByte` on an ASCII-only file returns the true byte offset |
| W2 | on a file whose earlier lines carry `→` and `—`, returns the true **byte** offset — the string-index version returns a smaller number |
| W3 | with a multi-byte sequence straddling the chunk boundary, still returns the true offset (no U+FFFD). **Both preconditions are asserted, not assumed** — the last line exceeds one chunk, and the byte at the boundary is a UTF-8 continuation byte |
| W4 | a file with no trailing newline: the last line starts after the last `\n` |
| W5 | an empty file returns 0; a single line with no newline returns 0 |
| W6 | a line longer than one chunk is handled — the scan widens rather than giving up. Asserted by the answer lying outside the first chunk, which a single read backwards from EOF could not have found |
| E1 | **the Closer.** The real daemon, driven against a session whose assistant text contains `→` and `—`, through enough beats to force several heartbeat upserts: **every line of the tag file parses as JSON**, no line carries a second record welded onto it, and the classified totals survive |
| E1b | across a quiet stretch, the heartbeat timestamp advances while the file size holds exactly still — replaced, not appended, so an idle daemon neither bloats the tag nor moves any reader's offset |
| R1 | a session file whose last line is written in two halves across two polls: the interaction is counted once, not lost |
| R2, R2b | the same, split **mid-UTF-8-sequence** — counted once the line completes, and exactly once |
| R3, R3b | a complete record with no trailing newline is counted, matching `parseSessionFile`, and exactly once. This is the settled-fragment arm, and the guard against #156 drift |
| R4 | **the Closer's second half.** A five-turn session dribbled in ONE-BYTE writes, so polls cut the stream at offsets nobody chose, yields exactly the turns `parseSessionFile` finds in the finished file — each once |
| C1 | a daemon SIGKILLed and left with a mid-line fragment is taken over by a second daemon: the fragment is discarded, **no heartbeat is welded onto it**, every line parses, and the earlier classified turns survive |
| S1 | no `fs.appendFileSync` reaches the tag path except through `appendTagFile` — the one helper that enforces the trailing newline |
| S2 | every tag truncate in the daemon cuts to a line boundary (an offset from `lastLineStartByte`) or to zero |
| S3 | `upsertHeartbeat` never truncates, and replaces the line in place at a `lastLineStartByte` offset. Structural because nothing observable at 667ms can tell in-place from same-width truncate-then-append — a behavioural test there would be theatre |

## RED, against the daemon that shipped

The suite was run against `bin/wtft-daemon.ts` as of the spec commit, before either fix:

**Method**, because the numbers are meaningless without it: only `bin/wtft-daemon.ts` was
reverted. `extensions/lib/wtft-daemon-lib.ts` kept the `lastLineStartByte` seam, so §W still
has a subject and still passes — the run measures the *call site*, which is where the corpus
damage came from.

```
FAIL E1 every one of the 16 tag lines parses as JSON
     {"_meta":{"swept":178959760425{"_hb":{"first":1789597604255,"last":1789597604925}}
     {"_meta":{"swept":17895976{"_hb":{"first":1789597605593,"last":1789597606261}}
FAIL E1 no line carries a second record welded onto it
FAIL E1 no two consecutive heartbeat lines — the cut fired
FAIL R1 the split turn is counted once the line completes   []
FAIL R1 and counted exactly once (0)
FAIL R2 a turn split mid-UTF-8-sequence is counted once the line completes
FAIL R2b and counted exactly once (0)
FAIL S2 every tag truncate cuts to zero or to a lastLineStartByte offset
19 passed, 8 failed
```

Those welded lines are the corpus shape, produced live by the real daemon rather than by a
fixture: a `_meta.swept` marker severed mid-number with a heartbeat welded onto the stump.
After the fix the same run is **27 passed, 0 failed**.

An earlier draft of this section quoted "14 passed, 5 failed" and "19 passed, 0 failed" — real
output from a run taken before §S existed, left standing after the suite grew. Round 1 of
review caught that the quoted output could not have come from the suite in the diff. Recorded
rather than silently corrected, because it is the same failure the #116 spec kept making.

## Closer

Run the daemon against a transcript containing `→` and `—` for long enough to upsert the
heartbeat at least three times, then read the tag file: **every line parses as JSON, no line
carries a second record welded onto it, and every turn written is still classified.** Those are
the three things E1 actually asserts — an earlier draft promised "the line count equals the
number of records written", which E1 never checked and which is not even well defined once
heartbeats are upserted rather than accumulated.

And on this host, after the v2.8.2 bump has let the tags rederive: a rescan of every
`wtft-tags/*.jsonl` reports **zero** mid-file unparseable lines, against 2,562 across 96 files
before.

## Review round 2 — the guarantee had two holes and the prose had four overclaims

Thirteen findings, six blocking. Every one reproduced against the code before it was adopted;
one did not reproduce the way it was argued, and that is recorded below rather than quietly
fixed as if it had.

### The seed offset was taken from a second look at the file (Medium/correctness)

Three call sites in `watchTagFile` did `readClassifiedTagFile(p)` and then
`lastReadOffset = fs.statSync(p).size`. The diff had just fixed exactly that shape inside the
`fs.watch` callback and left the other three standing, which is the drift this repo's
file-level reconcile scope exists to catch.

Two different losses hide in it. The stat sees bytes the read did not, so anything appended in
between is counted into the offset without ever being parsed. And a whole-file read can land
inside a multi-`write(2)` append and come back with a fragment, which the parse drops and the
stat counts — so the offset lands inside a line that completes a moment later and is then never
re-read. Both lose whole turns from the live view silently.

`seedClassifiedTagFile` returns the interactions **and** the offset from one buffer. The offset
is the end of the last complete line in the bytes actually parsed, so there is no second look
for a race to sit inside. All three sites now use it; no `statSync(tagPath).size` remains.

### A crash mid-append welded the NEXT daemon's heartbeat on (Medium/crossfile)

`appendTagFile` makes every write this daemon *completes* leave whole lines. It says nothing
about a write that never completed. A daemon killed inside `fs.appendFileSync` — SIGKILL, the
OOM killer, power loss — cannot reach the #512 handler that sets the `rebuild` lease token, so
the next daemon reaps a plain numeric PID as merely stale, resumes incrementally, and appends
its start heartbeat straight onto the fragment.

That is the corpus shape this whole issue is about, reached by a second route that the
arithmetic fix does not touch. `truncatePartialTail` now cuts any unterminated tail at the one
moment a new writer takes over the file, and says so on stderr. The fragment is discarded
rather than completed, because nobody knows how much of it reached the disk; if it carried a
`_meta` marker the resume falls back to the previous one and `dedupeClassifiedById` collapses
the re-read. C1 drives it with a real SIGKILL and was RED on all three of its substantive
assertions before the fix.

### The heartbeat upsert shrank the file (Medium/contract, and a Low that does not reproduce)

The truncate-then-append shape is gone; the heartbeat is now replaced by a single same-width
`writeSync` on the one descriptor already open. The reasoning is in the `upsertHeartbeat`
docstring and in Defect 1 above.

**What did not reproduce, stated because adopting a finding for the wrong reason is its own
defect.** The Low/crossfile finding argued a live bug: a *shorter* replacement heartbeat leaves
an offset reader past EOF, so the next classified line is read k bytes into itself and dropped.
The shrink is real, but it needs the two heartbeats to differ in width — and `first` and `last`
are both 13-digit epoch milliseconds until the year 5138. The finding also names
`{"_hb":"stop"}` as a replacement; it is a plain append and always was. So the mechanism is
sound and the instance is unreachable. The shape was fixed anyway, because it is simpler than
what it replaced and removes the window instead of arguing it is harmless — not because the bug
was live.

### Four claims in the prose that were false

| Claim | Where it was | What is true |
|---|---|---|
| "A whole-file reader never sees a partial line" | `wtft-tag-format.md`, `CONTEXT.md`, `EXT_WTFT.html`, two comments in `wtft-daemon-lib.ts` | a `readFileSync` concurrent with a multi-`write(2)` append returns the fragment too. The guarantee is that a fragment can only be **last**, never mid-file |
| "their existing `catch { continue; }` becomes dead weight" | this spec | it is load-bearing, and removing it would have broken every whole-file reader |
| the bump "makes every existing tag stale and rederived" | this spec, `wtft-tagger-version.ts` | it is rederived when that session's daemon next starts. Until then the old file is served flagged `stale-version`; a session nobody reopens keeps its welded tag forever. See the table above |
| "Patch: no cost moves" | `wtft-tagger-version.ts` | no counted line changes value, but `parseNewLines` used to skip turns, so a rederived total can come out **higher**. Recovered money, not moved money — still a patch, but worth naming |

The first is the one that mattered: acting on it would have meant deleting the very `catch`
that keeps whole-file readers correct.

### Two fixtures that had quietly stopped testing their subjects

W3 claimed a multi-byte sequence straddling the chunk boundary and W6 claimed the backward scan
widening. Neither happened. Both put the long line FIRST and a short heartbeat after it, so the
newline the scan looks for sat inside the very first chunk read from EOF and the loop returned
on iteration one; W3's dashes also happened to start at an offset that left the boundary
character-aligned. W6's only guard, `got > 512`, was trivially true of an unwidened scan.

Both now put the long line last, and both **assert their precondition** rather than asserting a
consequence that a broken scan also satisfies: W3 reads the byte at the boundary and demands a
UTF-8 continuation byte; W6 demands the answer lie outside the first chunk, which one read
backwards from EOF cannot produce. This is the same failure as A9 on #116 — a fixture that goes
on passing after it stops exercising anything — and the same remedy: assert the setup, not just
the result.

The heartbeat assertion had the same disease. "Some heartbeat has `last > first`" was justified
as something only a replacement could produce; it is not, because `initClassified` writes one
heartbeat, the first clean poll appends a `_meta` marker, and the next upsert then finds a
non-heartbeat last line and appends. E1b watches the file size across a quiet stretch instead,
which is the property the readers actually depend on.


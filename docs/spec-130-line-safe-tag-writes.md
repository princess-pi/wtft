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
guarantee above is not the watcher being clever — it is that a fragment can only ever be the
LAST thing in the file, never a corrupted line with valid lines after it. A reader woken twice
for one line sees, both times, every complete line intact and at most a trailing fragment it
already knows to hold. (An earlier draft said it "sees valid JSONL both times", which the
presumption table above already contradicted.)

## What was actually happening

Measured across this host, 2026-09-16 — 8,244 `.jsonl` files, 3,910,822 lines:

| Source | Files | Files with a mid-file broken line | Broken lines |
|---|---:|---:|---:|
| Harness transcripts (Claude Code + Pi) | 7,917 | **0** | **0** |
| wtft's own `wtft-tags/*.jsonl` — `~/.claude/projects` | 328 | **96** | **2,609** |
| wtft's own `wtft-tags/*.jsonl` — `~/.pi` | 94 | **23** | **224** |
| wtft's own `wtft-tags/*.jsonl` — `~/git-projects` | 5 | 0 | 0 |
| **wtft total** | **427** | **119 (28%)** | **2,833** |

**The Pi root was missed on the first pass**, and the first draft of this table reported only
`~/.claude/projects` — 327 / 96 / 2,562 — while the transcript row above it already claimed
"Claude Code + Pi". Tag files live in a `wtft-tags/` directory beside the transcript they derive
from, and Pi puts its transcripts under `~/.pi/agent/sessions/<slug>/`
(`extensions/lib/harness/pi/discovery.ts`), so 94 tag files were never counted. All of them
predate the measurement; none was created since. The conclusion is unchanged and the number is
10% larger.

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
find ~/.claude/projects ~/.pi/agent/sessions ~/git-projects -type d -name wtft-tags -print0 \
  | xargs -0 -I{} find {} -name '*.wtft-tag.v2.8.1.jsonl' -delete
```

**This command has had its roots wrong twice**, which is worth recording because both failures
look identical from the outside: exit 0, nothing deleted.

- Round 3 found it searching only `~/git-projects` — **5** `wtft-tags` directories, against
  **56** under `~/.claude/projects`. It would have reported success having deleted almost
  nothing on the very host whose corrupt files motivated the issue.
- The local audit round then found `~/.pi/agent/sessions` still missing — another **22**
  directories and **94** tag files. Currently inert for *this* glob, because Pi's newest tag
  version on this host is v2.7.2 and there is no v2.8.1 there to match, but it is the wrong
  scope to publish for exactly the reason round 3 gave.

A tag file lives in a `wtft-tags/` directory beside the session transcript it derives from, so
the root list is "every harness's transcript root, plus anywhere a session was run from" — one
entry per `HarnessDiscovery`. A command that silently matches nothing is the worst shape
available, since it looks like the cleanup ran.

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
| W3 | with a multi-byte sequence straddling the chunk boundary, still returns the true offset (no U+FFFD). **Three preconditions are asserted, not assumed** — the last line exceeds one chunk, the byte at the boundary is a UTF-8 continuation byte, and there is multi-byte content AHEAD of the resolving newline. The third is what makes it discriminate: without it every multi-byte character sits after the last newline where it cannot move the arithmetic, and a decode-per-chunk scan returns the right answer anyway |
| W4 | a file with no trailing newline: the last line starts after the last `\n` |
| W5 | an empty file returns 0; a single line with no newline returns 0; a single TERMINATED line also returns 0 |
| W6 | a line longer than one chunk is handled — the scan widens rather than giving up. Asserted by the answer lying outside the first chunk, which a single read backwards from EOF could not have found |
| E1 | **the Closer.** The real daemon, driven against a session whose assistant text contains `→` and `—`, through enough beats to force several heartbeat upserts: **every line of the tag file parses as JSON**, no line carries a second record welded onto it, and the classified totals survive |
| E1b | across a quiet stretch, the heartbeat timestamp advances while the file size holds exactly still — replaced, not appended, so an idle daemon neither bloats the tag nor moves any reader's offset |
| R1 | a session file whose last line is written in two halves across two polls: the interaction is counted once, not lost |
| R2, R2b | the same, split **mid-UTF-8-sequence** — counted once the line completes, and exactly once |
| R3, R3b | a complete record with no trailing newline is counted, matching `parseSessionFile`, and exactly once. This is the settled-fragment arm, and the guard against #156 drift |
| R4 | **the Closer's second half.** A five-turn session dribbled in ONE-BYTE writes, PACED against `POLL_MS` to span four beats (asserted, so it cannot silently shrink back inside one poll), yields exactly the turns `parseSessionFile` finds in the finished file — each once, **and the same total cost**, with `wantCost > 0` asserted first so the comparison cannot be vacuous |
| C1 | a daemon SIGKILLed and left with a mid-line fragment is taken over by a second daemon: the fragment is discarded, **no heartbeat is welded onto it**, every line parses, and the earlier classified turns survive |
| S1 | no `fs.appendFileSync` reaches the tag path except through `appendTagFile` — the one helper that enforces the trailing newline |
| S2 | every tag truncate in the daemon cuts to a line boundary (an offset from `lastLineStartByte`) or to zero |
| S3 | `upsertHeartbeat` never truncates, and replaces the line in place at a `lastLineStartByte` offset. Structural because nothing observable at 667ms can tell in-place from same-width truncate-then-append — a behavioural test there would be theatre |
| S4 | the watcher has a SHRINK branch, not only a grow branch, and re-seeds through `seedClassifiedTagFile` rather than guessing an offset |
| W7 | `seedClassifiedTagFile` takes its offset from the bytes it parsed: a trailing fragment is left unconsumed, a missing file answers `{[], 0}` without throwing |
| C1b | the rebuilt tag holds EXACTLY what the transcript holds — turn count and money — so the replayed-batch double count cannot hide behind a `>=` |
| P0 | the daemon's `POLL_MS` is still 667, which R4's pacing depends on |

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
FAIL E1 no two consecutive heartbeat lines
FAIL R1 the split turn is counted once the line completes   []
FAIL R1 and counted exactly once (0)
FAIL R2 a turn split mid-UTF-8-sequence is counted once the line completes
FAIL R2b and counted exactly once (0)
FAIL S2 every tag truncate cuts to zero or to a lastLineStartByte offset
19 passed, 8 failed
```

**That listing is ROUND 1's, against round 1's suite of 27 assertions, and it is kept as the
historical record of the original defect — it is not a run of the suite in this branch.** The
suite has since grown three times, to 69 assertions, and each later round's own RED evidence is
recorded with its finding rather than re-quoted here:

| Round | Suite | RED evidence for that round's fixes |
|---|---:|---|
| 1 | 27 | the listing above — live corruption in the corpus shape, R1 returning `[]` |
| 2 | 42 | C1 RED on all three substantive assertions against the pre-fix daemon (fragment not discarded, heartbeat welded onto it, lines unparseable) |
| 3 | 57 | S4 RED — no `stat.size < lastReadOffset` branch existed; R4 re-measured and shown to span 4 poll intervals where the first version finished inside one |
| local audit | 69 | C1b RED against a cut-only daemon: **4 rows vs 3, the id-less turn counted twice, the money wrong** — the first version of C1b could not fail |

A label in the listing was also edited by a later round (`— the cut fired` became
`— the replacement fired` when the truncate went away). Quoting live test output in a document
rots exactly this way, which is why the table above names the evidence instead of transcribing
it, and why this paragraph says outright which run the listing is from. Round 2's closing
section called this class of drift fixed and round 3 found it again — recorded rather than
quietly re-fixed.

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
are both 13-digit epoch milliseconds from 2001-09-09 until 2286-11-20 (1e12 to 1e13 ms; the
round-3 section below records how that figure was got wrong twice). The finding also names
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

## Review round 3 — the ceiling round, and it found a reader the writer fix left behind

Thirteen findings, four blocking. One did not reproduce and is recorded as such; the rest were
real, and three of them were defects **this branch introduced in round 2**.

### A `--watch` reader never noticed the file getting shorter (Medium/correctness)

The watch callback asked `stat.size > lastReadOffset` and had no other arm. The daemon truncates
the tag to zero in three places, and round 2 added a fourth shrink. A `--watch` reader stays
attached across a daemon restart — the `r` key, a respawn, a lease rebuild — so its offset was
left past the new EOF, pointing at bytes the file no longer had.

Nothing recovered from that. The reader sat idle until the rebuilt file grew *past* the stale
offset and then began reading from the middle of a line: every rebuilt line before that offset
was never seen, and round 1's consume-to-last-newline only drops the leading fragment. The chart
silently lost the early session.

Worse, **round 2's own prose asserted this was safe** — "truncating to zero is safe because no
reader can be positioned inside it", "the file never shrinks". True of the content, false of the
offset, which is the thing that breaks. A `stat.size < lastReadOffset` branch now re-seeds
through `seedClassifiedTagFile`. S4 pins it.

### A crashed tag is now REBUILT, not resumed (Low/correctness, and it was right)

Round 2 cut the unterminated tail and stopped there. That is necessary and not sufficient.
`flushPending` appends the classified batch and *then* `_meta.offset`; a daemon killed inside
that second append leaves the whole batch on disk with the offset line as the fragment. Cut it,
and the resume falls back to the previous offset and re-classifies a batch already in the file.

Round 2's docstring waved this away as free because `dedupeClassifiedById` collapses it. **It
does not** — that function passes an interaction with no `messageId` straight through
(`wtft-daemon-lib.ts:187`, and `wtft-tag-format.md` §4 states the rule), so every id-less turn
in the replayed batch would be billed twice, permanently. A transient double count is what
#132's priority excuses; a permanent one is exactly what it does not.

So a cut tail escalates to `rebuildTagOnStartup`. A tag is a disposable derived cache;
rederiving one after a crash costs a single re-parse of a session that just lost its daemon, and
it is provably correct where "resume from an offset we are no longer sure of" is a guess. C1b
pins it with exact equality against `parseSessionFile` — turn count and money — because `>=` is
how a double count goes unnoticed.

### The watcher's recovery path had started rendering an empty chart (Low/correctness)

Round 2 replaced a `fs.statSync` that THREW on a missing file with `seedClassifiedTagFile`,
which never throws and answers `{interactions: [], offset: 0}`. The catch below it therefore
wiped the accumulator and redrew an EMPTY chart on any transient read failure, and the "File
gone — wait for it to reappear" branch became unreachable. It now asks `existsSync` and keeps
the last good chart. A regression introduced by a fix, caught by a lens reading the diff.

### The one-time disposal command searched the wrong tree (Medium/contract)

Corrected above, with the measurement. Worth repeating here because of the failure SHAPE: the
command would have exited 0 having deleted almost nothing, on the exact host whose 96 corrupt
files motivated the issue. A cleanup that reports success without cleaning is worse than no
cleanup, because nobody looks again.

### R4 was finishing inside a single poll (Medium/contract)

The Closer's byte-at-a-time test dribbled ~2 KB with a 1ms sleep every 64 bytes: tens of
milliseconds, comfortably inside one 667ms beat. The daemon read the finished file in one poll
and never saw a mid-line cut, so R4 passed against the pre-fix reader too. It now paces itself
against `POLL_MS` to span at least four beats **and asserts the elapsed time**, so it cannot
quietly shrink back. `POLL_MS` is copied from the daemon rather than exported for a test, and
pinned by P0 against the daemon source.

R4 also compared only message ids. It now compares cost — and the first version of THAT summed
`r.costUsd`, a field that does not exist, reporting a confident `$0.000000 == $0.000000`. A
comparison that cannot fail, written in the same round that deleted two other assertions for
exactly that. It now asserts the fixture costs something before comparing.

### S2 was a file-global name match calling itself provenance (Low/reasoning)

Three versions, each fixing the last: proximity (failed on the fix it protects), then a
file-global regex — which let any `const lineStart = lastLineStartByte(...)` anywhere in the
file satisfy every truncate whose argument happened to be named `lineStart` — and now a match
within the enclosing function body. Because that narrowing has a fallback that is
indistinguishable from working, S2 now **self-checks**: it asserts `bodyOf` returned one
function rather than the whole file, and that a name bound elsewhere is rejected.

### Arithmetic, twice wrong in the same sentence

Round 2 wrote that 13-digit epoch milliseconds hold "until the year 5138". Round 3 corrected it
to "about 317,000 years". Both are wrong: 5138 is where Unix time in SECONDS reaches 1e11, and
1e13 ms is 317 years after 1970, not 317,000. The real window is **2001-09-09 to 2286-11-20**.
The width guarantee was sound every time; the arithmetic offered in support of it was not. Fixed
in all three places that carried it.

### What did not reproduce

`lastLineStartByte` is imported from `wtft-shared.js`, and a lens flagged that the branch assumes
that module re-exports `wtft-daemon-lib` wholesale — if it used a named list instead, the bundle
would break or the symbol would be undefined at runtime, and `upsertHeartbeat`'s catch would
swallow the TypeError on every beat. Sound reasoning, and checked: `wtft-shared.ts` line 20 is
`export * from "./wtft-parser.js"` and its neighbours are the same form. The assumption holds.
Recorded rather than silently dropped, because the next person to add an export there should
know the whole file depends on that form.

### Where this leaves the round limit

Round 3 is the ceiling. `PR_REVIEW_ROUND_LIMIT` is **not** raised — that rule exists precisely
for a loop that keeps finding real things, which is what this is. Every finding above is fixed,
and a further LOCAL audit round (below) was run instead of buying a fourth billed round.

## Local audit round — run instead of buying a fourth billed review

Round 3 reached the review ceiling. Rather than raise `PR_REVIEW_ROUND_LIMIT`, three
fresh-context auditors were dispatched over the same artifacts: the writer, the reader, and the
tests-plus-spec. They found fourteen things. The pattern the earlier rounds established held —
**most of what they found was introduced by the previous rounds' own fixes** — and two were bad
enough that the suite was not testing what it claimed.

### The fixture reproduced #130's defect inside the test that guards against it

C1 built its mid-line fragment like this:

```ts
const lastNl = Buffer.from(before, "utf8").lastIndexOf(0x0a);   // a BYTE index
fs.writeFileSync(tagPath, before.slice(0, lastNl + 1) + fragment); // a STRING slice
```

A byte offset used as a UTF-16 index — the whole of #130, in the fixture written to catch it.
And because every `cmd` in the fixture carries `→` and `—` by construction, the byte index
always EXCEEDED the string length, so `slice` returned the entire string and **the cut removed
zero characters**. Measured: `byteLength 654, length 646, lastNl 653`. The assertion "the
fixture really does end mid-line" passed on the appended fragment alone, having destroyed
nothing.

Rebuilt entirely in `Buffer` space, and the fixture now asserts it is SHORTER than what it cut
from — a property the broken version fails.

### C1b could not fail, against the exact behaviour it was written to pin

Round 3 made a crashed tag REBUILD rather than resume, because a resume replays a batch and
`dedupeClassifiedById` does not collapse id-less turns. C1b was written to pin that. It could
not: the fixture destroyed a trailing **heartbeat**, which leaves every `_meta.offset` intact,
so a cut-only daemon resumed from an offset equal to EOF, classified nothing new, and produced
byte-identical output. Every C1 and C1b assertion passed against the behaviour round 3 replaced.

Two changes make it discriminate, and both were needed:

- the fixture now destroys the **last `_meta.offset` line** — the line a real crash destroys,
  since `flushPending` appends the batch and then the marker — and asserts an earlier offset
  survives for a cut-only daemon to resume from;
- the session now carries a turn with **no message id**, because an identified turn collapses
  in `dedupeClassifiedById` and a replay is invisible.

**Measured RED** against a daemon with the escalation removed: `4 rows vs 3`, the id-less turn
counted twice, the money wrong.

### W3 still did not discriminate, after round 2 rewrote it for that reason

Round 2 rebuilt W3 because it never split a UTF-8 sequence. The rebuild made both stated
preconditions true — last line over one chunk, boundary byte a continuation byte — and the
answer was **still** insensitive to either, because the newline that resolves the scan sits in
the chunk starting at byte 0 and everything before it is ASCII. All the multi-byte content was
AFTER the last newline, where it cannot move the arithmetic. A decode-per-chunk scan returns 29
against a truth of 29.

Both lines now carry the dashes, and a third precondition is asserted: multi-byte content
**ahead of the resolving newline**. Against that fixture a decode-per-chunk scan returns 351
where the truth is 619.

### The S2 self-check added in round 3 matched nowhere in the file

Round 3 added a self-check because `bodyOf` has a fallback indistinguishable from working. Its
third assertion asked whether `pendingFragmentSize` was bound from `lastLineStartByte` — and
`pendingFragmentSize` is bound once, from `0`, so the regex matched nowhere in 104k characters.
True of the whole file, and it would have passed unchanged had `bodyOf` returned the whole file.
Replaced with two content checks that cannot be vacuous.

### Nothing gated the bundle against the source

The suite's behavioural half drives `bin/*.mjs` — gitignored build output — and its structural
half reads `bin/*.ts`. `tests/run.ts` does not build, and suites run sorted, so this one runs
before the only suite that does. Edit the daemon, run `bun run test` without building, and §E/R/C
green-light the OLD daemon while §S certifies the NEW source. That is round 1's RED procedure
happening by accident. **B0** now compares mtimes and fails first; verified by touching the
source and watching it fire.

### Three claims that were false, and one more shrink

| Claim | Where | What is true |
|---|---|---|
| "the file never shrinks" | `wtft-daemon-lib.ts` ×2 (one of them the `watchTagFile` JSDoc), `wtft-tag-format.md`, `CONTEXT.md` | a WRITE never shrinks it; a daemon STARTUP truncates to zero in three cases, and round 3's crash repair escalates to exactly that. The JSDoc sat fifty lines above the shrink branch and was a documented licence to delete it |
| `dedupeClassifiedById` "already collapses" a replay, so re-reading is free | `truncatePartialTail`'s docstring | it does not, which is why the caller escalates to a rebuild — round 3 refuted this 1,070 lines below and left the argument standing in the function it argues about |
| the first idle poll appends `{"_hb":{"first":<ts>}}` | the poll loop, eight lines above the call | both fields, always. A one-field first line would fail the width check and make an idle daemon append forever — the comment described something that would break the design beneath it |
| the file is whole JSONL "at every instant" | `upsertHeartbeat`'s docstring | true of that write, false of the file: a large append is not one `write(2)`, as the sibling file says where the incremental reader handles it |

### The disposal command had its roots wrong a second time

Round 3 found it searching only `~/git-projects` and added `~/.claude/projects`. It stopped one
root short: Pi transcripts live under `~/.pi/agent/sessions/`, so Pi tag files do too.
Re-measured across all three roots — **427 tag files, 119 corrupt, 2,833 mid-file broken
lines**, against the 327/96/2,562 this spec reported from one root. The conclusion is unchanged
and the damage is 10% larger. (Inert for this particular glob — Pi's newest tag version here is
v2.7.2, so there is no v2.8.1 to match — but it is the wrong scope to publish.)

### Filed, not fixed here

Two pre-existing defects the audit surfaced that are not #130's to fix:

- **#139** — `--watch` never re-arms its inotify watch, so a tag file replaced at the same path
  (`wtft --force`, or a version-bumped daemon's sweep) freezes the chart against a live daemon.
  #130's shrink branch does not help: after an unlink there are no events at all.
- **#140** — `initClassified` decides "has classified data" by substring, so a turn whose command
  mentions `_hb` or `_meta` discards the tag and forces a full re-parse. Bounded and
  self-correcting; the one place left that reads a tag line without parsing it.

### What the auditors checked and cleared

Recorded because "no finding" is most of the result and the reasoning is the deliverable: the
`pwrite` is a real `pwrite` (the fd is `r+`, not `a` — under `O_APPEND` the position is ignored
and every beat would weld); `first` is never 0 at the write (both call sites re-stamp it);
`appendTagFile`'s #512 contract survives the in-place attempt's `catch` because the append is
outside it; the torn-write argument holds; `lastSize` is correct on all five paths; the rebuild
loses nothing a re-parse cannot restore; `seedClassifiedTagFile` is correct at all three edges;
`allInteractions` has no stale capture; and `wtft-shared.ts` really is `export *`.

69 assertions.

## Macroscope, on PR #142 — the billed round, after three local ones

Three findings, all reproduced against the code before adopting, all fixed. Two of them are
gaps in fixes THIS SPEC already describes, which is the pattern the local audit round found
too: a repair narrows the defect rather than closing it.

### The shrink check could not see a rebuild (Medium)

`watchTagFile` re-seeded only when the tag file shrank BELOW the reader's offset. A daemon that
truncates and rebuilds before the `fs.watch` callback runs — one coalesced event, which is the
normal case and not a race anyone has to engineer — leaves the final size at or ABOVE the stale
offset, so the branch never fires.

Reproduced on a 3-record file rebuilt to 5: the reader kept `orig-1..3` (records from a file
that no longer exists), read from the stale offset into the MIDDLE of a line, dropped the
fragment, and silently lost `rebuilt-1..3`. **Wrong in both directions at once** — stale records
retained and real records lost — which is worse than the report described.

A generation check cannot do this job: truncate-and-rewrite keeps the same inode, so `stat.ino`
is unchanged. The bytes at the boundary are the only thing that distinguishes the two files.
`readPrefixSentinel` keeps the last 64 bytes of the consumed prefix and re-checks them on every
event; `watcherAction` is the pure decision it feeds. `null` means "could not read", which is
NOT "changed" — and it RE-SEEDS.

**That was wrong in the first cut of this fix, and Macroscope caught it on the second round.** The
reader idled on `null`, which looked like the conservative choice and was the opposite:
`prefixSentinel` is refreshed only where the offset moves, the offset moves only on the `read`
branch, and `read` is unreachable while the comparison is `null`. So a single failed sentinel read
**froze the watch permanently** — no error, no recovery short of a restart. Not transient, as the
report framed it: terminal.

The report proposed treating an unreadable sentinel as MATCHING. That removes the deadlock by
re-opening the stale-offset bug the sentinel exists to close, so it was fixed for the verified
reason instead: a whole-file re-read is always CORRECT, merely more expensive, and it refreshes the
sentinel on the way through. A file that cannot be read at all still costs nothing —
`seedClassifiedTagFile` reports `read: false`, the caller commits nothing, and that is a retry.

`G5` states the rule rather than the case: **no state with unread bytes may resolve to `idle`**,
since `idle` is the only action that does not advance the offset. `G5a` is its converse, so `G5`
cannot pass by `idle` having been deleted outright.

**This also let S4 stop lying.** S4 was two regexes over the library source requiring
`stat.size < lastReadOffset` to sit within 1600 characters of `seedClassifiedTagFile(`. Its
first assertion passed by matching a COMMENT, and the second failed against code that was
strictly more correct. Its stated excuse — driving it "would mean standing up the interactive
watch TUI and racing a daemon restart" — stopped being true the moment the decision became a
pure function. S4 is now behavioural, and G1 is the full decision table.

### A slowly-written record was re-read once per poll (High)

`lastSize` advanced only by whole lines, so a record still missing its newline left the offset
parked behind it and every poll re-allocated and re-read the entire partial record from disk.

**Measured**, replaying the function's own offset arithmetic against a 64 MiB record written in
1 MiB chunks, one chunk per poll:

| | total read | largest single allocation | amplification |
|---|---|---|---|
| before | 2,144 MiB | 64 MiB | **33.5x** |
| after | 64 MiB | 1 MiB | **1.0x** |

Quadratic to linear. The record is now carried between polls as BYTES rather than as a length,
so the offset advances every poll and no byte is fetched twice.

**The report's severity was wrong and the thread says so.** It claimed the daemon "throws at
`MAX_LENGTH`"; `buffer.constants.MAX_LENGTH` is **8,388,608 GiB** on this node, so that needs an
8-petabyte single line. Fixed for the verified reason, not the reported one.

Two behaviours could have broken and did not: R3 (a complete record with no trailing newline is
still counted) and R4 (1,830 one-byte writes across four poll intervals reach the same total,
$0.031500). One subtlety the rewrite had to preserve: the old code got its "the writer died"
re-evaluation **for free** by re-reading the same bytes forever. With the offset advancing, a
quiet poll returns early — so the function now falls through on a quiet poll whenever a fragment
is held, or a dead writer's last record would never be released. `A4` pins that.

### The mid-file guarantee does not hold for legacy files (Medium)

`docs/wtft-tag-format.md` told readers no mid-file line is ever malformed and that the #130
defect "cannot recur". True of a fixed writer; false of the files `getTagPath()` reaches through
its stale-version reader fallback, which were written by the defective one.

**Measured on this host 2026-09-17: 119 of 422 tag files carry a malformed mid-file line, 2,852
lines in total.** The guarantee is now scoped to files written at or after the fix, and names the
fallback as the exception, so a third-party reader knows to keep a per-line tolerance rather than
only a final-line one.


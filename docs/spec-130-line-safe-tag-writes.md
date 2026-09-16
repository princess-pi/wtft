# Spec #130 — the tag file is line-safe by construction

## The rule this issue installs

**Every write the daemon makes to a `.wtft-tag.*.jsonl` file leaves the file a whole
number of complete lines.** Not "usually", not "except on ENOSPC" — at every instant an
outside reader can observe, the file is valid JSONL.

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
| Every line in the file parses as JSON | no write ever ends mid-line |
| A reader woken by inotify sees only complete lines | every write lands on a `\n` boundary, so there is no observable mid-line state |
| Writes arrive no faster than one beat | `POLL_MS = 667` gates the heartbeat and throttles the classified flush |

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
decodes it whole (a complete line is complete UTF-8), and — when it is a heartbeat —
truncates to that same offset. `ftruncateSync` to a line boundary keeps the file valid
JSONL; a reader woken between the truncate and the append sees every earlier line intact and
simply no heartbeat yet.

**Defect 2 — consume only to the last newline, in bytes.**

```ts
const lastNl = buf.lastIndexOf(0x0a);
if (lastNl === -1) return [];          // nothing complete yet — lastSize unmoved
lastSize += lastNl + 1;                // BYTES, from a Buffer index
```

A partial trailing line is left for the next poll, which re-reads it whole. Searching the
`Buffer` rather than the decoded string is the same discipline as defect 1 and for the same
reason.

**And the invariant is made structural, not a habit.** `appendTagFile` is the single helper
every tag append goes through, so it is where "whole lines" is enforced: a batch that does not
end in a newline is a programming error at the call site, and it fails loudly there instead of
becoming a line some reader has to tolerate. S1 and S2 then read the source and fail on the two
shapes that caused #130 — an append that bypasses the helper, and a truncate to an offset that
did not come from `lastLineStartByte`. #130 survived months because every reader swallowed it
silently; a check that reads the writer is the only thing that would have caught it.

**Nothing is added to any reader.** `readClassifiedTagFile`, `readTagFileWithVerdict` and
`tagProvisionalFromContent` keep their existing `catch { continue; }`, which becomes dead
weight rather than load-bearing — and that is the point: the guarantee moves into the
writer, where one place owns it, instead of being re-derived by every reader.

## Tests

`tests/wtft-130-line-safe-tag-writes.test.ts`.

| # | Asserts |
|---|---|
| W1 | `lastLineStartByte` on an ASCII-only file returns the true byte offset |
| W2 | on a file whose earlier lines carry `→` and `—`, returns the true **byte** offset — the string-index version returns a smaller number |
| W3 | with a multi-byte sequence straddling the chunk boundary, still returns the true offset (no U+FFFD) |
| W4 | a file with no trailing newline: the last line starts after the last `\n` |
| W5 | an empty file returns 0; a single line with no newline returns 0 |
| W6 | a line longer than one chunk is handled — the scan widens rather than giving up |
| E1 | **the Closer.** The real daemon, driven against a session whose assistant text contains `→` and `—`, through enough beats to force several heartbeat upserts: **every line of the tag file parses as JSON**, and the classified totals survive |
| R1 | a session file whose last line is written in two halves across two polls: the interaction is counted once, not lost |
| S1 | no `fs.appendFileSync` reaches the tag path except through `appendTagFile` — the one helper that enforces the trailing newline |
| S2 | every tag truncate in the daemon cuts to a line boundary (an offset from `lastLineStartByte`) or to zero |

## RED, against the daemon that shipped

The suite was run against `bin/wtft-daemon.ts` as of the spec commit, before either fix:

```
FAIL E1 every one of the 16 tag lines parses as JSON
     {"_meta":{"swept":178959760425{"_hb":{"first":1789597604255,"last":1789597604925}}
     {"_meta":{"swept":17895976{"_hb":{"first":1789597605593,"last":1789597606261}}
FAIL E1 no line carries a second record welded onto it
FAIL E1 no two consecutive heartbeat lines — the cut fired
FAIL R1 the split turn is counted once the line completes   []
FAIL R1 and counted exactly once (0)
14 passed, 5 failed
```

Those welded lines are the corpus shape, produced live by the real daemon rather than by a
fixture: a `_meta.swept` marker severed mid-number with a heartbeat welded onto the stump.
After the fix the same run is 19 passed, 0 failed.

## Closer

Run the daemon against a transcript containing `→` and `—` for long enough to upsert the
heartbeat at least three times, then read the tag file: **every line parses as JSON, and the
line count equals the number of records written.** Today the file carries welded lines; when
this closes it carries none, and `tests/wtft-130-line-safe-tag-writes.test.ts` E1 fails if
that ever stops being true.

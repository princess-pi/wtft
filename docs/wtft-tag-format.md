# wtft Tag File Format

> **Authoritative source:** `serializeClassified()` and `classifiedToInteraction()` in
> `extensions/lib/wtft-daemon-lib.ts`. This document must stay in sync with both functions.
> `tests/wtft-tag-format.test.ts` gates the round-trip contract.

---

## 1. File location and naming

```
<sessionDir>/wtft-tags/<sessionBase>.wtft-tag.v<VERSION>.jsonl
```

- **`<sessionDir>`** — the directory containing the Claude Code transcript file (`.jsonl`)
- **`<sessionBase>`** — the transcript filename, `.jsonl` extension included (so a tag is `<uuid>.jsonl.wtft-tag.v<VERSION>.jsonl`)
- **`<VERSION>`** — the value of `WTFT_TAGGER_VERSION` exported from
  `extensions/lib/wtft-tagger-version.ts`; never hardcode this value

When a session has no current-version tag file, readers fall back to searching for
older-version files and re-parsing them from the raw transcript. A tag file at the
expected version path is always preferred.

---

## 2. JSONL format

The file is newline-delimited JSON. Each line is one complete JSON object, of one of the
kinds in §2a–§2e or a `_meta` marker (§6). Readers MUST handle every kind.

### The line-safety guarantee (#130)

**Every write the daemon completes leaves the file a whole number of complete lines**, and a
crash mid-append is repaired by the next daemon before its first write. So no MID-FILE line is
ever malformed.

It does **not** say a reader never meets a fragment: a large append is not one `write(2)`, so a
read concurrent with one can return the complete lines plus a partial tail. The guarantee is
about WHERE a fragment can be — only ever last — not about whether one exists. An earlier draft
of this sentence claimed "at every instant an outside reader can observe, the file is valid
JSONL", which the table immediately below it already contradicted.

A reader may therefore presume, without writing any code for the alternative:

| Presumption | What makes it true |
|---|---|
| Every line in the file at rest parses as JSON | no COMPLETED write ever ends mid-line, and a crash mid-append is repaired by the next daemon at startup |
| **No MID-FILE line is ever malformed** — *in a file written by a daemon at or after the #130 fix* | the only line any reader can find incomplete is the LAST one, and only while a write is in flight. A welded or truncated line in the middle of the file is the #130 defect, and a fixed writer cannot recreate it. **This does NOT extend to a file `getTagPath()` reaches through its stale-version reader fallback** (Macroscope, PR #142): those were written by the defective writer and the bad lines are already on disk. Measured on this host 2026-09-17: **119 of 422 tag files carry a malformed mid-file line, 2,852 lines in total.** A reader that follows only the row above will throw or silently skip records on one of them. `getCurrentVersionTagPath` is the writer-side path and never returns a stale name; the reader fallback is the one that can, so a third-party reader must keep a per-line tolerance, not merely a final-line one, whenever it opens a file whose version is not the current one |
| ANY reader concurrent with a write may see one partial line at the end | this holds for whole-file readers too, not only offset-tracking ones. A large append is not one `write(2)`, so a `readFileSync` can land inside it and return the complete lines plus a fragment. **Every reader keeps its final-line tolerance** — `classifiedInteractionsFromContent`'s `catch` is load-bearing, and `watchTagFile` consumes to the last `\n` and carries the remainder |
| Writes arrive in bursts no more often than one beat | `POLL_MS = 667` bounds how often a poll comes round — **not how many writes it makes.** One poll writes the classified batch, then `_meta.offset`, then a `_meta.swept` marker, plus one append per changed subagent transcript; `shutdown` writes outside the cadence entirely. Expect several notifications per beat |

**This is not the watcher being clever, and it cannot be.** `fs.watch`/inotify report **bytes**;
there is no "notify me on a newline" anywhere in the stack, and no watcher can be made
line-aware. So the guarantee is deliberately not "a reader never sees a fragment" — no writer
can deliver that against a concurrent read. It is that **a fragment can only ever be the last
thing in the file**, which is the case every reader already handles, and never a corrupted line
with valid lines after it, which is the case none of them can.

**Do not remove a reader's final-line `catch` on the strength of this contract.** An earlier
draft of this document said a whole-file reader "sees only complete lines", and the #130 spec
called those catches "dead weight rather than load-bearing". Both were wrong, and acting on
either would have broken every reader (#130 review round 2).

**The file is not purely append-only, and a WRITE never shrinks it** — a daemon *startup*
can, and does. The heartbeat is *upserted*:
when the last line is already a heartbeat of the same width, it is **overwritten in place** —
one `writeSync` at a `lastLineStartByte` offset, on the one descriptor already open. The size
does not change, so an offset-tracking reader's position can never go stale, and a torn write
leaves a mix of two heartbeats that have identical shape and identical length, hence still a
complete parseable line. The fixed width is what buys that: `first` and `last` are both
13-digit epoch milliseconds. A line of any other width — `{"_hb":"stop"}`, or a tag from some
future build — is not ours to overwrite, so it is appended beside instead.

The earlier design truncated the stale heartbeat and appended a fresh one through a second
descriptor. It left whole lines at every instant, but the file briefly got SHORTER, and an
offset-tracking reader only ever asks whether the file GREW (#130 review round 2). The rebuild
path still truncates — to zero, and a crash repair escalates to exactly that.

**So an incremental reader MUST handle the file getting shorter.** Not "may": a reader that
only asks whether the file grew is left with an offset past EOF across any daemon restart, and
it then resumes mid-line and silently loses every rebuilt line before that offset. An earlier
draft of this section argued a truncate to zero was harmless because "no reader can be
positioned inside it" — true of the CONTENT, false of the OFFSET, which is the thing that
breaks. `watchTagFile` re-seeds on `stat.size < lastReadOffset`, on a prefix that no longer matches or
cannot be read, and on any appended `_gen` record (§2e) — an append cannot retract lines already
read. A third-party incremental reader needs all four branches.

**Where the guarantee lives.** In the writer, once: `appendTagFile` refuses a batch that does
not end in a newline, a tag truncate may only cut to zero or to a `lastLineStartByte` offset,
and a daemon taking over a file left unterminated by a crashed predecessor cuts the fragment
off before its first write (`truncatePartialTail`) rather than welding onto it. `tests/wtft-130-line-safe-tag-writes.test.ts` §S reads the daemon source and fails on
either shape. It does **not** live in each reader — a guarantee re-derived by every consumer is
a guarantee nobody owns, which is how the defect behind #130 survived 2,562 corrupt lines
across 96 files without anything reporting it.

### 2a. Interaction line (primary kind)

The daemon writes one interaction line per classified turn. Fields:

| Key | Type | Presence | Meaning |
|-----|------|----------|---------|
| `t` | number | **required** | Unix timestamp in milliseconds |
| `c` | number | **required** | Cost in USD, rounded to 6 decimal places |
| `cat` | string | **required** | Pre-classified interaction category (see §3) |
| `f` | array | **required** | Files touched: `[{p: string, a: "w"\|"r"}, ...]` |
| `cmd` | array | **required** | Shell commands run during the turn |
| `id` | string | optional | Message ID — present when the harness provided one; used for cross-run dedup (§4) |
| `m` | string | optional | Model name |
| `in` | number | optional | Input tokens (absent ⟹ 0) |
| `out` | number | optional | Output tokens (absent ⟹ 0) |
| `cr` | number | optional | Cache-read tokens (absent ⟹ 0) |
| `cw` | number | optional | Cache-write tokens (absent ⟹ 0) |
| `rs` | number | optional | Reasoning tokens (absent ⟹ 0) |
| `sc` | number | optional | Server-side tool cost in USD, 6 dp (absent ⟹ 0) |
| `ws` | number | optional | Web search requests (absent ⟹ 0) |
| `wf` | number | optional | Web fetch requests (absent ⟹ 0) |
| `tl` | string | optional | Thinking effort level |
| `cb` | number | optional | Compaction tokens recorded before this turn |
| `tc` | array | optional | Tool-implied categories (subset of §3 values) |
| `ut` | `1` | optional | Unrecognized tool flag — set to `1` when present, absent otherwise |
| `ttl` | `"1h"\|"5m"` | optional | Observed prompt-cache TTL class |
| `miss` | `1` | optional | Cache miss flag (whole prefix re-primed) — set to `1` when present |
| `ir` | `1` | optional | Interrupted turn — set to `1` when present |
| `sp` | `1` | optional | DeepSeek surge-pricing flag — set to `1` when present |
| `s` | string | optional | Source: set on a line the daemon wrote from a child transcript, absent on the tag's own session's lines. The first 16 hex digits of the SHA-1 of the child transcript's path — relative to the session directory when it lies under it, absolute when it does not. A later `_gen` record for the same `s` supersedes the line (§2e) |

**Optional means absent, not null.** A field absent from the JSON object means its numeric
value is zero or its boolean value is false. Consumers must treat a missing field identically
to the corresponding zero/false value.

### 2b. Overhead line (meter-split)

When a compaction or recache meter-split applies, the daemon emits **two lines** for one
turn: a main interaction line and an overhead line. The overhead line has the same shape as
an interaction line but its `id` field takes the form `"<messageId>#oh"` — the literal
suffix `#oh` distinguishes it from the main line. The overhead line carries the
cache-write cost component (`cw` / `sc`) separately from the main line's work cost.

Consumers MUST NOT deduplicate an `#oh` line with its corresponding bare-id line.

### 2c. Heartbeat line (skip)

The daemon periodically writes heartbeat lines to signal liveness. Shape:

```json
{"_hb": {"first": 1789597603583, "last": 1789597604925}}
```

`first` is the millisecond timestamp at which the current idle run began and `last` the most
recent beat; `first === last` on the first beat of a run. The daemon also writes
`{"_hb": "stop"}` on shutdown, so the value is **not** always an object — a reader that
destructures it must handle the string.

The top-level `_hb` key identifies a heartbeat. Readers MUST skip all lines that carry
`_hb` — they are not interaction records.

### 2d. Fold record

```json
{"_fold": {"parent": "<session id>", "child": "<session id>", "s": "<source>"}}
```

`child` is the filename without `.jsonl` of a transcript the daemon folded into this tag (the
session id for a `claude -p` child or a Pi sibling, `agent-<name>` for a Task child): a Task child
under `<session>/subagents/`, a Pi sibling session, a `claude -p` child, or a session one of those folded in on a
model-tagged turn, at any depth. `parent` is the tag's own session id, the transcript filename
without `.jsonl`; readers key on `child` only. `s` is the source of the child transcript whose
parse implied the record (§2a), so a later `_gen` for that source supersedes it (§2e). Whenever a
child transcript parses, the daemon appends a record for each such session that source's current
generation has not recorded yet, after whatever lines that parse produced and in the same append. Two sources that
fold one session each record it. A reader treats the records as a set; a repeat is not an error.

A fold record is data, not a marker: a tag whose last data line is one reads unswept. The spawn
walk skips every recorded child as `in-self-total`, because its money is already in the tag's total
— on the arm that reads the tag; a run whose session log is absent passes an empty set instead
(`docs/spec-178-135-180-fold-records.md`, `docs/spec-176-134-135-report-honesty.md`).

### 2e. Generation record

```json
{"_gen": {"s": "<source>", "session": "<session id>"}}
```

Opens a new generation for the child transcript whose source is `s` (§2a). `session` is that
transcript's filename without `.jsonl`, for a human reading the file. **A line carrying `s` —
an interaction line or a fold record — counts only if no `_gen` record for the same `s` follows
it.** A line with no `s` always counts.

The daemon writes one on the first successful parse of a child transcript in each daemon life,
and on the first parse after that transcript rotated — read from the parse rather than from a
stat: the parse no longer produces a line the generation wrote, and that line carries no `id`, or
an `id` this parse no longer produces, so §4's dedup cannot collapse it. The record goes first in
the append, followed by every line of that parse and every fold record it
implies. A generation with no lines still writes its record, so a transcript rotated to empty
drops its old lines. Like a fold record, it is data: a tag whose last data line is one reads
unswept (`docs/spec-114-14-generation-records.md`).

---

## 3. Category values (`cat` field)

```
"plan" | "spec" | "research" | "web" | "grep"
| "code" | "tests" | "git" | "agents"
| "prompt" | "compaction" | "interrupted" | "overhead" | "other"
```

The daemon pre-classifies each turn and writes the category to `cat`. Readers should
use this stored value rather than re-classifying from files/commands. The `_cat` field
on the in-memory `Interaction` type carries the same value after deserialization.

---

## 4. Dedup rule (message ID)

Tag files are append-only and the daemon polls sources incrementally, so a single
billed harness message can produce more than one line — the harness re-emits assistant
messages with growing `usage` as streaming continues. Consumers MUST deduplicate lines
sharing the same bare `id` by keeping the **highest-cost copy**.

- Lines without an `id` are never deduplicated.
- Overhead lines (`id` ending in `#oh`) have a distinct id and MUST NOT be collapsed
  with their corresponding bare-id line.
- First-appearance order is preserved — dedup is a pure subtraction.

The canonical implementation is `dedupeClassifiedById()` in `wtft-daemon-lib.ts`.

---

## 5. Version migration

Readers locate a tag file by the current `WTFT_TAGGER_VERSION`. If no current-version
file exists, they fall back to older-version files and re-parse from the raw transcript.
A bump to `WTFT_TAGGER_VERSION` signals that stale tags must be re-parsed.

**Never hardcode the version number.** Always import `WTFT_TAGGER_VERSION` from
`extensions/lib/wtft-tagger-version.ts`.

---

## 6. Reader contract summary

1. Open the file at the expected version path (§1).
2. Drop every line that carries a source (`s` on an interaction line, `_fold.s` on a fold
   record) and is followed by a `_gen` record for the same source (§2e).
3. For each remaining line — a line that fails to parse, or whose fields are the wrong
   shape, is skipped on its own and never fails the read (the per-line tolerance §1 requires):
   - Skip if it has a `_hb` top-level key (heartbeat).
   - Skip if it has a `_gen` top-level key (§2e).
   - Skip if it has a `_meta` top-level key (the daemon's offset and sweep markers).
   - Collect `_fold.child` if it has a `_fold` top-level key (§2d).
   - Otherwise treat as an interaction line (or overhead line if `id` ends in `#oh`).
4. After reading all lines, apply dedup (§4) — keep the highest-cost line per bare `id`.
5. Treat absent optional fields as zero / false (§2a).

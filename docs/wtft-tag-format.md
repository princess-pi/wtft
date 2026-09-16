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
- **`<sessionBase>`** — the transcript filename without its `.jsonl` extension
- **`<VERSION>`** — the value of `WTFT_TAGGER_VERSION` exported from
  `extensions/lib/wtft-tagger-version.ts`; never hardcode this value

When a session has no current-version tag file, readers fall back to searching for
older-version files and re-parsing them from the raw transcript. A tag file at the
expected version path is always preferred.

---

## 2. JSONL format

The file is newline-delimited JSON. Each line is one complete JSON object. There are three
line kinds; readers MUST handle all three.

### The line-safety guarantee (#130)

**Every write the daemon makes leaves the file a whole number of complete lines.** At every
instant an outside reader can observe, the file is valid JSONL.

A reader may therefore presume, without writing any code for the alternative:

| Presumption | What makes it true |
|---|---|
| Every line parses as JSON | no write ever ends mid-line |
| A WHOLE-FILE reader woken by `fs.watch` sees only complete lines | every write lands on a `\n` boundary, so there is no observable mid-line state left behind |
| An OFFSET-TRACKING reader may see one partial line at the end | the writer guarantee kills truncation welds; it does **not** make a large append atomic against a concurrent read. Such a reader must consume to the last `\n` and carry the remainder — `watchTagFile` does |
| Writes arrive in bursts no more often than one beat | `POLL_MS = 667` bounds how often a poll comes round — **not how many writes it makes.** One poll writes the classified batch, then `_meta.offset`, then a `_meta.swept` marker, plus one append per changed subagent transcript; `shutdown` writes outside the cadence entirely. Expect several notifications per beat |

**This is not the watcher being clever, and it cannot be.** `fs.watch`/inotify report **bytes**;
there is no "notify me on a newline" anywhere in the stack, and no watcher can be made
line-aware. The guarantee is that the file is never in a state worth hiding. A reader woken
twice for one line still sees valid JSONL both times.

**The file is not purely append-only.** The heartbeat is *upserted*: when the last line is
already a heartbeat it is truncated off and a fresh one appended. That truncate cuts to a line
boundary (`lastLineStartByte`), so a reader landing between the cut and the append sees every
earlier line intact and simply no heartbeat yet — which is a true statement about the file. The
rebuild path truncates to zero, which is also a whole number of lines.

**Where the guarantee lives.** In the writer, once: `appendTagFile` refuses a batch that does
not end in a newline, and a tag truncate may only cut to zero or to a `lastLineStartByte`
offset. `tests/wtft-130-line-safe-tag-writes.test.ts` §S reads the daemon source and fails on
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
2. For each line:
   - Skip if it has a `_hb` top-level key (heartbeat).
   - Skip if it has a `_meta` top-level key (provisional marker written by readers).
   - Otherwise treat as an interaction line (or overhead line if `id` ends in `#oh`).
3. After reading all lines, apply dedup (§4) — keep the highest-cost line per bare `id`.
4. Treat absent optional fields as zero / false (§2a).

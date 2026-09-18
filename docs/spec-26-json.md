# spec-26 — `wtft --json`, the machine-readable session summary

**Issue:** [#26](https://github.com/princess-pi/wtft/issues/26) — *wtft has no
machine-readable mode at all.*

## Why

`wtft` produced every number as ANSI-decorated prose aimed at a terminal, with
`3.6k`-style abbreviation that **destroys** the exact value rather than merely
obscuring it. A consumer could not recover `3600` from the rendered table at
all. #443 needed to report "this total may still grow" and, with no structured
surface to put a field in, had to spend an exit code (9) on one bit.

`~/git-projects/CLAUDE.md` § *Agent-First Output* requires a machine-readable
mode on anything another program may read. This is that mode.

## The contract

`wtft --json` writes **exactly one JSON object** to stdout, followed by a single
newline, and nothing else on stdout: no ANSI, no abbreviation, no chart, no
table, no prose. It is not pretty-printed — the reader is a program, and `jq`
adds indentation back for free.

**Which stream carries what.** The object is the output, so every human sentence
goes to **stderr**. Two of those sentences — "session log not written yet" and
"no data yet" — are stdout on the rendered path, because there they *are* the
output; under `--json` they move to stderr. Each sentence that would have been
stdout is also carried in `notices[]`, so a consumer never has to read stderr to
learn why a number looks the way it does.

**`notices[]` is not a mirror of stderr, and does not claim to be.** Diagnostics
that belong to the run rather than to the report have no notice: the reap-warning
block (#130), the `--force` line, and the parser's unreadable-file warnings are
stderr-only. The rule is narrower and checkable — *nothing that would otherwise
have gone to stdout is lost* — rather than "stderr and notices agree", which
would be a promise about every future `console.error` in the tree.

Numbers are exact: integers for tokens, full-precision IEEE doubles for dollars.
Nothing is rounded, abbreviated, or padded on this path. `costUsd` is a float
**sum**, so the per-row figures add up to `total.costUsd` to within floating-point
accumulation error, not bit-exactly; the token fields have no such slack.

### Field names are API; prose is not

`schema`, every key below, and every exit code are **versioned interface**.
Changing one is a breaking change and bumps `schema`. A change to what a field
**means**, with its name and type unchanged, bumps `schema` too — a rename a
pinned consumer cannot see is still a rename. The strings inside
`notices[].text` are **prose** and may be reworded freely — a consumer that
branches on `notices[].code` is safe, one that matches `notices[].text` has no
contract.

### Schema `wtft/session@4`

```json
{
  "schema": "wtft/session@4",
  "session": {
    "path": "/home/u/.claude/projects/-x/abc.jsonl",
    "harness": "claude-code",
    "taggerVersion": "2.7.2",
    "tagPath": "/home/u/.claude/projects/-x/wtft-tags/abc.jsonl.wtft-tag.v2.7.2.jsonl"
  },
  "provisional": { "provisional": false, "reason": null },
  "total": {
    "costUsd": 0.0369,
    "inputTokens": 3600,
    "outputTokens": 270,
    "reasoningTokens": 0,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "untaggedCostUsd": 0
  },
  "models": [
    { "model": "claude-sonnet-4-6", "priced": true,
      "costUsd": 0.0369, "inputTokens": 3600, "outputTokens": 270,
      "reasoningTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0 }
  ],
  "categories": [
    { "category": "overhead", "costUsd": 0, "inputTokens": 0, "outputTokens": 0,
      "reasoningTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0 }
  ],
  "uncounted": { "compaction": 0, "recap": 0 },
  "spawned": {
    "schema": "wtft/spawn-tree@1",
    "descendants": 1,
    "edges": [ { "parent": "…", "child": "…", "mechanism": "pr-review-lens",
                 "ts": "2026-09-16T05:00:00Z", "label": "correctness", "depth": 1,
                 "resolved": true, "path": "/home/u/.claude/projects/-tmp-x/….jsonl",
                 "total": { "costUsd": 12.34, "inputTokens": 0, "outputTokens": 0,
                            "reasoningTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0 } } ],
    "unattributed": [],
    "depthCapped": 0,
    "maxDepth": 5,
    "malformedLedgerLines": 0,
    "ledgerError": null,
    "total": { "costUsd": 12.34, "inputTokens": 0, "outputTokens": 0,
               "reasoningTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0 }
  },
  "tree": {
    "costUsd": 12.3769,
    "inputTokens": 3600, "outputTokens": 270,
    "reasoningTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0
  },
  "subagents": [
    { "transcript": "…/subagents/agent-a641e532bfaae9903.jsonl",
      "meta": { "agentType": "general-purpose", "spawnDepth": 1,
                "description": "Audit the 116 test suite", "toolUseId": "toolu_01…",
                "model": "claude-sonnet-5" } },
    { "transcript": "…/subagents/agent-b7c2e910442d1f88.jsonl", "meta": null }
  ],
  "compaction": { "events": 0, "tokensFreed": 0 },
  "untaggedInteractions": 0,
  "notices": [ { "code": "provisional", "text": "…" } ]
}
```

| Key | Type | Meaning |
|---|---|---|
| `schema` | string | `"wtft/session@4"`. **Adding a top-level key bumps it — a NESTED one too** (Duppy, 2026-09-18, answer Y). `@2` is #116 (`spawned`, `tree`); `@3` is #141 (`subagents[]`); `@4` is #119's `total.untaggedCostUsd`; #89's `-s` no-TTY contract change is not a key change but rides the same bump (see Amendment 3). A consumer that only wants to know whether a given wtft can report subagents should still test for the `subagents[]` key, since absence is meaningful there (see below) and a version string cannot carry that. |
| `session.path` | string | The session `.jsonl` this run read. |
| `session.harness` | string \| null | Harness id whose parse adapter claims the session's first assistant turn — `"claude-code"`, `"pi"`, or an id registered out of tree through the #156 seam. `null` means **no claim**, and does not distinguish an empty session, one not written yet, a file that could not be read, and a format no registered harness understands. |
| `session.taggerVersion` | string | `WTFT_TAGGER_VERSION` of the running binary — a dotted version such as `"2.7.2"`, which is also what appears in `tagPath`. |
| `session.tagPath` | string | The classified tag file path resolved for this run: read when it exists, and on the `pending-session` and `no-data` arms the *expected* path — not evidence that a file was opened. |
| `provisional.provisional` | bool | **This run's** verdict — may this total still grow? Usually `readTagProvisional`'s answer, but the blind-spot scan can override it (see below), so do not read it as "what the tag file says". |
| `provisional.reason` | string \| null | A **closed three-value vocabulary**, unchanged since #457 and enforced by the `TagProvisionalReason` union: `"stale-version"` · `"unswept"` · `"subagent-unreadable"`, or `null` when settled. `--json` reports it; it did not widen it. **Issue #26's own wish-list names only two**, `stale-version` and `unswept`: it was written before #457 added the third, and this spec supersedes it on that point. Repeated review lenses have cited the issue's list as the contract; it is not. |
| `total.*` | number | Exact totals for **this session as the daemon tagged it** — its own turns AND the Task subagents blended into its tag file. That is why the spawn walk marks such an edge `in-self-total` and never adds it: `tree` would bill it twice. **Launcher-spawned descendants are not in here** (#116) — those are `spawned`, and `tree` is the sum. Cost is USD, the rest are token counts. |
| `spawned` | object | The recorded lineage (#116), schema `wtft/spawn-tree@1`. Present on every run, so an empty tree means "read the ledger, found nothing" rather than "nobody looked" — the same rule as `uncounted`. |
| `spawned.schema` | string | `"wtft/spawn-tree@1"`. Versioned separately from the document. |
| `spawned.edges[]` | array | One row per recorded edge reached from this session, in walk order. Always `parent`, `child`, `mechanism`, `ts`, `depth`, `resolved`, `path`, `total`; `label`, `model` and `cwd` only where the ledger line carried them, and `skip` only on an unresolved edge. `depth` is 1 for a direct child. |
| `spawned.total` | object | The sum over RESOLVED descendants. Unattributed and depth-capped edges are not in it. |
| `spawned.edges[].total` | object \| null | **`null`, never a zero object**, when the edge contributed nothing. A zero would say "this child cost nothing", which is a claim; `null` says we do not have one. `skip` names why: `not-found`, `unreadable`, `already-counted`, `already-seen-unresolved`, `in-self-total`, `depth-capped`. |
| `spawned.unattributed[]` | array | The gaps: `{child, mechanism, ts, label?, reason}` — no `depth`, no `path`, unlike an edge. `reason` is `not-found` (the lookup came back empty — absent, or somewhere unreadable; the walk cannot tell) or `unreadable` (a file found that would not parse). ONE ENTRY PER SESSION, not per edge. Not the same as cost zero. |
| `spawned.depthCapped` | number | Edges NOT FOLLOWED because of `spawned.maxDepth`, each also in `edges` with `skip: "depth-capped"`. Direct children are depth 1, so `maxDepth: 5` walks five generations and cuts the sixth. This counts the cuts, not the sessions behind them — a non-zero value means the tree is known to be partial. |
| `spawned.maxDepth` | number | The recursion bound in force for this run, stated so a reader never needs the constant to interpret a truncated tree. |
| `spawned.descendants` | number | Sessions whose cost is in `spawned.total`, **each counted exactly once**: a diamond or a cycle in the ledger contributes once, not twice. Lower than `edges.length` whenever an edge was skipped. |
| `spawned.malformedLedgerLines` | number | Ledger lines the reader could not use. A broken spawner shows up as a number rather than an absence. |
| `spawned.ledgerError` | string \| null | The ledger read FAILED, with the message. Without this field an unreadable ledger would serialise identically to "read it, this session spawned nothing" — the silent gap #116 exists to end, reintroduced inside its own fix. An *absent* ledger is not an error. |
| `tree.*` | number | **SELF + RESOLVED descendants**, as a field, so a consumer never adds two numbers and has to work out whether it double-counted. A **floor** whenever anything was not counted, under any of FOUR conditions: `spawned.unattributed` is non-empty, `spawned.depthCapped` is non-zero, `spawned.ledgerError` is non-null, or `spawned.malformedLedgerLines` is non-zero. The last two are the traps — an unreadable ledger sets none of the others, so a consumer checking only those reads a zeroed tree as a complete lineage; and a malformed line WAS a record, so its edge is lost with the count as its only trace. Checking `unattributed` alone reads a depth-truncated tree as complete. |
| `models[]` | array | One row per model id, **sorted by `costUsd` descending** — the same order and the same numbers as the rendered `--tokens` table's rows, un-abbreviated. `model` is the full id, never shortened. |
| `models[].priced` | bool | `isModelPriced(model)` — the `?` marker in the rendered table. `false` means **no rate card**, not "wtft guessed this row": a harness-native per-turn cost is used unchanged wherever the transcript records one, so a marked row's cost can mix provenance. |
| `categories[]` | array | One row per `CATEGORY_ORDER` entry, **always all fourteen, always in `CATEGORY_ORDER` order**, so a consumer can index by position. |
| `subagents[]` | array \| **absent** | #137. One row per subagent transcript `discoverSubagentSessionFiles` finds for this session — which is **both** patterns it knows: Claude Code Task children under `<session>/subagents/`, and Pi siblings claimed by a matching `parentSession` header. Only the first kind has a `.meta.json`, so a Pi row is a real subagent with `meta: null`. **Absent, not `[]`, whenever the answer would be incomplete** — whether discovery never ran, could not read a directory, or could not read a file. A consumer never needs to know which: absent means the answer cannot be trusted as complete. A partial answer omits the key too, so an array that is present is never partial. An empty array therefore always means "looked, found none" — never "nobody looked". Same rule as `uncounted`, opposite spelling, because this one has a meaningful absent state and that one does not. |
| `subagents[].transcript` | string | Always present. The child's `.jsonl`. **Listing a row is not a claim that its cost is in `total`** — this array is the CLI's own discovery of the session's children, independent of what the daemon tagged, so on the `no-data` arm the document can name children while `total.costUsd` is 0. Read `notices[]` before treating a row as priced. |
| `subagents[].meta` | object \| null | The `.meta.json` the harness writes beside a **Claude Code Task** transcript: `agentType` and `spawnDepth` always, and optionally `description`, `toolUseId`, `model`, `parentAgentId`, `isFork`. **`null` is a GAP, not a missing subagent** — the transcript is LISTED either way; it simply has no label. **Being listed here is not evidence that its cost is in `total`.** Discovery is a live filesystem read; counting is the tag file's business, written asynchronously by the daemon, and the two are independent. A transcript the daemon has not tagged yet appears here and is not yet in any total, and `meta` has no bearing on either. Pi children (which have no such file), and any harness release that stops writing one, land here — as does a file that exists but cannot be READ — that one also adds a `subagent-meta-unreadable` notice naming the file (#146), so an absent meta and an unreadable one can be told apart. `meta.model` is itself optional, so a null there is a gap too. Only `agentType` and `spawnDepth` are universal; `description` and `toolUseId` are absent on the Dynamic Workflow children, and a meta carrying just the two universal fields is still a meta. Counts move whenever a session spawns a subagent — `docs/spec-137-subagent-meta.md` carries one dated census rather than repeating ratios here. |
| `uncounted` | object | The #149 blind spot: events the harness bills and writes no `usage` for. Counted, never priced, and deliberately **not** in `total`. Scanned on **every** `--json` run, so a zero means "looked, found none" rather than "nobody looked" — with one narrower gap, **#94**: the scan drops unparseable session lines silently, so a zero can also mean "could not read part of it". Fixing that adds a field; it does not change this one. (A no-op only on the `pending-session` arm, where there is no file yet; the `no-data` arm has a real session file and can find real billables in it.) Along with `spawned` and `subagents[]`, one of the three parts of the document that do not come from the aggregation. |
| `compaction` | object | Compaction events seen and the tokens they freed — the rendered table's `Compaction:` line. Counted over **every** deduped interaction, tagged or not: it describes context freed, not spend, so the model-tag exclusion below does not apply to it. |
| `total.untaggedCostUsd` | number | `@4` (#119). The cost EXCLUDED from `total.costUsd` because it belongs to an untagged interaction (`untaggedInteractions` below) — sourced from the same per-interaction figures the bar chart bins for those turns. `total.costUsd + total.untaggedCostUsd` equals the chart's own running total within float accumulation error, the same tolerance "The one arithmetic guarantee", below, gives `costUsd`. |
| `untaggedInteractions` | int | Interactions excluded from `total.costUsd`/`models`/`categories` because they carry no model id (`(unknown)` or `<synthetic>`) — the rendered table's "(N untagged interactions skipped)", or, when *every* interaction is untagged, its "No model-tagged interactions found (N untagged)." Its cost is `total.untaggedCostUsd`, not zero. |
| `notices[]` | array | `{ code, text }`. `code` is API; `text` is prose. Codes: `pending-session`, `no-data`, `unpriced-model`, `provisional`, `subagent-meta-unreadable` (#146: one per `.meta.json` that exists and could not be read; an absent meta adds none). `auto-selected-session` was retired in `@4` (#89) — see Amendment 3: a machine caller now gets exit 10 instead of a silent auto-pick. |

### The one arithmetic guarantee

`sum(models[].X) === total.X` and `sum(categories[].X) === total.X` for every one
of the six `TokenTotals` fields — exactly on the five token fields, and within
float accumulation error on `costUsd`.

That holds because all three come from **one** aggregation over **one**
deduplicated interaction set, and because all three apply the same exclusion:
interactions with no model id are counted in `untaggedInteractions` and appear in
none of them; their cost is `total.untaggedCostUsd` (#119). `compaction` is the one field that does *not* apply that exclusion,
and it is not part of the guarantee.

A category the tag file names that this build does not know — `_cat` reaches the
classifier unvalidated, so a future tagger or a hand-edited tag can do this — is
folded into `other`. Dropping it would have been the silent option and would have
broken the guarantee with nothing to signal it; giving it a row of its own would
have broken the positional addressability `categories[]` sells.

**Server-side tool spend is inside `total.costUsd` (#90, direction A).** It was
not, until #90: `buildWtftLines` added `serverToolCost` to the chart's `web` bin
while `computeSessionSummary` summed `cost` alone, so the chart's running total,
the `--tokens` TOTAL row and this `total.costUsd` disagreed by the web-search and
web-fetch spend. The number under the word TOTAL now means what the word says,
and **the `--tokens` TOTAL a reader sees rose by the session's MODEL-TAGGED
server-tool spend** — the accepted consequence of A, recorded here rather than
discovered. Model-tagged, precisely: the addition sits inside the loop body an
untagged interaction never reaches, so it carries the same exclusion every other
number here carries.

It is attributed to the **`web`** category, which is where the chart puts it, so
the guarantee above still holds and a category row names the same category the
bars do. **Not the same number** — the chart bins every interaction while these
rows drop the untagged ones, and `categories[]` is session-wide where a bar is
per-bin. Per model it goes to the model that made the request. It carries **no
tokens**: server-side tool calls are billed per request, on a meter with no token
counts on it (#73), so the five token fields are untouched and their exact
equality is unaffected.

**The chart's total is still a different number, legitimately, for ONE reason:**
the bar chart bins *every* interaction, so it includes the untagged spend this
`total` excludes. That divergence predates #26 and remains — but as of `@4`
a machine consumer **can size it**: `total.untaggedCostUsd` carries exactly the
excluded cost, so `total.costUsd + total.untaggedCostUsd` equals the chart's own
running total. **#119**, closed by Amendment 3, is what added the field;
`untaggedInteractions` stays a plain count of how many turns contributed to it.

**`total.costUsd` changed meaning under an unchanged `schema`.** `wtft/session@1`
shipped with the old arithmetic, and a program pinned to it now sees the number
move with nothing to branch on — `notices[]` gains no code, and this document
declares its own prose non-contractual. Direction A was chosen knowing it was the
incompatible option; what it did not settle is whether the incompatibility gets a
machine-readable marker. **#120** settles it: see "Field names are API; prose is
not", above, and Amendment 1's note that `@2` already carries this change.

### The seam

`computeSessionSummary(interactions)` in `extensions/lib/wtft-renderer.ts` is the
single aggregation — the only *implementation* of the arithmetic, not the only
*call*. `renderTokenSummary` formats its result for a human; `buildSessionJson`
in `extensions/lib/wtft-json.ts` serialises the same result for a machine.
Neither reimplements it, so the prose and the JSON cannot report different
**numbers**. Since #116 a run calls it N+1 times — once for this session and
once per resolved descendant, inside `computeSpawnTree` — which is the same
function over different inputs, and is what lets `self` and `tree` be added.

Some things the human table prints have no direct JSON counterpart, because they
are ratios, labels and legends derived at render time rather than aggregate
facts: the per-model `Cache:` hit-rate line, the `Think:` budget-utilisation
line, the `?` fallback legend, and — since #116 — the SPAWNED block's row labels,
its `(skip)` text where a cost would be, and the ledger-error sentence. Every
number in that block is in `spawned`; the words around them are not.

Only the cache hit rate is fully recoverable:
`cacheReadTokens / (cacheReadTokens + cacheWriteTokens + inputTokens)`, all three
in the document.

`models[].priced` recovers **which** rows the legend marks. The legend's
per-model sentences do reach the document, one `unpriced-model` entry per model
in `notices[]`, each the same `describeFallbackPricing` text the rendered legend
prints. What is absent is the legend's layout and its mixed-provenance caveat,
which is a single sentence about the table as a whole and has no row to attach
to.

The **`Think:` percentage is not recoverable at all**, and cannot be: its
denominator is `--thinking-budget`, an input flag the document does not carry
and which `--json` ignores outright. A consumer gets `reasoningTokens` and
supplies its own budget.

`buildSessionJson` is otherwise a thin serialiser, with three departures, all
deliberate: `uncounted` is a separate scan of the session files and is passed in;
`spawned` is the ledger walk and is passed in; and `tree` is the one piece of
arithmetic the function performs itself, `treeTotals(summary.total,
input.spawned)` — an addition of two results of the aggregation above, which is
why it is not a fourth way of counting. `notices` is the only input with a
default; `uncounted` and `spawned` are required-not-defaulted, so an empty one
always means "looked, found none".

### Exit codes

`--json` does not change what any exit code means. It changes only what stdout
carries. The table lives in `docs/manifests/wtft-cmd.json`, which is what
`wtft --help` renders its **Exit codes** section from — one source, two surfaces.

| Code | Meaning | stdout under `--json` |
|---|---|---|
| **0** | A report was produced, including when there is nothing to report yet — a session file not written, or a tag with no classified data. Also the exit for the commands that run *instead* of a report (`--help`/`--why`/`--version`, `--list`/`--cleanup`/`--restart`/`--stop`, and `spawn-record`). | one JSON object for a report; the command's own output for the others |
| **1** | Error: no session found or selected, an invalid path, a daemon that could not be spawned or that died before producing data, a refused flag (`-p`), or an unhandled exception. The reason is on stderr. | nothing |
| **2** | `wtft spawn-record` only: the call was wrong — a missing or unknown flag, a flag with no value, a malformed session id, an oversized field. Nothing was appended. The report path never returns 2. | n/a |
| **3** | `wtft spawn-record` only: the record was valid and the ledger could not be written — usually a full disk. The edge is not recorded, so the child is **invisible** to the tree, not `unattributed` (which means an edge we have whose child we could not read). Any partial line left behind is reported as a counted `malformedLedgerLines` on the next read; nothing tries to repair it. | n/a |
| **9** | Provisional (#443): a report was produced in full, but the total may still grow under the daemon. `provisional.provisional` is `true` and `provisional.reason` names the condition. | one JSON object |
| **10** | `EXIT_SESSION_AMBIGUOUS` (#89): no interactive terminal, and either `-s <substring>` matched zero or several sessions, or no `-s` was given at all -- even when the picker's default scope (this worktree, last 20 minutes) holds exactly one session (#89, C2). Zero is included, which replaces the OLD exit 1 "no session found" for this no-`-s`/no-TTY case. Every candidate is named on stderr. | nothing |
| **130** | The interactive session picker was cancelled with `q` or Ctrl-C — the SIGINT convention (128+2), not a wtft-specific code. As of `@4` (#89), an interactive terminal still gets the picker under `--json` (drawn to stderr — see "Session selection" above), so `--json` DOES still return this when a human cancels it; it is exit 10 above, not 130, that `--json` cannot combine with a prompt. | n/a |

Codes 0 and 9 both carry a complete object; a consumer that wants only settled
numbers checks `$?` **or** `.provisional.provisional` and gets the same answer.

**One incompleteness has no exit code**, deliberately: a `spawned.ledgerError`
leaves `$?` at 0. Exit 9 means *this total may still grow under the daemon*, and
`provisional.reason` is a closed three-value vocabulary — widening either to
cover an unreadable ledger would change what a settled 0 means for every
consumer that has one. A reader who cares about lineage branches on the field.

**An empty report is still a report.** On the two empty paths every `total.*` is
0, `models[]` is `[]`, `categories[]` is still all fourteen zero rows, and
`notices[]` carries `pending-session` or `no-data`. A consumer never has to
branch on shape, only on values. `spawned` is read on those paths too: a session
log that is not written yet says nothing about whether the ledger holds edges for
it, and handing the builder a hand-made empty tree is how a `ledgerError: null`
gets claimed by a run that never opened the file.

`session.harness` is `null` on the `pending-session` arm, where there is no file
to ask. On the `no-data` arm the session file exists and may well name its
harness, so `null` is **not** a marker of emptiness — `notices[]` is that marker.

The exit code on these paths follows the same rule as everywhere else, so an
empty report from a provisional tag exits **9**, not 0, in *both* modes. Two
rounds of PR review were needed to get that right: the first found the `--json`
arms returning without setting the code, the second found the rendered arms
still falling through to `process.exit(0)` after the `--json` ones were fixed —
so the same session exited 0 under `wtft` and 9 under `wtft --json`.

**The verdict is scoped to what the run checked.** The exit code is otherwise
mode-invariant, with one honest exception: `subagent-unreadable` is discovered by
the `uncounted` scan, and a plain `wtft` run — no `--tokens`, no `--json`, data
present — never performs it. Such a session exits 0 there and 9 under the two
modes that do scan. That is deliberate, not an oversight: scanning on the default
path would put a full read of the session and every subagent transcript on the
commonest invocation of all, to detect a rare condition the run is not otherwise
looking for — the exact cost #443 chose read-then-render to avoid. The code
reports what the run actually checked. The *empty* paths are unaffected, and §9
of the suite pins that they agree.

**The blind-spot scan can change the verdict.** An unreadable subagent session
file discovered during the `uncounted` scan sets `provisional.reason` to
`subagent-unreadable` regardless of what the tag file itself says, so
`provisional` in the document is this run's verdict, not merely the tag's.

### Interaction with other flags

**Suppressed.** Every rendering flag: `--tokens`, `--other`, `--pad`, `--emoji`,
`--interval`, `--limit`, `--bucket`/`--cumulative`, `--ticks`, `--timezone`.
Passing one alongside `--json` is not an error and never crashes; the JSON object
is what you get. Which flag "wins" in any *other* contradictory pairing is not
pinned by this spec or by its suite.

**Not suppressed — these run instead of a report, and `--json` does not reach
them.** Each returns before the `--json` branch, and the exit-code table's row 0
covers them:

| Flag | What `--json` alongside it does |
|---|---|
| `--help`, `--why`, `--version` | prints that text on stdout, exit 0, no object |
| `--list`, `--cleanup`, `--restart`, `--stop` | prints the daemon output on stdout, exit 0, no object |
| `--watch` | enters the live re-render loop and never returns until SIGINT; no object |
| `-p`/`--pager` | refused on stderr, exit 1, stdout empty |

Giving those five a machine-readable mode is real work with its own contract —
`--list` in particular — and is **#92**, filed rather than half-done here.

**`--force` still does its work.** `-F` kills the daemon and deletes the tag files
before this branch is reached, so `--json -F` re-parses exactly as the rendered
path would.

**Session selection, as of `@4` (#89 — see Amendment 3 for the full contract).**
This paragraph described `@1`–`@3`'s behaviour — `--json` never prompted, and
with several sessions discovered and no `-s` it silently took the newest,
recording an `auto-selected-session` notice — and that behaviour is retired.
Today: an interactive terminal still gets the scoped session picker even under
`--json` (drawn to stderr, so stdout stays one clean object, and `q`/Ctrl-C
still exits 130). With **no** interactive terminal, wtft selects only when
`-s` matches exactly one session, and otherwise exits `EXIT_SESSION_AMBIGUOUS`
(10), naming every candidate on stderr and nothing on stdout. That includes no
`-s` with exactly one session in the default scope (#89, C2). A caller wanting
determinism still passes `-s`; on a non-interactive caller it is now required
whenever more than one session could match.

**`--json` is CLI-only**, in the sense that the Pi extension never reads it: the
parser is shared, so the flag is accepted there, but `extensions/wtft.ts` never
destructures `json` and no code path could observe it. A TUI widget has no stdout
to write an object to.

## Closer

```console
$ node bin/wtft.mjs -s <fixture> --json \
    | jq -e '.schema == "wtft/session@4" and (.total.outputTokens|type) == "number"'
```

exits 0, and `tests/wtft-26-json.test.ts` asserts, on a fixture, in eleven
sections:

1. **§1** stdout is exactly one parseable JSON object, carrying the schema the
   module exports, with no ANSI escape byte in it and nothing before or after it.
2. **§2** every cell of the rendered `--tokens` table's `TOTAL` row *and* of each
   per-model row equals the corresponding JSON field once abbreviated by the
   table's documented rule — so the prose and the JSON cannot drift. The fixture
   carries two models, one of them unpriced, so `priced` is pinned in both
   directions and `models[0]` is not numerically identical to `total`.
3. **§3** `sum(models[]) === sum(categories[]) === total`, field by field, and
   `categories[]` is all fourteen names in the documented order — compared
   against a literal written out in the suite, not against the imported
   `CATEGORY_ORDER`, which would compare the array to itself.
4. **§4** stdout is still one parseable JSON object on the **provisional** path;
   that run exits 9 with `provisional.provisional === true`; the sentence is on
   stderr *and* in `notices[]` and on neither is it on stdout; and a second
   fixture pins `stale-version` so `reason` is a vocabulary rather than one
   string.
5. **§5** the session identity fields, and `uncounted`/`compaction` present with
   both members rather than absent.
6. **§6** `--json` beside each rendering flag the manifest's `--json` entry
   names as suppressed (`--tokens`, `--other`, `--pad`, `--emoji`/`--no-emoji`,
   `--bucket`/`--cumulative`, `--interval`, `--limit`, `--ticks`, `--timezone`)
   yields an object and does not crash. Which flag wins is deliberately not
   pinned.
7. **§7** every exit code the CLI can return — scanned from `bin/wtft.ts` **and**
   `extensions/lib/session-selector.ts`, which is where 130 lives — appears in
   the manifest table, and `wtft --help` renders that table.
8. **§8** an *empty* report obeys the exit-code contract too: a provisional one
   exits 9 and a settled one exits 0, asserted in both directions so the claim
   cannot pass by both sides being false.
8b. **§8b** a session file that was never written is *late, not broken* (#308):
   one object, a `pending-session` notice, `provisional: false`, exit 0, and a
   zeroed blind spot meaning "nothing to scan" rather than a guess.
8c. **§8c** the `#443` stderr line reaches every arm — the empty `--json` ones
   included, which used to exit 9 with nothing a human could read — and appears
   **exactly once**, never twice on a full report.
9. **§9** the rendered path and `--json` return the **same** code on the same
   state, empty or not — each mode against its own fresh fixture, because the
   first run's daemon repairs the tag and a second run against it would
   legitimately differ.

## Reconciliation

Findings from the fresh-context audit run at the **Code & Spec Approved** step.
Rows marked *pre-existing* are drift this branch surfaced rather than caused;
file-level scope says fix or file, and the Action column says which.

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| `docs/manifests/wtft-cmd.json` | had no exit-code table at all | `bin/wtft.ts` exits 0, 1, 9; `session-selector.ts` exits 130 | ✅ `wtft-26-json.test.ts` §7 | Added `exitCodes` (0/1/9/**130**), rendered by `--help` |
| `bin/wtft.ts` under `--json` | "exactly one JSON object on stdout" | `selectSessionPrompt` `console.log`s its candidate list to **stdout** before the object, and exits 130 on Ctrl-C | ✅ `wtft-26-json.test.ts` §1, §7 | **Code fixed** (`@1`, historical): `--json` never prompts; takes the newest, notice `auto-selected-session`. **Superseded by `@4` (#89) — see Amendment 3**: `--json` now DOES prompt on an ambiguous population with an interactive terminal (drawn to stderr), the `auto-selected-session` notice is retired, and the no-TTY case is exit 10, not a silent auto-pick. Left as written rather than rewritten, since this row records what `@1` actually fixed at the time (pr-review round 3, Medium: an earlier state of this row read as a current claim). |
| `extensions/lib/wtft-renderer.ts` `computeSessionSummary` | `sum(categories) === total` | `_cat` reaches `classifyInteraction` unvalidated, so an unknown category was dropped from `categories[]` | ✅ `wtft-26-json.test.ts` §3 | **Code fixed**: folded into `other` |
| `extensions/lib/wtft-json.ts` | `uncounted` defaulted to zeros when a caller skipped the scan | "not scanned" was indistinguishable from "none found" | ✅ `wtft-26-json.test.ts` §5 | **Code fixed**: scanned on every path |
| `extensions/lib/wtft-parser.ts` | — | this branch inserted `detectSessionHarness`'s docstring **between** `scanUncountedBillables`'s docstring and its function, orphaning it | n/a | **Code fixed**: moved below |
| `bin/wtft.ts` `@package princess-pi-tools` | *pre-existing* — names the pre-extraction package | `package.json` is `@princess-pi/wtft` | n/a | Fixed |
| `bin/wtft.ts` "cost auditing tool for Pi Coding Agent session logs" | *pre-existing* — `--harness auto` is the default | `wtft-cli-shared.ts` defaults `harnessOption` to `auto` | ✅ `wtft-issue-156-harness-seam.test.ts` | Fixed |
| `bin/wtft.ts` "Nothing in this repo invokes this CLI and inspects `$?`" | *pre-existing* — the grep skipped `tests/` | `tests/wtft-513-exit9-caller-guard.test.ts` exists because `wtft-auto-fit` failed on exit 9 | ✅ `wtft-513-exit9-caller-guard.test.ts` | Corrected, kept as history |
| `bin/wtft.ts` "used from four places" / "Memoised: `--tokens --json` … twice" | this branch's own new comments, both wrong | four call sites, none of them the `--tokens` renderer, which is unreachable under `--json` | n/a | Fixed |
| `bin/wtft.ts` "2 daemon beats", `showReapWarnings` docstring | *pre-existing* — names an undefined unit; silent on the truncate | literal 1400 ms / 667 ms; the function truncates `reap.log` | n/a | Fixed |
| `docs/manifests/wtft-cmd.json` `--limit` "(default: 10)" | *pre-existing* — false for the CLI | `bin/wtft.ts` substitutes 100 when `hasLimit` is false | ✅ `wtft-74-budget-flag-parsing.test.ts` | Fixed: names both |
| `docs/manifests/wtft-cmd.json` `--width` "(default: 240)" | *pre-existing* — the CLI never reads `opts.width`, and 240 is not a default anywhere | no reference to `opts.width` in `bin/wtft.ts`; parser default is 80; 240 is the Pi extension's `Math.min(…, 240)` **cap** | ✅ `wtft-74-budget-flag-parsing.test.ts` | Fixed: extension-only, default 80, 240 named as the cap |
| `tests/wtft-26-json.test.ts` §1 | the spec said §1 asserts "no ANSI escape byte" | a round-4 edit deleted the assertion and kept its explanatory comment, so the documented coverage was not real for two rounds | ✅ restored, and it is the assertion again rather than a comment about one | Fixed |
| `docs/manifests/wtft-cmd.json` `-S/-H`, `-p`, `--emoji`, `-s` | *pre-existing* — silent on CLI inertness, the exit-1 refusal, CLI emoji, and pending paths | `wtft-cli-shared.ts`, `bin/wtft.ts` | ✅ `wtft-74-budget-flag-parsing.test.ts` §4, `wtft-issue-153-pager-cli.test.ts`, `wtft-308-lagging-session.test.ts` | Fixed |
| `docs/spec-149-compaction-cost-scope.md` | "Wired into the non-watch `--tokens` path only" | the scan now runs on every `--json` run, and can downgrade the verdict | ✅ `wtft-26-json.test.ts` §5 | Fixed |
| `docs/spec-160-161-162-wtft-spec-surfaces.md` | "the manifest's 25 `usage` entries" | this branch made it 27 | ✅ `wtft-spec-alignment.test.ts` | Fixed |
| `docs/spec-308-lagging-session.md` | the pending/no-data sentences go to stdout | true only without `--json`; and its `bin/wtft.ts:NNN` citations no longer resolve | ✅ `wtft-308-lagging-session.test.ts` | Fixed: mode named, citations made construct-anchored |
| `docs/wtft-incremental-render-spec.md`, `tests/wtft-443-cli-exit-9.test.ts` header, `bin/wtft.ts` | "`wtft` has no `--json`, no `--porcelain`" | this branch adds `--json` | ✅ `wtft-26-json.test.ts` §4 | Fixed in all three |
| `tests/wtft-443-cli-exit-9.test.ts` | "says nothing about being provisional" asserted against `execFileSync`'s stdout | the sentence is only ever on stderr, so it could not fail in any outcome | ✅ itself, now on both streams | **Test fixed**: `spawnSync` |
| `tests/wtft-26-json.test.ts` | `categories[]` vs the imported `CATEGORY_ORDER`; a hardcoded `EXIT_PROVISIONAL = 9`; an exit-code scan of one file | all three compare the code to itself, or miss 130 | ✅ itself | **Test fixed** |
| `CONTEXT.md` | no term for the new output mode; CLI entry listed two CLI-only modes | `--json` is a third | ✅ `wtft-75-doc-claims.test.ts` | Fixed: **JSON mode** and **Provisional** entries added |

**#90 was filed here and has since been FIXED** (direction A, 2026-09-16):
`computeSessionSummary` adds `serverToolCost`, so the chart's running total, the
`--tokens` TOTAL row and `total.costUsd` are one number. Gate:
`tests/wtft-90-total-includes-server-tool-cost.test.ts`, which drives all three
surfaces through the CLI — the comparison whose absence let the divergence
survive. See *The one arithmetic guarantee* above for the rule now in force.

**Filed rather than fixed** — pre-existing, out of this branch's scope, each with
a consequence named in its issue:

- **#91** — `parseWtftCliArgs` silently ignores unknown flags and malformed
  values, so a typo'd `--jsonn` renders a full ANSI chart and exits 0. `--json`
  is what makes this dangerous rather than untidy.
- **#92** — the daemon-management commands have no machine-readable mode;
  `--json` does not reach them, and this spec documents that rather than
  half-implementing it.
- **#93** — a sweep of `wtft-renderer.ts` docstrings that bind to nothing or to
  the wrong symbol, describe retired behaviour, or keep dead fields alive.

---

## Amendment 1 — `wtft/session@2`: `spawned` and `tree` (#116, 2026-09-16)

`@2` adds two keys and pins the meaning of one that was already there.

**`total` means SELF, and always did.** #116 moved no money into or out of it.
A launcher-spawned session — a `pr-review` lens, a `herdr agent start` child —
has never been in it and still is not. What changed is that the document now
*says so*, and carries the descendant money beside it under its own name.

**Why beside it rather than folded in.** Measured on one real session, the
descendants were $69.68 against a self of $70.33: folding would have roughly
doubled a number the reader already trusts, with nothing in the document saying
which half was which. The #149 `uncounted` block set the precedent — a quantity
the reader has not seen before arrives labelled. Whether `total` should ever
absorb the tree is a separate decision that needs the interaction-level
attribution rework in #107 / #14 / #94 first.

**Why this bumps `schema` when #90 did not.** #90 changed `total.costUsd`'s
meaning under an unchanged `@1` and this spec records that as the mistake it
was (see "**`total.costUsd` changed meaning under an unchanged `schema`**",
above, and #120). Adding keys is the documented bump condition, and a consumer
pinning `@1` gets to notice rather than to silently read a document with a
shape it does not know.

**`@2` also carries #90's change of meaning to `total.costUsd`.** #90 landed
before this amendment shipped, so no consumer ever saw the old arithmetic under
`@2` — a program that bumps from `@1` to `@2` picks up the corrected number
along with `spawned` and `tree`, even though the meaning change is not why `@2`
exists.

Ledger format, writer, walk and failure modes: `docs/spec-116-spawn-ledger.md`.

## Amendment 2 — `wtft/session@3`: `subagents[]` (#141, 2026-09-16)

`@3` adds one key, and it is the first key in this document whose **absence is
part of its contract**.

**Why it bumps.** Amendment 1 set the rule — *adding keys is the documented bump
condition* — after #90 changed a meaning under an unchanged `@1` and this spec
recorded that as the mistake it was. `subagents[]` is a new top-level key, so it
bumps, on that rule and not on a fresh judgement. This branch originally wrote
the opposite rule ("adding a top-level key does not bump") and added the key
under `@1`; #116 merged first and settled the question the other way. The rule
now has one spelling.

**Absent ≠ `[]`, and this is the point of the field.** Every other block here is
present on every run, so an empty one means "looked, found none". This one is
OMITTED whenever the answer would be incomplete, which makes `[]` an
unambiguous "looked, found none" instead of a value that also has to cover
"nobody looked". A consumer testing for the key learns whether discovery ran; a
consumer reading the array learns what it found. A version string cannot carry
that distinction, which is why `schema` is not the way to ask.

**`meta: null` is a gap, not a missing subagent.** The transcript is listed and
its cost accounted for by the tag file independently — `meta` neither causes nor
evidences that. Only Claude Code Task children have a `.meta.json`;
Pi siblings matched by `parentSession` are real subagents with no label.

Discovery, the `.meta.json` contract, and the 493-file census behind the
required-field set: `docs/spec-137-subagent-meta.md`.

## Amendment 3 — `wtft/session@4`: `total.untaggedCostUsd`, and the `-s` no-TTY contract change (#89, #119, 2026-09-18)

`@4` carries two changes at once, landing in one branch and one bump — the
scoped-picker redesign (#89) and the untagged-cost field (#119) were decided
together and shipped together. Full behaviour list:
`docs/spec-89-scoped-picker.md`.

**`total.untaggedCostUsd` is a NESTED key, and it bumps `schema` on its own
merits (Duppy, 2026-09-18, answer Y).** Amendment 1's "adding keys is the
documented bump condition" did not say top-level only; this amendment is what
makes that explicit, because #119 is the first key this document has added one
level down rather than at the top. `total` itself was already present on every
run, so a consumer reading an unversioned `total.costUsd` sees no shape change
at all — only a consumer that iterates `total`'s own keys, or that assumes
`total` is a plain `TokenTotals` (five token fields, `costUsd`), would notice
anything moved. `schema` is the only way to ask this, same as every field
addition before it.

**Where the field's value comes from** — decided 2026-09-18, and measured the
same day: the parser already prices every turn by model and by date (intro
rates, surge windows) and bakes the result into the tag file's `c`. An untagged
turn carries no real model id (`<synthetic>` or none), so it is priced at the
default fallback rate like any unpriced model; across 55 untagged tag lines in
25 tag files on the real corpus, every one measured `c: 0`, and the #119 test's
fixture gives one real usage and so a non-zero `c`. `total.untaggedCostUsd` sums that same `c` (`i.cost` once parsed) for
every untagged interaction, **plus `i.serverToolCost` when present** — the
`serverToolCost` half is this spec's own addition to the decision's wording,
not measured on the corpus (nothing there carries it), added so the closer
below holds **structurally**, not merely because every measured case happens to
be zero. `docs/spec-89-scoped-picker.md` U2 records the same reasoning.

**Closer:** on a fixture with one `<synthetic>` turn among tagged ones — the
exact shape `tests/wtft-90-total-includes-server-tool-cost.test.ts` TEST 5
built and, at the time, could not assert against —
`total.costUsd + total.untaggedCostUsd` equals the chart's own running total,
to within half a cent: the comparison scrapes the chart's own two-decimal
`formatCost` display, the same tolerance `tests/wtft-90-…`'s own chart/TOTAL
comparisons use. `tests/wtft-119-untagged-cost.test.ts` is
that assertion.

**`untaggedInteractions` is unchanged** — still a plain count, per #119's
direction B (the compatible, additive option; direction A would have replaced
it with `{ interactions, costUsd }` and was not chosen).

**The `-s` no-TTY contract change (#89, E3/E4).** Before `@4`, `--json` with no
interactive terminal and more than one candidate auto-selected the newest and
raised an `auto-selected-session` notice. `@4` retires both the notice code and
the behaviour: with no interactive terminal, wtft selects only when `-s
<substring>` matches EXACTLY one session; zero or several exit
`EXIT_SESSION_AMBIGUOUS` (10) instead, naming every match on stderr, with
nothing on stdout — the same "under `--json`, stdout carries nothing" contract
exit 1 already carries for an error. `notices[]`'s vocabulary shrinks by one
code as a result: `pending-session`, `no-data`, `unpriced-model`,
`provisional`. This is a genuine behaviour change under a bumped `schema`
rather than a silent one, which is the whole reason `@3` → `@4` exists.

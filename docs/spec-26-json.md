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
Changing one is a breaking change and bumps `schema`. The strings inside
`notices[].text` are **prose** and may be reworded freely — a consumer that
branches on `notices[].code` is safe, one that matches `notices[].text` has no
contract.

### Schema `wtft/session@1`

```json
{
  "schema": "wtft/session@1",
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
    "cacheWriteTokens": 0
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
  "compaction": { "events": 0, "tokensFreed": 0 },
  "untaggedInteractions": 0,
  "notices": [ { "code": "provisional", "text": "…" } ]
}
```

| Key | Type | Meaning |
|---|---|---|
| `schema` | string | `"wtft/session@1"`. Bumped when any key below changes shape. |
| `session.path` | string | The session `.jsonl` this run read. |
| `session.harness` | string \| null | Harness id whose parse adapter claims the session's first assistant turn — `"claude-code"`, `"pi"`, or an id registered out of tree through the #156 seam. `null` means **no claim**, and does not distinguish an empty session, one not written yet, a file that could not be read, and a format no registered harness understands. |
| `session.taggerVersion` | string | `WTFT_TAGGER_VERSION` of the running binary — a dotted version such as `"2.7.2"`, which is also what appears in `tagPath`. |
| `session.tagPath` | string | The classified tag file this run read. |
| `provisional.provisional` | bool | The `readTagProvisional` verdict — may this total still grow? |
| `provisional.reason` | string \| null | `"stale-version"` · `"unswept"` · `"subagent-unreadable"`, or `null` when settled. |
| `total.*` | number | Exact session totals. Cost is USD, the rest are token counts. |
| `models[]` | array | One row per model id, **sorted by `costUsd` descending** — the same order and the same numbers as the rendered `--tokens` table's rows, un-abbreviated. `model` is the full id, never shortened. |
| `models[].priced` | bool | `isModelPriced(model)` — the `?` marker in the rendered table. `false` means **no rate card**, not "wtft guessed this row": a harness-native per-turn cost is used unchanged wherever the transcript records one, so a marked row's cost can mix provenance. |
| `categories[]` | array | One row per `CATEGORY_ORDER` entry, **always all fourteen, always in `CATEGORY_ORDER` order**, so a consumer can index by position. |
| `uncounted` | object | The #149 blind spot: events the harness bills and writes no `usage` for. Counted, never priced, and deliberately **not** in `total`. Scanned on **every** `--json` run — including the empty ones, where the scan is a no-op — so a zero always means "looked, found none", never "nobody looked". This is the one part of the document that does not come from the aggregation. |
| `compaction` | object | Compaction events seen and the tokens they freed — the rendered table's `Compaction:` line. Counted over **every** deduped interaction, tagged or not: it describes context freed, not spend, so the model-tag exclusion below does not apply to it. |
| `untaggedInteractions` | int | Interactions excluded from `total`/`models`/`categories` because they carry no model id (`(unknown)` or `<synthetic>`) — the rendered table's "(N untagged interactions skipped)", or, when *every* interaction is untagged, its "No model-tagged interactions found (N untagged)." |
| `notices[]` | array | `{ code, text }`. `code` is API; `text` is prose. Codes: `pending-session`, `no-data`, `unpriced-model`, `provisional`, `auto-selected-session`. |

### The one arithmetic guarantee

`sum(models[].X) === total.X` and `sum(categories[].X) === total.X` for every one
of the six `TokenTotals` fields — exactly on the five token fields, and within
float accumulation error on `costUsd`.

That holds because all three come from **one** aggregation over **one**
deduplicated interaction set, and because all three apply the same exclusion:
interactions with no model id are counted in `untaggedInteractions` and appear in
none of them. `compaction` is the one field that does *not* apply that exclusion,
and it is not part of the guarantee.

A category the tag file names that this build does not know — `_cat` reaches the
classifier unvalidated, so a future tagger or a hand-edited tag can do this — is
folded into `other`. Dropping it would have been the silent option and would have
broken the guarantee with nothing to signal it; giving it a row of its own would
have broken the positional addressability `categories[]` sells.

**The chart's total is a different number, legitimately, for two reasons.** The
bar chart bins *every* interaction, so it includes the untagged spend this
`total` excludes; and `buildWtftLines` adds `serverToolCost` to its `web` bin,
which no summing of per-interaction `cost` reaches. Both predate #26 — the
rendered `--tokens` table has always summed `cost` alone — and #26 deliberately
did not change the arithmetic, only gave it a second reader. The gap is filed as
its own issue rather than fixed here, because fixing it changes the human table's
numbers.

### The seam

`computeSessionSummary(interactions)` in `extensions/lib/wtft-renderer.ts` is the
single aggregation. `renderTokenSummary` formats it for a human;
`buildSessionJson` in `extensions/lib/wtft-json.ts` serialises it for a machine.
Neither reimplements the arithmetic, so the prose and the JSON cannot report
different **numbers**.

Three things the human table prints have no JSON counterpart, because they are
ratios and legends derived at render time rather than aggregate facts: the
per-model `Cache:` hit-rate line, the `Think:` budget-utilisation line, and the
`?` fallback legend. A consumer recomputes the first two from fields the document
already carries; the third is `models[].priced`.

`buildSessionJson` is otherwise a pure serialiser — every number it emits comes
from the aggregation, with the single exception of `uncounted`, which is a
separate scan of the session files and is passed in.

### Exit codes

`--json` does not change what any exit code means. It changes only what stdout
carries. The table lives in `docs/manifests/wtft-cmd.json`, which is what
`wtft --help` renders its **Exit codes** section from — one source, two surfaces.

| Code | Meaning | stdout under `--json` |
|---|---|---|
| **0** | A report was produced, including when there is nothing to report yet — a session file not written, or a tag with no classified data. Also the exit for the commands that run *instead* of a report (`--help`/`--why`/`--version`, `--list`/`--cleanup`/`--restart`/`--stop`). | one JSON object for a report; the command's own output for the others |
| **1** | Error: no session found or selected, an invalid path, a daemon that could not be spawned or that died before producing data, a refused flag (`-p`), or an unhandled exception. The reason is on stderr. | nothing |
| **9** | Provisional (#443): a report was produced in full, but the total may still grow under the daemon. `provisional.provisional` is `true` and `provisional.reason` names the condition. | one JSON object |
| **130** | The interactive session selector was cancelled with `q` or Ctrl-C — the SIGINT convention (128+2), not a wtft-specific code. `--json` never prompts, so it never returns this. | n/a |

Codes 0 and 9 both carry a complete object; a consumer that wants only settled
numbers checks `$?` **or** `.provisional.provisional` and gets the same answer.

**An empty report is still a report.** On the two exit-0 empty paths every
`total.*` is 0, `models[]` is `[]`, `categories[]` is still all fourteen zero
rows, `session.harness` is `null`, and `notices[]` carries `pending-session` or
`no-data`. A consumer never has to branch on shape, only on values.

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
`--list` in particular — and is filed separately rather than half-done here.

**`--force` still does its work.** `-F` kills the daemon and deletes the tag files
before this branch is reached, so `--json -F` re-parses exactly as the rendered
path would.

**Session selection does not prompt.** `selectSessionPrompt` writes its menu and
its non-interactive candidate list to *stdout*, and exits 130 on `q`/Ctrl-C. Under
`--json` neither can be allowed, so when several sessions are discovered and no
`-s` is given, `--json` takes the newest — the same one the non-interactive
fallback resolves to — reports that on stderr, and records an
`auto-selected-session` notice naming how many it chose between. A caller wanting
determinism passes `-s`; the notice is what tells it that it should.

**`--json` is CLI-only**, in the sense that the Pi extension never reads it: the
parser is shared, so the flag is accepted there, but `extensions/wtft.ts` never
destructures `json` and no code path could observe it. A TUI widget has no stdout
to write an object to.

## Closer

```console
$ node bin/wtft.mjs -s <fixture> --json \
    | jq -e '.schema == "wtft/session@1" and (.total.outputTokens|type) == "number"'
```

exits 0, and `tests/wtft-26-json.test.ts` asserts, on a fixture, in seven
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
6. **§6** `--json` beside each rendering flag yields an object and does not
   crash. Which flag wins is deliberately not pinned.
7. **§7** every exit code the CLI can return — scanned from `bin/wtft.ts` **and**
   `extensions/lib/session-selector.ts`, which is where 130 lives — appears in
   the manifest table, and `wtft --help` renders that table.

## Reconciliation

Findings from the fresh-context audit run at the **Code & Spec Approved** step.
Rows marked *pre-existing* are drift this branch surfaced rather than caused;
file-level scope says fix or file, and the Action column says which.

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| `docs/manifests/wtft-cmd.json` | had no exit-code table at all | `bin/wtft.ts` exits 0, 1, 9; `session-selector.ts` exits 130 | ✅ `wtft-26-json.test.ts` §7 | Added `exitCodes` (0/1/9/**130**), rendered by `--help` |
| `bin/wtft.ts` under `--json` | "exactly one JSON object on stdout" | `selectSessionPrompt` `console.log`s its candidate list to **stdout** before the object, and exits 130 on Ctrl-C | ✅ `wtft-26-json.test.ts` §1, §7 | **Code fixed**: `--json` never prompts; takes the newest, notice `auto-selected-session` |
| `extensions/lib/wtft-renderer.ts` `computeSessionSummary` | `sum(categories) === total` | `_cat` reaches `classifyInteraction` unvalidated, so an unknown category was dropped from `categories[]` | ✅ `wtft-26-json.test.ts` §3 | **Code fixed**: folded into `other` |
| `extensions/lib/wtft-json.ts` | `uncounted` defaulted to zeros when a caller skipped the scan | "not scanned" was indistinguishable from "none found" | ✅ `wtft-26-json.test.ts` §5 | **Code fixed**: scanned on every path |
| `extensions/lib/wtft-parser.ts` | — | this branch inserted `detectSessionHarness`'s docstring **between** `scanUncountedBillables`'s docstring and its function, orphaning it | n/a | **Code fixed**: moved below |
| `bin/wtft.ts` `@package princess-pi-tools` | *pre-existing* — names the pre-extraction package | `package.json` is `@princess-pi/wtft` | n/a | Fixed |
| `bin/wtft.ts` "cost auditing tool for Pi Coding Agent session logs" | *pre-existing* — `--harness auto` is the default | `wtft-cli-shared.ts` defaults `harnessOption` to `auto` | ✅ `wtft-issue-156-harness-seam.test.ts` | Fixed |
| `bin/wtft.ts` "Nothing in this repo invokes this CLI and inspects `$?`" | *pre-existing* — the grep skipped `tests/` | `tests/wtft-513-exit9-caller-guard.test.ts` exists because `wtft-auto-fit` failed on exit 9 | ✅ `wtft-513-exit9-caller-guard.test.ts` | Corrected, kept as history |
| `bin/wtft.ts` "used from four places" / "Memoised: `--tokens --json` … twice" | this branch's own new comments, both wrong | three call sites; the `--tokens` renderer is unreachable under `--json` | n/a | Fixed |
| `bin/wtft.ts` "2 daemon beats", `showReapWarnings` docstring | *pre-existing* — names an undefined unit; silent on the truncate | literal 1400 ms / 667 ms; the function truncates `reap.log` | n/a | Fixed |
| `docs/manifests/wtft-cmd.json` `--limit` "(default: 10)" | *pre-existing* — false for the CLI | `bin/wtft.ts` substitutes 100 when `hasLimit` is false | ✅ `wtft-74-budget-flag-parsing.test.ts` | Fixed: names both |
| `docs/manifests/wtft-cmd.json` `--width` "(default: 240)" | *pre-existing* — the CLI never reads `opts.width` | no reference to `opts.width` in `bin/wtft.ts`; parser default is 80 | ✅ `wtft-74-budget-flag-parsing.test.ts` | Fixed: marked extension-only |
| `docs/manifests/wtft-cmd.json` `-S/-H`, `-p`, `--emoji`, `-s` | *pre-existing* — silent on CLI inertness, the exit-1 refusal, CLI emoji, and pending paths | `wtft-cli-shared.ts`, `bin/wtft.ts` | ✅ `wtft-74-budget-flag-parsing.test.ts` §4, `wtft-issue-153-pager-cli.test.ts`, `wtft-308-lagging-session.test.ts` | Fixed |
| `docs/spec-149-compaction-cost-scope.md` | "Wired into the non-watch `--tokens` path only" | the scan now runs on every `--json` run, and can downgrade the verdict | ✅ `wtft-26-json.test.ts` §5 | Fixed |
| `docs/spec-160-161-162-wtft-spec-surfaces.md` | "the manifest's 25 `usage` entries" | this branch made it 27 | ✅ `wtft-spec-alignment.test.ts` | Fixed |
| `docs/spec-308-lagging-session.md` | the pending/no-data sentences go to stdout | true only without `--json`; and its `bin/wtft.ts:NNN` citations no longer resolve | ✅ `wtft-308-lagging-session.test.ts` | Fixed: mode named, citations made construct-anchored |
| `docs/wtft-incremental-render-spec.md`, `tests/wtft-443-cli-exit-9.test.ts` header, `bin/wtft.ts` | "`wtft` has no `--json`, no `--porcelain`" | this branch adds `--json` | ✅ `wtft-26-json.test.ts` §4 | Fixed in all three |
| `tests/wtft-443-cli-exit-9.test.ts` | "says nothing about being provisional" asserted against `execFileSync`'s stdout | the sentence is only ever on stderr, so it could not fail in any outcome | ✅ itself, now on both streams | **Test fixed**: `spawnSync` |
| `tests/wtft-26-json.test.ts` | `categories[]` vs the imported `CATEGORY_ORDER`; a hardcoded `EXIT_PROVISIONAL = 9`; an exit-code scan of one file | all three compare the code to itself, or miss 130 | ✅ itself | **Test fixed** |
| `CONTEXT.md` | no term for the new output mode; CLI entry listed two CLI-only modes | `--json` is a third | ✅ `wtft-75-doc-claims.test.ts` | Fixed: **JSON mode** and **Provisional** entries added |

**Filed rather than fixed** — pre-existing, out of this branch's scope, each with
a consequence named in its issue: the chart-vs-summary `serverToolCost`
divergence; unknown flags and malformed flag values being silently ignored; the
daemon-management commands having no machine-readable mode; and a sweep of
`wtft-renderer.ts` docstrings that bind to the wrong symbol or describe retired
behaviour. Issue numbers are in the PR body.

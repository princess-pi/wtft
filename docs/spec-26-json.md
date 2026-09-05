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

`wtft --json` writes **exactly one JSON object** to stdout, followed by a
newline, and nothing else on stdout: no ANSI, no abbreviation, no chart, no
table, no prose. Human-facing prose still goes to **stderr**, and the same text
is carried in the object's `notices[]` so a consumer never has to read stderr to
learn why a number looks the way it does.

Numbers are exact: integers for tokens, full-precision IEEE doubles for dollars.
Nothing is rounded, abbreviated, or padded on this path.

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
    "taggerVersion": "12",
    "tagPath": "/home/u/.claude/projects/-x/wtft-tags/abc.jsonl.wtft-tag.v12.jsonl"
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
| `session.harness` | string \| null | Harness id whose parse adapter claims the transcript's first assistant turn — `"claude-code"`, `"pi"`, or an out-of-tree id. `null` when no adapter claims anything (an empty or not-yet-written transcript). |
| `session.taggerVersion` | string | `WTFT_TAGGER_VERSION` of the running binary. |
| `session.tagPath` | string | The classified tag file this run read. |
| `provisional.provisional` | bool | The `readTagProvisional` verdict — may this total still grow? |
| `provisional.reason` | string \| null | `"stale-version"` · `"unswept"` · `"subagent-unreadable"`, or `null` when settled. |
| `total.*` | number | Exact session totals. Cost is USD, the rest are token counts. |
| `models[]` | array | One row per model id, **sorted by `costUsd` descending** — the same order and the same numbers as the rendered `--tokens` table's rows, un-abbreviated. `model` is the full id, never shortened. |
| `models[].priced` | bool | `isModelPriced(model)` — the `?` marker in the rendered table. `false` means the cost is a fallback guess. |
| `categories[]` | array | One row per `CATEGORY_ORDER` entry, **always all fourteen, always in `CATEGORY_ORDER` order**, so a consumer can index by position. |
| `uncounted` | object | The #149 blind spot: events the harness bills and writes no `usage` for. Counted, never priced, and deliberately **not** in `total`. |
| `compaction` | object | Compaction events seen and tokens they freed — the `Compaction:` line of the rendered table. |
| `untaggedInteractions` | int | Interactions excluded from `total`/`models`/`categories` because they carry no model id (`(unknown)` or `<synthetic>`) — the rendered table's "(N untagged interactions skipped)". |
| `notices[]` | array | `{ code, text }`. `code` is API; `text` is prose. Codes: `pending-session`, `no-data`, `unpriced-model`, `provisional`. |

### The one arithmetic guarantee

`sum(models[].X) === total.X` and `sum(categories[].X) === total.X` for every
field `X`, exactly, with no rounding slack on the token fields.

That holds because all three come from **one** aggregation over **one**
deduplicated interaction set, and because all three apply the same exclusion:
interactions with no model id are counted in `untaggedInteractions` and appear
in none of them. This is deliberately the token-summary table's population, not
the bar chart's — the chart bins every interaction, so a chart total and this
`total` can legitimately differ by the untagged spend.

### The seam

`computeSessionSummary(interactions)` in `extensions/lib/wtft-renderer.ts` is
the single aggregation. `renderTokenSummary` formats it for a human;
`buildSessionJson` in `extensions/lib/wtft-json.ts` serialises it for a machine.
Neither reimplements the arithmetic, so the prose and the JSON cannot drift.

### Exit codes

`--json` does not change what any exit code means. It changes only what stdout
carries.

| Code | Meaning | stdout under `--json` |
|---|---|---|
| **0** | The report was produced. Includes the cases where there is nothing to report yet — a session file not written, or a tag with no classified data. | one JSON object |
| **1** | Error: no session selected or found, an invalid path, a daemon that died before producing data, a flag refused (`--pager`), or an unhandled exception. The reason is on stderr. | nothing |
| **9** | Provisional (#443): the report printed in full, but the total may still grow under the daemon. `provisional.provisional` is `true` and `provisional.reason` names the condition. | one JSON object |

Codes 0 and 9 both carry a complete object; a consumer that wants only settled
numbers checks `$?` **or** `.provisional.provisional` and gets the same answer.

### Interaction with other flags

`--json` suppresses every rendering flag: the chart, `--other`, `--tokens`,
`--pad`, `--emoji`. Passing one alongside `--json` is not an error and never
crashes; the JSON object is what you get. `--watch` and `--pager` keep their own
behaviour — `--json` describes one snapshot, not a stream.

`--json` is a **CLI-only** flag, like `--list` and `--watch`. The Pi extension
parses it (the parser is shared) and ignores it; there is no stdout in a TUI
widget to write an object to.

## Closer

```console
$ node bin/wtft.mjs -s <fixture> --json \
    | jq -e '.schema == "wtft/session@1" and (.total.outputTokens|type) == "number"'
```

exits 0, and `tests/wtft-26-json.test.ts` asserts, on a fixture:

1. stdout is exactly one parseable JSON object with no ANSI escape byte in it;
2. `total`, `models[]` and `categories[]` each equal what `renderTokenSummary`
   printed for the same interactions, once the table's `3.6k` abbreviations are
   un-abbreviated — so the prose and the JSON cannot drift;
3. stdout is still one parseable JSON object on the **provisional** path, and
   that run exits 9 with `provisional.provisional === true`;
4. `sum(models[]) === total` and `sum(categories[]) === total`, field by field.

## Reconciliation

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| `docs/manifests/wtft-cmd.json` | had no exit-code table at all | `bin/wtft.ts` exits 0, 1, and 9 | ✅ `wtft-26-json.test.ts` §5, `wtft-443-cli-exit-9.test.ts` | Added `exitCodes`, rendered by `--help` |
| `README.md` § Usage | named no `--json` | this branch adds the flag | ✅ `wtft-75-doc-claims.test.ts` §1 | Example and exit-code table added |
| `bin/wtft.ts` (#443 comment) | "`wtft` has no --json/--porcelain today" | this branch adds `--json` | ✅ `wtft-26-json.test.ts` §1 | Comment corrected |
| `tests/wtft-443-cli-exit-9.test.ts` header | "There IS no structured output … no `--json`" | this branch adds `--json` | n/a (header prose) | Corrected to point here |

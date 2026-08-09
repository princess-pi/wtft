# Spec: wtft pricing correctness + workflow subagent rollup (#139, #140, #141)

**Status:** Code and Spec Approved (tested; reconciled to shipped code)
**Issues:** [#139](https://github.com/duppypro/princess-pi-packages/issues/139),
[#140](https://github.com/duppypro/princess-pi-packages/issues/140),
[#141](https://github.com/duppypro/princess-pi-packages/issues/141)

---

## Why (one paragraph)

A 2026-08-08 all-Fable session showed wtft reporting **$15.33** where the Claude Code
status line (authoritative) showed **$79.43**. Two independent causes: (a) `claude-fable-5`
matches nothing in `MODEL_PRICING` nor the `haiku`/`opus` substring fallbacks, so it
silently prices at the Sonnet-tier initializer defaults ($3/$15 vs the real $10/$50) —
and nothing warns that the number is a guess; (b) Dynamic Workflow transcripts under
`<session>/subagents/workflows/wf_*/agent-*.jsonl` are never discovered because
`walkSubagentDir` only recurses into directories named `subagents`/`ns`/`agent-*`.

## Scope

Three fixes, one branch, one tagger-version bump (`WTFT_TAGGER_VERSION` 2.5.4 → 2.6.0)
so previously-tagged sessions re-parse with correct pricing and workflow rollup.

### #139 — Claude 5 family in `MODEL_PRICING`

Add per-MTok entries to `MODEL_PRICING` in `extensions/lib/wtft-cost.ts`
(rates verified against the claude-api reference, list prices):

| key(s) | input | output | cacheRead | cacheWrite (5m) |
|---|---|---|---|---|
| `claude-fable-5`, `claude-mythos-5` | 10.00 | 50.00 | 1.00 | 12.50 |
| `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-opus-4-1` | 5.00 | 25.00 | 0.50 | 6.25 |
| `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5` | 3.00 | 15.00 | 0.30 | 3.75 |
| `claude-haiku-4-5` | 1.00 | 5.00 | 0.10 | 1.25 |

Notes:
- `lookupModelPricing` fuzzy-matches by substring, so dated IDs
  (`claude-haiku-4-5-20251001`) resolve via their alias key.
- Existing registry cache-write handling (`cw1h` billed at 2× the 5m rate) is correct
  for Anthropic and is reused as-is.
- The legacy `haiku`/`opus` substring branches stay as a safety net for IDs not in the
  registry (e.g. `claude-opus-4-0`); registry entries win because they are checked first.
- Sonnet 5 intro pricing ($2/$10 through 2026-08-31) is a road not taken — wtft prices
  at list rates, same as every other entry (no date-dependent pricing).

### #140 — pricing as data + loud miss path + per-model breakdown

1. **User pricing registry (data, not code).** New module
   `extensions/lib/wtft-pricing-config.ts`:
   - `loadUserPricing()` reads `$XDG_CONFIG_HOME/princess-pi-packages/wtft-pricing.json`
     (default `~/.config/princess-pi-packages/wtft-pricing.json`) and merges entries
     **over** built-ins via `applyUserPricing(record)` exported from `wtft-cost.ts`.
   - File shape = `Record<string, ModelPricing>` (same shape as `MODEL_PRICING`,
     including optional `tiers`). Unreadable/invalid file → ignored silently (wtft
     never blocks on config).
   - Called at startup by both the CLI (`bin/wtft.ts`) and the daemon
     (`bin/wtft-daemon.ts`) — the daemon is where costs are actually computed.
   - *Deviation from issue text:* the issue suggested `~/.config/wtft/pricing.json`;
     this repo's config convention (`extensions/lib/config.ts`) is
     `~/.config/princess-pi-packages/<tool>*.json`, so the pricing file lives there too.
2. **Warn on unknown models.** New `isModelPriced(model): boolean` in `wtft-cost.ts` —
   true when the (user-merged) registry fuzzy-matches or a legacy fallback branch
   (`deepseek`/`haiku`/`opus`) applies. The CLI (non-watch path) scans distinct
   `interaction.model` values from the tag file and prints one stderr line per unknown
   model per run:
   `⚠ no pricing for <model> — using default $3/$15 rates; totals may be unreliable`.
   (The daemon computes costs in a separate process, so the CLI derives the warning
   from tag data rather than sharing in-process state.)
3. **`--by-model` breakdown.** `--by-model` is an **alias of `--tokens`** — the
   existing `renderTokenSummary` table already is the per-model token+cost breakdown
   (one row per model, TOTAL row), so the flag maps to it rather than duplicating a
   renderer. Cost cells for models failing `isModelPriced` (and the TOTAL when any row
   is affected) are suffixed `?`, with a legend line explaining the marker.

### #141 — workflow transcript discovery

`walkSubagentDir` (`extensions/lib/wtft-parser.ts`) recurses into **all**
subdirectories instead of only `subagents`/`ns`/`agent-*`. The depth counter keeps its
existing meaning (increments only on `subagents`/`ns` containers → `MAX_SUBAGENT_DEPTH`
still bounds *nesting* depth, not directory depth), and the `agent-*.jsonl` file filter
still gates what is collected. This picks up
`subagents/workflows/wf_<runId>/agent-*.jsonl` and future harness layout changes.

**Exclusion discovered during implementation:** `wtft-tags/` directories are skipped —
wtft's own tag output for an agent transcript is named
`agent-<id>.jsonl.wtft-tag.v<ver>.jsonl`, which matches the `agent-*.jsonl` file filter
and would double-count if the walker entered those dirs.

### Tagger version bump

`WTFT_TAGGER_VERSION` `2.5.4` → `2.6.0` in `extensions/lib/wtft-daemon-lib.ts`.
Both the pricing fix and the walker fix change tag-file content; the bump makes stale
tags re-parse on next run.

## Verification (spec gate)

Tests run against the built bundle (`bun run build` first), per repo convention:

1. **`tests/wtft-claude5-pricing.test.ts`** (new)
   - `calculateClaudeCost("claude-fable-5", …)` prices at $10/$50/$1.00/$12.50
     (input, output, cacheRead, 5m cacheWrite), 1h cacheWrite at 2× = $25/MTok.
   - Opus 5 / Sonnet 5 / Haiku 4.5 rows spot-checked.
   - Repro guard: 25M cacheRead + 1.6M cacheWrite + 100k output on `claude-fable-5`
     ≈ $50 (±5%), NOT ≈ $15.
   - `isModelPriced("claude-fable-5")` true; `isModelPriced("claude-sonnet-6")` false;
     `isModelPriced("claude-opus-4-0")` true (legacy branch).
   - `applyUserPricing({"model-x": {...}})` makes `lookupModelPricing("model-x")`
     resolve and `isModelPriced` true (JSON entry corrects totals without rebuild).
2. **`tests/wtft-issue-141-workflow-discovery.test.ts`** (new)
   - Fixture `<session>/subagents/workflows/wf_abc/agent-1.jsonl` +
     `wf_def/agent-2.jsonl` → both discovered by `discoverSubagentSessionFiles`.
   - Existing depth-5 nesting fixtures still pass (regression:
     `tests/wtft-issue-82.test.ts`).
3. **Existing suites** `wtft-pricing-tiers`, `wtft-issue-82`, `wtft-issue-83`,
   `wtft-server-tool-cost`, daemon cost cross-validation — all green.
4. **Manual (result):** `wtft -s <…a578 session>` after `--force` re-parse reports
   **$92.11** (fable-5 $90.64 + sonnet-5 $1.47), vs $15.33 before. This exceeds the
   issue's ≈$73 estimate and the $79.43 status-line snapshot because the 33 rolled-up
   subagent/workflow transcripts contribute ≈14M cache-read tokens the estimate
   approximated, and the status-line figure was a mid-session snapshot.
   `wtft --by-model -s <session>` rows sum to the TOTAL row. `--help` documents
   `--by-model`. All suites listed above ran green (commit b6bb290 has the full list);
   typecheck shows no new errors (2 pre-existing TS7016 in serve/cloudflare.js).

## Roads not taken

- **Recursing all dirs with per-level depth counting** — would silently lower the
  effective nesting bound (5 nesting levels ≈ 10+ dir levels); kept container-counting
  semantics instead.
- **Sharing unknown-model state daemon→CLI via tag file schema change** — the CLI can
  derive the same fact from `interaction.model`; avoids a tag-schema field.
- **`~/.config/wtft/` config dir** — repo already standardizes on
  `~/.config/princess-pi-packages/`.

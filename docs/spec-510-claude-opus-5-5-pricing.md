# Spec 510 — Claude Opus 5.5 list rates

Module: extensions/lib/wtft-cost.ts

**State:** Code and Spec Approved

Issue: https://github.com/princess-pi/wtft/issues/510.
**Branch:** `510-claude-opus-5-5-is`

---

## 1. Today

`MODEL_PRICING` has no `claude-opus-5-5` key. `lookupModelPricing("claude-opus-5-5")`
fuzzy-matches the substring `claude-opus-5` and prices the turn at the Opus 5 card —
$5.00 input, $25.00 output, $0.50 cacheRead, $6.25 cacheWrite (5m) — an overcharge that
varies by token class: 1.25x on input, output and writes, 2.5x on cacheRead. Every
Opus 5.5 session wtft prices is inflated accordingly: the CLI total, the `--watch`
chart, and the spawn tree.

The repro session (`2ae7e1ae-6209-4f5f-b0e2-e7cdc1afa139`) read $13.72 from wtft where
the Claude Code status line read $8.78 at the same time; recomputed at Opus 5.5 rates it
is $8.33 — a blended factor of 1.6x on that session's token mix.

## 2. Want

One flat card, USD per 1M tokens, no `surge`, no `dateTiers`, no `tiers`:

| Registry key | input (cache miss) | cacheRead | cacheWrite (5m) | output |
|---|---:|---:|---:|---:|
| `claude-opus-5-5` | 4.00 | 0.20 | 5.00 | 20.00 |

- **The exact key wins.** `lookupModelPricing` checks an exact (lower-cased, trimmed) key
  before the longest-substring fallback, so `claude-opus-5-5` stops resolving to the
  `claude-opus-5` card once its own key exists.
- **`cacheWrite` (5m) `= 1.25 × input`** — the same pattern as every other Claude row
  (`5.00 / 4.00 = 1.25`). The 1h write is not a registry field; `calculateClaudeCost`
  derives it as `2 × input` ($8.00/MTok), so no separate field is added.
- **`WTFT_TAGGER_VERSION` bumps 2.15.0 to 2.16.0**, so tags written with Opus 5.5 turns
  at the Opus 5 card re-parse.

## 3. Verification

`tests/wtft-claude5-pricing.test.ts` (the `#510` describe), through `calculateClaudeCost`
and `lookupModelPricing`:

- 1,000,000 each of `input_tokens`, `output_tokens`, `cache_read_input_tokens` and
  `cache_creation_input_tokens` costs 4.00, 20.00, 0.20 and 5.00.
- A 1h-TTL cache write of 1,000,000 costs 8.00 (2 × input).
- The Closer: 1M cache-read + 1M 1h-write + 1M output bills 0.20 + 8.00 + 20.00 = 28.20.
- `lookupModelPricing("claude-opus-5-5")` returns the 5.5 card, not the `claude-opus-5`
  card.

`tests/wtft-pricing-manifest.test.ts` closes the manifest: `docs/manifests/wtft-pricing.json`
equals `renderPricingManifest()`.

## 4. Reconciliation record

| Artifact | Claim | Checked against | Covered by a test? | Action |
|---|---|---|---|---|
| this spec, section 2 | one flat card at the listed rates | `MODEL_PRICING` in `extensions/lib/wtft-cost.ts` | yes, `tests/wtft-claude5-pricing.test.ts` | none, matches |
| `docs/manifests/wtft-pricing.json` | one row for `claude-opus-5-5` | `renderPricingManifest()` | yes, `tests/wtft-pricing-manifest.test.ts` | regenerated |
| `docs/wtft.html` spec index | every spec is linked | `tests/wtft-doc-spec-index.test.ts` | yes | row added |
| `artifacts/renderer/wtft-chart.mjs` | bundles the registry | `bun run artifacts` | yes, stale-bundle test | regenerated |

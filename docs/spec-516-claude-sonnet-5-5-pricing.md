# Spec 516 — Claude Sonnet 5.5 list rates

Module: extensions/lib/wtft-cost.ts

**State:** Spec Approved

Issue: https://github.com/princess-pi/wtft/issues/516.

---

## 1. Today

`MODEL_PRICING` has no `claude-sonnet-5-5` key. `lookupModelPricing("claude-sonnet-5-5")`
fuzzy-matches `claude-sonnet-5` and prices the turn at that card. On session `0f069641`
(Sonnet 5.5 only) wtft read $2.64 where the Claude Code status line read $1.29.

## 2. Want

One flat card, USD per 1M tokens, from https://platform.claude.com/docs/en/about-claude/pricing
(read 2026-10-15):

| Registry key | input (cache miss) | cacheRead | cacheWrite (5m) | output |
|---|---:|---:|---:|---:|
| `claude-sonnet-5-5` | 2.00 | 0.10 | 2.50 | 10.00 |

- **Cache reads are 0.05 × input,** not the usual 0.1 ×; the pricing page footnotes it.
- **The 1h write** is derived as `2 × input` ($4.00), as for every Claude row.
- **`WTFT_TAGGER_VERSION` bumps** a minor version, so tags written at the fallback card re-parse.

## 3. Verification

`tests/wtft-claude5-pricing.test.ts`, the Sonnet 5.5 describe:

- 1,000,000 each of `input_tokens`, `output_tokens`, `cache_read_input_tokens` and
  `cache_creation_input_tokens` costs 2.00, 10.00, 0.10 and 2.50.
- A 1h-TTL cache write of 1,000,000 costs 4.00.
- `lookupModelPricing("claude-sonnet-5-5")` returns the 5.5 card, not the `claude-sonnet-5` card.

Smoke: session `0f069641` prices within 10% of $1.29.

`tests/wtft-pricing-manifest.test.ts` closes the manifest: `docs/manifests/wtft-pricing.json`
equals `renderPricingManifest()`.
